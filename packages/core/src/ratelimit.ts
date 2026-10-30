import type { AgentEvent, RunnerId, Task } from "@switchboard/protocol";
import type { Db } from "./db.ts";
import { ResumeSupersededError, type TaskManager, type TurnEnd } from "./tasks.ts";
import { GITHUB_NOTE, lastStopWasDaemon, STOP_RESUME_PROMPT } from "./interrupted.ts";
import { GITHUB_REMAINING_MIN } from "./backlog.ts";
import type { GithubBudget } from "@switchboard/protocol";
import { AUTO_RESUME_HEAD } from "./evals.ts";
import type { StopReport } from "./stops.ts";

/**
 * Usage-limit auto-resume (#102). A subscription runner stops a turn when its window (Claude: 5 hours / 7 days) is
 * used up; Claude Code prints "You've hit your session limit · resets 4:10am (Asia/Tokyo)" as the turn's result, next
 * to a `rate_limit_event` whose binding window carries the exact reset time. Everything needed to continue is
 * there — the session id for `--resume`, the time — so the daemon records `Task.resumeAt` and, when the runner's
 * auto-resume setting is on, sends a follow-up turn once that time has passed. Off, the time is only shown.
 *
 * Recorded shape: `quota five_hour {utilization: > 1, resetsAt: <epoch s>}` then
 * `session.end(error, "You've hit your session limit · resets 4:10am (Asia/Tokyo)")`.
 */

/** The default wording of the follow-up after the head (`quotaAndResume.resumePrompt`, #835). */
const RESUME_TEXT = "使用上限がリセットされました。中断した箇所から作業を続けてください。";
/** What the daemon sends to continue. The head says who resumed and why, whatever the wording after it. */
export const RESUME_PROMPT = `${AUTO_RESUME_HEAD} ${RESUME_TEXT}`;
/**
 * A GitHub API limit a turn's command met (#550): the line gh / GraphQL prints, at the head of a line of the result.
 * Only at the head: a `grep` or `Read` of a file that quotes it has a path or a line number first.
 */
export const GITHUB_LIMIT_LINE = /^(?:(?:gh|GraphQL): )?API rate limit (?:already )?exceeded for [^\n]*/m;
export const GITHUB_RESUME_PROMPT = `${AUTO_RESUME_HEAD} GitHub の API 上限が戻りました。中断した箇所から作業を続けてください。`;
export { GITHUB_NOTE };
/** Tools whose result is what they read, not what they ran: a limit line in them is a quote. */
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

/** The GitHub limit line a command's result carries, if any; undefined for a read tool, or none. */
export function githubLimitHit(tool: string, summary: string): string | undefined {
  if (READ_TOOLS.has(tool)) return undefined;
  const m = GITHUB_LIMIT_LINE.exec(summary);
  return m ? m[0] : undefined;
}
/** The banner's time has minute resolution and the window may lift a little late: wait this much past it. */
export const RESUME_MARGIN_MS = 60_000;
/** The reset time has passed but the runner still refuses (lifted late), or the send failed for a passing reason: try again after this. */
export const LATE_RETRY_MS = 5 * 60_000;
/** No reset time anywhere (unknown banner, no quota report): first retry after this, doubling per consecutive stop. */
export const FALLBACK_DELAY_MS = 15 * 60_000;
export const MAX_FALLBACK_DELAY_MS = 4 * 3600_000;
/** A reset this recently past is "lifted late" (wait a bit more), not "tomorrow at the same time". */
export const PAST_GRACE_MS = 6 * 3600_000;
/** A task that hits the limit this many turns in a row *after the daemon resumed it* stops being resumed (a misread time must not loop). */
export const MAX_CONSECUTIVE_STOPS = 8;
/**
 * Runners whose limit may be ended before its time — an early report, a try (#2237): Claude only. Codex's limit detection is not verified yet
 * (its wording is a guess), so its waits keep the planned time.
 */
const EARLY_RUNNERS: ReadonlySet<RunnerId> = new Set(["claude"]);
/**
 * A wait longer than this tries once at this point (#2237): a limit can lift before its reset (the 7-day window waits
 * days), and a refused turn costs nothing (docs/design/rate-limit-resume.md, 早く解けた上限).
 */
export const PROBE_AFTER_MS = 6 * 3600_000;
/** A window at this utilization is the one that stopped the turn (Claude reports > 1 while blocked). */
const SATURATED = 0.999;

const LIMIT_TEXT: Record<RunnerId, RegExp[]> = {
  // Verified: "You've hit your session limit · resets 4:10am (Asia/Tokyo)" (Claude Code 2.1.265, stream-json result), and the
  // API's `rate_limit_error` body on a refused start. Anchored so "generate_limits", "cli.js:429:17", "context limit reached",
  // "max turns (429)" and the like are not mistaken for it.
  claude: [/hit your (?:session |usage |weekly |daily )?limit/i, /\busage limit/i, /\brate[ _-]?limit/i, /too many requests/i],
  // Not recorded yet: matched on wording only (unverified against a recorded message).
  codex: [/\brate[ _-]?limit/i, /\busage limit/i, /too many requests/i, /credits? (?:depleted|exhausted)/i],
  dak: [],
};

/** Whether a runner's error text is its usage / rate limit (as opposed to any other failure). */
export function isLimitText(runner: RunnerId, text: string | undefined): boolean {
  if (!text) return false;
  return (LIMIT_TEXT[runner] ?? []).some((re) => re.test(text));
}

const TIME = "(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?";
const ZONE = "(?:\\s*\\(([^)]+)\\))?";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/**
 * When a banner says the limit lifts (ms), or undefined when it names no time. Verified wording: `resets 4:10am
 * (Asia/Tokyo)`. Also read, unverified: `resets at 16:10`, `resets in 3 hours`, `resets Sep 15 at 4am`, `resets Tue 4am`.
 * A wall-clock time is the next time it comes round in the named zone (the daemon's zone when none or unknown), except
 * that a time passed less than `PAST_GRACE_MS` ago is returned as that past moment — it is the reset that has not taken
 * effect yet, not tomorrow's.
 */
export function parseResetBanner(text: string, now: number): number | undefined {
  const rel = /resets?\s+in\s+(?:(\d+)\s*(?:h|hr|hrs|hours?)\b)?(?:\s*(?:and\s+)?(\d+)\s*(?:m|min|mins|minutes?)\b)?/i.exec(text);
  if (rel && (rel[1] || rel[2])) return now + Number(rel[1] ?? 0) * 3600_000 + Number(rel[2] ?? 0) * 60_000;
  const dated = new RegExp(`resets?\\s+(?:on\\s+)?(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\s+(?:at\\s+)?${TIME}${ZONE}`, "i").exec(text);
  if (dated) {
    const hm = clock(dated[4], dated[5], dated[6]);
    if (!hm) return undefined;
    const tz = validZone(dated[7]) ?? localZone();
    const today = wallClock(now, tz);
    const month = MONTHS.indexOf(dated[1]!.toLowerCase()) + 1;
    const year = dated[3] ? Number(dated[3]) : today.y;
    let at = wallClockToEpoch(year, month, Number(dated[2]), hm.h, hm.m, tz);
    if (!dated[3] && at < now - PAST_GRACE_MS) at = wallClockToEpoch(year + 1, month, Number(dated[2]), hm.h, hm.m, tz);
    return at;
  }
  const weekly = new RegExp(`resets?\\s+(?:on\\s+)?(${DAYS.join("|")})[a-z]*\\.?\\s+(?:at\\s+)?${TIME}${ZONE}`, "i").exec(text);
  if (weekly) {
    const hm = clock(weekly[2], weekly[3], weekly[4]);
    if (!hm) return undefined;
    const tz = validZone(weekly[5]) ?? localZone();
    const today = wallClock(now, tz);
    const want = DAYS.indexOf(weekly[1]!.toLowerCase());
    for (let ahead = 0; ahead < 8; ahead++) {
      const at = wallClockToEpoch(today.y, today.m, today.d + ahead, hm.h, hm.m, tz);
      if (wallClock(at, tz).dow !== want) continue;
      if (at > now || now - at <= PAST_GRACE_MS) return at;
    }
    return undefined;
  }
  const plain = new RegExp(`resets?\\s+(?:at\\s+)?${TIME}${ZONE}`, "i").exec(text);
  if (!plain) return undefined;
  const hm = clock(plain[1], plain[2], plain[3]);
  if (!hm) return undefined;
  const tz = validZone(plain[4]) ?? localZone();
  const today = wallClock(now, tz);
  const at = wallClockToEpoch(today.y, today.m, today.d, hm.h, hm.m, tz);
  if (at > now || now - at <= PAST_GRACE_MS) return at;
  return wallClockToEpoch(today.y, today.m, today.d + 1, hm.h, hm.m, tz);
}

function clock(h: string | undefined, m: string | undefined, ampm: string | undefined): { h: number; m: number } | undefined {
  let hour = Number(h);
  const minute = m ? Number(m) : 0;
  const ap = ampm?.toLowerCase();
  if (ap === "pm" && hour < 12) hour += 12;
  if (ap === "am" && hour === 12) hour = 0;
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return undefined;
  return { h: hour, m: minute };
}

export interface QuotaWindow {
  window: string;
  utilization: number;
  resetsAt: number;
}

/**
 * The reset of the window that stopped the turn: the one the runner names (`limitType`) when it is used up, else the
 * earliest used-up window (waiting for the later one would idle through the earlier one's reset; a second stop simply
 * plans again). Seconds or milliseconds accepted. A reset up to `PAST_GRACE_MS` in the past still counts (lifted late).
 * With the reset, the window's name (#2237: a later report of it under 100 % resumes early).
 */
export function resetFromQuota(windows: QuotaWindow[], now: number, limitType?: string): { at: number; window: string } | undefined {
  const used = windows
    .filter((w) => w.utilization >= SATURATED)
    .map((w) => ({ window: w.window, at: w.resetsAt > 1e12 ? w.resetsAt : w.resetsAt * 1000 })) // Claude reports seconds
    .filter((w) => w.at > now - PAST_GRACE_MS);
  const named = limitType ? used.find((w) => w.window === limitType) : undefined;
  if (named) return named;
  let best: { at: number; window: string } | undefined;
  for (const w of used) if (best === undefined || w.at < best.at) best = w;
  return best;
}

/** Where `fallbackRunner` moved a Task from (#834): the decided runner and its window at the limit. */
export interface FallbackFrom {
  runner: RunnerId;
  window: string;
  utilization: number;
  /** ms */
  resetsAt: number;
}

/**
 * 上限のときの代わり (#834): the runner a Task that starts by itself starts on. A runner is at its limit while one of its
 * windows is at `fallbackAt` or more and has not reset; a runner with no quota rows (DAK) never is. When `runner` is,
 * the candidates are the order after it, then before it (from the head when it is not in the order); the first
 * installed one not at its limit wins, with `from` naming why. No such candidate = `runner` as it is (a stop on the
 * limit is then the automatic resume's).
 */
export function fallbackRunner(runner: RunnerId, cfg: { fallback: RunnerId[]; fallbackAt: number }, quotaFor: (r: RunnerId) => QuotaWindow[], installed: (r: RunnerId) => boolean, now: number): { runner: RunnerId; from?: FallbackFrom } {
  const hot = (r: RunnerId) =>
    quotaFor(r)
      .map((w) => ({ ...w, resetsAt: w.resetsAt > 1e12 ? w.resetsAt : w.resetsAt * 1000 })) // Claude reports seconds
      .find((w) => w.utilization >= cfg.fallbackAt && w.resetsAt > now);
  const at = hot(runner);
  if (!at) return { runner };
  const i = cfg.fallback.indexOf(runner);
  const order = i < 0 ? cfg.fallback : [...cfg.fallback.slice(i + 1), ...cfg.fallback.slice(0, i)];
  const next = order.find((r) => r !== runner && installed(r) && !hot(r));
  return next ? { runner: next, from: { runner, window: at.window, utilization: at.utilization, resetsAt: at.resetsAt } } : { runner };
}

/** The transcript's status line of a switch (#834): 「claude が上限（0.95、04:10 に戻る）のため codex で開始」. */
export function fallbackNote(runner: RunnerId, from: FallbackFrom, now: number): string {
  return `${from.runner} が上限（${from.utilization.toFixed(2)}、${fmtTime(from.resetsAt, now)} に戻る）のため ${runner} で開始`;
}

export interface LimitStop {
  /** The text that identified the stop (banner or error). */
  text: string;
  /** When the limit lifts (ms), if known; may be slightly in the past (lifted late). */
  resetsAt?: number;
  source: "quota" | "banner" | "none";
  /** The quota window that stopped the turn (source "quota" only). */
  window?: string;
}

/**
 * Whether a turn ended on the usage limit, and when it lifts: the quota report's used-up window first (exact), the
 * banner's time second, else unknown. `texts` are the turn's session.end summary and its error messages.
 */
export function detectLimitStop(runner: RunnerId, texts: Array<string | undefined>, quota: QuotaWindow[], now: number, limitType?: string): LimitStop | undefined {
  const text = texts.find((t) => isLimitText(runner, t));
  if (!text) return undefined;
  const fromQuota = resetFromQuota(quota, now, limitType);
  if (fromQuota !== undefined) return { text, resetsAt: fromQuota.at, source: "quota", window: fromQuota.window };
  const fromBanner = texts.map((t) => (t ? parseResetBanner(t, now) : undefined)).find((t) => t !== undefined);
  if (fromBanner !== undefined) return { text, resetsAt: fromBanner, source: "banner" };
  return { text, source: "none" };
}

/**
 * When to send the follow-up: a little after the reset; `LATE_RETRY_MS` from now when the reset already passed (the
 * runner still refused, so the window lifted late); when no time is known, `FALLBACK_DELAY_MS` doubling with each
 * consecutive stop (`attempt` = 1 for the first) up to `MAX_FALLBACK_DELAY_MS`. Never in the past. `delay` is the
 * setting `quotaAndResume` (#835); absent = those constants.
 */
export function planResumeAt(stop: LimitStop, now: number, attempt = 1, delay: Pick<ResumeTunables, "retryDelayMs" | "retryMaxDelayMs"> = DEFAULT_TUNABLES): number {
  if (stop.resetsAt === undefined) return now + Math.min(delay.retryDelayMs * 2 ** Math.max(0, attempt - 1), delay.retryMaxDelayMs);
  if (stop.resetsAt <= now) return now + LATE_RETRY_MS;
  return stop.resetsAt + RESUME_MARGIN_MS;
}

/** The values of the setting `quotaAndResume` the resumer uses (#835). */
export interface ResumeTunables {
  retryDelayMs: number;
  retryMaxDelayMs: number;
  maxLimitStops: number;
  /** Without the head: the daemon puts `AUTO_RESUME_HEAD` before it, so the turn is still told from a person's. */
  resumePrompt: string;
}
const DEFAULT_TUNABLES: ResumeTunables = { retryDelayMs: FALLBACK_DELAY_MS, retryMaxDelayMs: MAX_FALLBACK_DELAY_MS, maxLimitStops: MAX_CONSECUTIVE_STOPS, resumePrompt: RESUME_TEXT };

export interface ResumerOptions {
  /** The runner's auto-resume setting, read on every use so a PATCH takes effect at once. */
  enabled: (runner: RunnerId) => boolean;
  /** The setting `quotaAndResume` (#835), read on every use like `enabled`. Absent = the constants and `prompt`. */
  tunables?: () => ResumeTunables;
  now?: () => number;
  /** The usage-limit follow-up, whole. Ignored when `tunables` is given (its `resumePrompt` after the head is sent). */
  prompt?: string;
  log?: (message: string) => void;
  /** GitHub's GraphQL budget for a checkout (#550, `GithubBudgetCache`): when a turn met the GitHub limit, the time it comes back. Absent = a fallback delay. */
  githubBudget?: (cwd: string) => Promise<GithubBudget | null>;
}

/**
 * Watches turn ends for a usage-limit stop, records `resumeAt`, and (setting on) sends the follow-up when due. A 30 s
 * ticker rather than one timer per task: `resume_at` is a column, so a daemon restart, or the setting being switched
 * on later, picks the waiting tasks up on the next tick with no state to rebuild.
 */
export class RateLimitResumer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  /**
   * Consecutive limit stops per task since a person last started a turn. A turn the daemon itself resumed that stops
   * again counts; a turn the person sent starts the count over (their reply is a decision to go on). In memory: a
   * restart starts over.
   */
  private stops = new Map<string, number>();
  /** Tasks whose current turn was started by the resumer (so its end can be told from a person's turn). */
  private resumedByUs = new Set<string>();
  /**
   * Tasks whose current turn is the one try before a long wait (#2237), with the time the wait goes back to when it is
   * refused. In memory like `stops`: after a restart a refused try plans afresh.
   */
  private probing = new Map<string, number>();
  /** Tasks whose follow-up is being sent, so a tick during the await cannot send twice. */
  private sending = new Set<string>();
  /**
   * The turns whose GitHub plan waits for the budget read (#550), as `task#n` with n counting the task's turn ends
   * here: forgetting the task's plan (a reply, 中断, a cancel — `TaskManager.onPlanForgotten`) takes them out, and the
   * read then plans nothing; a later turn's read does not consume an earlier one's marker.
   */
  private githubPending = new Set<string>();
  private turnEnds = new Map<string, number>();
  private unsubscribeForget: (() => void) | null = null;
  private now: () => number;
  private prompt: string;
  private log: (m: string) => void;

  constructor(
    private db: Db,
    private tasks: TaskManager,
    private opts: ResumerOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.prompt = opts.prompt ?? RESUME_PROMPT;
    this.log = opts.log ?? (() => undefined);
  }

  private tunables(): ResumeTunables {
    return this.opts.tunables?.() ?? DEFAULT_TUNABLES;
  }

  /** The follow-up of a usage-limit stop: the setting's text after the head, or the constructor's prompt. */
  private resumePrompt(): string {
    return this.opts.tunables ? `${AUTO_RESUME_HEAD} ${this.tunables().resumePrompt}` : this.prompt;
  }

  /** Subscribe to turn ends and start the ticker. */
  start(intervalMs = 30_000) {
    if (!this.unsubscribe) this.unsubscribe = this.tasks.onTurnEnd((taskId, task, turn) => this.onTurnEnd(taskId, task, turn));
    if (!this.unsubscribeForget) this.unsubscribeForget = this.tasks.onPlanForgotten((taskId) => this.dropPending(taskId));
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeForget?.();
    this.unsubscribeForget = null;
  }

  /** The task's GitHub plans still waiting for their budget read are dropped; true when there was one. */
  private dropPending(taskId: string): boolean {
    let had = false;
    for (const key of [...this.githubPending]) if (key.startsWith(`${taskId}#`)) had = this.githubPending.delete(key) || had;
    return had;
  }

  /** Tasks waiting on a limit (resumeAt set), soonest first. */
  pending(): Task[] {
    return this.db.listTasksWithResume();
  }

  /** Called on every turn end: records the stop (with the time) or forgets a task that got past it. */
  onTurnEnd(taskId: string, task: Task, turn: TurnEnd): void {
    const ours = this.resumedByUs.delete(taskId);
    const probe = this.probing.get(taskId);
    this.probing.delete(taskId);
    const now = this.now();
    // The turn's own quota report is the runner's view at the moment it stopped; the table (last report per runner,
    // any task) only when the turn had none. Read for a turn that ended on an error only.
    const q = turn.quota;
    const windows = (): QuotaWindow[] => (q ? Object.entries(q.windows).map(([window, v]) => ({ window, ...v })) : this.db.quotaFor(task.runner));
    const stop = turn.end.status === "error" ? detectLimitStop(task.runner, [turn.end.summary, ...turn.errors], windows(), now, q?.limitType) : undefined;
    if (!stop) {
      // a turn the runner's limit did not stop (it ended by itself, or on another error) but whose commands met
      // GitHub's limit waits for GitHub's time (#550); a cut turn (aborted) is the person's, left alone
      if (turn.end.status !== "aborted" && turn.githubLimit) {
        void this.planGithub(taskId, task, turn.githubLimit, ours);
        return;
      }
      this.stops.delete(taskId);
      return;
    }
    const wait = stop.window ? { window: stop.window, since: now } : {};
    if (ours && probe !== undefined) {
      // the one try before a long wait was refused: back to the planned time, no second try, not counted as a stop
      const at = probe > now ? probe : planResumeAt(stop, now, 1, this.tunables());
      this.tasks.setResumeAt(taskId, at, "limit", wait);
      this.tasks.record(taskId, { t: "status", text: `使用上限で停止: ${stop.text}。試しは使用上限で断られました。元の予定の ${fmtTime(at, now)} に自動再開します` });
      this.log(`ratelimit: ${taskId} probe refused; back to ${new Date(at).toISOString()}`);
      return;
    }
    const count = ours ? (this.stops.get(taskId) ?? 0) + 1 : 1;
    this.stops.set(taskId, count);
    const tunables = this.tunables();
    if (count > tunables.maxLimitStops) {
      this.tasks.record(taskId, { t: "status", text: `使用上限で停止: ${stop.text}。自動再開の後 ${count - 1} 回続けて止まったので、これ以上は再開しません。返信すると再開します（その後また自動再開の対象になります）` });
      this.log(`ratelimit: ${taskId} stopped ${count} times in a row; giving up`);
      return;
    }
    const at = planResumeAt(stop, now, count, tunables);
    // a long wait tries once first (#2237); with auto-resume off nothing would be sent, so it is planned as before
    const enabled = this.opts.enabled(task.runner);
    const tryAt = enabled && EARLY_RUNNERS.has(task.runner) && at - now > PROBE_AFTER_MS ? now + PROBE_AFTER_MS : undefined;
    this.tasks.setResumeAt(taskId, tryAt ?? at, "limit", { ...wait, plannedAt: tryAt === undefined ? null : at });
    const when = fmtTime(at, now);
    const basis =
      stop.source === "quota"
        ? stop.resetsAt! <= now
          ? "リセット時刻は過ぎているのに止まったので少し待って再試行"
          : "リセット時刻はランナーの quota から"
        : stop.source === "banner"
          ? stop.resetsAt! <= now
            ? "リセット時刻は過ぎているのに止まったので少し待って再試行"
            : "リセット時刻は停止メッセージから"
          : `リセット時刻が分からないので ${Math.round((at - now) / 60_000)} 分後に試します`;
    const action = tryAt !== undefined ? `${fmtTime(tryAt, now)} に 1 回試し、だめなら ${when} に自動再開します` : enabled ? `${when} に自動再開します` : `${when} に再開できます（自動再開は OFF — Home のランナー設定で ON にするか、返信で再開）`;
    this.tasks.record(taskId, { t: "status", text: `使用上限で停止: ${stop.text}。${action}。${basis}` });
    this.log(`ratelimit: ${taskId} hit the ${task.runner} limit; resume at ${new Date(tryAt ?? at).toISOString()} (${stop.source})`);
  }

  /**
   * A turn whose commands met GitHub's API limit and ended by itself (#550): planned at GitHub's reset (+ margin) when
   * the budget says the limit is still on; a short retry when it is back already; a fallback delay when it cannot be
   * read. The budget is read after the turn, so a turn the person started meanwhile is left alone.
   */
  private async planGithub(taskId: string, task: Task, line: string, ours: boolean): Promise<void> {
    const n = (this.turnEnds.get(taskId) ?? 0) + 1;
    this.turnEnds.set(taskId, n);
    const marker = `${taskId}#${n}`;
    this.githubPending.add(marker);
    const budget = await (this.opts.githubBudget?.(task.cwd) ?? Promise.resolve(null)).catch(() => null);
    // the marker is gone when a reply, 中断 or a cancel came meanwhile (TaskManager.onPlanForgotten), or when a later
    // turn of the task ended (its own marker replaced this one): a plan on the old turn would be a wrong one
    if (!this.githubPending.delete(marker) || (this.turnEnds.get(taskId) ?? 0) !== n) return;
    const cur = this.db.getTask(taskId);
    if (!cur || cur.status === "running" || cur.status === "waiting") return;
    const now = this.now();
    const count = ours ? (this.stops.get(taskId) ?? 0) + 1 : 1;
    this.stops.set(taskId, count);
    const tunables = this.tunables();
    if (count > tunables.maxLimitStops) {
      this.tasks.record(taskId, { t: "status", text: `${GITHUB_NOTE}: ${line}。自動再開の後 ${count - 1} 回続けて止まったので、これ以上は再開しません。返信すると再開します` });
      return;
    }
    const limited = budget !== null && budget.remaining < GITHUB_REMAINING_MIN;
    const at = budget === null ? planResumeAt({ resetsAt: undefined, source: "none", text: line }, now, count, tunables) : limited ? planResumeAt({ resetsAt: budget.resetsAt * 1000, source: "quota", text: line }, now, 1, tunables) : now + LATE_RETRY_MS;
    this.tasks.setResumeAt(taskId, at, "github");
    const when = fmtTime(at, now);
    const basis = budget === null ? `GitHub の残量を読めないので ${Math.round((at - now) / 60_000)} 分後に試します` : limited ? (budget.resetsAt * 1000 <= now ? "リセット時刻は過ぎているのに残量が無いので少し待って再試行" : "戻る時刻は GitHub の rateLimit から") : "GitHub の残量は戻っているので少し待って再試行";
    const action = this.opts.enabled(task.runner) ? `${when} に自動再開します` : `${when} に再開できます（自動再開は OFF — Home のランナー設定で ON にするか、返信で再開）`;
    this.tasks.record(taskId, { t: "status", text: `${GITHUB_NOTE}: ${line}。${action}。${basis}` });
    this.log(`ratelimit: ${taskId} met the GitHub API limit; resume at ${new Date(at).toISOString()}`);
  }

  /** Send the follow-up to every due task whose runner has auto-resume on. Returns the ids it resumed. */
  async tick(): Promise<string[]> {
    const now = this.now();
    const resumed: string[] = [];
    for (const t of this.db.listTasksWithResume()) {
      if (t.resumeAt === null) continue;
      const early = t.resumeAt > now && this.liftedEarly(t);
      if (t.resumeAt > now && !early) continue;
      if (!this.opts.enabled(t.runner)) continue;
      if (t.status === "running" || t.status === "waiting" || this.sending.has(t.id)) continue;
      if (early) this.tasks.record(t.id, { t: "status", text: `使用上限が予定（${fmtTime(t.resumePlannedAt ?? t.resumeAt, now)}）より早く戻ったと報告があったので再開します` });
      if (await this.resume(t)) resumed.push(t.id);
    }
    return resumed;
  }

  /**
   * Lifted before its reset (#2237): the window that stopped the task was reported under 100 % after the stop (the
   * `quota` table; any task of the runner reports it). A report from before the stop, or of another window, is not it.
   */
  private liftedEarly(t: Task): boolean {
    if (!EARLY_RUNNERS.has(t.runner) || t.resumeReason === "github" || t.resumeWindow === null || t.resumeSince === null) return false;
    const w = this.db.quotaFor(t.runner).find((q) => q.window === t.resumeWindow);
    return w !== undefined && w.ts > t.resumeSince && w.utilization < SATURATED;
  }

  /** The person's "今すぐ再開": same follow-up, regardless of the time and the setting. */
  async resumeNow(taskId: string): Promise<Task> {
    const t = this.db.getTask(taskId);
    if (!t) throw new Error(`task ${taskId} not found`);
    if (t.status === "running" || t.status === "waiting") throw new Error("the task is still running");
    if (!t.runnerSessionId) throw new Error("the task has no runner session to resume");
    if (this.sending.has(taskId)) throw new Error("a resume is already in flight");
    this.sending.add(taskId);
    try {
      const stopped = lastStopWasDaemon(this.db.listEvents(taskId).map((e) => e.ev));
      const github = t.resumeReason === "github";
      this.tasks.record(taskId, { t: "status", text: stopped ? "中断されたターンを今すぐ再開します" : github ? "GitHub の上限の待ちを打ち切って今すぐ再開します" : "使用上限の待ちを打ち切って今すぐ再開します" });
      return await this.tasks.send(taskId, stopped ? STOP_RESUME_PROMPT : github ? GITHUB_RESUME_PROMPT : this.resumePrompt(), { mirror: false }); // the shadow's runner (#99) hit no limit
    } finally {
      this.sending.delete(taskId);
    }
  }

  /** Forget the planned resume; the task stays as it is and can be continued by replying. */
  cancel(taskId: string): Task {
    const t = this.db.getTask(taskId);
    if (!t) throw new Error(`task ${taskId} not found`);
    this.stops.delete(taskId);
    this.resumedByUs.delete(taskId);
    this.probing.delete(taskId);
    // a GitHub plan still waiting for its budget read is cancelled with it (#550)
    const pending = this.dropPending(taskId);
    if (t.resumeAt === null) {
      if (pending) this.tasks.record(taskId, { t: "status", text: "自動再開を取り消しました（返信すると再開します）" });
      return t;
    }
    const updated = this.tasks.setResumeAt(taskId, null);
    this.tasks.record(taskId, { t: "status", text: "自動再開を取り消しました（返信すると再開します）" });
    return updated;
  }

  private async resume(t: Task): Promise<boolean> {
    if (!t.runnerSessionId) {
      this.tasks.setResumeAt(t.id, null);
      this.tasks.record(t.id, { t: "status", text: "自動再開できません: 再開できるセッションがありません（返信すると新しいセッションで始まります）" });
      return false;
    }
    if (this.tasks.isOverBudget(t.id)) {
      this.tasks.setResumeAt(t.id, null);
      this.tasks.record(t.id, { t: "status", text: `自動再開できません: 予算 $${t.budgetUsd} を超過しています（予算を上げてから返信すると再開します）` });
      return false;
    }
    this.sending.add(t.id);
    // Marked before the send: a runner may end the turn before send() returns (the fakes do), and the end must be
    // told from a person's turn.
    this.resumedByUs.add(t.id);
    if (t.resumePlannedAt !== null) this.probing.set(t.id, t.resumePlannedAt);
    try {
      // The turn itself is the record ("[Switchboard 自動再開] …" as the user message). `asResume` makes send() give
      // up if a reply, 中断 or a cancel landed while a release was awaited.
      // A turn the daemon's own stop cut (interrupted.ts) shares the plan column; its follow-up says what happened.
      const prompt = lastStopWasDaemon(this.db.listEvents(t.id).map((e) => e.ev)) ? STOP_RESUME_PROMPT : t.resumeReason === "github" ? GITHUB_RESUME_PROMPT : this.resumePrompt();
      await this.tasks.send(t.id, prompt, { asResume: true });
      this.log(`ratelimit: resumed ${t.id}`);
      // the failures before this one were the same stop; it is over (#949)
      const failed = this.tasks.stopOf(t.id, RESUME_STOP);
      if (failed && failed.state !== "resolved") this.tasks.recordStop(t.id, resumeStop({ evidence: failed.evidence, state: "resolved", actions: [...failed.actions, { attempt: failed.actions.length, at: this.now(), what: "再開を送れた", ok: true }].slice(-20) }));
      return true;
    } catch (e) {
      this.resumedByUs.delete(t.id);
      this.probing.delete(t.id);
      if (e instanceof ResumeSupersededError) {
        this.log(`ratelimit: ${t.id} ${e.message}`);
        return false;
      }
      // A passing failure (the process exited under us, a spawn error): keep the plan, try again in a while; the same
      // cap as repeated stops bounds it.
      const msg = String((e as Error).message ?? e);
      const count = (this.stops.get(t.id) ?? 0) + 1;
      this.stops.set(t.id, count);
      // The same stop as the task's other failed sends (#949): this path's own cap and timer, recorded — never a second retry.
      const prev = this.tasks.stopOf(t.id, RESUME_STOP);
      const tried = [...(prev && prev.state !== "resolved" ? prev.actions : []), { attempt: count, at: this.now(), what: "再開を送れなかった", ok: false }].slice(-20);
      if (count > this.tunables().maxLimitStops) {
        this.tasks.setResumeAt(t.id, null);
        this.tasks.record(t.id, { t: "status", text: `自動再開できませんでした（${msg}）。${count - 1} 回続けて失敗したので、これ以上は再開しません。返信すると再開します` });
        this.tasks.recordStop(t.id, resumeStop({ evidence: msg, state: "exhausted", actions: tried }));
      } else {
        const at = this.now() + LATE_RETRY_MS;
        // the same wait as before (a GitHub one stays one); only a report after this failure resumes it early, so the
        // report that was just used does not cut the retry's delay short
        this.tasks.setResumeAt(t.id, at, t.resumeReason ?? "limit", { window: t.resumeWindow, since: t.resumeWindow !== null ? this.now() : null, plannedAt: t.resumePlannedAt });
        this.tasks.record(t.id, { t: "status", text: `自動再開できませんでした（${msg}）。${fmtTime(at, this.now())} に再試行します` });
        this.tasks.recordStop(t.id, resumeStop({ evidence: msg, state: "waiting", conditions: [{ key: "resumeAt", value: new Date(at).toISOString(), met: false }], actions: tried }));
      }
      this.log(`ratelimit: resume of ${t.id} failed: ${msg}`);
      return false;
    } finally {
      this.sending.delete(t.id);
    }
  }
}

/** The stop a failed resume send is recorded as (#949): one per task, waiting on its own timer (`resumeAt`), not on a retry. */
const RESUME_STOP = "resume-send";
const resumeStop = (r: Partial<StopReport>): StopReport => ({ id: RESUME_STOP, op: "resume.send", target: "", reason: "transient", evidence: "", safety: "before-effect", conditions: [], actions: [], state: "waiting", ...r, ...(r.evidence !== undefined ? { evidence: r.evidence.slice(0, 300) } : {}) });

/* ---------- time helpers ---------- */

function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

function validZone(name: string | undefined): string | undefined {
  if (!name) return undefined;
  try {
    Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return undefined;
  }
}

function wallClock(epoch: number, tz: string): { y: number; m: number; d: number; h: number; min: number; s: number; dow: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(epoch));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const dow = DAYS.indexOf((parts.find((p) => p.type === "weekday")?.value ?? "").slice(0, 3).toLowerCase());
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") % 24, min: get("minute"), s: get("second"), dow };
}

/** Offset of `tz` from UTC at `epoch` (ms; positive east of Greenwich). */
function tzOffsetMs(epoch: number, tz: string): number {
  const w = wallClock(epoch, tz);
  const asUtc = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min, w.s);
  return asUtc - Math.floor(epoch / 1000) * 1000;
}

/** A wall-clock time in `tz` → epoch ms. `d` may overflow the month (Date.UTC normalises it). */
function wallClockToEpoch(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const first = guess - tzOffsetMs(guess, tz);
  const second = guess - tzOffsetMs(first, tz);
  return second;
}

/** "04:10", or "9/12 04:10" when not today (daemon local time — the same clock the transcript timestamps use). */
export function fmtTime(at: number, now: number): string {
  const a = new Date(at);
  const n = new Date(now);
  const p = (x: number) => String(x).padStart(2, "0");
  const hm = `${p(a.getHours())}:${p(a.getMinutes())}`;
  const sameDay = a.getFullYear() === n.getFullYear() && a.getMonth() === n.getMonth() && a.getDate() === n.getDate();
  return sameDay ? hm : `${a.getMonth() + 1}/${a.getDate()} ${hm}`;
}

/** The events of one turn that matter here, for tests and the design doc. */
export type LimitEvents = Extract<AgentEvent, { t: "session.end" | "error" | "quota" }>;
