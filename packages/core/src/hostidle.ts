/**
 * Stopping the machine when nobody uses it (#181). On a cloud host that runs only while in use, the daemon notices
 * that nothing is going on and hands the stop to the environment: `SWITCHBOARD_IDLE_STOP_CMD <next wake ISO | ->`.
 * The command (the host's sb-stop) registers the wake-up and shuts the machine down; core only decides when. Unset
 * (a Mac) = never.
 */

export interface IdleInput {
  running: number;
  waiting: number;
  /** Background jobs the runners still have after their turn ended (a finished Task waiting for its notification). */
  background: number;
  /** Open UI WebSockets (/ws). */
  ws: number;
  /** Terminal-tab shells (/ws/pty sessions). */
  pty: number;
  /** The earliest planned resume or schedule firing (ms), or null. */
  nextWakeAt: number | null;
}

/** Something due this soon keeps the machine up: stopping and starting again would cost more than staying. */
export const WAKE_MARGIN_MS = 30 * 60_000;
/** How long the daemon must stay idle before it asks to stop. */
export const IDLE_HOLD_MS = 20 * 60_000;

export function evaluateIdle(input: IdleInput, now: number): { idle: boolean; nextWakeAt: number | null } {
  const busy = input.running > 0 || input.waiting > 0 || input.background > 0 || input.ws > 0 || input.pty > 0;
  const soon = input.nextWakeAt !== null && input.nextWakeAt < now + WAKE_MARGIN_MS;
  return { idle: !busy && !soon, nextWakeAt: input.nextWakeAt };
}

/**
 * The earliest time something is due that would wake the host: a planned resume the daemon will act on (its runner's
 * auto-resume is on — a plan left with auto-resume off is only shown, and must not keep the machine up forever) and
 * the enabled schedules' next firings.
 */
export function nextWakeFrom(resumes: Array<{ resumeAt: number | null; auto: boolean }>, schedules: Array<{ enabled: boolean; nextRunAt: number | null }>): number | null {
  const times = [...resumes.filter((r) => r.auto).map((r) => r.resumeAt), ...schedules.filter((s) => s.enabled).map((s) => s.nextRunAt)].filter((t): t is number => typeof t === "number");
  return times.length ? Math.min(...times) : null;
}

/**
 * Calls `onStop` once when `read()` has been idle for `holdMs`; any activity starts the count again. Polling alone
 * misses a socket or a turn that comes and goes between ticks, so the daemon also calls `touch()` when one does.
 */
export class HostIdle {
  private idleSince: number | null = null;
  private fired = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly holdMs: number;
  private readonly tickMs: number;
  private readonly now: () => number;

  constructor(
    private read: () => IdleInput,
    private onStop: (nextWakeAt: number | null) => void,
    opts: { holdMs?: number; tickMs?: number; now?: () => number } = {},
  ) {
    this.holdMs = opts.holdMs ?? IDLE_HOLD_MS;
    this.tickMs = opts.tickMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (!this.timer) this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Something happened (a socket opened or closed, a turn ended): the quiet spell starts again from here. */
  touch(): void {
    this.idleSince = null;
    this.fired = false;
  }

  tick(): void {
    const now = this.now();
    const r = evaluateIdle(this.read(), now);
    if (!r.idle) {
      // activity again: a later quiet spell counts from zero (and may ask to stop again, e.g. after a failed stop)
      this.idleSince = null;
      this.fired = false;
      return;
    }
    this.idleSince ??= now;
    if (!this.fired && now - this.idleSince >= this.holdMs) {
      this.fired = true;
      this.onStop(r.nextWakeAt);
    }
  }
}
