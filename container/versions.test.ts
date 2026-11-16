// test-reads: container/Dockerfile aws/host/devtools.sh aws/host/node.sh aws/host/host.test.ts ops-kit/src/cli.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPins } from "../scripts/host-pins.ts";

// The image repeats what aws/host/devtools.sh and node.sh pin (PBI #4042: two places, kept equal by this test)
const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const dockerfile = read("container/Dockerfile");
const nodeSh = read("aws/host/node.sh");
const devtoolsSh = read("aws/host/devtools.sh");

const arg = (text: string, name: string): string | undefined => new RegExp(`^(?:ARG )?${name}=(\\S+)$`, "m").exec(text)?.[1];

describe("container/Dockerfile pins", () => {
  const { pins } = readPins(nodeSh, devtoolsSh);
  const shared = ["NODE", "DOCKER", "COMPOSE", "UV", "GITLEAKS"];

  test("GH_STACK version is the host's", () => {
    const pin = pins.find((p) => p.name === "GH_STACK_VERSION")!;
    expect(pin).toBeDefined();
    expect(arg(dockerfile, "GH_STACK_VERSION")?.replace(/^v/, "")).toBe(pin.pinned);
  });

  for (const tool of shared) {
    test(`${tool} version and sha256 are the host's`, () => {
      const pin = pins.find((p) => p.name === `${tool}_VERSION`)!;
      expect(pin).toBeDefined();
      expect(arg(dockerfile, `${tool}_VERSION`)?.replace(/^v/, "")).toBe(pin.pinned);
      const sha = arg(tool === "NODE" ? nodeSh : devtoolsSh, `${tool}_SHA256`);
      expect(sha).toMatch(/^[0-9a-f]{64}$/);
      expect(arg(dockerfile, `${tool}_SHA256`)).toBe(sha);
    });
  }

  test("what only the image pins has a default version, and a sha256 where it is downloaded", () => {
    for (const name of ["BUN_VERSION", "CLAUDE_VERSION", "CODEX_VERSION", "GH_VERSION", "GH_STACK_VERSION"]) {
      expect(arg(dockerfile, name)).toMatch(/^v?\d+(\.\d+)+$/);
    }
    for (const name of ["GH_SHA256", "GH_STACK_SHA256"]) expect(arg(dockerfile, name)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("PLAYWRIGHT_VERSION is the host's", () => {
    const pin = arg(devtoolsSh, "PLAYWRIGHT_VERSION");
    expect(pin).toMatch(/^\d+(\.\d+)+$/);
    expect(arg(dockerfile, "PLAYWRIGHT_VERSION")).toBe(pin);
  });

  test("the ci stage stops before the repository is copied in, and the last stage is the stand-alone one", () => {
    const stages = [...dockerfile.matchAll(/^FROM \S+ AS (\S+)$/gm)];
    expect(stages.map((m) => m[1])).toEqual(["base", "ci", "stand-alone"]);
    const copy = dockerfile.search(/^COPY \. /m);
    expect(copy).toBeGreaterThan(stages[1].index!);
    expect(copy).toBeGreaterThan(stages[2].index!);
    expect(dockerfile.indexOf("PLAYWRIGHT_VERSION")).toBeLessThan(stages[2].index!);
  });

  test("HOME, user and repositories are the host's", () => {
    expect(dockerfile).toContain("ENV HOME=/home/switchboard");
    expect(dockerfile).toContain("useradd -u 1000 -m -d /home/switchboard switchboard");
    expect(dockerfile).toContain("/home/switchboard/repos");
  });

  const tools = ["DOCKER", "COMPOSE", "UV", "GITLEAKS", "NODE", "GH", "GH_STACK"];
  // the RUN that downloads the tools: from `RUN set -eu` to the blank line after it
  const fetchRun = /^RUN set -eu; \\\n[\s\S]*?\n\n/m.exec(dockerfile)?.[0] ?? "";

  // the unsuffixed sha256 are the arm64 files the host pins; the x86-64 file of the same version is another file, so its sha256 differs
  test("every downloaded tool has an x86-64 sha256 that is not its arm64 one", () => {
    for (const tool of tools) {
      const x86 = arg(dockerfile, `${tool}_SHA256_X86_64`);
      expect({ tool, x86 }).toEqual({ tool, x86: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect({ tool, same: x86 === arg(dockerfile, `${tool}_SHA256`) }).toEqual({ tool, same: false });
    }
  });

  // one version per tool for both CPUs: the version is only an ARG and the RUN names it by variable, so one CPU cannot lag behind
  test("the fetching RUN names each version by its ARG and holds no version number", () => {
    expect(fetchRun).toContain("fetch()");
    for (const tool of tools) {
      const version = arg(dockerfile, `${tool}_VERSION`)!.replace(/^v/, "");
      expect({ tool, written: fetchRun.includes(version) }).toEqual({ tool, written: false });
      expect({ tool, named: fetchRun.includes(`$${tool}_VERSION`) || fetchRun.includes(`\${${tool}_VERSION}`) }).toEqual({ tool, named: true });
    }
  });

  test("the fetching RUN chooses by uname -m between x86_64 and aarch64 and refuses any other CPU", () => {
    expect(fetchRun).toContain('M="$(uname -m)"');
    expect(fetchRun).toMatch(/^\s+x86_64\) /m);
    expect(fetchRun).toMatch(/^\s+aarch64\) /m);
    expect(fetchRun).toContain('*) echo "unsupported CPU: $M" >&2; exit 1 ;;');
  });

  // each branch takes its own CPU's sha256: a swapped or copied assignment would pass the arm64 build and fail only on x86-64
  test("the x86_64 branch takes the _X86_64 sha256 and the aarch64 branch the unsuffixed one", () => {
    const branch = (cpu: string) => new RegExp(`^\\s+${cpu}\\) [\\s\\S]*?;;`, "m").exec(fetchRun)?.[0] ?? "";
    for (const tool of tools) {
      expect({ tool, x86: branch("x86_64").includes(`${tool}_SHA="$${tool}_SHA256_X86_64"`) }).toEqual({ tool, x86: true });
      expect({ tool, arm: branch("aarch64").includes(`${tool}_SHA="$${tool}_SHA256"`) }).toEqual({ tool, arm: true });
    }
  });
});

// The ci stage is where `sb-offload --ci` runs aws/host/host.test.ts and ops-kit/src/cli.test.ts; a command they call that the image lacks fails there
// and not on the host. One table, command -> the dnf package of the base or ci stage ("-" = the base image already has it: coreutils, bash, grep).
describe("ci stage tools", () => {
  const stageInstall = (stage: string): string[] => {
    const m = new RegExp(`FROM \\S+ AS ${stage}\\b[\\s\\S]*?RUN dnf install -y -q ([^\\n&\\\\]*(?:\\\\\\n[^\\n&\\\\]*)*)`).exec(dockerfile);
    return (m?.[1] ?? "").replace(/\\\n/g, " ").split(/\s+/).filter(Boolean);
  };
  const installed = new Set([...stageInstall("base"), ...stageInstall("ci")]);
  const tools: Record<string, string> = {
    bash: "-", grep: "-", id: "-", mv: "-", touch: "-", sha256sum: "-",
    git: "git", sqlite3: "sqlite", tar: "tar", find: "findutils", zstd: "zstd",
    rsync: "rsync", ps: "procps-ng", pgrep: "procps-ng", file: "file", cmp: "diffutils", // cmp: aws/host/pre-rebuild.sh, aws/host/runner-sync.sh
    // the repository's own command, on PATH from ops-kit/bin
    "ops-kit": "-",
  };

  test("every command in the table has its package in the base or ci stage's dnf install", () => {
    expect(installed.size).toBeGreaterThan(10);
    for (const [cmd, pkg] of Object.entries(tools)) {
      if (pkg !== "-") expect({ cmd, installed: installed.has(pkg) }).toEqual({ cmd, installed: true });
    }
  });

  // tests run `bun` from dirname(process.execPath); the npm package has only bun.exe there, so the Dockerfile links it
  test("the image links bun next to the bun.exe that process.execPath names", () => {
    expect(dockerfile).toMatch(/ln -s bun\.exe \/usr\/local\/lib\/nodejs\/lib\/node_modules\/bun\/bin\/bun\s/);
  });

  test("a command the two test files spawn is in the table", () => {
    const missing: string[] = [];
    for (const f of ["aws/host/host.test.ts", "ops-kit/src/cli.test.ts"]) {
      for (const m of read(f).matchAll(/Bun\.spawn(?:Sync)?\(\[\s*"([^"]+)"/g)) if (!(m[1]! in tools)) missing.push(`${f}: ${m[1]}`);
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
