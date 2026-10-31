import { useEffect, useRef, useState } from "react";
import type { GithubBudget, RunnerId, Task, TeleportProgress } from "@switchboard/protocol";
import { copyText } from "../clipboard.ts";
import { jstClock } from "../time.ts";

export function RunnerPill(props: { runner: RunnerId }) {
  // a runner only a newer daemon knows still shows its id rather than an empty pill
  const label = ({ claude: "Claude", codex: "Codex", dak: "DAK" } as Record<string, string>)[props.runner] ?? props.runner;
  return <span className={`pill ${props.runner}`}>{label}</span>;
}

/** "04:11", or "9/12 04:11" when not today — JST, like every other time the UI shows (#2028). */
export const fmtClock = jstClock;

/** GitHub's GraphQL budget left (#549): "3,965 / 5,000 · 11:31 に戻る". */
export function githubBudgetLabel(g: GithubBudget, now = Date.now()): string {
  return `${g.remaining.toLocaleString()} / ${g.limit.toLocaleString()} · ${fmtClock(g.resetsAt * 1000, now)} に戻る`;
}

/** Less than 2 tenths left: the share Home's usage meter warns at (above 0.8 used), not the daemon's constant copied. */
export const githubBudgetLow = (g: GithubBudget) => g.remaining / g.limit < 0.2;

/**
 * A task stopped on the runner's usage limit (#102), or waiting for GitHub's API limit a turn met (#550, `reason`
 * github): when it can go on. Whether it goes on by itself is the runner's setting (Home). `compact` (the Rail, where
 * a dated time would leave no room for the title) keeps the time in the tooltip. `plannedAt` (#2237): a long wait tries
 * once at `resumeAt` and goes back to this time when refused.
 */
export function ResumeTag(props: { resumeAt: Task["resumeAt"]; reason: Task["resumeReason"]; plannedAt?: Task["resumePlannedAt"]; compact?: boolean }) {
  if (props.resumeAt === null) return null;
  const when = fmtClock(props.resumeAt);
  if (props.reason === "github")
    return (
      <span className="tag resume" title={`GitHub の API 上限（1 時間の枠）で待機。${when} に枠が戻る見込み（自動再開はランナーごとの設定。Task の Brief から今すぐ再開・取り消しができます）`}>
        {props.compact ? "GitHub 待ち" : `GitHub の上限待ち（${when} に再開）`}
      </span>
    );
  if (props.reason === "disk")
    return (
      <span className="tag resume" title="ディスクの空き切れで停止。空きが 1 GiB に戻るまで待ちます（5 分ごとに確認。自動再開はランナーごとの設定。Task の Brief から今すぐ再開・取り消しができます）">
        {props.compact ? "空き待ち" : `空き待ち（${when} に確認）`}
      </span>
    );
  if (props.plannedAt != null)
    return (
      <span className="tag resume" title={`ランナーの使用上限で停止。${when} に 1 回試し、だめなら ${fmtClock(props.plannedAt)} に再開（自動再開はランナーごとの設定。Task の Brief から今すぐ再開・取り消しができます）`}>
        {props.compact ? "再開待ち" : `再開待ち ${when} に試す`}
      </span>
    );
  return (
    <span className="tag resume" title={`ランナーの使用上限で停止。${when} に枠が戻る見込み（自動再開はランナーごとの設定。Task の Brief から今すぐ再開・取り消しができます）`}>
      {props.compact ? "再開待ち" : `再開待ち ${when}`}
    </span>
  );
}

/** Where a task was started (#91). Switchboard is the default and shows nothing; a session run in a terminal gets a tag. */
export function OriginTag(props: { origin: Task["origin"] }) {
  if (props.origin !== "terminal") return null;
  return (
    <span className="tag origin" title="Terminal で実行した Claude Code のセッション（~/.claude/projects から取り込み）。返信すると Switchboard 側で同じセッションを再開します">
      Terminal
    </span>
  );
}

/** Shadow run (#99): a task that mirrors another one on a second runner. */
export function ShadowTag(props: { task: Pick<Task, "shadowOf" | "shadowStopped"> }) {
  if (!props.task.shadowOf) return null;
  const title = props.task.shadowStopped
    ? "並走 Task（停止済み）: 主 Task への返信はもう写されません。ここへ直接送ることはできます"
    : "並走 Task: 別の Task と同じ依頼を別ランナーで実行しています。主 Task への返信はここにも写されます（承認待ちの間は除く）。承認・差分・台帳はこの Task 単独のものです";
  return (
    <span className={`tag shadow ${props.task.shadowStopped ? "stopped" : ""}`} title={title}>
      並走{props.task.shadowStopped ? "・停止" : ""}
    </span>
  );
}

/**
 * A copy button (#695). `text` is read when pressed, so a running task copies what has come so far; `partial` says so on
 * the button. Always shown (not on hover): a phone has no hover. A failure goes to `onError` instead of doing nothing.
 */
export function CopyButton(props: { text: () => string; partial?: boolean; label?: string; onError: (msg: string) => void }) {
  const label = props.label ?? "コピー";
  const [done, setDone] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    const shown = props.partial ? "途中までコピーしました" : "コピーしました";
    copyText(props.text()).then(
      () => {
        setDone(shown);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(null), 2000);
      },
      (e) => props.onError(String((e as Error).message ?? e)),
    );
  };
  return (
    <button type="button" className="ghost copy" aria-label={label} onClick={copy}>
      {done ?? label}
    </button>
  );
}

export const fmtUsd = (n: number) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export const pct = (x: number) => `${Math.round(x * 100)}%`;

/** What "continue locally" shows for a Cloud Task (#1306): one place for the words. null = nothing to show. */
export function teleportView(p: TeleportProgress | null | undefined): { text: string; question?: string; answerInTerminal: boolean; active: boolean } | null {
  if (!p) return null;
  switch (p.phase) {
    case "teleporting": return { text: "公式CLIでTeleport中…", answerInTerminal: false, active: true };
    case "needs-input": return { text: "公式CLIが確認を求めています。ターミナルで答えてください", question: p.question, answerInTerminal: true, active: true };
    case "exiting":
    case "importing": return { text: "Local Taskへ取込み中…", answerInTerminal: false, active: true };
    case "done": return { text: "取込みを確認しました", answerInTerminal: false, active: false };
    case "unconfirmed": return { text: p.message ?? "取込み結果は未確認です", answerInTerminal: false, active: false };
  }
}

/** A Local Task imported from a Cloud Task (#1634): in the sticky head, so it is seen without scrolling; `switched` adds the line
 *  for the screen "ローカルで続ける" just switched to. */
export function CloudSourceTag(props: { source: Task; switched: boolean; onOpen: () => void }) {
  return (
    <>
      <span className="tag" title="このTaskへの返信で再開します。Cloudへ自動同期しません。">Cloudから取込み</span>
      <button className="ghost" onClick={props.onOpen}>元Cloud Taskを開く</button>
      {props.switched && <p className="hint switched-from-cloud" role="status">{`Cloud Task「${props.source.title}」から、取り込んだLocal Taskに切り替わりました`}</p>}
    </>
  );
}

/** Cloud is operated in the official UI; a launcher reference proves no workload outcome. */
export function CloudSessionNotice(props: { session: Task["cloudSession"]; onTeleport?: () => void; onRefresh?: () => void; teleportReason?: string; progress?: TeleportProgress | null; onAnswerInTerminal?: () => void; localTasks?: Task[]; onOpenTask?: (id: string) => void }) {
  const ref = props.session;
  const view = teleportView(props.progress);
  const valid = ref !== null && /^session_[A-Za-z0-9_-]+$/.test(ref.id) && ref.url === `https://claude.ai/code/${ref.id}`;
  return <div className="cloud-session card" role="status">
    <p>Cloud側の状態は未確認です。開始プロセスの終了は、Cloud作業の完了を意味しません。</p>
    {valid ? <a className="btn pri" href={ref.url} target="_blank" rel="noopener noreferrer">公式Cloudで続ける</a> : <p>Cloudセッションの参照を確認できていません。公式 Web で作成の有無を確認してください。</p>}
    {props.onTeleport && <>
      <button className="btn" disabled={!!props.teleportReason || view?.active} onClick={props.onTeleport}>ローカルで続ける</button>
      {props.teleportReason && <p className="hint">{props.teleportReason}</p>}
      {view && <div role="status" data-testid="teleport-progress">
        <p>{view.text}</p>
        {view.question && <pre>{view.question}</pre>}
        {view.answerInTerminal && <button className="btn" onClick={props.onAnswerInTerminal}>ターミナルで答える</button>}
      </div>}
      <p className="hint">同じアカウント・リポジトリのclaude.aiサブスクリプション認証が必要です。Cloudの作業ブランチがpush済みか確認してください。公式CLIでCloudの変更を取り込みます。確認を求められたときだけターミナルで答えます。取消・失敗は自動再試行しません。</p>
    </>}
    {props.onRefresh && <button className="btn" onClick={props.onRefresh}>Local Taskを確認</button>}
    {props.localTasks?.map(t => <p key={t.id}><button className="btn" onClick={() => props.onOpenTask?.(t.id)}>ローカルの Task: {t.title}</button> <span className="hint">作業コピー: {t.cwd}</span></p>)}
    <p className="hint">Cloud側の続行・承認・停止は公式 Web で操作してください。Localへの取込み後はCloudへ自動同期しません。</p>
  </div>;
}
