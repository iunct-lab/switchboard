// test-reads: container/compose.yaml container/entrypoint.sh container/up.sh
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
