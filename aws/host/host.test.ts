import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

/**
 * aws/host (#230): the host scripts run against fake `aws`, `sudo`, `systemctl`, `shutdown` and `curl` on PATH, so no
 * AWS account and no root are needed. systemd-analyze only exists on Linux, so the units are checked as text.
 */
const HERE = import.meta.dir;
const SCRIPTS = readdirSync(HERE).filter((f) => f.endsWith(".sh"));
let dir: string;
let log: string;

function fake(name: string, body: string) {
  writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "bin", name), 0o755);
}
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
function run(script: string, args: string[], env: Record<string, string> = {}) {
  rmSync(log, { force: true });
  const p = Bun.spawnSync(["bash", join(HERE, script), ...args], { env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, SB_HOST_ENV: join(dir, "host.env"), ...env }, stderr: "pipe", stdout: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-test-host-"));
  mkdirSync(join(dir, "bin"));
  log = join(dir, "calls.log");
  writeFileSync(join(dir, "host.env"), "SB_INSTANCE_ID=i-0123\nSB_SCHEDULER_ROLE_ARN=arn:aws:iam::1:role/sched\nSB_DATA_BUCKET=bucket\nSB_REPO_DIR=/nowhere\n");
  for (const n of ["systemctl", "shutdown", "systemd-run"]) fake(n, `echo "${n} $*" >> "${join(dir, "calls.log")}"`);
  fake("sudo", `[ "$1" = "-n" ] && shift; exec "$@"`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("aws/host (#230)", () => {
  test("every script parses (bash -n)", () => {
    expect(SCRIPTS.length).toBeGreaterThanOrEqual(4);
    for (const s of SCRIPTS) expect(Bun.spawnSync(["bash", "-n", join(HERE, s)]).exitCode).toBe(0);
  });

  test("sb-stop registers one wake-up at the given UTC time, lets Litestream stop, then shuts down", () => {
    // update fails (no schedule yet) → create
    fake("aws", `echo "aws $*" >> "${log}"; [ "$2" = "update-schedule" ] && exit 1; exit 0`);
    const r = run("sb-stop.sh", ["2026-09-25T05:30:00.000Z"]);
    expect(r.code).toBe(0);
    const c = calls();
    const create = c.find((l) => l.startsWith("aws scheduler create-schedule"))!;
    expect(create).toContain("--name switchboard-wake");
    expect(create).toContain("--schedule-expression at(2026-09-25T05:30:00) --schedule-expression-timezone UTC");
    expect(create).toContain("arn:aws:scheduler:::aws-sdk:ec2:startInstances");
    expect(create).toContain('\\"InstanceIds\\":[\\"i-0123\\"]');
    expect(create).toContain("arn:aws:iam::1:role/sched");
    expect(c.slice(-2)).toEqual(["systemctl stop litestream", "shutdown -h now"]);
  });

  test("sb-stop with - registers nothing and removes a leftover wake-up; a time that is not UTC ISO stops before shutting down", () => {
    fake("aws", `echo "aws $*" >> "${log}"`);
    expect(run("sb-stop.sh", ["-"]).code).toBe(0);
    expect(calls()).toEqual(["aws scheduler delete-schedule --name switchboard-wake", "systemctl stop litestream", "shutdown -h now"]);
    // no schedule to delete is not an error
    fake("aws", `echo "aws $*" >> "${log}"; exit 254`);
    expect(run("sb-stop.sh", ["-"]).code).toBe(0);
    fake("aws", `echo "aws $*" >> "${log}"`);
    const bad = run("sb-stop.sh", ["tomorrow"]);
    expect(bad.code).not.toBe(0);
    expect(calls()).toEqual([]);
  });

  test("sb-env writes the shared header and the Starter's URL and token, readable by root alone", () => {
    fake("aws", `echo "aws $*" >> "${log}"; case "$*" in *edge-header*) echo edge-value-xyz;; *starter-url*) echo https://fn.example/;; *start-token*) echo start-tok;; esac`);
    const out = join(dir, "switchboard.env");
    expect(run("sb-env.sh", [out]).code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("SWITCHBOARD_EDGE_HEADER_VALUE=edge-value-xyz\nSWITCHBOARD_STARTER_URL=https://fn.example/\nSWITCHBOARD_STARTER_TOKEN=start-tok\nSWITCHBOARD_SESSION_PUBLIC_KEY=\nSWITCHBOARD_WEB_URL=\n");
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });

  test("sb-env hands the login cookie's public key (#211, #701) to the daemon and sb-rescue when the parameter exists; never the old HMAC key", () => {
    fake("aws", `echo "aws $*" >> "${log}"; case "$*" in *edge-header*) echo edge-value-xyz;; *session-public-key*) echo pub-key-b64url;; *session-key*) echo old-hmac-key;; *) echo "ParameterNotFound" >&2; exit 254;; esac`);
    const out = join(dir, "switchboard.env");
    expect(run("sb-env.sh", [out]).code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("SWITCHBOARD_SESSION_PUBLIC_KEY=pub-key-b64url\n");
    expect(readFileSync(out, "utf8")).not.toContain("old-hmac-key");
    expect(readFileSync(log, "utf8")).not.toMatch(/switchboard\/session-key\b/);
  });

  test("sb-env hands the distribution's https origin (#399) to the daemon as SWITCHBOARD_WEB_URL when the parameter exists", () => {
    fake("aws", `case "$*" in *edge-header*) echo edge-value-xyz;; *web-url*) echo https://d1.example.net;; *) echo "ParameterNotFound" >&2; exit 254;; esac`);
    const out = join(dir, "switchboard.env");
    expect(run("sb-env.sh", [out]).code).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("SWITCHBOARD_WEB_URL=https://d1.example.net\n");
  });

  test("sb-env on a first boot before the stack wrote the Starter's URL: the header still goes in, 作り直す waits (re-review #344)", () => {
    fake("aws", `case "$*" in *edge-header*) echo edge-value-xyz;; *starter-url*) echo "ParameterNotFound" >&2; exit 254;; *start-token*) echo start-tok;; esac`);
    const out = join(dir, "switchboard.env");
    expect(run("sb-env.sh", [out]).code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("SWITCHBOARD_EDGE_HEADER_VALUE=edge-value-xyz\nSWITCHBOARD_STARTER_URL=\nSWITCHBOARD_STARTER_TOKEN=\nSWITCHBOARD_SESSION_PUBLIC_KEY=\nSWITCHBOARD_WEB_URL=\n");
    // the edge header is not optional: without it nothing reaches the daemon through CloudFront
    fake("aws", `case "$*" in *edge-header*) exit 254;; *) echo x;; esac`);
    expect(run("sb-env.sh", [out]).code).not.toBe(0);
  });

  test("sb-env writes the daemon's API token from Parameter Store as the token file's owner, never through a planted link", () => {
    // runuser (util-linux on the host) is faked: it drops "-u <user> --" and runs the rest as this test's user
    fake("runuser", `echo "runuser $1 $2 $3" >> "${log}"; shift 3; exec "$@"`);
    const tokenFile = join(dir, "sbhome", ".switchboard", "token");
    fake("aws", `case "$*" in *edge-header*) echo edge-value-xyz;; *daemon-token*) echo sb_daemon_tok;; *) echo x;; esac`);
    expect(run("sb-env.sh", [join(dir, "switchboard.env"), tokenFile, "someone"]).code).toBe(0);
    expect(readFileSync(tokenFile, "utf8")).toBe("sb_daemon_tok\n");
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(log, "utf8")).toContain("runuser -u someone --");
    // a link planted in the user's directory is replaced, its target untouched
    const victim = join(dir, "victim.txt");
    writeFileSync(victim, "keep");
    rmSync(tokenFile);
    symlinkSync(victim, tokenFile);
    expect(run("sb-env.sh", [join(dir, "switchboard.env"), tokenFile, "someone"]).code).toBe(0);
    expect(readFileSync(victim, "utf8")).toBe("keep");
    expect(lstatSync(tokenFile).isSymbolicLink()).toBe(false);
    // no parameter: nothing is written (the daemon makes its own)
    rmSync(tokenFile);
    fake("aws", `case "$*" in *edge-header*) echo edge-value-xyz;; *daemon-token*) exit 254;; *) echo x;; esac`);
    expect(run("sb-env.sh", [join(dir, "switchboard.env"), tokenFile, "someone"]).code).toBe(0);
    expect(existsSync(tokenFile)).toBe(false);
  });

  test("sb-env finds runuser in /usr/sbin even with the unit's PATH (first deploy of #232: switchboard.service failed on it)", () => {
    expect(readFileSync(join(HERE, "sb-env.sh"), "utf8")).toContain('export PATH="$PATH:/usr/sbin:/sbin"');
    expect(readFileSync(join(HERE, "switchboard.service"), "utf8")).not.toMatch(/Environment=PATH=.*\/usr\/sbin/); // the fix is in sb-env, not the user's PATH
  });

  test("the one-time import from the Mac happens only when Litestream brought nothing back (#232)", () => {
    const boot = readFileSync(join(HERE, "bootstrap.sh"), "utf8");
    const at = boot.indexOf("# --- the one-time move from the Mac");
    expect(at).toBeGreaterThan(boot.indexOf("litestream restore")); // after the restore
    expect(at).toBeLessThan(boot.indexOf("# --- units ---")); // before the daemon starts
    const block = boot.slice(at, boot.indexOf("# --- the registered workspaces"));
    expect(block).toContain('if [ ! -f "$SB_HOST_HOME/.switchboard/switchboard.db" ] && aws s3api head-object');
    expect(block).toContain("bun packages/core/src/main.ts import");
    expect(block).not.toMatch(/\/tmp\//); // mktemp, no fixed names
  });

  test("the registered workspaces are cloned on every bootstrap, not only after the import — a rebuild restores the history onto a new disk", () => {
    const boot = readFileSync(join(HERE, "bootstrap.sh"), "utf8");
    const at = boot.indexOf("# --- the registered workspaces");
    expect(at).toBeGreaterThan(boot.indexOf("bun packages/core/src/main.ts import")); // after the import adds its workspaces
    expect(at).toBeLessThan(boot.indexOf("# --- units ---")); // before the daemon starts
    const block = boot.slice(at, boot.indexOf("# --- units ---"));
    const clone = block.slice(0, block.indexOf("\nfi\n"));
    expect(clone).toStartWith('# --- the registered workspaces');
    expect(clone).toContain('if [ -f "$SB_HOST_HOME/.switchboard/switchboard.db" ]; then'); // restored or imported
    expect(clone).not.toContain("aws s3api head-object"); // not gated on the import package
    expect(clone).toContain("gh repo clone");
    expect(clone).toContain('[ -d "$ws" ] && continue'); // an existing checkout is left alone
    // best effort on every rebuild: a database it cannot read must not stop the bootstrap before the units
    expect(clone).toMatch(/done \|\| echo "bootstrap: could not list the workspaces/);
  });

  // The registered workspaces' section (#2799) run alone: as_user runs as is, the database is made here, and a fake gh
  // records its arguments; its clone makes the folder, and its view answers for the clone what `view` says
  function cloneWorkspaces(rows: { name: string; source?: object }[], view: string) {
    const boot = readFileSync(join(HERE, "bootstrap.sh"), "utf8");
    const section = boot.slice(boot.indexOf("# --- the registered workspaces"), boot.indexOf("# --- the runners' records"));
    const root = join(dir, "ws");
    rmSync(root, { recursive: true, force: true });
    const home = join(root, "home");
    const repos = join(root, "repos");
    mkdirSync(join(home, ".switchboard"), { recursive: true });
    mkdirSync(repos);
    const db = new Database(join(home, ".switchboard", "switchboard.db"));
    db.run("CREATE TABLE workspaces (path TEXT, backlog_source TEXT)");
    for (const r of rows) db.run("INSERT INTO workspaces VALUES (?, ?)", [join(repos, r.name), r.source ? JSON.stringify(r.source) : null]);
    db.close();
    fake("gh", `echo "gh $*" >> "${log}"
case "$1 $2" in "repo clone") mkdir -p "$4";; "repo view") echo "${view}";; esac`);
    rmSync(log, { force: true });
    writeFileSync(join(root, "section.sh"), `as_user() { "$@"; }\nSB_HOST_HOME=${home}\nSB_REPOS_DIR=${repos}\n${section}`);
    const p = Bun.spawnSync(["bash", join(root, "section.sh")], { env: { PATH: `${join(dir, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString(), repos, left: readdirSync(repos).sort() };
  }
  const github = (repository: string, priv?: boolean) => ({ service: "github", host: "github.com", repository, project: { owner: "acme", number: 1 }, ...(priv === undefined ? {} : { private: priv }) });

  test("bootstrap clones a workspace from its registered repository", () => {
    const r = cloneWorkspaces([{ name: "app", source: github("acme/app-dev", true) }], "acme/app-dev true");
    expect(r.code).toBe(0);
    expect(calls().filter((c) => c.startsWith("gh repo clone"))).toEqual([`gh repo clone acme/app-dev ${join(r.repos, "app")} -- -q`]);
    expect(calls().join("\n")).not.toContain("acme/app ");
    expect(r.left).toEqual(["app"]);
    expect(r.out).toBe("");
  });

  test("bootstrap does not clone a workspace with no registered repository", () => {
    const r = cloneWorkspaces([{ name: "notes" }, { name: "local", source: { service: "switchboard", host: "local", repository: "ws_1", project: { owner: "switchboard", number: 0 } } }], "");
    expect(r.code).toBe(0);
    expect(calls()).toEqual([]);
    expect(r.left).toEqual([]);
    expect(r.out).toContain("bootstrap: not cloning notes: no registered GitHub repository");
    expect(r.out).toContain("bootstrap: not cloning local: no registered GitHub repository");
  });

  test("bootstrap moves aside a clone that is not the registered repository", () => {
    const r = cloneWorkspaces([{ name: "app", source: github("acme/app-dev") }], "acme/app false");
    expect(r.code).toBe(0);
    expect(r.left).toHaveLength(1);
    expect(r.left[0]).toMatch(/^app\.unverified-\d{8}T\d{6}Z$/);
    expect(r.out).toContain("bootstrap: moved app aside: the clone is acme/app, registered acme/app-dev");
    // GitHub's case is not a difference; no answer at all is
    expect(cloneWorkspaces([{ name: "app", source: github("acme/app-dev") }], "Acme/App-Dev false").left).toEqual(["app"]);
    expect(cloneWorkspaces([{ name: "app", source: github("acme/app-dev") }], "").out).toContain("bootstrap: moved app aside: GitHub did not say which repository the clone is");
  });

  test("bootstrap moves aside a public clone of a private registration", () => {
    const r = cloneWorkspaces([{ name: "app", source: github("acme/app", true) }], "acme/app false");
    expect(r.left[0]).toMatch(/^app\.unverified-/);
    expect(r.out).toContain("bootstrap: moved app aside: the clone of acme/app is public, registered private");
    // a registration with no visibility yet is checked by its name only
    expect(cloneWorkspaces([{ name: "app", source: github("acme/app") }], "acme/app false").left).toEqual(["app"]);
  });

  // sb-host-update (#435): a fake git whose clone puts the given sb-env.sh into a new tree; the installed ones are in bin/
  function hostUpdate(clone: string, prepare?: (opt: string) => void, repo?: string) {
    const root = join(dir, "hu");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "opt", "switchboard-host", "aws", "host"), { recursive: true });
    writeFileSync(join(root, "bin", "sb-env"), "old sb-env\n");
    prepare?.(join(root, "opt"));
    fake("aws", `case "$*" in *github-token*) echo gh-tok-123;; *github-repo*) ${repo ? `echo "${repo}"` : "exit 254"};; *) exit 254;; esac`);
    fake("git", `echo "git $* | header=$GIT_CONFIG_VALUE_0" >> "${log}"
case "$1 $3" in "-C remote") echo https://github.com/o/r.git; exit 0;; "-C rev-parse") echo abc1234; exit 0;; esac
[ "$1" = clone ] || exit 1
${clone}`);
    const r = run("host-update.sh", [], { SB_BIN_DIR: join(root, "bin"), SB_HOST_CLONE: join(root, "opt", "switchboard-host") });
    rmSync(join(dir, "bin", "git")); // the later tests (sb-offload) use the real one
    return { ...r, root };
  }
  const newTree = `for d; do :; done; mkdir -p "$d/aws/host"; for f in sb-stop sb-env archive runner-sync offload pre-rebuild node host-update; do echo "new $f" > "$d/aws/host/$f.sh"; done`;

  test("sb-host-update installs the host scripts from a fresh clone of main before sb-env runs (#435)", () => {
    const r = hostUpdate(newTree);
    expect(r.code).toBe(0);
    expect(r.out).toContain("sb-host-update: abc1234 from main");
    for (const [name, src] of [["sb-env", "sb-env"], ["sb-stop", "sb-stop"], ["sb-archive", "archive"], ["sb-runner-sync", "runner-sync"], ["sb-offload", "offload"], ["sb-pre-rebuild", "pre-rebuild"], ["sb-node", "node"], ["sb-host-update", "host-update"]]) {
      expect(readFileSync(join(r.root, "bin", name), "utf8")).toBe(`new ${src}\n`);
      expect(statSync(join(r.root, "bin", name)).mode & 0o777).toBe(0o755);
    }
    expect(existsSync(join(r.root, "opt", "switchboard-host", "aws", "host", "sb-env.sh"))).toBe(true); // the new clone took the old one's place
    // main's node pin is applied in a unit of its own (the download does not fit the start)
    expect(calls()).toContain(`systemd-run --unit=sb-node-update --no-block --collect --quiet -- ${join(r.root, "bin", "sb-node")}`);
    expect(existsSync(join(r.root, "opt", "switchboard-host.new"))).toBe(false);
    // With no parameter, the root-owned clone supplies the destination, and the journal says so.
    expect(readFileSync(log, "utf8")).toContain("clone --depth 1 --branch main -q https://github.com/o/r.git");
    expect(r.err).toContain("no readable /switchboard/github-repo; following the origin of");

    // the unit runs it before sb-env, and a failure does not stop the start
    const pre = readFileSync(join(HERE, "switchboard.service"), "utf8").split("\n").filter((l) => l.startsWith("ExecStartPre="));
    expect(pre[0]).toBe("ExecStartPre=-+/usr/bin/env HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/local/bin/sb-host-update");
    expect(pre[1]).toStartWith("ExecStartPre=+/usr/bin/env HOME=/root PATH=/usr/sbin:/usr/bin:/sbin:/bin /usr/local/bin/sb-env ");
    expect(readFileSync(join(HERE, "bootstrap.sh"), "utf8")).toContain('install -m 755 "$HERE/host-update.sh" /usr/local/bin/sb-host-update');
    expect(readFileSync(join(HERE, "host-update.sh"), "utf8").trimEnd().split("\n").at(-1)).toBe('main "$@"; exit'); // it replaces itself
  });

  test("sb-host-update follows the administrator's repository parameter", () => {
    const r = hostUpdate(newTree, undefined, "example/private");
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("clone --depth 1 --branch main -q https://github.com/example/private.git");
    expect(readFileSync(log, "utf8")).not.toContain("-C remote");
    expect(r.err).not.toContain("no readable");
  });

  test("sb-host-update ignores an invalid repository parameter and uses origin", () => {
    const r = hostUpdate(newTree, undefined, "not a repository");
    expect(r.code).toBe(0);
    expect(readFileSync(log, "utf8")).toContain("clone --depth 1 --branch main -q https://github.com/o/r.git");
    expect(r.err).toContain("no readable /switchboard/github-repo");
  });

  test("sb-host-update keeps the installed scripts and exits 0 when main cannot be fetched", () => {
    const r = hostUpdate(`for d; do :; done; mkdir -p "$d"; echo "fatal: unable to access" >&2; exit 128`);
    expect(r.code).toBe(0);
    expect(r.err).toContain("sb-host-update: could not fetch main (fatal: unable to access); keeping the installed scripts");
    expect(readFileSync(join(r.root, "bin", "sb-env"), "utf8")).toBe("old sb-env\n");
    expect(existsSync(join(r.root, "opt", "switchboard-host"))).toBe(true); // the old clone stays
    expect(existsSync(join(r.root, "opt", "switchboard-host.new"))).toBe(false);
    // a start cut between the two renames: the previous clone comes back from .old and is used
    const back = hostUpdate(newTree, (opt) => Bun.spawnSync(["mv", join(opt, "switchboard-host"), join(opt, "switchboard-host.old")]));
    expect(back.code).toBe(0);
    expect(back.out).toContain("from main");
    expect(existsSync(join(back.root, "opt", "switchboard-host.old"))).toBe(false);
    // no clone on this machine (a Mac, a host from before UserData kept it): nothing to do
    rmSync(join(r.root, "opt"), { recursive: true });
    fake("git", "exit 128");
    const none = run("host-update.sh", [], { SB_BIN_DIR: join(r.root, "bin"), SB_HOST_CLONE: join(r.root, "opt", "switchboard-host") });
    rmSync(join(dir, "bin", "git"));
    expect(none.code).toBe(0);
    expect(none.err).toContain("skipped");
  });

  test("sb-host-update installs itself first, and a script main no longer has does not stop the others", () => {
    const r = hostUpdate(newTree.replace("runner-sync ", ""));
    expect(r.code).toBe(0);
    expect(r.err).toContain("sb-host-update: main has no aws/host/runner-sync.sh; sb-runner-sync left as it was");
    expect(readFileSync(join(r.root, "bin", "sb-host-update"), "utf8")).toBe("new host-update\n");
    expect(readFileSync(join(r.root, "bin", "sb-offload"), "utf8")).toBe("new offload\n");
    expect(existsSync(join(r.root, "bin", "sb-runner-sync"))).toBe(false);
  });

  test("the scripts sb-host-update installs as root are the ones docs/design/cloud-hosting.md lists (#852)", () => {
    const sh = readFileSync(join(HERE, "host-update.sh"), "utf8");
    const self = sh.match(/install -m 755 "\$h\/(\S+)" "\$BIN\/(\S+)"/)!;
    const list = sh.match(/for src in (.+?); do/)![1].split(/\s+/).map((p) => p.split(":") as [string, string]);
    const installed = [[self[1], self[2]] as [string, string], ...list].map(([src, dst]) => `aws/host/${src} ${dst}`).sort();
    const doc = readFileSync(join(HERE, "..", "..", "docs", "design", "cloud-hosting.md"), "utf8");
    const section = doc.slice(doc.indexOf("### 6.5 "), doc.indexOf("#### 見直す契機"));
    const listed = [...section.matchAll(/^\| `(aws\/host\/[^`]+)` \| `([^`]+)` \|$/gm)].map((m) => `${m[1]} ${m[2]}`).sort();
    expect(listed).toEqual(installed);
  });

  test("the token goes in a header, never in the clone URL or on the command line of git", () => {
    const r = hostUpdate(newTree);
    expect(r.code).toBe(0);
    const clone = calls().find((l) => l.startsWith("git clone"))!;
    const [args, header] = clone.split(" | header=");
    expect(args).toBe(`git clone --depth 1 --branch main -q https://github.com/o/r.git ${join(r.root, "opt", "switchboard-host.new")}`);
    expect(args).not.toContain("gh-tok-123");
    expect(args).not.toContain(Buffer.from("x-access-token:gh-tok-123").toString("base64"));
    expect(header).toBe(`AUTHORIZATION: basic ${Buffer.from("x-access-token:gh-tok-123").toString("base64")}`);
    for (const l of calls()) expect(l.split(" | ")[0]).not.toContain("gh-tok-123");
  });

  test("the root steps of the unit do not take the host user's HOME or PATH (the agents can write there)", () => {
    const unit = readFileSync(join(HERE, "switchboard.service"), "utf8").split("\n");
    for (const l of unit.filter((x) => /^Exec\w+=[-@:!]*\+/.test(x))) expect(l).toMatch(/^Exec\w+=[-@:!]*\+\/usr\/bin\/env HOME=\/root PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin \//);
    expect(unit.filter((x) => /^ExecStartPre=[-@:!]*\+/.test(x)).length).toBe(2);
  });

  test("bootstrap keeps the workspace folder when the development repository is renamed", () => {
    const line = readFileSync(join(HERE, "bootstrap.sh"), "utf8").split("\n").find((l) => l.startsWith("REPO_DIR="))!;
    const r = Bun.spawnSync(["bash", "-c", `${line}\nprintf '%s' "$REPO_DIR"`], {
      env: { ...process.env, SB_REPOS_DIR: "/home/dev/repos", SB_GITHUB_REPO: "example/development" },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toBe("/home/dev/repos/switchboard");
  });

  test("bootstrap refuses to run without the stack's parameters", () => {
    const r = run("bootstrap.sh", []);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("SB_HOST_USER");
  });

  test("the daemon unit: runs sb-rescue as the host user, listens for CloudFront, stops through sb-stop, restarts", () => {
    const unit = readFileSync(join(HERE, "switchboard.service"), "utf8");
    for (const line of ["User=@USER@", "Environment=SWITCHBOARD_HOST=0.0.0.0", "Environment=SWITCHBOARD_RESCUE_HOST=0.0.0.0", "Environment=SWITCHBOARD_IDLE_STOP_CMD=/usr/local/bin/sb-stop", "Environment=SWITCHBOARD_RESCUE_RESTART_BY_EXIT=1", "Environment=SWITCHBOARD_RESCUE_OWNS_TMP=1", "EnvironmentFile=/etc/switchboard.env", "ExecStart=@HOME@/.bun/bin/bun @HOME@/.switchboard/rescue/sb-rescue.js", "Restart=always", "ExecStop=/bin/sh -c 'kill -TERM ${MAINPID} 2>/dev/null; while kill -0 ${MAINPID} 2>/dev/null; do sleep 0.5; done'"]) {
      expect(unit.split("\n")).toContain(line);
    }
    expect(unit).not.toMatch(/^KillMode=/m); // the default: whatever is left after sb-rescue gets SIGTERM, not SIGKILL (dev servers)
    expect(readFileSync(join(HERE, "sb-archive.timer"), "utf8")).toContain("OnCalendar=daily");
  });

  test("no author-specific user or path in the host files", () => {
    for (const f of readdirSync(HERE)) expect(readFileSync(join(HERE, f), "utf8")).not.toMatch(/\/Users\/|\/Volumes\//);
  });

  test("Litestream comes from the arm64 tarball with a pinned checksum and has its own unit; age is checked too (review #342)", () => {
    const boot = readFileSync(join(HERE, "bootstrap.sh"), "utf8");
    expect(boot).toContain("litestream-v$LITESTREAM_VERSION-linux-arm64.tar.gz");
    expect(boot).not.toContain(".rpm");
    expect(boot).toMatch(/LITESTREAM_SHA256=[0-9a-f]{64}/);
    expect(boot).toMatch(/AGE_SHA256=[0-9a-f]{64}/);
    expect(boot).toContain('sha256sum -c --quiet -');
    const unit = readFileSync(join(HERE, "litestream.service"), "utf8").split("\n");
    expect(unit).toContain("ExecStart=/usr/local/bin/litestream replicate -config /etc/litestream.yml");
    expect(boot).toContain("for u in switchboard.service sb-dockerd.service litestream.service sb-archive.service sb-archive.timer sb-runner-sync.service sb-runner-sync.timer; do");
  });

  test("the replica names its region, so Litestream never asks S3 for the bucket location (the role has no GetBucketLocation)", () => {
    const yml = readFileSync(join(HERE, "litestream.yml"), "utf8");
    expect(yml).toMatch(/\n\s+region: @REGION@/);
    expect(readFileSync(join(HERE, "bootstrap.sh"), "utf8")).toContain('-e "s|@REGION@|$REGION|g"');
  });

  test("a failed restore stops the bootstrap instead of starting an empty database (review #342)", () => {
    const boot = readFileSync(join(HERE, "bootstrap.sh"), "utf8");
    const restore = boot.slice(boot.indexOf("litestream restore"), boot.indexOf("litestream restore") + 200);
    expect(restore).not.toContain("|| true");
    expect(boot).toContain("restore -if-replica-exists");
  });

  test("the daily archive finds age (/usr/local/bin) and the host settings, and runs the release, not the working tree (review #342)", () => {
    const unit = readFileSync(join(HERE, "sb-archive.service"), "utf8").split("\n");
    expect(unit).toContain("Environment=PATH=/usr/local/bin:@HOME@/.bun/bin:/usr/bin:/bin");
    expect(unit).toContain("EnvironmentFile=/etc/switchboard-host.env");
    expect(readFileSync(join(HERE, "archive.sh"), "utf8")).toContain('CODE="$HOME/.switchboard/releases/current"');
  });

  test("the daily archive adds one line of disk usage, and a failure to write it does not stop the archive", () => {
    const home = join(dir, "home-disk");
    const sb = join(home, ".switchboard");
    mkdirSync(join(sb, "snapshots"), { recursive: true });
    writeFileSync(join(sb, "snapshots", "a.db"), "x".repeat(2 * 1024 * 1024));
    writeFileSync(join(sb, "switchboard.db"), "x");
    fake("aws", `[ "$1" = ssm ] && echo age1recipient; exit 0`);
    fake("bun", `echo pkg > "$3"`);
    for (const [d, mb] of [[".switchboard/releases", 1], [".claude/projects", 2], [".codex/sessions", 3], [".cache", 7]] as const) {
      mkdirSync(join(home, d), { recursive: true });
      writeFileSync(join(home, d, "f"), "x".repeat(mb * 1024 * 1024));
    }
    const file = join(sb, "disk-history.tsv");

    expect(run("archive.sh", [], { HOME: home }).code).toBe(0);
    expect(run("archive.sh", [], { HOME: home }).code).toBe(0);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1); // the second run of the day adds nothing
    const [date, used, free, db, snapshots, releases, runner, cache] = lines[0]!.split("\t");
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number(used)).toBeGreaterThan(0);
    expect(Number(free)).toBeGreaterThan(0);
    expect(Number(db)).toBeGreaterThan(0);
    expect(Number(snapshots)).toBeGreaterThanOrEqual(2);
    expect(Number(releases)).toBeLessThan(Number(runner));
    expect(Number(runner)).toBeGreaterThanOrEqual(5); // both folders
    expect(Number(cache)).toBeGreaterThan(Number(runner));

    rmSync(file);
    mkdirSync(file); // cannot be appended to
    expect(run("archive.sh", [], { HOME: home }).code).toBe(0);
    expect(readFileSync(join(sb, "archive.status"), "utf8")).toMatch(/^ok /);
  });

  test("the daily archive works on the disk, not /tmp, and records ok / failed in archive.status (#1201)", () => {
    const home = join(dir, "home-archive");
    const sb = join(home, ".switchboard");
    mkdirSync(join(sb, "archive-out"), { recursive: true });
    writeFileSync(join(sb, "archive-out", "stale"), "left by a killed run");
    fake("aws", `echo "aws $*" >> "${log}"; [ "$1" = ssm ] && echo age1recipient; exit 0`);
    // bun main.ts export <out> --encrypt <key>: records where it was told to write, writes there, exits $BUN_EXIT
    fake("bun", `echo "bun $*" >> "${log}"; [ -e "$(dirname "$3")/stale" ] && echo "stale still there" >> "${log}"; echo pkg > "$3"; exit "\${BUN_EXIT:-0}"`);
    const archive = (env: Record<string, string> = {}) => run("archive.sh", [], { HOME: home, ...env });
    const status = () => readFileSync(join(sb, "archive.status"), "utf8").trim();

    expect(archive().code).toBe(0);
    const exported = calls().find((c) => c.startsWith("bun "))!.split(" ")[3]!;
    expect(exported).toMatch(new RegExp(`^${join(sb, "archive-out")}/switchboard-\\d{8}T\\d{6}Z\\.tar\\.zst\\.age$`));
    expect(calls()).not.toContain("stale still there"); // the previous run's leftovers are gone before the export
    expect(calls()).toContain(`aws s3 cp ${exported} s3://bucket/archive/${exported.split("/").pop()} --only-show-errors`);
    expect(status()).toMatch(new RegExp(`^ok \\d+ archive/${exported.split("/").pop()!.replaceAll(".", "\\.")}$`));
    expect(existsSync(join(sb, "archive-out"))).toBe(false);

    expect(archive({ BUN_EXIT: "1" }).code).not.toBe(0);
    expect(status()).toMatch(/^failed \d+ 1$/);
    expect(calls().some((c) => c.startsWith("aws s3 cp"))).toBe(false);
    expect(existsSync(join(sb, "archive-out"))).toBe(false);

    // A leftover that cannot be removed fails the run before the export, and that is still recorded (review #1378).
    fake("bun", `echo pkg > "$3"`);
    expect(archive().code).toBe(0);
    expect(status()).toMatch(/^ok /);
    mkdirSync(join(sb, "archive-out", "locked", "x"), { recursive: true });
    chmodSync(join(sb, "archive-out", "locked"), 0o500);
    try {
      expect(archive().code).not.toBe(0);
      expect(calls().some((c) => c.startsWith("bun "))).toBe(false);
      expect(status()).toMatch(/^failed \d+ 1$/);
    } finally {
      chmodSync(join(sb, "archive-out", "locked"), 0o700);
    }

    // A run that is killed outright (oom-kill: no trap) leaves "running", which the daemon reads as stopped (#1209).
    fake("bun", `kill -9 $PPID`);
    archive();
    expect(status()).toMatch(/^running \d+$/);
  });

  describe("old tasks' events to history/events (#1438)", () => {
    const home = () => join(dir, "home-events");
    const committed = () => join(dir, "committed.tsv");
    const status = () => readFileSync(join(home(), ".switchboard", "archive.status"), "utf8").trim();
    const year = new Date().getUTCFullYear();
    // prepare writes two task files and the manifest; commit keeps what archive.sh told it was uploaded
    const bun = () =>
      fake(
        "bun",
        `echo "bun $*" >> "${log}"; case "$2 $3" in
         "export "*) echo pkg > "$3";;
         "events-archive prepare") mkdir -p "$4"; echo a > "$4/task_a.5.jsonl.zst.age"; echo b > "$4/task_b.9.jsonl.zst.age"
           echo '[{"taskId":"task_a","file":"task_a.5.jsonl.zst.age","count":5,"maxSeq":5,"sha256":"x"},{"taskId":"task_b","file":"task_b.9.jsonl.zst.age","count":3,"maxSeq":9,"sha256":"y"}]' > "$4/manifest.json";;
         "events-archive commit") cat "$4/uploaded.tsv" > "${committed()}" 2>/dev/null || : > "${committed()}";;
         esac`,
      );
    // put-object: $PUT_FAIL names a file whose upload fails, $PUT_EXISTS one that is already there (412)
    const aws = () =>
      fake(
        "aws",
        `echo "aws $*" >> "${log}"; [ "$1" = ssm ] && { echo age1recipient; exit 0; }
         case "$*" in *"$\{PUT_FAIL:-@@}"*) echo "An error occurred (AccessDenied) when calling the PutObject operation" >&2; exit 254;;
           *"$\{PUT_EXISTS:-@@}"*) echo "An error occurred (PreconditionFailed) when calling the PutObject operation" >&2; exit 254;; esac; exit 0`,
      );
    const archive = (env: Record<string, string> = {}) => run("archive.sh", [], { HOME: home(), ...env });
    const code = () => join(home(), ".switchboard", "releases", "current");
    const release = (main: string) => {
      mkdirSync(join(code(), "packages", "core", "src"), { recursive: true });
      writeFileSync(join(code(), "packages", "core", "src", "main.ts"), main);
    };

    test("a release from before events-archive only archives: its main.ts would start a second daemon", () => {
      bun();
      aws();
      release(`if (cmd === "export" || cmd === "import") {}`);
      expect(archive().code).toBe(0);
      expect(calls().some((l) => l.includes("events-archive"))).toBe(false);
      expect(status()).toMatch(/^ok \d+ archive\//);
    });

    test("archive uploads old tasks' events to history/events and commits only what was uploaded", () => {
      bun();
      aws();
      release(`if (cmd === "events-archive") {}`);
      expect(archive().code).toBe(0);
      const out = join(home(), ".switchboard", "archive-out");
      const c = calls();
      expect(c).toContain(`bun ${code()}/packages/core/src/main.ts events-archive prepare ${out}/events --encrypt age1recipient`);
      for (const f of ["task_a.5", "task_b.9"])
        expect(c).toContain(`aws s3api put-object --bucket bucket --key history/events/${year}/${f}.jsonl.zst.age --body ${out}/events/${f}.jsonl.zst.age --if-none-match *`);
      // the archive goes up first, then prepare, the uploads, and commit last
      expect(c.findIndex((l) => l.startsWith("aws s3 cp"))).toBeLessThan(c.findIndex((l) => l.includes("events-archive prepare")));
      expect(c[c.length - 1]).toBe(`bun ${code()}/packages/core/src/main.ts events-archive commit ${out}/events`);
      expect(readFileSync(committed(), "utf8")).toBe(`task_a\thistory/events/${year}/task_a.5.jsonl.zst.age\ntask_b\thistory/events/${year}/task_b.9.jsonl.zst.age\n`);
      expect(status()).toMatch(/^ok \d+ archive\//);
      // already there from a run that did not commit: counted as uploaded
      expect(archive({ PUT_EXISTS: "task_a.5" }).code).toBe(0);
      expect(readFileSync(committed(), "utf8")).toContain("task_a\t");
    });

    test("a failed upload keeps that task's events and marks the status failed", () => {
      bun();
      aws();
      release(`if (cmd === "events-archive") {}`);
      const r = archive({ PUT_FAIL: "task_a.5" });
      expect(r.code).toBe(3);
      expect(r.err).toContain(`history/events/${year}/task_a.5.jsonl.zst.age not uploaded`);
      // the other task still goes, and commit still runs for it
      expect(readFileSync(committed(), "utf8")).toBe(`task_b\thistory/events/${year}/task_b.9.jsonl.zst.age\n`);
      expect(status()).toMatch(/^failed \d+ 3$/);
      expect(existsSync(join(home(), ".switchboard", "archive-out"))).toBe(false);
    });
  });

  describe("old runner records to history/runner (#1440)", () => {
    const home = () => join(dir, "home-runner");
    const sb = () => join(home(), ".switchboard");
    const OLD = "11111111-1111-4111-8111-111111111111";
    const RUNNING = "22222222-2222-4222-8222-222222222222";
    const CODEX = "33333333-3333-4333-8333-333333333333";
    const put = (rel: string, daysOld: number) => {
      const f = join(home(), rel);
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, Buffer.alloc(1048576)); // 1 MiB each: the budget counts bytes
      const t = new Date(Date.now() - daysOld * 86400_000);
      utimesSync(f, t, t);
    };
    const setup = () => {
      rmSync(home(), { recursive: true, force: true });
      mkdirSync(sb(), { recursive: true });
      writeFileSync(join(sb(), "switchboard.db"), "");
      put(`.claude/projects/-w/${OLD}.jsonl`, 30);
      put(`.claude/projects/-w/${RUNNING}.jsonl`, 30);
      put(".claude/projects/-w/memory/note.md", 30);
      put(`.claude/projects/-w/${"4".repeat(8)}-4444-4444-8444-${"4".repeat(12)}.jsonl`, 3);
      put(`.codex/sessions/2026/09/01/rollout-2026-09-01T00-00-00-${CODEX}.jsonl`, 40);
      // bun -e reads the running tasks (RUNNING_IDS), the others are the export; tar / age pass bytes through
      fake("bun", `echo "bun $*" >> "${log}"; [ "$1" = -e ] && { for i in $RUNNING_IDS; do echo "$i"; done; exit 0; }; [ "$2" = export ] && echo pkg > "$3"; exit 0`);
      // APPEND_ON_TAR: a session that is resumed while the tarball is made
      fake("tar", `echo "tar $*" >> "${log}"; cat "$7" > /dev/null; [ -n "$APPEND_ON_TAR" ] && echo more >> "$APPEND_ON_TAR"; echo tarball`);
      fake("age", `echo "age $*" >> "${log}"; cat`);
      fake("aws", `echo "aws $*" >> "${log}"; [ "$1" = ssm ] && { echo age1recipient; exit 0; }; case "$*" in *history/runner*) [ -n "$RUNNER_PUT_FAIL" ] && exit 1;; esac; exit 0`);
    };
    // tar / age are fakes only here; later tests use the real ones
    afterAll(() => { for (const n of ["tar", "age"]) rmSync(join(dir, "bin", n), { force: true }); });
    // the newest 1 MiB stays (the 3-day-old file); everything past it moves
    const archive = (env: Record<string, string> = {}) => run("archive.sh", [], { HOME: home(), RUNNING_IDS: RUNNING, SB_RUNNER_KEEP_MB: "1", ...env });
    const list = () => (existsSync(join(sb(), "runner-archive.tsv")) ? readFileSync(join(sb(), "runner-archive.tsv"), "utf8") : "");

    test("old runner records go to history/runner and are listed, then removed", () => {
      setup();
      expect(archive().code).toBe(0);
      // a new key only: the host role's PutObject carries the If-None-Match condition
      const up = calls().find((l) => l.startsWith("aws s3api put-object") && l.includes("history/runner/"))!;
      expect(up).toMatch(/^aws s3api put-object --bucket bucket --key history\/runner\/runner-\d{8}T\d{6}Z\.tar\.zst\.age --body \S+ --if-none-match \*$/);
      expect(calls().some((l) => l.startsWith("age -r age1recipient"))).toBe(true);
      const key = up.split(" ")[6]!;
      const rows = list().trim().split("\n").map((l) => l.split("\t"));
      expect(rows.map((r) => r[0]).sort()).toEqual([`.claude/projects/-w/${OLD}.jsonl`, `.codex/sessions/2026/09/01/rollout-2026-09-01T00-00-00-${CODEX}.jsonl`]);
      expect(rows.find((r) => r[1] === OLD)![2]).toBe(key);
      expect(rows.find((r) => r[1] === CODEX)![3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Bun.spawnSync(["grep", OLD, join(sb(), "runner-archive.tsv")]).exitCode).toBe(0);
      expect(existsSync(join(home(), `.claude/projects/-w/${OLD}.jsonl`))).toBe(false);
      expect(existsSync(join(home(), `.codex/sessions/2026/09/01/rollout-2026-09-01T00-00-00-${CODEX}.jsonl`))).toBe(false);
      expect(readFileSync(join(sb(), "archive.status"), "utf8")).toMatch(/^ok /);
    });

    test("without SB_RUNNER_KEEP_MB the budget is a tenth of the root filesystem", () => {
      setup();
      const MID = join(home(), `.claude/projects/-w/${"5".repeat(8)}-5555-4555-8555-${"5".repeat(12)}.jsonl`);
      put(MID.slice(home().length + 1), 10); // inside the 25 days: only the budget can move it
      fake("df", `echo Filesystem 1048576-blocks Used Available Capacity Mounted; echo /dev/x $DF_MB 1 1 1% /`);
      try {
        // 40 GiB root: 4 GiB budget, the 10-day-old file stays
        expect(archive({ SB_RUNNER_KEEP_MB: "", DF_MB: "40960" }).code).toBe(0);
        expect(existsSync(MID)).toBe(true);
        // 10 MiB root: 1 MiB budget, it moves
        expect(archive({ SB_RUNNER_KEEP_MB: "", DF_MB: "10" }).code).toBe(0);
        expect(existsSync(MID)).toBe(false);
      } finally { rmSync(join(dir, "bin", "df"), { force: true }); }
    });

    test("a budget that cannot be worked out fails the run (exit 4) and keeps the records, the events still go", () => {
      for (const keep of ["", "abc"]) {
        setup();
        // a release that has events-archive; prepare writes one task file and its manifest, commit is only logged
        mkdirSync(join(home(), ".switchboard", "releases", "current", "packages", "core", "src"), { recursive: true });
        writeFileSync(join(home(), ".switchboard", "releases", "current", "packages", "core", "src", "main.ts"), `if (cmd === "events-archive") {}`);
        fake("bun", `echo "bun $*" >> "${log}"; [ "$1" = -e ] && { for i in $RUNNING_IDS; do echo "$i"; done; exit 0; }
          case "$2 $3" in "export "*) echo pkg > "$3";;
            "events-archive prepare") mkdir -p "$4"; echo a > "$4/task_a.5.jsonl.zst.age"
              echo '[{"taskId":"task_a","file":"task_a.5.jsonl.zst.age","count":5,"maxSeq":5,"sha256":"x"}]' > "$4/manifest.json";; esac; exit 0`);
        fake("df", "exit 1");
        try {
          const r = archive({ SB_RUNNER_KEEP_MB: keep });
          expect(r.code).toBe(4);
          expect(r.err).toContain("no usable runner budget");
          expect(existsSync(join(home(), `.claude/projects/-w/${OLD}.jsonl`))).toBe(true);
          const c = calls();
          expect(c.some((l) => l.includes("events-archive prepare"))).toBe(true);
          expect(c.some((l) => l.startsWith("aws s3api put-object") && l.includes("history/events/"))).toBe(true);
          expect(c.some((l) => l.includes("events-archive commit"))).toBe(true);
        } finally { rmSync(join(dir, "bin", "df"), { force: true }); }
      }
    });

    test("a record older than 25 days moves even when it is inside the budget", () => {
      setup();
      expect(archive({ SB_RUNNER_KEEP_MB: "100" }).code).toBe(0);
      expect(existsSync(join(home(), `.claude/projects/-w/${OLD}.jsonl`))).toBe(false);
      expect(readdirSync(join(home(), ".claude/projects/-w")).length).toBe(3);
    });

    test("memory/, a running task's session and a recent file stay", () => {
      setup();
      expect(archive().code).toBe(0);
      expect(existsSync(join(home(), ".claude/projects/-w/memory/note.md"))).toBe(true);
      expect(existsSync(join(home(), `.claude/projects/-w/${RUNNING}.jsonl`))).toBe(true);
      expect(readdirSync(join(home(), ".claude/projects/-w")).length).toBe(3);
      expect(list()).not.toContain(RUNNING);
    });

    test("a file appended to while it was uploaded is not removed", () => {
      setup();
      const f = join(home(), `.claude/projects/-w/${OLD}.jsonl`);
      expect(archive({ APPEND_ON_TAR: f }).code).toBe(0);
      expect(existsSync(f)).toBe(true);
      expect(existsSync(join(home(), `.codex/sessions/2026/09/01/rollout-2026-09-01T00-00-00-${CODEX}.jsonl`))).toBe(false);
    });

    test("a list that cannot be written removes nothing", () => {
      setup();
      mkdirSync(join(sb(), "runner-archive.tsv"));
      expect(archive().code).toBe(4);
      expect(existsSync(join(home(), `.claude/projects/-w/${OLD}.jsonl`))).toBe(true);
    });

    test("a record that cannot be removed fails the run (exit 4)", () => {
      setup();
      const dirp = join(home(), ".claude/projects/-w");
      chmodSync(dirp, 0o555);
      try {
        if (process.getuid?.() === 0) return; // root removes anyway
        const r = archive();
        expect(r.code).toBe(4);
        expect(r.err).toContain("could not remove");
      } finally {
        chmodSync(dirp, 0o755);
      }
    });

    test("without the database nothing moves: which sessions run is unknown", () => {
      setup();
      rmSync(join(sb(), "switchboard.db"));
      const r = archive();
      expect(r.code).toBe(0);
      expect(r.err).toContain("runner records stay");
      expect(existsSync(join(home(), `.claude/projects/-w/${OLD}.jsonl`))).toBe(true);
      expect(calls().some((l) => l.includes("history/runner"))).toBe(false);
    });

    test("a failed upload removes nothing and marks the status failed", () => {
      setup();
      const r = archive({ RUNNER_PUT_FAIL: "1" });
      expect(r.code).toBe(4);
      expect(r.err).toContain("runner records not uploaded");
      expect(existsSync(join(home(), `.claude/projects/-w/${OLD}.jsonl`))).toBe(true);
      expect(list()).toBe("");
      expect(readFileSync(join(sb(), "archive.status"), "utf8")).toMatch(/^failed \d+ 4\s*$/);
    });
  });

  test("nothing on the host rewrites CloudFront any more: the origin is a VPC origin (review #338)", () => {
    expect(existsSync(join(HERE, "sb-origin.sh"))).toBe(false);
    for (const f of readdirSync(HERE).filter((x) => !x.endsWith(".test.ts"))) expect(readFileSync(join(HERE, f), "utf8")).not.toMatch(/sb-origin|cloudfront/);
  });
});

describe("aws/host devtools (#371)", () => {
  const read = (f: string) => readFileSync(join(HERE, f), "utf8");

  test("bootstrap runs devtools once gh is logged in and the repository is there, before the units start", () => {
    const boot = read("bootstrap.sh");
    const at = boot.indexOf('bash "$HERE/devtools.sh"');
    expect(at).toBeGreaterThan(boot.indexOf("gh auth login --with-token"));
    expect(at).toBeGreaterThan(boot.indexOf("bun rescue/install.ts"));
    expect(at).toBeLessThan(boot.indexOf("# --- units ---"));
  });

  test("a devtools failure does not stop the bootstrap: the daemon and sb-rescue still start (#389)", () => {
    const line = read("bootstrap.sh").split("\n").find((l) => l.includes('bash "$HERE/devtools.sh"'))!;
    expect(line).toMatch(/^bash "\$HERE\/devtools\.sh" \|\| echo "bootstrap: devtools failed/);
    // the same shape, run: under set -e a failing command before || does not end the script
    const r = Bun.spawnSync(["bash", "-c", `set -euo pipefail; ${line.replace('bash "$HERE/devtools.sh"', "false")}; echo after`], { stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("after");
    expect(r.stderr.toString()).toContain("bootstrap: devtools failed (exit 1)"); // $? is devtools' own status (review #390)
    // and a failed devtools leaves no downloads in /tmp (RAM here) while the daemon goes on to start
    expect(read("devtools.sh")).toContain(`DL="$(mktemp -d)"; trap 'rm -rf "$DL"' EXIT`);
  });

  test("devtools refuses to run without the host user and home", () => {
    const r = run("devtools.sh", []);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("SB_HOST_USER");
  });

  test("every download has a pinned version and checksum and goes through the checksum check", () => {
    const dev = read("devtools.sh");
    expect(read("node.sh")).toMatch(/\nNODE_SHA256=[0-9a-f]{64}\n/);
    for (const name of ["DOCKER", "DOCKER_ROOTLESS", "COMPOSE", "UV", "GITLEAKS", "SAM"]) expect(dev).toMatch(new RegExp(`\\n${name}_SHA256=[0-9a-f]{64}\\n`));
    expect(dev).toContain('sha256sum -c --quiet -');
    // every curl is the checksummed fetch; the rest comes from dnf or a pinned npm / gh package
    expect(dev.match(/curl /g)?.length).toBe(1);
    expect(dev).toContain('npx -y "playwright@$PLAYWRIGHT_VERSION" install chromium');
    expect(dev).toContain('gh extension install github/gh-stack --pin "$GH_STACK_VERSION"');
    expect(dev).toContain('"@playwright/mcp@$PLAYWRIGHT_MCP_VERSION"');
    expect(dev).not.toMatch(/@latest|releases\/latest/);
  });

  test("root keeps what it unpacks: every tar is --no-same-owner (a tarball's owner uid can be the host user's, #375)", () => {
    const tars = [...read("devtools.sh").split("\n"), ...read("node.sh").split("\n"), ...read("bootstrap.sh").split("\n")].filter((l) => /\btar\b.*-x/.test(l) && !l.includes("as_user tar")); // the host user's own tar cannot chown anyway
    expect(tars.length).toBe(7);
    for (const l of tars) expect(l).toContain("tar --no-same-owner -x");
  });

  test("an interrupted install is redone, not taken for done (review #377)", () => {
    const dev = read("devtools.sh");
    // docker unpacks into <dir>.new and is renamed into place last, so the directory exists only when complete
    expect(dev).toContain('[ -d "$DOCKER_BIN" ] || {');
    expect(dev).toContain('mv "$DOCKER_BIN.new" "$DOCKER_BIN"');
    expect(dev).toContain('bash "$HERE/node.sh"'); // node: its own script, tested below
    expect(dev).toContain("[ -x /usr/local/bin/uv ] && [ -x /usr/local/bin/uvx ] || {");
    expect(dev).toContain("--bin-dir /usr/local/bin --update");
  });

  test("the user gets no root for docker: no docker group; sudoers allows only starting sb-dockerd", () => {
    const dev = read("devtools.sh");
    expect(dev).not.toMatch(/usermod|groupadd|sudoers|systemctl/);
    expect(dev).toContain("docker-rootless-extras-$DOCKER_VERSION.tgz");
    const sudo = read("bootstrap.sh").split("\n").find((l) => l.includes("NOPASSWD"))!;
    expect(sudo).toContain(", /usr/bin/systemctl start sb-dockerd");
    expect(sudo).not.toMatch(/systemctl (stop|restart) sb-dockerd|dockerd-rootless|\*/);
  });

  test("sb-dockerd: the rootless dockerd runs as the host user in a unit of its own, with a memory and swap ceiling", () => {
    const unit = read("sb-dockerd.service").split("\n");
    for (const line of ["User=@USER@", "Environment=XDG_RUNTIME_DIR=@HOME@/.docker/run", "Environment=DOCKERD_ROOTLESS_ROOTLESSKIT_NET=pasta", "ExecStart=/usr/local/lib/docker-rootless/bin/dockerd-rootless.sh", "MemoryMax=1536M", "MemorySwapMax=256M", "OOMPolicy=continue"]) expect(unit).toContain(line);
    expect(unit.join("\n")).not.toContain("[Install]"); // started on demand, not at boot
    const boot = read("bootstrap.sh");
    expect(boot).toMatch(/for u in switchboard\.service sb-dockerd\.service /);
    expect(boot).not.toMatch(/enable[^\n]*sb-dockerd/);
    // not in the daemon's cgroup any more: nothing in switchboard.service or dockerd-up starts it with setsid
    expect(read("dockerd-up.sh")).not.toMatch(/setsid|nohup|dockerd-rootless/);
  });

  test("the host user reads the whole journal (the kernel's OOM kills), and nothing more", () => {
    expect(read("bootstrap.sh")).toContain('usermod -aG systemd-journal "$SB_HOST_USER"');
    expect(read("bootstrap.sh")).not.toMatch(/usermod -aG[^\n]*(wheel|adm|docker)/);
  });

  test("dockerd-up starts sb-dockerd when docker does not answer, and fails when that is refused", () => {
    const bin = join(dir, "docker-bin-start");
    mkdirSync(bin, { recursive: true });
    const flag = join(dir, "dockerd-started");
    rmSync(flag, { force: true });
    writeFileSync(join(bin, "docker"), `#!/bin/sh
echo "docker $*" >> "${log}"
[ -f "${flag}" ]
`);
    chmodSync(join(bin, "docker"), 0o755);
    const sc = join(dir, "fake-systemctl");
    writeFileSync(sc, `#!/bin/sh
echo "systemctl $*" >> "${log}"
: > "${flag}"
`);
    chmodSync(sc, 0o755);
    const home = join(dir, "home-start");
    expect(run("dockerd-up.sh", [], { HOME: home, SB_DOCKER_BIN: bin, SB_SYSTEMCTL: sc }).code).toBe(0);
    expect(calls()).toEqual([`docker -H unix://${home}/.docker/run/docker.sock info`, "systemctl start sb-dockerd", `docker -H unix://${home}/.docker/run/docker.sock info`]);
    rmSync(flag, { force: true });
    writeFileSync(sc, `#!/bin/sh
exit 1
`);
    const r = run("dockerd-up.sh", [], { HOME: home, SB_DOCKER_BIN: bin, SB_SYSTEMCTL: sc });
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not start sb-dockerd");
  });

  test("docker build and compose up print the sb-offload hint, other commands do not (#678)", () => {
    const bin = join(dir, "docker-bin-hint");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho "docker $*" >> "${log}"\n`);
    chmodSync(join(bin, "docker"), 0o755);
    const hint = "docker: heavy builds and compose stacks can run off the host: sb-offload [--size large] <command> — small unless asked; a compose stack's checks can need large (開発リポジトリ aws/README.md, Offload)\n";
    // another DOCKER_HOST: dockerd-up is not asked, only the wrapper's own lines run
    const docker = (...a: string[]) => run("docker.sh", a, { HOME: join(dir, "home-hint"), SB_DOCKER_BIN: bin, DOCKER_HOST: "tcp://127.0.0.1:1" });
    for (const a of [["build", "-t", "x", "."], ["buildx", "build", "."], ["image", "build", "."], ["compose", "up", "--build"], ["compose", "-f", "c.yaml", "up", "-d"], ["compose", "--project-name=x", "-p", "y", "build"], ["compose", "build"]]) {
      const r = docker(...a);
      expect(r.err).toBe(hint);
      expect(r.code).toBe(0);
      expect(calls()).toEqual([`docker ${a.join(" ")}`]); // run as before, on the host
    }
    // only compose's own subcommand counts, not what a container is asked to run (review #687)
    for (const a of [["ps"], ["compose", "down"], ["compose", "logs", "app"], ["compose", "exec", "app", "build"], ["compose", "-p", "build", "ps"], ["compose", "run", "--rm", "app", "make", "up"], ["run", "--rm", "alpine", "true"], ["images"], ["buildx", "ls"]]) expect(docker(...a).err).toBe("");
  });

  test("the daemon's unit hands the runners the browser and the rootless docker socket", () => {
    const unit = read("switchboard.service").split("\n");
    for (const line of ["Environment=CHROME_BIN=/usr/local/bin/chromium", "Environment=CHROME_PATH=/usr/local/bin/chromium", "Environment=DOCKER_HOST=unix://@HOME@/.docker/run/docker.sock"]) expect(unit).toContain(line);
  });

  test("chromium runs the newest Playwright Chromium with the given arguments, and says how to get one when there is none", () => {
    const home = join(dir, "home-chromium");
    for (const rev of ["999", "1243"]) {
      const d = join(home, ".cache", "ms-playwright", `chromium-${rev}`, "chrome-linux-arm64");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "chrome"), `#!/bin/sh\necho "chrome-${rev} $*"\n`);
      chmodSync(join(d, "chrome"), 0o755);
    }
    const r = run("chromium.sh", ["--headless=new", "--remote-debugging-port=0"], { HOME: home });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("chrome-1243 --headless=new --remote-debugging-port=0");
    const none = run("chromium.sh", [], { HOME: join(dir, "home-empty") });
    expect(none.code).toBe(127);
    expect(none.err).toContain("npx playwright install chromium");
  });

  test("docker starts the rootless dockerd before the command, and leaves another DOCKER_HOST alone", () => {
    const bin = join(dir, "docker-bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho "docker $DOCKER_HOST $*" >> "${log}"\n`);
    chmodSync(join(bin, "docker"), 0o755);
    const up = join(dir, "dockerd-up");
    writeFileSync(up, `#!/bin/sh\necho "dockerd-up" >> "${log}"\n`);
    chmodSync(up, 0o755);
    const home = join(dir, "home-docker");
    const env = { HOME: home, SB_DOCKER_BIN: bin, SB_DOCKERD_UP: up };
    expect(run("docker.sh", ["ps", "-q"], env).code).toBe(0);
    expect(calls()).toEqual(["dockerd-up", `docker unix://${home}/.docker/run/docker.sock ps -q`]);
    expect(run("docker.sh", ["ps"], { ...env, DOCKER_HOST: "tcp://elsewhere:2375" }).code).toBe(0);
    expect(calls()).toEqual(["docker tcp://elsewhere:2375 ps"]);
    writeFileSync(up, `#!/bin/sh\necho "dockerd-up" >> "${log}"\nexit 1\n`);
    expect(run("docker.sh", ["ps"], env).code).not.toBe(0);
    expect(calls()).toEqual(["dockerd-up"]);
  });

  test("dockerd-up does nothing when the rootless dockerd already answers", () => {
    const bin = join(dir, "docker-bin-up");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho "docker $*" >> "${log}"\n`);
    chmodSync(join(bin, "docker"), 0o755);
    const home = join(dir, "home-up");
    expect(run("dockerd-up.sh", [], { HOME: home, SB_DOCKER_BIN: bin }).code).toBe(0);
    expect(calls()).toEqual([`docker -H unix://${home}/.docker/run/docker.sock info`]);
  });

  test("Claude settings change only explicitly selected keys, keeping existing settings", () => {
    const dt = read("devtools.sh");
    expect(dt.indexOf('as_user bash "$HERE/claude-settings.sh" "$SB_HOST_HOME/.claude/settings.json" "$OWN_SETTINGS"')).toBeGreaterThan(dt.indexOf("claude mcp add -s user playwright"));
    // the owner's patch: the development checkout's private/ first (a rebuild may start from the public copy), then this clone's
    expect(dt).toContain('DEV_CLONE="${SB_REPOS_DIR:-}/switchboard"');
    expect(dt).toContain('OWN_SETTINGS="$DEV_CLONE/private/claude-settings.json"');
    expect(dt).toContain('[ -f "$OWN_SETTINGS" ] || OWN_SETTINGS="$HERE/../../private/claude-settings.json"');
    const fresh = join(dir, "claude-fresh", ".claude", "settings.json");
    const mine = join(dir, "claude-mine", "settings.json");
    mkdirSync(join(dir, "claude-mine"));
    const original = { model: "opus", env: { FOO: "1" }, enabledPlugins: { "other@market": true, "selected@market": true } };
    writeFileSync(mine, JSON.stringify(original));
    expect(run("claude-settings.sh", [fresh]).code).toBe(0);
    expect(existsSync(fresh)).toBe(false);
    expect(run("claude-settings.sh", [mine]).code).toBe(0);
    expect(JSON.parse(readFileSync(mine, "utf8"))).toEqual(original);
    const patch = join(dir, "claude-settings.json");
    writeFileSync(patch, JSON.stringify({ env: { SELECTED: "false" }, enabledPlugins: { "selected@market": false } }));
    for (let i = 0; i < 2; i++) for (const f of [fresh, mine]) expect(run("claude-settings.sh", [f, patch]).code).toBe(0);
    expect(JSON.parse(readFileSync(fresh, "utf8"))).toEqual({ env: { SELECTED: "false" }, enabledPlugins: { "selected@market": false } });
    expect(JSON.parse(readFileSync(mine, "utf8"))).toEqual({ ...original, env: { FOO: "1", SELECTED: "false" }, enabledPlugins: { "other@market": true, "selected@market": false } });
    expect(existsSync(`${mine}.new`)).toBe(false);
  });

  test("the owner's patch is read from the development clone under SB_REPOS_DIR first, else from this clone (#2002)", () => {
    // the selection lines of devtools.sh as they are, run with a fake HERE (this clone's aws/host) and SB_REPOS_DIR
    const lines = read("devtools.sh").split("\n");
    const from = lines.findIndex((l) => l.startsWith("DEV_CLONE="));
    const pick = lines.slice(from, lines.findIndex((l, i) => i > from && l.startsWith('[ -f "$OWN_SETTINGS" ] ||')) + 1).join("\n");
    const root = join(dir, "own-settings");
    const here = join(root, "clone", "aws", "host");
    const repos = join(root, "repos");
    mkdirSync(here, { recursive: true });
    mkdirSync(join(root, "clone", "private"), { recursive: true });
    mkdirSync(join(repos, "switchboard", "private"), { recursive: true });
    const inClone = join(root, "clone", "private", "claude-settings.json");
    const inRepos = join(repos, "switchboard", "private", "claude-settings.json");
    writeFileSync(inClone, "{}");
    writeFileSync(inRepos, "{}");
    const chosen = () => {
      const r = Bun.spawnSync(["bash", "-c", `set -euo pipefail; HERE=${JSON.stringify(here)}; ${pick}\nprintf %s "$OWN_SETTINGS"`], { env: { PATH: process.env.PATH!, SB_REPOS_DIR: repos } });
      expect(r.exitCode).toBe(0);
      return r.stdout.toString();
    };
    expect(chosen()).toBe(inRepos);
    rmSync(inRepos);
    expect(chosen()).toBe(`${here}/../../private/claude-settings.json`); // = inClone
    expect(readFileSync(chosen(), "utf8")).toBe("{}");
  });
});

describe("aws/host runner records (#401, #402)", () => {
  const read = (f: string) => readFileSync(join(HERE, f), "utf8");
  // a fake aws that keeps what it was given: `aws s3 cp <file> s3://bucket/<key>` copies the file to $S3OUT/<key>, and
  // `s3 cp s3://bucket/<key> <file>` the other way; list-objects-v2 prints the keys under $S3OUT; AWS_FAIL fails it all
  const awsFake = () => fake("aws", `echo "aws $*" >> "${log}"; [ -n "$AWS_FAIL" ] && exit 1
case "$1 $2" in
  "s3 cp") case "$3" in s3://bucket/*) cp "$S3OUT/\${3#s3://bucket/}" "$4";; *) k="\${4#s3://bucket/}"; [ -e "$S3OUT/$k" ] && { echo "overwrote $k" >> "$S3OUT.overwrites"; }; mkdir -p "$(dirname "$S3OUT/$k")"; cp "$3" "$S3OUT/$k";; esac;;
  "s3api list-objects-v2") (cd "$S3OUT" 2>/dev/null && find . -type f | sed 's|^\./||' | sort | paste -sd'\t' -) | grep . || echo None;;
esac
exit 0`);
  let home: string, out: string;
  const sync = (env: Record<string, string> = {}) => run("runner-sync.sh", [], { HOME: home, S3OUT: out, ...env });
  const keys = () => (existsSync(out) ? Bun.spawnSync(["find", out, "-type", "f"]).stdout.toString().split("\n").filter(Boolean).map((f) => f.slice(out.length + 1)).sort() : []);
  const tarList = (key: string) => Bun.spawnSync(["tar", "--zstd", "-tf", join(out, key)]).stdout.toString().split("\n").filter((f) => f && !f.endsWith("/"));
  const uploads = () => calls().filter((l) => l.startsWith("aws s3 cp"));
  const fresh = () => { rmSync(out, { recursive: true, force: true }); rmSync(`${out}.overwrites`, { force: true }); rmSync(join(home, ".switchboard", "runner-sync.state"), { force: true }); };
  const touchAfter = (f: string, text: string) => { Bun.sleepSync(20); writeFileSync(f, text); };

  beforeAll(() => {
    home = join(dir, "home-runner");
    out = join(dir, "runner-out");
    mkdirSync(join(home, ".claude", "projects", "-work"), { recursive: true });
    mkdirSync(join(home, ".claude", "projects", "-work", "memory"), { recursive: true });
    writeFileSync(join(home, ".claude", "projects", "-work", "s1.jsonl"), '{"type":"user"}\n');
    writeFileSync(join(home, ".claude", "projects", "-work", "memory", "MEMORY.md"), "- a memory\n");
    mkdirSync(join(home, ".claude", "secrets-not-here"), { recursive: true });
    writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
  });

  test("runner-sync uploads Claude's sessions and memory (not its login) as a base, to a key of its own", () => {
    awsFake();
    fresh();
    const r = sync();
    expect(r.code).toBe(0);
    expect(r.err).toBe(""); // the first run has no state yet, and says nothing about it
    expect(keys()).toEqual([expect.stringMatching(/^archive\/runner\/\d{10}\/base\.tar\.zst$/)]);
    expect(uploads()[0]).toContain(join(home, ".cache", "sb-runner-sync.")); // scratch on the disk, not /tmp (RAM)
    const list = tarList(keys()[0]!);
    expect(list).toContain(".claude/projects/-work/s1.jsonl");
    expect(list).toContain(".claude/projects/-work/memory/MEMORY.md");
    expect(list.some((f) => f.includes("credentials"))).toBe(false);
    expect(readdirSync(join(home, ".cache")).filter((f) => f.startsWith("sb-runner-sync."))).toEqual([]); // cleaned up
  });

  test("runner-sync uploads a base first, then only the files that changed into the same set, and nothing on an unchanged day", () => {
    awsFake();
    fresh();
    sync();
    const base = keys()[0]!;
    const set = base.split("/")[2]!;
    expect(sync().out).toContain("unchanged");
    expect(uploads()).toEqual([]);
    touchAfter(join(home, ".claude", "projects", "-work", "s1.jsonl"), '{"type":"user"}\n{"type":"assistant"}\n');
    expect(sync().code).toBe(0);
    expect(uploads().length).toBe(1);
    const diff = keys().filter((k) => k !== base);
    expect(diff).toEqual([expect.stringMatching(new RegExp(`^archive/runner/${set}/\\d{10}\\.tar\\.zst$`))]);
    expect(tarList(diff[0]!)).toEqual([".claude/projects/-work/s1.jsonl"]); // that file only
    expect(sync().out).toContain("unchanged"); // and the difference is not uploaded again
    // two differences in the same second get two keys: the second does not write over the first
    touchAfter(join(home, ".claude", "projects", "-work", "s1.jsonl"), "a\n");
    sync();
    touchAfter(join(home, ".claude", "projects", "-work", "memory", "MEMORY.md"), "b\n");
    sync();
    expect(keys().filter((k) => k !== base).length).toBe(3);
    expect(existsSync(`${out}.overwrites`)).toBe(false); // no key is written twice, so the bucket keeps no old versions
  }, 20000);

  test("runner-sync starts a new set after 7 days and when the state is gone", () => {
    awsFake();
    fresh();
    sync();
    const state = join(home, ".switchboard", "runner-sync.state");
    const first = readFileSync(state, "utf8").trim();
    writeFileSync(state, `${Math.floor(Date.now() / 1000) - 8 * 24 * 3600}\n`);
    Bun.sleepSync(1100); // sets are named by the second
    sync();
    const sets = () => [...new Set(keys().map((k) => k.split("/")[2]))];
    expect(keys().filter((k) => k.endsWith("/base.tar.zst")).length).toBe(2);
    expect(readFileSync(state, "utf8").trim()).not.toBe(first);
    // an old-format state ("<sha256> <epoch>") is unreadable: a base again, not a crash
    writeFileSync(state, `${"a".repeat(64)} ${Math.floor(Date.now() / 1000)}\n`);
    Bun.sleepSync(1100); // sets are named by the second
    expect(sync().code).toBe(0);
    expect(keys().filter((k) => k.endsWith("/base.tar.zst")).length).toBe(3);
    rmSync(state);
    Bun.sleepSync(1100);
    sync();
    expect(keys().filter((k) => k.endsWith("/base.tar.zst")).length).toBe(4);
    expect(sets().length).toBe(4);
  });

  test("runner-sync does nothing without the folders, and a failed upload is not remembered as done", () => {
    awsFake();
    fresh();
    const empty = join(dir, "home-runner-empty");
    mkdirSync(empty, { recursive: true });
    expect(run("runner-sync.sh", [], { HOME: empty, S3OUT: out }).out).toContain("nothing to save");
    expect(calls()).toEqual([]);
    writeFileSync(join(home, ".claude", "projects", "-work", "s2.jsonl"), "{}\n");
    expect(sync({ AWS_FAIL: "1" }).code).not.toBe(0);
    expect(existsSync(join(home, ".switchboard", "runner-sync.state"))).toBe(false);
    sync();
    expect(uploads().length).toBe(1); // tried again, since the failed one was not recorded
    // a failed difference upload leaves the clock where it was: the next run carries those files
    touchAfter(join(home, ".claude", "projects", "-work", "s2.jsonl"), "{}\n{}\n");
    expect(sync({ AWS_FAIL: "1" }).code).not.toBe(0);
    sync();
    expect(uploads().length).toBe(1);
    expect(tarList(keys().find((k) => !k.endsWith("base.tar.zst"))!)).toContain(".claude/projects/-work/s2.jsonl");
  });

  test("restore brings back the newest set, the newest copy of each file, and keeps files already there", () => {
    awsFake();
    fresh();
    // an older set (its file must not come back) and a newer one: a base and two differences
    const put = (key: string, files: Record<string, string>) => {
      const src = join(dir, "restore-src");
      rmSync(src, { recursive: true, force: true });
      for (const [f, text] of Object.entries(files)) { mkdirSync(join(src, f, ".."), { recursive: true }); writeFileSync(join(src, f), text); }
      mkdirSync(join(out, key, ".."), { recursive: true });
      expect(Bun.spawnSync(["tar", "--zstd", "-cf", join(out, key), "-C", src, ...Object.keys(files)]).exitCode).toBe(0);
    };
    put("archive/runner/1700000000/base.tar.zst", { ".claude/projects/-w/old-set.jsonl": "old\n" });
    put("archive/runner/1700100000/base.tar.zst", { ".claude/projects/-w/a.jsonl": "base\n", ".claude/projects/-w/b.jsonl": "base\n", ".claude/projects/-w/here.jsonl": "from the base\n" });
    put("archive/runner/1700100000/1700103600.tar.zst", { ".claude/projects/-w/a.jsonl": "first\n" });
    put("archive/runner/1700100000/1700107200.tar.zst", { ".claude/projects/-w/a.jsonl": "second\n" });
    const target = join(dir, "home-restored");
    rmSync(target, { recursive: true, force: true });
    mkdirSync(join(target, ".claude", "projects", "-w"), { recursive: true });
    writeFileSync(join(target, ".claude", "projects", "-w", "here.jsonl"), "already here\n");
    const r = run("runner-sync.sh", ["restore"], { HOME: target, S3OUT: out });
    expect(r.code).toBe(0);
    const f = (n: string) => join(target, ".claude", "projects", "-w", n);
    expect(readFileSync(f("a.jsonl"), "utf8")).toBe("second\n");
    expect(readFileSync(f("b.jsonl"), "utf8")).toBe("base\n");
    expect(readFileSync(f("here.jsonl"), "utf8")).toBe("already here\n");
    expect(existsSync(f("old-set.jsonl"))).toBe(false);
    expect(readdirSync(join(target, ".cache")).filter((x) => x.startsWith("sb-runner-restore."))).toEqual([]);
  });

  test("restore does nothing when nothing was saved and fails when aws fails", () => {
    awsFake();
    fresh();
    const target = join(dir, "home-restored-none");
    mkdirSync(target, { recursive: true });
    const r = run("runner-sync.sh", ["restore"], { HOME: target, S3OUT: out });
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing saved yet");
    // a leftover of the old single-object form is not read
    mkdirSync(join(out, "archive", "runner"), { recursive: true });
    writeFileSync(join(out, "archive", "runner", "latest.tar.zst"), "x");
    expect(run("runner-sync.sh", ["restore"], { HOME: target, S3OUT: out }).out).toContain("nothing saved yet");
    const bad = run("runner-sync.sh", ["restore"], { HOME: target, S3OUT: out, AWS_FAIL: "1" });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("could not list");
  });

  test("a session written to while tar reads it does not stop the upload (review #404: tar exits 1 on a changed file)", () => {
    awsFake();
    writeFileSync(join(home, ".claude", "projects", "-work", "s3.jsonl"), "{}\n");
    // a tar that archives, then reports "file changed as we read it" (exit 1) as GNU tar does for an active session
    const bin = join(dir, "bin-tar-changed");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "tar"), `#!/bin/sh\n/usr/bin/tar "$@" || exit $?\necho "tar: file changed as we read it" >&2\nexit 1\n`);
    chmodSync(join(bin, "tar"), 0o755);
    fresh();
    const r = run("runner-sync.sh", [], { HOME: home, S3OUT: out, PATH: `${bin}:${join(dir, "bin")}:/usr/bin:/bin` });
    expect(r.code).toBe(0);
    expect(uploads().length).toBe(1);
    // anything worse than exit 1 still stops it
    writeFileSync(join(bin, "tar"), `#!/bin/sh\nexit 2\n`);
    fresh();
    expect(run("runner-sync.sh", [], { HOME: home, S3OUT: out, PATH: `${bin}:${join(dir, "bin")}:/usr/bin:/bin` }).code).toBe(2);
    expect(read("runner-sync.sh")).toContain("flock -w 60 9"); // a stuck run does not hold up sb-stop or 作り直す forever
    // a run killed by 作り直す's time limit leaves its scratch behind (bash's EXIT trap does not run on TERM): the next
    // run clears what is over an hour old (review #405)
    const stale = join(home, ".cache", "sb-runner-sync.stale1");
    mkdirSync(stale, { recursive: true });
    Bun.spawnSync(["touch", "-d", "2 hours ago", stale]);
    const young = join(home, ".cache", "sb-runner-sync.fresh1");
    mkdirSync(young, { recursive: true });
    awsFake();
    sync();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(young)).toBe(true);
    rmSync(young, { recursive: true, force: true });
  });

  test("a folder that cannot be read stops the save: a partial snapshot never replaces the good one (review #404)", () => {
    awsFake();
    const locked = join(home, ".claude", "projects", "-locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "s.jsonl"), "{}\n");
    chmodSync(locked, 0o000);
    try {
      const r = sync();
      expect(r.code).not.toBe(0);
      expect(calls()).toEqual([]);
    } finally {
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true, force: true });
    }
  });

  test("sb-stop saves the runners' records before stopping, and stops even when that fails", () => {
    fake("aws", `echo "aws $*" >> "${log}"`);
    const saver = join(dir, "fake-runner-sync");
    writeFileSync(saver, `#!/bin/sh\necho "sb-runner-sync" >> "${log}"\nexit 1\n`);
    chmodSync(saver, 0o755);
    expect(run("sb-stop.sh", ["-"], { SB_RUNNER_SYNC: saver }).code).toBe(0);
    expect(calls()).toEqual(["aws scheduler delete-schedule --name switchboard-wake", "sb-runner-sync", "systemctl stop litestream", "shutdown -h now"]);
  });

  test("bootstrap brings the records back as the host user after the history, before the units, without overwriting", () => {
    const boot = read("bootstrap.sh");
    const at = boot.indexOf("# --- the runners' records (#401)");
    expect(at).toBeGreaterThan(boot.indexOf("# --- the one-time move from the Mac"));
    expect(at).toBeLessThan(boot.indexOf("# --- units ---"));
    const block = boot.slice(at, boot.indexOf("# --- units ---"));
    // the host user unpacks, in runner-sync.sh (restore keeps files already there with --skip-old-files)
    expect(block).toContain("as_user env SB_HOST_ENV=/etc/switchboard-host.env /usr/local/bin/sb-runner-sync restore");
    expect(read("runner-sync.sh")).toContain("tar --zstd --skip-old-files -xf");
    // only "nothing saved" skips the restore; any other failure stops the bootstrap, as for Litestream, so the first
    // sync cannot put a near-empty base over the good one (review #404)
    expect(block).toMatch(/could not bring back .*exit 1/s);
    expect(read("runner-sync.sh")).toContain('mktemp -d "$HOME/.cache/sb-runner-restore.XXXXXX"'); // not /tmp (RAM)
    expect(boot).toContain('install -m 755 "$HERE/runner-sync.sh" /usr/local/bin/sb-runner-sync');
    expect(boot).toContain("systemctl enable $NOW litestream.service sb-archive.timer sb-runner-sync.timer switchboard.service"); // --now unless a reboot is due (#2186)
    expect(read("switchboard.service").split("\n")).toContain("Environment=SWITCHBOARD_REBUILD_SAVE_CMD=/usr/local/bin/sb-runner-sync"); // #403
    const timer = read("sb-runner-sync.timer").split("\n");
    expect(timer).toContain("OnCalendar=hourly");
    const unit = read("sb-runner-sync.service").split("\n");
    for (const l of ["User=@USER@", "EnvironmentFile=/etc/switchboard-host.env", "ExecStart=/usr/local/bin/sb-runner-sync"]) expect(unit).toContain(l);
  });
});

describe("aws/host memory (#537)", () => {
  const read = (f: string) => readFileSync(join(HERE, f), "utf8");
  let m: string;

  beforeAll(() => {
    m = mkdtempSync(join(tmpdir(), "switchboard-test-memory-"));
    mkdirSync(join(m, "sysctl.d"));
    writeFileSync(join(m, "fstab"), "UUID=1 / xfs defaults 0 0\n");
    writeFileSync(join(m, "active"), "");
    const mlog = join(m, "calls.log");
    // dd makes the file it is asked for; swapon lists what was switched on and switches on what it is given
    fake("dd", `echo "dd $*" >> "${mlog}"; for a in "$@"; do case "$a" in of=*) : > "\${a#of=}";; esac; done`);
    fake("mkswap", `case " $* " in *" -q "*) echo "mkswap: invalid option -- 'q'" >&2; exit 1;; esac; echo "mkswap $*" >> "${mlog}"`); // util-linux 2.37 (AL2023) has no -q
    fake("sysctl", `echo "sysctl $*" >> "${mlog}"`);
    fake("swapon", `if [ "$1" = "--show=NAME" ]; then cat "${join(m, "active")}"; else echo "swapon $*" >> "${mlog}"; echo "$1" >> "${join(m, "active")}"; fi`);
  });
  afterAll(() => rmSync(m, { recursive: true, force: true }));
  const env = () => ({ SB_SWAPFILE: join(m, "swapfile"), SB_SWAP_MB: "2", SB_FSTAB: join(m, "fstab"), SB_SYSCTL_D: join(m, "sysctl.d") });
  const mcalls = () => (existsSync(join(m, "calls.log")) ? readFileSync(join(m, "calls.log"), "utf8").trim().split("\n") : []);

  test("memory.sh makes a private swap file, switches it on, keeps it across reboots and lowers swappiness", () => {
    const r = run("memory.sh", [], env());
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const c = mcalls();
    expect(c.map((l) => l.split(" ")[0])).toEqual(["dd", "mkswap", "swapon", "sysctl"]);
    expect(c[0]).toContain(`of=${join(m, "swapfile")}.new bs=1M count=2`);
    expect(existsSync(join(m, "swapfile"))).toBe(true);
    expect(existsSync(join(m, "swapfile.new"))).toBe(false);
    expect(statSync(join(m, "swapfile")).mode & 0o777).toBe(0o600);
    expect(c[2]).toBe(`swapon ${join(m, "swapfile")}`);
    expect(readFileSync(join(m, "fstab"), "utf8")).toBe(`UUID=1 / xfs defaults 0 0\n${join(m, "swapfile")} none swap sw 0 0\n`);
    expect(readFileSync(join(m, "sysctl.d", "99-switchboard-memory.conf"), "utf8")).toBe("vm.swappiness=10\n");
  });

  test("a second run changes nothing: no new file, no second swapon, no second fstab line", () => {
    const before = readFileSync(join(m, "fstab"), "utf8");
    rmSync(join(m, "calls.log"), { force: true });
    expect(run("memory.sh", [], env()).code).toBe(0);
    expect(mcalls().map((l) => l.split(" ")[0])).toEqual(["sysctl"]);
    expect(readFileSync(join(m, "fstab"), "utf8")).toBe(before);
  });

  test("an interrupted run (a half-written .new file, no swap file) is redone from the start", () => {
    rmSync(join(m, "swapfile"));
    writeFileSync(join(m, "active"), "");
    writeFileSync(join(m, "swapfile.new"), "half");
    rmSync(join(m, "calls.log"), { force: true });
    expect(run("memory.sh", [], env()).code).toBe(0);
    expect(mcalls().map((l) => l.split(" ")[0])).toEqual(["dd", "mkswap", "swapon", "sysctl"]);
    expect(existsSync(join(m, "swapfile.new"))).toBe(false);
    expect(readFileSync(join(m, "fstab"), "utf8").match(/none swap/g)).toHaveLength(1);
  });

  test("the daemon's unit has a memory ceiling as a share of the machine, and one killed process does not stop the unit", () => {
    const unit = read("switchboard.service").split("\n");
    for (const line of ["MemoryMax=85%", "MemorySwapMax=512M", "OOMPolicy=continue", "ManagedOOMMemoryPressure=kill", "ManagedOOMMemoryPressureLimit=50%"]) expect(unit).toContain(line);
    // the swap cap is below the swap file, or the unit can still fill it and thrash
    expect(Number(read("memory.sh").match(/SB_SWAP_MB:-(\d+)/)![1])).toBeGreaterThan(512);
  });

  test("no unit throttles itself with MemoryHigh (a unit throttled between high and max stalls), and oomd runs", () => {
    for (const u of ["switchboard.service", "sb-dockerd.service"]) {
      const unit = read(u);
      expect(unit).not.toMatch(/^MemoryHigh=/m);
      expect(unit).toMatch(/^ManagedOOMMemoryPressure=kill$/m);
    }
    const line = read("bootstrap.sh").split("\n").find((l) => l.includes("systemctl enable --now systemd-oomd"))!;
    expect(line).toBeDefined();
    const boot = read("bootstrap.sh");
    expect(boot).toContain('|| echo "bootstrap: systemd-oomd could not start');
    expect(boot.indexOf("systemd-oomd")).toBeGreaterThan(boot.indexOf("systemctl daemon-reload"));
  });

  test("bootstrap sets the swap up before the units, and a failure does not stop it (the host still serves)", () => {
    const boot = read("bootstrap.sh");
    const line = boot.split("\n").find((l) => l.includes('bash "$HERE/memory.sh"'))!;
    expect(line).toMatch(/^bash "\$HERE\/memory\.sh" \|\| echo "bootstrap: swap failed/);
    const r = Bun.spawnSync(["bash", "-c", `set -euo pipefail; ${line.replace('bash "$HERE/memory.sh"', "(exit 5)")}; echo after`], { stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("after");
    expect(r.stderr.toString()).toContain("bootstrap: swap failed (exit 5)");
    expect(boot.indexOf(line)).toBeLessThan(boot.indexOf("# --- units ---"));
    expect(boot.indexOf(line)).toBeGreaterThan(boot.indexOf("dnf install -y -q git"));
  });
});

describe("aws/host cloudwatch (#539)", () => {
  const read = (f: string) => readFileSync(join(HERE, f), "utf8");
  const block = () => {
    const boot = read("bootstrap.sh");
    const from = boot.indexOf("CWA=/opt/aws/amazon-cloudwatch-agent");
    return { boot, text: boot.slice(from, boot.indexOf("# --- host scripts and settings for them ---")).trim() };
  };

  test("the agent sends only memory and swap use to CWAgent, per instance, every minute", () => {
    const cfg = JSON.parse(read("cloudwatch-agent.json"));
    expect(cfg.agent.metrics_collection_interval).toBe(60);
    expect(cfg.metrics.namespace).toBe("CWAgent");
    expect(cfg.metrics.append_dimensions).toEqual({ InstanceId: "${aws:InstanceId}" });
    expect(Object.keys(cfg.metrics.metrics_collected).sort()).toEqual(["mem", "swap"]);
    expect(cfg.metrics.metrics_collected.mem.measurement).toEqual(["mem_used_percent"]);
    expect(cfg.metrics.metrics_collected.swap.measurement).toEqual(["swap_used_percent"]);
  });

  test("the agent also ships the daemon's log (access / operation lines, #1490) to the host's group, and leaves its retention to the template", () => {
    const cfg = JSON.parse(read("cloudwatch-agent.json"));
    const files = cfg.logs.logs_collected.files.collect_list as Array<Record<string, unknown>>;
    expect(files).toEqual([{ file_path: "@HOME@/.switchboard/daemon.log", log_group_name: "/switchboard/host", log_stream_name: "{instance_id}", retention_in_days: -1 }]);
  });

  test("bootstrap fills @HOME@ in the agent's config and leaves none", () => {
    const { text } = block();
    expect(text).toContain('sed -e "s|@HOME@|$SB_HOST_HOME|g" "$HERE/cloudwatch-agent.json"');
  });

  test("bootstrap installs and starts the agent after the tools and before the units", () => {
    const { boot, text } = block();
    expect(text).toContain("dnf install -y -q amazon-cloudwatch-agent");
    expect(text).toContain("amazon-cloudwatch-agent-ctl");
    expect(text).toContain("fetch-config -m ec2 -s");
    const at = boot.indexOf("CWA=/opt/aws/amazon-cloudwatch-agent");
    expect(at).toBeGreaterThan(boot.indexOf("codex/install.sh"));
    expect(at).toBeLessThan(boot.indexOf("# --- units ---"));
  });

  test("a failing agent (install or ctl) does not stop the bootstrap: it says so and goes on", () => {
    const { text } = block();
    for (const failing of ["dnf", "ctl"]) {
      const root = mkdtempSync(join(dir, "cwa-"));
      mkdirSync(join(root, "agent", "bin"), { recursive: true });
      mkdirSync(join(root, "agent", "etc"));
      const bin = join(root, "bin");
      mkdirSync(bin);
      const put = (path: string, body: string) => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
      put(join(bin, "dnf"), failing === "dnf" ? "exit 3" : `echo "dnf $*" >> "${root}/calls"`);
      put(join(root, "agent", "bin", "amazon-cloudwatch-agent-ctl"), failing === "ctl" ? "exit 4" : `echo "ctl $*" >> "${root}/calls"`);
      const script = `set -euo pipefail; HERE="${HERE}"; SB_HOST_HOME=/home/h; ${text.replace("CWA=/opt/aws/amazon-cloudwatch-agent", `CWA="${root}/agent"`)}; echo after`;
      const r = Bun.spawnSync(["bash", "-c", script], { env: { PATH: `${bin}:/usr/bin:/bin` }, stderr: "pipe", stdout: "pipe" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toString()).toContain("after");
      expect(r.stderr.toString()).toContain(`bootstrap: the CloudWatch agent failed (exit ${failing === "dnf" ? 3 : 4}); the host starts without memory metrics`);
      const seen = existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8") : "";
      if (failing === "dnf") expect(seen).toBe(""); // nothing after a failed install
      else {
        expect(seen).toContain("dnf install -y -q amazon-cloudwatch-agent");
        expect(readFileSync(join(root, "agent", "etc", "amazon-cloudwatch-agent.json"), "utf8")).toBe(read("cloudwatch-agent.json").replaceAll("@HOME@", "/home/h"));
      }
    }
  });

  test("with everything working the agent config is installed and ctl fetches it", () => {
    const { text } = block();
    const root = mkdtempSync(join(dir, "cwa-"));
    mkdirSync(join(root, "agent", "bin"), { recursive: true });
    mkdirSync(join(root, "agent", "etc"));
    mkdirSync(join(root, "bin"));
    const put = (path: string, body: string) => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); };
    put(join(root, "bin", "dnf"), `echo "dnf $*" >> "${root}/calls"`);
    put(join(root, "agent", "bin", "amazon-cloudwatch-agent-ctl"), `echo "ctl $*" >> "${root}/calls"`);
    const script = `set -euo pipefail; HERE="${HERE}"; SB_HOST_HOME=/home/h; ${text.replace("CWA=/opt/aws/amazon-cloudwatch-agent", `CWA="${root}/agent"`)}; echo after`;
    const r = Bun.spawnSync(["bash", "-c", script], { env: { PATH: `${join(root, "bin")}:/usr/bin:/bin` }, stderr: "pipe", stdout: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toBe("");
    expect(readFileSync(join(root, "calls"), "utf8")).toContain(`ctl -a fetch-config -m ec2 -s -c file:${root}/agent/etc/amazon-cloudwatch-agent.json`);
    const installed = readFileSync(join(root, "agent", "etc", "amazon-cloudwatch-agent.json"), "utf8");
    expect(installed).not.toContain("@HOME@");
    expect(JSON.parse(installed).logs.logs_collected.files.collect_list[0].file_path).toBe("/home/h/.switchboard/daemon.log");
  });
});

describe("aws/host offload (#678)", () => {
  // a fake aws that logs its calls, keeps the upload in $S3OUT and answers from files in $FAKE: status (the build's
  // "<status> <group> <stream>") and events.json (one page of the log; a call with its token gets no more)
  let home: string, repo: string, fakeDir: string, out: string;
  const awsFake = () =>
    fake(
      "aws",
      `echo "aws $*" >> "${log}"
case "$1 $2" in
  "ssm get-parameter") echo sb-host-offload ;;
  "s3 cp") cp "$3" "$S3OUT" ;;
  "codebuild start-build") [ -f "$FAKE/busy" ] && { rm "$FAKE/busy"; echo "An error occurred (AccountLimitExceededException) when calling the StartBuild operation: Cannot have more than 2 active builds for the project" >&2; exit 254; }; echo "sb-host-offload:build-1" ;;
  "codebuild batch-get-builds") cat "$FAKE/status" ;;
  "logs get-log-events") case "$*" in *--next-token*) echo '{"events":[],"nextForwardToken":"f/2"}' ;; *) cat "$FAKE/events.json" ;; esac ;;
esac
exit 0`,
    );
  const setLog = (status: string, lines: string[]) => {
    writeFileSync(join(fakeDir, "status"), `${status}\t/aws/codebuild/sb-host-offload\tbuild-1\n`);
    writeFileSync(join(fakeDir, "events.json"), JSON.stringify({ events: lines.map((message) => ({ message: `${message}\n` })), nextForwardToken: "f/2" }));
  };
  const offload = (args: string[], env: Record<string, string> = {}) => {
    rmSync(log, { force: true });
    const p = Bun.spawnSync(["bash", join(HERE, "offload.sh"), ...args], {
      cwd: repo,
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, SB_HOST_ENV: join(dir, "host.env"), HOME: home, FAKE: fakeDir, S3OUT: out, ...env },
      stderr: "pipe",
      stdout: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const git = (...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: repo });

  beforeAll(() => {
    home = join(dir, "home-offload");
    repo = join(dir, "repo-offload");
    fakeDir = join(dir, "fake-offload");
    out = join(dir, "offload-out.tar.gz");
    for (const d of [home, repo, fakeDir]) mkdirSync(d, { recursive: true });
    git("init", "-q");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n.env\n");
    writeFileSync(join(repo, "compose.yaml"), "services: {}\n");
    writeFileSync(join(repo, "gone.txt"), "deleted in the work tree\n");
    git("add", ".");
    git("commit", "-qm", "init");
    writeFileSync(join(repo, "compose.yaml"), "services: { app: {} }\n"); // uncommitted
    writeFileSync(join(repo, "new.py"), "print(1)\n"); // untracked
    rmSync(join(repo, "gone.txt"));
    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "big.js"), "x\n"); // ignored
    writeFileSync(join(repo, ".env"), "SECRET=1\n"); // ignored
    // an untracked clone inside the work tree: git lists it as one directory; its files (ignored ones too) stay here
    mkdirSync(join(repo, "nested", "node_modules"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: join(repo, "nested") });
    writeFileSync(join(repo, "nested", ".gitignore"), "node_modules/\n.env\n");
    writeFileSync(join(repo, "nested", ".env"), "SECRET=2\n");
    writeFileSync(join(repo, "nested", "node_modules", "big.js"), "x\n");
    // a submodule: its tracked files go (review #685)
    const sub = join(dir, "sub-offload");
    mkdirSync(sub, { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: sub });
    writeFileSync(join(sub, "lib.py"), "x = 1\n");
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qam", "s", "--allow-empty"], { cwd: sub });
    Bun.spawnSync(["git", "add", "lib.py"], { cwd: sub });
    Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "lib"], { cwd: sub });
    git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/sub");
  });

  test("sb-offload sends the worktree with uncommitted and untracked files, not ignored ones, and starts the offload project with the command", () => {
    awsFake();
    setLog("SUCCEEDED", ["sb-offload: exit 0"]);
    const r = offload(["docker", "compose", "up", "--build", "&&", "pytest", "-k", "a,b"]);
    expect(r.code).toBe(0);
    const files = Bun.spawnSync(["tar", "-tzf", out]).stdout.toString().trim().split("\n").sort();
    // the nested clone's folder, nothing in it; the submodule's tracked files (review #685)
    expect(files).toEqual([".gitignore", ".gitmodules", "compose.yaml", "nested/", "new.py", "vendor/sub/lib.py"]);
    expect(Bun.spawnSync(["tar", "-xzOf", out, "compose.yaml"]).stdout.toString()).toBe("services: { app: {} }\n");
    const c = calls();
    const up = c.find((l) => l.startsWith("aws s3 cp "))!;
    expect(up).toMatch(/ s3:\/\/bucket\/offload\/[0-9TZ]+-[A-Za-z0-9]+\.tar\.gz --only-show-errors$/);
    expect(up).toContain(join(home, ".cache", "sb-offload.")); // scratch on the disk, not /tmp (RAM)
    const key = up.match(/s3:\/\/bucket\/(offload\/\S+)/)![1];
    expect(c).toContain("aws ssm get-parameter --name /switchboard/offload-project --query Parameter.Value --output text");
    const start = c.find((l) => l.startsWith("aws codebuild start-build"))!;
    expect(start).toContain("--project-name sb-host-offload --compute-type-override BUILD_GENERAL1_SMALL --environment-variables-override "); // the smallest unless asked (#2304)
    const envs = JSON.parse(start.slice(start.indexOf("[{"), start.lastIndexOf("}]") + 2));
    expect(envs).toEqual([
      { name: "SB_OFFLOAD_KEY", value: key, type: "PLAINTEXT" },
      { name: "SB_OFFLOAD_CMD", value: "docker compose up --build && pytest -k a,b", type: "PLAINTEXT" },
    ]);
    expect(r.err.split("\n")[0]).toBe("sb-offload: sent the work tree (5 files, 0 MB) and started sb-host-offload:build-1 (small)");
    expect(readdirSync(join(home, ".cache")).filter((f) => f.startsWith("sb-offload."))).toEqual([]); // cleaned up
  });

  test("sb-offload --size picks the machine for this build; a size off the list sends nothing and exits 2 (#2304)", () => {
    awsFake();
    setLog("SUCCEEDED", ["sb-offload: exit 0"]);
    const startOf = () => calls().find((l) => l.startsWith("aws codebuild start-build"))!;
    for (const [args, compute, size] of [[["--size", "large"], "BUILD_GENERAL1_LARGE", "large"], [["--size=medium"], "BUILD_GENERAL1_MEDIUM", "medium"]] as const) {
      const r = offload([...args, "docker", "compose", "up"]);
      expect(r.code).toBe(0);
      expect(startOf()).toContain(`--compute-type-override ${compute} `);
      const envs = JSON.parse(startOf().slice(startOf().indexOf("[{"), startOf().lastIndexOf("}]") + 2));
      expect(envs[1].value).toBe("docker compose up"); // the rest is the command
      expect(r.err.split("\n")[0]).toMatch(new RegExp(`and started sb-host-offload:build-1 \\(${size}\\)$`));
    }
    for (const args of [["--size", "xlarge", "true"], ["--size", "lage", "true"], ["--size=2xlarge", "true"], ["--size"]]) {
      const r = offload(args);
      expect(r.code).toBe(2);
      expect(r.err).toContain("sb-offload: --size is small, medium or large (default small)");
      expect(calls()).toEqual([]); // no upload, no build
    }
    const none = offload(["--size", "large"]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("usage: sb-offload [--size small|medium|large] <command…>");
    expect(calls()).toEqual([]);
  });

  test("sb-offload streams the build's log and exits with the command's exit code", () => {
    awsFake();
    setLog("SUCCEEDED", ["[Container] Running command sh -c ...", "3 passed, 1 failed", "sb-offload: exit 3"]);
    const r = offload(["pytest"]);
    expect(r.out).toBe("[Container] Running command sh -c ...\n3 passed, 1 failed\nsb-offload: exit 3\n");
    expect(r.code).toBe(3);
    const logCalls = calls().filter((l) => l.startsWith("aws logs get-log-events"));
    expect(logCalls[0]).toBe("aws logs get-log-events --log-group-name /aws/codebuild/sb-host-offload --log-stream-name build-1 --start-from-head --output json");
    expect(logCalls[1]).toContain("--next-token f/2"); // only what is new
    expect(calls()).toContain("aws codebuild batch-get-builds --ids sb-host-offload:build-1 --query builds[0].[buildStatus,logs.groupName,logs.streamName] --output text");
  });

  test("sb-offload exits 124 on a timeout and 1 on a failure without the exit line", () => {
    awsFake();
    setLog("TIMED_OUT", ["still building"]);
    const t = offload(["docker", "build", "."]);
    expect(t.code).toBe(124);
    expect(t.err).toContain("ended TIMED_OUT without the command's exit code");
    setLog("FAILED", ["tar: unexpected end of file"]);
    expect(offload(["docker", "build", "."]).code).toBe(1);
  });

  test("sb-offload stops the build and exits 130 when it is interrupted, and removes the upload in every case", async () => {
    awsFake();
    setLog("SUCCEEDED", ["sb-offload: exit 0"]);
    offload(["true"]);
    const rm = (c: string[]) => c.filter((l) => l.startsWith("aws s3 rm "));
    const up = calls().find((l) => l.startsWith("aws s3 cp "))!.match(/s3:\/\/\S+/)![0];
    expect(rm(calls())).toEqual([`aws s3 rm ${up} --only-show-errors`]);
    setLog("FAILED", []);
    offload(["true"]);
    expect(rm(calls())).toHaveLength(1);
    // interrupted while the build runs
    setLog("IN_PROGRESS", ["building"]);
    rmSync(log, { force: true });
    const p = Bun.spawn(["bash", join(HERE, "offload.sh"), "docker", "compose", "up"], {
      cwd: repo,
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, SB_HOST_ENV: join(dir, "host.env"), HOME: home, FAKE: fakeDir, S3OUT: out },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 100 && !calls().some((l) => l.startsWith("aws codebuild batch-get-builds")); i++) await Bun.sleep(50);
    // TERM, as a stopped Task sends; INT takes the same trap (bun's test runner hands its children an ignored INT)
    p.kill("SIGTERM");
    expect(await p.exited).toBe(130);
    const c = calls();
    expect(c).toContain("aws codebuild stop-build --id sb-host-offload:build-1");
    expect(rm(c)).toHaveLength(1);
    expect(await new Response(p.stderr).text()).toContain("stopped sb-host-offload:build-1");
    expect(readdirSync(join(home, ".cache")).filter((f) => f.startsWith("sb-offload."))).toEqual([]);
  }, 15_000);

  test("sb-offload waits for a free build when the project already runs 2, and stops on any other start failure", () => {
    awsFake();
    setLog("SUCCEEDED", ["sb-offload: exit 0"]);
    writeFileSync(join(fakeDir, "busy"), "");
    const r = offload(["true"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("2 builds are running; waiting for one to end");
    expect(calls().filter((l) => l.startsWith("aws codebuild start-build"))).toHaveLength(2);
    fake("aws", `echo "aws $*" >> "${log}"; case "$1 $2" in "codebuild start-build") echo "AccessDeniedException" >&2; exit 254;; "ssm get-parameter") echo p;; esac; exit 0`);
    const denied = offload(["true"]);
    expect(denied.code).toBe(1);
    expect(denied.err).toContain("AccessDeniedException");
    expect(calls().filter((l) => l.startsWith("aws codebuild start-build"))).toHaveLength(1);
    expect(calls().filter((l) => l.startsWith("aws s3 rm "))).toHaveLength(1); // the upload goes all the same
  }, 15_000);

  test("sb-offload stops the build when it cannot follow it any more: a failing poll does not leave a billed build running (review #685)", () => {
    setLog("IN_PROGRESS", ["building"]);
    fake("aws", `echo "aws $*" >> "${log}"
case "$1 $2" in
  "ssm get-parameter") echo sb-host-offload ;;
  "codebuild start-build") echo "sb-host-offload:build-1" ;;
  "codebuild batch-get-builds") echo "ThrottlingException" >&2; exit 255 ;;
esac
exit 0`);
    const r = offload(["true"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("could not read the state of sb-host-offload:build-1");
    const c = calls();
    expect(c.filter((l) => l.startsWith("aws codebuild batch-get-builds"))).toHaveLength(3); // a blip is retried
    expect(c).toContain("aws codebuild stop-build --id sb-host-offload:build-1");
    expect(c.filter((l) => l.startsWith("aws s3 rm "))).toHaveLength(1);
    // a build that ended is not stopped again
    awsFake();
    setLog("SUCCEEDED", ["sb-offload: exit 0"]);
    offload(["true"]);
    expect(calls().some((l) => l.includes("stop-build"))).toBe(false);
  }, 30_000);

  test("sb-offload says why and exits 2 without the host env (on a Mac)", () => {
    awsFake();
    const r = offload(["docker", "build", "."], { SB_HOST_ENV: join(dir, "no-such.env") });
    expect(r.code).toBe(2);
    expect(r.err).toContain("not the cloud host; run docker here instead");
    expect(calls()).toEqual([]);
    expect(offload([]).code).toBe(2); // no command
  });

  test("bootstrap installs sb-offload", () => {
    expect(readFileSync(join(HERE, "bootstrap.sh"), "utf8")).toContain('install -m 755 "$HERE/offload.sh" /usr/local/bin/sb-offload');
  });
});

describe("aws/host gh-guard on the host shell (#824)", () => {
  // the profile.d file as bootstrap.sh writes it, with a fake checkout whose ops-kit/bin/gh is executable
  const me = Bun.spawnSync(["id", "-un"]).stdout.toString().trim();
  const guard = (repo: string, home: string, user = me) => {
    const f = join(dir, `sb-gh-guard-${Math.random().toString(36).slice(2)}.sh`);
    writeFileSync(f, readFileSync(join(HERE, "sb-gh-guard.sh"), "utf8").replaceAll("@REPO@", repo).replaceAll("@HOME@", home).replaceAll("@USER@", user));
    return f;
  };
  const shell = (script: string) => Bun.spawnSync(["bash", "-c", script], { env: { PATH: "/usr/bin:/bin" } }).stdout.toString().trim().split("\n");

  test("gh-guard on the host shell: gh is the kit's guard, PATH holds it once when read twice, and stays as it is without a checkout", () => {
    const repo = join(dir, "checkout");
    mkdirSync(join(repo, "ops-kit/bin"), { recursive: true });
    writeFileSync(join(repo, "ops-kit/bin/gh"), "#!/bin/sh\n");
    chmodSync(join(repo, "ops-kit/bin/gh"), 0o755);
    const f = guard(repo, "/home/sb");
    const [gh, path] = shell(`. ${f}; command -v gh; echo "$PATH"`);
    expect(gh).toBe(join(repo, "ops-kit/bin/gh"));
    expect(path).toBe(`${join(repo, "ops-kit/bin")}:/usr/bin:/bin:/home/sb/.bun/bin`);
    const [, twice] = shell(`. ${f}; . ${f}; command -v gh; echo "$PATH"`);
    expect(twice).toBe(path);
    // no checkout (or not yet cloned): PATH is not touched
    const [none] = shell(`. ${guard(join(dir, "no-checkout"), "/home/sb")}; echo "$PATH"`);
    expect(none).toBe("/usr/bin:/bin");
    // another user's shell (root's above all): the agent-writable checkout never comes first
    const [other] = shell(`. ${guard(repo, "/home/sb", "not-the-host-user")}; echo "$PATH"`);
    expect(other).toBe("/usr/bin:/bin");
  });

  test("gh-guard on the host shell: bootstrap puts it in /etc/profile.d with the checkout and the home filled in", () => {
    const boot = readFileSync(join(HERE, "bootstrap.sh"), "utf8");
    expect(boot).toContain('sed -e "s|@REPO@|$REPO_DIR|g" -e "s|@HOME@|$SB_HOST_HOME|g" -e "s|@USER@|$SB_HOST_USER|g" "$HERE/sb-gh-guard.sh" > /etc/profile.d/sb-gh-guard.sh');
    expect(boot).toContain("chmod 644 /etc/profile.d/sb-gh-guard.sh");
  });
});

describe("aws/README.md emergency steps (#1492)", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const at = readme.indexOf("## 緊急時: 不審なアクセスがあったとき（#1492）");
  const section = at < 0 ? "" : readme.slice(at, readme.indexOf("\n## ", at + 1));

  test("the section has (a) to (d), and each of (a) to (c) says what stops and what stays", () => {
    expect(at).toBeGreaterThan(-1);
    for (const h of ["### (a) 全セッションの即時失効", "### (b) 経路の遮断", "### (c) API の全停止", "### (d) 戻し方"]) expect(section).toContain(h);
    for (const name of ["(a)", "(b)", "(c)"]) {
      const i = section.indexOf(`### ${name}`);
      const body = section.slice(i, section.indexOf("\n### ", i + 1) < 0 ? undefined : section.indexOf("\n### ", i + 1));
      expect(body).toContain("- 止まるもの:");
      expect(body).toContain("- 残るもの:");
    }
    expect(section).toContain("古い版に戻さない");
  });

  test("the commands print no secret: no --with-decryption, no echo of a value", () => {
    expect(section).not.toContain("--with-decryption");
    expect(section).not.toMatch(/echo [^\n]*\$/);
  });
});

describe("aws/README.md travelling (#1639)", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const at = readme.indexOf("- **Travelling (#1639)**");
  const section = at < 0 ? "" : readme.slice(at, readme.indexOf("- **Web ACL**", at));

  test("the section says how to set it before a trip, that it ends by itself, and how to undo it when it was forgotten", () => {
    expect(at).toBeGreaterThan(-1);
    for (const h of ["- (a) Before the trip", "- (b) It ends by itself", "- (c) Forgot to set it"]) expect(section).toContain(h);
    expect(section).toContain("before leaving");
    expect(section).toContain("`AllowedCountries`");
    expect(section).toContain("a person's deploy");
  });

  test("it says that a failing run mails, and that the subscription must be confirmed", () => {
    expect(section).toContain("starter-errors");
    expect(section).toContain("confirm the subscription");
  });

  test("it prints no secret and names no account or profile", () => {
    expect(section).not.toContain("--with-decryption");
    expect(section).not.toMatch(/--profile|\b\d{12}\b/);
  });
});

describe("aws/host bootstrap security updates (#2186)", () => {
  const boot = () => readFileSync(join(HERE, "bootstrap.sh"), "utf8");
  // the units' tail of bootstrap.sh run with a fake dnf (needs-restarting's exit code) and systemctl (logged)
  function tail(needsRestart: number) {
    const s = boot();
    const block = s.slice(s.indexOf("REBOOT=0"), s.indexOf("\n", s.indexOf("systemctl reboot")));
    const d = mkdtempSync(join(tmpdir(), "switchboard-test-reboot-"));
    mkdirSync(join(d, "bin"));
    writeFileSync(join(d, "bin", "dnf"), `#!/bin/sh\nexit ${needsRestart}\n`);
    writeFileSync(join(d, "bin", "systemctl"), `#!/bin/sh\necho "$*" >> "${d}/calls"\n`);
    for (const f of ["dnf", "systemctl"]) chmodSync(join(d, "bin", f), 0o755);
    const p = Bun.spawnSync(["bash", "-c", `set -euo pipefail\n${block}`], {
      env: { PATH: `${join(d, "bin")}:/usr/bin:/bin`, DONE: join(d, "state", "bootstrapped"), SB_HOST_USER: "u", REPO_DIR: "/r" },
      stdout: "pipe", stderr: "pipe",
    });
    const calls = existsSync(join(d, "calls")) ? readFileSync(join(d, "calls"), "utf8").trim().split("\n") : [];
    const done = existsSync(join(d, "state", "bootstrapped"));
    rmSync(d, { recursive: true, force: true });
    return { code: p.exitCode, out: p.stdout.toString(), calls, done };
  }

  test("updates come from the latest release, before any other package, and a failure does not stop the bootstrap", () => {
    const s = boot();
    const lines = s.split("\n");
    expect(lines).toContain("echo latest > /etc/dnf/vars/releasever");
    const up = lines.find((l) => l.startsWith("dnf upgrade -y -q --security"))!;
    expect(up).toMatch(/\|\| echo "bootstrap: security updates failed/);
    expect(s.indexOf("echo latest > /etc/dnf/vars/releasever")).toBeLessThan(s.indexOf(up));
    expect(s.indexOf(up)).toBeLessThan(s.indexOf("# --- tools ---")); // the tools come from the same release
    const r = Bun.spawnSync(["bash", "-c", `set -euo pipefail; ${up.replace("dnf upgrade -y -q --security", "(exit 5)")}; echo after`], { stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("after");
    expect(r.stderr.toString()).toContain("bootstrap: security updates failed (exit 5)");
  });

  test("with no reboot due, the units start now and the host does not reboot", () => {
    const r = tail(0);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(["enable --now litestream.service sb-archive.timer sb-runner-sync.timer switchboard.service"]);
    expect(r.done).toBe(true);
  });

  test("with a new kernel, the units are enabled without starting, DONE is written, then the host reboots", () => {
    const r = tail(1);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual(["enable litestream.service sb-archive.timer sb-runner-sync.timer switchboard.service", "reboot"]);
    expect(r.done).toBe(true); // the next boot does nothing
    expect(r.out).toContain("bootstrap: rebooting into the updated kernel");
  });
});

describe("aws/host sb-pre-rebuild (#2186)", () => {
  let d: string;
  // a fake aws: `s3 cp - <url>` stores stdin under s3/<key>, `s3 cp <url> -` prints it, list-objects-v2 lists s3/
  function setup() {
    d = mkdtempSync(join(tmpdir(), "switchboard-test-prerebuild-"));
    for (const p of ["bin", "s3", "home/.switchboard/attachments", "home/Knowledge", "repos"]) mkdirSync(join(d, p), { recursive: true });
    const bin = (name: string, body: string) => { writeFileSync(join(d, "bin", name), `#!/bin/bash\n${body}\n`); chmodSync(join(d, "bin", name), 0o755); };
    bin("aws", `echo "aws $*" >> "${d}/calls"
if [ "$1 $2" = "s3 cp" ] && [ "$3" = - ]; then k="\${4#s3://bucket/}"; mkdir -p "${d}/s3/$(dirname "$k")"; cat > "${d}/s3/$k"; exit 0; fi
if [ "$1 $2" = "s3 cp" ] && [ "$4" = - ]; then cat "${d}/s3/\${3#s3://bucket/}"; exit 0; fi
if [ "$2" = list-objects-v2 ]; then (cd "${d}/s3" && find . -type f | sed 's#^\\./##' | tr '\\n' '\\t'); echo; exit 0; fi
exit 254`);
    bin("sb-runner-sync", `echo "sb-runner-sync $*" >> "${d}/calls"`);
    writeFileSync(join(d, "host.env"), `SB_DATA_BUCKET=bucket\nSB_REPO_DIR=${d}/repos/switchboard\n`);
    writeFileSync(join(d, "home/.switchboard/attachments/a.png"), "png");
    writeFileSync(join(d, "home/Knowledge/README.md"), "old readme");
    Bun.spawnSync(["sqlite3", join(d, "home/.switchboard/switchboard.db"), "create table t(x); insert into t values (42);"]);
  }
  const sh = (args: string[]) => {
    const p = Bun.spawnSync(["bash", join(HERE, "pre-rebuild.sh"), ...args], {
      env: { PATH: `${join(d, "bin")}:/usr/local/bin:/usr/bin:/bin`, HOME: join(d, "home"), SB_HOST_ENV: join(d, "host.env"), GIT_CONFIG_GLOBAL: "/dev/null" },
      stdout: "pipe", stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  const git = (cwd: string, ...a: string[]) => Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null" } });
  afterAll(() => rmSync(d, { recursive: true, force: true }));

  test("save streams a dump of the database and the files nothing brings back to archive/pre-rebuild/<time>/, then syncs the runners", () => {
    setup();
    const r = sh(["save"]);
    expect(r.code).toBe(0);
    const at = r.out.match(/saved (\d{8}T\d{6}Z)/)![1];
    const dump = Bun.spawnSync(["zstd", "-dc", join(d, "s3/archive/pre-rebuild", at, "switchboard.sql.zst")]).stdout.toString();
    expect(dump).toContain("INSERT INTO t VALUES(42);");
    const list = Bun.spawnSync(["tar", "--zstd", "-tf", join(d, "s3/archive/pre-rebuild", at, "files.tar.zst")]).stdout.toString().split("\n");
    expect(list).toContain(".switchboard/attachments/a.png");
    expect(list).toContain("Knowledge/README.md");
    expect(list.some((l) => l.startsWith(".switchboard/fixtures"))).toBe(false); // absent ones are skipped
    expect(readFileSync(join(d, "calls"), "utf8")).toContain("sb-runner-sync");
    expect(readdirSync(join(d, "home/.switchboard")).sort()).toEqual(["attachments", "switchboard.db"]); // nothing written to the disk
  });

  test("save lists the work trees with uncommitted changes or commits on no remote, and pushes none", () => {
    const origin = join(d, "origin.git");
    git(d, "init", "-q", "--bare", origin);
    git(join(d, "repos"), "clone", "-q", origin, "switchboard");
    const main = join(d, "repos/switchboard");
    writeFileSync(join(main, "f"), "1");
    git(main, "add", "f"); git(main, "commit", "-qm", "c1"); git(main, "push", "-q", "origin", "HEAD:main");
    git(main, "worktree", "add", "-q", "-b", "ahead", join(d, "repos/wt-ahead"));
    writeFileSync(join(d, "repos/wt-ahead/g"), "2");
    git(join(d, "repos/wt-ahead"), "add", "g"); git(join(d, "repos/wt-ahead"), "commit", "-qm", "c2");
    git(main, "worktree", "add", "-q", "--detach", join(d, "repos/wt-clean"));
    writeFileSync(join(main, "dirty"), "x");
    // a clone nested in the tree, with an ignored secret: not taken
    git(main, "init", "-q", "nested");
    writeFileSync(join(main, "nested/.gitignore"), ".env\n");
    writeFileSync(join(main, "nested/.env"), "SECRET=1");
    // a repository with no commit yet does not stop the save
    git(join(d, "repos"), "init", "-q", "empty");
    writeFileSync(join(d, "repos/empty/new"), "n");
    writeFileSync(join(d, "repos/empty/staged"), "s");
    git(join(d, "repos/empty"), "add", "staged");
    // a repository staged in it (a gitlink): its ignored files are not taken either
    git(join(d, "repos/empty"), "init", "-q", "sub");
    writeFileSync(join(d, "repos/empty/sub/f"), "f"); writeFileSync(join(d, "repos/empty/sub/.env"), "SECRET=2"); writeFileSync(join(d, "repos/empty/sub/.gitignore"), ".env\n");
    git(join(d, "repos/empty/sub"), "add", "f", ".gitignore"); git(join(d, "repos/empty/sub"), "commit", "-qm", "s");
    git(join(d, "repos/empty"), "add", "sub");
    git(join(d, "repos"), "clone", "-q", "--bare", origin, "bare.git"); // commits, no refs/remotes, no work tree: skipped, and the save goes on
    git(join(d, "repos/bare.git"), "worktree", "add", "-q", "--detach", join(d, "bare-wt"), "main"); // but its linked work tree is kept
    writeFileSync(join(d, "bare-wt/w"), "w");
    const r = sh(["save"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`not pushed: ${main} (2 uncommitted, 0 commits on no remote), kept as worktrees/3`); // dirty and nested/
    expect(r.out).toContain(`not pushed: ${join(d, "repos/wt-ahead")} (0 uncommitted, 1 commits on no remote), kept as worktrees/4`);
    expect(r.out).not.toContain("wt-clean");
    expect(r.out).toContain(`not pushed: ${join(d, "repos/empty")} (3 uncommitted, 0 commits on no remote), kept as worktrees/2`); // its files only, staged ones too
    expect(r.out).toContain("4 work trees not pushed");
    expect(git(main, "ls-remote", "origin").stdout.toString()).not.toContain("ahead");
    // what was kept brings the work back: the untracked file, and the commit from the bundle
    const at = r.out.match(/saved (\d{8}T\d{6}Z)/)![1];
    const x = join(d, "x");
    mkdirSync(x);
    Bun.spawnSync(["tar", "--zstd", "-xf", join(d, "s3/archive/pre-rebuild", at, "worktrees.tar.zst"), "-C", x]);
    expect(readFileSync(join(x, "worktrees/2/info"), "utf8")).toContain("head none");
    expect(Bun.spawnSync(["tar", "-xOf", join(x, "worktrees/2/untracked.tar"), "new"]).stdout.toString()).toBe("n");
    expect(Bun.spawnSync(["tar", "-xOf", join(x, "worktrees/2/untracked.tar"), "staged"]).stdout.toString()).toBe("s");
    expect(Bun.spawnSync(["tar", "-tf", join(x, "worktrees/2/untracked.tar")]).stdout.toString()).not.toContain(".env");
    expect(readFileSync(join(x, "worktrees/2/info"), "utf8")).toContain("nested (not kept) sub");
    expect(r.out).not.toContain("bare.git");
    expect(r.out).toContain(`not pushed: ${join(d, "bare-wt")}`);
    expect(Bun.spawnSync(["tar", "-xOf", join(x, "worktrees/3/untracked.tar"), "dirty"]).stdout.toString()).toBe("x");
    expect(readFileSync(join(x, "worktrees/4/info"), "utf8")).toContain("branch ahead");
    expect(readFileSync(join(x, "worktrees/3/info"), "utf8")).toContain("nested (not kept) nested/");
    expect(Bun.spawnSync(["tar", "-tf", join(x, "worktrees/3/untracked.tar")]).stdout.toString().trim().split("\n")).toEqual(["dirty"]);
    git(main, "fetch", "-q", join(x, "worktrees/4/commits.bundle"), "HEAD");
    expect(git(main, "log", "-1", "--format=%s", "FETCH_HEAD").stdout.toString().trim()).toBe("c2");
    expect(readdirSync(join(d, "home/.cache"))).toEqual([]); // the staging dir is removed
  });

  test("restore unpacks the newest save into HOME and keeps the files the new host already has", () => {
    rmSync(join(d, "home/.switchboard/attachments"), { recursive: true });
    writeFileSync(join(d, "home/Knowledge/README.md"), "fresh readme");
    const r = sh(["restore"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(d, "home/.switchboard/attachments/a.png"), "utf8")).toBe("png");
    expect(readFileSync(join(d, "home/Knowledge/README.md"), "utf8")).toBe("fresh readme");
    expect(sh(["nonsense"]).code).toBe(2);
  });
});

describe("aws/host sb-node: the pinned Node.js reaches a running host", () => {
  const read = (f: string) => readFileSync(join(HERE, f), "utf8");
  // a copy of node.sh with a pin for a fake tarball; curl copies it from here, the old node answers v24.21.0
  function nodeRun(opts: { tarball?: boolean; old?: string; pin?: "fake" | "real" } = {}) {
    const root = join(dir, "node");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "src", "pkg", "bin"), { recursive: true });
    writeFileSync(join(root, "src", "pkg", "bin", "node"), "#!/bin/sh\necho v99.0.0\n");
    chmodSync(join(root, "src", "pkg", "bin", "node"), 0o755);
    Bun.spawnSync(["tar", "-cJf", join(root, "node.tar.xz"), "-C", join(root, "src"), "pkg"]);
    const sha = Bun.spawnSync(["sha256sum", join(root, "node.tar.xz")]).stdout.toString().split(" ")[0];
    let sh = read("node.sh");
    if (opts.pin !== "real") sh = sh.replace(/\nNODE_VERSION=\S+\n/, "\nNODE_VERSION=99.0.0\n").replace(/\nNODE_SHA256=\S+\n/, `\nNODE_SHA256=${sha}\n`);
    writeFileSync(join(root, "node.sh"), sh);
    if (opts.old) {
      mkdirSync(join(root, "lib", "nodejs", "bin"), { recursive: true });
      writeFileSync(join(root, "lib", "nodejs", "bin", "node"), `#!/bin/sh\necho ${opts.old}\n`);
      chmodSync(join(root, "lib", "nodejs", "bin", "node"), 0o755);
    }
    fake("curl", `echo "curl $*" >> "${log}"; ${opts.tarball === false ? "exit 22" : `while [ "$1" != -o ]; do shift; done; cp "${join(root, "node.tar.xz")}" "$2"`}`);
    rmSync(log, { force: true });
    const p = Bun.spawnSync(["bash", join(root, "node.sh")], { env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, SB_NODE_DIR: join(root, "lib", "nodejs"), SB_NODE_BIN: join(root, "bin") }, stderr: "pipe", stdout: "pipe" });
    rmSync(join(dir, "bin", "curl"));
    const version = () => Bun.spawnSync([join(root, "bin", "node"), "--version"]).stdout.toString().trim();
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), root, version };
  }

  test("the pin is the 2026-10-21 security release of 24.x (CVE-2026-111497 and others) or later", () => {
    const v = read("node.sh").match(/\nNODE_VERSION=24\.(\d+)\.(\d+)\n/)!;
    expect(Number(v[1]) * 1000 + Number(v[2])).toBeGreaterThanOrEqual(22 * 1000 + 1);
    expect(read("node.sh")).toContain('"https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz"');
  });

  test("an older version in place is replaced, and the links point at the new one", () => {
    const r = nodeRun({ old: "v24.21.0" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("sb-node: v99.0.0");
    expect(r.version()).toBe("v99.0.0");
    for (const b of ["node", "npm", "npx"]) expect(lstatSync(join(r.root, "bin", b)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(r.root, "lib", "nodejs.new"))).toBe(false);
    expect(existsSync(join(r.root, "lib", "nodejs.old"))).toBe(false);
  });

  test("the pinned version in place is left alone: no download", () => {
    const r = nodeRun({ old: "v99.0.0" });
    expect(r.code).toBe(0);
    expect(calls().some((l) => l.startsWith("curl"))).toBe(false);
    expect(r.version()).toBe("v99.0.0");
  });

  test("a tarball whose checksum differs, or a failed download, keeps the old version", () => {
    // one at a time: each run replaces the last one's fixture (review #2513)
    for (const make of [() => nodeRun({ old: "v24.21.0", pin: "real" }), () => nodeRun({ old: "v24.21.0", tarball: false })]) {
      const r = make();
      expect(r.code).not.toBe(0);
      expect(Bun.spawnSync([join(r.root, "lib", "nodejs", "bin", "node")]).stdout.toString().trim()).toBe("v24.21.0");
      expect(existsSync(join(r.root, "lib", "nodejs.new"))).toBe(false);
    }
  });

  test("a stop between the two renames: the previous one comes back from .old and, being the pinned version, is kept", () => {
    const r = nodeRun({ old: "v24.21.0" }); // first a normal run to get the paths
    rmSync(join(r.root, "lib", "nodejs"), { recursive: true });
    mkdirSync(join(r.root, "lib", "nodejs.old", "bin"), { recursive: true });
    writeFileSync(join(r.root, "lib", "nodejs.old", "bin", "node"), "#!/bin/sh\necho v99.0.0\n");
    chmodSync(join(r.root, "lib", "nodejs.old", "bin", "node"), 0o755);
    const again = Bun.spawnSync(["bash", join(r.root, "node.sh")], { env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, SB_NODE_DIR: join(r.root, "lib", "nodejs"), SB_NODE_BIN: join(r.root, "bin") } });
    expect(again.exitCode).toBe(0);
    expect(existsSync(join(r.root, "lib", "nodejs.old"))).toBe(false);
    expect(r.version()).toBe("v99.0.0");
  });

  test("sb-host-update starts the installed sb-node even when main cannot be fetched (review #2513)", () => {
    const bin = join(dir, "nodebin");
    rmSync(bin, { recursive: true, force: true });
    mkdirSync(bin);
    const r0 = run("host-update.sh", [], { SB_BIN_DIR: bin, SB_HOST_CLONE: join(dir, "noclone") });
    expect(r0.code).toBe(0);
    expect(calls().some((l) => l.includes("sb-node-update"))).toBe(false); // none installed: nothing to start
    writeFileSync(join(bin, "sb-node"), "#!/bin/sh\n");
    chmodSync(join(bin, "sb-node"), 0o755);
    const r = run("host-update.sh", [], { SB_BIN_DIR: bin, SB_HOST_CLONE: join(dir, "noclone") }); // no clone: the fetch is skipped
    expect(r.code).toBe(0);
    expect(r.err).toContain("skipped");
    expect(calls()).toContain(`systemd-run --unit=sb-node-update --no-block --collect --quiet -- ${join(bin, "sb-node")}`);
    const sh = read("host-update.sh");
    expect(sh).toMatch(/\n {2}update_scripts\n {2}node_update\n\}/); // after the scripts, so a new pin is used at once
    expect(read("node.sh").trimEnd().split("\n").at(-1)).toBe('main "$@"; exit');
  });
});

describe("aws/host sb-host-update security updates (#2186)", () => {
  test("every start hands AL2023's latest security updates to a unit of their own, without waiting", () => {
    const r = run("host-update.sh", [], { SB_BIN_DIR: join(dir, "nobin"), SB_HOST_CLONE: join(dir, "noclone") }); // no clone: the fetch is skipped
    expect(r.code).toBe(0);
    expect(calls()).toContain("systemd-run --unit=sb-security-update --no-block --collect --quiet -- dnf --releasever=latest upgrade -y -q --security");
    expect(r.err).toContain("skipped"); // the updates are started before the fetch's early returns
  });

  test("a failure to start them (a run still going) does not stop the start", () => {
    fake("systemd-run", "exit 1");
    const r = run("host-update.sh", [], { SB_BIN_DIR: join(dir, "nobin"), SB_HOST_CLONE: join(dir, "noclone") });
    fake("systemd-run", `echo "systemd-run $*" >> "${log}"`);
    expect(r.code).toBe(0);
    expect(r.err).toContain("sb-host-update: security updates not started (exit 1)");
  });
});
