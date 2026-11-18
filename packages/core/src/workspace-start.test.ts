// test-reads: none
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provenance, RunnerAdapter, RunnerId, StartOptions, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";
import { withoutWorkspaceRules } from "./tasks/manager.ts";
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
  /** Stops the daemon and starts it again on the same home; returns the new base URL. */
  const restart = async () => {
    await core!.stop();
    core = await startServer(cfg, adapters, { port: 0, selfdevChecks: false, dryRunRestart: true });
    return `http://127.0.0.1:${core.server.port}`;
  };
  return { core, base, repoRoot, own, local, foreign, meta, post, promptOf, restart };
}

test("adopt: starts one meta Task that names the adopt-repo skill and hands over the workspace as data", async () => {
  const b = await boot();
  const r = await b.post(b.own.id, "adopt");
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ workspaceId: b.meta.id, cwd: b.meta.path, title: "取り込み: widget" });
  const prompt = await b.promptOf();
  expect(prompt).toContain(".claude/skills/adopt-repo/SKILL.md");
  expect(prompt).toContain(b.own.path);
  // the id the skill puts the rules under, and whether GitHub's parts apply
  expect(prompt).toContain(b.own.id);
  expect(prompt).toContain("GitHub と連携する。");
  // it asks before it writes: the skill's step 3, named in the prompt
  expect(prompt).toContain("書く前に");
  expect(b.core.db.listTasks()).toHaveLength(1);
});

test("adopt: a workspace without GitHub is adopted too, and its Task is told to skip GitHub's parts", async () => {
  const b = await boot();
  const r = await b.post(b.local.id, "adopt");
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ workspaceId: b.meta.id, title: "取り込み: notes" });
  const prompt = await b.promptOf();
  expect(prompt).toContain(b.local.id);
  expect(prompt).toContain("GitHub と連携しない（Switchboard に置く）");
});

test("adopt: someone else's repository, the meta workspace, an unknown id are 404; a missing directory is 409; nothing starts", async () => {
  const b = await boot();
  for (const id of [b.foreign.id, b.meta.id, "ws_missing"]) expect((await b.post(id, "adopt")).status).toBe(404);
  // a registered workspace whose directory is gone
  rmSync(b.own.path, { recursive: true });
  expect((await b.post(b.own.id, "adopt")).status).toBe(409);
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

test("rules: kept in the database on Switchboard's side and added to the first prompt of Tasks in that workspace only", async () => {
  const b = await boot();
  const put = async (id: string, body: unknown) => {
    const r = await fetch(`${b.base}/api/workspaces/${id}/rules`, { method: "PUT", body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as { id?: string; rules?: string; error?: string } };
  };
  const rules = "テスト: make test\n枝: 人は feature/<topic>、Task は sb/<n>-<topic>";
  expect(await put(b.own.id, { rules: `  ${rules}\n` })).toEqual({ status: 200, body: { id: b.own.id, rules } });
  expect(b.core.db.getWorkspace(b.own.id)!.rules).toBe(rules);
  // refused: the meta workspace, someone else's repository, an unknown id, too long, no body, a value that can authenticate
  for (const id of [b.meta.id, b.foreign.id, "ws_missing"]) expect((await put(id, { rules })).status).toBe(404);
  for (const body of [{ rules: "x".repeat(8_001) }, {}, null]) expect((await put(b.own.id, body)).status).toBe(400);
  const secret = await put(b.own.id, { rules: `token: ghp_${"a".repeat(36)}` });
  expect(secret.status).toBe(400);
  expect(b.core.db.getWorkspace(b.own.id)!.rules).toBe(rules);
  // a Task there gets the rules after its prompt; a Task in another workspace does not
  const start = (workspaceId: string, cwd: string, title: string | null = "t") => fetch(`${b.base}/api/tasks`, { method: "POST", body: JSON.stringify({ workspaceId, cwd, runner: "claude", prompt: "直して", ...(title ? { title } : {}) }) });
  expect((await start(b.own.id, b.own.path)).status).toBe(201);
  const withRules = await b.promptOf();
  expect(withRules.startsWith("直して")).toBe(true);
  expect(withRules).toContain("このリポジトリの決まり（Switchboard の側に置いたもの。リポジトリの git には無い）");
  expect(withRules).toContain(rules);
  // the automatic title reads the request alone
  expect(withoutWorkspaceRules(withRules)).toBe("直して");
  expect(withoutWorkspaceRules("直して")).toBe("直して");
  started.length = 0;
  expect((await start(b.local.id, b.local.path)).status).toBe(201);
  expect(await b.promptOf()).not.toContain("このリポジトリの決まり");
  // the launch Task of that workspace gets them too (one place for every route)
  started.length = 0;
  expect((await b.post(b.own.id, "baseline", { concept: "x" })).status).toBe(201);
  expect(await b.promptOf()).toContain(rules);
  // a Task made without a title is named from the request's own words, not from the rules added after them
  expect(((await (await start(b.own.id, b.own.path, null)).json()) as Task).title).toBe("直して");
  // empty = none
  expect(await put(b.own.id, { rules: "  " })).toEqual({ status: 200, body: { id: b.own.id, rules: "" } });
  expect(b.core.db.getWorkspace(b.own.id)!.rules).toBeUndefined();
});

/** The page's answer to a pending change of the settings (the headers a browser adds on its own page). */
const answerConfig = (base: string, askId: string, ok: boolean, page = true) =>
  fetch(`${base}/api/asks/answer`, { method: "POST", headers: page ? { origin: base, "sec-fetch-site": "same-origin" } : {}, body: JSON.stringify({ id: askId, answer: { kind: "confirm", ok } }) });

test("config: the workspace's settings are kept on Switchboard's side; a bare call's change of the CI's steps waits as a question and is in force only after the page confirms it; then written to a file the tools read and handed to its Tasks; a refusal says why in one line", async () => {
  const b = await boot();
  type View = { id?: string; config?: string; file?: string | null; source?: string; version?: string | null; pending?: { askId: string; keys: string[]; source: string; config: string } | null; error?: string };
  const call = async (id: string, method: "GET" | "PUT", body?: unknown) => {
    const r = await fetch(`${b.base}/api/workspaces/${id}/config`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: (await r.json()) as View };
  };
  // nothing saved, no file in the repository
  expect(await call(b.own.id, "GET")).toEqual({ status: 200, body: { id: b.own.id, config: "", file: null, source: "none", version: null, pending: null } });
  const config = { ci: { steps: [{ name: "test", run: "make test" }] } };
  const text = `${JSON.stringify(config, null, 2)}\n`;
  const file = join(root!, "home", "workspace-config", b.own.id, "ops.config.json");
  // a call that does not look like the page's (a Task's curl, a script): recorded, not in force, no file
  const asked = await call(b.own.id, "PUT", { config: JSON.stringify(config) });
  expect(asked).toMatchObject({ status: 200, body: { config: "", file: null, source: "none", version: null, pending: { keys: ["ci"], source: "call", config: text } } });
  expect(existsSync(file)).toBe(false);
  expect(b.core.db.getWorkspace(b.own.id)!.config).toBeUndefined();
  // it waits among the questions, and only the page can answer it
  const askId = asked.body.pending!.askId;
  const asks = ((await (await fetch(`${b.base}/api/asks`)).json()) as { asks: Array<{ id: string; state: string; answers: string[]; needs: string }> }).asks;
  expect(asks.find((a) => a.id === askId)).toMatchObject({ state: "open", answers: ["confirm"], needs: "person" });
  const bare = await answerConfig(b.base, askId, true, false);
  expect(bare.status).toBe(403);
  expect(((await bare.json()) as { reason: string }).reason).toBe("human");
  expect(existsSync(file)).toBe(false);
  expect((await answerConfig(b.base, askId, true)).status).toBe(200);
  const saved = await call(b.own.id, "GET");
  expect(saved).toEqual({ status: 200, body: { id: b.own.id, config: text, file, source: "switchboard", version: expect.stringMatching(/^[0-9a-f]{12}$/), pending: null } });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(config);
  // the record of the change: how it came in, both values, who confirmed
  const changes = ((await (await fetch(`${b.base}/api/workspaces/${b.own.id}/config/changes`)).json()) as { changes: Array<Record<string, unknown>> }).changes;
  expect(changes).toEqual([expect.objectContaining({ state: "confirmed", source: "call", decidedBy: "screen", before: null, after: text, keys: ["ci"] })]);
  // the index the scripts find the file by, outside a Task: the workspace's folder and name, the version in force, and no change waiting
  expect(JSON.parse(readFileSync(join(root!, "home", "workspace-config", "index.json"), "utf8"))).toEqual({ workspaces: [{ id: b.own.id, name: "widget", path: b.own.path, file, version: saved.body.version }], pending: [] });
  // nothing was written to the repository
  expect(existsSync(join(b.own.path, "ops.config.json"))).toBe(false);
  // refused with the reason: not in the shape (an unknown key, a key in a wrong shape, not JSON), publicSync, a value that can authenticate
  const refused = async (text: string) => {
    const r = await call(b.own.id, "PUT", { config: text });
    expect(r.status).toBe(400);
    return r.body.error!;
  };
  expect(await refused(JSON.stringify({ ci: { steps: [] } }))).toStartWith("設定の形が不正です: ci.steps:");
  expect(await refused(JSON.stringify({ nope: 1 }))).toStartWith("設定の形が不正です:");
  expect(await refused("{ not json")).toStartWith("JSON として読めません:");
  expect(await refused(JSON.stringify({ publicSync: { target: "o/public", exclude: [] } }))).toStartWith("publicSync は Switchboard の側には置けません");
  expect(await refused(JSON.stringify({ ci: { steps: [{ run: `curl -H "Authorization: token ghp_${"a".repeat(36)}" https://example.com` }] } }))).toBe("認証に使える値を含む設定は保存できません");
  expect((await refused("x".repeat(40_001))).length).toBeGreaterThan(0);
  // every refusal left the saved settings as they were
  expect((await call(b.own.id, "GET")).body.config).toBe(saved.body.config);
  // someone else's repository, the meta workspace and an unknown id: 404, read or write
  for (const id of [b.meta.id, b.foreign.id, "ws_missing"]) {
    expect((await call(id, "GET")).status).toBe(404);
    expect((await call(id, "PUT", { config: "{}" })).status).toBe(404);
  }
  // a Task there is started with the file's place (the kit's variable); a Task in another workspace is not
  const start = (workspaceId: string, cwd: string) => fetch(`${b.base}/api/tasks`, { method: "POST", body: JSON.stringify({ workspaceId, cwd, runner: "claude", prompt: "直して", title: "t" }) });
  started.length = 0;
  expect((await start(b.own.id, b.own.path)).status).toBe(201);
  await b.promptOf();
  expect(started.at(-1)!.env).toMatchObject({ OPS_KIT_CONFIG: file });
  started.length = 0;
  expect((await start(b.local.id, b.local.path)).status).toBe(201);
  await b.promptOf();
  expect(started.at(-1)!.env).not.toHaveProperty("OPS_KIT_CONFIG");
  // the repository's own ops.config.json wins as a whole: the row says which settings are in use
  writeFileSync(join(b.own.path, "ops.config.json"), "{}");
  expect((await call(b.own.id, "GET")).body.source).toBe("repository");
  rmSync(join(b.own.path, "ops.config.json"));
  // empty = none, once confirmed: the file goes
  const emptied = await call(b.own.id, "PUT", { config: "  " });
  expect(emptied.body).toMatchObject({ config: text, pending: { keys: ["ci"], config: "" } });
  expect(existsSync(file)).toBe(true);
  expect((await answerConfig(b.base, emptied.body.pending!.askId, true)).status).toBe(200);
  expect(await call(b.own.id, "GET")).toEqual({ status: 200, body: { id: b.own.id, config: "", file: null, source: "none", version: null, pending: null } });
  expect(existsSync(file)).toBe(false);
  expect(b.core.db.getWorkspace(b.own.id)!.config).toBeUndefined();
});

test("config: written again from the database when the daemon starts (the files are a copy)", async () => {
  const b = await boot();
  const put = await fetch(`${b.base}/api/workspaces/${b.own.id}/config`, { method: "PUT", body: JSON.stringify({ config: '{"ci":{"steps":[{"run":"make"}]}}' }) });
  expect((await answerConfig(b.base, ((await put.json()) as { pending: { askId: string } }).pending.askId, true)).status).toBe(200);
  const file = join(root!, "home", "workspace-config", b.own.id, "ops.config.json");
  rmSync(join(root!, "home", "workspace-config"), { recursive: true });
  await b.core.stop();
  core = undefined;
  const again = await startServer(loadConfig({ SWITCHBOARD_HOME: join(root!, "home"), SWITCHBOARD_REPO_ROOT: join(root!, "switchboard"), SWITCHBOARD_KNOWLEDGE: join(root!, "home", "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(root!, "home", "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [], { port: 0, selfdevChecks: false, dryRunRestart: true });
  core = again;
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ ci: { steps: [{ run: "make" }] } });
  expect(((await (await fetch(`http://127.0.0.1:${again.server.port}/api/workspaces/${b.own.id}/config`)).json()) as { source: string }).source).toBe("switchboard");
});

test("rules: read back through the API after the daemon restarts", async () => {
  const b = await boot();
  const rules = "コミット: Conventional Commits";
  expect((await fetch(`${b.base}/api/workspaces/${b.own.id}/rules`, { method: "PUT", body: JSON.stringify({ rules }) })).status).toBe(200);
  const base = await b.restart();
  const list = (await (await fetch(`${base}/api/workspaces`)).json()) as Array<{ id: string; rules?: string }>;
  expect(list.find((w) => w.id === b.own.id)?.rules).toBe(rules);
  expect(list.find((w) => w.id === b.local.id)?.rules).toBeUndefined();
});
