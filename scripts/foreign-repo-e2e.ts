/**
 * bun scripts/foreign-repo-e2e.ts (#2576): someone else's repository from its addition to a Task's write, with a fake gh
 * (it records every write) and a fake runner. No browser: the screen is checked by its own E2E in the PR.
 *
 * POST /api/workspaces {repo} → the clone → POST /api/tasks is 409 → confirm the runner config → a request and a PBI in
 * the backlog kept here → a Task whose shell, with the environment the daemon gave it, runs `gh issue create` → the gh in
 * front (ops-kit/bin/gh) stops it.
 * The last line is `upstream writes: <n>`; exit 1 unless it is 0 and every step went as written.
 *
 * --own-copy: the same, with `ownCopy: true`. The daemon also makes a private copy under your name (`gh repo create
 * me/widget --private`, here a local bare repository behind it) and pushes to it; the Task's write without a target goes
 * to that copy and arrives, the one that names the original is still stopped. The last line is the same.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerAdapter, Task, Workspace } from "@switchboard/protocol";
import type { GhRunner } from "../packages/core/src/backlog.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";

const CHECKOUT = join(import.meta.dir, "..");
// the run again gets the directory from its parent under a name only this script uses; the parent made it and removes it
const CHILD_ROOT = "SWITCHBOARD_FOREIGN_E2E_CHILD_ROOT";
const root = process.env[CHILD_ROOT] ?? mkdtempSync("/tmp/switchboard.e2e.");
const home = join(root, "home");
const repoRoot = join(root, "switchboard");
const ownCopy = process.argv.includes("--own-copy");
const log = join(root, "gh-writes.log");
const mineLog = join(root, "gh-mine.log"); // writes that went to the copy under your name
const mineBare = join(root, "mine.git");
const bin = join(root, "bin");
// both addresses are github.com, so git is told to use the local repositories instead: the copy is pushed to the bare one,
// upstream is fetched from the origin. Bun does not hand a changed process.env to the processes the daemon starts, so this runs
// again with the setting in its environment from the start
if (!process.env[CHILD_ROOT]) {
  const gitconfig = join(root, "gitconfig");
  writeFileSync(gitconfig, `[url "${join(root, "mine")}"]\n\tinsteadOf = https://github.com/me/widget\n[url "${join(root, "origin")}"]\n\tinsteadOf = https://github.com/someone/widget\n`);
  symlinkSync(join(root, "origin"), join(root, "origin.git")); // the rewritten address keeps its .git
  const again = spawnSync(process.execPath, [import.meta.path, ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, [CHILD_ROOT]: root, GIT_CONFIG_GLOBAL: gitconfig } });
  rmSync(root, { recursive: true, force: true });
  process.exit(again.status ?? 1);
}

for (const d of [home, repoRoot, bin]) mkdirSync(d);
symlinkSync(join(CHECKOUT, "ops-kit"), join(repoRoot, "ops-kit")); // the meta workspace: Tasks get the gh in front from it
process.env.PATH = `${bin}:${process.env.PATH}`; // the fake gh is the real one behind it
writeFileSync(log, "");
writeFileSync(mineLog, "");
// the origin: a small repository with a hook in it
const origin = join(root, "origin");
spawnSync("git", ["init", "-q", "-b", "main", origin]);
mkdirSync(join(origin, ".claude"));
writeFileSync(join(origin, ".claude/settings.json"), '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch hook-ran"}]}]}}\n');
const git = (...args: string[]) => spawnSync("git", ["-C", origin, "-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", ...args]);
git("add", "-A");
git("commit", "-qm", "first");

const REPO = "someone/widget";
const gh: GhRunner = async (args) => {
  if (args[0] === "api" && args[1] === `repos/${REPO}` && !args.includes("-X")) return { code: 0, stdout: `false ${REPO}\n`, stderr: "" };
  if (args[0] === "repo" && args[1] === "clone") {
    const c = spawnSync("git", ["clone", "-q", origin, args[3]!]);
    if (c.status !== 0) return { code: 1, stdout: "", stderr: String(c.stderr) };
    spawnSync("git", ["-C", args[3]!, "remote", "set-url", "origin", `https://github.com/${REPO}.git`]);
    return { code: 0, stdout: "", stderr: "" };
  }
  if (ownCopy && args[0] === "api" && args[1] === "user") return { code: 0, stdout: "me\n", stderr: "" };
  if (ownCopy && args[0] === "api" && args[1] === "repos/me/widget") return { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
  if (ownCopy && args[0] === "repo" && args[1] === "create" && args[2] === "me/widget" && args[3] === "--private") {
    spawnSync("git", ["init", "-q", "--bare", mineBare]);
    writeFileSync(mineLog, `daemon: ${args.join(" ")}\n`, { flag: "a" });
    return { code: 0, stdout: "", stderr: "" };
  }
  // the backlog is on GitHub here, so the daemon reads the Project's address and the repository: reads, not writes
  if (ownCopy && ((args[0] === "variable" && args[1] === "get") || (args[0] === "repo" && args[1] === "view"))) return { code: 1, stdout: "", stderr: "not here" };
  if (ownCopy && args[0] === "repo" && args[1] === "set-default" && args[2] === "me/widget") return { code: 0, stdout: "", stderr: "" };
  writeFileSync(log, `daemon: ${args.join(" ")}\n`, { flag: "a" }); // anything else the daemon asks of GitHub counts as a write to look at
  return { code: 1, stdout: "", stderr: "not here" };
};

// the real gh behind the gh in front: it answers the guard's read of the repository, and records the rest, so a write that passes is seen
// (with a copy, the repository the clone answers for is the copy; a write that names the original is still recorded as a write to it)
writeFileSync(join(bin, "gh"), `#!/bin/sh\nif [ "$1 $2" = "repo view" ]; then echo ${ownCopy ? "me/widget" : REPO}; exit 0; fi\ncase "$*" in *"-R ${REPO}"*) echo "task: $*" >> ${log};; *) echo "task: $*" >> ${mineLog};; esac\n`);
chmodSync(join(bin, "gh"), 0o755);

// the Task's shell: the prompt run with the environment the daemon gave it, the way a real runner would
let wrote: { code: number | null; stderr: string } | null = null;
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    void (async () => {
      const shell = Bun.spawn(["sh", "-c", opts.prompt], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "ignore", stderr: "pipe" });
      const [code, stderr] = await Promise.all([shell.exited, new Response(shell.stderr).text()]);
      wrote = { code, stderr };
      emit({ t: "session.end", status: "ok" });
      exit(0);
    })();
    return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited };
  },
};

const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: repoRoot, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", SWITCHBOARD_CANDIDATE: "1" });
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh });
const base = `http://127.0.0.1:${core.server.port}`;
const send = async <T = any>(method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json()) as T };
};
const step = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
};
let failed = false;

try {
  step("add", (await send("POST", "/api/workspaces", ownCopy ? { repo: REPO, ownCopy: true } : { repo: REPO })).status === 202);
  let ws: Workspace | undefined;
  for (let i = 0; i < 500 && !ws; i++) {
    ws = (await send<Workspace[]>("GET", "/api/workspaces")).body.find((w) => w.upstream === REPO);
    await Bun.sleep(20);
  }
  if (!ws) throw new Error(`the clone did not register: ${JSON.stringify((await send("GET", "/api/workspaces/clones")).body)}`);
  const remotes = spawnSync("git", ["-C", ws.path, "remote"]).stdout.toString().trim();
  if (ownCopy) {
    step("upstream kept, the copy is origin", remotes.split("\n").sort().join(",") === "origin,upstream", remotes.split("\n").join(","));
    step("backlog on GitHub", ws.backlog === "github", ws.backlog);
    const pushed = spawnSync("git", ["-C", mineBare, "branch", "--list", "main"]).stdout.toString().trim();
    step("the copy holds the branch", pushed.endsWith("main"), pushed);
  } else {
    step("upstream only", remotes === "upstream", remotes);
    step("backlog here", ws.backlog === "switchboard", ws.backlog);
  }
  // with a copy: a write that names the original (stopped), then one without a target (goes to the copy)
  const prompt = ownCopy ? "gh issue create -R someone/widget --title x --body y; gh pr create --title x --body y" : "gh issue create --title x --body y";
  const start = { workspaceId: ws.id, runner: "claude", prompt, title: "write" };
  step("task before the confirmation", (await send("POST", "/api/tasks", start)).status === 409);
  const seen = await send<{ hash: string; files: { path: string }[] }>("GET", `/api/workspaces/${ws.id}/runner-config`);
  step("config listed", seen.body.files.some((f) => f.path === ".claude/settings.json"));
  step("confirm", (await send("POST", `/api/workspaces/${ws.id}/runner-config`, { hash: seen.body.hash })).status === 200);
  if (!ownCopy) {
    const req = await send<{ number: number }>("POST", "/api/backlog", { workspaceId: ws.id, title: "要望: x", labels: ["type:request"] });
    const pbi = await send("POST", "/api/backlog", { workspaceId: ws.id, title: "PBI: x", labels: ["type:pbi"] });
    step("request and PBI here", req.status === 202 && pbi.status === 202);
  }
  const task = await send<Task>("POST", "/api/tasks", start);
  step("task after the confirmation", task.status === 201);
  for (let i = 0; i < 500 && !wrote; i++) await Bun.sleep(20);
  const refused = wrote as { code: number | null; stderr: string } | null;
  if (ownCopy) step("the Task's write to the original is stopped and the one to the copy goes", refused?.code === 0 && !!refused?.stderr.includes("ops-kit.noWrite"), refused?.stderr.trim().split("\n")[0]);
  else step("the Task's gh issue create is stopped", refused?.code !== 0 && !!refused?.stderr.includes("ops-kit.noWrite"), refused?.stderr.trim().split("\n")[0]);
  step("the confirmation holds for the next Task", (await send("POST", "/api/tasks", { ...start, prompt: "true" })).status === 201);
  await Bun.sleep(1000); // what the daemon sends goes on in the background
} catch (e) {
  step("run", false, String(e));
}
await core.stop();
const writes = readFileSync(log, "utf8").split("\n").filter(Boolean);
for (const w of writes) console.log(w);
if (ownCopy) {
  const mine = readFileSync(mineLog, "utf8").split("\n").filter(Boolean);
  for (const w of mine) console.log(`copy: ${w}`);
  step("repo create me/widget --private is recorded", mine.includes("daemon: repo create me/widget --private"));
  step("the write to the copy arrives", mine.includes("task: pr create --title x --body y"));
}
console.log(`upstream writes: ${writes.length}`);
process.exit(failed || writes.length ? 1 : 0);
