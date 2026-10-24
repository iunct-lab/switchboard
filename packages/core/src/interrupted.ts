import type { AgentEvent, Task } from "@switchboard/protocol";
import type { Db } from "./db.ts";
import { AUTO_RESUME_HEAD, isAutomaticUserText } from "./evals.ts";

/**
 * Turns cut by the daemon itself stopping — the host shutting down (a Spot interruption, a stop from the console), a
 * promotion's restart, a crash — are continued by the next daemon the way a usage-limit stop is (#102): `resumeAt` is
 * set to the moment of the stop, and `RateLimitResumer` sends the follow-up on its first tick after the start when the
 * runner's auto-resume is on. Without it, a host that shuts down in the middle of a turn leaves the task as `error`
 * after the start until a person writes to it.
 */

/** The transcript note a stop leaves; also how the resumer and the cap below recognise one. */
export const STOP_NOTE = "デーモンの停止でターンが中断されました";
/** The note a GitHub API limit stop writes (#550, ratelimit.ts): not a daemon stop. */
export const GITHUB_NOTE = "GitHub の API 上限で待機";
/** What the daemon sends to continue after a stop. The runner's commands in flight were killed with it. */
export const STOP_RESUME_PROMPT = `${AUTO_RESUME_HEAD} デーモン（ホスト）の停止でターンが中断されました。実行中だったコマンドやバックグラウンドの処理は終了しています。状態を確かめてから、中断した箇所から作業を続けてください。`;
/** A turn cut this many times in a row is not continued again: a task whose own work takes the host down must not loop. */
export const MAX_STOP_RESUMES = 2;

const isAutoResume = isAutomaticUserText;

/**
 * How many turns in a row were cut by a stop, counting back from the end of the transcript. A turn that ended ok, or
 * a message the person sent, starts the count over (the daemon's own resume messages do not).
 */
export function consecutiveStops(events: AgentEvent[]): number {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.t === "status" && ev.text.startsWith(STOP_NOTE)) n++;
    else if (ev.t === "session.end" && ev.status === "ok") break;
    else if (ev.t === "message.delta" && ev.role === "user" && !isAutoResume(ev.text)) break;
  }
  return n;
}

/** Whether the latest stop in the transcript (since the person last wrote) was a daemon stop rather than a usage limit. */
export function lastStopWasDaemon(events: AgentEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]!;
    if (ev.t === "status" && ev.text.startsWith(STOP_NOTE)) return true;
    if (ev.t === "status" && (ev.text.startsWith("使用上限で停止") || ev.text.startsWith(GITHUB_NOTE))) return false;
    if (ev.t === "message.delta" && ev.role === "user" && !isAutoResume(ev.text)) return false;
  }
  return false;
}

/**
 * Plan the continuation of a task whose turn the stop cut: a note in the transcript and `resumeAt = now`. Nothing is
 * planned without a runner session to resume, nor after `max` stops in a row (the note says so). `max` is the setting
 * `quotaAndResume.maxStopResumes` (#835); absent = `MAX_STOP_RESUMES`.
 * `record` writes the note (the TaskManager's, so the UI sees it; the bare database at start-up).
 */
export function planResumeAfterStop(db: Db, task: Task, now: number, record: (ev: AgentEvent) => void, max = MAX_STOP_RESUMES): boolean {
  if (!task.runnerSessionId) return false;
  const before = consecutiveStops(db.listEvents(task.id).map((e) => e.ev));
  if (before >= max) {
    record({ t: "status", text: `${STOP_NOTE}。${before + 1} 回続けて中断されたので自動再開しません（返信すると再開します）` });
    return false;
  }
  record({ t: "status", text: `${STOP_NOTE}。次に起動したとき同じセッションで自動再開します（ランナーの自動再開が OFF なら返信で再開）` });
  db.updateTask(task.id, { resumeAt: now });
  return true;
}
