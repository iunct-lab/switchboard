// test-reads: container/compose.yaml container/entrypoint.sh container/up.sh
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");
const compose = read("compose.yaml");
const entrypoint = read("entrypoint.sh");
/** The lines of a shell script that run something (no comments, no blanks). */
const commands = (script: string) => script.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

/** The items of the one `ports:` list of compose.yaml, unquoted. */
function ports(yaml: string): string[] {
  const lines = yaml.split("\n");
  const at = lines.findIndex((l) => /^\s+ports:\s*$/.test(l));
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s+-\s+"?([^"\s]+)"?\s*$/.exec(line);
    if (!item) break;
    out.push(item[1]!);
  }
  return at < 0 ? [] : out;
}

test("every published port is on the machine's 127.0.0.1: the daemon's only — sb-rescue's port is not published", () => {
  const published = ports(compose);
  expect(published.filter((p) => !p.startsWith("127.0.0.1:"))).toEqual([]);
  expect(published.sort()).toEqual(["127.0.0.1:47831:47831"]);
  expect(compose.match(/^\s+ports:/gm)?.length).toBe(1);
});

test("sb-rescue is reachable on the container's loopback only: nothing relays to its port, nothing opens it on another address, and the port is not published", () => {
  // sb-rescue lets a loopback connection promote, roll back and restart without a login; a relay on the container's
  // address (where a published port, and any peer on the docker bridge, arrives) would make every such peer loopback
  const run = commands(entrypoint);
  const rescuePort = /SWITCHBOARD_RESCUE_PORT=(\d+)/.exec(run.at(-1)!)![1]!;
  const relays = run.filter((l) => l.includes("container/relay.ts")).map((l) => l.replace(/^.*relay\.ts"? /, "").replace(/ &$/, "").split(" "));
  expect(relays.length).toBeGreaterThan(0);
  for (const [listen, target] of relays) expect({ listen, target, toRescue: listen === rescuePort || target === rescuePort }).toEqual({ listen, target, toRescue: false });
  // no other way to the port from outside the container: no listen address for sb-rescue, no forwarder, no published port
  expect(entrypoint).not.toContain("SWITCHBOARD_RESCUE_HOST");
  for (const tool of ["socat", "iptables", "nc ", "ncat"]) expect({ tool, used: run.some((l) => l.includes(tool)) }).toEqual({ tool, used: false });
  expect(ports(compose).filter((p) => p.split(":").includes(rescuePort))).toEqual([]);
  expect(compose).not.toMatch(/^\s+(network_mode|expose):/m);
});

test("the entrypoint ends in sb-rescue from the home volume and never starts the daemon from the image", () => {
  const run = commands(entrypoint);
  expect(run.at(-1)).toMatch(/\bexec bun "\$HOME\/\.switchboard\/rescue\/sb-rescue\.js"$/);
  expect(run.filter((l) => l.includes("packages/core/src/main.ts"))).toEqual([]);
  // the daemon's relay answers on the port compose publishes; sb-rescue has no relay and is not opened to other addresses
  expect(run.filter((l) => l.includes("container/relay.ts")).map((l) => l.replace(/^.*relay\.ts"? /, ""))).toEqual(["47831 47832 &"]);
  expect(run.at(-1)).toContain("SWITCHBOARD_PORT=47832 SWITCHBOARD_RESCUE_PORT=47841 ");
  // the daemon is told that the rescue page does not open outside the container, so the screen offers the commands and no link
  expect(run.at(-1)).toContain(" SWITCHBOARD_RESCUE_IN_CONTAINER=1 ");
  expect(entrypoint).not.toContain("SWITCHBOARD_RESCUE_HOST");
  expect(entrypoint).not.toContain("SWITCHBOARD_HOST");
});

test("the role is sb-rescue's own: a clone when SWITCHBOARD_REPO_ROOT is passed through, else the public repository's Releases", () => {
  // compose hands the machine's value on (empty when there is none) and names no other role setting
  expect(compose).toContain('SWITCHBOARD_REPO_ROOT: "${SWITCHBOARD_REPO_ROOT:-}"');
  const run = commands(entrypoint);
  const branch = run.indexOf('if [ -n "${SWITCHBOARD_REPO_ROOT:-}" ]; then');
  const otherwise = run.indexOf("else", branch);
  const end = run.findIndex((l) => l.includes("container/relay.ts"));
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
