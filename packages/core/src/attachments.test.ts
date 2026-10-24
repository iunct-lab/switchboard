import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentEvent, Attachment, EventEnvelope, RunnerAdapter, RunnerId, RunnerSession, StartOptions, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { startServer } from "./server.ts";
import { ATTACHMENT_ONLY_TEXT, AttachmentStore, attachmentNote, extValue, MAX_NAME_BYTES, mimeFor, safeName, withAttachments } from "./attachments.ts";

const NO_HISTORY = { SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" };

/** A runner that answers every turn at once; `lingers` keeps the process alive after the turn (like `claude -p` with stream-json). */
function fakeAdapter(id: RunnerId, starts: StartOptions[], sends: string[], opts: { lingers?: boolean; costUsd?: number } = {}): RunnerAdapter {
  return {
    id,
    async detect() {
      return { available: true, version: "fake" };
    },
    start(startOpts, emit) {
      starts.push(startOpts);
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      let gone = false;
      const turn = (text: string, first: boolean) =>
        queueMicrotask(() => {
          if (gone) return;
          if (first) emit({ t: "session.start", runner: id, runnerSessionId: `${id}-sess-${starts.length}`, cwd: startOpts.cwd });
          emit({ t: "message.delta", role: "user", text });
          emit({ t: "message.delta", role: "assistant", text: "ok" });
          // "make-file": the runner hands back a file it made (#124: DAK's artifacts) — and one it points at elsewhere
          if (text.startsWith("make-file") && startOpts.attachmentDir) {
            mkdirSync(startOpts.attachmentDir, { recursive: true });
            writeFileSync(join(startOpts.attachmentDir, "made.md"), "# made\n");
            emit({ t: "artifact", kind: "file", path: join(startOpts.attachmentDir, "made.md") });
            emit({ t: "artifact", kind: "file", path: join(startOpts.cwd, "elsewhere.md") });
            symlinkSync(join(startOpts.cwd, "elsewhere.md"), join(startOpts.attachmentDir, "link.md")); // inside the directory, pointing out of it
            emit({ t: "artifact", kind: "file", path: join(startOpts.attachmentDir, "link.md") });
            emit({ t: "artifact", kind: "file", path: join(startOpts.attachmentDir, "made.md") });
          }
          if (opts.costUsd) emit({ t: "usage", source: "reported", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: opts.costUsd });
          emit({ t: "session.end", status: "ok" });
          if (!opts.lingers) resolveExit(0);
        });
      turn(startOpts.prompt, true);
      const session: RunnerSession = {
        send: (text, atts) => {
          sends.push(text);
          sentAttachments.push(atts ?? []);
          turn(text, false);
        },
        respondPermission: () => {},
        abort: async () => {
          gone = true;
          resolveExit(null);
        },
        close: async () => {
          gone = true;
          resolveExit(0);
        },
        exited,
      };
      return session;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (r: Response) => r.json() as Promise<any>;
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

let home: string;
let core: Awaited<ReturnType<typeof startServer>>;
let base: string;
const claudeStarts: StartOptions[] = [];
const claudeSends: string[] = [];
const codexStarts: StartOptions[] = [];
const codexSends: string[] = [];
/** What each live send() got as its attachments (#124), across both fake runners. */
const sentAttachments: Attachment[][] = [];
const names = (atts: Attachment[] | undefined) => (atts ?? []).map((a) => a.name);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

async function upload(files: Array<{ name: string; type?: string; bytes: Uint8Array }>): Promise<Response> {
  const fd = new FormData();
  for (const f of files) fd.append("file", new File([f.bytes], f.name, { type: f.type ?? "" }));
  // connection: close — a 413 is sent before the body is read, and the next request must not reuse that socket
  return fetch(`${base}/api/attachments`, { method: "POST", body: fd, headers: { connection: "close" } });
}
const createTask = (body: Record<string, unknown>) => fetch(`${base}/api/tasks`, { method: "POST", body: JSON.stringify({ cwd: home, title: "t", prompt: "hello", runner: "claude", ...body }) });
const detail = (id: string) => fetch(`${base}/api/tasks/${id}`).then(j) as Promise<{ task: Task; events: EventEnvelope[]; attachments: Array<{ id: string; taskId: string | null; path: string; name: string }> }>;
const settle = async (id: string) => {
  await until(() => core.db.getTask(id)?.status === "done");
  return core.db.getTask(id)!;
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "switchboard-att-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", ...NO_HISTORY });
  core = await startServer(cfg, [fakeAdapter("claude", claudeStarts, claudeSends, { costUsd: 1 }), fakeAdapter("codex", codexStarts, codexSends, { lingers: true })], { port: 0, selfdevChecks: false, dryRunRestart: true });
  base = `http://127.0.0.1:${core.server.port}`;
});

afterAll(async () => {
  await core.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("attachments (#125)", () => {
  test("an upload lands in attachments/inbox with its mime and is served back with the same bytes", async () => {
    const r = await upload([{ name: "shot.png", type: "image/png", bytes: PNG }]);
    expect(r.status).toBe(201);
    const [a] = await j(r);
    expect(a).toMatchObject({ taskId: null, name: "shot.png", mime: "image/png", size: PNG.byteLength });
    expect(a.path).toBe(join(home, "attachments", "inbox", a.id, "shot.png"));
    expect(existsSync(a.path)).toBe(true);
    const got = await fetch(`${base}/api/attachments/${a.id}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("content-disposition")).toContain("shot.png");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    expect((await fetch(`${base}/api/attachments/att_nope`)).status).toBe(404);
  });

  test("a drop without a browser mime falls back to the extension; names lose their directories", async () => {
    const r = await upload([{ name: "../../etc/notes.md", bytes: new TextEncoder().encode("# hi") }]);
    const [a] = await j(r);
    expect(a.name).toBe("notes.md");
    expect(a.mime).toBe("text/markdown");
    expect(mimeFor("x.PDF")).toBe("application/pdf");
    expect(mimeFor("x.bin")).toBe("application/octet-stream");
    expect(mimeFor("x.bin", "image/webp")).toBe("image/webp");
    expect(mimeFor("x.png", "application/octet-stream")).toBe("image/png");
    expect(mimeFor("x.txt", "text/plain;charset=utf-8")).toBe("text/plain");
  });

  test("created with attachmentIds: the file moves under the task, the scope gains that directory, the prompt lists the path, the transcript has the row", async () => {
    const [a] = await j(await upload([{ name: "shot.png", type: "image/png", bytes: PNG }]));
    const before = claudeStarts.length;
    const r = await createTask({ attachmentIds: [a.id] });
    expect(r.status).toBe(201);
    const task = (await j(r)) as Task;
    const dir = join(home, "attachments", task.id);
    expect(task.scope).toEqual([home, dir]);
    await settle(task.id);
    const start = claudeStarts[before]!;
    expect(start.scope).toEqual([home, dir]);
    expect(start.prompt).toBe(`hello${attachmentNote([{ ...a, taskId: task.id, path: join(dir, "shot.png") }])}`);
    expect(start.prompt).toContain(`- ${join(dir, "shot.png")} (image/png, 16 B)`);
    expect(start.attachments?.map((x) => x.path)).toEqual([join(dir, "shot.png")]); // the adapter gets them too (#124)
    expect(existsSync(join(dir, "shot.png"))).toBe(true);
    expect(existsSync(dirname(a.path))).toBe(false); // the inbox folder is gone
    const d = await detail(task.id);
    expect(d.attachments).toHaveLength(1);
    expect(d.attachments[0]).toMatchObject({ id: a.id, taskId: task.id, path: join(dir, "shot.png") });
    const rowSeq = d.events.find((e) => e.ev.t === "attachment")!;
    expect(rowSeq.ev).toMatchObject({ t: "attachment", id: a.id, name: "shot.png", mime: "image/png", size: 16 });
    const userSeq = d.events.find((e) => e.ev.t === "message.delta" && e.ev.role === "user")!;
    expect(rowSeq.seq).toBeLessThan(userSeq.seq);
    // the same id cannot be sent twice
    expect((await createTask({ attachmentIds: [a.id] })).status).toBe(409);
  });

  test("a follow-up with attachments goes out with the new path; an attachment-only turn gets the fixed sentence", async () => {
    const [a] = await j(await upload([{ name: "shot.png", type: "image/png", bytes: PNG }]));
    const task = (await j(await createTask({ attachmentIds: [a.id] }))) as Task;
    await settle(task.id);
    const [b] = await j(await upload([{ name: "log.txt", bytes: new TextEncoder().encode("x") }]));
    const before = claudeStarts.length;
    const r = await fetch(`${base}/api/tasks/${task.id}/send`, { method: "POST", body: JSON.stringify({ attachmentIds: [b.id] }) });
    expect(r.status).toBe(200);
    await until(() => claudeStarts.length > before);
    await settle(task.id);
    const dir = join(home, "attachments", task.id);
    const start = claudeStarts[before]!;
    expect(start.resumeSessionId).toBeDefined();
    expect(start.prompt.startsWith(ATTACHMENT_ONLY_TEXT)).toBe(true);
    expect(start.prompt).toContain(`- ${join(dir, "log.txt")} (text/plain, 1 B)`);
    expect(names(start.attachments)).toEqual(["log.txt"]); // the --resume restart carries this turn's files only
    expect(start.scope).toEqual([home, dir]); // already there: no duplicate
    const d = await detail(task.id);
    expect(d.attachments.map((x) => x.name)).toEqual(["shot.png", "log.txt"]);
    expect(d.events.filter((e) => e.ev.t === "attachment")).toHaveLength(2);
    // a second file of the same name keeps its own path
    const [c] = await j(await upload([{ name: "shot.png", type: "image/png", bytes: PNG }]));
    await fetch(`${base}/api/tasks/${task.id}/send`, { method: "POST", body: JSON.stringify({ text: "again", attachmentIds: [c.id] }) });
    await until(() => claudeStarts.length > before + 1);
    await settle(task.id);
    expect((await detail(task.id)).attachments.at(-1)!.path).toBe(join(dir, `shot-${c.id.slice(-4)}.png`));
    // neither text nor attachments is refused
    expect((await fetch(`${base}/api/tasks/${task.id}/send`, { method: "POST", body: JSON.stringify({ text: "  " }) })).status).toBe(400);
  });

  test("a task created without attachments gets the directory on its first attached turn; a live runner is restarted with --resume so it sees the new root", async () => {
    const before = codexStarts.length;
    const task = (await j(await createTask({ runner: "codex" }))) as Task;
    await settle(task.id);
    expect(task.scope).toEqual([home]);
    expect(core.tasks.isLive(task.id)).toBe(true); // codex lingers
    const [a] = await j(await upload([{ name: "shot.png", type: "image/png", bytes: PNG }]));
    const r = await fetch(`${base}/api/tasks/${task.id}/send`, { method: "POST", body: JSON.stringify({ text: "look", attachmentIds: [a.id] }) });
    expect(r.status).toBe(200);
    await until(() => codexStarts.length === before + 2);
    await settle(task.id);
    const dir = join(home, "attachments", task.id);
    expect(codexSends).not.toContain(expect.stringContaining(dir)); // not handed to the old process
    const restarted = codexStarts[before + 1]!;
    expect(restarted.resumeSessionId).toBe(`codex-sess-${before + 1}`);
    expect(restarted.scope).toEqual([home, dir]);
    expect(restarted.prompt).toContain(join(dir, "shot.png"));
    expect(names(restarted.attachments)).toEqual(["shot.png"]);
    const d = await detail(task.id);
    expect(d.task.scope).toEqual([home, dir]);
    expect(d.events.some((e) => e.ev.t === "status" && e.ev.text.includes("プロセスを再開します（--resume）"))).toBe(true);
  });

  test("a file the runner made in the task's attachment directory is registered and recorded as an attachment; others, and a symlink out of it, are not (#124)", async () => {
    writeFileSync(join(home, "elsewhere.md"), "not the task's");
    const task = (await j(await createTask({ prompt: "make-file please" }))) as Task;
    await settle(task.id);
    const dir = join(home, "attachments", task.id);
    expect(claudeStarts.at(-1)!.attachmentDir).toBe(dir);
    const d = await detail(task.id);
    expect(d.attachments).toHaveLength(1);
    expect(d.attachments[0]).toMatchObject({ taskId: task.id, name: "made.md", path: join(dir, "made.md") });
    const evs = d.events.map((e) => e.ev);
    const att = evs.filter((e) => e.t === "attachment");
    expect(att).toEqual([{ t: "attachment", id: d.attachments[0]!.id, name: "made.md", mime: "text/markdown", size: 7 }]);
    // recorded right after the runner's artifact, after the assistant's reply
    const i = evs.findIndex((e) => e.t === "attachment");
    expect(evs[i - 1]).toMatchObject({ t: "artifact", path: join(dir, "made.md") });
    expect(evs.findIndex((e) => e.t === "message.delta" && e.role === "assistant")).toBeLessThan(i);
    // the bytes are served like any attachment
    expect(await (await fetch(`${base}/api/attachments/${d.attachments[0]!.id}`)).text()).toBe("# made\n");
  });

  test("a refused turn leaves the uploads in the inbox: unknown task (a traversal in the id included), budget exceeded", async () => {
    const [a] = await j(await upload([{ name: "x.txt", bytes: new Uint8Array(1) }]));
    const before = claudeStarts.length;
    // the id is a raw URL segment; Bun decodes %2F — it must never become a directory outside the store
    for (const id of ["task_nope", "..%2F..%2Fescaped%2Fdeeper", "inbox", "%2E%2E"]) {
      const r = await fetch(`${base}/api/tasks/${id}/send`, { method: "POST", body: JSON.stringify({ text: "x", attachmentIds: [a.id] }) });
      // a 404/409 from the route, or the static fallback (a normalised path never reaches the route) — never a task
      expect(r.headers.get("content-type")?.startsWith("application/json") ? r.status : 404).toBeGreaterThanOrEqual(400);
      expect(core.db.getAttachment(a.id)!.taskId).toBeNull();
      expect(existsSync(a.path)).toBe(true);
    }
    expect(existsSync(join(home, "escaped"))).toBe(false);
    expect(existsSync(join(tmpdir(), "escaped"))).toBe(false);
    // budget: the fake claude reports $1 per turn; a $0.5 budget is exceeded after the first turn
    const task = (await j(await createTask({ budgetUsd: 0.5 }))) as Task;
    await settle(task.id);
    const r = await fetch(`${base}/api/tasks/${task.id}/send`, { method: "POST", body: JSON.stringify({ text: "more", attachmentIds: [a.id] }) });
    expect(r.status).toBe(409);
    expect((await j(r)).error).toContain("budget exceeded");
    expect(core.db.getAttachment(a.id)!.taskId).toBeNull();
    expect(existsSync(a.path)).toBe(true);
    expect((await detail(task.id)).events.some((e) => e.ev.t === "attachment")).toBe(false);
    expect((await detail(task.id)).task.scope).toEqual([home]);
    expect(claudeStarts.length).toBe(before + 1);
    // the store itself refuses a task id that is not a directory name
    const store = new AttachmentStore(core.db, join(home, "attachments"));
    for (const bad of ["../x", "a/b", "", "inbox", "."]) expect(() => store.taskDir(bad)).toThrow();
  });

  test("names are cut on code points within MAX_NAME_BYTES, keeping the extension; active content downloads with a sandbox CSP", async () => {
    const long = "画".repeat(120) + "🙂".repeat(20) + ".png";
    const cut = safeName(long);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(cut.endsWith(".png")).toBe(true);
    expect([...cut].some((c) => /[\uD800-\uDFFF]/.test(c))).toBe(false); // no lone surrogate
    expect(safeName("x".repeat(300))).toHaveLength(MAX_NAME_BYTES);
    expect(safeName("..")).toBe("file");
    expect(safeName("a.".padEnd(40, "z"))).toBe("a.".padEnd(40, "z")); // a 38-char "extension" is not one
    const [png] = await j(await upload([{ name: long, type: "image/png", bytes: PNG }]));
    expect(Buffer.byteLength(png.name)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(existsSync(png.path)).toBe(true);
    const [html] = await j(await upload([{ name: "it's (1).html", type: "text/html", bytes: new TextEncoder().encode("<script>alert(1)</script>") }]));
    const got = await fetch(`${base}/api/attachments/${html.id}`);
    expect(got.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''it%27s%20%281%29.html");
    expect(got.headers.get("content-security-policy")).toBe("sandbox");
    const img = await fetch(`${base}/api/attachments/${png.id}`);
    expect(img.headers.get("content-disposition")!.startsWith("inline; ")).toBe(true);
    expect(img.headers.get("content-security-policy")).toBe("sandbox");
    expect(extValue("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
    // a declared body far over the limit is refused before it is read
    // (fetch rewrites content-length, so the header goes over a raw socket)
    const head = await new Promise<string>((resolve) => {
      let out = "";
      void Bun.connect({
        hostname: "127.0.0.1",
        port: core.server.port!,
        socket: {
          open(s) {
            s.write(`POST /api/attachments HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: multipart/form-data; boundary=x\r\nContent-Length: ${300 * 1024 * 1024}\r\nConnection: close\r\n\r\n`);
          },
          data(_s, chunk) {
            out += chunk.toString();
            if (out.includes("\r\n\r\n")) resolve(out);
          },
          close: () => resolve(out),
          error: () => resolve(out),
        },
      });
      setTimeout(() => resolve(out), 3000);
    });
    expect(head.startsWith("HTTP/1.1 413")).toBe(true);
  });

  test("sweep and remove only ever delete the upload's own inbox folder, never what a tampered path points at", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "switchboard-att-tamper-"));
    const db = new Db(join(scratch, "x.db"));
    const store = new AttachmentStore(db, join(scratch, "att"));
    const victim = join(scratch, "victim");
    mkdirSync(victim, { recursive: true });
    writeFileSync(join(victim, "keep.txt"), "keep");
    const a = store.save({ name: "a.txt", bytes: new Uint8Array(1) });
    const b = store.save({ name: "b.txt", bytes: new Uint8Array(1) });
    db.sqlite.query("UPDATE attachments SET path = ?, created_at = 0 WHERE id = ?").run(join(victim, "keep.txt"), a.id);
    db.sqlite.query("UPDATE attachments SET path = ? WHERE id = ?").run(join(victim, "keep.txt"), b.id);
    expect(store.check([b.id])?.status).toBe(410); // not in its inbox folder: cannot be sent
    expect(() => store.attach([b.id], "task_x")).toThrow();
    store.remove(b.id);
    expect(store.sweep()).toBe(1);
    expect(existsSync(join(victim, "keep.txt"))).toBe(true);
    expect(existsSync(join(scratch, "att", "inbox", a.id))).toBe(false);
    expect(existsSync(join(scratch, "att", "inbox", b.id))).toBe(false);
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("a shadow run reads the primary's files: same paths in its prompt, its scope widened to the primary's directory", async () => {
    const [a] = await j(await upload([{ name: "shot.png", type: "image/png", bytes: PNG }]));
    const before = codexStarts.length;
    const task = (await j(await createTask({ attachmentIds: [a.id], shadowRunner: "codex" }))) as Task;
    await settle(task.id);
    await until(() => codexStarts.length > before);
    const dir = join(home, "attachments", task.id);
    const shadowStart = codexStarts[before]!;
    expect(shadowStart.prompt).toContain(join(dir, "shot.png"));
    expect(shadowStart.scope).toEqual([home, dir]);
    expect(names(shadowStart.attachments)).toEqual(["shot.png"]);
    const shadow = core.db.shadowTaskOf(task.id)!;
    await settle(shadow.id);
    const d = await detail(shadow.id);
    expect(d.events.some((e) => e.ev.t === "attachment" && e.ev.id === a.id)).toBe(true);
    // a follow-up on the primary reaches the shadow with the same new path
    const [b] = await j(await upload([{ name: "more.txt", bytes: new TextEncoder().encode("y") }]));
    const shadowBefore = codexStarts.length + codexSends.length;
    await fetch(`${base}/api/tasks/${task.id}/send`, { method: "POST", body: JSON.stringify({ text: "next", attachmentIds: [b.id] }) });
    await until(() => codexStarts.length + codexSends.length > shadowBefore);
    const lastShadowTurn = codexSends.at(-1) ?? codexStarts.at(-1)!.prompt;
    expect(lastShadowTurn).toContain(join(dir, "more.txt"));
    expect(codexSends.length).toBeGreaterThan(0); // the live process took it: send() got the file along
    expect(names(sentAttachments.at(-1))).toEqual(["more.txt"]);
  });

  test("limits and refusals: file size, file count, no file, unknown / repeated ids — nothing starts", async () => {
    const big = await upload([{ name: "big.bin", bytes: new Uint8Array(20 * 1024 * 1024 + 1) }]);
    expect(big.status).toBe(413);
    expect((await j(big)).error).toContain("max 20.0 MB");
    const many = await upload(Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, bytes: new Uint8Array(1) })));
    expect(many.status).toBe(413);
    expect((await upload([])).status).toBe(400);
    expect((await fetch(`${base}/api/attachments`, { method: "POST", body: JSON.stringify({}) })).status).toBe(400);
    const before = claudeStarts.length;
    expect((await createTask({ attachmentIds: ["att_nope"] })).status).toBe(404);
    const [a] = await j(await upload([{ name: "x.txt", bytes: new Uint8Array(1) }]));
    expect((await createTask({ attachmentIds: [a.id, a.id] })).status).toBe(400);
    const task = (await j(await createTask({}))) as Task;
    await settle(task.id);
    expect((await fetch(`${base}/api/tasks/${task.id}/send`, { method: "POST", body: JSON.stringify({ text: "x", attachmentIds: ["att_nope"] }) })).status).toBe(404);
    expect(claudeStarts.length).toBe(before + 1);
    expect(core.db.getAttachment(a.id)!.taskId).toBeNull(); // the refused creation did not take it
  });

  test("DELETE forgets an upload that was not sent; one that was sent stays with the transcript", async () => {
    const [a] = await j(await upload([{ name: "x.txt", bytes: new Uint8Array(1) }]));
    const folder = dirname(a.path);
    expect((await fetch(`${base}/api/attachments/${a.id}`, { method: "DELETE" })).status).toBe(200);
    expect(existsSync(folder)).toBe(false);
    expect((await fetch(`${base}/api/attachments/${a.id}`)).status).toBe(404);
    expect((await fetch(`${base}/api/attachments/${a.id}`, { method: "DELETE" })).status).toBe(404);
    const [b] = await j(await upload([{ name: "y.txt", bytes: new Uint8Array(1) }]));
    const task = (await j(await createTask({ attachmentIds: [b.id] }))) as Task;
    await settle(task.id);
    const gone = await fetch(`${base}/api/attachments/${b.id}`, { method: "DELETE" });
    expect(gone.status).toBe(409);
    expect((await fetch(`${base}/api/attachments/${b.id}`)).status).toBe(200);
  });

  test("rows and files survive reopening the database; the boot sweep removes only day-old unsent uploads", async () => {
    const [a] = await j(await upload([{ name: "keep.txt", bytes: new Uint8Array(1) }]));
    const task = (await j(await createTask({ attachmentIds: [a.id] }))) as Task;
    await settle(task.id);
    const again = new Db(join(home, "switchboard.db"));
    const row = again.getAttachment(a.id)!;
    expect(row.taskId).toBe(task.id);
    expect(existsSync(row.path)).toBe(true);
    again.close();

    const scratch = mkdtempSync(join(tmpdir(), "switchboard-att-sweep-"));
    const db = new Db(join(scratch, "x.db"));
    const store = new AttachmentStore(db, join(scratch, "att"));
    const old = store.save({ name: "old.txt", bytes: new Uint8Array(1) });
    const fresh = store.save({ name: "fresh.txt", bytes: new Uint8Array(1) });
    const sent = store.save({ name: "sent.txt", bytes: new Uint8Array(1) });
    store.attach([sent.id], "task_x");
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    db.sqlite.query("UPDATE attachments SET created_at = ? WHERE id IN (?, ?)").run(dayAgo, old.id, sent.id);
    expect(store.sweep()).toBe(1);
    expect(existsSync(dirname(old.path))).toBe(false);
    expect(store.get(old.id)).toBeNull();
    expect(existsSync(fresh.path)).toBe(true);
    expect(existsSync(store.get(sent.id)!.path)).toBe(true); // sent: never swept
    db.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  test("the prompt block: nothing without attachments, the fixed sentence for an empty text", () => {
    expect(withAttachments("  keep as is \n", [])).toBe("  keep as is \n");
    const a = { id: "att_1", taskId: "t", name: "a.png", mime: "image/png", size: 2048, path: "/x/a.png", createdAt: 0 };
    expect(withAttachments("", [a])).toBe(`${ATTACHMENT_ONLY_TEXT}\n\n添付ファイル（このマシン上のパス。必要なら読んでください）:\n- /x/a.png (image/png, 2.0 KB)`);
    expect(withAttachments("look", [a, { ...a, path: "/x/b.pdf", mime: "application/pdf", size: 3 * 1024 * 1024 }])).toBe("look\n\n添付ファイル（このマシン上のパス。必要なら読んでください）:\n- /x/a.png (image/png, 2.0 KB)\n- /x/b.pdf (application/pdf, 3.0 MB)");
  });
});

// keep the type import used in signatures above
export type { AgentEvent };
