import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db } from "./db.ts";
import { KnowledgeStore, parseDocument, toFtsQuery } from "./knowledge.ts";

let root: string;
let db: Db;
let store: KnowledgeStore;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sb-knowledge-"));
  db = new Db(join(root, "index.db"));
  const dir = join(root, "Knowledge");
  mkdirSync(join(dir, "rules"), { recursive: true });
  writeFileSync(
    join(dir, "rules", "dak.md"),
    `---\ntitle: DAK の規約\ntargets: [claude, codex, agents-md]\nrepo: /repos/dak\napproval: { confirm: ["docker-compose*.yml", ".github/**"] }\ntags: [dak]\n---\n## 規約\n- System ENABLES, Agent DECIDES\n- 変更にはテストを添える\n`,
  );
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(join(dir, "notes", "2026-09-05-bff-streaming.md"), `# BFF をストリーミング対応にする\n\nADK の /run_sse をそのまま SSE で中継すれば足りるはず\n`);
  writeFileSync(join(dir, "loose.md"), `no frontmatter, no heading\n`);
  store = new KnowledgeStore(dir, db);
});

afterAll(() => {
  store.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("knowledge store", () => {
  test("scan indexes markdown files, derives titles and kinds, keeps frontmatter", () => {
    const r = store.scan();
    expect(r.indexed).toBe(3); // README is only generated when the folder did not exist
    expect(r.errors).toEqual([]);
    const docs = store.list();
    const dak = docs.find((d) => d.path === "rules/dak.md")!;
    expect(dak.kind).toBe("rules");
    expect(dak.title).toBe("DAK の規約");
    expect(dak.frontmatter.targets).toEqual(["claude", "codex", "agents-md"]);
    expect(dak.frontmatter.approval?.confirm).toEqual(["docker-compose*.yml", ".github/**"]);
    expect(docs.find((d) => d.path === "notes/2026-09-05-bff-streaming.md")?.title).toBe("BFF をストリーミング対応にする");
    expect(docs.find((d) => d.path === "loose.md")).toMatchObject({ kind: "other", title: "loose" });
    // a second scan with nothing changed is a no-op
    expect(store.scan()).toEqual({ indexed: 0, removed: 0, errors: [] });
  });

  test("FTS5 trigram search matches substrings in body and title, ANDs terms, and returns snippets", () => {
    const hits = store.search("ストリーミング");
    expect(hits.map((h) => h.path)).toEqual(["notes/2026-09-05-bff-streaming.md"]);
    expect(hits[0]!.snippet).toContain("ストリーミング");
    expect(store.search("DECIDES tests").length).toBe(0); // AND semantics
    expect(store.search("DECIDES テスト")[0]?.path).toBe("rules/dak.md");
    expect(store.search("   ")).toEqual([]);
    expect(toFtsQuery('abc "def* gh')).toEqual({ fts: '"abc" AND "def"', like: ["gh"] });
    // two-kanji words are shorter than a trigram: they still work, as LIKE filters
    expect(store.search("規約").map((h) => h.path)).toEqual(["rules/dak.md"]);
    expect(store.search("DECIDES 規約").map((h) => h.path)).toEqual(["rules/dak.md"]);
    expect(store.search("DECIDES 存在しない")).toEqual([]);
  });

  test("write creates folders, indexes immediately; removed files leave the index on the next scan", () => {
    const doc = store.write("docs/new/idea.md", "---\ntitle: Idea\n---\nbody text here\n");
    expect(doc.title).toBe("Idea");
    expect(store.search("body text")[0]?.path).toBe("docs/new/idea.md");
    rmSync(join(store.dir, "docs", "new"), { recursive: true });
    expect(store.scan().removed).toBe(1);
    expect(store.list().some((d) => d.path === "docs/new/idea.md")).toBe(false);
  });

  test("paths are canonical, cannot escape the folder (also through symlinks), and only .md is served", () => {
    expect(() => store.resolve("../outside.md")).toThrow(/invalid|escapes/);
    expect(() => store.resolve("/etc/passwd")).toThrow(/invalid|escapes/);
    for (const bad of ["", ".", "notes\\x.md", ".git/config", "notes/.hidden.md", "../x.md", "notes/../../x.md"]) expect(() => store.canonical(bad)).toThrow(/invalid/);
    // spelling variants collapse onto one index key
    expect(store.canonical("notes/./x.md")).toBe("notes/x.md");
    expect(store.canonical("notes//x.md")).toBe("notes/x.md");
    expect(() => store.write("notes/x.txt", "x")).toThrow(/\.md/);
    expect(() => store.read("nope.md")).toThrow(/not found/);
    expect(() => store.read("rules")).toThrow(/not found/);
    // a symlink inside the folder pointing outside is neither indexed nor readable
    const outside = join(root, "outside.md");
    writeFileSync(outside, "# leak\n");
    symlinkSync(outside, join(store.dir, "docs", "leak.md"));
    store.scan();
    expect(store.list().some((d) => d.path === "docs/leak.md")).toBe(false);
    expect(() => store.read("docs/leak.md")).toThrow(/escapes/);
  });

  test("an unreadable file is reported, not fatal; API writes notify listeners", () => {
    const seen: number[] = [];
    const off = store.onChange((r) => seen.push(r.indexed));
    store.write("docs/notify.md", "# n\n");
    expect(seen).toEqual([1]);
    off();
    const p = join(store.dir, "docs", "unreadable.md");
    writeFileSync(p, "# x\n");
    chmodSync(p, 0o000);
    const r = store.scan();
    expect(r.errors.some((e) => e.startsWith("docs/unreadable.md"))).toBe(true);
    chmodSync(p, 0o644);
    expect(store.scan().errors).toEqual([]);
  });

  test("frontmatter: invalid shapes are reported, not fatal; BOM, CRLF, empty and scalar blocks are handled", () => {
    const { frontmatter, title } = parseDocument("---\ntargets: notalist\n---\n# H\n");
    expect(frontmatter._invalid).toContain("targets");
    expect(title).toBe("H");
    expect(parseDocument("---\nbad: [unclosed\n---\nx").frontmatter._invalid).toContain("yaml");
    expect(parseDocument("\uFEFF---\r\ntitle: 2026\r\n---\r\nbody\r\n")).toMatchObject({ frontmatter: { title: "2026" }, body: "body\r\n", title: "2026" });
    const empty = parseDocument("---\n---\n# After\n\n---\n\nrule\n");
    expect(empty.frontmatter).toEqual({});
    expect(empty.body.startsWith("# After")).toBe(true);
    expect(parseDocument("---\nhello\n---\n# S\n").frontmatter._invalid).toContain("mapping");
    expect(parseDocument("---\n- a\n---\n# S\n").frontmatter._invalid).toContain("mapping");
  });

  test("an unusable folder disables the store without throwing", () => {
    const blocked = join(root, "blocked-parent");
    writeFileSync(blocked, "not a dir");
    const s = new KnowledgeStore(join(blocked, "Knowledge"), db);
    expect(s.disabled).toBeTruthy();
    expect(s.scan()).toMatchObject({ indexed: 0 });
    expect(() => s.write("notes/x.md", "x")).toThrow(/unavailable/);
    s.close();
  });

  test("git status is informational and safe when the folder is not a repo", async () => {
    expect(await store.gitStatus()).toEqual({ isRepo: false, clean: null });
  });
});
