// test-reads: none
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provenance, RunnerAdapter, RunnerId, StartOptions, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";
import { registerWorkspace } from "./workspace-clone.ts";

// 取り込み and 立ち上げ from a Workspace row: one Task each; the steps are the skill's and the candidate's, not the daemon's.

let core: CoreServer | undefined;
let root: string | undefined;
afterEach(async () => {
  if (core) await core.stop();
  if (root) rmSync(root, { recursive: true, force: true });
  core = root = undefined;
}, 30_000);

const started: StartOptions[] = [];
/** The candidate as the meta checkout holds it; a stand-in, so the test does not read the kit's own text. */
const DEFINITION = "---\nid: p2-baseline\nversion: 1\ntitle: 立ち上げ型\n---\n\n## entry baseline\n\n構想から立ち上げる。\n\n{{concept}}\n";

async function boot(ids: RunnerId[] = ["claude", "codex"]) {
  started.length = 0;
  root = mkdtempSync(join(tmpdir(), "switchboard.workspace-start."));
  const home = join(root, "home");
  const repoRoot = join(root, "switchboard");
  for (const d of [home, repoRoot, join(repoRoot, "ops-kit", "processes")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(repoRoot, "ops-kit", "processes", "p2-baseline.md"), DEFINITION);
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: repoRoot, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  const adapters: RunnerAdapter[] = ids.map((id) => ({
    id, detect: async () => ({ available: true }),
    start(opts, emit) {
      started.push(opts);
      queueMicrotask(() => emit({ t: "session.end", status: "ok" }));
      return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) };
    },
  }));
  core = await startServer(cfg, adapters, { port: 0, selfdevChecks: false, dryRunRestart: true });
  const base = `http://127.0.0.1:${core.server.port}`;
  const dir = (name: string) => {
    const p = join(root!, name);
    mkdirSync(p);
    return p;
  };
  const own = registerWorkspace(core.db, { path: dir("widget"), name: "widget", backlog: "github" });
  const local = registerWorkspace(core.db, { path: dir("notes"), name: "notes", backlog: "switchboard" });
  const foreign = core.db.upsertWorkspace({ name: "theirs", path: dir("theirs"), kind: "repo", upstream: "someone/theirs" });
  const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const post = async (id: string, what: "adopt" | "baseline", body?: unknown) => {
    const r = await fetch(`${base}/api/workspaces/${id}/${what}`, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as Task & { error?: string } };
  };
  const promptOf = async () => {
    for (let i = 0; !started.length && i < 100; i++) await Bun.sleep(10);
    return started.at(-1)!.prompt;
  };
  return { core, base, repoRoot, own, local, foreign, meta, post, promptOf };
}

test("adopt: starts one meta Task that names the adopt-repo skill and hands over the workspace as data", async () => {
  const b = await boot();
  const r = await b.post(b.own.id, "adopt");
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ workspaceId: b.meta.id, cwd: b.meta.path, title: "取り込み: widget" });
  const prompt = await b.promptOf();
  expect(prompt).toContain(".claude/skills/adopt-repo/SKILL.md");
  expect(prompt).toContain(b.own.path);
  // it asks before it writes: the skill's step 3, named in the prompt
  expect(prompt).toContain("書く前に");
  expect(b.core.db.listTasks()).toHaveLength(1);
});

test("adopt: someone else's repository, the meta workspace, an unknown id are 404; a workspace without GitHub is 409; nothing starts", async () => {
  const b = await boot();
  for (const id of [b.foreign.id, b.meta.id, "ws_missing"]) expect((await b.post(id, "adopt")).status).toBe(404);
  // a registered workspace whose directory is gone
  rmSync(b.own.path, { recursive: true });
  expect((await b.post(b.own.id, "adopt")).status).toBe(409);
  const local = await b.post(b.local.id, "adopt");
  expect(local.status).toBe(409);
  expect(local.body.error).toContain("GitHub と連携しない");
  expect(b.core.db.listTasks()).toHaveLength(0);
});

test("baseline: starts one Task in the workspace under p2-baseline, recorded as the button, with the concept fenced as data", async () => {
  const b = await boot();
  const concept = "旅行の予定を同行者と共有する。\n````\n閉じようとするフェンス\n````";
  const r = await b.post(b.own.id, "baseline", { concept });
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ workspaceId: b.own.id, cwd: b.own.path, title: "立ち上げ: widget" });
  const prov = (await (await fetch(`${b.base}/api/tasks/${r.body.id}/provenance`)).json()) as Provenance;
  expect(prov.process).toEqual({ id: "p2-baseline", version: 1 });
  expect(prov.processReason).toBe("baseline button");
  const prompt = await b.promptOf();
  expect(prompt).toContain("構想から立ち上げる。");
  // a fence longer than any run of backticks in the concept: the concept cannot close it
  expect(prompt).toContain(`\`\`\`\`\`text\n${concept}\n\`\`\`\`\``);
  // another repository's Task is told where the skills and scripts are, as a stage Task of that workspace is
  expect(prompt).toContain("--repo <このリポジトリの owner/name>");
});

test("baseline: a workspace without GitHub gets the rules for a backlog kept here, with no Project variable, and is told it has no PBI or Task", async () => {
  const b = await boot();
  const r = await b.post(b.local.id, "baseline", { concept: "メモの整理" });
  expect(r.status).toBe(201);
  const prompt = await b.promptOf();
  expect(prompt).toContain("ops-kit backlog");
  expect(prompt).toContain("GitHub にこの Issue は無い");
  expect(prompt).not.toContain("gh variable get");
  expect(prompt).toContain("この Task には PBI も Task の Issue も無い");
});

test("baseline: an empty or too long concept is 400, someone else's / meta / unknown is 404, no definition is 409; nothing starts", async () => {
  const b = await boot();
  for (const body of [{ concept: "" }, { concept: "   " }, { concept: "x".repeat(8_001) }, {}, undefined]) expect((await b.post(b.own.id, "baseline", body)).status).toBe(400);
  expect((await b.post(b.own.id, "baseline", { concept: "x".repeat(8_000) })).status).toBe(201);
  for (const id of [b.foreign.id, b.meta.id, "ws_missing"]) expect((await b.post(id, "baseline", { concept: "x" })).status).toBe(404);
  // a definition without the entry, then none at all: 409, not a 500
  writeFileSync(join(b.repoRoot, "ops-kit", "processes", "p2-baseline.md"), "---\nid: p2-baseline\nversion: 1\ntitle: t\n---\n\n## entry other\n\nx\n");
  const unrendered = await b.post(b.own.id, "baseline", { concept: "x" });
  expect(unrendered.status).toBe(409);
  rmSync(join(b.repoRoot, "ops-kit", "processes", "p2-baseline.md"));
  const missing = await b.post(b.own.id, "baseline", { concept: "x" });
  expect(missing.status).toBe(409);
  expect(missing.body.error).toContain("候補の定義を読めません");
  expect(b.core.db.listTasks()).toHaveLength(1);
});

test("adopt and baseline start on their own kind's runner when one is saved, else on the common one", async () => {
  const b = await boot();
  b.core.db.setSetting("settings", { autoStart: { runner: "codex" } });
  expect((await b.post(b.own.id, "adopt")).body).toMatchObject({ runner: "codex" });
  expect((await b.post(b.own.id, "baseline", { concept: "x" })).body).toMatchObject({ runner: "codex" });
  b.core.db.setSetting("settings", { autoStart: { runner: "codex", byKind: { "adopt-repo": { runner: "claude" }, baseline: { runner: "claude" } } } });
  expect((await b.post(b.own.id, "adopt")).body).toMatchObject({ runner: "claude" });
  expect((await b.post(b.own.id, "baseline", { concept: "x" })).body).toMatchObject({ runner: "claude" });
});
