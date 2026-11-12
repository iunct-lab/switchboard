// test-reads: container/Dockerfile aws/host/devtools.sh aws/host/node.sh
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

  test("HOME, user and repositories are the host's; arm64 only", () => {
    expect(dockerfile).toContain("ENV HOME=/home/switchboard");
    expect(dockerfile).toContain("useradd -u 1000 -m -d /home/switchboard switchboard");
    expect(dockerfile).toContain("/home/switchboard/repos");
    expect(dockerfile).not.toMatch(/x86_64|amd64/);
  });
});
