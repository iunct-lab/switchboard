/**
 * bun scripts/foreign-repo-e2e.ts (#2576): someone else's repository from its addition to a Task's write, with a fake gh
 * (it records every write) and a fake runner. No browser: the screen is checked by its own E2E in the PR.
 *
 * POST /api/workspaces {repo} → the clone → POST /api/tasks is 409 → confirm the runner config → a request and a PBI in
 * the backlog kept here → a Task whose shell, with the environment the daemon gave it, runs `gh issue create` → the gh in
 * front (ops-kit/bin/gh) stops it.
 * The last line is `upstream writes: <n>`; exit 1 unless it is 0 and every step went as written.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerAdapter, Task, Workspace } from "@switchboard/protocol";
import type { GhRunner } from "../packages/core/src/backlog.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";

const CHECKOUT = join(import.meta.dir, "..");
const root = mkdtempSync("/tmp/switchboard.e2e.");
const home = join(root, "home");
const repoRoot = join(root, "switchboard");
const log = join(root, "gh-writes.log");
const bin = join(root, "bin");
for (const d of [home, repoRoot, bin]) mkdirSync(d);
symlinkSync(join(CHECKOUT, "ops-kit"), join(repoRoot, "ops-kit")); // the meta workspace: Tasks get the gh in front from it
process.env.PATH = `${bin}:${process.env.PATH}`; // the fake gh is the real one behind it
writeFileSync(log, "");

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
  writeFileSync(log, `daemon: ${args.join(" ")}\n`, { flag: "a" }); // anything else the daemon asks of GitHub counts as a write to look at
  return { code: 1, stdout: "", stderr: "not here" };
};

// the real gh behind the gh in front: it answers the guard's read of the repository, and records the rest, so a write that passes is seen
writeFileSync(join(bin, "gh"), `#!/bin/sh\nif [ "$1 $2" = "repo view" ]; then echo ${REPO}; exit 0; fi\necho "task: $*" >> ${log}\n`);
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
  step("add", (await send("POST", "/api/workspaces", { repo: REPO })).status === 202);
  let ws: Workspace | undefined;
  for (let i = 0; i < 500 && !ws; i++) {
    ws = (await send<Workspace[]>("GET", "/api/workspaces")).body.find((w) => w.upstream === REPO);
    await Bun.sleep(20);
  }
  if (!ws) throw new Error("the clone did not register");
  const remotes = spawnSync("git", ["-C", ws.path, "remote"]).stdout.toString().trim();
  step("upstream only", remotes === "upstream", remotes);
  step("backlog here", ws.backlog === "switchboard", ws.backlog);
  const start = { workspaceId: ws.id, runner: "claude", prompt: "gh issue create --title x --body y", title: "write" };
  step("task before the confirmation", (await send("POST", "/api/tasks", start)).status === 409);
  const seen = await send<{ hash: string; files: { path: string }[] }>("GET", `/api/workspaces/${ws.id}/runner-config`);
  step("config listed", seen.body.files.some((f) => f.path === ".claude/settings.json"));
  step("confirm", (await send("POST", `/api/workspaces/${ws.id}/runner-config`, { hash: seen.body.hash })).status === 200);
  const req = await send<{ number: number }>("POST", "/api/backlog", { workspaceId: ws.id, title: "要望: x", labels: ["type:request"] });
  const pbi = await send("POST", "/api/backlog", { workspaceId: ws.id, title: "PBI: x", labels: ["type:pbi"] });
  step("request and PBI here", req.status === 202 && pbi.status === 202);
  const task = await send<Task>("POST", "/api/tasks", start);
  step("task after the confirmation", task.status === 201);
  for (let i = 0; i < 500 && !wrote; i++) await Bun.sleep(20);
  const refused = wrote as { code: number | null; stderr: string } | null;
  step("the Task's gh issue create is stopped", refused?.code !== 0 && !!refused?.stderr.includes("ops-kit.noWrite"), refused?.stderr.trim().split("\n")[0]);
  step("the confirmation holds for the next Task", (await send("POST", "/api/tasks", { ...start, prompt: "true" })).status === 201);
  await Bun.sleep(1000); // what the daemon sends goes on in the background
} catch (e) {
  step("run", false, String(e));
}
await core.stop();
const writes = readFileSync(log, "utf8").split("\n").filter(Boolean);
for (const w of writes) console.log(w);
rmSync(root, { recursive: true, force: true });
console.log(`upstream writes: ${writes.length}`);
process.exit(failed || writes.length ? 1 : 0);
