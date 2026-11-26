/**
 * What one Issue's body, labels and Project fields say: the sections of a body (the request it came from, the
 * acceptance criteria and their confirmations, the prerequisites, the screen image), the stage it is stuck at with the
 * action and the slot of that stage, and the item the screens and the selection read (`toItem`).
 */
import { POST_MERGE_KINDS, type BacklogAction, type BacklogItem, type BacklogStage, type BacklogSyncInfo } from "@switchboard/protocol";
import { pbiProgress, type PbiFacts } from "./pbi-progress.ts";
import type { ProcessDef } from "./process-defs.ts";
import { afterTime } from "../../../scripts/parallel-guard.ts";
import type { BacklogWorkspace } from "./backlog-gh.ts";

/** An Issue as `toItem` reads it (built from the stored records). */
export interface RawBacklogIssue {
  number: number;
  title: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  body: string;
  labels: { nodes: Array<{ name: string }> };
  subIssuesSummary: { total: number; completed: number; doneAt: string | null };
  projectItems: { nodes: Array<{ project: { number: number }; fieldValues: { nodes: Array<{ name?: string; number?: number; field?: { name: string } }> } }> };
}

/** The fence (``` / ~~~) open after `line`, given the one open before it; null = outside any fence. */
function fenceAfter(fence: string | null, line: string): string | null {
  const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
  if (fence) return marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker ? null : fence;
  return marker ?? null;
}

/**
 * The text under `## <name>` up to the next `## ` heading. Headings inside a ``` / ~~~ fence do not count: a request
 * keeps its original text in a fence, and that text may itself contain `## 派生 PBI` or `#12`.
 */
function section(body: string, name: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  let inside = false;
  for (const line of body.split("\n")) {
    const before = fence;
    fence = fenceAfter(fence, line);
    if (!before && !fence && /^## /.test(line)) {
      if (inside) break;
      inside = line.trim() === `## ${name}`;
      continue;
    }
    if (inside) out.push(line);
  }
  return out.join("\n");
}

/** The Issue a PBI came from: the first `#N` in its `## 元要望` section (null when it says "なし"). */
export function requestOf(body: string): number | null {
  const origin = /^## 元要望\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(body)?.[1] ?? "";
  const n = /#(\d+)/.exec(origin)?.[1];
  return n ? Number(n) : null;
}

/**
 * The length of a request's own words: the text of its `## 要望` section without the lines that open or close a fence,
 * trimmed; null = no such section, or one with no words in it (the caller then uses the whole body). A `## 要望` line
 * inside a fence is not the section (as in `section`). Other sections (`## 解釈メモ` …) do not count.
 */
export function requestTextChars(body: string): number | null {
  let fence: string | null = null;
  const kept: string[] = [];
  for (const line of section(body, "要望").split("\n")) {
    const before: string | null = fence;
    fence = fenceAfter(fence, line);
    if (before === fence) kept.push(line); // a line that opens or closes a fence changes it
  }
  const n = kept.join("\n").trim().length;
  return n > 0 ? n : null;
}

/**
 * Who said a request's words: the first `- 誰の言葉: <value>` line of the `## 出典` section (fence lines left out, as in
 * `requestTextChars`), when the value starts with one of the three; null otherwise.
 */
export function requestFromOf(body: string): BacklogItem["requestFrom"] {
  let fence: string | null = null;
  for (const line of section(body.replace(/\r\n/g, "\n"), "出典").split("\n")) {
    const before: string | null = fence;
    fence = fenceAfter(fence, line);
    if (before !== fence || fence) continue;
    const m = /^- 誰の言葉:\s*(利用者|エージェント|定期の検査)/.exec(line);
    if (m) return m[1] as NonNullable<BacklogItem["requestFrom"]>;
  }
  return null;
}

const CRITERIA = "## 到達点 / 受け入れ条件";
const CONFIRM_MARK = "（利用者確認:";

/**
 * The checkbox lines of a PBI's acceptance criteria, outside fences. `n` counts every checkbox line of the section
 * from 1, checked ones too, so checking one leaves the others' numbers; `line` = its index in `body.split("\n")`.
 */
export function criteria(body: string): Array<{ n: number; checked: boolean; text: string; line: number }> {
  const out: Array<{ n: number; checked: boolean; text: string; line: number }> = [];
  let fence: string | null = null;
  let inside = false;
  let left = false; // the first such section only, as section() reads it
  body.split("\n").forEach((raw, line) => {
    const before = fence;
    fence = fenceAfter(fence, raw);
    if (before || fence) return;
    if (/^## /.test(raw)) {
      left ||= inside;
      inside = !left && raw.trim() === CRITERIA;
      return;
    }
    const m = inside ? /^- \[([ xX])\] (.*)$/.exec(raw.replace(/\r$/, "")) : null;
    if (m) out.push({ n: out.length + 1, checked: m[1] !== " ", text: m[2]!.trimEnd(), line });
  });
  return out;
}

/** An inline code span: a run of backticks up to the next run of the same length (`` ` `` holds one). */
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;

/**
 * The acceptance criteria still waiting on the user's own check: unchecked lines with `（利用者確認: …）`. One
 * inside inline code does not count: a line that only names the form (a PBI's own description of the form) is not a confirmation.
 */
export function confirmationsOf(body: string): Array<{ n: number; text: string; after: string | null }> {
  return criteria(body).filter((c) => !c.checked && c.text.replace(CODE_SPAN, "").includes(CONFIRM_MARK)).map(({ n, text }) => ({ n, text, after: confirmAfterOf(text) }));
}

const POST_MERGE_MARK = "（マージの後:";

/**
 * The acceptance criteria that can only be checked after the merge: unchecked lines with `（マージの後: <kind>）`, kind
 * one of `POST_MERGE_KINDS`; 観測 says `（マージの後: 観測 期日 <ISO 8601 with a zone> 以降）` and `after` is that time
 * (null = none, or one `afterTime` cannot read). A mark inside inline code, or of another kind, does not count. The
 * first mark of a line is the one read.
 */
export function postMergeOf(body: string): Array<{ n: number; text: string; kind: BacklogItem["postMerge"][number]["kind"]; after: string | null }> {
  const out: ReturnType<typeof postMergeOf> = [];
  for (const c of criteria(body)) {
    if (c.checked) continue;
    const rest = c.text.replace(CODE_SPAN, "").split(POST_MERGE_MARK)[1];
    if (rest === undefined) continue;
    const mark = rest.split("）")[0]!.trim();
    const kind = POST_MERGE_KINDS.find((k) => k === mark.split(/[\s、,]/)[0]);
    if (!kind) continue;
    const due = kind === "観測" ? /期日\s+(\S+)\s*以降/.exec(mark)?.[1] : undefined;
    out.push({ n: c.n, text: c.text, kind, after: due !== undefined && !Number.isNaN(afterTime(due)) ? due : null });
  }
  return out;
}

/**
 * What `pbiProgress` (pbi-progress.ts) reads of a PBI, from its labels, body, Status and Tasks: the unchecked user-check
 * lines, the unchecked after-merge lines and how many other criteria are unchecked. `decided` / `held` are not in a body (`withConfirmDecisions` reads
 * them from the stored decisions); `status` null = not read.
 */
export function pbiFactsOf(i: { labels: string[]; body: string; status: string | null; tasks: { total: number; done: number } }): PbiFacts {
  const { confirms, postMerge, others } = bodyFactsOf(i.body);
  return { pbi: i.labels.includes("type:pbi"), decision: i.labels.includes("needs-decision"), status: i.status, tasks: { total: i.tasks.total, done: i.tasks.done }, others, confirms: [...confirms], postMerge: [...postMerge], decided: [], held: false };
}

/**
 * What `pbiFactsOf` reads of the body alone, by the body: a pure function's result, so the same body is the same answer
 * (a PBI whose body changed is read again, as its body is the key). Oldest first out past the limit, as `pathsIn`'s memo in
 * backlog-overlap.ts. The arrays are shared between reads: `pbiFactsOf` copies them out.
 */
const BODY_FACTS_MEMO_MAX = 4000;
const bodyFactsMemo = new Map<string, { confirms: readonly number[]; postMerge: readonly number[]; others: number }>();
function bodyFactsOf(body: string): { confirms: readonly number[]; postMerge: readonly number[]; others: number } {
  const hit = bodyFactsMemo.get(body);
  if (hit) return hit;
  const confirms = confirmationsOf(body).map((c) => c.n);
  // a line that carries both marks stays the user's check: one answer is not read two ways
  const postMerge = postMergeOf(body).map((c) => c.n).filter((n) => !confirms.includes(n));
  const others = criteria(body).filter((c) => !c.checked && !confirms.includes(c.n) && !postMerge.includes(c.n)).length;
  const facts = { confirms, postMerge, others };
  bodyFactsMemo.set(body, facts);
  if (bodyFactsMemo.size > BODY_FACTS_MEMO_MAX) bodyFactsMemo.delete(bodyFactsMemo.keys().next().value!);
  return facts;
}

/**
 * The time a confirmation line says to wait for: `（利用者確認: 期日 <ISO 8601 with a zone> 以降 — …）`, right after the
 * parenthesis as `confirmDecisionsOf`'s form is. Inline code does not count. null = no such time, or one `afterTime` cannot read
 * (no zone, not a time): the line is asked for as before.
 */
export function confirmAfterOf(text: string): string | null {
  const m = /（利用者確認:\s*期日\s*(\S+)\s*以降/.exec(text.replace(CODE_SPAN, ""));
  return m && !Number.isNaN(afterTime(m[1]!)) ? m[1]! : null;
}

/**
 * The decisions a confirmation line names to be checked by their answers: the `#n` run right after `回答で確かめる` inside
 * its `（利用者確認: …）` parentheses, e.g. `（利用者確認: 回答で確かめる #12, #34 — …）`. Inline code does not count, as in
 * `confirmationsOf`. `[]` = the line names none (or none readable): it stays the user's own check.
 */
export function confirmDecisionsOf(text: string): number[] {
  const m = /（利用者確認:\s*回答で確かめる\s*((?:#\d+(?:\s*[,、，]\s*)?)+)/.exec(text.replace(CODE_SPAN, ""));
  return m ? [...new Set([...m[1]!.matchAll(/#(\d+)/g)].map((x) => Number(x[1])))] : [];
}

/**
 * The prerequisites a PBI / Task names: the numbers on its body's first `**前提**:` line outside fences, e.g.
 * `**前提**: #12, #34（リリース）`; `（リリース）` right after one = its merge must reach the running release too. Free text
 * (「前提: #N が Done」, `## 依存関係`) is not read: nothing is guessed. `なし` = none; a number named twice is one.
 */
export function prereqsOf(body: string): Array<{ number: number; release: boolean }> {
  let fence: string | null = null;
  for (const raw of body.split("\n")) {
    const before = fence;
    fence = fenceAfter(fence, raw);
    if (before || fence || !raw.startsWith("**前提**:")) continue;
    const out = new Map<number, boolean>();
    for (const m of raw.matchAll(/#(\d+)(（リリース）)?/g)) out.set(Number(m[1]), !!out.get(Number(m[1])) || !!m[2]);
    return [...out].map(([number, release]) => ({ number, release }));
  }
  return [];
}

/**
 * The Task whose artifacts are a PBI's screen mockups: the first id on its body's first `**画面イメージ**:` line
 * outside fences (a full-width colon too), taken as a question's (`asks.ts`). null = no such line or no id on it.
 */
export function mockupTaskOf(body: string): string | null {
  let fence: string | null = null;
  for (const raw of body.split("\n")) {
    const before = fence;
    fence = fenceAfter(fence, raw);
    const m = before || fence ? null : /^\*\*画面イメージ\*\*[:：]\s*(.+)$/.exec(raw.trim());
    if (m) return /[\w-]+/.exec(m[1]!)?.[0] ?? null;
  }
  return null;
}

function field(raw: RawBacklogIssue, project: number, name: string) {
  const item = raw.projectItems.nodes.find((n) => n.project.number === project);
  return item?.fieldValues.nodes.find((v) => v.field?.name === name);
}

/** The label that keeps backlog-next off a request or PBI still being thought about. */
export const ON_HOLD_LABEL = "on-hold";
/** The label of a PBI that improves the development flow itself; at most `flowLimit` of them are in progress at once. */
export const FLOW_LABEL = "flow-improvement";

/**
 * The stage of one open Issue; null = not shown (a request that already has a PBI in its `## 派生 PBI`).
 * `needs-decision` (label) wins over the rest; a PBI's stage comes from the Project's Status.
 */
export function stageOf(raw: RawBacklogIssue, project: number): BacklogStage | null {
  const labels = raw.labels.nodes.map((l) => l.name);
  if (labels.includes("needs-decision")) return "needs-decision";
  if (!labels.includes("type:pbi")) return /#\d+/.test(section(raw.body, "派生 PBI")) ? null : "request";
  const status = field(raw, project, "Status")?.name;
  if (status === "Ready") return "ready";
  if (status === "In progress" || status === "In review") return "in-progress";
  return "needs-tasks";
}

/** The label a request carries after its direct Task came back without a change: the pipeline takes it from there. */
export const DIRECT_RETURNED_LABEL = "direct-returned";

/**
 * Which candidate a request starts in, from the candidates' own `auto` criteria (process-defs.ts; no value lives here):
 * `direct-returned` goes to the pipeline; otherwise the first candidate (in the order given) whose `auto` the request
 * meets (the request's `## 要望` text, or the whole body when it has none, ≤ `maxBodyChars`, none of `excludeLabels`); otherwise the pipeline. Pure and deterministic.
 */
export function chooseProcess(item: Pick<BacklogItem, "bodyChars" | "requestChars" | "labels">, defs: ProcessDef[]): { process: string; reason: string } {
  if (item.labels.includes(DIRECT_RETURNED_LABEL)) return { process: "p0-pipeline", reason: "direct returned" };
  const misses: string[] = [];
  const n = item.requestChars ?? item.bodyChars;
  const what = item.requestChars !== null ? "要望の文" : "本文";
  for (const d of defs) {
    const a = d.auto;
    if (!a) continue;
    const label = a.excludeLabels?.find((l) => item.labels.includes(l));
    if (label !== undefined) { misses.push(`${d.id}: ラベル ${label}`); continue; }
    if (a.maxBodyChars !== undefined && n > a.maxBodyChars) { misses.push(`${d.id}: ${what} ${n} 字 > ${a.maxBodyChars}`); continue; }
    return { process: d.id, reason: `auto direct: ${what} ${n} 字${a.maxBodyChars !== undefined ? ` ≤ ${a.maxBodyChars}` : ""}` };
  }
  return { process: "p0-pipeline", reason: `auto pipeline: ${misses.join(", ") || "自動の基準を持つ候補なし"}` };
}

export function toItem(raw: RawBacklogIssue, project: number, ws: Pick<BacklogWorkspace, "id" | "name">): BacklogItem | null {
  const stage = stageOf(raw, project);
  if (!stage) return null;
  const pbi = raw.labels.nodes.some((l) => l.name === "type:pbi");
  const status = field(raw, project, "Status")?.name ?? null;
  const tasks = pbi ? { total: raw.subIssuesSummary.total, done: raw.subIssuesSummary.completed, doneAt: raw.subIssuesSummary.doneAt } : null;
  const labels = raw.labels.nodes.map((l) => l.name);
  const progress = pbiProgress(pbiFactsOf({ labels, body: raw.body, status, tasks: tasks ?? { total: 0, done: 0 } }));
  // the lines asked now: an in-progress PBI's (a needs-decision label or not), none while a Task is open
  const confirmed = new Set(confirmationsOf(raw.body).map((c) => c.n));
  const confirmations = confirmationsOf(raw.body).filter((c) => progress.asked.includes(c.n));
  return {
    number: raw.number, title: raw.title, url: raw.url, type: pbi ? "pbi" : "request", stage,
    priority: field(raw, project, "Priority")?.name ?? null,
    storyPoints: field(raw, project, "Story Points")?.number ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    commentedAt: null,
    tasks,
    decision: null,
    activeTaskId: null,
    projectStatus: status,
    lastTask: null,
    replyWaiting: false,
    report: null,
    answeredAt: null,
    heldAt: null,
    confirmations,
    closable: progress.closable,
    autoHeld: null,
    postMerge: pbi ? postMergeOf(raw.body).filter((c) => !confirmed.has(c.n)) : [],
    progress: { closableByApi: progress.closableByApi, closesOnAnswer: progress.closesOnAnswer, checking: progress.checking },
    onHold: labels.includes(ON_HOLD_LABEL),
    claim: null,
    flow: labels.includes(FLOW_LABEL),
    bodyChars: raw.body.length,
    requestChars: requestTextChars(raw.body),
    kind: field(raw, project, "Kind")?.name ?? null,
    requestFrom: requestFromOf(raw.body),
    origin: pbi ? requestOf(raw.body) : null,
    labels,
    waits: [],
    waitsAt: null,
    waitsUntil: null,
    overlap: null,
    prereqs: [],
    events: [],
    stopSummary: [],
    mockupTask: pbi ? mockupTaskOf(raw.body) : null,
    mockups: [],
    sync: noSync,
    workspaceId: ws.id,
    workspaceName: ws.name,
  };
}

/** The sync of an item not read from the store (readStoredBacklog replaces it with `syncOf`). */
const noSync: BacklogSyncInfo = { state: "error", reason: "unfetched", lastSuccessfulSync: null, retryAt: null, pendingCount: 0, conflicts: [], guarantee: "A" };

export const ACTION_FOR_STAGE: Partial<Record<BacklogStage, BacklogAction>> = { request: "to-pbi", "needs-tasks": "to-tasks", ready: "complete", "in-progress": "check" };

/** backlog-next's two slots per workspace: implementing a PBI, and planning (to a PBI, to Tasks, a status check). */
export type Slot = "implement" | "plan";

export const SLOT_OF_ACTION: Record<BacklogAction, Slot> = { complete: "implement", close: "implement", "to-pbi": "plan", "to-tasks": "plan", check: "plan", direct: "plan" };

/** The stage actions that carry a change to the default branch (the implement slot): the others only read and write Issues. */
export const actionMerges = (action: BacklogAction): boolean => SLOT_OF_ACTION[action] === "implement";

/** The Issue numbers a request names in its `## 派生 PBI`, in the order written, each once. */
export function derivedPbisOf(body: string): number[] {
  return [...new Set([...section(body, "派生 PBI").matchAll(/(?<![\w/])#(\d+)/g)].map((m) => Number(m[1])))];
}
