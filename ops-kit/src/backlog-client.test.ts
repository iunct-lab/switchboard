import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecords, runBacklog } from "./backlog-client.ts";

// `ops-kit backlog` (#918) against a fake app: what it sends, and the exit it gives for each answer. The real app's
// routes are checked in packages/core/src/backlog.test.ts ("ops-kit backlog …").

const SYNC = { workspaceId: "ws1", repository: "acme/app", syncedAt: 1_760_000_000_000, syncing: false, sync: { state: "synced", reason: null, pendingCount: 0 } };
const LIST = { syncs: [SYNC, { ...SYNC, workspaceId: "ws2", repository: "acme/other" }], items: [{ number: 3, workspaceId: "ws1", type: "pbi", stage: "ready", projectStatus: "Ready", title: "PBI 3" }, { number: 9, workspaceId: "ws2", type: "pbi", stage: "ready", projectStatus: "Ready", title: "other" }] };
const issue = (number: number, title: string, state: "OPEN" | "CLOSED", labels: string[], status: string | null) => ({ number, title, state, stateReason: null, body: "", labels, parent: null, subIssues: [], updatedAt: "", fields: status === null ? null : { Status: status } });
/** `GET /records` of a workspace: what `backlog list` reads (#3071). */
const RECORDS = (workspaceId: string) => ({
  workspaceId,
  service: "github",
  repository: "acme/app",
  project: { owner: "acme", number: 1 },
  fetchedAt: 1,
  top: [],
  unread: [],
  pulls: [],
  issues: workspaceId === "ws2" ? [issue(9, "other", "OPEN", ["type:pbi"], "Ready")] : [issue(3, "PBI 3", "OPEN", ["type:pbi", "area:web"], "Ready"), issue(4, "要望: Closed Request", "CLOSED", ["type:request"], "Done"), issue(5, "Task: 実装", "OPEN", ["type:task", "area:web"], null), issue(6, "PBI: closed", "CLOSED", ["type:pbi"], "Done")],
});
/** The app's answer by route: the workspace list, a workspace's records, else `other`. */
const routes = (other: (method: string, path: string, body: unknown) => { status?: number; body?: unknown } = () => ({ body: {} })) => (method: string, path: string, body: unknown) => {
  const records = /^\/records\?workspaceId=(.+)$/.exec(path);
  return path === "" ? { body: LIST } : records ? { body: RECORDS(decodeURIComponent(records[1]!)) } : other(method, path, body);
};

function app(answer: (method: string, path: string, body: unknown) => { status?: number; body?: unknown } | "down" = routes()) {
  const calls: Array<{ method: string; path: string; body: unknown; auth: string | null }> = [];
  const fetch = async (url: string, init: RequestInit = {}) => {
    const path = url.replace("http://app/api/backlog", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? "GET", path, body, auth: new Headers(init.headers).get("authorization") });
    const a = answer(init.method ?? "GET", path, body);
    if (a === "down") throw new Error("connect ECONNREFUSED");
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 });
  };
  return { fetch, calls };
}

async function run(argv: string[], fake = app(), env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runBacklog(argv, { BACKLOG_URL: "http://app/api/backlog", GH_REPO: "acme/app", ...env }, { out: (s) => out.push(s), err: (s) => err.push(s), stdin: async () => "from stdin" }, { fetch: fake.fetch, phase: true });
  return { code, out: out.join("\n"), err: err.join("\n"), calls: fake.calls };
}

test("list: the stored items of the repository's workspace and how fresh they are, one read and no sync unless --fresh", async () => {
  const r = await run(["list"]);
  expect(r.code).toBe(0);
  expect(r.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET ", "GET /records?workspaceId=ws1"]);
  expect(r.out).toContain("# acme/app  最終取得 2025-10-09");
  expect(r.out).toContain("同期 synced");
  expect(r.out).toContain("#3\tpbi\tOPEN\tReady\tPBI 3");
  expect(r.out).toContain("#5\ttask\tOPEN\t-\tTask: 実装");
  expect(r.out).not.toContain("other");
  const fresh = await run(["list", "--fresh"]);
  expect(fresh.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET ", "POST /sync", "GET ", "GET /records?workspaceId=ws1"]);
  expect(fresh.calls[1]!.body).toEqual({ workspaceId: "ws1" });
});

test("list --search / --label / --state (#3071): filtered from the stored records, open by default; a wrong --state is refused", async () => {
  const numbers = async (...argv: string[]) => {
    const r = await run(["list", ...argv]);
    expect(r.code).toBe(0);
    return r.out.split("\n").slice(1).map((l) => l.split("\t")[0]);
  };
  expect(await numbers()).toEqual(["#3", "#5"]);
  expect(await numbers("--state", "closed")).toEqual(["#4", "#6"]);
  expect(await numbers("--state", "all")).toEqual(["#3", "#4", "#5", "#6"]);
  expect(await numbers("--label", "type:request", "--state", "closed")).toEqual(["#4"]);
  // every label given: both type:task and area:web
  expect(await numbers("--label", "area:web", "--label", "type:task")).toEqual(["#5"]);
  // a part of the title, case-insensitive
  expect(await numbers("--search", "closed", "--state", "all")).toEqual(["#4", "#6"]);
  expect(await numbers("--search", "pbi")).toEqual(["#3"]);
  const json = JSON.parse((await run(["list", "--label", "type:request", "--state", "closed", "--json"])).out);
  expect(json.items).toEqual([{ number: 4, type: "request", state: "CLOSED", status: "Done", title: "要望: Closed Request", labels: ["type:request"] }]);
  // what the last import could not read is listed as stored, and said so on stderr
  const stale = await run(["list"]);
  expect(stale.err).toBe("");
  const unread = await run(["list", "--json"], app((m, p) => (p.startsWith("/records") ? { body: { ...RECORDS("ws1"), unread: [5, 6] } } : routes()(m, p, undefined))));
  expect([JSON.parse(unread.out).unread, unread.err]).toEqual([[5], "最後の取込みで読めていない Issue（保存値のまま。今の値ではない）: #5（--fresh で取り込み直す）"]);
  const wrong = await run(["list", "--state", "merged"]);
  expect([wrong.code, wrong.calls.length]).toEqual([1, 0]);
});

test("the key in BACKLOG_TOKEN_FILE goes as the bearer; --workspace picks a workspace without a repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "backlog-client-"));
  try {
    writeFileSync(join(dir, "token"), "k123\n");
    const r = await run(["list", "--workspace", "ws2"], app(), { BACKLOG_TOKEN_FILE: join(dir, "token"), GH_REPO: undefined });
    expect(r.code).toBe(0);
    expect(r.calls[0]!.auth).toBe("Bearer k123");
    expect(r.out).toContain("#9\tpbi\tOPEN\tReady\tother");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nothing is read as current when it cannot be told: no app, the app down, a repository not imported, 5xx; GitHub out of reach answers what is stored (#2264)", async () => {
  expect((await run(["list"], app(), { BACKLOG_URL: undefined })).code).toBe(2);
  expect((await run(["list"], app(() => "down"))).code).toBe(2);
  // the app cannot reach GitHub (424): the stored copy is the answer, with its last sync and 「GitHub 未同期」
  const detail = { issue: { number: 3, title: "PBI 3", state: "OPEN", labels: [], milestone: null, parent: null, body: "保存した本文", url: "" }, comments: [], fields: null, fetchedAt: 1, localId: null, pending: 1, sync: { state: "pending", reason: "import", lastSuccessfulSync: SYNC.syncedAt } };
  const unsynced = await run(["view", "3", "--fresh"], app((m, p) => (p === "/sync" ? { status: 424, body: { error: "GitHub の上限" } } : { body: p === "" ? LIST : detail })));
  expect(unsynced.code).toBe(0);
  expect(unsynced.err).toContain("GitHub 未同期");
  expect(unsynced.err).toContain("最終同期 2025-10-09");
  expect(unsynced.err).toContain("424 GitHub の上限");
  expect(unsynced.out).toContain("保存した本文");
  expect(unsynced.calls.map((c) => c.path)).toEqual(["", "/sync", "", "/3?workspaceId=ws1"]);
  // the same with --json: stdout keeps its shape, the line goes to stderr
  const json = await run(["list", "--fresh", "--json"], app(routes((m, p) => (p === "/sync" ? { status: 424, body: { error: "GitHub の上限" } } : {}))));
  expect([json.code, JSON.parse(json.out).workspaceId, json.err.includes("GitHub 未同期")]).toEqual([0, "ws1", true]);
  // the app failing itself, or answering the sync with 5xx, is not GitHub out of reach
  for (const status of [500, 502, 401]) expect((await run(["view", "3", "--fresh"], app((m, p) => (p === "/sync" ? { status } : { body: LIST })))).code).toBe(2);
  expect((await run(["list"], app(), { GH_REPO: "acme/unknown" })).code).toBe(2);
  // a workspace never imported has no items: not an empty list as if read
  const never = { ...LIST, syncs: [{ ...SYNC, syncedAt: null, sync: { state: "error", reason: "unfetched", pendingCount: 0 } }], items: [] };
  const unfetched = await run(["list"], app(() => ({ body: never })));
  expect(unfetched.code).toBe(2);
  expect(unfetched.out).toBe("");
  for (const argv of [["view", "3"], ["set", "3", "Status", "Ready"], ["edit", "3", "--title", "T"]]) {
    const r = await run(argv, app(() => ({ body: never })));
    expect([r.code, r.calls.map((c) => c.path)]).toEqual([2, [""]]);
  }
  expect((await run(["view", "3"], app((m, p) => (p === "" ? { body: LIST } : { status: 500 })))).code).toBe(2);
  expect((await run(["view", "3"], app((m, p) => (p === "" ? { body: LIST } : { status: 409, body: { error: "まだ GitHub から取り込んでいません" } })))).code).toBe(2);
});

test("a sandbox refusal names the approved rerun; the app down keeps its line (#2726)", async () => {
  const refused = { fetch: async () => { throw Object.assign(new Error("EPERM: Was there a typo in the url or port?"), { code: "EPERM" }); }, calls: [] };
  const r = await run(["view", "3"], refused as unknown as ReturnType<typeof app>);
  expect(r.code).toBe(2);
  expect(r.err).toContain("サンドボックスがこのホストのアプリ（BACKLOG_URL）への接続を止めています");
  expect(r.err).toContain("承認つきの実行で同じコマンドを 1 回やり直して");
  const down = await run(["view", "3"], app(() => "down"));
  expect(down.code).toBe(2);
  expect(down.err).toContain("アプリに届きません（connect ECONNREFUSED）。判定できません");
  expect(down.err).not.toContain("承認つきの実行");
});

test("readRecords --fresh: a 424 sync answers the stored records with unsynced; the app down is unknown (#2264)", async () => {
  const records = { workspaceId: "ws1", repository: "acme/app", fetchedAt: SYNC.syncedAt, issues: [] };
  const env = { BACKLOG_URL: "http://app/api/backlog", GH_REPO: "acme/app" };
  const limited = app((m, p) => (p === "/sync" ? { status: 424, body: { error: "GitHub の上限" } } : { body: p === "" ? LIST : records }));
  const r = await readRecords(env, { fresh: true, fetch: limited.fetch });
  expect(r).toMatchObject({ workspaceId: "ws1", unsynced: expect.stringContaining("GitHub 未同期") });
  expect(limited.calls.map((c) => c.path)).toEqual(["", "/sync", "/records?workspaceId=ws1"]);
  const synced = await readRecords(env, { fresh: true, fetch: app((m, p) => ({ body: p === "" ? LIST : records })).fetch });
  expect(synced.unsynced).toBeNull();
  await expect(readRecords(env, { fresh: true, fetch: app(() => "down").fetch })).rejects.toThrow("届きません");
  await expect(readRecords(env, { fresh: true, fetch: app((m, p) => (p === "/sync" ? { status: 503 } : { body: LIST })).fetch })).rejects.toThrow("503");
});

test("edits go to the app's routes as its screen sends them; a refusal is exit 1", async () => {
  const detail = { issue: { number: 3 }, fields: { "Story Points": 2, Code: "007" } };
  const ok = app((m, p) => (m === "GET" ? { body: p === "" ? LIST : detail } : { status: 202, body: { localId: "L1", operations: ["o"] } }));
  expect((await run(["edit", "#3", "--title", "T", "--body-file", "-", "--add-label", "a", "--remove-label", "b", "--state", "closed", "--no-milestone"], ok)).code).toBe(0);
  expect((await run(["set", "3", "Story Points", "5"], ok)).code).toBe(0);
  expect((await run(["set", "3", "Code", "001"], ok)).code).toBe(0);
  expect((await run(["triage", "3", "core", "feature", "P2", "Phase 2", "891", "Ready"], ok)).code).toBe(0);
  expect((await run(["comment", "3", "--body-file", "-"], ok)).code).toBe(0);
  expect((await run(["create", "--title", "New", "--label", "type:task", "--parent", "891", "--field", "Status=Backlog"], ok)).code).toBe(0);
  expect(ok.calls.filter((c) => c.method !== "GET").map((c) => [c.method, c.path, c.body])).toEqual([
    ["PATCH", "/3", { workspaceId: "ws1", title: "T", body: "from stdin", labels: { add: ["a"], remove: ["b"] }, state: "CLOSED", milestone: null }],
    // a number only where the stored value is one; GitHub's field type decides when the app sends it
    ["PATCH", "/3", { workspaceId: "ws1", fields: { "Story Points": 5 } }],
    ["PATCH", "/3", { workspaceId: "ws1", fields: { Code: "001" } }],
    ["PATCH", "/3", { workspaceId: "ws1", project: true, fields: { Area: "core", Kind: "feature", Priority: "P2", Phase: "Phase 2", Status: "Ready" }, parent: 891 }],
    ["POST", "/3/comment", { workspaceId: "ws1", text: "from stdin" }],
    ["POST", "", { workspaceId: "ws1", title: "New", body: "", labels: ["type:task"], milestone: null, parent: 891, fields: { Status: "Backlog" } }],
  ]);
  const refused = await run(["edit", "3", "--title", "T"], app((m) => (m === "GET" ? { body: LIST } : { status: 404, body: { error: "#3 は保存されていません" } })));
  expect(refused).toMatchObject({ code: 1, err: "backlog: 404 #3 は保存されていません" });
  expect((await run(["edit", "3"])).code).toBe(1);
  // an edit has nothing to wait for: --fresh there is refused, not ignored
  const fresh = await run(["edit", "3", "--title", "T", "--fresh"]);
  expect([fresh.code, fresh.calls]).toEqual([1, []]);
  expect((await run(["nope"])).code).toBe(1);
});

test("a text holding a value usable to authenticate is not sent at all", async () => {
  const leaked = app();
  const out: string[] = [];
  const code = await runBacklog(["comment", "3", "--body-file", "-"], { BACKLOG_URL: "http://app/api/backlog", GH_REPO: "acme/app" }, { out: (s) => out.push(s), err: (s) => out.push(s), stdin: async () => "token ghp_" + "a".repeat(36) }, { fetch: leaked.fetch });
  expect(code).toBe(1);
  expect(leaked.calls).toEqual([]);
  expect(out.join("\n")).not.toContain("ghp_");
  // an account id of the host's AWS config, written bare, is refused the same way
  const id = ["8642", "9753", "1086"].join("");
  const dir = mkdtempSync(join(tmpdir(), "backlog-client-aws-"));
  writeFileSync(join(dir, "config"), `[profile x-admin]\nsso_account_id = ${id}\n`);
  const bare = await runBacklog(["comment", "3", "--body-file", "-"], { BACKLOG_URL: "http://app/api/backlog", GH_REPO: "acme/app", AWS_CONFIG_FILE: join(dir, "config") }, { out: (s) => out.push(s), err: (s) => out.push(s), stdin: async () => `メモ ${id}` }, { fetch: leaked.fetch });
  rmSync(dir, { recursive: true });
  expect(bare).toBe(1);
  expect(leaked.calls).toEqual([]);
  expect(out.join("\n")).toContain("account-id");
  expect(out.join("\n")).not.toContain(id);
});

test("BACKLOG_WORKSPACE picks a workspace without GitHub, origin unread (#2265)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "backlog-client-local-")); // no Git, no origin
  try {
    const local = { ...SYNC, workspaceId: "ws_local", repository: "ws_local" };
    const list = { syncs: [...LIST.syncs, local], items: [] };
    const detail = { issue: { number: 1, title: "PBI 1", state: "OPEN", labels: [], milestone: null, parent: null, body: "", url: "" }, comments: [], fields: null, fetchedAt: 1, localId: null, pending: 0, sync: { state: "synced", reason: null, lastSuccessfulSync: 1 } };
    const fake = app((m, p) => ({ body: p === "" ? list : detail }));
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s) };
    expect(await runBacklog(["view", "1"], { BACKLOG_URL: "http://app/api/backlog", BACKLOG_WORKSPACE: "ws_local" }, io, { fetch: fake.fetch, cwd: dir })).toBe(0);
    expect(fake.calls.at(-1)!.path).toBe("/1?workspaceId=ws_local");
    // GH_REPO, when set, comes first
    expect(await runBacklog(["view", "1"], { BACKLOG_URL: "http://app/api/backlog", BACKLOG_WORKSPACE: "ws_local", GH_REPO: "acme/app" }, io, { fetch: fake.fetch, cwd: dir })).toBe(0);
    expect(fake.calls.at(-1)!.path).toBe("/1?workspaceId=ws1");
    // the records the lint and the parallel guard read
    const records = { workspaceId: "ws_local", service: "app", repository: "ws_local", project: { owner: "app", number: 0 }, fetchedAt: 1, top: [], issues: [], unread: [], pulls: [] };
    const r = await readRecords({ BACKLOG_URL: "http://app/api/backlog", BACKLOG_WORKSPACE: "ws_local" }, { fresh: false, cwd: dir, fetch: app((m, p) => ({ body: p === "" ? list : records })).fetch });
    expect([r.workspaceId, r.service]).toEqual(["ws_local", "app"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("create prints the number a local backlog gives (#2265)", async () => {
  const local = await run(["create", "--title", "PBI: x", "--label", "type:pbi"], app((m) => ({ body: m === "GET" ? LIST : { localId: "u1", number: 1 } })));
  expect([local.code, local.out]).toEqual([0, "#1 を作りました（localId u1）"]);
  const github = await run(["create", "--title", "PBI: x"], app((m) => ({ body: m === "GET" ? LIST : { localId: "u2", number: null } })));
  expect(github.out).toContain("作りました（送信待ち）: localId u2");
});
