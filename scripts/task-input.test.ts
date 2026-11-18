// test-reads: none
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTaskSession, renderInput, splitFirstMessage, taskInput } from "./task-input.ts";

const PREAMBLE = "[Switchboard: 止まったときの報告]\n理由を報告してください。\n```switchboard-stop\n{}\n```\n\n[Switchboard: 成果物の登録]\nフェンスを書いてください。";
const RULES = "## このリポジトリの決まり（Switchboard の側に置いたもの。リポジトリの git には無い）\n\n枝は main から切る";
const line = (o: object) => JSON.stringify(o);

test("splitFirstMessage: the app's sections, a recap up to the heading of the person's message, the request, the workspace's rules", () => {
  expect(splitFirstMessage(`${PREAMBLE}\n\n/pbi-complete 9\n\n対象: #9。`)).toEqual({ preamble: PREAMBLE, request: "/pbi-complete 9\n\n対象: #9。", rules: "" });
  expect(splitFirstMessage(`${PREAMBLE}\n\n直して\n\n${RULES}`)).toEqual({ preamble: PREAMBLE, request: "直して", rules: RULES });
  const recap = "【Switchboard からの引き継ぎ】前のセッションは別の機械。\n\n<これまでのやり取り>\n利用者: p\n</これまでのやり取り>\n\n利用者の今回のメッセージ:";
  expect(splitFirstMessage(`${PREAMBLE}\n\n${recap}\n\n続けて`)).toEqual({ preamble: `${PREAMBLE}\n\n${recap}`, request: "続けて", rules: "" });
  // nothing in front (the insights schedule's Task, a session continued by its process)
  expect(splitFirstMessage("/insights")).toEqual({ preamble: "", request: "/insights", rules: "" });
});

test("taskInput counts each route up to the model's first answer, and the first skill it loaded", () => {
  const first = `${PREAMBLE}\n\n/pbi-complete 9\n\n${RULES}`;
  const skill = "Base directory for this skill: /w/.claude/skills/pbi-complete\n\n# pbi-complete\n本文";
  const jsonl = [
    line({ type: "session-owner" }),
    line({ type: "user", message: { role: "user", content: first } }),
    line({ type: "attachment", attachment: { type: "date" }, rendered: [{ content: "<system-reminder>今日</system-reminder>" }] }),
    line({ type: "attachment", attachment: { type: "skill_listing", content: "- a: x\n- b: y", skillCount: 2 }, rendered: [{ content: "<system-reminder>- a: x\n- b: y</system-reminder>" }] }),
    line({ type: "attachment", attachment: { type: "instructions", files: [{ path: "/w/CLAUDE.md", content: "決まり" }, { path: "/h/memory/MEMORY.md", content: "索引です" }] }, rendered: [{ content: "…" }] }),
    line({ type: "attachment", attachment: { type: "prompt_snapshot" } }), // shows the model nothing: not a row
    "{ a line still being written",
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "pbi-complete" } }] } }),
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
    line({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: skill }] } }),
    line({ type: "attachment", attachment: { type: "date" }, rendered: [{ content: "後の添付は数えない" }] }),
    line({ type: "user", isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /w/.claude/skills/task-to-pr\n\n2 本目" }] } }),
  ].join("\n");
  const input = taskInput(jsonl);
  expect(input.rows).toEqual([
    { route: "preamble", detail: "アプリの前置き", chars: PREAMBLE.length },
    { route: "request", detail: "依頼の文", chars: "/pbi-complete 9".length },
    { route: "workspace-rules", detail: "workspace の決まり", chars: RULES.length },
    { route: "attachment:date", detail: "", chars: "<system-reminder>今日</system-reminder>".length },
    { route: "skill-listing", detail: "2 本", chars: "- a: x\n- b: y".length },
    { route: "instructions", detail: "/w/CLAUDE.md", chars: 3 },
    { route: "instructions", detail: "/h/memory/MEMORY.md", chars: 4 },
    { route: "first-skill", detail: "pbi-complete", chars: skill.length },
  ]);
  expect(input.app).toBe(PREAMBLE.length + "/pbi-complete 9".length + RULES.length);
  expect(input.total).toBe(input.rows.reduce((n, r) => n + r.chars, 0));
  const table = renderInput("task_x", input);
  expect(table).toContain(`| skill-listing | 2 本 | ${"- a: x\n- b: y".length} |`);
  expect(table).toContain(`| アプリが組んだ文（preamble + request + workspace-rules） | | ${input.app} |`);
});

test("readTaskSession finds the record by the Task's folder and session; another runner's Task is exit 2, a missing one exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-task-input-"));
  try {
    const dbPath = join(dir, "switchboard.db");
    const db = new Database(dbPath);
    db.exec("CREATE TABLE tasks (id TEXT, runner TEXT, runner_session_id TEXT, cwd TEXT)");
    db.query("INSERT INTO tasks VALUES ('t1', 'claude', 'sess-1', '/home/u/repo.x'), ('t2', 'codex', 'sess-2', '/home/u/repo.x'), ('t3', 'claude', NULL, '/home/u/repo.x'), ('t4', 'claude', 'gone', '/home/u/repo.x')").run();
    db.close();
    const projects = join(dir, "projects");
    mkdirSync(join(projects, "-home-u-repo-x"), { recursive: true });
    writeFileSync(join(projects, "-home-u-repo-x", "sess-1.jsonl"), line({ type: "user", message: { content: "p" } }));
    expect(readTaskSession(dbPath, projects, "t1")).toEqual({ jsonl: line({ type: "user", message: { content: "p" } }) });
    expect(readTaskSession(dbPath, projects, "t2")).toMatchObject({ exit: 2, why: expect.stringContaining("未対応") });
    expect(readTaskSession(dbPath, projects, "t3")).toMatchObject({ exit: 1 });
    expect(readTaskSession(dbPath, projects, "t4")).toMatchObject({ exit: 1, why: expect.stringContaining("セッションの記録") });
    expect(readTaskSession(dbPath, projects, "nope")).toMatchObject({ exit: 1 });
    expect(readTaskSession(join(dir, "none.db"), projects, "t1")).toMatchObject({ exit: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
