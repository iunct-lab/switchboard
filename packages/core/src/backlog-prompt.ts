/**
 * The request texts: what a stage Task is started with (`buildStartPrompt`, `buildDirectPrompt`), its title, the rules
 * a Task is given for a backlog kept here only or for another repository's backlog, and the mark a Task leaves when
 * every Task of a PBI is done.
 */
import type { BacklogAction, BacklogItem } from "@switchboard/protocol";
import type { RunnerId } from "@switchboard/protocol";
import { skillPathsFor, type SetupScripts } from "./skillsync.ts";
import { entryConditions, loadProcess, renderEntry, REVIEWER_WORDS, type ProcessDef, type ReviewSetting } from "./process-defs.ts";
import { actionMerges } from "./backlog-item.ts";

const ACTION_NAME: Record<BacklogAction, string> = { "to-pbi": "PBI にする", "to-tasks": "Task に分解", complete: "実装", check: "状況確認", close: "閉じる", direct: "直行で直す" };

export function startTitle(item: Pick<BacklogItem, "number" | "title">, action: BacklogAction): string {
  return `#${item.number} ${ACTION_NAME[action]}: ${item.title}`;
}

/** What `scripts/setup/` of another repository holds (`setupScripts`), for the instructions of a Task that runs there. */
export interface OtherRepo {
  meta: string;
  projectVar?: string;
  setup: SetupScripts;
}

/**
 * How a Task on another registered workspace reads the skills and scripts, which are written for this repository
 * (a backlog stage Task, a request registered for that workspace). `merges` = the Task carries a change to the default
 * branch: only then it is told about PRs or local changes, the merge gate, the recheck, local CI, release tags and
 * rolling back. A Task that only writes Issues (a request, a decomposition, a status check) gets none of that.
 */
export function otherRepoRules(other: OtherRepo, opts: { local?: boolean; localForge?: boolean; merges: boolean }): string {
  const { local = false, localForge = false, merges } = opts;
  const { meta, setup } = other;
  const projectUrl = `SWITCHBOARD_PROJECT_URL=$(gh variable get ${other.projectVar ?? "SWITCHBOARD_PROJECT_URL"})`;
  // a backlog kept in Switchboard only: no GitHub Issue, Project or its variable, so none of the setup scripts for them
  const own = !local && setup.config && setup.kit.length > 0; // the repository's own entries call the kit and it has its own ops.config.json
  const metaScripts = `${own ? "ほかのスクリプト" : "スクリプト"}（\`scripts/…\`）はこのリポジトリには無く、Switchboard のリポジトリ ${meta} からの相対パスです。そこにあるものを、このディレクトリから実行してください。`;
  const scripts = own
    ? `運用ツール（\`scripts/setup/\` の ${setup.kit.join("、")}）はこのリポジトリの入口を使ってください（共通キットを呼び、設定はこのリポジトリの \`ops.config.json\`。キットは \`OPS_KIT=${meta}/ops-kit\` を付けて渡す）。${metaScripts}`
    : metaScripts;
  // the settings are on Switchboard's side (the repository has no `ops.config.json`): the tools already read them
  const saved = setup.saved
    ? "このリポジトリの設定（`ops.config.json` と同じ形: CI の手順・Project のフィールド・必須の節など）は Switchboard の側にあり、アプリが環境変数 `OPS_KIT_CONFIG` でそのファイルを渡しています。`ops-kit backlog` / `ops-kit lint --fresh` と Switchboard のスクリプトはそれを読むので、このリポジトリに `ops.config.json` を作らない・コミットしない（設定を変えるなら、Switchboard の設定の Workspace の行から）。"
    : "";
  const copies = !local && setup.copies.length > 0
    ? `このリポジトリの \`scripts/setup/\` の ${setup.copies.join("、")} は共通キットを呼ばない写しなので使わない。代わりに ${meta} の \`scripts/setup/\` の同じ名前の入口に \`${projectUrl}\` を付けて使う。`
    : "";
  const project = local ? localBacklogRules({ localForge, merges }, `${meta}/`) : own ? "" : `Project の URL はリポジトリ変数 \`${other.projectVar ?? "SWITCHBOARD_PROJECT_URL"}\` にあり、Project を触るスクリプトには \`${projectUrl}\` を付けて渡す。`;
  return `スキル（\`.claude/skills/…\`）は Switchboard がこのリポジトリに置いたもの（Git 管理外）を使ってください。${scripts}${saved}${copies}スキルは Switchboard 向けに書かれているので、次のように読み替えてください: スキル中の「このリポジトリ」「開発リポジトリ」はこのリポジトリ。${project}${localForge || !merges ? "" : `${local ? "\`scripts/merge-gate.ts\`・\`scripts/local-ci.ts\`" : "\`scripts/merge-gate.ts\`・\`scripts/parallel-guard.ts\`・\`scripts/local-ci.ts\`"} の既定の対象は実行する場所（環境変数・作業ツリー・スクリプトの clone）で変わるので、必ず \`--repo <このリポジトリの owner/name>\` を付けて実行し、その判定に従う（自分で条件を確かめて代わりにしない）。再チェックの手順は \`${meta}/docs/merge-gate.md\` の「Recheck」（その中の \`-R <owner/name>\` と \`origin\` はこのリポジトリ。印は必ずこのリポジトリの PR に付ける）。Actions が始まらない（ジョブのステップ 0 件）ときは、このリポジトリの作業ツリーから \`bun ${meta}/scripts/local-ci.ts <PR> --repo <このリポジトリの owner/name>\` で CI を回す（作業ツリーの origin が \`--repo\` と違えば何も投稿せず exit 2）。回すのはスタックの一番上で 1 回（全部の PR の指摘の処理が済んでから。いつ回し、どう数えるかは \`${meta}/docs/merge-gate.md\` の「When to run local CI and how it counts」）。PR をマージするたびに、マージした PR ごとに \`bun ${meta}/scripts/release-tag.ts --pr <PR> --repo <このリポジトリの owner/name>\` でそのマージにタグと Release を付け（付け先はその PR のマージコミット。PR が MERGED でなければ何も付けず exit 1 なので、マージに失敗したらタグは付かない。付け先を \`origin/main\` などの動く値で渡さない。タグの無い前のマージもその Release に入る）、出力を PBI の結果に書く。main をタグの状態に戻すときは \`bun ${meta}/scripts/rollback-pr.ts <tag> --repo <このリポジトリの owner/name>\` で PR を作り、ふつうの PR と同じくレビューと merge-gate を通してマージする。`}ビルド・テスト・ブランチ・コミットの決まりは、このリポジトリの CLAUDE.md / AGENTS.md / README がスキルと食い違えばこのリポジトリの方に従う。Switchboard のリポジトリ自体は変更しない。`;
}

/**
 * What a Task on a backlog kept in Switchboard only does instead of GitHub's Issues and Project: the kit's
 * `ops-kit backlog` (it is given the workspace, BACKLOG_WORKSPACE) and `ops-kit lint --fresh`, and the parallel guard
 * without `--repo` (it writes its claims there too).
 */
/** The Issue half of LOCAL_BACKLOG_RULES: the kit's backlog and the parallel guard without --repo. */
export const LOCAL_ISSUE_RULES = "Issue・Project のフィールド・Milestone・親子（sub-issue）・コメント・lint は `ops-kit backlog`（create / edit / comment / set / triage / view）と `ops-kit lint --fresh` だけで行い、`gh issue` / `gh project` / `gh api graphql` の Issue・Project の操作 / `scripts/setup/*` / Project の変数は使わない（GitHub にこの Issue は無い）。並列ガード（`scripts/parallel-guard.ts`）は `--repo` を付けずに実行する（占有と着手の印もアプリに書く）。";
export const LOCAL_BACKLOG_RULES = LOCAL_ISSUE_RULES + "PR・レビュー・CI・マージはリポジトリの PR で行う。ただし PR の本文・コミットには GitHub の閉じるキーワード（close / fix / resolve とその -s / -d 形）も `#<番号>` の形の Task・PBI の参照も書かない（番号は Switchboard の番号で、GitHub の同じ番号の別の Issue を閉じる・参照する）。Task は PR 本文の 1 行 `Backlog-Task: <番号>` と枝 `sb/<番号>-<topic>` で示す。PR をマージしたら `ops-kit backlog edit <Task> --state closed` で Task を閉じる（自動では閉じない）。";

/**
 * The rules of a backlog kept in Switchboard only, for one Task: the Issue half always; how its change travels (a PR of
 * the repository, or the app's local change on a checkout without a remote) only when the Task merges one.
 */
export const localBacklogRules = (opts: { localForge?: boolean; merges: boolean }, root = ""): string =>
  !opts.merges ? LOCAL_ISSUE_RULES : opts.localForge ? LOCAL_ISSUE_RULES + localChangeRules(root) : LOCAL_BACKLOG_RULES;

/**
 * What a Task does instead of PRs on a checkout whose changes the app keeps (the kit's `forgeOf` is its local
 * service: no remote, or `forge` names it): the skills' 「ローカルの変更では」 lines, with `scripts` = where the
 * Switchboard checkout is (`` in its own, `<meta>/` in another's): its scripts and docs/merge-gate.md.
 */
export const localChangeRules = (root: string) =>
  `この workspace の変更はアプリに置く（リモートは使わない）。PR の代わりにローカルの「変更」で、レビュー・ローカル CI・マージ判定・マージを行う（各スキルの「ローカルの変更では」の行）。\`gh pr\` / \`gh stack\` / \`git push\` / \`git fetch\`・リリースタグ・\`ops-kit pull-main\` は使わない。枝は \`git checkout -b sb/<Task>-<topic>\` で 1 本ずつ（積まず、マージしてから次の枝を main から切る）。変更は \`ops-kit backlog create --title <題> --body-file <本文> --head <枝> --base main\`（本文の 1 行 \`Backlog-Task: <Task>\`。閉じるキーワードと \`#<番号>\` は書かない）。ローカル CI は \`bun ${root}scripts/local-ci.ts --change <変更>\`、マージ判定は \`bun ${root}scripts/merge-gate.ts --change <変更>\`、マージは \`bun ${root}scripts/local-merge.ts <変更>\`（判定をもう一度通し、Task も閉じる）。どれも \`--repo\` は付けない。マージ判定が \`[再チェック <kind>]\` で止めたら、\`${root}docs/merge-gate.md\` の「Recheck」を、PR の情報を \`ops-kit backlog view <変更>\`、差分を \`git diff main...<枝>\` に読み替えて回す。再チェックはアプリの仕事として頼む（LLM が読む種類は監督者として \`ops-kit job request review <変更> --change --as arbiter --prompt <指示> --out <出力>\`（指示は \`ops-kit review-arbiter prompt\`）、コマンドの種類は \`ops-kit job request recheck <変更> --change --kind <種類>\`）。判定は仕事の記録を読み、変更へのコメントは読まない。聞く理由は利用者の許可の記録（「変更 L<n> をマージしてよい」）で外れる。\`[merge-ask]\` / \`[merge-answer]\` の印は付けない。リリースタグは無いので、決定ログの「戻すなら <tag>」は「戻すなら: タグなし（変更 #<変更> の mergeCommit の前）」と書く。`;

/** The form of a ## 状況, the same in a 状況確認 and in a resume of a stalled PBI. */
const REPORT_FORMAT = "`## 状況` で始まるコメントを 1 件書いてください。中身は `### 済んだこと` / `### 残り` / `### 止まっている理由`（動いているなら「動いている」とその Task）/ `### 次にやること`。";

/**
 * What a complete Task is asked for, so the runner's own approval reads the merge of a PR the merge gate passed as part of
 * the request, and so does its sharing of review material and the Issues the skills file. The same section as .claude/skills/pbi-complete/SKILL.md names; only `complete` carries it.
 * The reviewer is named by the review setting, as the skills placed for the Task are.
 */
export const completeScope = (review: ReviewSetting) => "この依頼は、マージ判定（`scripts/merge-gate.ts`）が merge を返した PR のマージ、リリースタグ、PBI を閉じるところまでを含みます。.claude/skills/cross-runner-review/SKILL.md が渡すレビューの材料（fresh clone のコード、PR・Task・PBI の本文、差分）を" + (review === "same" ? REVIEWER_WORDS.same : `${REVIEWER_WORDS.other}（Claude Code / Codex）`) + "と CLAUDE.md の追加のレビュアーに渡すこと、スキルの手順が作る Issue（レビュー指摘の Issue 化、要望 Issue と PBI）とコメントも、この依頼に含みます。マージのたびに利用者へ聞き直さないでください。マージ判定が `[聞く]` で止めたとき、デーモンを再起動する pull、認証は、これまでどおり Task の会話で聞いてください（.claude/skills/pbi-complete/SKILL.md の「この依頼が含む範囲」）。昇格はリポジトリの CLAUDE.md の決まりに従い、CLAUDE.md が聞かずに昇格してよいと書いていなければ Task の会話で聞いてください。";

/**
 * `other` = the Issue is in another registered workspace's repository: the Task runs there, using the stage skills synced
 * into that repository when the runner starts (docs/design/skill-sync.md); `other.meta` is only where `scripts/…` are.
 * The skills are written for this repository, so what to read differently is spelled out.
 *
 * `local`: the workspace's backlog is kept in Switchboard only — the Task works on it with `ops-kit backlog` alone.
 *
 * `resume`: backlog-next resumes a stalled in-progress PBI (the resume's text differs from a first start's).
 *
 * `answer`: the newest `## 回答` the person gave on the screen (screenAnswer), put in the prompt as the person's
 * words — read with a tool, an operation it allows is not the person's say to the runner's approval. Not for a check.
 */
/** The entries a stage start renders from the pipeline's definition (`ops-kit/processes/p0-pipeline.md`); a definition missing one cannot start a stage. */
export const PIPELINE_ENTRIES = ["to-pbi", "to-tasks", "to-tasks-ready", "complete", "complete-other", "complete-resume", "check", "close"] as const;

/** The stage Task's first prompt: the entry's text from `def` (the pipeline candidate; `opts` are explained above `PIPELINE_ENTRIES`), then what the daemon adds around it (the answer to read, the scope of a complete, where the Issue is). */
export function buildStartPrompt(item: Pick<BacklogItem, "number"> & Partial<Pick<BacklogItem, "tasks" | "freeTasks">>, action: BacklogAction, opts: { other?: OtherRepo; resume?: true; local?: boolean; localForge?: boolean; answer?: { issue: number; text: string } | null; taskModel?: string; review?: ReviewSetting; runner?: RunnerId } = {}, def: ProcessDef = loadProcess("p0-pipeline")): string {
  const n = item.number;
  const runner = opts.runner ?? "claude";
  const merges = actionMerges(action);
  const subIssues = item.tasks?.total ?? 0;
  const missing = PIPELINE_ENTRIES.filter((e) => !(e in def.entries));
  if (missing.length) throw new Error(`${def.path}: the pipeline definition lacks entries ${missing.join(", ")}`);
  // which entry of the definition (docs/design/process-kernel.md, K4): the texts themselves are in the file, not here
  const entry =
    action === "to-tasks"
      ? subIssues > 0 ? "to-tasks-ready" : "to-tasks" // a PBI in 分解待ち that already has sub-issues is waiting to be made Ready, not to be decomposed again
      : action === "complete"
        ? opts.resume ? "complete-resume" : opts.other || runner !== "claude" ? "complete-other" : "complete" // every complete, from Ready too: backlog-next also uses it to resume an in-progress PBI whose Task was answered; a resume names the skill's file: a slash command is expanded only at the start of a prompt, and only Claude Code has that slash command
        : action;
  const rendered = renderEntry(def, entry, { n, subIssues, reportFormat: REPORT_FORMAT }, entryConditions({ runner, review: opts.review ?? "other", local: !!opts.local }));
  // Task ごとの実装のモデル: every complete entry, a resume too; a model without an alias adds nothing, and so does a
  // runner without the Agent tool the paragraph names
  const alias = action === "complete" && runner === "claude" && opts.taskModel ? subagentModelAlias(opts.taskModel) : null;
  const body = alias ? `${rendered}\n\n${taskModelParagraph(alias)}` : rendered;
  const elsewhere = opts.local
    ? `\n\n#${n} はこの workspace の Switchboard のバックログの Issue です（GitHub には無い）。${opts.other ? otherRepoRules(opts.other, { local: true, localForge: !!opts.localForge, merges }) : localBacklogRules({ localForge: opts.localForge, merges })}`
    : opts.other ? `\n\n#${n} はこのディレクトリのリポジトリ（\`gh repo view\` が答えるもの）の Issue です。${otherRepoRules(opts.other, { merges })}` : "";
  const answer = action === "check" ? "" : `始める前に Issue #${n} の最新の \`## 回答\` コメント${action === "complete" ? "（sub-issue の Task のものも）" : ""}を読み（\`ops-kit backlog view ${n} --fresh\`。アプリが GitHub と同期してから答え、GitHub に届かなければ保存値と未同期の印で答える）、あればそれに従って続きから進めてください。`;
  const scope = action === "complete" ? completeScope(opts.review ?? "other") : "";
  const said = action !== "check" ? saidOf(opts.answer) : "";
  // the person's answer goes after the runner's reading of the app's own text: their words are never rewritten
  return `${skillPathsFor(`${body}\n\n${action === "complete" && !opts.resume ? freeTasksLine(item.freeTasks) : ""}対象: #${n}。${answer}${scope}${elsewhere}`, runner)}${said}`;
}

/**
 * The Tasks the app judged free of overlaps when it started the PBI (`withOverlap`), as a line of the 実装 prompt: the
 * session judges these first, so it does not pick a Task the app saw overlapping and stop. Not a replacement for the
 * session's own check. Empty when there is none.
 */
export const freeTasksLine = (free: number[] | undefined): string =>
  free?.length ? `重ならないと判定した Task: ${free.map((n) => `#${n}`).join(", ")}（アプリの判定。この Task から着手の判定にかける）。\n\n` : "";

/**
 * The Agent tool's `model` alias of a Claude model id: `claude-sonnet-*` → `sonnet`, and opus / haiku / fable
 * alike. null = none (another runner's model, a Bedrock id): the setting refuses it and the prompt leaves it out.
 */
export function subagentModelAlias(model: string): string | null {
  return /^claude-(sonnet|opus|haiku|fable)-/.exec(model)?.[1] ?? null;
}

/** The paragraph of an 実装 Task's prompt: each Task's implementation on a foreground subagent of `alias`; the rest stays here. */
function taskModelParagraph(alias: string): string {
  return `Task ごとの実装（task-to-pr の着手コメントから PR を出して In review にするまで）は、Agent ツールの model に \`${alias}\` を指定したサブエージェントに前景で任せてください（\`run_in_background\` にしない）。並べる順・レビューの処理・マージ判定・PBI を閉じるのはこの会話で行ってください。`;
}

/** The person's newest answer on the screen as their words, in a fence longer than any run of backticks in it, so the answer cannot close it. */
function saidOf(answer: { issue: number; text: string } | null | undefined): string {
  if (!answer) return "";
  const fence = "`".repeat(Math.max(4, ...[...answer.text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `\n\n利用者が画面で答えた Issue #${answer.issue} の最新の回答（利用者の言葉）:\n\n${fence}text\n${answer.text}\n${fence}`;
}

/**
 * The first prompt of a 直行で直す: the `direct` entry of the `p1-direct` candidate with the request as its signal,
 * then the answer to read, the rules of a local backlog or of another repository and the screen answer as a stage Task
 * has them. No PBI or Task Issue: the entry itself says what it leaves on the request.
 */
export function buildDirectPrompt(item: Pick<BacklogItem, "number">, opts: { other?: OtherRepo; local?: boolean; localForge?: boolean; answer?: { issue: number; text: string } | null; review?: ReviewSetting; runner?: RunnerId } = {}, def: ProcessDef = loadProcess("p1-direct")): string {
  const n = item.number;
  const body = renderEntry(def, "direct", { signal: `#${n}`, reviewer: REVIEWER_WORDS[opts.review ?? "other"] }, entryConditions({ runner: opts.runner ?? "claude", review: opts.review ?? "other", local: !!opts.local }));
  const elsewhere = opts.local
    ? `\n\n#${n} はこの workspace の Switchboard のバックログの Issue です（GitHub には無い）。${opts.other ? otherRepoRules(opts.other, { local: true, localForge: !!opts.localForge, merges: true }) : localBacklogRules({ localForge: opts.localForge, merges: true })}`
    : opts.other ? `\n\n#${n} はこのディレクトリのリポジトリ（\`gh repo view\` が答えるもの）の Issue です。${otherRepoRules(opts.other, { merges: true })}` : "";
  const inOther = opts.other ? `\n\n${directOther(opts.other)}` : "";
  return `${skillPathsFor(`${body}\n\n対象: #${n}。始める前に Issue #${n} の最新の \`## 回答\` コメントを読み（\`ops-kit backlog view ${n} --fresh\`。アプリが GitHub と同期してから答え、GitHub に届かなければ保存値と未同期の印で答える）、あればそれに従ってください。${elsewhere}${inOther}`, opts.runner ?? "claude")}${saidOf(opts.answer)}`;
}

/** What the `direct` entry's own paths mean in another repository: the invariants are Switchboard's, the working rules are the repository's. */
function directOther(other: OtherRepo): string {
  return `上の入口が指す不変条件のファイルは ${other.meta}/ops-kit/invariants.md です。そこを読んでください。worktree・枝・テストのコマンドは、このリポジトリの CLAUDE.md / AGENTS.md に書かれていればそれに従ってください。この Task には PBI も Task の Issue も無い。上の読み替えのうち PBI・Task の番号を使う行は、PBI の結果に書くものは PR（ローカルの変更）の本文に書き、\`Backlog-Task:\` の行は書かず（閉じる Task が無い。ほかの番号を書くとその Issue を閉じる）、Task を閉じる手順は飛ばし、枝の \`<Task>\` は \`sb/direct-<topic>\` と読む。`;
}

/** The first prompt of a 束: the `bundle` entry of the `p3-bundle` candidate with the PBIs to put in together and who reviews. */
export function buildBundlePrompt(pbis: number[], opts: { review?: ReviewSetting; runner?: RunnerId } = {}, def: ProcessDef = loadProcess("p3-bundle")): string {
  const body = renderEntry(def, "bundle", { pbis: pbis.map((n) => "#" + n).join(", "), reviewer: REVIEWER_WORDS[opts.review ?? "other"] });
  return skillPathsFor(body, opts.runner ?? "claude");
}
