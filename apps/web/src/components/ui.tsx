import { useEffect, useRef, useState } from "react";
import type { GithubBudget, RunnerId, Task, TeleportProgress } from "@switchboard/protocol";
import { copyText } from "../clipboard.ts";
import { jstClock } from "../time.ts";
import { runnerLabel } from "../runners.ts";
import { t } from "../i18n.ts";
import { task as m } from "../i18n/task.ts";

export function RunnerPill(props: { runner: RunnerId }) {
  // a runner only a newer daemon knows still shows its id rather than an empty pill
  return <span className={`pill ${props.runner}`}>{runnerLabel(props.runner)}</span>;
}

/** "04:11", or "9/12 04:11" when not today — JST, like every other time the UI shows (#2028). */
export const fmtClock = jstClock;

/** GitHub's GraphQL budget left (#549): "3,965 / 5,000 · 11:31 に戻る". */
export function githubBudgetLabel(g: GithubBudget, now = Date.now()): string {
  return t(m.githubBudget, { remaining: g.remaining.toLocaleString(), limit: g.limit.toLocaleString(), time: fmtClock(g.resetsAt * 1000, now) });
}

/** Less than 2 tenths left: the share Home's usage meter warns at (above 0.8 used), not the daemon's constant copied. */
export const githubBudgetLow = (g: GithubBudget) => g.remaining / g.limit < 0.2;

/**
 * A task stopped on the runner's usage limit (#102), or waiting for GitHub's API limit a turn met (#550, `reason`
 * github): when it can go on. Whether it goes on by itself is the runner's setting (Home). `compact` (the Rail, where
 * a dated time would leave no room for the title) keeps the time in the tooltip. `plannedAt` (#2237): a long wait tries
 * once at `resumeAt` and goes back to this time when refused.
 */
/** The turn ended waiting for background jobs: the task is `done`, but work is still going on. */
export function BackgroundTag(props: { background: Task["background"]; compact?: boolean }) {
  const b = props.background;
  if (!b) return null;
  const n = b.jobs.length || 1;
  const min = Math.max(0, Math.floor((Date.now() - b.since) / 60_000));
  const text = t(m.background, { n, min });
  return (
    <span className="tag" title={b.jobs.join("\n") || t(m.contentsUnknown)}>
      {props.compact || !b.jobs.length ? text : `${text}: ${b.jobs.join(" / ")}`}
    </span>
  );
}

export function ResumeTag(props: { resumeAt: Task["resumeAt"]; reason: Task["resumeReason"]; plannedAt?: Task["resumePlannedAt"]; compact?: boolean }) {
  if (props.resumeAt === null) return null;
  const when = fmtClock(props.resumeAt);
  if (props.reason === "github")
    return (
      <span className="tag resume" title={t(m.resumeGithubTitle, { when })}>
        {props.compact ? t(m.resumeGithubCompact) : t(m.resumeGithub, { when })}
      </span>
    );
  if (props.reason === "disk")
    return (
      <span className="tag resume" title={t(m.resumeDiskTitle)}>
        {props.compact ? t(m.resumeDiskCompact) : t(m.resumeDisk, { when })}
      </span>
    );
  if (props.plannedAt != null)
    return (
      <span className="tag resume" title={t(m.resumePlannedTitle, { when, planned: fmtClock(props.plannedAt) })}>
        {props.compact ? t(m.resumeQueued) : t(m.resumePlanned, { when })}
      </span>
    );
  return (
    <span className="tag resume" title={t(m.resumeTitle, { when })}>
      {props.compact ? t(m.resumeQueued) : t(m.resumeAt, { when })}
    </span>
  );
}

/** Where a task was started (#91). Switchboard is the default and shows nothing; a session run in a terminal gets a tag. */
export function OriginTag(props: { origin: Task["origin"] }) {
  if (props.origin !== "terminal") return null;
  return (
    <span className="tag origin" title={t(m.originTitle)}>
      Terminal
    </span>
  );
}

/** Shadow run (#99): a task that mirrors another one on a second runner. */
export function ShadowTag(props: { task: Pick<Task, "shadowOf" | "shadowStopped"> }) {
  if (!props.task.shadowOf) return null;
  const title = props.task.shadowStopped
    ? t(m.shadowStoppedTitle)
    : t(m.shadowTitle);
  return (
    <span className={`tag shadow ${props.task.shadowStopped ? "stopped" : ""}`} title={title}>
      {t(m.shadowTag)}{props.task.shadowStopped ? t(m.shadowStoppedSuffix) : ""}
    </span>
  );
}

/**
 * A copy button (#695). `text` is read when pressed, so a running task copies what has come so far; `partial` says so on
 * the button. Always shown (not on hover): a phone has no hover. A failure goes to `onError` instead of doing nothing.
 */
export function CopyButton(props: { text: () => string; partial?: boolean; label?: string; onError: (msg: string) => void }) {
  const label = props.label ?? t(m.copy);
  const [done, setDone] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    const shown = props.partial ? t(m.copiedPartial) : t(m.copied);
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
    case "teleporting": return { text: t(m.teleporting), answerInTerminal: false, active: true };
    case "needs-input": return { text: t(m.needsInput), question: p.question, answerInTerminal: true, active: true };
    case "exiting":
    case "importing": return { text: t(m.importing), answerInTerminal: false, active: true };
    case "done": return { text: t(m.importDone), answerInTerminal: false, active: false };
    case "unconfirmed": return { text: p.message ?? t(m.importUnconfirmed), answerInTerminal: false, active: false };
  }
}

/** A Local Task imported from a Cloud Task (#1634): in the sticky head, so it is seen without scrolling; `switched` adds the line
 *  for the screen "ローカルで続ける" just switched to. */
export function CloudSourceTag(props: { source: Task; switched: boolean; onOpen: () => void }) {
  return (
    <>
      <span className="tag" title={t(m.cloudSourceTitle)}>{t(m.cloudSource)}</span>
      <button className="ghost" onClick={props.onOpen}>{t(m.openCloudSource)}</button>
      {props.switched && <p className="hint switched-from-cloud" role="status">{t(m.switchedFromCloud, { title: props.source.title })}</p>}
    </>
  );
}

/** Cloud is operated in the official UI; a launcher reference proves no workload outcome. */
export function CloudSessionNotice(props: { session: Task["cloudSession"]; onTeleport?: () => void; onRefresh?: () => void; teleportReason?: string; progress?: TeleportProgress | null; onAnswerInTerminal?: () => void; localTasks?: Task[]; onOpenTask?: (id: string) => void }) {
  const ref = props.session;
  const view = teleportView(props.progress);
  const valid = ref !== null && /^session_[A-Za-z0-9_-]+$/.test(ref.id) && ref.url === `https://claude.ai/code/${ref.id}`;
  return <div className="cloud-session card" role="status">
    <p>{t(m.cloudUnchecked)}</p>
    {valid ? <a className="btn pri" href={ref.url} target="_blank" rel="noopener noreferrer">{t(m.continueInCloud)}</a> : <p>{t(m.cloudRefUnchecked)}</p>}
    {props.onTeleport && <>
      <button className="btn" disabled={!!props.teleportReason || view?.active} onClick={props.onTeleport}>{t(m.continueLocally)}</button>
      {props.teleportReason && <p className="hint">{props.teleportReason}</p>}
      {view && <div role="status" data-testid="teleport-progress">
        <p>{view.text}</p>
        {view.question && <pre>{view.question}</pre>}
        {view.answerInTerminal && <button className="btn" onClick={props.onAnswerInTerminal}>{t(m.answerInTerminal)}</button>}
      </div>}
      <p className="hint">{t(m.teleportHint)}</p>
    </>}
    {props.onRefresh && <button className="btn" onClick={props.onRefresh}>{t(m.checkLocalTask)}</button>}
    {props.localTasks?.map(lt => <p key={lt.id}><button className="btn" onClick={() => props.onOpenTask?.(lt.id)}>{t(m.localTask, { title: lt.title })}</button> <span className="hint">{t(m.workCopy, { cwd: lt.cwd })}</span></p>)}
    <p className="hint">{t(m.cloudOps)}</p>
  </div>;
}
