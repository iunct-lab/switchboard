/**
 * A workspace's GitHub backlog (#264; every registered workspace since #294): open requests and PBIs with the stage each one is stuck at. GitHub is the
 * source of truth; the DB keeps a copy of it (#885, backlog-sync.ts) that `readStoredBacklog` reads. One GraphQL query (100 Issues a page, the same shape as
 * scripts/setup/lint_backlog.sh) instead of one call per Issue, which is slow and runs into the secondary rate limit (#201).
 */
import type { Backlog, BacklogAction, BacklogCommentData, BacklogCreateInput, BacklogEditInput, BacklogFetchState, BacklogHeldEdit, BacklogIssueData, BacklogIssueDetail, BacklogItem, BacklogPrereq, BacklogProjectItemData, BacklogPullRequestData, BacklogRecord, BacklogSource, BacklogStage, BacklogSyncInfo, BacklogSyncState, GithubBudget } from "@switchboard/protocol";
import { applyBacklogField, BacklogResolveError, type BacklogLocalEntry, type BacklogOperation, type Db, type NewBacklogOperation } from "./db.ts";
import { conflictRevision, withoutMarker } from "./backlog-merge.ts";
import { closesOf } from "./backlog-sync.ts";
import { findSecrets, hostAws } from "../../../ops-kit/src/secrets.ts";
import { publicCopyRefusal } from "../../../ops-kit/src/config.ts";
import type { SetupScripts } from "./skillsync.ts";
import { judge, type Work } from "../../../scripts/parallel-guard.ts";
import { pathsIn } from "../../../scripts/task-paths.ts";
import { readdirSync } from "node:fs";
import type { StoredRecords } from "../../../ops-kit/src/backlog-client.ts";
import { parseIncluded, responseOf, retryAtFromResponse, type GithubFailure, type GithubResponse } from "../../../ops-kit/src/gh.ts";

export type GhRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** `gh` from PATH. A missing binary answers like a failed command so the caller reports it instead of throwing. */
export const runGh: GhRunner = async (args, cwd) => {
  try {
    const p = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: `gh を起動できません: ${(e as Error).message}` };
  }
};

/**
 * `response`: what GitHub answered to the failed call (status, headers, errors), to tell a limit from other failures (#894).
 * `kind`: what the owner has to do about it (#2362; BacklogErrorKind), when the place that called gh knows.
 */
export class BacklogError extends Error {
  constructor(message: string, readonly response?: GithubResponse, readonly kind?: "gh-login" | "project-var") {
    super(message);
  }
}

/** The workspace a backlog is read for: gh runs in `path`, and its items carry `id` / `name`. */
export interface BacklogWorkspace {
  id: string;
  name: string;
  path: string;
  /** Repository variable holding the Project URL (Workspace.projectVar); unset = SWITCHBOARD_PROJECT_URL. */
  projectVar?: string;
}

/** An Issue as `toItem` reads it (built from the stored records, #885). */
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

const CRITERIA = "## 到達点 / 受け入れ条件";
const CONFIRM_MARK = "（利用者確認:";

/**
 * The checkbox lines of a PBI's acceptance criteria (#523), outside fences. `n` counts every checkbox line of the section
 * from 1, checked ones too, so checking one leaves the others' numbers; `line` = its index in `body.split("\n")`.
 */
function criteria(body: string): Array<{ n: number; checked: boolean; text: string; line: number }> {
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
 * The acceptance criteria still waiting on the user's own check (#523): unchecked lines with `（利用者確認: …）`. One
 * inside inline code does not count: a line that only names the form (PBI #523's own) is not a confirmation.
 */
export function confirmationsOf(body: string): Array<{ n: number; text: string }> {
  return criteria(body).filter((c) => !c.checked && c.text.replace(CODE_SPAN, "").includes(CONFIRM_MARK)).map(({ n, text }) => ({ n, text }));
}

/**
 * The prerequisites a PBI / Task names (#937): the numbers on its body's first `**前提**:` line outside fences, e.g.
 * `**前提**: #12, #34（リリース）`; `（リリース）` right after one = its merge must reach the running release too. Free text
 * (「前提: #9 が Done」, `## 依存関係`) is not read: nothing is guessed. `なし` = none; a number named twice is one.
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
 * The Task whose artifacts are a PBI's screen mockups (#2296): the first id on its body's first `**画面イメージ**:` line
 * outside fences (a full-width colon too), taken as a question's (`asks.ts`, #2221). null = no such line or no id on it.
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

export function toItem(raw: RawBacklogIssue, project: number, ws: Pick<BacklogWorkspace, "id" | "name">): BacklogItem | null {
  const stage = stageOf(raw, project);
  if (!stage) return null;
  const pbi = raw.labels.nodes.some((l) => l.name === "type:pbi");
  const status = field(raw, project, "Status")?.name ?? null;
  // an in-progress PBI's, a needs-decision label or not (#523)
  const confirmations = pbi && (status === "In progress" || status === "In review") ? confirmationsOf(raw.body) : [];
  const tasks = pbi ? { total: raw.subIssuesSummary.total, done: raw.subIssuesSummary.completed, doneAt: raw.subIssuesSummary.doneAt } : null;
  return {
    number: raw.number, title: raw.title, url: raw.url, type: pbi ? "pbi" : "request", stage,
    priority: field(raw, project, "Priority")?.name ?? null,
    storyPoints: field(raw, project, "Story Points")?.number ?? null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
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
    closable: stage === "in-progress" && !!tasks && tasks.total > 0 && tasks.done === tasks.total && confirmations.length === 0,
    waits: [],
    waitsAt: null,
    overlap: null,
    prereqs: [],
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

const ACTION_NAME: Record<BacklogAction, string> = { "to-pbi": "PBI にする", "to-tasks": "Task に分解", complete: "実装", check: "状況確認", close: "閉じる" };

export function startTitle(item: Pick<BacklogItem, "number" | "title">, action: BacklogAction): string {
  return `#${item.number} ${ACTION_NAME[action]}: ${item.title}`;
}

/** backlog-next's two slots per workspace (#561): implementing a PBI, and planning (to a PBI, to Tasks, a status check). */
export type Slot = "implement" | "plan";

export const SLOT_OF_ACTION: Record<BacklogAction, Slot> = { complete: "implement", close: "implement", "to-pbi": "plan", "to-tasks": "plan", check: "plan" };

/** What `scripts/setup/` of another repository holds (`setupScripts`), for the instructions of a Task that runs there (#557). */
export interface OtherRepo {
  meta: string;
  projectVar?: string;
  setup: SetupScripts;
}

/**
 * How a Task on another registered workspace reads the skills and scripts, which are written for this repository
 * (a backlog stage Task, a request registered for that workspace).
 */
export function otherRepoRules(other: OtherRepo, local = false): string {
  const { meta, setup } = other;
  const projectUrl = `SWITCHBOARD_PROJECT_URL=$(gh variable get ${other.projectVar ?? "SWITCHBOARD_PROJECT_URL"})`;
  // a backlog kept in Switchboard only (#2265): no GitHub Issue, Project or its variable, so none of the setup scripts for them
  const own = !local && setup.config && setup.kit.length > 0; // the repository's own entries call the kit and it has its own ops.config.json
  const metaScripts = `${own ? "ほかのスクリプト" : "スクリプト"}（\`scripts/…\`）はこのリポジトリには無く、Switchboard のリポジトリ ${meta} からの相対パスです。そこにあるものを、このディレクトリから実行してください。`;
  const scripts = own
    ? `運用ツール（\`scripts/setup/\` の ${setup.kit.join("、")}）はこのリポジトリの入口を使ってください（共通キットを呼び、設定はこのリポジトリの \`ops.config.json\`。キットは \`OPS_KIT=${meta}/ops-kit\` を付けて渡す）。${metaScripts}`
    : metaScripts;
  const copies = !local && setup.copies.length > 0
    ? `このリポジトリの \`scripts/setup/\` の ${setup.copies.join("、")} は共通キットを呼ばない写しなので使わない。代わりに ${meta} の \`scripts/setup/\` の同じ名前の入口に \`${projectUrl}\` を付けて使う。`
    : "";
  const project = local ? LOCAL_BACKLOG_RULES : own ? "" : `Project の URL はリポジトリ変数 \`${other.projectVar ?? "SWITCHBOARD_PROJECT_URL"}\` にあり、Project を触るスクリプトには \`${projectUrl}\` を付けて渡す。`;
  return `スキル（\`.claude/skills/…\`）は Switchboard がこのリポジトリに置いたもの（Git 管理外）を使ってください。${scripts}${copies}スキルは Switchboard 向けに書かれているので、次のように読み替えてください: スキル中の「このリポジトリ」「開発リポジトリ」はこのリポジトリ。${project}${local ? "\`scripts/merge-gate.ts\`・\`scripts/local-ci.ts\`" : "\`scripts/merge-gate.ts\`・\`scripts/parallel-guard.ts\`・\`scripts/local-ci.ts\`"} の既定の対象は実行する場所（環境変数・作業ツリー・スクリプトの clone）で変わるので、必ず \`--repo <このリポジトリの owner/name>\` を付けて実行し、その判定に従う（自分で条件を確かめて代わりにしない）。再チェックの手順は \`${meta}/docs/merge-gate.md\` の「再チェック」（その中の \`-R <owner/name>\` と \`origin\` はこのリポジトリ。印は必ずこのリポジトリの PR に付ける）。Actions が始まらない（ジョブのステップ 0 件）ときは、このリポジトリの作業ツリーから \`bun ${meta}/scripts/local-ci.ts <PR> --repo <このリポジトリの owner/name>\` で CI を回す（作業ツリーの origin が \`--repo\` と違えば何も投稿せず exit 2）。回すのはスタックの一番上で 1 回（全部の PR の指摘の処理が済んでから。いつ回し、どう数えるかは \`${meta}/docs/merge-gate.md\` の「ローカル CI を回す時と数え方」）。PR をマージするたびに、\`git fetch origin\` のあと \`bun ${meta}/scripts/release-tag.ts $(git rev-parse origin/main) --repo <このリポジトリの owner/name>\` でそのマージにタグと Release を付け（タグの無い前のマージもその Release に入る）、出力を PBI の結果に書く。main をタグの状態に戻すときは \`bun ${meta}/scripts/rollback-pr.ts <tag> --repo <このリポジトリの owner/name>\` で PR を作り、ふつうの PR と同じくレビューと merge-gate を通してマージする。ビルド・テスト・ブランチ・コミットの決まりは、このリポジトリの CLAUDE.md / AGENTS.md / README がスキルと食い違えばこのリポジトリの方に従う。Switchboard のリポジトリ自体は変更しない。`;
}

/**
 * What a Task on a backlog kept in Switchboard only (#2265) does instead of GitHub's Issues and Project: the kit's
 * `ops-kit backlog` (it is given the workspace, BACKLOG_WORKSPACE) and `ops-kit lint --fresh`, and the parallel guard
 * without `--repo` (it writes its claims there too).
 */
export const LOCAL_BACKLOG_RULES = "Issue・Project のフィールド・Milestone・親子（sub-issue）・コメント・lint は `ops-kit backlog`（create / edit / comment / set / triage / view）と `ops-kit lint --fresh` だけで行い、`gh issue` / `gh project` / `gh api graphql` の Issue・Project の操作 / `scripts/setup/*` / Project の変数は使わない（GitHub にこの Issue は無い）。並列ガード（`scripts/parallel-guard.ts`）は `--repo` を付けずに実行する（占有と着手の印もアプリに書く）。PR・レビュー・CI・マージはリポジトリの PR で行う。ただし PR の本文・コミットには GitHub の閉じるキーワード（close / fix / resolve とその -s / -d 形）も `#<番号>` の形の Task・PBI の参照も書かない（番号は Switchboard の番号で、GitHub の同じ番号の別の Issue を閉じる・参照する）。Task は PR 本文の 1 行 `Backlog-Task: <番号>` と枝 `sb/<番号>-<topic>` で示す。PR をマージしたら `ops-kit backlog edit <Task> --state closed` で Task を閉じる（自動では閉じない）。";

/** The form of a ## 状況 (#522), the same in a 状況確認 and in a resume of a stalled PBI (#578). */
const REPORT_FORMAT = "`## 状況` で始まるコメントを 1 件書いてください。中身は `### 済んだこと` / `### 残り` / `### 止まっている理由`（動いているなら「動いている」とその Task）/ `### 次にやること`。";

/**
 * What a complete Task is asked for, so the runner's own approval reads the merge of a PR the merge gate passed as part of
 * the request (#1357), and so does its sharing of review material and the Issues the skills file (#2725). The same section as .claude/skills/pbi-complete/SKILL.md names; only `complete` carries it.
 */
const COMPLETE_SCOPE = "この依頼は、マージ判定（`scripts/merge-gate.ts`）が merge を返した PR のマージ、リリースタグ、PBI を閉じるところまでを含みます。.claude/skills/cross-runner-review/SKILL.md が渡すレビューの材料（fresh clone のコード、PR・Task・PBI の本文、差分）を別のランナー（Claude Code / Codex）と CLAUDE.md の追加のレビュアーに渡すこと、スキルの手順が作る Issue（レビュー指摘の Issue 化、要望 Issue と PBI）とコメントも、この依頼に含みます。マージのたびに利用者へ聞き直さないでください。マージ判定が `[聞く]` で止めたとき、昇格・デーモンの再起動、認証は、これまでどおり Task の会話で聞いてください（.claude/skills/pbi-complete/SKILL.md の「この依頼が含む範囲」）。";

/**
 * `other` = the Issue is in another registered workspace's repository: the Task runs there, using the stage skills synced
 * into that repository when the runner starts (docs/design/skill-sync.md); `other.meta` is only where `scripts/…` are.
 * The skills are written for this repository, so what to read differently is spelled out.
 *
 * `local` (#2265): the workspace's backlog is kept in Switchboard only — the Task works on it with `ops-kit backlog` alone.
 *
 * `resume` (#578): backlog-next resumes a stalled in-progress PBI, which had `tasksDone` closed Tasks when it was picked;
 * the ## 状況 it writes first carries that number, so the next firing leaves the PBI until another Task closes.
 *
 * `answer` (#2745): the newest `## 回答` the person gave on the screen (screenAnswer), put in the prompt as the person's
 * words — read with a tool, an operation it allows is not the person's say to the runner's approval. Not for a check.
 */
export function buildStartPrompt(item: Pick<BacklogItem, "number"> & Partial<Pick<BacklogItem, "tasks">>, action: BacklogAction, opts: { other?: OtherRepo; resume?: { tasksDone: number }; local?: boolean; answer?: { issue: number; text: string } | null } = {}): string {
  const n = item.number;
  const subIssues = item.tasks?.total ?? 0;
  const complete = opts.other ? `.claude/skills/pbi-complete/SKILL.md に従い、PBI #${n} を完了させてください。` : `/pbi-complete ${n}`;
  const body = {
    "to-pbi": `.claude/skills/request-to-backlog/SKILL.md に従い、既存の要望 Issue #${n} から PBI を作ってください（要望 Issue は新しく作らない。#${n} の原文を正本にする）。続けて .claude/skills/pbi-to-tasks/SKILL.md で、作った PBI を Ready にしてください。`,
    // a PBI in 分解待ち that already has sub-issues is waiting to be made Ready, not to be decomposed again (#1393)
    "to-tasks": subIssues > 0
      ? `PBI #${n} は Task（sub-issue ${subIssues} 件）に分解済みですが、Project の Status が Ready になっていません。.claude/skills/pbi-to-tasks/SKILL.md に従い、既にある Task を作り直さずに、最新の \`## 回答\` を PBI と Task に反映し、受け入れ条件の被覆と Task の粒度を確かめ、足りなければ Task を足して、PBI #${n} を Ready にしてください。`
      : `.claude/skills/pbi-to-tasks/SKILL.md に従い、PBI #${n} を Task に分解して Ready にしてください。`,
    // every complete, from Ready too: backlog-next also uses it to resume an in-progress PBI whose Task was answered (#562)
    // a resume names the skill's file: a slash command is expanded only at the start of a prompt
    complete: opts.resume
      ? `PBI #${n} は実装中のまま止まっています。sub-issue の Task（状態・PR）、関連する PR、受け入れ条件を確かめ、Issue #${n} に ${REPORT_FORMAT}その末尾に \`${TASKS_DONE_MARK(opts.resume.tasksDone)}\` を 1 行そのまま入れてください（この PBI を選んだ時点の閉じた Task の数。数え直さない。次に Task が閉じるか \`## 回答\` が付くまで、定期実行がこの PBI を再開しないための印です）。利用者の判断が要るもの（要件の読み・設計の選択・受け入れ条件の利用者確認など）があれば、.claude/skills/issue-workflow/SKILL.md の「判断待ちの出し方」で \`## 判断待ち\` を出して止めてください。無ければ続けて .claude/skills/pbi-complete/SKILL.md に従い、PBI #${n} を完了させてください。`
      : complete,
    check: `PBI #${n} の今の状況を確認してください。sub-issue の Task（状態・PR）、関連する PR（\`gh pr list -R <このリポジトリの owner/name> --state all --search "#${n}"\` と各 Task の PR。状態・レビュー・CI）、PBI の受け入れ条件（それぞれ満たされているか、検証の結果）、決定ログ・コメントを読み、Issue #${n} に ${REPORT_FORMAT}利用者の判断が要るもの（受け入れ条件の利用者確認など）があれば、.claude/skills/issue-workflow/SKILL.md の「判断待ちの出し方」で \`## 判断待ち\` を出してください。コードの変更・PR の作成やマージ・Issue のクローズ・Project の Status の変更はしないでください。これまでの \`## 回答\` は状況の材料として読むだけにし、その続きの作業はしないでください。`,
    close: `.claude/skills/pbi-complete/SKILL.md の「6. PBI を閉じる」に従い、PBI #${n} の受け入れ条件を検証結果つきで埋め、## 結果 を書いて閉じてください（Task は全部閉じ、利用者確認の項目も確認済みです）。`,
  }[action];
  const elsewhere = opts.local
    ? `\n\n#${n} はこの workspace の Switchboard のバックログの Issue です（GitHub には無い）。${opts.other ? otherRepoRules(opts.other, true) : LOCAL_BACKLOG_RULES}`
    : opts.other ? `\n\n#${n} はこのディレクトリのリポジトリ（\`gh repo view\` が答えるもの）の Issue です。${otherRepoRules(opts.other)}` : "";
  const answer = action === "check" ? "" : `始める前に Issue #${n} の最新の \`## 回答\` コメント${action === "complete" ? "（sub-issue の Task のものも）" : ""}を読み（\`ops-kit backlog view ${n} --fresh\`。アプリが GitHub と同期してから答え、GitHub に届かなければ保存値と未同期の印で答える）、あればそれに従って続きから進めてください。`;
  const scope = action === "complete" ? COMPLETE_SCOPE : "";
  // a fence longer than any run of backticks in the answer, so the answer cannot close it
  const fence = "`".repeat(Math.max(4, ...[...(opts.answer?.text.matchAll(/`+/g) ?? [])].map((m) => m[0].length + 1)));
  const said = opts.answer && action !== "check" ? `\n\n利用者が画面で答えた Issue #${opts.answer.issue} の最新の回答（利用者の言葉）:\n\n${fence}text\n${opts.answer.text}\n${fence}` : "";
  return `${body}\n\n対象: #${n}。${answer}${scope}${elsewhere}${said}`;
}

/** While any usage window of the runner the stage Tasks start on (after 上限のときの代わり, #834) is at or above this, the scheduler starts a stage Task only when none runs anywhere (#267, #561). The default of `quotaAndResume.backlogQuotaLimit` (#835). */
export const QUOTA_LIMIT = 0.8;
/** A usage window of the runner the stage Tasks start on at this has hit its limit: a stage Task would end at once, so the scheduler starts none until it resets (#1275). */
export const QUOTA_FULL = 1;

/**
 * Below this GraphQL budget left, a Task stopped by GitHub's limit is resumed at the budget's reset (`ratelimit.ts`, #549):
 * twice the heaviest read (`gh project item-list`, about 400 points; #547) still fits. A stage start does not wait on it (#2264).
 */
export const GITHUB_REMAINING_MIN = 1000;

/**
 * GitHub's GraphQL budget (#549), asked at most once per `ttlMs` (1 point a time): a failed read is kept as long as a
 * good one, so a gh that fails is not asked on every look; calls at the same time share one read. `null` = not known,
 * and a read that takes longer than `timeoutMs` is not known either (a stage button or the ledger does not hang on gh).
 * At 0 left GitHub refuses the read itself: a refusal for its primary limit is 0 left until the time GitHub gave.
 * While the host is waited for (`waiting`, BacklogSync's) nothing is asked: a primary
 * limit is 0 left until its end, another wait (or one whose kind is not known) is not known.
 */
export class GithubBudgetCache {
  private last: { at: number; value: Promise<GithubBudget | null> } | null = null;
  /** A read gh has not answered yet: a stuck gh is waited on again, not joined by one more process a minute. */
  private reading: Promise<GithubBudget | null> | null = null;
  /** The limit GitHub last said, for the budgets made without asking: GitHub's budget of a user until it says. */
  private limit = 5000;
  constructor(private readonly gh: GhRunner, private readonly ttlMs = 60_000, private readonly clock = () => Date.now(), private readonly timeoutMs = 10_000, private readonly waiting: () => { until: number; reason: GithubFailure | null } | null = () => null) {}

  get(cwd: string): Promise<GithubBudget | null> {
    const now = this.clock();
    const wait = this.waiting();
    if (wait) return Promise.resolve(wait.reason === "primary" ? { remaining: 0, limit: this.limit, resetsAt: Math.floor(wait.until / 1000) } : null);
    if (this.last && now - this.last.at < this.ttlMs) return this.last.value;
    if (!this.reading) {
      const reading = this.read(cwd);
      this.reading = reading;
      void reading.finally(() => { if (this.reading === reading) this.reading = null; });
    }
    const value = Promise.race([this.reading, Bun.sleep(this.timeoutMs).then(() => null)]);
    this.last = { at: now, value };
    return value;
  }

  private async read(cwd: string): Promise<GithubBudget | null> {
    const r = await this.gh(["api", "graphql", "--include", "-f", "query={ rateLimit { limit remaining resetAt } }"], cwd).catch(() => null);
    if (!r) return null;
    const { headers, body } = parseIncluded(r.stdout);
    if (r.code !== 0) {
      const limited = retryAtFromResponse(responseOf(r.stdout, r.stderr), this.clock());
      const limit = Number(headers["x-ratelimit-limit"]);
      if (limited?.kind !== "primary" || limited.at === null) return null;
      if (limit > 0) this.limit = limit;
      return { remaining: 0, limit: this.limit, resetsAt: Math.floor(limited.at / 1000) };
    }
    // the answer's own headers, when the body does not say (GitHub answers a limited read with 200 and errors — #550)
    const fromHeaders = (): GithubBudget | null => {
      const remaining = Number(headers["x-ratelimit-remaining"]);
      const limit = Number(headers["x-ratelimit-limit"]);
      const reset = Number(headers["x-ratelimit-reset"]);
      if (!Number.isFinite(remaining) || !Number.isFinite(reset) || headers["x-ratelimit-remaining"] === undefined || headers["x-ratelimit-reset"] === undefined) return null;
      if (limit > 0) this.limit = limit;
      return { remaining, limit: this.limit, resetsAt: reset };
    };
    try {
      const l = (JSON.parse(body) as { data?: { rateLimit?: { limit?: unknown; remaining?: unknown; resetAt?: unknown } } })?.data?.rateLimit;
      const resetsAt = typeof l?.resetAt === "string" ? Date.parse(l.resetAt) / 1000 : NaN;
      if (typeof l?.limit !== "number" || typeof l.remaining !== "number" || !Number.isFinite(resetsAt)) return fromHeaders();
      this.limit = l.limit;
      return { remaining: l.remaining, limit: l.limit, resetsAt };
    } catch {
      return fromHeaders();
    }
  }
}

const STAGE_ORDER: BacklogStage[] = ["ready", "needs-tasks", "request"];
const SLOT_STAGES: Record<Slot, BacklogStage[]> = { implement: ["ready"], plan: ["needs-tasks", "request"] };
/** Priority as an order: P0 first, unset last. */
export const priorityRank = (p: string | null) => (p && /^P[0-3]$/.test(p) ? Number(p[1]) : 4);

/**
 * An in-progress PBI answered since its last stage Task finished (#562): its newest ## 回答 (on it or a Task; answeredAt is
 * set for in-progress PBIs only, and a Task's open question makes the PBI needs-decision) is newer than when its last stage
 * Task — any stage, a status check too — last changed, which for a finished one is when it finished (the decision log of
 * #562). So an answer is taken up once. A PBI never started from the backlog has no last stage Task and is left to
 * whoever runs it.
 */
export const isAnswered = (i: BacklogItem) => i.stage === "in-progress" && !!i.answeredAt && !!i.lastTask && Date.parse(i.answeredAt) > i.lastTask.updatedAt;

const isFinished = (t: NonNullable<BacklogItem["lastTask"]>) => t.status === "done" || t.status === "error" || t.status === "aborted";
/**
 * Its last stage Task stopped for a reason and nothing about that stop changed since (#950): an open series (waiting /
 * exhausted) of that Task with no new cause, answer or condition met against its earlier stop, and it stopped before (or
 * ran out of retries, or still waits on a condition). Starting again would stop at the same place and ask the same thing,
 * so an update to the Issue alone — a label, an unrelated comment — does not release it. A new `## 回答` (isAnswered), a
 * wait that closed (isUnblocked), a person's answer to the stop or its condition met do. A condition met is read from
 * the item's own waits / prerequisites (`pr#12`, `issue#3`; #937), so it is not waited for in the runner's own report.
 */
export const stopHeld = (i: BacklogItem) => {
  const t = i.lastTask;
  if (!t || !isFinished(t) || releasedByReview(t) || isAnswered(i)) return false;
  // only the stop that came last decides: an older series that stayed the same does not hold back a new cause
  const s = i.stopSummary.filter((x) => x.work.taskId === t.id).sort((a, b) => b.lastAt - a.lastAt)[0];
  if (!s || (s.state !== "waiting" && s.state !== "exhausted")) return false;
  if (s.changes.some((c) => c.kind === "answer" || c.kind === "cause")) return false;
  const metByWait = (key: string) => {
    const m = /^(issue|pr)#(\d+)$/.exec(key);
    return !!m && [...i.waits, ...i.prereqs].some((w) => w.state === "met" && w.number === Number(m[2]) && (w.kind === null || w.kind === m[1]));
  };
  const unmet = s.conditions.filter((c) => !c.met && !metByWait(c.key));
  // a condition met lets it go only when none other still holds it back; a value moving while unmet is not a met one
  if (unmet.length === 0 && (s.changes.some((c) => c.kind === "condition-met") || s.conditions.some((c) => !c.met))) return false;
  return s.count >= 2 || s.state === "exhausted" || unmet.length > 0;
};

/** A request / 分解待ち / Ready item whose last stage Task was this stage's (from a button too). */
const triedThisStage = (i: BacklogItem) => STAGE_ORDER.includes(i.stage) && !!i.lastTask && i.lastTask.action === ACTION_FOR_STAGE[i.stage];

/**
 * Nothing changed since backlog-next last worked on it (#624): its last stage Task was this stage's, it has finished (in any
 * way), and the Issue has not been updated since — a comment, ## 回答, body or label counts, whoever wrote it (one account).
 * In-progress PBIs are #578's. A Task that ended asking the person and was marked reviewed does not hold it (#1275).
 */
export const isUnchanged = (i: BacklogItem) => triedThisStage(i) && isFinished(i.lastTask!) && !releasedByReview(i.lastTask!) && Date.parse(i.updatedAt) <= i.lastTask!.updatedAt;

/**
 * Its last stage Task failed (error / aborted) and the Issue was not updated since (#1275). A runner that could not run at
 * all (the usage limit, an organization's setting) ends the Task in seconds and leaves no mark on the Issue — not the
 * ## 状況 of #578 either — so without this an in-progress PBI was resumed every firing (26 times in 30 hours). Any stage. A Task closed since releases it too (`tasks.doneAt`, #1051), which asking the person (`awaitingReply`) does not.
 */
export const failedSince = (i: BacklogItem) =>
  !!i.lastTask && (i.lastTask.status === "error" || i.lastTask.status === "aborted") && !touchedSince(i) && !(i.tasks?.doneAt && Date.parse(i.tasks.doneAt) > i.lastTask.updatedAt);

/**
 * Something happened on the Issue since its last stage Task ended (#1275): the Issue itself was updated, or a ## 回答 came
 * on it or on one of its Tasks (`answeredAt`, which a child's answer sets without touching the parent's `updatedAt`).
 */
const touchedSince = (i: BacklogItem) => !!i.lastTask && (Date.parse(i.updatedAt) > i.lastTask.updatedAt || (!!i.answeredAt && Date.parse(i.answeredAt) > i.lastTask.updatedAt));

/** The person read the Task that ended asking them and marked it reviewed (#492): that releases the item in every stage (#1275). */
const releasedByReview = (t: NonNullable<BacklogItem["lastTask"]>) => t.outcome === "needs_action" && t.reviewedAt !== null;

/**
 * Its last stage Task ended asking the person in its own conversation (#1275): outcome needs_action (#492), not reviewed,
 * and the Issue not updated since. An operational question is asked in the Task, not on the Issue (CLAUDE.md), so the
 * Issue shows nothing; starting the stage again stops at the same question. A reply resumes the Task (then activeTaskId
 * holds the item), an update to the Issue — a ## 回答 too — or marking the Task reviewed lets it be picked again.
 */
export const awaitingReply = (i: BacklogItem) => !!i.lastTask && isFinished(i.lastTask) && i.lastTask.outcome === "needs_action" && i.lastTask.reviewedAt === null && !touchedSince(i);

/**
 * Its last stage Task, finished, stopped last on a series that waits for the person's decision (`next = "decide"`, #948).
 * backlog-next leaves such an item by `stopHeld`; the row shows it as waiting for a reply (#1619).
 */
const decidingStop = (i: BacklogItem) => {
  const t = i.lastTask;
  if (!t || !isFinished(t)) return false;
  const s = i.stopSummary.filter((x) => x.work.taskId === t.id).sort((a, b) => b.lastAt - a.lastAt)[0];
  return s?.next === "decide";
};

/** Its last stage Task waits for the person's reply (#1619): the item's `replyWaiting`, from the same judgment backlog-next skips by. */
export const isReplyWaiting = (i: BacklogItem) => awaitingReply(i) || decidingStop(i);

/** The stages a slot's firing picks from: its own, and for the implement slot the in-progress PBIs it resumes or closes (#578). */
const inSlot = (i: BacklogItem, slot: Slot) => SLOT_STAGES[slot].includes(i.stage) || (slot === "implement" && i.stage === "in-progress");

/** The items of a slot backlog-next leaves because their last stage Task ended asking the person (#1275). */
export const replyWaitingIn = (items: BacklogItem[], slot: Slot) =>
  items.filter((i) => inSlot(i, slot) && !i.activeTaskId && !isWaiting(i) && !isUnblocked(i) && awaitingReply(i));

/** The items of a slot backlog-next leaves because their last stage Task failed with no update to the Issue since (#1275); one asking the person is listed as that instead. */
export const failedIn = (items: BacklogItem[], slot: Slot) =>
  items.filter((i) => inSlot(i, slot) && !i.activeTaskId && !isWaiting(i) && !isUnblocked(i) && !awaitingReply(i) && failedSince(i));

/** Worked on at this stage before and updated since (#624): picked after the items of its slot not yet worked on. */
const isTriedBefore = (i: BacklogItem) => triedThisStage(i) && !isUnchanged(i);

/** The items of a slot backlog-next leaves because nothing changed since the last time (#624); a 閉じる that did not close, too (#578). */
export const unchangedIn = (items: BacklogItem[], slot: Slot) =>
  items.filter((i) => (SLOT_STAGES[slot].includes(i.stage) && isUnchanged(i)) || (inSlot(i, slot) && !i.activeTaskId && !isWaiting(i) && !isUnblocked(i) && stopHeld(i)) || (slot === "implement" && i.stage === "in-progress" && i.closable && !i.activeTaskId && !isWaiting(i) && !isAnswered(i) && !isClosable(i)));

/**
 * A Ready / in-progress PBI with a wait or a prerequisite not met (#817, #1046, #937): still open, not read, withdrawn,
 * in a cycle or not judged. backlog-next leaves it; its row's button does not.
 */
const isWaiting = (i: BacklogItem) => i.waits.some((w) => w.state !== "met") || i.prereqs.some((p) => p.state !== "met");

/**
 * A Ready / in-progress PBI whose waits closed or became deferred (#817).
 * waitsAt also preserves the resumption trigger when all parked PRs are removed from the current wait list.
 * It stopped with a release that came before its 実装 finished, so
 * isUnchanged does not hold it. Taken once: the 実装 it starts is a stage Task started after the waits, which makes them
 * old (server.ts withActive), and it claims and releases the PBI again.
 */
export const isUnblocked = (i: BacklogItem) => (i.stage === "in-progress" || i.stage === "ready") && i.waitsAt !== null && !isWaiting(i);

/**
 * The items of a slot backlog-next leaves because of their waits and prerequisites (#817, #937), with what holds each:
 * `pending` = not done yet (goes on by itself once done), `stuck` = withdrawn / missing / cycle / unknown (a person has
 * to act).
 */
export const heldIn = (items: BacklogItem[], slot: Slot) =>
  items
    .filter((i) => slot === "implement" && !i.activeTaskId && (i.stage === "ready" || i.stage === "in-progress") && isWaiting(i))
    .map((item) => {
      const held = [...item.waits, ...item.prereqs].filter((x) => x.state !== "met");
      return { item, pending: held.filter((x) => x.state === "pending"), stuck: held.filter((x) => x.state !== "pending") };
    });

/** An item whose 実装 would touch what other work touches, or cannot be judged (#1044). */
const isOverlapped = (i: BacklogItem) => !!i.overlap && (i.overlap.hits.length > 0 || i.overlap.unknown !== null);

/** The mark a resume of a stalled PBI ends its ## 状況 with (#578): how many of its Tasks were closed then. */
export const TASKS_DONE_MARK = (n: number) => `<!-- tasks-done: ${n} -->`;

/** The number in a ## 状況's tasks-done mark (#578); null = no report, or one without the mark (a 状況確認's). */
export function tasksDoneMark(report: { body: string } | null): number | null {
  const m = report && /<!-- tasks-done: (\d+) -->/.exec(report.body);
  return m ? Number(m[1]) : null;
}

/**
 * An in-progress PBI whose Tasks are all closed and whose confirmations are all answered (#578): backlog-next starts 閉じる
 * (#523). Left when its last stage Task was a 閉じる that finished with no update to the Issue since, so a 閉じる that
 * failed is not started again every firing.
 */
const isClosable = (i: BacklogItem) =>
  i.closable && !(i.lastTask?.action === "close" && isFinished(i.lastTask) && !releasedByReview(i.lastTask) && Date.parse(i.updatedAt) <= i.lastTask.updatedAt);

/** An in-progress PBI with Tasks left and nothing it waits on (#578): backlog-next resumes it (`complete`). */
const isStalled = (i: BacklogItem) => i.stage === "in-progress" && !!i.tasks && i.tasks.done < i.tasks.total;

/**
 * A resume that ended before writing its ## 状況 mark (#1051): the last stage Task is a finished 実装, and neither the
 * Issue (`updatedAt`), a Task closed since (`tasks.doneAt`) nor a ## 回答 is newer than that Task's start. A resume writes
 * its marked ## 状況 first, and a 実装 started from Ready writes the decision log of its start first, so either one that
 * got that far moved the Issue past the Task.
 */
const endedUnmarked = (i: BacklogItem) => {
  const t = i.lastTask;
  if (!t || t.action !== "complete" || !isFinished(t)) return false;
  const newer = (at: string | null | undefined) => !!at && Date.parse(at) > t.createdAt;
  return !newer(i.updatedAt) && !newer(i.tasks?.doneAt) && !newer(i.answeredAt);
};

/**
 * A stalled PBI not moved since its last resume (#578): its newest ## 状況 carries the tasks-done mark of as many closed
 * Tasks as now, and no ## 回答 came after that report; or the resume ended before writing a mark (`endedUnmarked`, #1051).
 * A resume that ended asking the person and was marked reviewed releases it too (#1275).
 */
const isSpinning = (i: BacklogItem) =>
  isStalled(i) &&
  ((tasksDoneMark(i.report) === i.tasks!.done && !(i.answeredAt && Date.parse(i.answeredAt) > Date.parse(i.report!.at))) || endedUnmarked(i)) &&
  !(i.lastTask && releasedByReview(i.lastTask));

/** The stalled PBIs backlog-next leaves because they did not move since their last resume (#578). */
export const spinningIn = (items: BacklogItem[], slot: Slot) =>
  items.filter((i) => slot === "implement" && !i.activeTaskId && !isWaiting(i) && !isAnswered(i) && isSpinning(i));

/**
 * The one item backlog-next moves on in a slot (#267, #561, #2929): the in-progress PBIs to finish first (回答済みの実装中 →
 * 待ちが解けた実装中 → 閉じられる実装中 → 止まった実装中), then Priority (P0 first, none last), then within one Priority
 * the items not yet worked on before those worked on and updated since, then the stage (Ready → 分解待ち → 要望), then the
 * oldest. Items waiting for a decision or with a running stage Task are left alone. An answered in-progress PBI goes on with 実装
 * (`complete`), not the in-progress button's 状況確認; so does one whose waits all closed (#817).
 * #624: an item unchanged since its last stage Task of the same stage is left too, and one updated since goes after the
 * items of the same Priority not yet worked on (an answered in-progress PBI still first).
 * #817: an item waiting for a PR / Issue still open is left, Ready or in progress.
 * #578: any other in-progress PBI is closed (`close`) when it can be, else resumed (`complete`, `resume: true`) unless it
 * did not move since its last resume (`spinningIn`).
 * #1051: a resume that ended before writing its mark is left too, until the Issue, a Task or an answer moves.
 * #1275: an item whose last stage Task failed, or ended asking the person, with no update to the Issue since is left in
 * any stage (`failedIn`, `replyWaitingIn`).
 */
export function pickNext(items: BacklogItem[], slot: Slot): { item: BacklogItem; action: BacklogAction; resume?: true } | null {
  // #1044: an 実装 (`complete`) that would touch what other work touches is not started; the next candidate goes instead
  return candidates(items, slot).find((c) => !(c.action === "complete" && isOverlapped(c.item))) ?? null;
}

/** The items of the 実装 slot backlog-next leaves for their files overlapping other work, or for that not being judged (#1044). */
export const overlapIn = (items: BacklogItem[], slot: Slot) => candidates(items, slot).filter((c) => c.action === "complete" && isOverlapped(c.item)).map((c) => c.item);

/** The items a slot may move on, in the order backlog-next takes them, each with what it would do. */
function candidates(items: BacklogItem[], slot: Slot): Array<{ item: BacklogItem; action: BacklogAction; resume?: true }> {
  const resumed = (i: BacklogItem) =>
    isAnswered(i) ? -4 : i.stage !== "in-progress" ? null : isUnblocked(i) ? -3 : isClosable(i) ? -2 : isStalled(i) && !isSpinning(i) ? -1 : null;
  const first = (i: BacklogItem) => resumed(i) ?? 0;
  const tried = (i: BacklogItem) => (isTriedBefore(i) ? 1 : 0);
  // #1275: a Task that failed or stopped asking, with no update to the Issue since, holds the item in any stage (an unblocked one still goes on, #817)
  const open = items.filter((i) => !i.activeTaskId && !isWaiting(i) && (isUnblocked(i) || (!isUnchanged(i) && !failedSince(i) && !awaitingReply(i) && !stopHeld(i))) && (SLOT_STAGES[slot].includes(i.stage) || (slot === "implement" && resumed(i) !== null)));
  // #2929: the in-progress ones to finish first, then Priority, then not yet worked on, then the stage, then the oldest
  open.sort(
    (a, b) =>
      first(a) - first(b) ||
      priorityRank(a.priority) - priorityRank(b.priority) ||
      tried(a) - tried(b) ||
      STAGE_ORDER.indexOf(a.stage) - STAGE_ORDER.indexOf(b.stage) ||
      a.createdAt.localeCompare(b.createdAt),
  );
  return open.map((item) => {
    const r = resumed(item);
    const action: BacklogAction = r === -2 ? "close" : r !== null ? "complete" : ACTION_FOR_STAGE[item.stage]!;
    return r === -1 ? { item, action, resume: true } : { item, action };
  });
}

export const DECISION_HEADING = "## 判断待ち";
export const ANSWER_HEADING = "## 回答";
/** A question put on hold (#936): not an answer — the label stays, nothing resumes, and the question is still the person's. */
export const HOLD_HEADING = "## 保留";
export const REPORT_HEADING = "## 状況";

type Comment = { body: string; createdAt: string };
type SubTask = { number: number; state: string; labels: { nodes: Array<{ name: string }> }; comments: { nodes: Comment[] } };
/** The newest comment that starts with `heading`; null when there is none. */
function latestHeading(comments: Comment[], heading: string): { body: string; at: string } | null {
  const c = comments.filter((x) => x.body.trimStart().startsWith(heading)).at(-1);
  return c ? { body: c.body, at: c.createdAt } : null;
}

/** The open question of a needs-decision item. */
export const latestDecision = (comments: Comment[]) => latestHeading(comments, DECISION_HEADING);

/**
 * When the question `d` was put on hold (#936): the newest `## 保留` after it; a ## 判断待ち asked after the hold reopens it.
 * A labelled Issue without its ## 判断待ち (null) is held by any `## 保留` on it.
 */
export function heldSince(comments: Comment[], d: { at: string } | null): string | null {
  const h = latestHeading(comments, HOLD_HEADING);
  // GitHub writes `…:00Z`, a comment kept here `…:00.000Z`: compared as times, not as text
  return h && (!d || Date.parse(h.at) > Date.parse(d.at)) ? h.at : null;
}

/**
 * The question an in-progress PBI waits on in one of its open Tasks (#562): the newest ## 判断待ち among the Tasks labelled
 * needs-decision; a labelled Task without one still holds the PBI (the label is the record) and says so. null = none waits.
 */
export function taskDecision(tasks: SubTask[], fallbackAt: string): NonNullable<BacklogItem["decision"]> | null {
  const waiting = tasks.filter((t) => t.state === "OPEN" && t.labels.nodes.some((l) => l.name === "needs-decision"));
  if (!waiting.length) return null;
  const asked = waiting.map((t) => ({ t, d: latestDecision(t.comments.nodes) })).filter((x) => x.d).sort((a, b) => a.d!.at.localeCompare(b.d!.at)).at(-1);
  if (asked) return { ...asked.d!, issue: asked.t.number };
  const t = waiting[0]!;
  return { body: `${DECISION_HEADING}\n（Task #${t.number} に「${DECISION_HEADING}」のコメントがありません。Issue を開いて確かめてください）`, at: fallbackAt, issue: t.number };
}

/** A /pbi-complete occupancy mark (scripts/parallel-guard.ts); a release may name what the PBI waits for (`waits=603,778`). */
const PBI_COMPLETE_MARK = /<!-- pbi-complete:(claim|takeover|release)(?: (\S+))? -->/;

/**
 * What a PBI waits for (#817) and when that was written: the numbers of its newest /pbi-complete mark when that is a
 * release with `waits=`, and no ## 回答 came after it. A later release without waits or a later claim clears it, so
 * nothing else has to. null = it waits for nothing.
 */
export function waitsOf(comments: Comment[]): { numbers: number[]; at: string; overlap: boolean } | null {
  let at = comments.length - 1;
  while (at >= 0 && !PBI_COMPLETE_MARK.test(comments[at]!.body)) at--;
  const m = at >= 0 ? PBI_COMPLETE_MARK.exec(comments[at]!.body) : null;
  const list = m?.[1] === "release" ? /^(?:waits|overlap)=(\d+(?:,\d+)*)$/.exec(m[2] ?? "")?.[1] : undefined;
  if (!list || comments.slice(at + 1).some((c) => c.body.trimStart().startsWith(ANSWER_HEADING))) return null;
  return { numbers: [...new Set(list.split(",").map(Number))], at: comments[at]!.createdAt, overlap: m![2]!.startsWith("overlap=") };
}

/** The last status report of an in-progress item (#522). */
export const latestReport = (comments: Comment[]) => latestHeading(comments, REPORT_HEADING);

/** The repository checked out at `cwd` and whether it is private (#2799). */
export async function repoOf(gh: GhRunner, cwd: string): Promise<{ repo: string; owner: string; name: string; private: boolean }> {
  const answer = (await call(gh, cwd, ["repo", "view", "--json", "nameWithOwner,isPrivate", "-q", '"\\(.nameWithOwner) \\(.isPrivate)"'])).trim();
  const [repo = "", visibility] = answer.split(/\s+/);
  const [owner, name] = repo.split("/");
  if (!owner || !name || (visibility !== "true" && visibility !== "false")) throw new BacklogError(`リポジトリを特定できません: ${answer.slice(0, 200)}`);
  return { repo, owner, name, private: visibility === "true" };
}

/**
 * The repository whose backlog the checkout at `cwd` imports and writes (`repoOf`). A clone of the public copy that
 * still resolves to it (`publicCopyRefusal`, #2467) is refused: its backlog is neither imported nor sent, and the
 * import's failure says how to point the clone at one's own repository. A read only (the secret scan) uses `repoOf`.
 */
export async function backlogRepoOf(gh: GhRunner, cwd: string): Promise<{ repo: string; owner: string; name: string; private: boolean }> {
  const r = await repoOf(gh, cwd);
  const refusal = publicCopyRefusal(r.repo, cwd);
  if (refusal) throw new BacklogError(refusal);
  return r;
}

/**
 * A workspace whose backlog is kept in Switchboard only (#2265): no GitHub Issue or Project. Its records are stored
 * under the workspace's id, so two of them never share a number.
 */
export const LOCAL_BACKLOG = { service: "switchboard", host: "local" } as const;
/** Its source: the Project is this workspace's stored data only (owner / number are what records are matched on, no Project elsewhere). */
export const localBacklogSource = (workspaceId: string): BacklogSource => ({ ...LOCAL_BACKLOG, repository: workspaceId, project: { owner: "switchboard", number: 0 } });

/**
 * Whether the workspace's backlog reads and writes its service's Issues — GitHub's Issues and Project (#2266), or a
 * GitLab project's Issues (#892): not one kept here only (#2265), nor one whose sync was turned off. null = a workspace
 * not imported yet. (The name is older than GitLab.)
 */
export const syncsGithub = (s: BacklogSource | null | undefined) => !s || (s.service !== "switchboard" && !s.disabled);

/* ---------- edits kept here and sent to GitHub later (#886) ---------- */

/** An edit refused before anything is stored; `status` = the HTTP status the API answers with. */
export class BacklogEditError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Refuses a text with a value that signs in or acts as the user (#661): it would be stored, then posted to GitHub. */
function refuseSecrets(...texts: Array<string | undefined>): void {
  const host = hostAws();
  for (const t of texts) {
    const hit = t ? findSecrets(t, host)[0] : undefined;
    if (hit) throw new BacklogEditError(`認証に使える値（${hit.kind}、${hit.line} 行目）が入っています。外してから保存してください`, 422);
  }
}

/** The names and text values of Project fields: what is stored and goes to GitHub as it is. */
const texts = (fields: Record<string, string | number | null> | null | undefined) => Object.entries(fields ?? {}).flatMap(([k, v]) => (typeof v === "string" ? [k, v] : [k]));
/** Fields to set, none when the map is empty: an empty map does not put an Issue in the Project. */
const someFields = (fields: Record<string, string | number | null> | null | undefined) => (fields && Object.keys(fields).length ? fields : undefined);

/**
 * What a stored record shows: an edit not sent yet over what GitHub answered, or one made here that GitHub does not have
 * yet. A record GitHub has that its last read did not get in full (404 / 403) shows nothing, edits or not.
 */
const shown = (r: BacklogRecord) => (r.fetchState === "fetched" || !r.remote ? (r.local ?? r.remote) : null);

/** The workspace's Project item of Issue n, as shown. */
const projectItemOf = (records: BacklogRecord[], source: BacklogSource, n: number) =>
  records.find((r) => {
    const v = r.objectKind === "project-item" ? (shown(r) as BacklogProjectItemData | null) : null;
    return !!v && v.issue === n && v.owner.toLowerCase() === source.project.owner.toLowerCase() && v.project === source.project.number;
  });

/** The Issue record of `ref`: a number, or the local id of an Issue made here (its create operation's id). */
/** The Issues' record ids by number, as issueRecord finds them: one GitHub no longer shows by the value kept here. */
const issueIds = (records: Iterable<BacklogRecord>) =>
  new Map([...records].flatMap((r) => {
    const n = ((r.local ?? r.remote) as BacklogIssueData | null)?.number;
    return n ? [[n, r.externalId] as const] : [];
  }));

/** A PBI's own record and its Tasks': an edit kept for one of them is the PBI's too (its stage and completion come from the Tasks). */
const familyOf = (own: string | undefined, subIssues: number[], ids: Map<number, string>) => new Set([own, ...subIssues.map((n) => ids.get(n))].filter((x): x is string => !!x));

function issueRecord(db: Db, source: BacklogSource, ref: number | string): BacklogRecord | null {
  // while the sync is being turned on (#2266) an Issue made here may still have the number of one of GitHub's: #N is GitHub's
  if (typeof ref === "number") return (ref > 0 && db.listBacklogRecords(source, "issue").filter((r) => ((r.local ?? r.remote) as BacklogIssueData | null)?.number === ref).sort((a, b) => Number(a.externalId.startsWith("sb:")) - Number(b.externalId.startsWith("sb:")))[0]) || null;
  const op = db.getBacklogOperation(ref);
  if (!op || op.kind !== "create" || op.repository !== source.repository || op.host !== source.host) return null;
  return db.getBacklogRecord({ ...source, objectKind: "issue", externalId: op.target });
}

/** The create operation of an Issue made here while it can still be changed (not sent yet; GitHub has not made it). */
const pendingCreate = (db: Db, source: BacklogSource, issue: string) => db.listPendingBacklogOperations(source).find((o) => o.kind === "create" && o.issue === issue && o.status === "pending" && !o.remoteId);

/** What a create sends (#886): the Issue's fields, and the Project it goes in with its fields. */
export interface BacklogCreatePayload {
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  milestone: string | null;
  parent: number | null;
  project: { owner: string; number: number; fields: Record<string, string | number | null> } | null;
}

/** A new Issue, kept until it is created on GitHub; read and edited by the returned local id until then and after. */
export function createStoredIssue(db: Db, source: BacklogSource, input: Omit<BacklogCreateInput, "workspaceId">, now = Date.now()): { localId: string } {
  refuseSecrets(input.title, input.body, input.milestone ?? undefined, ...input.labels, ...texts(input.fields));
  const localId = crypto.randomUUID();
  const at = new Date(now).toISOString();
  const draft: BacklogIssueData = { number: 0, title: input.title, url: "", state: "OPEN", stateReason: null, body: input.body, labels: input.labels, milestone: input.milestone, parent: input.parent, subIssues: [], createdAt: at, updatedAt: at, closedAt: null };
  const payload: BacklogCreatePayload = { title: input.title, body: input.body, state: "OPEN", labels: input.labels, milestone: input.milestone, parent: input.parent, project: someFields(input.fields) ? { ...source.project, fields: input.fields! } : null };
  const id = `local:${localId}`;
  db.applyBacklogEdit(source, { records: [{ objectKind: "issue", externalId: id, local: draft }], operations: [{ id: localId, issue: id, targetKind: "issue", target: id, kind: "create", payload }] }, now);
  return { localId };
}

/**
 * Edits a stored Issue (#886): each field that changes becomes an operation, sent later, made on the value shown now
 * (its `base`). An Issue not created yet has its create changed instead. Refused: an Issue not stored, one not read in
 * full (404 / 403 on its last read), a Project change of an Issue whose create is under way. Returns the operations.
 */
export function editStoredIssue(db: Db, source: BacklogSource, ref: number | string, input: Omit<BacklogEditInput, "workspaceId">, now = Date.now()): { localId: string | null; operations: string[] } {
  refuseSecrets(input.title, input.body, input.milestone ?? undefined, ...(input.labels?.add ?? []), ...texts(input.fields));
  const rec = issueRecord(db, source, ref);
  const cur = rec ? (shown(rec) as BacklogIssueData | null) : null;
  if (!rec || !cur) throw new BacklogEditError(rec?.remote ? `#${ref} は GitHub から読めていません（${rec.fetchState}）。再読込してから編集してください` : `#${ref} は保存されていません`, rec?.remote ? 409 : 404);
  const localId = rec.externalId.startsWith("local:") ? rec.externalId.slice("local:".length) : null;
  // a name both added and removed is removed, whether the Issue was made yet or not
  const added = (input.labels?.add ?? []).filter((l) => !input.labels?.remove.includes(l));
  const labels = (l: string[]) => [...new Set([...l, ...added])].filter((x) => !input.labels?.remove.includes(x));
  const create = pendingCreate(db, source, rec.externalId);
  if (create) {
    const p = create.payload as BacklogCreatePayload;
    const project = input.project === false ? null : input.project || someFields(input.fields) || p.project ? { ...source.project, fields: { ...p.project?.fields, ...input.fields } } : null;
    const next: BacklogCreatePayload = { title: input.title ?? p.title, body: input.body ?? p.body, state: input.state ?? p.state, labels: labels(p.labels), milestone: input.milestone === undefined ? p.milestone : input.milestone, parent: input.parent === undefined ? p.parent : input.parent, project };
    const { project: _, ...fields } = next;
    db.applyBacklogEdit(source, { records: [{ objectKind: "issue", externalId: rec.externalId, local: { ...cur, ...fields } }], operations: [{ issue: create.issue, targetKind: "issue", target: create.target, kind: "create", payload: next, replace: create.id }] }, now);
    return { localId, operations: [create.id] };
  }
  const issue = rec.externalId;
  const ops: NewBacklogOperation[] = [];
  const set = (field: string, value: unknown, base: unknown) => ops.push({ issue, targetKind: "issue", target: issue, kind: "set", field, payload: value, base });
  // the body as shown: without the marker a post sent from here left on it
  const was = { ...cur, body: withoutMarker(cur.body) };
  for (const f of ["title", "body", "state", "milestone", "parent"] as const) if (input[f] !== undefined && input[f] !== was[f]) set(f, input[f], was[f]);
  for (const l of added) if (!cur.labels.includes(l)) set(`label:${l}`, true, false);
  for (const l of input.labels?.remove ?? []) if (cur.labels.includes(l)) set(`label:${l}`, false, true);
  const records: BacklogLocalEntry[] = [];
  if (input.project !== undefined || someFields(input.fields)) {
    if (!cur.number) throw new BacklogEditError("作成を GitHub に送っている間は Project を変えられません。送り終えてから編集してください", 409);
    let item = projectItemOf(db.listBacklogRecords(source, "project-item"), source, cur.number);
    // taken out of the Project by an edit not sent yet: in it again undoes that
    const out = !!item && db.listPendingBacklogOperations(source).filter((o) => o.target === item!.externalId && o.field === "member").at(-1)?.payload === false;
    const member = (payload: boolean) => ops.push({ issue, targetKind: "project-item", target: item!.externalId, kind: "set", field: "member", payload, base: !!item!.remote });
    if (item && input.project === false && !out) {
      member(false);
      // one GitHub does not have yet is gone: not shown, and in the Project again makes a new one
      if (!item.remote) records.push({ objectKind: "project-item", externalId: item.externalId, local: null });
    }
    if (item && input.project !== false && out) member(true);
    const made = !item && input.project !== false;
    if (made) {
      const local: BacklogProjectItemData = { issue: cur.number, owner: source.project.owner, project: source.project.number, fields: { ...input.fields } };
      item = { ...source, objectKind: "project-item", externalId: `local:${crypto.randomUUID()}`, remote: null, base: null, local, fetchedAt: null, fetchState: "unfetched" };
      records.push({ objectKind: "project-item", externalId: item.externalId, local });
      member(true);
    }
    if (item && input.project !== false) {
      const fields = (shown(item) as BacklogProjectItemData).fields ?? {};
      for (const [name, v] of Object.entries(input.fields ?? {})) if (made || fields[name] !== v) ops.push({ issue, targetKind: "project-item", target: item.externalId, kind: "set", field: `field:${name}`, payload: v, base: made ? null : (fields[name] ?? null) });
      // an item GitHub does not have yet shows its fields here
      if (!made && !item.remote && input.fields) records.push({ objectKind: "project-item", externalId: item.externalId, local: { ...(shown(item) as BacklogProjectItemData), fields: { ...fields, ...input.fields } } });
    }
  }
  // an Issue the service does not have yet shows its edits here; one it has, on what it answered (rebaseBacklogRecord)
  if (!rec.remote) records.push({ objectKind: "issue", externalId: issue, local: ops.filter((o) => o.targetKind === "issue").reduce<unknown>((d, o) => applyBacklogField("issue", d, o.field!, o.payload), cur) });
  return { localId, operations: ops.length ? db.applyBacklogEdit(source, { records, operations: ops }, now) : [] };
}

/**
 * The user's choice on a held conflict of a stored Issue (#887): the held `set` of `field` (as the held edit names it)
 * goes to Db.resolveBacklogConflict with the revision the choice saw. 404 = no such Issue; 409 = no conflict held on
 * that field (an unknown field too), or the revision is old. Returns the operation chosen on.
 */
export function resolveStoredConflict(db: Db, source: BacklogSource, ref: number | string, resolve: NonNullable<BacklogEditInput["resolve"]>, now = Date.now()): { operation: string } {
  const rec = issueRecord(db, source, ref);
  if (!rec) throw new BacklogEditError(`#${ref} は保存されていません`, 404);
  const op = db.listPendingBacklogOperations(source).find((o) => o.issue === rec.externalId && o.kind === "set" && o.field === resolve.field && o.status === "conflict");
  if (!op) throw new BacklogEditError(`#${ref} の ${resolve.field} に保留中の競合はありません`, 409);
  try {
    db.resolveBacklogConflict(source, op.id, resolve.choice, resolve.expectedRevision, now);
  } catch (e) {
    if (e instanceof BacklogResolveError) throw new BacklogEditError(e.message, e.status);
    throw e;
  }
  return { operation: op.id };
}

/** What the check before a send, and the read with the history after it, keep and what they cannot (#887 方式 A, #1329 方式 1′): told with every stored Issue. */
export const SYNC_LIMITS =
  "GitHub に送る編集は、送る直前に GitHub の値を確かめ、編集の元から変わっていれば止めて競合として残します。本文・題・状態・ラベル・Milestone・親・Project の Status は、書いた直後に GitHub の編集履歴も読み、確かめてから書くまでの間にほかの人が書いていれば、その値を添えて競合として残します（版の内容が履歴に残っていれば、上書きした値を選んで戻せます。消されていれば編集者と時刻だけが残ります）。Status 以外の Project フィールド（Priority・Story Points・Phase など）には履歴が無く、本文・コメントは 100 版を超えて押し出された版が残らないので、そこは確かめてから書くまでの間の編集を上書きしうる（気づけない）ことがあります。履歴を読めなかったときは、書いた編集を未確認の競合として残します。同じ GitHub アカウントで GitHub の画面から書いた編集は、ほかの人の編集と区別しません（Switchboard の開発リポジトリの Issue #1329）。GitHub Project の自動化が動かした Status は編集として数えず競合にしません（手元の値を送ります。Issue が閉じたことで動いた Status は GitHub の値のままにします）。";

/** A comment kept here until it is sent: its record and its operation. `extra` goes with the operation (what an answer answers). */
function comment(issue: BacklogRecord, n: number, body: string, now: number, extra: object = {}): { record: BacklogLocalEntry; op: NewBacklogOperation } {
  const id = `local:${crypto.randomUUID()}`;
  const local: BacklogCommentData = { issue: n, body, createdAt: new Date(now).toISOString() };
  return { record: { objectKind: "comment", externalId: id, local }, op: { issue: issue.externalId, targetKind: "comment", target: id, kind: "comment", payload: { body, ...extra } } };
}

/**
 * `## 回答` + text on Issue n, then the needs-decision label off (#266), kept here and sent in that order (#886).
 * `screen` = the person gave it on the app's screen (#2745): its comment's operation keeps the mark screenAnswer reads.
 */
export function answerStoredDecision(db: Db, source: BacklogSource, n: number, text: string, now = Date.now(), opts: { screen?: boolean } = {}): void {
  refuseSecrets(text);
  const rec = issueRecord(db, source, n);
  if (!rec || !shown(rec)) throw new BacklogEditError(rec ? `#${n} は GitHub から読めていません（${rec.fetchState}）。再読込してから回答してください` : `#${n} は保存されていません`, rec ? 409 : 404);
  const c = comment(rec, n, `${ANSWER_HEADING}\n\n${text}`, now, opts.screen ? { screen: true } : {});
  db.applyBacklogEdit(source, { records: [c.record], operations: [c.op, { issue: rec.externalId, targetKind: "issue", target: rec.externalId, kind: "set", field: "label:needs-decision", payload: false, base: true }] }, now);
}

/**
 * The newest `## 回答` of Issue n and its sub-issues (a PBI and its Tasks) when the person gave it on the app's screen (#2745): its comment
 * was made here with the `screen` mark. null = there is none, or the newest came from GitHub (written there, or imported
 * only), from a saved policy, or was edited after it was given — only the screen's answer is the person's words to the next stage Task.
 */
export function screenAnswer(db: Db, source: BacklogSource, n: number): { issue: number; text: string } | null {
  const records = shownRecords(db, source);
  const item = records.find((r) => r.objectKind === "issue" && (r.remote as BacklogIssueData | null)?.number === n)?.remote as BacklogIssueData | undefined;
  const want = new Set([n, ...(item?.subIssues ?? [])]);
  const last = records
    .flatMap((r) => {
      const c = r.objectKind === "comment" ? (r.remote as BacklogCommentData | null) : null;
      return c && want.has(c.issue) && c.body.trimStart().startsWith(ANSWER_HEADING) ? [{ id: r.externalId, ...c }] : [];
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  if (!last) return null;
  // and only as it was given: a comment edited on GitHub after it was sent is not the screen's words any more
  const sent = db.listBacklogOperations(source).find((o) => o.kind === "comment" && o.target === last.id && (o.payload as { screen?: unknown } | null)?.screen === true);
  const given = (sent?.payload as { body?: unknown } | undefined)?.body;
  return typeof given === "string" && given.trim() === last.body.trim() ? { issue: last.issue, text: given.trimStart().slice(ANSWER_HEADING.length).trim() } : null;
}

/** `## 保留` + text on Issue n (#936), kept here and sent later: the needs-decision label stays (an answer would take it off). */
export function holdStoredDecision(db: Db, source: BacklogSource, n: number, text: string, now = Date.now()): void {
  refuseSecrets(text);
  const rec = issueRecord(db, source, n);
  if (!rec || !shown(rec)) throw new BacklogEditError(rec ? `#${n} は GitHub から読めていません（${rec.fetchState}）。再読込してから保留してください` : `#${n} は保存されていません`, rec ? 409 : 404);
  const c = comment(rec, n, text ? `${HOLD_HEADING}\n\n${text}` : HOLD_HEADING, now);
  db.applyBacklogEdit(source, { records: [c.record], operations: [c.op] }, now);
}

/** `## 判断待ち` + text on Issue n, then the needs-decision label on, kept here and sent in that order: answerStoredDecision turned round. */
export function askStoredDecision(db: Db, source: BacklogSource, n: number, text: string, now = Date.now()): void {
  refuseSecrets(text);
  const rec = issueRecord(db, source, n);
  if (!rec || !shown(rec)) throw new BacklogEditError(rec ? `#${n} は GitHub から読めていません（${rec.fetchState}）。再読込してから書いてください` : `#${n} は保存されていません`, rec ? 409 : 404);
  const c = comment(rec, n, `${DECISION_HEADING}\n${text}`, now);
  db.applyBacklogEdit(source, { records: [c.record], operations: [c.op, { issue: rec.externalId, targetKind: "issue", target: rec.externalId, kind: "set", field: "label:needs-decision", payload: true, base: false }] }, now);
}

/** A plain comment (text as written, no heading) on Issue n (#910), kept here and sent later; no label changes. */
export function commentStoredIssue(db: Db, source: BacklogSource, n: number, text: string, now = Date.now()): { operation: string } {
  refuseSecrets(text);
  const rec = issueRecord(db, source, n);
  if (!rec || !shown(rec)) throw new BacklogEditError(rec ? `#${n} は GitHub から読めていません（${rec.fetchState}）。再読込してからコメントしてください` : `#${n} は保存されていません`, rec ? 409 : 404);
  const c = comment(rec, n, text, now);
  const [operation] = db.applyBacklogEdit(source, { records: [c.record], operations: [c.op] }, now);
  return { operation: operation! };
}

/**
 * Answers confirmation `c.n` of PBI n (#523), kept here (#886): false (nothing stored) when that line of the body shown is
 * no longer an unchecked confirmation with `c.text`. `ok` checks the line (`- [ ]` → `- [x]`, the rest of the body byte
 * for byte, CRLF too; sent with the body it was made on, so a body changed on GitHub meanwhile is held, not overwritten)
 * and says it was confirmed; otherwise the body is left and `reason` is written. The labels are not touched.
 */
export function answerStoredConfirmation(db: Db, source: BacklogSource, n: number, c: { n: number; text: string; ok: boolean; reason: string }, now = Date.now()): boolean {
  refuseSecrets(c.reason);
  const rec = issueRecord(db, source, n);
  const body = rec ? (shown(rec) as BacklogIssueData | null)?.body : undefined;
  const line = body === undefined ? undefined : criteria(body).find((x) => x.n === c.n);
  if (!rec || body === undefined || !line || line.checked || line.text !== c.text || !confirmationsOf(body).some((x) => x.n === c.n)) return false;
  const head = `${ANSWER_HEADING}\n\n受け入れ条件 ${c.n}「${c.text}」`;
  const answer = comment(rec, n, c.ok ? `${head}を確認しました。${c.reason ? `\n\n${c.reason}` : ""}` : `${head}は違います: ${c.reason}`, now, { confirm: { n: c.n, text: c.text } });
  const ops = [answer.op];
  if (c.ok) {
    const lines = body.split("\n");
    lines[line.line] = lines[line.line]!.replace(/^- \[ \]/, "- [x]");
    ops.unshift({ issue: rec.externalId, targetKind: "issue", target: rec.externalId, kind: "set", field: "body", payload: lines.join("\n"), base: body });
  }
  db.applyBacklogEdit(source, { records: [answer.record], operations: ops }, now);
  return true;
}

async function call(gh: GhRunner, cwd: string, args: string[]): Promise<string> {
  const r = await gh(args, cwd);
  if (r.code !== 0) {
    // gh's own wording for a missing or refused login (#2362): the backlog then says to log in, not this text
    const login = /gh auth login|not logged in|authentication required/i.test(r.stderr) ? "gh-login" : undefined;
    throw new BacklogError(`gh ${args.slice(0, 2).join(" ")}: ${(r.stderr.trim() || `exit ${r.code}`).slice(0, 200)}`, responseOf(r.stdout, r.stderr), login);
  }
  // `gh api --include` puts the status and headers first: only the body is the answer
  return parseIncluded(r.stdout).body;
}

/** The Project a workspace's backlog reads, from the URL `…/<orgs|users>/<owner>/projects/<number>`. */
export interface BacklogProject {
  owner: string;
  number: number;
}

/**
 * The Project of the workspace: the repository variable the workspace names (its own naming), else
 * SWITCHBOARD_PROJECT_URL — from the environment or the repository variable, as the backlog scripts read it. The
 * environment applies to every workspace, so a workspace that names its variable is not overridden by it.
 */
export async function projectOf(gh: GhRunner, ws: Pick<BacklogWorkspace, "path" | "projectVar">): Promise<BacklogProject> {
  const varName = ws.projectVar ?? "SWITCHBOARD_PROJECT_URL";
  const variable = () => call(gh, ws.path, ["variable", "get", varName]).catch((e: unknown) => {
    // the variable is not set (#2362): the backlog then shows how to set up a Project, or to go without GitHub
    if (e instanceof BacklogError && !e.kind && /was not found/i.test(e.message)) throw new BacklogError(e.message, e.response, "project-var");
    throw e;
  });
  const projectUrl = (ws.projectVar ? await variable() : (process.env.SWITCHBOARD_PROJECT_URL ?? (await variable()))).trim();
  const parts = projectUrl.split("/");
  const number = Number(parts.at(-1));
  if (!Number.isInteger(number) || number <= 0) throw new BacklogError(`${varName} から Project 番号が取れません: ${projectUrl.slice(0, 200)}`);
  return { owner: parts.at(-3) ?? "", number };
}

/**
 * What an Issue or PR a PBI waits for is now (#817): its type, state (OPEN / CLOSED / MERGED), Draft, labels and, for
 * a PR, the Issues it closes (#1183; `[]` for an Issue).
 */
export interface WaitTarget {
  kind: "issue" | "pr";
  state: string;
  isDraft: boolean;
  labels: string[];
  closes: number[];
  /** An Issue's (#937); null for a PR, or not read. */
  stateReason: string | null;
  /** A merged PR's merge commit (#937); null otherwise. */
  mergeCommit: string | null;
}

/**
 * How one prerequisite stands (#937) from what is stored of it (`t`; undefined = not stored): an Issue is met when closed
 * as completed (or closed with no reason read), withdrawn when closed as not planned / a duplicate; a PR is met when
 * merged, withdrawn when closed unmerged. `release` needs the merge commit in the running release too (`released`; null
 * = cannot tell); an Issue cannot be released, so that is not judged. Open is pending, a Draft too.
 */
export function prereqState(t: WaitTarget | undefined, need: BacklogPrereq["need"], released: (oid: string) => boolean | null): BacklogPrereq["state"] {
  if (!t) return "missing";
  if (t.state === "OPEN") return "pending";
  if (t.kind === "issue") return t.stateReason === "NOT_PLANNED" || t.stateReason === "DUPLICATE" ? "withdrawn" : need === "release" ? "unknown" : "met";
  if (t.state !== "MERGED") return "withdrawn";
  if (need !== "release") return "met";
  const r = t.mergeCommit ? released(t.mergeCommit) : null;
  return r === null ? "unknown" : r ? "met" : "pending";
}

/** A wait's `open` as #821's screen reads it (#937): false = met, true = pending, null = anything else. */
const openOf = (state: BacklogPrereq["state"]) => (state === "met" ? false : state === "pending" ? true : null);

/** The items whose comments are read: needs-decision, in-progress, and Ready PBIs (their waits, #817). */
const askedOf = (items: BacklogItem[]) => items.filter((i) => i.stage === "needs-decision" || i.stage === "in-progress" || (i.stage === "ready" && i.type === "pbi"));
/** In-progress PBIs, whose Tasks are read too (#562). */
const buildingOf = (asked: BacklogItem[]) => asked.filter((i) => i.stage === "in-progress" && i.type === "pbi").map((i) => i.number);

/**
 * Gives the asked items what their comments say, wherever the comments came from (GitHub, or what is stored; #885):
 * needs-decision items their open question, in-progress ones their last status report, their Tasks' questions and their
 * newest answer. Returns the waits of Ready and in-progress PBIs (#817), for `withWaits`.
 */
function withComments(asked: BacklogItem[], building: number[], commentsOf: (n: number) => Comment[], tasksOf: (n: number) => SubTask[]): Map<BacklogItem, { numbers: number[]; at: string; overlap: boolean }> {
  const waiting = new Map<BacklogItem, { numbers: number[]; at: string; overlap: boolean }>();
  for (const i of asked) {
    const nodes = commentsOf(i.number);
    if (i.stage === "needs-decision") {
      const d = latestDecision(nodes);
      i.decision = d && { ...d, issue: i.number };
      i.heldAt = heldSince(nodes, d);
      continue;
    }
    if (i.stage === "ready") {
      const w = waitsOf(nodes);
      if (w) waiting.set(i, w);
      continue;
    }
    if (!building.includes(i.number)) {
      i.report = latestReport(nodes);
      continue;
    }
    const tasks = tasksOf(i.number);
    i.answeredAt = [nodes, ...tasks.map((t) => t.comments.nodes)].map((c) => latestHeading(c, ANSWER_HEADING)?.at).filter((a): a is string => !!a).sort().at(-1) ?? null;
    const d = taskDecision(tasks, i.updatedAt);
    if (d) {
      // a Task's question holds its PBI (#562): shown and answered where the PBI's own questions are
      i.stage = "needs-decision";
      i.decision = d;
      i.heldAt = heldSince(tasks.find((t) => t.number === d.issue)?.comments.nodes ?? [], d);
    } else {
      i.report = latestReport(nodes);
      const w = waitsOf(nodes);
      if (w) waiting.set(i, w);
    }
  }
  return waiting;
}

/**
 * The PBI that moves a wait forward (#1183), from the stored Issues: an Issue that is a PBI is its own, else its
 * parent; a PR's is the first one the Issues it closes give. null = none found (不明).
 */
function pbiOf(n: number, t: WaitTarget, issues: Map<number, BacklogIssueData>): BacklogItem["waits"][number]["pbi"] {
  const ofIssue = (m: number) => {
    const issue = issues.get(m);
    if (issue?.labels.includes("type:pbi")) return { number: m, title: issue.title };
    if (issue?.parent) return { number: issue.parent, title: issues.get(issue.parent)?.title ?? null };
    return null;
  };
  if (t.kind === "issue") return ofIssue(n);
  for (const m of t.closes) {
    const pbi = ofIssue(m);
    if (pbi) return pbi;
  }
  return null;
}

/**
 * Gives each waiting item its waits with their states, why it waits (#1046) and the PBI that moves each forward
 * (`pbiOf`). A number with no known state stays, with `open: null`: not taken as closed.
 */
function withWaits(waiting: Map<BacklogItem, { numbers: number[]; at: string; overlap: boolean }>, targets: Map<number, WaitTarget>, issues: Map<number, BacklogIssueData>): void {
  for (const [i, w] of waiting) {
    const reason = w.overlap ? ("overlap" as const) : ("prerequisite" as const);
    i.waits = w.numbers.flatMap((n): BacklogItem["waits"] => {
      const t = targets.get(n);
      if (!t) return [{ number: n, kind: "issue", open: null, state: "missing", reason, pbi: null }];
      const decision = t.labels.includes("needs-decision");
      // These PRs are deliberately parked, not prerequisites that must be completed first.
      if (t.kind === "pr" && (t.isDraft || decision)) return [];
      if (w.overlap && t.kind === "issue" && decision) return [];
      // an overlap is over once the other side closes; a prerequisite only once it is done (#937)
      const state = w.overlap ? (t.state === "OPEN" ? "pending" : "met") : prereqState(t, t.kind === "pr" ? "merged" : "done", () => null);
      return [{ number: n, kind: t.kind, open: openOf(state), state, reason, pbi: pbiOf(n, t, issues) }];
    });
    i.waitsAt = w.at;
  }
}

/**
 * Gives each Ready / in-progress PBI its prerequisites (#937) with their states: those its body names (`via` null), and
 * those its open Tasks name, other than the PBI's own open Tasks (their order is the PBI's own business), when every
 * open Task has one not met. One that is still pending and leads back to the PBI (or to the Task naming it) along the
 * open Issues' prerequisites — a PBI leading on to its open Tasks' — is a `cycle`.
 */
function withPrereqs(items: BacklogItem[], issues: Map<number, BacklogIssueData>, targets: Map<number, WaitTarget>, released: (oid: string) => boolean | null): void {
  const named = (n: number) => {
    const i = issues.get(n);
    return i?.state === "OPEN" ? prereqsOf(i.body) : [];
  };
  const openTasks = (n: number) => (issues.get(n)?.subIssues ?? []).filter((m) => issues.get(m)?.state === "OPEN");
  // only open Issues lead on: a closed PBI's Tasks left open do not hold anything
  const next = (n: number) => (issues.get(n)?.state === "OPEN" ? [n, ...openTasks(n)] : []).flatMap((m) => named(m).map((p) => p.number));
  const leadsTo = (from: number, to: number[]) => {
    const seen = new Set<number>();
    for (const queue = [from]; queue.length; ) {
      const n = queue.shift()!;
      if (to.includes(n)) return true;
      if (!seen.has(n)) (seen.add(n), queue.push(...next(n)));
    }
    return false;
  };
  for (const i of items) {
    if (i.type !== "pbi" || (i.stage !== "ready" && i.stage !== "in-progress")) continue;
    const judge = (p: { number: number; release: boolean }, via: number | null): BacklogPrereq => {
      const t = targets.get(p.number);
      const need = p.release ? "release" : t?.kind === "pr" ? "merged" : "done";
      const state = prereqState(t, need, released);
      const cycle = state === "pending" && t?.kind === "issue" && leadsTo(p.number, via === null ? [i.number] : [i.number, via]);
      return { number: p.number, kind: t?.kind ?? null, need, state: cycle ? "cycle" : state, via };
    };
    const tasks = openTasks(i.number);
    const ofTasks = tasks.map((t) => named(t).filter((p) => !tasks.includes(p.number)).map((p) => judge(p, t)));
    const blocked = tasks.length > 0 && ofTasks.every((ps) => ps.some((p) => p.state !== "met"));
    i.prereqs = [...named(i.number).map((p) => judge(p, null)), ...(blocked ? ofTasks.flat() : [])];
  }
}

/**
 * Gives each Ready / in-progress PBI the files its open Tasks name that other work touches too (#1044), by the rule of
 * scripts/task-paths.ts (`pathsIn`) and scripts/parallel-guard.ts (`judge`, STALE_HOURS) read from the stored records, so that backlog-next
 * does not start a session that would only find the overlap itself. The other work: an open PR that is not a Draft, not
 * `needs-decision` and not the PBI's own (it closes neither the PBI nor one of its Tasks), and an In progress Task of
 * another PBI that is not `needs-decision`. A PR whose files are not all stored cannot be judged (`unknown`). `root` =
 * the checkout, whose top level the paths in a Task's body are read against (what `readOthers` asks GitHub for).
 */
function withOverlap(items: BacklogItem[], issues: Map<number, BacklogIssueData>, pulls: Array<{ number: number; isDraft: boolean; labels: string[]; closes: number[]; updatedAt: string; files: string[] | null; state: string }>, statuses: Map<number, string | number | null>, root: string): void {
  const mine = items.filter((i) => i.type === "pbi" && (i.stage === "ready" || i.stage === "in-progress"));
  if (!mine.length) return;
  const top = new Map<string, boolean>();
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) top.set(e.name, e.isDirectory());
  } catch {
    // the checkout is gone: the top level comes from the PRs' files only
  }
  // the vocabulary is every open PR's (a Draft's new directory too, as `readOthers`); only the ready ones are the other work
  const openPulls = pulls.filter((p) => p.state === "OPEN");
  const open = openPulls.filter((p) => !p.isDraft && !p.labels.includes("needs-decision"));
  for (const p of openPulls) for (const f of p.files ?? []) {
    const [head, ...more] = f.split("/");
    if (head && (more.length > 0 || !top.has(head))) top.set(head, more.length > 0 || top.get(head) === true);
  }
  const names = [...top].map(([name, dir]) => ({ name, dir }));
  const taskPaths = (n: number) => pathsIn(issues.get(n)?.body ?? "", names);
  const working = [...issues.values()].filter((t) => t.state === "OPEN" && t.labels.includes("type:task") && !t.labels.includes("needs-decision") && statuses.get(t.number) === "In progress");
  const now = new Date();
  for (const i of mine) {
    const own = new Set<number>([i.number, ...(issues.get(i.number)?.subIssues ?? [])]);
    const paths = [...new Set((issues.get(i.number)?.subIssues ?? []).filter((n) => issues.get(n)?.state === "OPEN").flatMap(taskPaths))];
    if (!paths.length) continue;
    const others: Work[] = [];
    const unknown: string[] = [];
    for (const p of open) {
      if (p.closes.some((n) => own.has(n))) continue;
      if (p.files === null) unknown.push(`PR #${p.number} の変更ファイルが記録に無い`);
      else others.push({ ref: `PR #${p.number}`, paths: p.files, updatedAt: p.updatedAt });
    }
    for (const t of working) {
      if (own.has(t.number) || (t.parent !== null && own.has(t.parent))) continue;
      others.push({ ref: `Task #${t.number}`, task: t.number, paths: taskPaths(t.number), updatedAt: t.updatedAt });
    }
    const seen = new Set<string>();
    const hits = judge({ paths }, others, now).blocking.filter((h) => !seen.has(`${h.ref} ${h.path}`) && !!seen.add(`${h.ref} ${h.path}`)).map((h) => ({ ref: h.ref, path: h.path }));
    i.overlap = hits.length || unknown.length ? { hits, unknown: unknown.length ? unknown.join("・") : null } : null;
  }
}

/**
 * The backlog of a workspace as stored by its last import (#885), without asking GitHub: the same items, stages,
 * questions, reports, answers and waits as GitHub's own answer would give, from the records read in full (`fetched`). `fetchedAt` = when
 * the last complete import was stored. A workspace never imported answers `fetchedAt: null` and no items — never an
 * empty list as if read.
 */
export function readStoredBacklog(db: Db, ws: Pick<BacklogWorkspace, "id" | "name" | "path">, opts: { released?: (oid: string) => boolean | null; importFailed?: boolean; now?: number } = {}): { fetchedAt: number | null; items: BacklogItem[] } {
  const source = db.getWorkspaceBacklogSource(ws.id);
  const fetchedAt = source ? db.getBacklogRepository(source)?.lastSuccessfulSync ?? null : null;
  if (!source || fetchedAt === null) return { fetchedAt: null, items: [] };
  const records = shownRecords(db, source);
  const ops = db.listPendingBacklogOperations(source);
  const repoSync = db.getBacklogRepository(source);
  const now = opts.now ?? Date.now();
  const issues = new Map<number, BacklogIssueData>();
  const targets = new Map<number, WaitTarget>();
  const comments = new Map<number, Comment[]>();
  const fields = new Map<number, RawBacklogIssue["projectItems"]["nodes"]>();
  const pulls: Array<NonNullable<Extract<BacklogRecord, { objectKind: "pull-request" }>["remote"]>> = [];
  const statuses = new Map<number, string | number | null>();
  const storedIssues = new Map(db.listBacklogRecords(source, "issue").map((r) => [r.externalId, r]));
  const readOf = new Map<number, { externalId: string; fetchedAt: number | null; fetchState: BacklogFetchState }>();
  const ids = issueIds(storedIssues.values());
  for (const r of records) {
    // an Issue made here has no number until GitHub gives it one: read by its local id (readStoredIssue)
    if (r.objectKind === "issue" && r.remote?.number === 0) continue;
    if (r.objectKind === "issue" && r.remote) {
      issues.set(r.remote.number, r.remote);
      // as GitHub last answered, not as shown (#908)
      const stored = storedIssues.get(r.externalId);
      readOf.set(r.remote.number, { externalId: r.externalId, fetchedAt: stored?.fetchedAt ?? null, fetchState: stored?.fetchState ?? "unfetched" });
      targets.set(r.remote.number, { kind: "issue", state: r.remote.state, isDraft: false, labels: r.remote.labels, closes: [], stateReason: r.remote.stateReason, mergeCommit: null });
    } else if (r.objectKind === "pull-request" && r.remote) {
      targets.set(r.remote.number, { kind: "pr", state: r.remote.state, isDraft: r.remote.isDraft, labels: r.remote.labels, closes: r.remote.closes, mergeCommit: r.remote.mergeCommit, stateReason: null });
      pulls.push(r.remote);
    }
    else if (r.objectKind === "comment" && r.remote) comments.set(r.remote.issue, [...(comments.get(r.remote.issue) ?? []), r.remote]);
    // the Project the workspace reads, by owner (GitHub ignores its case; the URL is written by hand) and number:
    // another owner's Project #n is another Project
    else if (r.objectKind === "project-item" && r.remote && r.remote.owner.toLowerCase() === source.project.owner.toLowerCase() && r.remote.project === source.project.number) {
      const values = Object.entries(r.remote.fields).map(([name, v]) => (typeof v === "number" ? { number: v, field: { name } } : { name: v ?? undefined, field: { name } }));
      fields.set(r.remote.issue, [{ project: { number: r.remote.project }, fieldValues: { nodes: values } }]);
      statuses.set(r.remote.issue, r.remote.fields.Status ?? null);
    }
  }
  for (const c of comments.values()) c.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const commentsOf = (n: number) => comments.get(n) ?? [];

  const items: BacklogItem[] = [];
  for (const i of issues.values()) {
    if (i.state !== "OPEN" || !i.labels.some((l) => l === "type:pbi" || l === "type:request")) continue;
    const closedSubs = i.subIssues.filter((n) => issues.get(n)?.state === "CLOSED");
    const raw: RawBacklogIssue = {
      number: i.number, title: i.title, url: i.url, createdAt: i.createdAt, updatedAt: i.updatedAt, body: i.body,
      labels: { nodes: i.labels.map((name) => ({ name })) },
      subIssuesSummary: {
        total: i.subIssues.length, completed: closedSubs.length,
        doneAt: closedSubs.map((n) => issues.get(n)!.updatedAt).sort().at(-1) ?? null,
      },
      projectItems: { nodes: fields.get(i.number) ?? [] },
    };
    const item = toItem(raw, source.project.number, ws);
    if (!item) continue;
    const read = readOf.get(i.number);
    const family = familyOf(read?.externalId, i.subIssues, ids);
    item.sync = syncOf(db, ops.filter((o) => family.has(o.issue)), { lastSuccessfulSync: freshAt(repoSync?.lastSuccessfulSync ?? null, read), retryAt: repoSync?.retryAt ?? null, fetchState: read?.fetchState, importFailed: opts.importFailed, now });
    items.push(item);
  }
  // newest created first, as GitHub's list of Issues
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.number - b.number);
  const asked = askedOf(items);
  const tasksOf = (n: number): SubTask[] =>
    (issues.get(n)?.subIssues ?? []).flatMap((m) => {
      const t = issues.get(m);
      return t ? [{ number: m, state: t.state, labels: { nodes: t.labels.map((name) => ({ name })) }, comments: { nodes: commentsOf(m) } }] : [];
    });
  withWaits(withComments(asked, buildingOf(asked), commentsOf, tasksOf), targets, issues);
  withPrereqs(items, issues, targets, opts.released ?? (() => null));
  withOverlap(items, issues, pulls, statuses, ws.path);
  return { fetchedAt, items };
}

/**
 * The records as shown (#886), each with its shown value as `remote` (and `fetched`): an edit not sent yet over what GitHub answered,
 * and the records made here. A Project item whose last edit takes it out of the Project is not shown.
 */
function shownRecords(db: Db, source: BacklogSource): BacklogRecord[] {
  const member = new Map(db.listPendingBacklogOperations(source).filter((o) => o.kind === "set" && o.field === "member").map((o) => [o.target, o.payload]));
  return db.listBacklogRecords(source).flatMap((r) => {
    const v = shown(r);
    const value = v && (r.objectKind === "issue" || r.objectKind === "comment") ? { ...v, body: withoutMarker((v as { body: string }).body) } : v;
    // read like a record GitHub answered with that value
    return value && !(r.objectKind === "project-item" && member.get(r.externalId) === false) ? [{ ...r, remote: value, local: null, fetchState: "fetched" } as BacklogRecord] : [];
  });
}

/**
 * One stored Issue of the workspace's repository (#885), without asking GitHub; null = not stored. `ref`: its number, or
 * the local id of an Issue made here (#886) — before GitHub numbers it and after. It shows the edits not sent yet.
 */
export function readStoredIssue(db: Db, ws: Pick<BacklogWorkspace, "id">, ref: number | string, opts: { importFailed?: boolean; now?: number } = {}): BacklogIssueDetail | null {
  const source = db.getWorkspaceBacklogSource(ws.id);
  const rec = source ? issueRecord(db, source, ref) : null;
  // one GitHub no longer showed (404 / 403) is still read as stored, with its fetchState; it is not edited (409)
  const value = rec && ((shown(rec) ?? rec.local ?? rec.remote) as BacklogIssueData | null);
  if (!source || !rec || !value) return null;
  const issue = { ...value, body: withoutMarker(value.body) };
  const records = shownRecords(db, source);
  // a comment made here is named by its `local:` id before it is sent and by the service's after: both find its operation.
  // Oldest last: one sent again when GitHub is turned on (backlog-enable.ts) keeps the seq it was written with
  const written = new Map(db.listBacklogOperations(source).reverse().flatMap((o) => (o.kind === "comment" ? [[o.target, o.seq] as const, ...(o.remoteId ? [[o.remoteId, o.seq] as const] : [])] : [])));
  const comments = issue.number ? records.flatMap((r) => (r.objectKind === "comment" && r.remote?.issue === issue.number ? [{ ...r.remote, id: r.externalId, seq: written.get(r.externalId) ?? null }] : [])) : [];
  const item = issue.number ? projectItemOf(records, source, issue.number) : undefined;
  const all = db.listPendingBacklogOperations(source);
  const pending = all.filter((o) => o.issue === rec.externalId);
  // as its list row
  const family = familyOf(rec.externalId, value.subIssues ?? [], issueIds(db.listBacklogRecords(source, "issue")));
  const create = pending.find((o) => o.kind === "create")?.payload as BacklogCreatePayload | undefined;
  const held = pending.flatMap((o): BacklogHeldEdit[] => {
    if (o.status !== "conflict" && o.status !== "failed" && o.status !== "unknown") return [];
    const conflict = o.status === "conflict" ? conflictOf(db, o) : null;
    return [{ operation: o.id, kind: o.kind, field: o.field, status: o.status, reason: o.error, updatedAt: o.updatedAt, conflict }];
  });
  return {
    workspaceId: ws.id, issue, comments: comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    fields: item ? (item.remote as BacklogProjectItemData).fields : (create?.project?.fields ?? null), fetchedAt: rec.fetchedAt, fetchState: rec.fetchState,
    localId: typeof ref === "string" ? ref : rec.externalId.startsWith("local:") ? rec.externalId.slice("local:".length) : null, pending: pending.length,
    held, limits: SYNC_LIMITS,
    sync: syncOf(db, all.filter((o) => family.has(o.issue)), { lastSuccessfulSync: freshAt(db.getBacklogRepository(source)?.lastSuccessfulSync ?? null, rec), retryAt: db.getBacklogRepository(source)?.retryAt ?? null, fetchState: rec.externalId.startsWith("local:") && !rec.remote ? "fetched" : rec.fetchState, importFailed: opts.importFailed, now: opts.now ?? Date.now() }),
  };
}

/**
 * The stored records of a workspace as the kit's checks read them (#919, `GET /api/backlog/records`): every Issue as
 * shown with its Project fields, the pull requests, the checkout's top level (what a Task body's paths are read
 * against) and the Issues whose last read was not complete (`unread`: never read as current). null = never imported.
 */
export function readStoredRecords(db: Db, ws: Pick<BacklogWorkspace, "id" | "path">): StoredRecords | null {
  const source = db.getWorkspaceBacklogSource(ws.id);
  const fetchedAt = source ? db.getBacklogRepository(source)?.lastSuccessfulSync ?? null : null;
  if (!source || fetchedAt === null) return null;
  const records = shownRecords(db, source);
  const fields = new Map<number, BacklogProjectItemData["fields"]>();
  for (const r of records) {
    if (r.objectKind === "project-item" && r.remote && r.remote.owner.toLowerCase() === source.project.owner.toLowerCase() && r.remote.project === source.project.number) fields.set(r.remote.issue, r.remote.fields);
  }
  let top: StoredRecords["top"] = [];
  try {
    top = readdirSync(ws.path, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch {
    // the checkout is gone: the kit adds the PRs' files' top level
  }
  // one the last import did not read in full is not shown, but is listed with what GitHub last answered: a check then
  // knows it is a typed open Issue it cannot judge (unread), not one that does not exist
  const unread = db.listBacklogRecords(source, "issue").flatMap((r) => (r.fetchState !== "fetched" && (r.remote as BacklogIssueData | null)?.number ? [r.remote as BacklogIssueData] : []));
  const issues = records.flatMap((r) => (r.objectKind === "issue" && r.remote && r.remote.number > 0 ? [r.remote] : []));
  return {
    workspaceId: ws.id, service: syncsGithub(source) ? source.service : "switchboard", repository: source.repository, project: source.project, fetchedAt, top,
    issues: [...issues, ...unread.filter((u) => !issues.some((i) => i.number === u.number))].map((i) => ({ ...i, fields: fields.get(i.number) ?? null })),
    unread: unread.map((i) => i.number),
    pulls: records.flatMap((r) => (r.objectKind === "pull-request" && r.remote ? [r.remote] : [])),
    comments: records.flatMap((r) => (r.objectKind === "comment" && r.remote ? [{ issue: r.remote.issue, body: r.remote.body, createdAt: r.remote.createdAt }] : [])).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

/**
 * The three values of a held conflict (#887) and the revision a choice names. A conflict the write found afterwards
 * (#1329) shows the other's value from the history, not GitHub's (which is the value made here); its revision still
 * names what GitHub has, as the choice does.
 */
function conflictOf(db: Db, o: BacklogOperation): NonNullable<BacklogHeldEdit["conflict"]> {
  const read = db.backlogRemoteValue(o);
  return o.overwritten
    ? { base: o.base, local: o.payload, remote: o.overwritten.value ?? null, remoteRead: "value" in o.overwritten, revision: conflictRevision(o, read) }
    : { base: o.base, local: o.payload, remote: read ?? null, remoteRead: read !== undefined, revision: conflictRevision(o, read) };
}

/**
 * When an Issue was last known to be current (#908): an import reads only what changed since its cursor, so a complete
 * one vouches for every record it did not return (`repoAt`), and the record's own read can only be as late. A record GitHub
 * did not answer for (404 / 403 / never read) is vouched for by neither: its last own read.
 */
const freshAt = (repoAt: number | null, rec: { fetchedAt: number | null; fetchState: BacklogFetchState } | undefined) =>
  rec && rec.fetchState === "fetched" ? Math.max(rec.fetchedAt ?? 0, repoAt ?? 0) || null : rec?.fetchedAt ?? null;

/** What a sync is judged on besides the operations (#908). `importFailed`: the workspace's last import failed or is held back. */
interface SyncAt { lastSuccessfulSync: number | null; retryAt: number | null; fetchState?: BacklogFetchState; importFailed?: boolean; now: number }

/**
 * How one Issue, or a workspace's whole repository, stands against GitHub (#908), from the stored operations and when it
 * was last read. Conflict wins, then what cannot be sent or told (a refused edit, a record GitHub no longer shows or
 * never read, a failed import), then what waits; `unknown` (a lost answer) waits, to be looked for before it is sent again.
 * A failed read never moves `lastSuccessfulSync`.
 */
export function syncOf(db: Db, ops: BacklogOperation[], at: SyncAt): BacklogSyncInfo {
  const open = ops.filter((o) => o.status !== "done");
  const conflicts = open.filter((o) => o.status === "conflict").map((o) => ({ field: o.field, ...conflictOf(db, o) }));
  const has = (status: BacklogOperation["status"]) => open.some((o) => o.status === status);
  const fetchState = at.fetchState ?? "fetched";
  const wait = at.retryAt !== null && at.retryAt > at.now ? at.retryAt : null;
  let state: BacklogSyncState = "synced";
  let reason: BacklogSyncInfo["reason"] = null;
  if (conflicts.length) state = "conflict";
  else if (has("failed")) [state, reason] = ["error", "failed"];
  else if (fetchState !== "fetched") [state, reason] = ["error", fetchState];
  // an edit waiting is "pending" even while GitHub is out of reach (the reason says so, and `retryAt` when it is tried again)
  else if (open.length) [state, reason] = ["pending", has("unknown") ? "unknown" : at.importFailed || wait !== null ? "import" : null];
  else if (at.importFailed || wait !== null) [state, reason] = ["error", "import"];
  const nextOp = open.flatMap((o) => (o.status === "pending" && o.retryAt && o.retryAt > at.now ? [o.retryAt] : []));
  return {
    state, reason, lastSuccessfulSync: at.lastSuccessfulSync,
    retryAt: wait ?? (nextOp.length ? Math.min(...nextOp) : null),
    pendingCount: open.length, conflicts, guarantee: "A",
  };
}

/**
 * A workspace's sync as a whole (#908): its repository's operations, when it was last imported, the Issues made here
 * that GitHub has not numbered yet (no number: no stage can start on them), and the numbered Issues that hold operations
 * not sent — a conflict or a send held by an Issue with no row in the list (Closed ones) is opened from here (#1872).
 * A workspace never imported is `unfetched`.
 */
export function workspaceSyncOf(db: Db, ws: Pick<BacklogWorkspace, "id">, opts: { importFailed?: boolean; now?: number } = {}): {
  sync: BacklogSyncInfo;
  creates: Array<{ localId: string; title: string; state: BacklogSyncState }>;
  issues: Array<{ number: number; title: string; url: string; closed: boolean; state: BacklogSyncState; pendingCount: number; conflictCount: number }>;
} {
  const now = opts.now ?? Date.now();
  const source = db.getWorkspaceBacklogSource(ws.id);
  const repo = source ? db.getBacklogRepository(source) : null;
  const ops = source ? db.listPendingBacklogOperations(source) : [];
  const last = repo?.lastSuccessfulSync ?? null;
  // the worst of the Issues: one GitHub no longer shows, refused, or never read in full makes the workspace say so
  const unread = source ? db.listBacklogRecords(source, "issue").find((r) => !r.externalId.startsWith("local:") && r.fetchState !== "fetched") : undefined;
  const base = syncOf(db, ops, { lastSuccessfulSync: last, retryAt: repo?.retryAt ?? null, importFailed: opts.importFailed, now, fetchState: last === null ? "unfetched" : unread?.fetchState ?? "fetched" });
  // only those GitHub has not numbered yet (a create whose Issue exists keeps its follow-ups, not a place here)
  const creates = ops.filter((o) => o.kind === "create" && !o.remoteId).map((o) => ({
    localId: o.id,
    title: String((o.payload as { title?: unknown } | null)?.title ?? ""),
    state: syncOf(db, [o], { lastSuccessfulSync: last, retryAt: null, now }).state,
  }));
  const held = new Map<string, BacklogOperation[]>();
  for (const o of ops) if (o.status !== "done") held.set(o.issue, [...(held.get(o.issue) ?? []), o]);
  const issues = (source ? db.listBacklogRecords(source, "issue") : []).flatMap((r) => {
    const own = held.get(r.externalId);
    const v = (shown(r) ?? r.local ?? r.remote) as BacklogIssueData | null;
    if (!own || !v || !(v.number > 0)) return [];
    const s = syncOf(db, own, { lastSuccessfulSync: last, retryAt: null, now });
    return [{ number: v.number, title: v.title, url: v.url, closed: v.state === "CLOSED", state: s.state, pendingCount: s.pendingCount, conflictCount: s.conflicts.length }];
  }).sort((a, b) => a.number - b.number);
  return { sync: base, creates, issues };
}

/**
 * Whether a stage may start on this item: the stored data is what is true (#2264), so only a conflict held here (#887)
 * stops it. GitHub's side of the sync (edits waiting to be sent, a failed or old import, an Issue it did not return) is
 * shown, never a reason not to start — what is kept here is sent once GitHub can be reached.
 */
export function canStartStoredBacklog(item: Pick<BacklogItem, "sync">): { ok: true } | { ok: false; why: string } {
  const c = item.sync.conflicts;
  return c.length ? { ok: false, why: `競合が解消されていない（${c.map((x) => x.field ?? "作成").join("・")}）` } : { ok: true };
}

/* ---------- the version the sweep runs on (#282) ---------- */

/** What the backlog sweep needs from sb-rescue's /api/status: the current release and the newest history entries. */
export interface ReleaseState {
  managed: boolean;
  current: string | null;
  history: Array<{ action: string; from: string | null; to: string | null; ok: boolean; reason: string }>;
}

/** The newest `v*` tag (semver order) and its commit; the remote's tags are fetched first when it answers. */
export async function latestTag(git: (args: string[]) => Promise<string>): Promise<{ tag: string; sha: string } | null> {
  await git(["fetch", "--tags", "-q", "origin"]).catch(() => undefined);
  const tag = (await git(["tag", "-l", "v*", "--sort=-v:refname"])).split("\n")[0]?.trim();
  if (!tag) return null;
  return { tag, sha: await git(["rev-list", "-n", "1", tag]) };
}

export type PromotionStep =
  | { action: "pick" }
  | { action: "promote"; tag: string; sha: string }
  | { action: "wait"; reason: string; failed?: { tag: string; sha: string; reason: string } };

/**
 * Before a backlog-next firing picks an item: bring the running app up to the newest tag (#282). Only under sb-rescue.
 * A tag whose promotion was rejected or that rolled back by itself is never asked for again, and while it is the newest
 * tag nothing new is started — the next merges would be built on a version that does not run. A rollback chosen by hand
 * is the person's call, not a failure of the version. `latestInCurrent`: the tag's commit is already part of what runs
 * (a newer commit was promoted by hand) — going back to the tag would undo that.
 */
export function promotionStep(s: { status: ReleaseState; latest: { tag: string; sha: string } | null; busyTasks: number; latestInCurrent?: boolean }): PromotionStep {
  const { status, latest } = s;
  if (!status.managed || !latest || latest.sha === status.current || s.latestInCurrent) return { action: "pick" };
  const failure = status.history.find((h) =>
    (h.to === latest.sha && !h.ok && h.action === "rejected") ||
    (h.from === latest.sha && h.action === "auto-rollback"));
  if (failure) return { action: "wait", reason: `昇格に失敗した版のまま: ${latest.tag}`, failed: { tag: latest.tag, sha: latest.sha, reason: failure.reason } };
  if (s.busyTasks > 0) return { action: "wait", reason: `${s.busyTasks} 件の Task が動いているので ${latest.tag} の昇格を待つ` };
  return { action: "promote", tag: latest.tag, sha: latest.sha };
}

const marker = (sha: string) => `<!-- promote-failed:${sha} -->`;

/**
 * Tells the PBI behind a failed version (the `(#n)` of its commit subject: a PR's first closed Task → the Task's parent
 * PBI, or the Task / PBI itself) with a ## 判断待ち, once per commit, through the workspace's stored backlog: kept here
 * and sent by the app (a backlog kept here only too). Only the PR is read from the code host when it is not stored
 * (the PR's `closes` are the parallel guard's rule, closesOf). Null when no stored PBI could be found.
 */
export async function reportPromoteFailure(db: Db, source: BacklogSource, gh: GhRunner, cwd: string, f: { tag: string; sha: string; subject: string; reason: string; rescueUrl: string }): Promise<number | null> {
  let n = Number(/\(#(\d+)\)\s*$/.exec(f.subject)?.[1]);
  if (!n) return null;
  const records = shownRecords(db, source);
  const issue = (k: number) => records.find((r) => r.objectKind === "issue" && (r.remote as BacklogIssueData).number === k)?.remote as BacklogIssueData | undefined;
  const pr = records.find((r) => r.objectKind === "pull-request" && (r.remote as BacklogPullRequestData).number === n)?.remote as BacklogPullRequestData | undefined;
  const closes = pr
    ? pr.closes
    : await call(gh, cwd, ["pr", "view", String(n), "--json", "body,headRefName"]).then((out) => {
        const v = JSON.parse(out) as { body: string | null; headRefName: string | null };
        return closesOf(v.body, v.headRefName);
      }, () => null);
  if (closes) n = closes[0] ?? 0;
  let it = n ? issue(n) : undefined;
  if (!it) return null;
  if (!it.labels.includes("type:pbi")) {
    n = it.parent ?? Number(/## 親 PBI\s*\n+\s*#(\d+)/.exec(it.body ?? "")?.[1]);
    it = n ? issue(n) : undefined;
    if (!it) return null;
  }
  if (records.some((r) => r.objectKind === "comment" && (r.remote as BacklogCommentData).issue === n && (r.remote as BacklogCommentData).body.includes(marker(f.sha)))) return n;
  askStoredDecision(db, source, n, [
    `**問い**: 動いているアプリに入らなかった版 ${f.tag}（${f.sha.slice(0, 7)} ${f.subject}）をどうするか`,
    "**選択肢**:",
    `- A: 直す — 影響: 直した PR がマージされて新しいタグが付くまで、定期実行は新しい項目を始めない`,
    `- B: 救援画面で前の版に戻したままにし、この変更を revert する — 影響: revert の PR が要る`,
    `**推奨**: A — 理由は sb-rescue の履歴: ${f.reason}`,
    `**止めた場所**: 定期実行（backlog-next）。救援画面: ${f.rescueUrl}`,
    "",
    marker(f.sha),
  ].join("\n"));
  return n;
}
