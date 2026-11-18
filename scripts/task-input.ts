/**
 * What a Task's runner was given when it started, by where it came from, in characters: the app's preamble (the stop
 * report, the artifact fence, a recap), the request text, the workspace's rules, the instruction files (CLAUDE.md and
 * the like), the skill listing, the other things Claude Code attaches, and the first skill it loaded.
 *
 *   bun scripts/task-input.ts <task id> [--json] [--db <path>] [--projects <dir>]
 *
 * Reads the Switchboard database read-only (`--db`, else `$SWITCHBOARD_HOME/switchboard.db`, else
 * `~/.switchboard/switchboard.db`) for the Task's runner, session and folder, and Claude Code's record of that session
 * (`--projects`, else `$SWITCHBOARD_CLAUDE_PROJECTS`, else `~/.claude/projects`). Only Claude Code's Tasks: another
 * runner's exits 2. Exit 1 = no such Task or no record of its session on this machine.
 */
import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeProjectDirName } from "../packages/adapters/claude/src/history.ts";

export type InputRow = {
  /** Where the text came from: `preamble`, `request`, `workspace-rules`, `instructions`, `skill-listing`, `attachment:<type>`, `first-skill`. */
  route: string;
  /** What it is, for the table: a file's path, a skill's name, the number of skills. */
  detail: string;
  chars: number;
};
export type TaskInput = { rows: InputRow[]; total: number; app: number };

/** The heading of the block the app adds after a first prompt for a workspace's rules kept on its side (`workspaceRulesBlock`). */
const RULES_HEADING = "\n\n## このリポジトリの決まり（Switchboard の側に置いたもの。リポジトリの git には無い）\n\n";
const RECAP_HEAD = "【Switchboard からの引き継ぎ】";
const RECAP_END = "利用者の今回のメッセージ:";

/**
 * The first user message split into what the app put in front (its `[Switchboard: …]` sections, then a recap that
 * ends with the heading of the person's message), the request, and the workspace's rules after it.
 */
export function splitFirstMessage(text: string): { preamble: string; request: string; rules: string } {
  let at = 0;
  while (text.startsWith("[Switchboard:", at)) {
    const end = text.indexOf("\n\n", at);
    if (end < 0) return { preamble: text, request: "", rules: "" };
    at = end + 2;
  }
  if (text.startsWith(RECAP_HEAD, at)) {
    const end = text.indexOf(`${RECAP_END}\n\n`, at);
    if (end >= 0) at = end + RECAP_END.length + 2;
  }
  const rest = text.slice(at);
  const rules = rest.lastIndexOf(RULES_HEADING);
  return { preamble: text.slice(0, at).trimEnd(), request: rules < 0 ? rest : rest.slice(0, rules), rules: rules < 0 ? "" : rest.slice(rules).trimStart() };
}

type Line = { type?: string; isMeta?: boolean; message?: { role?: string; content?: unknown }; attachment?: Record<string, unknown> & { type?: string }; rendered?: unknown };

const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : typeof b?.content === "string" ? b.content : "")).join("") : "";

/**
 * The rows of a session record (`jsonl`, Claude Code's): the first user message, every attachment before the model's
 * first answer, and the first skill body loaded (the meta user message that opens with the skill's base directory).
 * An attachment counts by what the model was shown (`rendered`); one that shows nothing is left out.
 */
export function taskInput(jsonl: string): TaskInput {
  const rows: InputRow[] = [];
  let first = false;
  let answered = false;
  for (const raw of jsonl.split("\n")) {
    if (!raw.trim()) continue;
    let l: Line;
    try {
      l = JSON.parse(raw) as Line;
    } catch {
      continue; // a line still being written
    }
    if (l.type === "assistant") answered = true;
    if (l.type === "user" && !first && typeof l.message?.content === "string") {
      first = true;
      const { preamble, request, rules } = splitFirstMessage(l.message.content);
      rows.push({ route: "preamble", detail: "アプリの前置き", chars: preamble.length }, { route: "request", detail: "依頼の文", chars: request.length });
      if (rules) rows.push({ route: "workspace-rules", detail: "workspace の決まり", chars: rules.length });
    } else if (l.type === "attachment" && !answered && l.attachment) {
      const a = l.attachment;
      if (a.type === "instructions" && Array.isArray(a.files)) {
        for (const f of a.files as Array<{ path?: string; content?: string }>) rows.push({ route: "instructions", detail: f.path ?? "", chars: (f.content ?? "").length });
      } else if (a.type === "skill_listing") {
        rows.push({ route: "skill-listing", detail: `${typeof a.skillCount === "number" ? a.skillCount : Array.isArray(a.names) ? a.names.length : "?"} 本`, chars: typeof a.content === "string" ? a.content.length : textOf(l.rendered).length });
      } else {
        const chars = textOf(l.rendered).length;
        if (chars) rows.push({ route: `attachment:${a.type ?? "?"}`, detail: "", chars });
      }
    } else if (l.type === "user" && l.isMeta && first) {
      const body = textOf(l.message?.content);
      const m = /^Base directory for this skill: \S*?\/([^/\s]+)\s/.exec(body);
      if (m) {
        rows.push({ route: "first-skill", detail: m[1]!, chars: body.length });
        break;
      }
    }
  }
  const sum = (pick: (r: InputRow) => boolean) => rows.filter(pick).reduce((n, r) => n + r.chars, 0);
  return { rows, total: sum(() => true), app: sum((r) => r.route === "preamble" || r.route === "request" || r.route === "workspace-rules") };
}

export function renderInput(id: string, input: TaskInput): string {
  const lines = [`Task ${id} の開始時の入力（字数）`, "", "| 経路 | 中身 | 字数 |", "|---|---|---:|"];
  for (const r of input.rows) lines.push(`| ${r.route} | ${r.detail} | ${r.chars} |`);
  lines.push(`| 合計 | | ${input.total} |`, `| アプリが組んだ文（preamble + request + workspace-rules） | | ${input.app} |`);
  return lines.join("\n");
}

/** The Task's session record: exit code and message when there is none to read. */
export function readTaskSession(dbPath: string, projects: string, id: string): { jsonl: string } | { exit: 1 | 2; why: string } {
  if (!existsSync(dbPath)) return { exit: 1, why: `データベースがありません: ${dbPath}` };
  const db = new Database(dbPath, { readonly: true });
  try {
    const t = db.query("SELECT runner, runner_session_id AS session, cwd FROM tasks WHERE id = ?").get(id) as { runner: string; session: string | null; cwd: string } | null;
    if (!t) return { exit: 1, why: `Task ${id} がありません` };
    if (t.runner !== "claude") return { exit: 2, why: `未対応: ${t.runner} の Task（セッションの記録を読めるのは Claude Code の Task だけ）` };
    if (!t.session) return { exit: 1, why: `Task ${id} にセッションがありません（まだ始まっていない）` };
    const path = join(projects, claudeProjectDirName(t.cwd), `${t.session}.jsonl`);
    if (!existsSync(path)) return { exit: 1, why: `セッションの記録がこのマシンにありません: ${path}` };
    return { jsonl: readFileSync(path, "utf8") };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(name);
    return i < 0 ? undefined : argv.splice(i, 2)[1];
  };
  const dbPath = flag("--db") ?? join(process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard"), "switchboard.db");
  const projects = flag("--projects") ?? process.env.SWITCHBOARD_CLAUDE_PROJECTS ?? join(homedir(), ".claude", "projects");
  const json = argv.includes("--json");
  const id = argv.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("usage: bun scripts/task-input.ts <task id> [--json] [--db <path>] [--projects <dir>]");
    process.exit(2);
  }
  const read = readTaskSession(dbPath, projects, id);
  if ("exit" in read) {
    console.error(read.why);
    process.exit(read.exit);
  }
  const input = taskInput(read.jsonl);
  console.log(json ? JSON.stringify({ task: id, ...input }, null, 2) : renderInput(id, input));
}
