import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

  test("addNotice marks the schedule, and closes only that schedule's earlier open notice (superseded_by)", () => {
    const src = { schedule: "sch_a", title: "検査" };
    const draft = inbox.add("my draft");
    const other = inbox.addNotice("other", { title: "other notice", source: { schedule: "sch_b", title: "別" } });
    const first = inbox.addNotice("one", { title: "notice one", source: src, now: new Date(2026, 8, 7, 4, 0, 0) });
    const second = inbox.addNotice("two", { title: "notice two", source: src, now: new Date(2026, 8, 8, 4, 0, 0) });
    const open = inbox.list().map((n) => n.path);
    expect(open).toContain(second.path);
    expect(open).not.toContain(first.path);
    expect(open).toContain(other.path);
    expect(open).toContain(draft.path);
    expect(inbox.get(second.path).source).toEqual(src);
    expect(inbox.get(draft.path).source).toBeUndefined();
    expect(readFileSync(join(store.dir, first.path), "utf8")).toContain(`superseded_by: ${second.path}`);
  });
});
