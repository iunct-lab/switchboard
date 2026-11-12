import type { Task } from "@switchboard/protocol";
import { fmtClock } from "./components/ui.tsx";
import { t } from "./i18n.ts";
import { brief as m } from "./i18n/brief.ts";

/** A piece of the Brief's sentence: plain text, or a time shown in bold. */
export type ResumePart = string | { b: string };

export type ResumeBlock = {
  heading: string;
  /** The sentence's start (before the time / the reason-specific tail). */
  stopped: string;
  parts: ResumePart[];
  /** "Resume now" needs a session to resume, except for a Task made at the limit that has not run a turn (`start`, #2768). */
  canResumeNow: boolean;
  nowTitle: string;
};

/** The Brief's wait section for a Task with a plan (`resumeAt` set): what it says and whether "Resume now" can be pressed. */
export function resumeBlock(task: Pick<Task, "resumeAt" | "resumeReason" | "resumePlannedAt" | "runnerSessionId">, autoResumeOn: boolean | undefined): ResumeBlock {
  const when = fmtClock(task.resumeAt ?? 0);
  const hasSession = !!task.runnerSessionId;
  if (task.resumeReason === "start")
    return {
      heading: t(m.resumeLimitHeading),
      stopped: "",
      parts: [t(m.startNotYet), { b: when }, autoResumeOn === true ? t(m.startAuto) : autoResumeOn === false ? t(m.startAutoOff) : t(m.startAutoUnknown)],
      canResumeNow: true,
      nowTitle: t(m.resumeNowStartTitle),
    };
  if (task.resumeReason === "disk")
    return {
      heading: t(m.resumeDiskHeading),
      stopped: t(m.resumeDiskStopped),
      parts: !hasSession
        ? [t(m.resumeNoSession)]
        : autoResumeOn === false
          ? [t(m.diskAutoOff)]
          : autoResumeOn === true
            ? [t(m.diskAutoOnBefore), { b: when }, t(m.diskAutoOnAfter)]
            : [t(m.diskAutoUnknown)],
      canResumeNow: hasSession,
      nowTitle: t(m.resumeNowDiskTitle),
    };
  const github = task.resumeReason === "github";
  const heading = github ? t(m.resumeGithubHeading) : t(m.resumeLimitHeading);
  const stopped = github ? t(m.resumeGithubWaiting) : t(m.resumeLimitStopped);
  const nowTitle = github ? t(m.resumeNowGithubTitle) : t(m.resumeNowLimitTitle);
  const parts: ResumePart[] = !hasSession
    ? [{ b: when }, t(m.limitNoSession)]
    : autoResumeOn === true && task.resumePlannedAt !== null
      ? [{ b: when }, t(m.limitTryOnce), { b: fmtClock(task.resumePlannedAt) }, t(m.limitTryOnceAfter)]
      : [{ b: when }, autoResumeOn === true ? t(m.limitAutoOn) : autoResumeOn === false ? t(m.limitAutoOff) : t(m.limitAutoUnknown)];
  return { heading, stopped, parts, canResumeNow: hasSession, nowTitle };
}
