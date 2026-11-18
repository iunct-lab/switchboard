// test-reads: CLAUDE.md private/CLAUDE.md AGENTS.md .claude/skills/ packages/core/src/skillsync.ts
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOC_RULES, docViolations, tellsATaskBy } from "../ops-kit/src/runner-docs.ts";

/**
 * This repository's half of the check that the documents a runner always reads say an operation in one way: the kit
 * checks its own skills with the same rules (ops-kit/src/skills.test.ts, ops-kit/src/runner-docs.ts) and cannot read
 * this repository's CLAUDE.md. Only the skills Git holds: the kit's copies under .claude/skills are outside Git. A tree
 * without Git (a ZIP) cannot tell them apart, so the skills are skipped there.
 */
const root = join(import.meta.dir, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const privateRules = "private/CLAUDE.md"; // the public copy has no private/
const ls = spawnSync("git", ["ls-files", ".claude/skills"], { cwd: root, encoding: "utf8" });
const trackedSkills = ls.status === 0 ? ls.stdout.split("\n").filter((f) => f.endsWith("/SKILL.md")) : [];
const docs = ["CLAUDE.md", "AGENTS.md", privateRules].filter((f) => existsSync(join(root, f)));
/** The kit's rules, with this app's own variable as the one that tells a Task (the kit names no app, so its skills name none). */
const RULES = [...DOC_RULES.filter((r) => r.name !== "telling a Task"), tellsATaskBy(/SWITCHBOARD_SUPERVISED|BACKLOG_URL|OPS_KIT_TASK_ID/, "SWITCHBOARD_TASK_ID")];
const violations = (f: string) => docViolations(read(f), f, RULES);

test("docs: CLAUDE.md, private/CLAUDE.md and the tracked skills say no other side of a decided operation", () => {
  expect([...docs, ...trackedSkills].flatMap(violations)).toEqual([]);
  // the rule catches the line CLAUDE.md once had, and the head the app once wrote on a placed skill
  expect(docViolations("- `SWITCHBOARD_SUPERVISED=1` なら自分は Switchboard の Task", "x", RULES)).toHaveLength(1);
  expect(docViolations("Task の外（SWITCHBOARD_SUPERVISED が無い）では原本を読む", "x", RULES)).toHaveLength(1);
  expect(docViolations("環境変数 `SWITCHBOARD_TASK_ID` があれば自分は Switchboard の Task（`SWITCHBOARD_SUPERVISED` は見分けには使わない）", "x", RULES)).toEqual([]);
});

test("docs: a working directory is made by the one form both runners can run", () => {
  for (const f of [...docs, ...trackedSkills]) expect({ f, has: read(f).includes("mktemp -d /tmp/") }).toEqual({ f, has: false });
  expect(read("CLAUDE.md")).toContain('W=$(mktemp -d "${TMPDIR:-/tmp}/switchboard.<用途>.XXXXXX")');
});

test("docs: CLAUDE.md names one variable for telling a Task", () => {
  const line = read("CLAUDE.md").split("\n").find((l) => l.includes("自分は Switchboard の Task"))!;
  expect(line).toContain("環境変数 `SWITCHBOARD_TASK_ID` があれば自分は Switchboard の Task");
  // the other variables a Task has are named on that line only to say they do not tell
  expect(line).toContain("どちらも Task かどうかの見分けには使わない");
  // what the app writes at the head of a skill it places says the same variable
  expect(read("packages/core/src/skillsync.ts")).toContain("Task の外（SWITCHBOARD_TASK_ID が無い）");
});

test.skipIf(!existsSync(join(root, privateRules)))("docs: private/CLAUDE.md says gh pr checks once, and the owner's decided values in one section", () => {
  const text = read(privateRules);
  expect(text.split("gh pr checks").length - 1).toBe(1);
  const section = text.slice(text.indexOf("## この所有者で決まっている値"), text.indexOf("## コードのコメントと Issue 番号"));
  for (const word of ["`SWITCHBOARD_ACTIONS` は `off`", "gh pr checks", "追加のレビュアー: 未設定", "`sb-offload` がある", "枝の保護: 2026-11-17 の時点では使っていない", "release（sb-rescue"]) expect(section).toContain(word);
  // a decided value is said in that section only
  for (const word of ["SWITCHBOARD_ACTIONS", "sb-offload", "追加のレビュアー"]) expect({ word, n: text.split(word).length - 1 }).toEqual({ word, n: section.split(word).length - 1 });
});

test("docs: CLAUDE.md and private/CLAUDE.md do not tell a Task to wait in a foreground loop", () => {
  for (const f of docs) {
    expect(violations(f).filter((v) => v.includes(": waiting — "))).toEqual([]);
    for (const word of ["前景の待ち", "ターンを保つ", "keep the turn alive", "foreground wait"]) expect({ f, word, has: read(f).includes(word) }).toEqual({ f, word, has: false });
  }
  expect(read("CLAUDE.md")).toContain("`job#<id>` を止まりの理由（reason `depends`）に書いてターンを終える（背景の `sleep` の待ちのループで待たない");
});
