// Which question a Task may go on from with its own recommendation: decided by the reversibility table
// (`ops-kit/reversibility.json`) and by nothing else. The one who writes a `## 判断待ち` proposes the kind of the decision
// and the recommendation; whether the work may go on without the answer is read from the table here, by the lint and by
// the app alike. Everything the table does not list as compensable stops and asks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scopeIn } from "./task-paths.ts";

export const REVERSIBILITY_FILE = join(import.meta.dir, "..", "reversibility.json");

/** The table's part for questions: each question kind's answer, and the words that make any question stop. */
export interface AskTable { kinds: Map<string, string>; stops: string[] }

/**
 * The question kinds of the table (`askKind` rows) and its stop words (`askStops`). null = the table cannot be read or is
 * not in its shape: nothing goes on then.
 */
export function loadAskTable(path = REVERSIBILITY_FILE): AskTable | null {
  try {
    const t = JSON.parse(readFileSync(path, "utf8")) as { v?: unknown; rows?: unknown; askStops?: unknown };
    if (t.v !== 1 || !Array.isArray(t.rows) || !Array.isArray(t.askStops) || !t.askStops.length || !t.askStops.every((w) => typeof w === "string" && w.trim() !== "")) return null;
    const kinds = new Map<string, string>();
    for (const row of t.rows as Array<{ askKind?: unknown; answer?: unknown }>) {
      if (row === null || typeof row !== "object") return null;
      if (row.askKind == null) continue;
      // a kind in a wrong form, without an answer, or listed twice makes the whole table unreadable: no row is guessed
      if (typeof row.askKind !== "string" || !/^[a-z][a-z0-9-]*$/.test(row.askKind) || typeof row.answer !== "string" || kinds.has(row.askKind)) return null;
      kinds.set(row.askKind, row.answer);
    }
    return { kinds, stops: (t.askStops as string[]).map((w) => w.toLowerCase()) };
  } catch {
    return null;
  }
}

let cached: AskTable | null | undefined;
const table = (): AskTable | null => (cached === undefined ? (cached = loadAskTable()) : cached);

/** Each line outside fences (``` / ~~~): the same reading as core's prereqsOf. */
export function* unfenced(body: string): Generator<string> {
  let fence: string | null = null;
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const before = fence;
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    fence = fence ? (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker ? null : fence) : (marker ?? null);
    if (!before && !fence) yield line;
  }
}

/**
 * The 進め方 line of a `## 判断待ち` body (outside fences) as written: `**進め方**: 推奨で進める（種類: <kind>）` or
 * `**進め方**: 止めて待つ`, either followed by `— <理由>` or nothing. `kind` is what the writer proposes (null = none
 * named). null = no such line.
 */
export function proceedLine(body: string): { said: "recommended" | "wait"; kind: string | null } | null {
  for (const line of unfenced(body)) {
    const m = /^\*\*進め方\*\*:\s*(推奨で進める|止めて待つ)\s*(?:[（(]\s*種類\s*[:：]\s*([^）)\s]+)\s*[）)])?(?:\s|$)/.exec(line.trim());
    if (m) return { said: m[1] === "推奨で進める" ? "recommended" : "wait", kind: m[2] ?? null };
  }
  return null;
}

/**
 * Where a question stands, for the check of the kind its writer proposes: the Issue it is asked on, that Issue's PBI
 * with its Tasks, and the names at the top of the repository (what `scopeIn` reads paths against).
 */
export interface AskPlace {
  issue: { number: number; body: string; labels: string[] };
  /** The PBI the Issue belongs to (itself when it is one) and the numbers of that PBI's Tasks; null = not known. */
  pbi: { number: number; tasks: number[] } | null;
  /** Empty = not known (no checkout to read): no path can be checked. */
  top: { name: string; dir: boolean }[];
}

const within = (path: string, scope: string[]) => scope.some((s) => path === s || (s.endsWith("/") && path.startsWith(s)));

/**
 * Why the question is not of the kind its writer proposes, as far as its structure shows, or null. The kind is only a
 * proposal: `task-order` holds only for a question that names no file and no Issue or PR outside one PBI and its Tasks;
 * `implementation-choice` and `wording` only for a question on a Task's Issue whose every named path is inside what
 * that Task's body names (`scopeIn`, the merge gate's reading). Paths and numbers are read in the whole text, fences
 * and quotes too. What cannot be checked (the place is not known, the Task names no path, a kind with no rule here)
 * is refused: the work then stops and asks. A question that names nothing that would show its kind (no path in the
 * Task's range, no Task of the PBI) is refused too. This catches a wrong kind, not a wrong intention — the stop words
 * and the person's later answer are what is left.
 */
export function kindRefusal(kind: string, body: string, place: AskPlace | null): string | null {
  if (!place) return "問いの置かれた Issue を読めず、種類を確かめられない";
  if (!place.top.length) return "リポジトリの最上位の名前を読めず、問いが名指すパスを確かめられない";
  const named = scopeIn(body, place.top);
  if (kind === "task-order") {
    if (!place.pbi) return "問いの PBI とその Task を読めず、種類 task-order を確かめられない";
    if (named.length) return `種類 task-order の問いがファイルを名指している（${named[0]}）`;
    const family = new Set([place.pbi.number, ...place.pbi.tasks]);
    const other = [...body.matchAll(/#(\d+)/g)].map((m) => Number(m[1])).find((n) => !family.has(n));
    if (other !== undefined) return `種類 task-order の問いが PBI #${place.pbi.number} とその Task でないもの（#${other}）を挙げている`;
    const tasks = new Set(place.pbi.tasks);
    const mentioned = [...body.matchAll(/#(\d+)/g)].some((m) => tasks.has(Number(m[1])));
    return mentioned ? null : `種類 task-order の問いが PBI #${place.pbi.number} の Task を 1 つも名指していないので、順序の問いか確かめられない`;
  }
  if (kind === "implementation-choice" || kind === "wording") {
    const n = place.issue.number;
    if (!place.issue.labels.includes("type:task")) return `種類 ${kind} は Task の Issue に書いた問いだけ（#${n} は Task でないので、名指しの範囲を確かめられない）`;
    const scope = scopeIn(place.issue.body, place.top);
    if (!scope.length) return `Task #${n} の本文が触るファイルを名指していないので、範囲を確かめられない`;
    if (!named.length) return `種類 ${kind} の問いがパスを 1 つも名指していないので、Task #${n} の範囲の中か確かめられない`;
    const out = named.find((x) => !within(x, scope));
    return out === undefined ? null : `問いが Task #${n} の名指しの外のパス（${out}）を挙げている`;
  }
  return `種類 ${kind} を確かめる規則が無い`;
}

/**
 * Why a question that says 推奨で進める must stop and ask all the same, or null when the work may go on: the kind is
 * named, the table lists it as compensable, the question's structure agrees with that kind (`kindRefusal`; `place`
 * null = it cannot be checked, so it is refused), and the question's text has none of the table's stop words (a merge,
 * a promotion, a `[聞く]` reason, publishing, deleting, permissions, money, keys — a safety confirmation is never gone
 * on from, whatever kind its writer gave it). The words are looked for in the whole comment: a command in a code
 * fence or a quoted block is part of what is asked. A table that cannot be read stops everything.
 * The words are a list and miss what is said another way (the limits are in the design note on questions the work goes on from).
 * `tableRefusal` is the part that needs no place (the table and the words), for a reader that only reports and has no
 * checkout of the repository it reads (the lint of another repository); what decides whether work goes on uses this one.
 */
export function proceedRefusal(body: string, t: AskTable | null = table(), place: AskPlace | null = null): string | null {
  const kind = proceedLine(body)?.kind;
  return tableRefusal(body, t) ?? (proceedLine(body)?.said === "recommended" && kind ? kindRefusal(kind, body, place) : null);
}

/** The table's and the stop words' part of `proceedRefusal`. */
export function tableRefusal(body: string, t: AskTable | null = table()): string | null {
  const line = proceedLine(body);
  if (line?.said !== "recommended") return null;
  if (t === null) return "戻せるかの表（ops-kit/reversibility.json）を読めない";
  if (line.kind === null) return "種類が書かれていない（**進め方**: 推奨で進める（種類: <表の askKind>））";
  const answer = t.kinds.get(line.kind);
  if (answer === undefined) return `種類 ${line.kind} が戻せるかの表に無い`;
  if (answer !== "compensable") return `種類 ${line.kind} は表で ${answer}（推奨で進めてよいのは compensable の種類だけ）`;
  const text = body.toLowerCase();
  const word = t.stops.find((w) => text.includes(w));
  if (word) return `問いに安全の確認に当たる語（${word}）がある`;
  return null;
}
