import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact, Task } from "@switchboard/protocol";
import { ArtifactStore, checkViewKey, MAX_ARTIFACT_DIR_FILES, MAX_ARTIFACT_FILE_BYTES, viewKey } from "./artifacts.ts";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

const mkTask = (id: string, cwd: string): Task => {
  const at = Date.now();
  return { id, workspaceId: null, title: "t", stage: null, runner: "claude", cwd, scope: [cwd], status: "done", runnerSessionId: null, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, statusAt: at, createdAt: at, updatedAt: at } as unknown as Task;
};
const j = (r: Response) => r.json() as Promise<any>;

let home: string;
let work: string;
let core: Awaited<ReturnType<typeof startServer>>;
let base: string;
let taskId: string;

const post = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const add = (source: string, title?: string) => post(`/api/tasks/${taskId}/artifacts`, { source, title });
const list = () => fetch(`${base}/api/tasks/${taskId}/artifacts`).then(j) as Promise<Artifact[]>;
const storeOf = (id: string) => join(home, "artifacts", taskId, id);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "switchboard-art-"));
  work = join(home, "work");
  mkdirSync(work);
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true });
  base = `http://127.0.0.1:${core.server.port}`;
  // A task row is all the store needs (no runner is started): the scope is its working copy.
  taskId = "tsk_art";
  core.db.insertTask(mkTask(taskId, work));
});

afterAll(async () => {
  await core.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("artifacts (#1777)", () => {
  test("register copies the file; deleting the original keeps it listed, and refresh then says 410 with the old copy intact", async () => {
    const f = join(work, "report.html");
    writeFileSync(f, "<h1>one</h1>");
    const r = await add(f);
    expect(r.status).toBe(201);
    const a: Artifact = await j(r);
    expect(a).toMatchObject({ taskId, title: "report.html", kind: "file", entry: "report.html", mime: "text/html", source: f });
    expect(readFileSync(join(storeOf(a.id), "report.html"), "utf8")).toBe("<h1>one</h1>");
    rmSync(f);
    expect((await list()).map((x) => x.id)).toEqual([a.id]);
    expect(readFileSync(join(storeOf(a.id), "report.html"), "utf8")).toBe("<h1>one</h1>");
    const again = await post(`/api/artifacts/${a.id}/refresh`);
    expect(again.status).toBe(410);
    expect(readFileSync(join(storeOf(a.id), "report.html"), "utf8")).toBe("<h1>one</h1>");
  });

  test("a relative path is read from the task's working directory; refresh picks up the new content; the same source twice is one artifact", async () => {
    writeFileSync(join(work, "notes.md"), "# v1");
    const a: Artifact = await j(await add("notes.md"));
    const dup: Artifact = await j(await add(join(work, "notes.md")));
    expect(dup.id).toBe(a.id);
    expect((await list()).filter((x) => x.title === "notes.md")).toHaveLength(1);
    writeFileSync(join(work, "notes.md"), "# v2 longer");
    const r = await post(`/api/artifacts/${a.id}/refresh`);
    expect(r.status).toBe(200);
    expect(readFileSync(join(storeOf(a.id), "notes.md"), "utf8")).toBe("# v2 longer");
    expect((await j(r)).size).toBe("# v2 longer".length);
  });

  test("a folder is copied whole (symlinks left out) and its page is index.html, else the only .html, else 400 naming the candidates", async () => {
    const d = join(work, "site");
    mkdirSync(join(d, "img"), { recursive: true });
    writeFileSync(join(d, "index.html"), '<img src="img/a.png">');
    writeFileSync(join(d, "img", "a.png"), "png");
    symlinkSync("/etc/hostname", join(d, "leak.txt"));
    const a: Artifact = await j(await add(d));
    expect(a).toMatchObject({ kind: "dir", entry: "index.html", title: "site" });
    expect(readFileSync(join(storeOf(a.id), "img", "a.png"), "utf8")).toBe("png");
    expect(existsSync(join(storeOf(a.id), "leak.txt"))).toBe(false);

    const one = join(work, "one");
    mkdirSync(one);
    writeFileSync(join(one, "report.html"), "x");
    expect((await j(await add(one))).entry).toBe("report.html");

    const two = join(work, "two");
    mkdirSync(two);
    writeFileSync(join(two, "a.html"), "x");
    writeFileSync(join(two, "b.html"), "x");
    const bad = await add(two);
    expect(bad.status).toBe(400);
    expect((await j(bad)).error).toContain("a.html, b.html");
  });

  test("outside the scope, `..`, and a symlink pointing out are 403; a URL is kept as is; other schemes are 400", async () => {
    expect((await add("/etc/hostname")).status).toBe(403);
    expect((await add("../../../../../../etc/hostname")).status).toBe(403);
    symlinkSync("/etc/hostname", join(work, "sneaky"));
    expect((await add(join(work, "sneaky"))).status).toBe(403);
    expect((await add(join(home, "token"))).status).toBe(403);
    expect((await add(join(home, "switchboard.db"))).status).toBe(403);
    expect((await add(home)).status).toBe(403); // a folder that holds them
    const u: Artifact = await j(await add("https://example.com/r/report.html"));
    expect(u).toMatchObject({ kind: "url", entry: null, title: "example.com/report.html" });
    expect(existsSync(storeOf(u.id))).toBe(false);
    expect((await post(`/api/artifacts/${u.id}/refresh`)).status).toBe(400);
    expect((await add("file:///etc/hostname")).status).toBe(400);
    expect((await add("nope/missing.html")).status).toBe(400);
    expect((await post("/api/tasks/tsk_none/artifacts", { source: "x" })).status).toBe(404);
  });

  test("one byte over the limit is 413 and leaves nothing in the store", async () => {
    const t2 = "tsk_big";
    core.db.insertTask(mkTask(t2, work));
    const big = join(work, "big.bin");
    writeFileSync(big, Buffer.alloc(MAX_ARTIFACT_FILE_BYTES + 1));
    const r = await post(`/api/tasks/${t2}/artifacts`, { source: big });
    expect(r.status).toBe(413);
    const dir = join(home, "artifacts", t2);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);

    const many = join(work, "many");
    mkdirSync(many);
    writeFileSync(join(many, "index.html"), "x");
    for (let i = 0; i < MAX_ARTIFACT_DIR_FILES; i++) writeFileSync(join(many, `f${i}.txt`), "x");
    expect((await post(`/api/tasks/${t2}/artifacts`, { source: many })).status).toBe(413);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    expect(await fetch(`${base}/api/tasks/${t2}/artifacts`).then(j)).toEqual([]);
  });

  test("a folder replaced by a file or the other way round keeps the new kind after a refresh", async () => {
    const p = join(work, "morph");
    writeFileSync(p, "a file");
    const a: Artifact = await j(await add(p));
    rmSync(p);
    mkdirSync(p);
    writeFileSync(join(p, "index.html"), "x");
    const r: Artifact = await j(await post(`/api/artifacts/${a.id}/refresh`));
    expect(r.kind).toBe("dir");
    expect((await list()).find((x) => x.id === a.id)).toMatchObject({ kind: "dir", entry: "index.html" });
  });

  test("a restart finishes a replacement that was cut off: the set-aside copy comes back, temp copies go", async () => {
    writeFileSync(join(work, "cut.txt"), "kept");
    const a: Artifact = await j(await add("cut.txt"));
    const taskDir = join(home, "artifacts", taskId);
    renameSync(join(taskDir, a.id), join(taskDir, `${a.id}.old`)); // the daemon stopped between the two renames
    mkdirSync(join(taskDir, ".tmp-half"));
    const { ArtifactStore } = await import("./artifacts.ts");
    new ArtifactStore(core.db, join(home, "artifacts"), { privateTmp: (id) => join(home, "tmp", id), deny: [], tmpRoots: [] });
    expect(readFileSync(join(taskDir, a.id, "cut.txt"), "utf8")).toBe("kept");
    expect(existsSync(join(taskDir, ".tmp-half"))).toBe(false);
    expect(existsSync(join(taskDir, `${a.id}.old`))).toBe(false);
  });

  test("remove hides it, restore brings it back with its copy, and the sweep deletes one removed a day ago", async () => {
    writeFileSync(join(work, "gone.txt"), "g");
    const a: Artifact = await j(await add("gone.txt"));
    expect((await fetch(`${base}/api/artifacts/${a.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await list()).some((x) => x.id === a.id)).toBe(false);
    expect(existsSync(join(storeOf(a.id), "gone.txt"))).toBe(true);
    const at = core.db.getArtifact(a.id)!.removedAt;
    await Bun.sleep(5);
    await fetch(`${base}/api/artifacts/${a.id}`, { method: "DELETE" }); // a second remove keeps the first time
    expect(core.db.getArtifact(a.id)!.removedAt).toBe(at);
    expect((await post(`/api/artifacts/${a.id}/restore`)).status).toBe(200);
    expect((await list()).some((x) => x.id === a.id)).toBe(true);
    await fetch(`${base}/api/artifacts/${a.id}`, { method: "DELETE" });
    expect(core.artifacts.sweep(Date.now())).toBe(0);
    expect(core.artifacts.sweep(Date.now() + 25 * 3600 * 1000)).toBe(1);
    expect(existsSync(storeOf(a.id))).toBe(false);
    expect(core.db.getArtifact(a.id)).toBeNull();
    expect((await post(`/api/artifacts/${a.id}/restore`)).status).toBe(404);
  });
});

describe("serving a report (#1782)", () => {
  const view = async (id: string): Promise<string> => (await j(await post(`/api/artifacts/${id}/view`))).url;
  const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

  /** fetch() tidies `..` away before sending; a hostile client does not, so write the request line as is. */
  async function rawGet(path: string): Promise<{ status: number; text: string }> {
    let text = "";
    const done = Promise.withResolvers<void>();
    const sock = await Bun.connect({ hostname: "127.0.0.1", port: core.server.port!, socket: { open: (s) => void s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`), data: (_s, d) => void (text += d.toString()), close: () => done.resolve(), error: () => done.resolve() } });
    await done.promise;
    sock.end();
    return { status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0), text };
  }

  async function site(): Promise<{ a: Artifact; url: string }> {
    const d = join(work, "served");
    mkdirSync(join(d, "img"), { recursive: true });
    writeFileSync(join(d, "index.html"), '<script>fetch("/api/tasks")</script><img src="img/a.png">');
    writeFileSync(join(d, "img", "a.png"), "png-bytes");
    const a: Artifact = await j(await add(d));
    return { a, url: await view(a.id) };
  }

  test("the view url opens the page inside a sandbox without allow-same-origin, and relative files resolve under the same key", async () => {
    const { url } = await site();
    const r = await get(url);
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("content-disposition")).toBe("inline");
    const img = await get(new URL("img/a.png", `${base}${url}`).pathname);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(await img.text()).toBe("png-bytes");
  });

  test("`..`, an encoded `..`, an absolute path and a backslash do not leave the folder", async () => {
    const { url } = await site();
    const key = url.split("/")[2]!;
    for (const p of ["../x", "%2e%2e/%2e%2e/work/notes.md", "img/..%2f..%2findex.html", "%2fetc%2fhostname", "..%5cindex.html", "img/%00"]) {
      const raw = await rawGet(`/artifacts/${key}/${p}`);
      expect([404, 403], p).toContain(raw.status);
      expect(raw.text).not.toContain("root:");
    }
    expect((await get(`/artifacts/${key}/nope.html`)).status).toBe(404);
  });

  test("a symlink inside the stored copy that points outside is not served", async () => {
    const { a, url } = await site();
    const key = url.split("/")[2]!;
    symlinkSync("/etc/hostname", join(storeOf(a.id), "leak.txt")); // the copy never holds one; serving must not rely on that
    symlinkSync("/etc", join(storeOf(a.id), "etc"));
    expect((await get(`/artifacts/${key}/leak.txt`)).status).toBe(404);
    expect((await get(`/artifacts/${key}/etc/hostname`)).status).toBe(404);
  });

  test("a forged key is 403, an expired one 410, a key for a removed report 404, and a url report has no view", async () => {
    const { a, url } = await site();
    const key = url.split("/")[2]!;
    expect((await get(`/artifacts/${key.slice(0, -2)}xx/index.html`)).status).toBe(403);
    expect((await get(`/artifacts/${a.id}.9999999999999.${"A".repeat(43)}/index.html`)).status).toBe(403);
    expect(checkViewKey(viewKey(a.id, Date.now() - 1))).toEqual({ ok: false, status: 410 });
    expect((await get(`/artifacts/${viewKey(a.id, Date.now() - 1)}/index.html`)).status).toBe(410);
    expect(checkViewKey(viewKey(a.id, Date.now() + 1000))).toEqual({ ok: true, id: a.id });
    // a key opens its own artifact only: another id with this signature is forged
    expect(checkViewKey(key.replace(a.id, "art_other"))).toEqual({ ok: false, status: 403 });
    await fetch(`${base}/api/artifacts/${a.id}`, { method: "DELETE" });
    expect((await get(url)).status).toBe(404);
    expect((await post(`/api/artifacts/${a.id}/view`)).status).toBe(404);
    const u: Artifact = await j(await add("https://example.com/x"));
    expect((await post(`/api/artifacts/${u.id}/view`)).status).toBe(400);
  });

  test("a page that runs in the sandbox sends `Origin: null`, and /api and /ws refuse it", async () => {
    expect((await get("/api/tasks", { headers: { origin: "null" } })).status).toBe(403);
    expect((await get("/api/tasks/tsk_art/artifacts", { headers: { origin: "null" } })).status).toBe(403);
    expect((await get("/ws", { headers: { origin: "null" } })).status).toBe(403);
    expect((await get("/api/tasks", { headers: { origin: base } })).status).toBe(200);
  });
});

describe("reports across tasks (#1835)", () => {
  const reports = (q = "") => fetch(`${base}/api/reports${q}`);
  const addTo = (task: string, source: string) => post(`/api/tasks/${task}/artifacts`, { source }).then(j) as Promise<Artifact>;

  test("every task's HTML artifacts, newest first, with the task's title; images stay out; a removed one drops out until restored", async () => {
    const t2 = "tsk_rep2";
    core.db.insertTask({ ...mkTask(t2, work), title: "second" });
    const dir = join(work, "rep");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of [["a.html", "<p>a</p>"], ["a.png", "png"], ["b.html", "<p>b</p>"]] as const) writeFileSync(join(dir, name), body);
    const a = await addTo(taskId, join(dir, "a.html"));
    expect((await addTo(taskId, join(dir, "a.png"))).mime).toBe("image/png");
    await Bun.sleep(5); // distinct updated_at, so the order below is the time's and not the id's
    const b = await addTo(t2, join(dir, "b.html"));
    const rows: Array<Artifact & { taskTitle: string; scheduleTitle: string | null }> = await j(await reports());
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(a.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    expect(rows.every((r) => r.mime === "text/html" && r.kind !== "url")).toBe(true);
    expect(rows.find((r) => r.id === b.id)).toMatchObject({ taskId: t2, taskTitle: "second", scheduleTitle: null, entry: "b.html" });
    expect((await fetch(`${base}/api/artifacts/${a.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await j(await reports())).some((r: Artifact) => r.id === a.id)).toBe(false);
    await post(`/api/artifacts/${a.id}/restore`);
    expect((await j(await reports())).some((r: Artifact) => r.id === a.id)).toBe(true);
  });

  test("limit takes an integer 1..100 only; a scheduled task's report names its schedule", async () => {
    for (const q of ["?limit=0", "?limit=101", "?limit=1.5", "?limit=abc", "?limit=", "?limit=%20", "?limit=1e1"]) expect((await reports(q)).status).toBe(400);
    expect((await reports()).status).toBe(200); // absent = the default
    const at = Date.now();
    core.db.insertSchedule({ id: "sch_rep", title: "評価の週報", cron: "0 19 * * 0", workspaceId: "ws_rep", runner: "claude", model: "", effort: "", prompt: "p", action: "prompt", budgetUsd: null, enabled: true, lastRunAt: null, lastTaskId: null, nextRunAt: null, lastResult: null, createdAt: at });
    const t3 = "tsk_rep3";
    core.db.insertTask({ ...mkTask(t3, work), title: "weekly", scheduleId: "sch_rep" });
    writeFileSync(join(work, "w.html"), "<p>w</p>");
    await Bun.sleep(5);
    const w = await addTo(t3, join(work, "w.html"));
    expect((await j(await reports()))[0]).toMatchObject({ id: w.id, taskTitle: "weekly", scheduleTitle: "評価の週報" });
    expect((await j(await reports("?limit=1"))).length).toBe(1);
  });
});

describe("artifacts across tasks (#1833)", () => {
  const across = (q = "") => fetch(`${base}/api/artifacts${q}`);
  const addTo = (task: string, source: string) => post(`/api/tasks/${task}/artifacts`, { source }).then(j) as Promise<Artifact>;
  type Row = Artifact & { taskTitle: string; scheduleTitle: string | null };
  const ids = async (path: string) => ((await j(await fetch(`${base}${path}`))) as Row[]).map((r) => r.id);
  let dir: string;
  let html: Artifact, png: Artifact, txt: Artifact, url: Artifact;

  beforeAll(async () => {
    core.db.insertTask({ ...mkTask("tsk_all1", work), title: "週報を作る" });
    core.db.insertTask({ ...mkTask("tsk_all2", work), title: "画面の確認" });
    dir = join(work, "all");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of [["trend_100%.html", "<p>t</p>"], ["shot.png", "png"], ["notes.txt", "n"]] as const) writeFileSync(join(dir, name), body);
    html = await addTo("tsk_all1", join(dir, "trend_100%.html"));
    await Bun.sleep(5); // distinct updated_at, so the order is the time's and not the id's
    png = await addTo("tsk_all2", join(dir, "shot.png"));
    await Bun.sleep(5);
    txt = await addTo("tsk_all1", join(dir, "notes.txt"));
    await Bun.sleep(5);
    url = await addTo("tsk_all2", "https://example.com/dash");
  });

  test("every kind from every task, newest first, with the task's title; a removed one drops out until restored", async () => {
    const rows: Row[] = await j(await across("?limit=100"));
    const mine = [url, txt, png, html].map((a) => a.id);
    expect(rows.map((r) => r.id).filter((id) => mine.includes(id))).toEqual(mine);
    expect(rows.find((r) => r.id === png.id)).toMatchObject({ title: "shot.png", kind: "file", mime: "image/png", taskId: "tsk_all2", taskTitle: "画面の確認" });
    expect(rows.find((r) => r.id === url.id)).toMatchObject({ kind: "url", taskTitle: "画面の確認" });
    expect(rows.find((r) => r.id === html.id)).toMatchObject({ createdAt: html.createdAt, updatedAt: html.updatedAt, taskTitle: "週報を作る" });
    expect((await fetch(`${base}/api/artifacts/${txt.id}`, { method: "DELETE" })).status).toBe(200);
    expect(await ids("/api/artifacts?limit=100")).not.toContain(txt.id);
    await post(`/api/artifacts/${txt.id}/restore`);
    expect(await ids("/api/artifacts?limit=100")).toContain(txt.id);
  });

  test("q matches part of the title, the original path or the task's title, with % and _ taken literally; /api/reports takes q within HTML", async () => {
    const q = (s: string) => encodeURIComponent(s);
    expect(await ids("/api/artifacts?limit=100&q=shot")).toEqual([png.id]);
    expect(await ids(`/api/artifacts?limit=100&q=${q("all/notes")}`)).toEqual([txt.id]);
    expect(await ids(`/api/artifacts?limit=100&q=${q("週報")}`)).toEqual([txt.id, html.id]);
    expect(await ids(`/api/artifacts?limit=100&q=${q("  画面の ")}`)).toEqual([url.id, png.id]);
    expect(await ids(`/api/artifacts?limit=100&q=${q("_100%")}`)).toEqual([html.id]);
    expect(await ids(`/api/artifacts?limit=100&q=${q("t_")}`)).toEqual([]); // "_" is not "any one character"
    expect(await ids(`/api/reports?limit=100&q=${q("週報")}`)).toEqual([html.id]);
    expect((await across(`?q=${"x".repeat(201)}`)).status).toBe(400);
    expect((await across(`?q=${"x".repeat(200)}`)).status).toBe(200);
    expect((await across("?q=%20")).status).toBe(200); // blank = no filter
  });

  test("1000 rows: limit caps a page, before reads on without gaps or repeats; a bad limit or an unknown before is 400", async () => {
    const at = Date.now() + 60_000; // newer than everything above, so the first pages are these
    core.db.insertTask({ ...mkTask("tsk_many", work), title: "many" });
    for (let i = 0; i < 1000; i++) {
      const id = `art_many_${String(i).padStart(4, "0")}`;
      // three rows share each updated_at, so the id breaks the ties across a page boundary
      core.db.insertArtifact({ id, taskId: "tsk_many", title: `m${i}.txt`, kind: "file", source: `/x/m${i}.txt`, entry: `m${i}.txt`, mime: "text/plain", size: 1, removedAt: null, createdAt: at, updatedAt: at + Math.floor(i / 3) });
    }
    const seen: string[] = [];
    let before = "";
    for (;;) {
      const page: Row[] = await j(await across(`?limit=100&q=many${before ? `&before=${before}` : ""}`));
      expect(page.length).toBeLessThanOrEqual(100);
      if (!page.length) break;
      seen.push(...page.map((r) => r.id));
      before = page[page.length - 1]!.id;
    }
    expect(seen.length).toBe(1000);
    expect(new Set(seen).size).toBe(1000);
    expect((await j(await across("?limit=100"))).length).toBe(100);
    expect((await j(await across())).length).toBe(20); // absent = 20
    for (const s of ["?limit=101", "?limit=0", "?limit=", "?before=art_nope"]) expect((await across(s)).status).toBe(400);
    expect((await fetch(`${base}/api/reports?before=art_nope`)).status).toBe(400);
  });

  test("an archived task, absent from GET /api/tasks, still lists its artifacts", async () => {
    core.db.insertTask({ ...mkTask("tsk_old", work), title: "古い Task", archivedAt: 1 });
    writeFileSync(join(dir, "old.html"), "<p>old</p>");
    const old = await addTo("tsk_old", join(dir, "old.html"));
    expect(((await j(await fetch(`${base}/api/tasks`))) as Task[]).some((t) => t.id === "tsk_old")).toBe(false);
    expect(await ids(`/api/artifacts?q=${encodeURIComponent("古い")}`)).toEqual([old.id]);
  });
});

describe("addCopy (#1838)", () => {
  test("the daemon's own copy of a file outside every scope: the ordinary entrance refuses it, addCopy takes it, keeps the deny list and the size limit, and replaces the same path", async () => {
    const outside = mkdtempSync(join(tmpdir(), "switchboard-art-outside-"));
    const f = join(outside, "report.html");
    writeFileSync(f, "<h1>r</h1>");
    writeFileSync(join(home, "token"), "x");
    const store = new ArtifactStore(core.db, join(home, "artifacts"), { privateTmp: () => join(home, "none"), deny: [join(home, "token")], tmpRoots: [] });
    const task = { id: taskId, cwd: work, scope: [work] };
    expect(() => store.add(task, { source: f })).toThrow(/outside/);
    const a = store.addCopy(task, f, "Claude Code Insights 2026-10-18");
    expect(a).toMatchObject({ taskId, title: "Claude Code Insights 2026-10-18", mime: "text/html", kind: "file", entry: "report.html" });
    expect(readFileSync(join(home, "artifacts", taskId, a.id, "report.html"), "utf8")).toBe("<h1>r</h1>");
    writeFileSync(f, "<h1>r2</h1>");
    expect(store.addCopy(task, f, "again").id).toBe(a.id);
    expect(readFileSync(join(home, "artifacts", taskId, a.id, "report.html"), "utf8")).toBe("<h1>r2</h1>");
    expect(() => store.addCopy(task, join(home, "token"), "t")).toThrow(/cannot be registered/);
    expect(() => store.addCopy(task, join(outside, "missing.html"), "m")).toThrow(/does not exist/);
    const big = join(outside, "big.html");
    writeFileSync(big, Buffer.alloc(MAX_ARTIFACT_FILE_BYTES + 1));
    expect(() => store.addCopy(task, big, "b")).toThrow(/max/);
    rmSync(outside, { recursive: true, force: true });
  });
});
