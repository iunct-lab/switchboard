/**
 * bun scripts/foreign-repo-e2e.ts: someone else's repository from its addition to a Task's write, with a fake gh
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
 *
 * --kept-settings: a repository of yours that has not committed `ops.config.json`, whose settings (the Project, the fields,
 * the required sections) are kept on Switchboard's side (PUT /api/workspaces/<id>/config), its backlog on GitHub (a fake
 * GitHub, with the same recording gh in front). A Task runs `ops-kit backlog create --label type:pbi` and `triage` with the
 * environment the daemon gave it; checks that the PBI is made, goes into the Project the kept `projectUrl` names, and has its
 * Priority, that every edit the daemon stored was sent (none left pending or in conflict), and that `ops-kit lint --fresh`, run
 * in the Task, checks the sections the kept settings require: a second PBI made without one is named, the first is not. Nothing is sent to the real
 * GitHub. The last line is `kept settings: gh calls <n>, …`; exit 1 unless every step held.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerAdapter, Task, Workspace } from "@switchboard/protocol";
import type { GhRunner } from "../packages/core/src/backlog-gh.ts";
import { fakeGithub } from "../packages/core/src/backlog-fake-github.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";

const CHECKOUT = join(import.meta.dir, "..");
// the run again gets the directory from its parent under a name only this script uses; the parent made it and removes it
const CHILD_ROOT = "SWITCHBOARD_FOREIGN_E2E_CHILD_ROOT";
const root = process.env[CHILD_ROOT] ?? mkdtempSync("/tmp/switchboard.e2e.");
const home = join(root, "home");
const repoRoot = join(root, "switchboard");
const ownCopy = process.argv.includes("--own-copy");
const kept = process.argv.includes("--kept-settings");
if (ownCopy && kept) throw new Error("--own-copy and --kept-settings are separate runs");
const log = join(root, "gh-writes.log");
const mineLog = join(root, "gh-mine.log"); // writes that went to the copy under your name
const mineBare = join(root, "mine.git");
const bin = join(root, "bin");
// both addresses are github.com, so git is told to use the local repositories instead: the copy is pushed to the bare one,
// upstream is fetched from the origin. Bun does not hand a changed process.env to the processes the daemon starts, so this runs
// again with the setting in its environment from the start
if (!process.env[CHILD_ROOT]) {
  const gitconfig = join(root, "gitconfig");
  // --kept-settings: no rewrite, the kit's Tasks read the repository from the address origin has (get-url applies a rewrite)
  writeFileSync(gitconfig, kept ? "" : `[url "${join(root, "mine")}"]\n\tinsteadOf = https://github.com/me/widget\n[url "${join(root, "origin")}"]\n\tinsteadOf = https://github.com/someone/widget\n`);
  symlinkSync(join(root, "origin"), join(root, "origin.git")); // the rewritten address keeps its .git
  const childEnv = { ...process.env, [CHILD_ROOT]: root, GIT_CONFIG_GLOBAL: gitconfig } as Record<string, string | undefined>;
  if (kept) delete childEnv.SWITCHBOARD_PROJECT_URL; // the Project comes from the settings kept here and from nothing else
  const again = spawnSync(process.execPath, [import.meta.path, ...process.argv.slice(2)], { stdio: "inherit", env: childEnv });
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

// --kept-settings: your own repository (the fake GitHub's), its Project named by the settings kept here and by nothing else
// (the environment's SWITCHBOARD_PROJECT_URL is removed above, and the repository has no variable)
const REPO = kept ? "acme/app" : "someone/widget";
const KEPT_PROJECT = { owner: "acme", number: 9 };
const KEPT_CONFIG = {
  envPrefix: "KEPT",
  projectUrl: `https://github.com/orgs/${KEPT_PROJECT.owner}/projects/${KEPT_PROJECT.number}`,
  fields: { priority: ["P0", "P1", "P2", "P3"] },
  sections: { pbi: ["ユーザーストーリー", "到達点 / 受け入れ条件"], task: ["やること"], request: ["要望"] },
};
const PRIORITY_OPTIONS = KEPT_CONFIG.fields.priority.map((name, n) => ({ id: `pr${n}`, name }));
const github = kept ? fakeGithub(() => Date.now()) : null;
// what the daemon asked of the Project and of the Issue, as the fake GitHub saw it
const seen = { projects: [] as string[], itemAdds: 0, priority: [] as string[], created: [] as string[], events: [] as string[] };
const keptGh: GhRunner = async (args, cwd) => {
  const field = (k: string) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? "";
  const q = field("query");
  writeFileSync(log, `daemon: ${args.join(" ").replace(/\s+/g, " ").slice(0, 160)}\n`, { flag: "a" });
  if (args[0] === "api" && args[1] === `repos/${REPO}` && !args.includes("-X") && args.includes("--jq")) return { code: 0, stdout: `true ${REPO}\n`, stderr: "" };
  if (args[0] === "repo" && args[1] === "clone") return gh(args, cwd);
  if (args[0] === "variable" && args[1] === "get") return { code: 1, stdout: "", stderr: "not here" };
  if (args[0] === "repo" && args[1] === "view") return { code: 0, stdout: `${REPO} true\n`, stderr: "" };
  // the import's reads (as scripts/forge-e2e.ts answers them), from the Issues the fake GitHub holds
  const raw = (i: { node_id: string; number: number; title: string; body: string; state: string; labels: string[] }) => ({ id: i.node_id, number: i.number, title: i.title, url: "", state: i.state, body: i.body, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z", milestone: null, parent: null,
    labels: { totalCount: i.labels.length, nodes: i.labels.map((name) => ({ name })) }, subIssues: { totalCount: 0, nodes: [] }, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, projectItems: { totalCount: 0, nodes: [] } });
  const reply = (body: unknown) => ({ code: 0, stdout: `HTTP/2.0 200 OK\ncontent-type: application/json\n\n${JSON.stringify(body)}`, stderr: "" });
  const page = (nodes: unknown[]) => reply({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
  const rawQuery = args.find((a) => a.startsWith("query=")) ?? "";
  if (rawQuery.includes("states:[OPEN,CLOSED]")) return page([...github!.issues.values()].filter((i) => i.labels.some((l) => l.startsWith("type:"))).map(raw));
  if (rawQuery.includes("states:OPEN")) return page([]);
  if (rawQuery.includes("issueOrPullRequest")) return reply({ data: { repository: Object.fromEntries([...rawQuery.matchAll(/w(\d+): /g)].map((m) => [`w${m[1]}`, { __typename: "Issue", ...raw(github!.issues.get(Number(m[1]))!) }])) } });
  if (q.includes("projectV2(number:$p)")) {
    seen.projects.push(`${field("o")}/${field("p")}`);
    if (seen.projects.length === 1) seen.events.push(`project read: ${field("o")}/${field("p")}`);
    const ok = { data: { repositoryOwner: { projectV2: { id: "P_1", fields: { nodes: [{ id: "F_s", name: "Status", dataType: "SINGLE_SELECT", options: ["Backlog", "Ready", "In progress", "In review", "Done"].map((name, n) => ({ id: `o${n + 1}`, name })) }, { id: "F_p", name: "Priority", dataType: "SINGLE_SELECT", options: PRIORITY_OPTIONS }] } } } } };
    return { code: 0, stdout: `HTTP/2.0 200 OK\ncontent-type: application/json\n\n${JSON.stringify(ok)}`, stderr: "" };
  }
  if (q.includes("updateProjectV2ItemFieldValue") && field("f") === "F_p") {
    seen.events.push(`item field edit: Priority`);
    const name = PRIORITY_OPTIONS.find((o) => o.id === field("value"))?.name ?? field("value");
    seen.priority.push(name);
    const item = github!.items.get(field("i"));
    if (item) item.fields.Priority = name; // kept, so the daemon's read back after the edit finds what it sent
    return { code: 0, stdout: `HTTP/2.0 200 OK\ncontent-type: application/json\n\n${JSON.stringify({ data: {} })}`, stderr: "" };
  }
  if (q.includes("addProjectV2ItemById")) (seen.itemAdds++, seen.events.push(`item add: ${field("p")}`));
  if (args[1] === `repos/${REPO}/issues` && args.includes("POST")) (seen.created.push(field("title")), seen.events.push(`issue create: ${field("title")}`));
  return github!.gh(args, cwd);
};
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
let wrote: { code: number | null; stdout: string; stderr: string } | null = null;
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    void (async () => {
      const shell = Bun.spawn(["sh", "-c", opts.prompt], { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdout: "pipe", stderr: "pipe" });
      const [code, stdout, stderr] = await Promise.all([shell.exited, new Response(shell.stdout).text(), new Response(shell.stderr).text()]);
      wrote = { code, stdout, stderr };
      emit({ t: "session.end", status: "ok" });
      exit(0);
    })();
    return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited };
  },
};

const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: repoRoot, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0", ...(kept ? {} : { SWITCHBOARD_CANDIDATE: "1" }) }); // the copy of the daemon sends nothing to GitHub; --kept-settings needs the send, to the fake GitHub only
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: kept ? keptGh : gh, ...(kept ? { cliUpdate: { checkMs: 3_600_000 } } : {}) }); // not a candidate: the host CLI's update check would come after 30 s, so it is put past the run
const base = `http://127.0.0.1:${core.server.port}`;
const send = async <T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
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
    ws = (await send<Workspace[]>("GET", "/api/workspaces")).body.find((w) => (kept ? w.name === "app" : w.upstream === REPO));
    await Bun.sleep(20);
  }
  if (!ws) throw new Error(`the clone did not register: ${JSON.stringify((await send("GET", "/api/workspaces/clones")).body)}`);
  const remotes = spawnSync("git", ["-C", ws.path, "remote"]).stdout.toString().trim();
  if (kept) {
    step("origin only", remotes === "origin", remotes);
    step("backlog on GitHub", ws.backlog === "github", ws.backlog);
    step("no ops.config.json in the clone", !existsSync(join(ws.path, "ops.config.json")));
    const saved = await send<{ refusal?: string; source?: string; file?: string | null }>("PUT", `/api/workspaces/${ws.id}/config`, { config: JSON.stringify(KEPT_CONFIG) }, { origin: base, "sec-fetch-site": "same-origin" }); // as the Settings screen sends it: the keys here only say how Issues are written, so they apply at once
    step("settings kept here", saved.status === 200 && !saved.body.refusal && saved.body.source === "switchboard", `source=${saved.body.source}`);
  } else if (ownCopy) {
    step("upstream kept, the copy is origin", remotes.split("\n").sort().join(",") === "origin,upstream", remotes.split("\n").join(","));
    step("backlog on GitHub", ws.backlog === "github", ws.backlog);
    const pushed = spawnSync("git", ["-C", mineBare, "branch", "--list", "main"]).stdout.toString().trim();
    step("the copy holds the branch", pushed.endsWith("main"), pushed);
  } else {
    step("upstream only", remotes === "upstream", remotes);
    step("backlog here", ws.backlog === "switchboard", ws.backlog);
  }
  if (kept) {
    const imported = await send("POST", "/api/backlog/sync", { workspaceId: ws.id }); // the first import, as the screen's backlog tab asks for it
    step("the backlog is imported from GitHub", imported.status === 200, JSON.stringify(imported.body).slice(0, 160));
    const kit = `bun ${join(CHECKOUT, "ops-kit/src/cli.ts")}`;
    // the PBI with the sections the kept settings require, made and triaged the way a Task does it
    const keptPrompt = [
      `W=$(mktemp -d "\${TMPDIR:-/tmp}/switchboard.kept.XXXXXX")`,
      `printf '## ユーザーストーリー\\n利用者として、設定を置かないリポジトリでも PBI を作りたい。\\n\\n## 到達点 / 受け入れ条件\\n- [ ] 1. Project に入り Priority が付く（検証: この場面）\\n\\n**Story Points**: 1\\n' > "$W/body.md"`,
      // a body without a section the kept settings require: made all the same, and lint --fresh names the section
      `printf '## ユーザーストーリー\\nx\\n\\n**Story Points**: 1\\n' > "$W/bad.md"`,
      `${kit} backlog create --title "PBI: lacks a section" --label type:pbi --body-file "$W/bad.md" || exit 1`,
      `created=$(${kit} backlog create --title "PBI: kept settings" --label type:pbi --body-file "$W/body.md") || exit 1`,
      `echo "created: $created"`,
      `ref=$(echo "$created" | sed -n 's/.*localId \\([0-9a-f-]*\\).*/\\1/p')`,
      `${kit} backlog triage "$ref" P1 || exit 1`,
      // the backlog rules checked on the kept settings, with no ops.config.json in the checkout (what the start conditions run).
      // The fake GitHub's own Issues break the rules, so it exits 1: what is checked is which sections it asked for
      `${kit} lint --fresh > "$W/lint.out" 2>&1; echo "lint: $?"; sed 's/^/lint| /' "$W/lint.out"`,
    ].join("; ");
    const start = { workspaceId: ws.id, runner: "claude", prompt: keptPrompt, title: "make a PBI" };
    step("task starts with no confirmation (your own repository)", (await send("POST", "/api/tasks", start)).status === 201);
    for (let i = 0; i < 1000 && !wrote; i++) await Bun.sleep(20);
    const ran = wrote as { code: number | null; stdout: string; stderr: string } | null;
    step("the Task's backlog create and triage ran", ran?.code === 0, (ran?.stdout.trim().split("\n")[0] ?? "") + (ran?.stderr.trim() ? ` / ${ran.stderr.trim().split("\n")[0]}` : ""));
    // the daemon sends the stored edits to GitHub in the background
    for (let i = 0; i < 500 && !seen.priority.length; i++) await Bun.sleep(20);
    await Bun.sleep(200);
    const made = [...github!.issues.values()].find((i) => i.title === "PBI: kept settings");
    step("the PBI is created on GitHub with its label and sections", !!made && made.labels.includes("type:pbi") && made.body.includes("## ユーザーストーリー") && made.body.includes("## 到達点 / 受け入れ条件"), JSON.stringify(made?.labels));
    step("the Project read is the kept projectUrl's", seen.projects.length > 0 && seen.projects.every((p) => p === `${KEPT_PROJECT.owner}/${KEPT_PROJECT.number}`), seen.projects.join(","));
    step("the PBI is added to that Project", seen.itemAdds === 1 && !!made && github!.items.has(`PVTI_${made.node_id}`), `adds=${seen.itemAdds}`);
    step("its Priority is P1", seen.priority.join(",") === "P1" && !!made && github!.items.get(`PVTI_${made.node_id}`)?.fields.Priority === "P1", seen.priority.join(","));
    const lines = ran?.stdout.split("\n") ?? [];
    const bad = [...github!.issues.values()].find((i) => i.title === "PBI: lacks a section");
    const lint = lines.filter((l) => l.startsWith("lint| ")).map((l) => l.slice(6));
    const lacks = (n: number | undefined) => lint.includes(`#${n}: PBI に「## 到達点 / 受け入れ条件」が無い`);
    // the checkout and the directories above it have no ops.config.json, so the sections can only be the kept settings'; the PBI that has them is not named
    step("lint --fresh checks the sections the kept settings require", lines.includes("lint: 1") && !!bad && lacks(bad.number) && !!made && !lacks(made.number) && !lint.some((l) => l.includes("ops.config.json")), lint.find((l) => l.startsWith(`#${bad?.number}:`)) ?? lint.at(-1));
    // the daemon's own record: every stored edit went out (a read back that disagrees leaves it in conflict, and stops what follows)
    for (let i = 0; i < 250 && core.db.sqlite.query("SELECT 1 FROM backlog_operations WHERE status != 'done'").get(); i++) await Bun.sleep(20);
    const left = core.db.sqlite.query("SELECT kind, field, status FROM backlog_operations WHERE status != 'done'").all();
    step("every backlog edit was sent", left.length === 0, JSON.stringify(left));
    step("no ops.config.json was written to the clone", !existsSync(join(ws.path, "ops.config.json")));
  } else {
    // with a copy: a write that names the original (stopped), then one without a target (goes to the copy)
    const prompt = ownCopy ? "gh issue create -R someone/widget --title x --body y; gh pr create --title x --body y" : "gh issue create --title x --body y";
    const start = { workspaceId: ws.id, runner: "claude", prompt, title: "write" };
    const before = await send("POST", "/api/tasks", start);
    step("task before the confirmation", before.status === 409);
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
    const refused = wrote as { code: number | null; stdout: string; stderr: string } | null;
    if (ownCopy) step("the Task's write to the original is stopped and the one to the copy goes", refused?.code === 0 && !!refused?.stderr.includes("ops-kit.noWrite"), refused?.stderr.trim().split("\n")[0]);
    else step("the Task's gh issue create is stopped", refused?.code !== 0 && !!refused?.stderr.includes("ops-kit.noWrite"), refused?.stderr.trim().split("\n")[0]);
    step("the confirmation holds for the next Task", (await send("POST", "/api/tasks", { ...start, prompt: "true" })).status === 201);
  }
  await Bun.sleep(1000); // what the daemon sends goes on in the background
} catch (e) {
  step("run", false, String(e));
}
await core.stop();
const writes = readFileSync(log, "utf8").split("\n").filter(Boolean);
if (kept) {
  // everything the daemon sent to the fake GitHub is here: your own repository's writes are what the scenario is about, not an error
  for (const e of seen.events) console.log(`gh: ${e}`); // the calls that matter, in order; the import's reads are left out
  console.log(`kept settings: gh calls ${writes.length}, Projects read ${[...new Set(seen.projects)].join(",")}, Issues created ${seen.created.length}, items added ${seen.itemAdds}, Priority ${seen.priority.join(",")}`);
  process.exit(failed ? 1 : 0);
}
for (const w of writes) console.log(w);
if (ownCopy) {
  const mine = readFileSync(mineLog, "utf8").split("\n").filter(Boolean);
  for (const w of mine) console.log(`copy: ${w}`);
  step("repo create me/widget --private is recorded", mine.includes("daemon: repo create me/widget --private"));
  step("the write to the copy arrives", mine.includes("task: pr create --title x --body y"));
}
console.log(`upstream writes: ${writes.length}`);
process.exit(failed || writes.length ? 1 : 0);
