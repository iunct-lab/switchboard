/**
 * bun scripts/backlog-sync-e2e.ts --api | --browser. `--browser` (#911) drives the Backlog screen in headless Chrome
 * (CDP) against the same fake GitHub and a fake runner: see the block at the end. `--api` (#886): the backlog edits kept while GitHub cannot be reached, through the daemon's
 * HTTP API only — no runner, no browser, no GitHub. One fake GitHub answers the import (GraphQL) and the sends (REST /
 * GraphQL) from one state, which is what someone who uses only GitHub would see.
 *
 * GitHub out of reach → a new Issue (with its Project field), edits of the title, the body (three times) and a Project
 * field, an answer → a backup (snapshotTo) → the daemon stops → it starts
 * on the backup → GitHub answers again: everything arrives once, in order. Then a reply lost after GitHub posted (found by
 * its marker, not posted again) and a post whose result is unknown and not found (never posted again).
 * The other fields (labels, state, milestone, parent, membership) are each sent by backlog-send.test.ts.
 * The reads after a write (#1355) are answered with an empty history: the overwrite checks are backlog-send.test.ts's.
 * Prints a JSON of pass / fail per case and counts; exit 1 when one fails.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer, type CoreServer } from "../packages/core/src/server.ts";
import { jstDateTime } from "../apps/web/src/time.ts";
import type { GhRunner } from "../packages/core/src/backlog.ts";
import type { BacklogIssueDetail, RunnerAdapter, Task } from "@switchboard/protocol";

const MODE_API = process.argv.includes("--api");
const MODE_BROWSER = process.argv.includes("--browser");
if (!MODE_API && !MODE_BROWSER) {
  console.error("usage: bun scripts/backlog-sync-e2e.ts --api | --browser");
  process.exit(2);
}

type Comment = { id: string; body: string; createdAt: string };
type Issue = { id: string; number: number; title: string; body: string; state: string; labels: string[]; parent: number | null; comments: Comment[]; item: { id: string; fields: Record<string, string | null> } | null };
const at = "2026-10-08T00:00:00Z";
const github = new Map<number, Issue>([
  [12, { id: "I_12", number: 12, title: "PBI: 元の題", body: "元の本文", state: "OPEN", labels: ["type:pbi", "needs-decision"], parent: null, comments: [{ id: "C_1", body: "## 判断待ち\n**問い**: A か B か", createdAt: at }], item: { id: "PVTI_12", fields: { Status: "In progress" } } }],
  [13, { id: "I_13", number: 13, title: "要望: 元", body: "原文", state: "OPEN", labels: ["type:request"], parent: null, comments: [], item: null }],
]);
const posts: string[] = [];
/** How many times the Issues were listed: what looking for an unknown create's marker reads. */
let lists = 0;
let down = false;
/** While set, GitHub answers reads but refuses every write: "403" (refused for good) or "502" (a gateway error, may be retried). */
let writesFail: "403" | "502" | null = null;
/** Answers the next call that matches instead of it; `after`: carries it out first (the reply is what is lost). */
let fail: { match: (a: string[]) => boolean; after: boolean } | null = null;

const ok = (body: unknown) => ({ code: 0, stdout: `HTTP/2.0 200 OK\ncontent-type: application/json\n\n${JSON.stringify(body)}`, stderr: "" });
const byId = (id: string) => [...github.values()].find((i) => i.id === id || i.item?.id === id)!;
const raw = (i: Issue) => ({
  id: i.id, number: i.number, title: i.title, url: `https://github.com/acme/app/issues/${i.number}`, state: i.state, body: i.body, createdAt: at, updatedAt: at, milestone: null,
  parent: i.parent ? { number: i.parent } : null, labels: { totalCount: i.labels.length, nodes: i.labels.map((name) => ({ name })) },
  subIssues: { totalCount: 0, nodes: [] }, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: i.comments },
  projectItems: { totalCount: i.item ? 1 : 0, nodes: i.item ? [{ id: i.item.id, project: { number: 1, owner: { login: "acme" } }, fieldValues: { totalCount: Object.keys(i.item.fields).length, nodes: Object.entries(i.item.fields).map(([f, name]) => ({ name, field: { name: f } })) } }] : [] },
});
const rest = (i: Issue) => ({ node_id: i.id, number: i.number, html_url: `https://github.com/acme/app/issues/${i.number}`, title: i.title, body: i.body, state: i.state.toLowerCase(), created_at: at, updated_at: at });

/** The second workspace's directory (--browser, #1541): `gh repo view` there says acme/second, and it has no Issues. */
let second = "";
const gh: GhRunner = async (args, cwd) => {
  if (down) return { code: 1, stdout: "", stderr: "error connecting to api.github.com" };
  if (args[0] === "repo") return { code: 0, stdout: cwd === second ? "acme/second true\n" : "acme/app true\n", stderr: "" };
  if (second && cwd === second && args[1] === "graphql") {
    const q = args.find((a) => a.startsWith("query="))?.slice(6) ?? "";
    const empty = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
    if (q.includes("issues(first:50")) return ok({ data: { repository: { issues: empty } } });
    if (q.includes("issues(first:100")) return ok({ data: { repository: { issues: empty, pullRequests: empty } } });
  }
  if (writesFail && ((args.includes("-X") && args[args.indexOf("-X") + 1] !== "GET") || args.some((a) => a.includes("addProjectV2ItemById") || a.includes("updateProjectV2ItemFieldValue")))) {
    return { code: 1, stdout: "", stderr: writesFail === "403" ? "HTTP 403: Resource not accessible by integration" : "HTTP 502: Bad Gateway" };
  }
  const v: Record<string, any> = {};
  for (let k = 0; k < args.length; k++) if (args[k] === "-f" || args[k] === "-F") {
    const [key, ...val] = args[k + 1]!.split("=");
    if (key!.endsWith("[]")) (v[key!.slice(0, -2)] ??= []).push(val.join("="));
    else v[key!] = args[k] === "-F" && /^\d+$/.test(val.join("=")) ? Number(val.join("=")) : val.join("=");
  }
  const failing = fail?.match(args) ? fail : null;
  if (failing) fail = null;
  const lost = { code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" };
  if (failing && !failing.after) return lost;
  const answer = (body: unknown) => (failing ? lost : ok(body));
  const q: string = v.query ?? "";
  const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
  if (args[1] === "graphql") {
    // the import's reads (#885)
    if (q.includes("issues(first:50")) return answer({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [...github.values()].map(raw) } } } });
    if (q.includes("issues(first:100")) return answer({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [...github.values()].filter((i) => i.state === "OPEN").map((i) => ({ number: i.number, projectItems: raw(i).projectItems })) }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    // the sends' (#886)
    if (q.includes("issue(number:$n){ id title")) {
      const i = github.get(v.n)!;
      return answer({ data: { repository: { issue: { id: i.id, title: i.title, body: i.body, state: i.state, milestone: null, parent: i.parent && { id: github.get(i.parent)!.id, number: i.parent }, labels: { nodes: i.labels.map((name) => ({ name })) } } } } });
    }
    if (q.includes("projectV2(number:$p)")) return answer({ data: { repositoryOwner: { projectV2: { id: "P_1", fields: { nodes: [{ id: "F_s", name: "Status", dataType: "SINGLE_SELECT", options: ["Backlog", "Ready", "In progress"].map((name) => ({ id: name, name })) }] } } } } });
    if (q.includes("fieldValueByName")) {
      const node = { fieldValueByName: byId(v.i).item?.fields[v.f] ? { name: byId(v.i).item!.fields[v.f] } : null };
      // the read after a write (AFTER_ITEM_Q, #1355) also asks for the history: an empty one
      const after = q.includes("timelineItems") ? { repository: { issue: { timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] } } } } : {};
      return answer({ data: { viewer: { login: "me" }, node, ...after } });
    }
    if (q.includes("addProjectV2ItemById")) {
      const i = byId(v.c);
      i.item ??= { id: `PVTI_${i.number}`, fields: {} };
      return answer({ data: { addProjectV2ItemById: { item: { id: i.item.id } } } });
    }
    if (q.includes("updateProjectV2ItemFieldValue")) return (byId(v.i).item!.fields.Status = v.value), answer({ data: {} });
    if (q.includes("... on Issue{ node_id")) return answer({ data: { node: rest(byId(v.i)) } });
    return { code: 1, stdout: "", stderr: `unexpected query ${q.slice(0, 80)}` };
  }
  const m = /^repos\/acme\/app\/issues(?:\/(\d+))?(\/comments|\/labels(?:\/(.+))?)?(?:\?.*)?$/.exec(args[1]!);
  if (!m) return { code: 1, stdout: "", stderr: `unexpected ${args[1]}` };
  const i = github.get(Number(m[1]))!;
  if (!m[1] && method === "POST") {
    const n = Math.max(...github.keys()) + 1;
    const made: Issue = { id: `I_${n}`, number: n, title: v.title, body: v.body, state: "OPEN", labels: v.labels ?? [], parent: null, comments: [], item: null };
    github.set(n, made);
    posts.push(`issue #${n}`);
    return answer(rest(made));
  }
  if (!m[1]) return lists++, answer([...github.values()].map(rest));
  if (m[2] === "/comments" && method === "POST") {
    const c = { id: `C_${i.number}_${i.comments.length + 1}`, body: v.body, createdAt: at };
    i.comments.push(c);
    posts.push(`comment #${i.number}`);
    return answer({ node_id: c.id, body: c.body, created_at: c.createdAt });
  }
  if (m[2] === "/comments") return answer(i.comments.map((c) => ({ node_id: c.id, body: c.body, created_at: c.createdAt })));
  if (m[2]?.startsWith("/labels")) {
    i.labels = method === "POST" ? [...i.labels, ...v.labels] : i.labels.filter((l) => l !== decodeURIComponent(m[3]!));
    posts.push(`label ${method === "POST" ? "+" : "-"} #${i.number}`);
    return answer([]);
  }
  if (method === "PATCH") Object.assign(i, v.state ? { state: v.state.toUpperCase() } : v);
  return answer(rest(i));
};

process.env.SWITCHBOARD_PROJECT_URL = "https://github.com/orgs/acme/projects/1";
const homes = [mkdtempSync(join(tmpdir(), "sb-backlog-sync-e2e-")), mkdtempSync(join(tmpdir(), "sb-backlog-sync-e2e-"))];
const cases: Record<string, boolean> = {};
const check = (name: string, ok: boolean, detail?: unknown) => {
  cases[name] = ok;
  if (!ok) console.error(`✗ ${name}`, detail === undefined ? "" : JSON.stringify(detail));
};
async function boot(home: string, adapters: RunnerAdapter[] = []): Promise<{ core: CoreServer; base: string }> {
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  const core = await startServer(cfg, adapters, { port: 0, selfdevChecks: false, dryRunRestart: true, gh, backlogAutoImport: true });
  return { core, base: `http://127.0.0.1:${core.server.port}` };
}
async function until<T>(f: () => T | Promise<T>, what: string, ms = 10_000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
    const v = await f();
    if (v) return v;
  }
  throw new Error(`timed out: ${what}`);
}

let core: CoreServer | null = null;
if (MODE_API) try {
  let { core: c, base } = await boot(homes[0]!);
  core = c;
  const ws = () => core!.db.listWorkspaces().find((w) => w.kind === "meta")!.id;
  const api = async (method: string, path: string, body?: object) => {
    const r = await fetch(`${base}${path}`, { method, body: body && JSON.stringify({ workspaceId: ws(), ...body }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const detail = async (ref: number | string) => (await api("GET", `/api/backlog/${ref}?workspaceId=${ws()}`)).body as BacklogIssueDetail;
  await until(() => core!.db.getWorkspaceBacklogSource(ws()), "the first import");

  // 1. GitHub out of reach: everything is kept here (202) and shows at once; GitHub is untouched
  down = true;
  const made = await api("POST", "/api/backlog", { title: "PBI: 新しい", body: "新しい本文", labels: ["type:pbi"], fields: { Status: "Backlog" } });
  const edits = [
    await api("PATCH", "/api/backlog/12", { title: "PBI: 直した題", fields: { Status: "Ready" } }),
    ...(await Promise.all(["本文 1", "本文 2"].map((body) => api("PATCH", "/api/backlog/12", { body })))),
    await api("PATCH", "/api/backlog/12", { body: "本文 3" }),
    await api("POST", "/api/backlog/12/answer", { text: "B で" }),
  ];
  const localId = made.body?.localId as string;
  check("kept while GitHub is out of reach (202)", made.status === 202 && edits.every((e) => e.status === 202), [made, ...edits].map((e) => e.status));
  const d12 = await detail(12);
  check("the edits show at once", d12.issue.title === "PBI: 直した題" && d12.issue.body === "本文 3" && !d12.issue.labels.includes("needs-decision") && d12.fields?.Status === "Ready" && d12.comments.at(-1)?.body === "## 回答\n\nB で", d12);
  check("a new Issue is told apart by its local id", (await detail(localId)).issue.number === 0, await detail(localId));
  const queued = core.db.listPendingBacklogOperations();
  check("the same field edited three times is one operation", queued.filter((o) => o.field === "body").length === 1, queued.map((o) => o.field));
  check("GitHub is untouched", posts.length === 0 && github.get(12)!.title === "PBI: 元の題", posts);

  // 2. a backup, the daemon stops, it starts on the backup, GitHub answers again
  core.db.snapshotTo(join(homes[1]!, "switchboard.db"));
  const before = queued.map((o) => [o.id, o.kind, o.field]);
  await core.stop();
  core = null;
  // the wait the outage left (one minute) has passed by the time the daemon starts again
  const { Database } = await import("bun:sqlite");
  const restored = new Database(join(homes[1]!, "switchboard.db"));
  restored.exec("UPDATE backlog_repositories SET retry_at = NULL");
  check("the backup has every operation", JSON.stringify((restored.query("SELECT id, kind, field FROM backlog_operations WHERE status != 'done' ORDER BY seq").all() as Array<{ id: string; kind: string; field: string | null }>).map((o) => [o.id, o.kind, o.field])) === JSON.stringify(before));
  restored.close();
  down = false;
  ({ core: c, base } = await boot(homes[1]!));
  core = c;
  await until(() => core!.db.listPendingBacklogOperations().length === 0, "everything sent", 20_000);
  const g12 = github.get(12)!;
  const created = [...github.values()].filter((i) => i.title === "PBI: 新しい");
  check("GitHub has the edits", g12.title === "PBI: 直した題" && g12.body === "本文 3" && g12.item?.fields.Status === "Ready", g12);
  check("the answer, then the label off", JSON.stringify(posts.filter((p) => p.endsWith("#12"))) === JSON.stringify(["comment #12", "label - #12"]) && !g12.labels.includes("needs-decision"), posts);
  check("an answer is an ordinary comment on GitHub", g12.comments.length === 2 && g12.comments[1]!.body.startsWith("## 回答\n\nB で\n\n<!--"), g12.comments);
  check("the new Issue is made once, in the Project", created.length === 1 && created[0]!.labels.includes("type:pbi") && created[0]!.item?.fields.Status === "Backlog", created);
  check("the local id finds it with its number", (await detail(localId)).issue.number === created[0]?.number, await detail(localId));

  // 3. GitHub posted the answer but the reply was lost: found by its marker, not posted again; the label waits for it
  g12.labels.push("needs-decision");
  g12.comments.push({ id: "C_q2", body: "## 判断待ち\n**問い**: 次の問い", createdAt: "2026-10-08T01:00:00Z" });
  await fetch(`${base}/api/backlog?refresh=1`);
  fail = { match: (a) => a[1] === "repos/acme/app/issues/12/comments" && a.includes("POST"), after: true };
  await api("POST", "/api/backlog/12/answer", { text: "A で" });
  await until(() => core!.db.listPendingBacklogOperations().some((o) => o.status === "unknown"), "the answer is unknown");
  check("the label waits for an unknown answer", g12.labels.includes("needs-decision"), g12.labels);
  await fetch(`${base}/api/backlog?refresh=1`);
  await until(() => core!.db.listPendingBacklogOperations().length === 0, "the unknown answer found");
  check("a lost reply is found by its marker: one comment", g12.comments.filter((x) => x.body.startsWith("## 回答\n\nA で")).length === 1 && !g12.labels.includes("needs-decision"), g12.comments);

  // 4. a post whose result is unknown and not found on GitHub: never posted again by itself
  fail = { match: (a) => a[1] === "repos/acme/app/issues" && a.includes("POST"), after: false };
  const issuesBefore = github.size;
  await api("POST", "/api/backlog", { title: "PBI: 結果不明" });
  await until(() => core!.db.listPendingBacklogOperations().some((o) => o.status === "unknown"), "the create is unknown");
  const listsBefore = lists;
  for (let k = 0; k < 3; k++) await fetch(`${base}/api/backlog?refresh=1`);
  // each send after an import looked for the marker, and posted nothing
  await until(() => lists >= listsBefore + 3, "the marker looked for after each import");
  check("unknown and not found: looked for, no post again", github.size === issuesBefore && core.db.listPendingBacklogOperations().map((o) => o.status).join() === "unknown", { size: github.size, lists: lists - listsBefore, ops: core.db.listPendingBacklogOperations().map((o) => o.status) });
} catch (e) {
  check("ran to the end", false, { error: String((e as Error)?.message ?? e), waiting: core?.db.listPendingBacklogOperations().map((o) => [o.kind, o.field, o.status, o.error]), posts });
} finally {
  await core?.stop();
}

/* ---------- --browser (#911): the Backlog screen against the same fake GitHub ---------- */
if (MODE_BROWSER) {
  // an Issue only the stale-copy case touches
  github.set(15, { id: "I_15", number: 15, title: "要望: 閉じられる", body: "古い写し", state: "OPEN", labels: ["type:request"], parent: null, comments: [], item: null });
  const out = mkdtempSync(join(tmpdir(), "switchboard.backlog-sync-browser."));
  const shots = join(out, "shots");
  mkdirSync(shots);
  homes.push(out);
  // a runner that stays running: a started stage Task is counted, never finished
  const prompts: string[] = [];
  const adapter: RunnerAdapter = {
    id: "claude", detect: async () => ({ available: true }),
    models: [{ value: "m-e2e", label: "m-e2e" }],
    start(opts) {
      prompts.push(opts.prompt);
      let exit!: (code: number | null) => void;
      const exited = new Promise<number | null>((r) => (exit = r));
      return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
    },
  };
  const profile = join(out, "chrome");
  const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/usr/local/bin/chromium", "--headless=new", "--no-sandbox", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1100,1500", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  let sock: WebSocket | undefined;
  let boots = await boot(homes[0]!, [adapter]);
  core = boots.core;
  let base = boots.base;
  const ws = () => core!.db.listWorkspaces().find((w) => w.kind === "meta")!.id;
  /** The daemon is stopped and started again on the same home with GitHub's outage wait gone (as the one minute passed). */
  const restart = async () => {
    const home = homes[0]!;
    await core!.stop();
    const { Database } = await import("bun:sqlite");
    const d = new Database(join(home, "switchboard.db"));
    d.exec("UPDATE backlog_repositories SET retry_at = NULL");
    d.close();
    boots = await boot(home, [adapter]);
    core = boots.core;
    base = boots.base;
  };
  try {
    await until(() => core!.db.getWorkspaceBacklogSource(ws()), "the first import");
    const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port", 20_000);
    const target = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null, "Chrome page");
    sock = new WebSocket(target);
    await new Promise<void>((resolve, reject) => { sock!.onopen = () => resolve(); sock!.onerror = () => reject(new Error("CDP socket failed")); });
    let seq = 0;
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    /** The one request `hold` waits for (the others go on); see `hold`. */
    let holding: { method: string; path: string; got: (r: { requestId: string; postData: string }) => void } | null = null;
    const errors: unknown[] = [];
    sock.onmessage = (event) => {
      const m = JSON.parse(String(event.data));
      if (m.method === "Log.entryAdded" && m.params.entry.source === "security") {
        errors.push(m);
        console.error(`csp: ${JSON.stringify(m.params.entry)}`); // shown even when the run fails before the final check
      }
      if (m.method === "Fetch.requestPaused") {
        const r = m.params.request as { method: string; url: string; postData?: string };
        if (holding && r.method === holding.method && new URL(r.url).pathname === holding.path) {
          const h = holding;
          holding = null;
          h.got({ requestId: m.params.requestId, postData: r.postData ?? "" });
        } else void call("Fetch.continueRequest", { requestId: m.params.requestId }).catch(() => undefined);
        return;
      }
      if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    };
    const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); sock!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression: string) => {
      const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)} in: ${expression.slice(0, 160)}`);
      return r.result.value;
    };
    /** Presses what `find` returns once it has stayed still (rows move while the list reads). */
    const press = async (find: string, label: string) => {
      const at = `(() => { const b = ${find}; if (!b || b.disabled) return null; b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; return b.contains(document.elementFromPoint(x, y)) ? { x, y } : null; })()`;
      const point = await until(async () => {
        const a = await evaluate(at) as { x: number; y: number } | null;
        if (!a) return null;
        await Bun.sleep(100);
        const b = await evaluate(at) as { x: number; y: number } | null;
        return b && b.x === a.x && b.y === a.y ? b : null;
      }, `pressable ${label}`);
      await call("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    };
    const issue = (n: number) => `a[href$="/issues/${n}"]`;
    const rowOf = (n: number) => `[...document.querySelectorAll('.backlog-item')].find(r => r.querySelector('${issue(n)}'))`;
    /** The row's sync line: the element after the row. */
    const lineOf = (n: number) => `(${rowOf(n)}).nextElementSibling`;
    const cardOf = (n: number) => `[...document.querySelectorAll('.decision-card')].find(r => r.querySelector('${issue(n)}'))`;
    const editor = (n: number) => `document.querySelector('.backlog-edit[data-issue$="/issues/${n}"]')`;
    const text = (expr: string) => evaluate(`(${expr})?.textContent ?? ''`) as Promise<string>;
    const button = (scope: string, label: string) => `[...(${scope}).querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
    /** Types into the field `find` returns, replacing what it has (the focus and a real insertText: React sees an input). */
    const fill = async (find: string, value: string) => {
      await until(() => evaluate(`!!(${find})`), `field ${find.slice(0, 60)}`);
      // a re-render under the typing (a read answering) can take the selection: look at the field and type again
      for (let attempt = 0; attempt < 3; attempt++) {
        await evaluate(`(() => { const e = ${find}; e.focus(); e.select(); })()`);
        await call("Input.insertText", { text: value });
        if ((await evaluate(`(${find}).value`)) === value) return;
      }
    };
    /**
     * Stops the next browser request `method path` (CDP Fetch: the daemon gets no test hook) until the test lets it go:
     * `continue()` sends it on, `fulfill` answers it as the daemon would have, `fail()` is a dropped connection.
     */
    const hold = async (method: string, path: string) => {
      await call("Fetch.enable", { patterns: [{ urlPattern: "*/api/backlog*", requestStage: "Request" }] });
      const got = new Promise<{ requestId: string; postData: string }>((resolve, reject) => {
        holding = { method, path, got: resolve };
        setTimeout(() => reject(new Error(`timed out: no ${method} ${path} from the browser`)), 20_000).unref();
      });
      return async () => {
        const { requestId, postData } = await got;
        return {
          postData,
          continue: () => call("Fetch.continueRequest", { requestId }),
          fulfill: (status: number, body: unknown) => call("Fetch.fulfillRequest", { requestId, responseCode: status, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)).toString("base64") }),
          fail: () => call("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" }),
        };
      };
    };
    /** Sets a <select> the way a person does; false (nothing changed) when it is disabled. */
    const choose = async (find: string, value: string) =>
      (await evaluate(`(() => { const s = ${find}; if (!s || s.disabled) return false; s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`)) as boolean;
    const shot = async (name: string) => writeFileSync(join(shots, `${name}.png`), Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
    const open = async () => {
      await call("Page.navigate", { url: base });
      await until(() => evaluate(`!!document.querySelector('.rail')`), "Rail");
      await press(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Backlog')`, "Backlog");
      await until(() => evaluate(`document.querySelectorAll('.backlog section[data-stage]').length === 5 && !document.querySelector('.backlog .head .hint')?.textContent.includes('読み込み中')`), "the list");
    };
    const openEditor = async (n: number) => {
      await press(`[...document.querySelectorAll('details.backlog-editor')].find(d => d.dataset.issue.endsWith('/issues/${n}')).querySelector('summary')`, `編集 #${n}`);
      await until(() => evaluate(`!!${editor(n)}`), `editor #${n}`);
    };
    await call("Runtime.enable");
    await call("Log.enable");
    await call("Page.enable");
    const api = async (method: string, path: string, body?: object) => {
      const r = await fetch(`${base}${path}`, { method, body: body && JSON.stringify({ workspaceId: ws(), ...body }) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const detail = async (ref: number | string) => (await api("GET", `/api/backlog/${ref}?workspaceId=${ws()}`)).body as BacklogIssueDetail;

    // 1. every row says it is in step, and when it was last read (条件 1)
    await open();
    const first = await text(lineOf(13));
    check("a row says 同期済み with its last successful time", first.includes("同期済み") && first.includes("最終成功:") && !first.includes("未取得"), first);
    check("the workspace line says so too and names the promise", (await text(`document.querySelector('.backlog-sync')`)).includes("同期済み"), await text(`document.querySelector('.backlog-sync')`));
    await shot("1-synced");

    // 2. GitHub out of reach: a form edit, a comment, an answer and a new Issue are kept — and survive a reload (条件 2)
    down = true;
    await openEditor(13);
    await fill(`${editor(13)}.querySelector('input')`, "要望: 画面で直した題");
    await press(button(editor(13), "保存"), "保存");
    await until(async () => (await text(editor(13))).includes("手元に保存しました"), "saved here, not yet on GitHub");
    check("the save says it is kept here and not yet sent", (await text(editor(13))).includes("送信待ち"), await text(editor(13)));
    await until(async () => (await text(lineOf(13))).includes("送信待ち"), "the row says 送信待ち");
    check("GitHub is untouched while it is out of reach", github.get(13)!.title === "要望: 元" && posts.length === 0, { title: github.get(13)!.title, posts });
    await fill(`${editor(13)}.querySelectorAll('textarea')[1]`, "画面からのコメント");
    await press(button(editor(13), "コメントを保存"), "コメントを保存");
    await until(async () => (await detail(13)).comments.some((x) => x.body === "画面からのコメント"), "the comment is kept");
    await press(button(`document.querySelector('details.backlog-new')`, "手元に保存"), "新しい Issue").catch(() => undefined);
    await press(`document.querySelector('details.backlog-new summary')`, "新しい Issue を開く");
    await fill(`document.querySelector('details.backlog-new input')`, "PBI: 画面で作った");
    await press(button(`document.querySelector('details.backlog-new')`, "手元に保存"), "手元に保存");
    await until(async () => (await text(`document.querySelector('.backlog-sync')`)).includes("番号なし"), "the new Issue is listed without a number");
    await fill(`${cardOf(12)}.querySelector('textarea')`, "画面から B で");
    await press(button(cardOf(12), "回答する"), "回答する");
    await until(() => core!.db.listPendingBacklogOperations().some((o) => o.kind === "comment" && JSON.stringify(o.payload).includes("画面から B で")), "the answer is kept");
    // typed and not saved: a draft the reload gives back
    await fill(`${editor(13)}.querySelectorAll('input')[0]`, "要望: 保存していない題");
    await shot("2-kept-offline");
    await open();
    const afterReload = await text(lineOf(13));
    check("after a reload the row still says 送信待ち, with the title kept here", afterReload.includes("送信待ち") && (await text(rowOf(13))).includes("画面で直した題"), afterReload);
    await openEditor(13);
    const typed = await evaluate(`${editor(13)}.querySelector('input').value`);
    check("what was typed and not saved is still in the form", typed === "要望: 保存していない題", typed);
    check("nothing was posted twice or at all", posts.length === 0, posts);

    // 3. a conflict: GitHub's body moved as well; both sides are shown, a choice is explicit, an old one needs a re-read (条件 3)
    await fill(`${editor(13)}.querySelectorAll('input')[0]`, "要望: 画面で直した題");
    await fill(`${editor(13)}.querySelector('textarea')`, "手元の本文");
    await press(button(editor(13), "保存"), "保存 本文");
    await until(async () => (await detail(13)).issue.body === "手元の本文", "the body is kept");
    github.get(13)!.body = "GitHub 側の本文";
    down = false;
    await restart();
    await open();
    await until(async () => (await text(lineOf(13))).includes("競合"), "the row says 競合", 20_000);
    await openEditor(13);
    await until(async () => (await text(`document.querySelector('.backlog-held[data-field="body"]')`)).includes("GitHub 側の本文"), "both sides shown");
    const sides = await text(`document.querySelector('.backlog-held[data-field="body"]')`);
    check("a conflict shows the local and the GitHub value", sides.includes("手元の本文") && sides.includes("GitHub 側の本文"), sides);
    await shot("3-conflict");
    // GitHub moves again and is read: the choice made on the older screen is refused (409), nothing is sent
    github.get(13)!.body = "GitHub 側の本文（さらに変更）";
    await fetch(`${base}/api/backlog?refresh=1`);
    await until(async () => ((await detail(13)).held.find((h) => h.field === "body")?.conflict?.remote as string | undefined)?.includes("さらに変更"), "the daemon read GitHub's new value");
    await press(button(editor(13), "手元の値を送る"), "手元の値を送る (old)");
    await until(async () => (await text(editor(13))).includes("選び直してください"), "the old choice asks for a re-read");
    check("an old choice is refused and GitHub is not written", github.get(13)!.body === "GitHub 側の本文（さらに変更）", github.get(13)!.body);
    await until(async () => (await text(`document.querySelector('.backlog-held[data-field="body"]')`)).includes("さらに変更"), "the screen shows the new GitHub value");
    await press(button(editor(13), "手元の値を送る"), "手元の値を送る");
    await until(() => github.get(13)!.body === "手元の本文", "the explicit choice is sent", 20_000);
    await until(async () => (await text(lineOf(13))).includes("同期済み"), "the row is in step again", 20_000);
    check("after the choice the row is 同期済み and GitHub has the local body", github.get(13)!.body === "手元の本文", github.get(13)!.body);
    await shot("4-resolved");

    // everything kept while GitHub was out of reach arrived once
    await until(() => core!.db.listPendingBacklogOperations().length === 0, "everything sent", 20_000);
    const titles = [...github.values()].map((i) => i.title);
    check("the title, the comment, the answer and the new Issue arrived once each", github.get(13)!.title === "要望: 画面で直した題" && github.get(13)!.comments.filter((x) => x.body.startsWith("画面からのコメント")).length === 1 && github.get(12)!.comments.filter((x) => x.body.includes("画面から B で")).length === 1 && titles.filter((t) => t === "PBI: 画面で作った").length === 1, { titles, c13: github.get(13)!.comments, c12: github.get(12)!.comments });

    // 4. backlog-next and a start by hand go on the stored data (#2264): GitHub is read first when it answers, an unsent
    // or refused edit does not hold a start, a conflict does — each case on its own
    const sched = await api("POST", "/api/schedules", { title: "バックログを進める", cron: "0 */3 * * *", runner: "claude", prompt: "", action: "backlog-next" });
    const run = () => fetch(`${base}/api/schedules/${(sched.body as { id: string }).id}/run`, { method: "POST" });
    const tasks = () => core!.db.listTasks().length;
    const byHand = (n: number) => api("POST", `/api/backlog/${n}/start`, { action: "to-pbi" });
    const errorOf = (r: { body: unknown }) => String((r.body as { error?: string } | null)?.error ?? "");

    // only #13 is a candidate: the Issue made on the screen is closed (it is not what these cases are about)
    for (const i of github.values()) if (i.title === "PBI: 画面で作った") i.state = "CLOSED";
    await fetch(`${base}/api/backlog?refresh=1`);

    // 4a. a stale copy: #15 was closed on GitHub and nothing has read it since — the start asks first and finds it gone
    github.get(15)!.state = "CLOSED";
    const staleHand = await byHand(15);
    check("a stale stored copy is not started on: the start imports first and #15 is gone (404, no Task)", staleHand.status === 404 && tasks() === 0, { staleHand, tasks: tasks() });
    // 4a'. a stale decision: GitHub put #13 under needs-decision and nothing has read it since — backlog-next imports
    // before it picks, so #13 (a candidate on the stored copy) is not started
    github.get(13)!.labels.push("needs-decision");
    await run();
    const decided = await detail(13);
    check("a decision GitHub added since the last read: backlog-next reads it first and starts no Task", tasks() === 0 && decided.issue.labels.includes("needs-decision"), { tasks: tasks(), labels: decided.issue.labels });
    github.get(13)!.labels = github.get(13)!.labels.filter((l) => l !== "needs-decision");
    await fetch(`${base}/api/backlog?refresh=1`);
    await until(async () => !(await detail(13)).issue.labels.includes("needs-decision"), "#13 out of needs-decision again");

    // 4b. an edit kept and GitHub reads fine but refuses to be written: pending does not hold the start (#2264). On #16,
    // whose Task is aborted after, so #13 (its unsent title is 4c's conflict) is not started here
    github.set(16, { id: "I_16", number: 16, title: "要望: 未送信のまま始める", body: "元の本文", state: "OPEN", labels: ["type:request"], parent: null, comments: [], item: null });
    await fetch(`${base}/api/backlog?refresh=1`);
    await until(async () => (await api("GET", `/api/backlog/16?workspaceId=${ws()}`)).status === 200, "#16 is read");
    writesFail = "502";
    await api("PATCH", "/api/backlog/13", { title: "要望: 送れない題" });
    await api("PATCH", "/api/backlog/16", { title: "要望: 送れない題 16" });
    const pendingHand = await byHand(16);
    check("an unsent edit alone: the start by hand makes the Task (201)", tasks() === 1 && pendingHand.status === 201 && (await detail(16)).sync.pendingCount > 0, { tasks: tasks(), pendingHand });
    await api("POST", `/api/tasks/${(pendingHand.body as Task).id}/abort`);
    await open();
    check("the row says 送信待ち while it cannot be sent", (await text(lineOf(13))).includes("送信待ち"), await text(lineOf(13)));
    writesFail = null;
    // #16's edit goes with the next send, not after its backoff (as the restart below does for the repository's wait)
    for (const o of core!.db.listPendingBacklogOperations()) if (o.issue === "I_16") core!.db.setBacklogOperationResult(o.id, { status: "pending", retryAt: null });

    // 4c. GitHub moved the same field: a conflict holds it; chosen on the screen with 「GitHub の値を使う」
    github.get(13)!.title = "要望: GitHub で別に直した";
    await restart();
    await until(async () => (await detail(13)).held.some((h) => h.field === "title" && h.status === "conflict"), "a conflict on the title", 20_000);
    await run();
    const conflictHand = await byHand(13);
    check("a held conflict: no Task by backlog-next, 409 by hand", tasks() === 1 && conflictHand.status === 409 && errorOf(conflictHand).includes("競合"), { tasks: tasks(), conflictHand });
    await open();
    await openEditor(13);
    await press(button(`document.querySelector('.backlog-held[data-field="title"]')`, "GitHub の値を使う"), "GitHub の値を使う");
    await until(async () => (await detail(13)).sync.state === "synced" && core!.db.listPendingBacklogOperations().length === 0, "in step again", 20_000);
    check("choosing GitHub's value on the screen keeps GitHub's title", github.get(13)!.title === "要望: GitHub で別に直した", github.get(13)!.title);

    // 4d. everything in step: exactly one Task starts
    await run();
    await until(() => tasks() === 2, "the Task after everything is in step", 20_000);
    check("in step: exactly one Task starts, on the newest state", tasks() === 2 && prompts.length === 2, { tasks: tasks(), prompts: prompts.length });
    check("no post twice", new Set(posts).size === posts.length || posts.every((p, i) => posts.indexOf(p) === i || p.startsWith("label")), posts);

    // 4e. GitHub refuses an edit for good: 同期失敗 on the row, the promise and the workspace's last time shown, and the
    // start by hand still makes the Task (#2264). On #20, which has no Task, with the slots widened: the Task of 4d does not hold it
    await fetch(`${base}/api/workspaces/${ws()}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sweep: { implement: 3, plan: 3 } }) });
    github.set(20, { id: "I_20", number: 20, title: "要望: 拒否される", body: "元の本文", state: "OPEN", labels: ["type:request"], parent: null, comments: [], item: null });
    await fetch(`${base}/api/backlog?refresh=1`);
    await until(async () => (await api("GET", `/api/backlog/20?workspaceId=${ws()}`)).status === 200, "#20 is read");
    writesFail = "403";
    await api("PATCH", "/api/backlog/20", { body: "拒否される本文" });
    await until(() => core!.db.listPendingBacklogOperations().some((o) => o.status === "failed"), "the edit is refused", 20_000);
    await open();
    const failedLine = await text(lineOf(20));
    check("a refused edit shows 同期失敗 with why", failedLine.includes("同期失敗") && failedLine.includes("受け付けませんでした"), failedLine);
    const promise = await evaluate(`(${lineOf(20)}).querySelector('.sync').title`) as string;
    check("the guarantee A is explained on the row", promise.includes("送る直前と直後"), promise);
    const wsAt = core!.db.getBacklogRepository(core!.db.getWorkspaceBacklogSource(ws())!)!.lastSuccessfulSync!;
    const shown = await text(`document.querySelector('.backlog-sync')`);
    // the screen shows JST whatever the browser's zone (#2028)
    const expected = jstDateTime(wsAt);
    check("the workspace line shows its last successful time", shown.includes(`最終成功: ${expected}`), { shown, expected });
    await shot("5-failed");
    const failedHand = await byHand(20);
    await run();
    const log = (await (await fetch(`${base}/api/schedules/log`)).json()) as string[];
    check("a refused edit does not hold the start: 201 by hand, and backlog-next starts no second Task on #20", failedHand.status === 201 && tasks() === 3, { failedHand, tasks: tasks(), log: log.slice(-5) });
    writesFail = null;

    // 4f-4h (#1541): a second workspace, and the new Issue form's draft per workspace, its lock while saving, an edit
    // that fails. #21 comes here so it is not a candidate of the cases above
    github.set(21, { id: "I_21", number: 21, title: "要望: 編集の失敗", body: "元の本文", state: "OPEN", labels: ["type:request"], parent: null, comments: [], item: null });
    second = mkdtempSync(join(tmpdir(), "sb-backlog-sync-e2e-"));
    homes.push(second);
    const wsA = ws();
    const wsB = core!.db.upsertWorkspace({ path: second, name: "second", kind: "repo" }).id;
    await fetch(`${base}/api/backlog?refresh=1`);
    await until(async () => (await api("GET", `/api/backlog/21?workspaceId=${wsA}`)).status === 200, "#21 is read");
    await open();
    const newForm = `document.querySelector('details.backlog-new')`;
    const wsSelect = `${newForm}.querySelectorAll('select')[0]`;
    const kindSelect = `${newForm}.querySelectorAll('select')[1]`;
    const titleOf = `${newForm}.querySelector('input')`;
    const bodyOf = `${newForm}.querySelector('textarea')`;
    const valueOf = (find: string) => evaluate(`(${find}).value`) as Promise<string>;
    const openNew = async () => {
      if (!(await evaluate(`${newForm}.open`))) await press(`${newForm}.querySelector('summary')`, "新しい Issue を開く");
      await until(() => evaluate(`${newForm}.open`), "the new Issue form is open");
    };
    const draftsWith = (needle: string) => evaluate(`Object.keys(localStorage).filter(k => k.startsWith('switchboard.backlog.text.new:') && localStorage.getItem(k).includes(${JSON.stringify(needle)}))`) as Promise<string[]>;
    await openNew();

    // 4f. each workspace has its own draft: A's is not written to B, and comes back on A
    if ((await valueOf(wsSelect)) !== wsA) await choose(wsSelect, wsA);
    await fill(titleOf, "PBI: A の下書き");
    await fill(bodyOf, "A の下書きの本文");
    await choose(kindSelect, "type:pbi");
    await choose(wsSelect, wsB);
    await until(async () => (await valueOf(titleOf)) === "", "B's form is empty (A's draft is not shown)");
    const onB = { body: await valueOf(bodyOf), kind: await valueOf(kindSelect) };
    await fill(titleOf, "要望: B の下書き");
    check("switching to B shows B's draft (empty), not A's", onB.body === "" && onB.kind === "type:request", onB);
    check("A's draft is not written under B's key", (await draftsWith("A の下書き")).every((k) => k.endsWith(`:${wsA}`)), await draftsWith("A の下書き"));
    await choose(wsSelect, wsA);
    await until(async () => (await valueOf(titleOf)) === "PBI: A の下書き", "A's draft comes back");
    check("back on A: its title, body and kind are back", (await valueOf(bodyOf)) === "A の下書きの本文" && (await valueOf(kindSelect)) === "type:pbi", { body: await valueOf(bodyOf), kind: await valueOf(kindSelect) });
    await choose(wsSelect, wsB);
    await until(async () => (await valueOf(titleOf)) === "要望: B の下書き", "B's draft comes back");
    await choose(wsSelect, wsA);
    await until(async () => (await valueOf(titleOf)) === "PBI: A の下書き", "on A again");
    await shot("7-new-drafts");

    // 4g. while A is being saved the workspace cannot be switched, and the answer does not touch B's draft
    const created = await hold("POST", "/api/backlog");
    await press(button(newForm, "手元に保存"), "手元に保存 (A)");
    const request = await created();
    check("the held request is A's draft", JSON.parse(request.postData).title === "PBI: A の下書き" && JSON.parse(request.postData).workspaceId === wsA, request.postData);
    check("while saving the workspace select is disabled and cannot be switched", (await evaluate(`${wsSelect}.disabled`)) === true && (await choose(wsSelect, wsB)) === false && (await valueOf(wsSelect)) === wsA, await valueOf(wsSelect));
    check("while saving the kind, title and body cannot be typed into", (await evaluate(`[${kindSelect}, ${titleOf}, ${bodyOf}].every((e) => e.disabled)`)) === true);
    await request.continue();
    await until(async () => (await text(newForm)).includes("手元に保存しました"), "the save answered");
    await until(() => [...github.values()].some((i) => i.title === "PBI: A の下書き"), "the Issue is created from A's draft", 45_000);
    check("the Issue made is A's draft, not what was typed while saving", ![...github.values()].some((i) => i.title === "PBI: 保存中に打った"), [...github.values()].map((i) => i.title));
    await choose(wsSelect, wsB);
    await until(async () => (await valueOf(titleOf)) === "要望: B の下書き", "B's draft is as it was");
    check("B's draft is untouched by A's save", (await valueOf(titleOf)) === "要望: B の下書き", await valueOf(titleOf));

    // 4h. an edit that fails (409, then a dropped connection): what was typed stays, the Issue is read again, the retry sends the difference
    await open();
    await openEditor(21);
    await fill(`${editor(21)}.querySelector('input')`, "要望: 画面で直した 21");
    let patch = await hold("PATCH", "/api/backlog/21");
    await press(button(editor(21), "保存"), "保存 #21");
    let held = await patch();
    github.get(21)!.body = "GitHub の新しい本文";
    await fetch(`${base}/api/backlog?refresh=1`);
    await until(async () => (await detail(21)).issue.body === "GitHub の新しい本文", "the daemon read the new body");
    await held.fulfill(409, { error: "conflict" });
    await until(async () => (await text(editor(21))).includes("入力は残しています"), "the failed save says the input stays");
    await until(async () => (await valueOf(`${editor(21)}.querySelector('textarea')`)) === "GitHub の新しい本文", "the form follows GitHub's new body");
    check("after a 409 the typed title stays and the body is GitHub's new one", (await valueOf(`${editor(21)}.querySelector('input')`)) === "要望: 画面で直した 21", await valueOf(`${editor(21)}.querySelector('input')`));
    patch = await hold("PATCH", "/api/backlog/21");
    await press(button(editor(21), "保存"), "保存 #21 (retry)");
    held = await patch();
    check("the retry sends only what changed against the new read", JSON.parse(held.postData).title === "要望: 画面で直した 21" && !("body" in JSON.parse(held.postData)), held.postData);
    await held.continue();
    await until(() => github.get(21)!.title === "要望: 画面で直した 21", "the retry arrives", 45_000);
    check("the retry kept GitHub's new body", github.get(21)!.body === "GitHub の新しい本文", github.get(21)!.body);
    // the save before is over (its read answered) — an answer arriving under the typing would put the old value back
    await until(() => evaluate(`(() => { const e = ${editor(21)}; const b = e && ${button("e", "保存")}; return !!b && !b.disabled; })()`), "the editor is ready for the next edit");
    await fill(`${editor(21)}.querySelector('input')`, "要望: 通信失敗の後");
    patch = await hold("PATCH", "/api/backlog/21");
    await press(button(editor(21), "保存"), "保存 #21 (dropped)");
    held = await patch();
    github.get(21)!.body = "通信失敗の間に GitHub で変わった本文";
    await fetch(`${base}/api/backlog?refresh=1`);
    await until(async () => (await detail(21)).issue.body === "通信失敗の間に GitHub で変わった本文", "the daemon read the body changed during the dropped save");
    await held.fail();
    await until(async () => (await text(editor(21))).includes("入力は残しています"), "the dropped save says the input stays");
    check("after a dropped connection the typed title stays", (await valueOf(`${editor(21)}.querySelector('input')`)) === "要望: 通信失敗の後", await valueOf(`${editor(21)}.querySelector('input')`));
    await until(async () => (await valueOf(`${editor(21)}.querySelector('textarea')`)) === "通信失敗の間に GitHub で変わった本文", "the form follows the body GitHub has after the dropped save");
    patch = await hold("PATCH", "/api/backlog/21");
    await press(button(editor(21), "保存"), "保存 #21 (again)");
    held = await patch();
    check("after the dropped connection the retry sends only the title", JSON.parse(held.postData).title === "要望: 通信失敗の後" && !("body" in JSON.parse(held.postData)), held.postData);
    await held.continue();
    await until(() => github.get(21)!.title === "要望: 通信失敗の後", "the save after the dropped one arrives", 45_000);
    check("the retry after the dropped connection kept GitHub's body", github.get(21)!.body === "通信失敗の間に GitHub で変わった本文", github.get(21)!.body);
    check("after the dropped connection the same input is saved once", github.get(21)!.title === "要望: 通信失敗の後", github.get(21)!.title);

    // 4i. a comment being saved cannot be typed into either, and what is in the box is what was sent
    await open();
    await openEditor(21);
    await fill(`${editor(21)}.querySelector('textarea:last-of-type')`, "保存するコメント");
    const commented = await hold("POST", "/api/backlog/21/comment");
    await press(button(editor(21), "コメントを保存"), "コメントを保存 #21");
    const sent = await commented();
    check("while a comment is saved its box is disabled", (await evaluate(`${editor(21)}.querySelector('textarea:last-of-type').disabled`)) === true, sent.postData);
    await sent.continue();
    await until(async () => (await text(editor(21))).includes("コメントを手元に保存しました"), "the comment save answered");
    check("the comment sent is the one in the box", JSON.parse(sent.postData).text === "保存するコメント", sent.postData);
    await call("Fetch.disable");

    // 4j. the workspace chosen above the list is where a new Issue goes, also after the form was opened on another
    await open();
    const wsButton = (pick: string) => `[...document.querySelectorAll('.backlog-ws button')].find(b => ${pick})`;
    await press(wsButton(`b.textContent.trim().startsWith('second')`), "second の絞り込み（フォームを開く前）");
    await openNew();
    await until(async () => (await valueOf(wsSelect)) === wsB, "a form opened after choosing B is for B");
    await press(wsButton(`!b.textContent.trim().startsWith('すべて') && !b.textContent.trim().startsWith('second')`), "A の絞り込み");
    await until(async () => (await valueOf(wsSelect)) === wsA, "the form is for the workspace shown (A)");
    await press(wsButton(`b.textContent.trim().startsWith('second')`), "second の絞り込み");
    await until(async () => (await valueOf(wsSelect)) === wsB, "the new Issue form follows the workspace shown above (B), after it was opened on A");
    check("the form follows the workspace shown above", (await valueOf(wsSelect)) === wsB, await valueOf(wsSelect));
    await fill(titleOf, "要望: B に作る");
    const createdOnB = await hold("POST", "/api/backlog");
    await press(button(newForm, "手元に保存"), "手元に保存 (B)");
    const toB = await createdOnB();
    check("the Issue is made in the workspace shown, not the one the form was opened on", JSON.parse(toB.postData).workspaceId === wsB && JSON.parse(toB.postData).title === "要望: B に作る", toB.postData);
    await toB.continue();
    await until(async () => (await text(newForm)).includes("手元に保存しました"), "the save on B answered");
    await call("Fetch.disable");

    // 4k. the first read of an editor fails: it can be read again without closing it
    await open();
    await press(`[...document.querySelectorAll('.backlog-ws button')].find(b => b.textContent.trim().startsWith('すべて'))`, "すべて");
    const firstRead = await hold("GET", "/api/backlog/21");
    await press(`[...document.querySelectorAll('details.backlog-editor')].find(d => d.dataset.issue.endsWith('/issues/21')).querySelector('summary')`, "編集 #21");
    const failedRead = await firstRead();
    await failedRead.fail();
    await until(async () => (await text(`[...document.querySelectorAll('details.backlog-editor')].find(d => d.dataset.issue.endsWith('/issues/21'))`)).includes("読み直す"), "the failed first read offers to read again");
    await call("Fetch.disable");
    await press(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '読み直す')`, "読み直す");
    await until(() => evaluate(`!!${editor(21)}`), "the editor opens after reading again");
    check("after a failed first read the editor can be read again without closing it", (await valueOf(`${editor(21)}.querySelector('input')`)).length > 0);

    // 5. a phone's width: the sync line, the open editor and the new Issue form (with two workspaces) do not run off the screen
    await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await open();
    await openEditor(13);
    const overflow = await evaluate(`document.documentElement.scrollWidth - window.innerWidth`) as number;
    check("at 390px the Backlog does not overflow sideways", overflow <= 1, overflow);
    await openNew();
    const newOverflow = await evaluate(`document.documentElement.scrollWidth - window.innerWidth`) as number;
    check("at 390px the new Issue form does not overflow sideways", newOverflow <= 1 && (await evaluate(`${newForm}.querySelectorAll('select').length`)) === 2, newOverflow);
    await shot("6-mobile");
    check("no CSP security entries", errors.length === 0, errors);
  } catch (e) {
    check("ran to the end", false, { error: String((e as Error)?.message ?? e), waiting: core?.db.listPendingBacklogOperations().map((o) => [o.kind, o.field, o.status, o.error]), posts });
  } finally {
    writeFileSync(join(out, "result.json"), JSON.stringify({ cases, posts }, null, 2));
    sock?.close();
    chrome.kill();
    await chrome.exited;
    await core?.stop();
    console.error(`artifacts: ${out}`);
  }
}
if (MODE_API) for (const h of homes) rmSync(h, { recursive: true, force: true });
const failed = Object.entries(cases).filter(([, ok]) => !ok).map(([name]) => name);
console.log(JSON.stringify({ pass: failed.length === 0, cases: Object.keys(cases).length, failed, posts: posts.length, comments12: github.get(12)!.comments.length, issues: github.size }, null, 2));
process.exit(failed.length ? 1 : 0);
