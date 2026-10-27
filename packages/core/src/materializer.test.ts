import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { KnowledgeStore } from "./knowledge.ts";
import { apply, appliesTo, contentHash, plan, renderFile, splitManaged, targetsOf, unifiedDiff } from "./materializer.ts";

let root: string;
let db: Db;
let store: KnowledgeStore;
let ws: Workspace;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sb-mat-"));
  db = new Db(join(root, "index.db"));
  store = new KnowledgeStore(join(root, "Knowledge"), db);
  mkdirSync(join(root, "repo"), { recursive: true });
  expect(spawnSync("git", ["init", "-q", join(root, "repo")]).status).toBe(0);
  ws = { id: "ws1", name: "repo", path: join(root, "repo"), kind: "repo", createdAt: 0, backlog: "github", sweep: { implement: 1, plan: 1 } };
  store.write("rules/global.md", "---\ntargets: [claude, agents-md]\n---\n## 共通\n- 変更にはテストを添える\n");
  store.write("rules/repo.md", `---\ntargets: [claude]\nrepo: ${ws.path}\n---\n## このリポジトリ\n- bun test を回す\n`);
  store.write("rules/other.md", "---\ntargets: [claude]\nrepo: /elsewhere/other\n---\n## 無関係\n");
  store.write("commands/triage-deps.md", "依存を triage する手順\n");
  store.write("commands/dak/nightly.md", "夜間バッチ\n");
  store.write("notes/idea.md", "# アイデア\nまだ targets なし\n");
});

afterAll(() => {
  store.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const B = (source: string, body: string) => ({ source, hash: contentHash(body), body });

describe("managed blocks", () => {
  test("splitManaged separates handwritten text from blocks; markers count only as whole lines outside code fences", () => {
    const s = splitManaged("# Mine\n\n<!-- switchboard:managed rules/a.md @ abc123 -->\nbody\n<!-- /switchboard:managed -->\ntail\n<!-- switchboard:managed broken");
    expect(s.handwritten).toBe("# Mine\n\ntail\n<!-- switchboard:managed broken\n");
    expect(s.blocks).toEqual([{ source: "rules/a.md", hash: "abc123", body: "body" }]);
    // an example of the format inside a fence is documentation, not a block
    const doc = "intro\n```\n<!-- switchboard:managed x @ y -->\nexample\n<!-- /switchboard:managed -->\n```\nend\n";
    expect(splitManaged(doc)).toEqual({ handwritten: doc, blocks: [] });
    expect(renderFile(doc, [])).toBe(doc);
    // a marker mentioned mid-line is text
    const inline = "see <!-- switchboard:managed x @ y --> in docs\n";
    expect(splitManaged(inline).blocks).toEqual([]);
  });

  test("renderFile replaces blocks in place, drops orphans, appends new ones, keeps handwritten text byte-for-byte, and is idempotent", () => {
    const current = "# Hand written\n\nkeep me\n\n<!-- switchboard:managed rules/a.md @ old -->\nold a\n<!-- /switchboard:managed -->\n\n<!-- switchboard:managed rules/gone.md @ x -->\nbye\n<!-- /switchboard:managed -->\nafter\n";
    const blocks = [B("rules/a.md", "new a"), B("rules/b.md", "b body")];
    const next = renderFile(current, blocks);
    expect(next).toBe(`# Hand written\n\nkeep me\n\n<!-- switchboard:managed rules/a.md @ ${blocks[0]!.hash} -->\nnew a\n<!-- /switchboard:managed -->\n\nafter\n\n<!-- switchboard:managed rules/b.md @ ${blocks[1]!.hash} -->\nb body\n<!-- /switchboard:managed -->\n`);
    expect(renderFile(next, blocks)).toBe(next);
    expect(renderFile(null, [B("s", "x")])).toBe(`<!-- switchboard:managed s @ ${contentHash("x")} -->\nx\n<!-- /switchboard:managed -->\n`);
    // handwritten text without a trailing newline is kept as is when nothing is appended
    expect(renderFile("no newline", [])).toBe("no newline");
  });

  test("source paths with spaces round-trip through the marker", () => {
    const b = B("rules/my rule.md", "text");
    const once = renderFile(null, [b]);
    expect(once).toContain("rules/my%20rule.md @ ");
    expect(splitManaged(once).blocks[0]!.source).toBe("rules/my rule.md");
    expect(renderFile(once, [b])).toBe(once);
  });

  test("a close marker mentioned inside a block body cannot truncate the block (only whole lines count)", () => {
    const b = B("rules/a.md", "mention <!-- /switchboard:managed --> inline\nmore");
    const f = renderFile(null, [b]);
    expect(splitManaged(f).blocks[0]!.body).toBe(b.body);
    expect(renderFile(f, [b])).toBe(f);
  });

  test("unifiedDiff: hunks with context, merged when close, empty for equal inputs, newline-at-EOF changes visible", () => {
    expect(unifiedDiff("a\nb\n", "a\nb\n", "f")).toBe("");
    const d = unifiedDiff("a\nb\nc\nd\ne\n", "a\nB\nc\nd\ne\nf\n", "f");
    expect(d.startsWith("--- a/f\n+++ b/f\n@@ -1,5 +1,6 @@\n")).toBe(true);
    expect(d).toContain("-b\n+B\n");
    expect(d).toContain("+f\n");
    expect(d.match(/^@@/gm)).toHaveLength(1);
    expect(unifiedDiff("", "x\n", "f")).toContain("@@ -0,0 +1,1 @@");
    const nl = unifiedDiff("x", "x\n", "f");
    expect(nl).toContain("\\ No newline at end of file");
  });

  test("targetsOf keeps command namespaces; appliesTo matches repo paths exactly, not by basename", () => {
    const cmd = store.list().find((d) => d.path === "commands/dak/nightly.md")!;
    expect(targetsOf(cmd)).toEqual([{ target: "commands", relPath: ".claude/commands/dak/nightly.md" }]);
    const other: Workspace = { id: "x", name: "other", path: join(root, "other"), kind: "repo", createdAt: 0, backlog: "github", sweep: { implement: 1, plan: 1 } };
    const doc = store.list().find((d) => d.path === "rules/other.md")!; // repo: /elsewhere/other
    expect(appliesTo(doc, other)).toBe(false);
    expect(appliesTo(store.list().find((d) => d.path === "rules/repo.md")!, { ...ws, path: ws.path + "/" })).toBe(true);
  });
});

describe("user-level plan / apply", () => {
  const user = () => plan(store, { home: join(root, "user") });

  test("writes global rules and namespaced commands only at user level, warning for repo-scoped documents", () => {
    const preview = user();
    expect(preview.warnings.map((w) => w.path)).toEqual(["rules/other.md", "rules/repo.md"]);
    expect(preview.files.map((f) => f.relPath)).toEqual([".claude/CLAUDE.md", ".claude/commands/dak/nightly.md", ".claude/commands/triage-deps.md", ".codex/AGENTS.md"]);
    const claude = preview.files[0]!;
    expect(claude.sources).toEqual(["rules/global.md"]);
    expect(claude.abs).toBe(join(root, "user", ".claude", "CLAUDE.md"));
    expect(claude.next).not.toContain("このリポジトリ");
    expect(apply(preview.files).written).toHaveLength(4);
    expect(user().files.every((f) => f.status === "unchanged")).toBe(true);
    expect(existsSync(join(ws.path, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(ws.path, ".claude"))).toBe(false);
    const status = spawnSync("git", ["-C", ws.path, "status", "--short"], { encoding: "utf8" });
    expect(status.status).toBe(0);
    expect(status.stdout).toBe("");
  });

  test("repo commands with implicit targets warn; approval-only documents remain outside materialization", () => {
    store.write("commands/scoped.md", "---\nrepos: [/elsewhere]\n---\nscoped command\n");
    store.write("rules/approval.md", "---\nrepo: /elsewhere\napproval: auto\n---\napproval only\n");
    const preview = user();
    expect(preview.warnings.some((w) => w.path === "commands/scoped.md")).toBe(true);
    expect(preview.warnings.some((w) => w.path === "rules/approval.md")).toBe(false);
    expect(preview.files.some((f) => f.sources.includes("commands/scoped.md"))).toBe(false);
  });

  test("stale preview and hand edits are refused; force is explicit and handwritten text survives", () => {
    const claude = join(root, "user", ".claude", "CLAUDE.md");
    writeFileSync(claude, "# mine\n" + readFileSync(claude, "utf8").replace("- 変更にはテストを添える", "edited"));
    const p = user().files.find((f) => f.relPath === ".claude/CLAUDE.md")!;
    expect(p.conflicts).toEqual(["rules/global.md"]);
    expect(apply([p]).skipped[0]?.reason).toBe("conflict");
    expect(apply([p], { expected: { [p.relPath]: "wrong" }, force: true }).skipped[0]?.reason).toBe("stale");
    expect(apply([p], { force: true }).written).toEqual([p.relPath]);
    expect(readFileSync(claude, "utf8")).toStartWith("# mine\n");
  });

  test("workspace preview only removes blocks, preserves handwritten text, and never adds global rules", () => {
    const claude = join(ws.path, "CLAUDE.md");
    writeFileSync(claude, "# project\n" + renderFile(null, [B("rules/global.md", "old")]));
    mkdirSync(join(ws.path, ".claude", "commands"), { recursive: true });
    writeFileSync(join(ws.path, ".claude", "commands", "old.md"), renderFile(null, [B("commands/old.md", "old")]));
    const preview = plan(store, { home: join(root, "user"), workspace: ws });
    expect(preview.files.map((f) => f.sources)).toEqual([[], []]);
    expect(preview.files.find((f) => f.relPath === "CLAUDE.md")?.next).toBe("# project\n");
    const result = apply(preview.files);
    expect(result.removed).toEqual([".claude/commands/old.md"]);
    expect(readFileSync(claude, "utf8")).toBe("# project\n");
    expect(plan(store, { home: join(root, "user"), workspace: ws }).files).toEqual([]);
    expect(() => plan(store, { home: root, workspace: { ...ws, path: join(root, "missing") } })).toThrow(/does not exist/);
  });
});
