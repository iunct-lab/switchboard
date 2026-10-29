import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { Inbox, localDate, notePath, slugify } from "./inbox.ts";
import { KnowledgeStore } from "./knowledge.ts";

let root: string;
let db: Db;
let store: KnowledgeStore;
let inbox: Inbox;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sb-inbox-"));
  db = new Db(join(root, "index.db"));
  store = new KnowledgeStore(join(root, "Knowledge"), db);
  inbox = new Inbox(store);
});
afterAll(() => {
  store.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("inbox", () => {
  test("slug and path are local-date-prefixed, unicode-safe, bounded by code points", () => {
    expect(slugify("BFF をストリーミング対応にする")).toBe("bff-をストリーミング対応にする");
    expect(slugify("   ")).toBe("note");
    expect(slugify("a".repeat(47) + "-b")).toBe("a".repeat(47)); // trailing dash removed after the cut
    expect(slugify("😀".repeat(60)).length).toBeLessThanOrEqual(48 * 2);
    expect(slugify("😀".repeat(60))).toBe("note"); // emoji are neither letters nor digits
    const d = new Date(2026, 8, 5, 8, 0, 0); // local 08:00 → still the 5th even if UTC says the 4th
    expect(localDate(d)).toBe("2026-09-05");
    expect(notePath("Hello World!", d)).toBe("notes/2026-09-05-hello-world.md");
  });

  test("add writes a note under notes/ with frontmatter; list shows only inbox notes, newest first; collisions get -2, -3, …", () => {
    const d = new Date(2026, 8, 5, 10, 0, 0);
    const a = inbox.add("BFF をストリーミング対応にする\r\n\r\nADK の /run_sse を中継すれば足りるはず", { workspaceHint: "dak", now: d });
    expect(a.path).toBe("notes/2026-09-05-bff-をストリーミング対応にする.md");
    expect(a.title).toBe("BFF をストリーミング対応にする");
    expect(a.body).not.toContain("\r");
    const b = inbox.add("ブログ記事: はじめての自作キーボード", { now: new Date(2026, 8, 6, 10, 0, 0) });
    expect(inbox.list().map((n) => n.path)).toEqual([b.path, a.path]);
    expect(inbox.list()[1]).toMatchObject({ workspaceHint: "dak", status: "inbox", body: expect.stringContaining("/run_sse") });
    const c = inbox.add("BFF をストリーミング対応にする", { now: new Date(2026, 8, 5, 11, 0, 0) });
    expect(c.path).toBe("notes/2026-09-05-bff-をストリーミング対応にする-2.md");
    const c3 = inbox.add("BFF をストリーミング対応にする", { now: new Date(2026, 8, 5, 12, 0, 0) });
    expect(c3.path).toBe("notes/2026-09-05-bff-をストリーミング対応にする-3.md");
    expect(() => inbox.add("   ")).toThrow(/empty/);
  });

  test("titles: empty/whitespace/CRLF titles fall back to the first line; quotes and colons round-trip through YAML", () => {
    const e = inbox.add("first line here\nmore", { title: "  \r\n", now: new Date(2026, 8, 7) });
    expect(e.title).toBe("first line here");
    expect(inbox.get(e.path).title).toBe("first line here");
    const q = inbox.add("body", { title: 'Zenn: "quotes" & #hash', now: new Date(2026, 8, 8) });
    expect(inbox.get(q.path).title).toBe('Zenn: "quotes" & #hash');
    expect(store.read(q.path).doc.frontmatter._invalid).toBeUndefined();
  });

  test("promoting keeps the file and hand-added frontmatter, flips status, records the task id, and refuses a second promotion", () => {
    const [first] = inbox.list();
    const raw = readFileSync(join(store.dir, first!.path), "utf8").replace("---\n", "---\ntags: [zenn]\n");
    store.write(first!.path, raw);
    const p = inbox.markPromoted(first!.path, "task_abc");
    expect(p).toMatchObject({ status: "promoted", taskId: "task_abc" });
    expect(inbox.list().some((n) => n.path === first!.path)).toBe(false);
    const after = store.read(first!.path);
    expect(after.content).toContain("task: task_abc");
    expect(after.doc.frontmatter.tags).toEqual(["zenn"]); // preserved
    expect(after.body.trim()).toBe(first!.body);
    expect(inbox.get(first!.path).status).toBe("promoted");
    expect(() => inbox.markPromoted(first!.path, "task_other")).toThrow(/already promoted/);
    expect(() => inbox.get("README.md")).toThrow(/not an inbox note/);
  });

  test("close takes a draft off the list without a task; the file stays with status: closed, also for a new Inbox", () => {
    const d = inbox.add("close me", { now: new Date(2026, 8, 6, 10, 0, 0) });
    const c = inbox.close(d.path, { now: new Date("2026-09-06T01:00:00Z") });
    expect(c.status).toBe("closed");
    expect(inbox.list().some((n) => n.path === d.path)).toBe(false);
    expect(new Inbox(store).list().some((n) => n.path === d.path)).toBe(false);
    const raw = readFileSync(join(store.dir, d.path), "utf8");
    expect(raw).toContain("status: closed");
    expect(raw).toContain("closed: 2026-09-06T01:00:00.000Z");
    expect(raw).toContain("close me");
    expect(() => inbox.close(d.path)).toThrow(/already closed/);
    expect(() => inbox.markPromoted(d.path, "t")).toThrow(/already closed/);
  });

  test("edit rewrites a draft's title and body; hand-added keys, workspace, created and the path stay (#3032)", () => {
    const d = inbox.add("最初の一行\n二行目", { title: "元の題", workspaceHint: "dak", now: new Date(2026, 8, 9, 10, 0, 0) });
    store.write(d.path, readFileSync(join(store.dir, d.path), "utf8").replace("---\n", "---\ntags: [zenn]\n"));
    const e = inbox.edit(d.path, { title: "直した題", text: "直した本文\r\n\r\n2 行目\n3 行目\n" });
    expect(e).toMatchObject({ path: d.path, title: "直した題", body: "直した本文\n\n2 行目\n3 行目", workspaceHint: "dak", created: d.created, status: "inbox" });
    expect(inbox.get(d.path)).toMatchObject({ title: "直した題", body: "直した本文\n\n2 行目\n3 行目", workspaceHint: "dak", created: d.created });
    expect(store.read(d.path).doc.frontmatter.tags).toEqual(["zenn"]);
    expect(inbox.list().filter((n) => n.title === "直した題").map((n) => n.path)).toEqual([d.path]);
    // without a title the title stays; a blank one falls back to the first line, as when adding
    expect(inbox.edit(d.path, { text: "本文だけ" }).title).toBe("直した題");
    expect(inbox.edit(d.path, { title: "  ", text: "一行目から\nあと" }).title).toBe("一行目から");
  });

  test("edit refuses promoted and closed notes (EEXIST) and an empty body, and leaves the file as it was (#3032)", () => {
    const empty = inbox.add("keep me", { now: new Date(2026, 8, 9, 11, 0, 0) });
    const before = readFileSync(join(store.dir, empty.path), "utf8");
    expect(() => inbox.edit(empty.path, { title: "x", text: " \r\n " })).toThrow(/empty/);
    expect(readFileSync(join(store.dir, empty.path), "utf8")).toBe(before);
    const promoted = inbox.add("promote me", { now: new Date(2026, 8, 9, 12, 0, 0) });
    inbox.markPromoted(promoted.path, "task_p");
    const closed = inbox.add("close me too", { now: new Date(2026, 8, 9, 13, 0, 0) });
    inbox.close(closed.path);
    for (const p of [promoted.path, closed.path]) {
      const raw = readFileSync(join(store.dir, p), "utf8");
      let code: string | undefined;
      try {
        inbox.edit(p, { text: "new" });
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).toBe("EEXIST");
      expect(readFileSync(join(store.dir, p), "utf8")).toBe(raw);
    }
  });

  test("closeDaemonNotes closes the daemon's notes once and leaves the user's drafts", () => {
    const store = new KnowledgeStore(join(root, "Knowledge-daemon-notes"), db);
    const inbox = new Inbox(store);
    const draft = inbox.add("my draft");
    // what the daemon wrote before #2866: a schedule's notice (source) and a workspace's note
    store.write("notes/2026-10-27-scan.md", "---\ntitle: 認証の値の検査\ncreated: 2026-10-27T03:00:00.000Z\nstatus: inbox\nsource:\n  schedule: sch_a\n  title: 検査\n---\nhits\n");
    const ws = inbox.add("origin は x、登録は y です", { title: "workspace app を使えません", workspaceHint: "app" });
    expect(inbox.list()).toHaveLength(3);
    expect(inbox.closeDaemonNotes(new Date("2026-10-29T00:00:00Z"))).toBe(2);
    expect(inbox.list().map((n) => n.path)).toEqual([draft.path]);
    // the files stay, closed
    expect(readFileSync(join(store.dir, "notes/2026-10-27-scan.md"), "utf8")).toContain("status: closed");
    expect(readFileSync(join(store.dir, ws.path), "utf8")).toContain("status: closed");
    expect(inbox.closeDaemonNotes()).toBe(0);
    // a write that fails is thrown, not counted as done (the boot logs it and tries again next time)
    const stuck = inbox.add("x", { title: "workspace other を使えません" });
    chmodSync(join(store.dir, stuck.path), 0o444);
    try {
      expect(() => inbox.closeDaemonNotes()).toThrow();
    } finally {
      chmodSync(join(store.dir, stuck.path), 0o644);
    }
    expect(inbox.closeDaemonNotes()).toBe(1);
    store.close();
  });

});
