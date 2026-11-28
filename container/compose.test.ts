// test-reads: container/compose.yaml container/entrypoint.sh container/up.sh container/work-machine.env.example .gitignore .dockerignore packages/core/src/config.ts container/e2e.sh container/e2e-release.sh
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");
const compose = read("compose.yaml");
const entrypoint = read("entrypoint.sh");
/** The lines of a shell script that run something (no comments, no blanks). */
const commands = (script: string) => script.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

const up = read("up.sh");

test("the container shares the machine's network and publishes nothing: no ports, no expose", () => {
  expect(compose).toMatch(/^\s+network_mode: host\s*$/m);
  expect(compose).not.toMatch(/^\s+(ports|expose):/m);
});

test("the daemon and sb-rescue listen on the machine's loopback only: no relay, no listen address, no forwarder", () => {
  // sb-rescue lets a loopback connection promote, roll back and restart without a login; with the host network
  // loopback is the machine's own, and any other address would open the ports to the docker bridge
  const run = commands(entrypoint);
  expect(entrypoint).not.toContain("relay.ts");
  for (const name of ["SWITCHBOARD_HOST", "SWITCHBOARD_RESCUE_HOST"]) expect({ name, set: entrypoint.includes(name) }).toEqual({ name, set: false });
  for (const tool of ["socat", "iptables", "nc ", "ncat"]) expect({ tool, used: run.some((l) => l.includes(tool)) }).toEqual({ tool, used: false });
});

test("the entrypoint ends in sb-rescue from the home volume on the ports of the EC2 host and never starts the daemon from the image", () => {
  const run = commands(entrypoint);
  expect(run.at(-1)).toMatch(/\bexec bun "\$HOME\/\.switchboard\/rescue\/sb-rescue\.js"$/);
  expect(run.at(-1)).toContain("SWITCHBOARD_PORT=47831 SWITCHBOARD_RESCUE_PORT=47841 ");
  expect(run.filter((l) => l.includes("packages/core/src/main.ts"))).toEqual([]);
});

test("up.sh refuses to start while the machine's 127.0.0.1 has either port in use, before compose up", () => {
  const run = commands(up);
  const check = run.findIndex((l) => l.includes("/dev/tcp/127.0.0.1/"));
  const compose_up = run.findIndex((l) => l.includes(" up -d --build"));
  expect(run.find((l) => l.startsWith("for port in"))).toBe("for port in 47831 47841; do");
  expect(check).toBeGreaterThanOrEqual(0);
  expect(check).toBeLessThan(compose_up);
  expect(run.slice(check, compose_up)).toContain("exit 1");
});

test("up.sh skips the port check when this stack's own container is running, so a re-run rebuilds it instead of refusing", () => {
  const run = commands(up);
  const own = run.findIndex((l) => l.includes("ps -q --status running switchboard"));
  const check = run.findIndex((l) => l.includes("/dev/tcp/127.0.0.1/"));
  expect(own).toBeGreaterThanOrEqual(0);
  expect(run[own]).toStartWith('if [ -z "$(');
  expect(own).toBeLessThan(check);
  // the same compose file for the question and for the start
  expect(run.find((l) => l.startsWith("DC=("))).toBe("DC=(docker compose -f container/compose.yaml)");
  expect(run.at(-1)).toContain('"${DC[@]}" up -d --build');
});

test("the role is sb-rescue's own: a clone when SWITCHBOARD_REPO_ROOT is passed through, else the public repository's Releases", () => {
  // compose hands the machine's value on (empty when there is none) and names no other role setting
  expect(compose).toContain('SWITCHBOARD_REPO_ROOT: "${SWITCHBOARD_REPO_ROOT:-}"');
  const run = commands(entrypoint);
  const branch = run.indexOf('if [ -n "${SWITCHBOARD_REPO_ROOT:-}" ]; then');
  const otherwise = run.indexOf("else", branch);
  const end = run.findIndex((l) => l.includes("exec bun"));
  expect(branch).toBeGreaterThanOrEqual(0);
  expect(otherwise).toBeGreaterThan(branch);
  const clone = run.slice(branch, otherwise);
  const release = run.slice(otherwise, end);
  expect(end).toBeGreaterThan(otherwise);
  // the clone's role bundles sb-rescue only (it builds from the clone's tags itself); no update source is recorded
  expect(clone.filter((l) => l.includes("rescue/install.ts"))).toEqual(['bun "$SRC/rescue/install.ts"']);
  // the other role installs from the repository ops.config.json names, and an empty variable does not reach sb-rescue
  expect(release).toContain("unset SWITCHBOARD_REPO_ROOT");
  expect(release.some((l) => l.includes('bun "$SRC/rescue/install.ts" --source "$SOURCE"'))).toBe(true);
  expect(release.some((l) => l.includes(".publicSync.target") && l.includes("ops.config.json"))).toBe(true);
});

test("work-machine: compose reads container/work-machine.env as an optional env_file, so no file means the daemon runs alone as before", () => {
  const service = Bun.YAML.parse(compose).services.switchboard;
  // required: false is what lets a PC without the file start; the only other source of the daemon's settings is the role
  expect(service.env_file).toEqual([{ path: "work-machine.env", required: false }]);
  expect(Object.keys(service.environment)).toEqual(["SWITCHBOARD_REPO_ROOT"]);
  // one entrance: no mount of the machine's AWS directory
  expect(service.volumes.filter((v: string) => v.includes(".aws"))).toEqual([]);
});

test("work-machine: the file with the credentials is out of Git and out of the build context; the example is not", () => {
  const root = join(import.meta.dir, "..");
  const ignored = (path: string) => spawnSync("git", ["check-ignore", "-q", path], { cwd: root }).status === 0;
  expect(ignored("container/work-machine.env")).toBe(true);
  expect(ignored("container/work-machine.env.example")).toBe(false);
  expect(readFileSync(join(root, ".dockerignore"), "utf8").split("\n")).toContain("container/work-machine.env");
});

test("work-machine: the example names the four variables of a work machine that loadUplink reads, and the AWS credentials, with no value", () => {
  const keys = read("work-machine.env.example").split("\n").filter((l) => l && !l.startsWith("#"));
  expect(keys.every((l) => /^[A-Z_]+=$/.test(l))).toBe(true);
  const names = keys.map((l) => l.slice(0, -1));
  const loader = readFileSync(join(import.meta.dir, "..", "packages/core/src/config.ts"), "utf8");
  const uplink = loader.slice(loader.indexOf("export function loadUplink"));
  for (const name of ["SWITCHBOARD_UPLINK", "SWITCHBOARD_UPLINK_PREVIEW", "SWITCHBOARD_MACHINE", "SWITCHBOARD_UPLINK_BUCKET"]) {
    expect({ name, example: names.includes(name), read: new RegExp(`env\\.${name}\\b`).test(uplink) }).toEqual({ name, example: true, read: true });
  }
  expect(names).toEqual(expect.arrayContaining(["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_DEFAULT_REGION"]));
});

test("work-machine: the e2e scripts' containers do not read the machine's container/work-machine.env", () => {
  // their override files are layered on compose.yaml, which keeps the base env_file unless the override resets it: on a
  // machine made a work machine the test container would otherwise start with its real settings and AWS key
  for (const script of ["e2e.sh", "e2e-release.sh"]) {
    const text = read(script);
    const services = text.split("\n").filter((l) => /^ {4}image: sb-e2e(-release)?$/.test(l)).length;
    const resets = text.split("\n").filter((l) => l.trim() === "env_file: !reset []").length;
    expect({ script, uses: text.includes("-f container/compose.yaml"), resets }).toEqual({ script, uses: true, resets: script === "e2e.sh" ? 1 : 2 });
    expect(services).toBeGreaterThanOrEqual(resets);
  }
});

const hasCompose = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
test.skipIf(!hasCompose)("work-machine: with the file the container's environment carries the work machine's settings, without it none, and an e2e override drops them", () => {
  // Compose itself resolves the file (`docker compose config`): a copy of compose.yaml in a directory of its own, so the
  // machine's own container/work-machine.env, if any, is not read
  const dir = mkdtempSync(join(tmpdir(), "sb-compose-"));
  try {
    writeFileSync(join(dir, "compose.yaml"), compose);
    const env = (...extra: string[]) => {
      const r = spawnSync("docker", ["compose", "-f", join(dir, "compose.yaml"), ...extra, "config", "--format", "json"], { cwd: dir, encoding: "utf8", env: { ...process.env, SWITCHBOARD_REPO_ROOT: "" } });
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout).services.switchboard.environment as Record<string, string>;
    };
    expect(Object.keys(env()).filter((k) => k !== "SWITCHBOARD_REPO_ROOT")).toEqual([]);
    writeFileSync(join(dir, "work-machine.env"), "SWITCHBOARD_UPLINK=send\nSWITCHBOARD_MACHINE=pc1\nAWS_DEFAULT_REGION=ap-northeast-1\n");
    expect(env()).toMatchObject({ SWITCHBOARD_UPLINK: "send", SWITCHBOARD_MACHINE: "pc1", AWS_DEFAULT_REGION: "ap-northeast-1" });
    writeFileSync(join(dir, "override.yaml"), "services:\n  switchboard:\n    env_file: !reset []\n");
    expect(Object.keys(env("-f", join(dir, "override.yaml"))).filter((k) => k !== "SWITCHBOARD_REPO_ROOT")).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
