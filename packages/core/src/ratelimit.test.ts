import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerId, RunnerSession, StartOptions, Task } from "@switchboard/protocol";
import { abortOrphanedTasks, Db } from "./db.ts";
import { STOP_NOTE } from "./evals.ts";
import { consecutiveStops, lastStopWasDaemon, MAX_STOP_RESUMES, STOP_RESUME_PROMPT } from "./interrupted.ts";
import { FALLBACK_DELAY_MS, GITHUB_NOTE, GITHUB_RESUME_PROMPT, LATE_RETRY_MS, MAX_CONSECUTIVE_STOPS, MAX_FALLBACK_DELAY_MS, PAST_GRACE_MS, RESUME_MARGIN_MS, RESUME_PROMPT, RateLimitResumer, type ResumeTunables, detectLimitStop, fallbackNote, fallbackRunner, fmtTime, githubLimitHit, isLimitText, parseResetBanner, planResumeAt, resetFromQuota } from "./ratelimit.ts";
import { ResumeSupersededError, TaskManager } from "./tasks.ts";
import { AUTO_RESUME_HEAD } from "./evals.ts";

// Fixed example: a Wednesday night stop over the 5-hour quota, resetting the next morning in Tokyo.
const BANNER = "You've hit your session limit · resets 4:10am (Asia/Tokyo)";
const STOP_TS = Date.parse("2026-09-09T14:30:00Z"); // 23:30 JST, a Wednesday
const RESETS_AT = 1788981000; // 2026-09-09T19:10:00Z = 04:10 JST
const WEEK_RESET = 1789344000; // 2026-09-14T00:00:00Z
const QUOTA: AgentEvent = { t: "quota", runner: "claude", windows: { five_hour: { utilization: 1.02, resetsAt: RESETS_AT }, seven_day: { utilization: 0.3, resetsAt: WEEK_RESET } }, status: "rejected", limitType: "five_hour" };
const LIMIT_TURN: AgentEvent[] = [{ t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" }, QUOTA, { t: "message.delta", role: "assistant", text: BANNER }, { t: "session.end", status: "error", summary: BANNER }];
const OK_TURN: AgentEvent[] = [{ t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" }, { t: "message.delta", role: "assistant", text: "done" }, { t: "session.end", status: "ok", summary: "done" }];

describe("rate limit: recognising the stop and its reset time (#102)", () => {
  test("Claude's banner and API rate-limit errors count; look-alikes and ordinary errors do not; Codex on wording only", () => {
    expect(isLimitText("claude", BANNER)).toBe(true);
    expect(isLimitText("claude", "You've hit your limit · resets 4pm")).toBe(true);
    expect(isLimitText("claude", 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"..."}}')).toBe(true);
    expect(isLimitText("claude", "Rate limited, try again later")).toBe(true);
    for (const notIt of ["runner exited (1)", "Cannot read properties of undefined", "at file:///cli.js:429:17", "Fixed #429", "Reached max turns (429)", "Context limit reached", "Bash tool output limit reached", "generate_limits failed", "error_max_turns"]) {
      expect(isLimitText("claude", notIt)).toBe(false);
    }
    expect(isLimitText("claude", undefined)).toBe(false);
    expect(isLimitText("codex", "You've reached your usage limit. Try again later.")).toBe(true);
    expect(isLimitText("codex", "stream disconnected before completion")).toBe(false);
    expect(isLimitText("codex", "disk quota exceeded")).toBe(false);
    expect(isLimitText("dak", "rate limit")).toBe(false); // no subscription window to wait for
  });

  test("banner wall clock: next occurrence in the named zone (daemon's zone otherwise); just passed = that past moment (lifted late), long passed = tomorrow; 12am/12pm; 24 h", () => {
    expect(parseResetBanner(BANNER, STOP_TS)).toBe(RESETS_AT * 1000);
    // 04:11:30 JST: the reset passed 90 s ago and the runner still refused → the same (past) moment, not tomorrow
    expect(parseResetBanner(BANNER, RESETS_AT * 1000 + 90_000)).toBe(RESETS_AT * 1000);
    // 11:00 JST: 04:10 is beyond the grace → tomorrow
    expect(parseResetBanner(BANNER, RESETS_AT * 1000 + PAST_GRACE_MS + 1000)).toBe(RESETS_AT * 1000 + 24 * 3600 * 1000);
    // pm, other zone, DST-aware (New York in September is UTC−4)
    expect(parseResetBanner("You've hit your usage limit · resets 4pm (America/New_York)", Date.parse("2026-09-09T12:00:00Z"))).toBe(Date.parse("2026-09-09T20:00:00Z"));
    expect(parseResetBanner("resets 12am (UTC)", Date.parse("2026-09-09T12:00:00Z"))).toBe(Date.parse("2026-09-10T00:00:00Z"));
    expect(parseResetBanner("resets 12:30pm (UTC)", Date.parse("2026-09-09T12:00:00Z"))).toBe(Date.parse("2026-09-09T12:30:00Z"));
    expect(parseResetBanner("limit reached, resets at 16:10 (UTC)", Date.parse("2026-09-09T12:00:00Z"))).toBe(Date.parse("2026-09-09T16:10:00Z"));
    const noZone = parseResetBanner("resets 4:10am (Mars/Olympus)", STOP_TS);
    expect(noZone).toBeGreaterThan(STOP_TS - PAST_GRACE_MS);
    expect(noZone! - STOP_TS).toBeLessThanOrEqual(24 * 3600 * 1000);
    expect(parseResetBanner("no time here", STOP_TS)).toBeUndefined();
    expect(parseResetBanner("resets 25:00 (UTC)", STOP_TS)).toBeUndefined();
  });

  test("banner variants read best-effort: 'in N hours/minutes', a dated reset, a weekday reset (unverified wording)", () => {
    const now = Date.parse("2026-09-09T12:00:00Z"); // Wednesday
    expect(parseResetBanner("You've hit your weekly limit · resets in 3 hours", now)).toBe(now + 3 * 3600_000);
    expect(parseResetBanner("resets in 45 minutes", now)).toBe(now + 45 * 60_000);
    expect(parseResetBanner("resets in 1 hour 30 min", now)).toBe(now + 90 * 60_000);
    expect(parseResetBanner("resets Sep 15 at 4am (UTC)", now)).toBe(Date.parse("2026-09-15T04:00:00Z"));
    expect(parseResetBanner("resets on September 15, 2026 at 4:30pm (UTC)", now)).toBe(Date.parse("2026-09-15T16:30:00Z"));
    expect(parseResetBanner("resets Jan 2 at 1am (UTC)", Date.parse("2026-12-30T12:00:00Z"))).toBe(Date.parse("2027-01-02T01:00:00Z")); // year rolls over
    expect(parseResetBanner("resets Tue 4am (UTC)", now)).toBe(Date.parse("2026-09-15T04:00:00Z"));
    expect(parseResetBanner("resets Wed 4am (UTC)", now)).toBe(Date.parse("2026-09-16T04:00:00Z")); // today's 04:00 is 8 h past → next week
    expect(parseResetBanner("resets Wed 11:30am (UTC)", now)).toBe(Date.parse("2026-09-09T11:30:00Z")); // 30 min past → lifted late
  });

  test("quota: the window the runner names wins when used up, else the earliest used-up one; < 100 % or long past is not it; recently past counts", () => {
    const now = STOP_TS;
    const five = { window: "five_hour", utilization: 1.02, resetsAt: RESETS_AT };
    const week = { window: "seven_day", utilization: 1.0, resetsAt: WEEK_RESET };
    expect(resetFromQuota([five, { window: "seven_day", utilization: 0.3, resetsAt: WEEK_RESET }], now)).toBe(RESETS_AT * 1000);
    expect(resetFromQuota([{ window: "five_hour", utilization: 0.78, resetsAt: RESETS_AT }], now)).toBeUndefined();
    expect(resetFromQuota([five, { window: "seven_day", utilization: 0.995, resetsAt: WEEK_RESET }], now)).toBe(RESETS_AT * 1000); // 99.5 % is not used up
    expect(resetFromQuota([five, week], now)).toBe(RESETS_AT * 1000); // both used up, none named → the earlier reset
    expect(resetFromQuota([five, week], now, "seven_day")).toBe(WEEK_RESET * 1000); // the runner says the weekly one binds
    expect(resetFromQuota([five, week], now, "five_hour")).toBe(RESETS_AT * 1000);
    expect(resetFromQuota([{ ...five, utilization: 0.5 }, week], now, "five_hour")).toBe(WEEK_RESET * 1000); // named but not used up → the other
    expect(resetFromQuota([{ window: "five_hour", utilization: 1, resetsAt: Math.floor(now / 1000) - 60 }], now)).toBe((Math.floor(now / 1000) - 60) * 1000); // a minute ago: lifted late
    expect(resetFromQuota([{ window: "five_hour", utilization: 1, resetsAt: Math.floor((now - PAST_GRACE_MS) / 1000) - 60 }], now)).toBeUndefined(); // stale
    expect(resetFromQuota([{ window: "five_hour", utilization: 1, resetsAt: RESETS_AT * 1000 }], now)).toBe(RESETS_AT * 1000); // ms accepted too
  });

  test("detection prefers the quota's time over the banner's, then the banner, then none; the plan: margin after a future reset, short retry after a passed one, doubling fallback when unknown", () => {
    const q = [{ window: "five_hour", utilization: 1.02, resetsAt: RESETS_AT + 300 }];
    expect(detectLimitStop("claude", [BANNER], q, STOP_TS)).toEqual({ text: BANNER, resetsAt: (RESETS_AT + 300) * 1000, source: "quota" });
    expect(detectLimitStop("claude", [BANNER], [], STOP_TS)).toEqual({ text: BANNER, resetsAt: RESETS_AT * 1000, source: "banner" });
    expect(detectLimitStop("claude", ["runner exited (1)", "API Error: 429 rate_limit_error"], [], STOP_TS)).toEqual({ text: "API Error: 429 rate_limit_error", source: "none" });
    expect(detectLimitStop("claude", ["runner exited (1)"], q, STOP_TS)).toBeUndefined(); // a used-up quota alone is not a stop
    expect(planResumeAt({ text: BANNER, resetsAt: RESETS_AT * 1000, source: "banner" }, STOP_TS)).toBe(RESETS_AT * 1000 + RESUME_MARGIN_MS);
    expect(planResumeAt({ text: BANNER, resetsAt: STOP_TS - 5000, source: "banner" }, STOP_TS)).toBe(STOP_TS + LATE_RETRY_MS); // passed: the window lifted late
    expect(planResumeAt({ text: BANNER, source: "none" }, STOP_TS)).toBe(STOP_TS + FALLBACK_DELAY_MS);
    expect(planResumeAt({ text: BANNER, source: "none" }, STOP_TS, 3)).toBe(STOP_TS + 4 * FALLBACK_DELAY_MS);
    expect(planResumeAt({ text: BANNER, source: "none" }, STOP_TS, 8)).toBe(STOP_TS + MAX_FALLBACK_DELAY_MS);
  });
});

/** A runner whose turns are scripted per start/send (the last script repeats); records what it was asked; can be made to refuse a send. */
function fakeAdapter(turns: AgentEvent[][], starts: StartOptions[], sends: string[], ctl: { failSend?: boolean } = {}): RunnerAdapter {
  let n = 0;
  return {
    id: "claude",
    async detect() {
      return { available: true };
    },
    start(opts, emit) {
      starts.push(opts);
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      const play = () => {
        const script = turns[Math.min(n++, turns.length - 1)] ?? [];
        queueMicrotask(() => {
          for (const ev of script) emit(ev);
        });
      };
      play();
      const session: RunnerSession = {
        send: (text) => {
          if (ctl.failSend) {
            ctl.failSend = false;
            throw new Error("runner process has exited; resume the task instead");
          }
          sends.push(text);
          emit({ t: "message.delta", role: "user", text });
          play();
        },
        respondPermission: () => undefined,
        abort: async () => resolveExit(null),
        close: async () => resolveExit(0),
        exited,
      };
      return session;
    },
  };
}

describe("rate limit: RateLimitResumer (#102)", () => {
  let home: string;
  let db: Db;
  let tasks: TaskManager;
  let starts: StartOptions[];
  let sends: string[];
  let broadcasts: unknown[];
  let now: number;
  let enabled: boolean;
  let resumer: RateLimitResumer;
  const ctl: { failSend?: boolean } = {};
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const statuses = (id: string) => db.listEvents(id).map((e) => e.ev).filter((e): e is Extract<AgentEvent, { t: "status" }> => e.t === "status").map((e) => e.text);

  const boot = (turns: AgentEvent[][]) => {
    tasks = new TaskManager(db, new Map([["claude", fakeAdapter(turns, starts, sends, ctl)]]), (m) => broadcasts.push(m), { idleMs: -1 });
    resumer = new RateLimitResumer(db, tasks, { enabled: () => enabled, now: () => now });
    resumer.start(3_600_000); // the ticker is driven by hand here
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-ratelimit-"));
    db = new Db(join(home, "db.sqlite"));
    starts = [];
    sends = [];
    broadcasts = [];
    now = STOP_TS;
    enabled = true;
    ctl.failSend = false;
  });
  afterEach(async () => {
    resumer.stop();
    await tasks.shutdown();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("a limit stop records resumeAt from the turn's quota (+ margin) and a note; the due tick sends the resume prompt on the same session; the setting off only records", async () => {
    boot([LIMIT_TURN, OK_TURN]);
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    let cur = db.getTask(t.id)!;
    expect(cur.status).toBe("error");
    expect(cur.resumeAt).toBe(RESETS_AT * 1000 + RESUME_MARGIN_MS);
    expect(statuses(t.id).at(-1)).toContain(`${fmtTime(cur.resumeAt!, now)} に自動再開します`); // 04:11 JST, in the daemon's zone
    expect(statuses(t.id).at(-1)).toContain("quota");
    expect(broadcasts.some((m) => (m as { type: string; task?: { resumeAt: number | null } }).type === "task.updated" && (m as { task: { resumeAt: number | null } }).task.resumeAt === cur.resumeAt)).toBe(true);
    // not due yet
    expect(await resumer.tick()).toEqual([]);
    expect(sends).toEqual([]);
    // due, but the setting is off: nothing is sent, the plan stays
    now = cur.resumeAt! + 1;
    enabled = false;
    expect(await resumer.tick()).toEqual([]);
    expect(db.getTask(t.id)!.resumeAt).toBe(cur.resumeAt);
    // switched on: the next tick sends the follow-up to the same session; resumeAt is cleared; the turn ends ok
    enabled = true;
    expect(await resumer.tick()).toEqual([t.id]);
    await settle();
    expect(sends).toEqual([RESUME_PROMPT]); // the live process took it (idleMs -1 keeps it)
    cur = db.getTask(t.id)!;
    expect(cur.resumeAt).toBeNull();
    expect(cur.status).toBe("done");
    expect(await resumer.tick()).toEqual([]); // nothing left
  });

  test("the window the runner names decides the wait; without a turn quota the runner's last report is used", async () => {
    const both: AgentEvent = { t: "quota", runner: "claude", windows: { five_hour: { utilization: 1.02, resetsAt: RESETS_AT }, seven_day: { utilization: 1.01, resetsAt: WEEK_RESET } }, limitType: "seven_day" };
    boot([[LIMIT_TURN[0]!, both, LIMIT_TURN[3]!], [LIMIT_TURN[0]!, LIMIT_TURN[3]!]]);
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    expect(db.getTask(t.id)!.resumeAt).toBe(WEEK_RESET * 1000 + RESUME_MARGIN_MS);
    // a second task stops without a quota report of its own → the table's five_hour (fresh from task 1) applies
    db.upsertQuota("claude", "five_hour", 1.02, RESETS_AT, now);
    db.upsertQuota("claude", "seven_day", 0.3, WEEK_RESET, now);
    const t2 = tasks.create({ cwd: home, title: "t2", prompt: "go", runner: "claude" });
    await settle();
    expect(db.getTask(t2.id)!.resumeAt).toBe(RESETS_AT * 1000 + RESUME_MARGIN_MS);
  });

  test("with the process released, the resume goes through --resume; the plan survives a reopened database; no session → dropped with a note; over budget → dropped with a note", async () => {
    boot([LIMIT_TURN, OK_TURN]);
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    await tasks.release(t.id);
    // a daemon restart: same file, new objects
    resumer.stop();
    await tasks.shutdown();
    db.close();
    db = new Db(join(home, "db.sqlite"));
    expect(db.getTask(t.id)!.resumeAt).toBe(RESETS_AT * 1000 + RESUME_MARGIN_MS);
    boot([OK_TURN]);
    now = RESETS_AT * 1000 + RESUME_MARGIN_MS;
    expect(await resumer.tick()).toEqual([t.id]);
    await settle();
    expect(starts.length).toBe(2);
    expect(starts[1]?.resumeSessionId).toBe("sess-1");
    expect(starts[1]?.prompt).toBe(RESUME_PROMPT);
    expect(db.getTask(t.id)!.status).toBe("done");
    // no session id → cannot resume: cleared with a note, never sent
    db.updateTask(t.id, { runnerSessionId: null, resumeAt: now - 1, resumeReason: null, status: "error" });
    expect(await resumer.tick()).toEqual([]);
    expect(db.getTask(t.id)!.resumeAt).toBeNull();
    expect(statuses(t.id).at(-1)).toContain("再開できるセッションがありません");
    // over budget → dropped with a note (raising the budget and replying is the person's call)
    db.updateTask(t.id, { runnerSessionId: "sess-1", resumeAt: now - 1, resumeReason: null, status: "error", budgetUsd: 0.000001 });
    db.insertLedger({ taskId: t.id, runner: "claude", model: "m", inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, costUsd: 1, billedUsd: 0, source: "reported", ts: now });
    expect(await resumer.tick()).toEqual([]);
    expect(db.getTask(t.id)!.resumeAt).toBeNull();
    expect(statuses(t.id).at(-1)).toContain("予算");
    expect(starts.length).toBe(2);
  });

  test("a resumed turn that stops again is planned again; after the cap the daemon stops resuming; a person's reply starts the count over", async () => {
    boot([LIMIT_TURN]); // every turn hits the limit
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    expect(db.getTask(t.id)!.resumeAt).not.toBeNull(); // stop 1 (the person's turn)
    for (let i = 1; i < MAX_CONSECUTIVE_STOPS; i++) {
      now = db.getTask(t.id)!.resumeAt! + 1;
      expect(await resumer.tick()).toEqual([t.id]);
      await settle();
      expect(db.getTask(t.id)!.resumeAt).not.toBeNull(); // planned again
    }
    now = db.getTask(t.id)!.resumeAt! + 1;
    expect(await resumer.tick()).toEqual([t.id]);
    await settle();
    expect(db.getTask(t.id)!.resumeAt).toBeNull(); // the 8th resume stopped too: no plan
    expect(statuses(t.id).at(-1)).toContain("これ以上は再開しません");
    expect(sends.length).toBe(MAX_CONSECUTIVE_STOPS);
    // the person replies and that turn stops on the limit too → a fresh count, planned again (their reply is a decision to go on)
    await tasks.send(t.id, "続けて");
    await settle();
    expect(db.getTask(t.id)!.resumeAt).not.toBeNull();
    expect(statuses(t.id).at(-1)).toContain("自動再開します");
  });

  test("a reply or 中断 clears the plan; cancel forgets it with a note; resumeNow sends at once regardless of time and setting", async () => {
    boot([LIMIT_TURN, OK_TURN, LIMIT_TURN, OK_TURN, LIMIT_TURN]);
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    expect(db.getTask(t.id)!.resumeAt).not.toBeNull();
    await tasks.send(t.id, "continue please");
    expect(db.getTask(t.id)!.resumeAt).toBeNull();
    await settle();
    expect(db.getTask(t.id)!.status).toBe("done");
    await tasks.send(t.id, "again"); // → limit
    await settle();
    expect(db.getTask(t.id)!.resumeAt).not.toBeNull();
    expect(resumer.pending().map((x) => x.id)).toEqual([t.id]);
    const cancelled = resumer.cancel(t.id);
    expect(cancelled.resumeAt).toBeNull();
    expect(statuses(t.id).at(-1)).toContain("取り消しました");
    expect(resumer.pending()).toEqual([]);
    expect(resumer.cancel(t.id).resumeAt).toBeNull(); // idempotent, no second note
    expect(statuses(t.id).filter((s) => s.includes("取り消しました")).length).toBe(1);
    // resumeNow: setting off, time not reached
    enabled = false;
    await tasks.send(t.id, "once more"); // → ok
    await settle();
    await tasks.send(t.id, "and again"); // → limit
    await settle();
    expect(db.getTask(t.id)!.resumeAt).not.toBeNull();
    const before = sends.length;
    await resumer.resumeNow(t.id);
    expect(sends.at(-1)).toBe(RESUME_PROMPT);
    expect(sends.length).toBe(before + 1);
    // 中断 while a plan exists forgets it
    await settle();
    expect(db.getTask(t.id)!.resumeAt).not.toBeNull(); // that turn hit the limit again (script end repeats)
    await tasks.abort(t.id);
    expect(db.getTask(t.id)!.resumeAt).toBeNull();
    await expect(resumer.resumeNow(t.id)).resolves.toBeDefined(); // still possible by hand (a new turn)
  });

  test("a resume that lost the race to a reply / cancel sends nothing (send asResume checks the plan after the wait); a passing send failure keeps the plan and retries", async () => {
    boot([LIMIT_TURN, OK_TURN]);
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    // the plan was cleared meanwhile (a cancel, a reply) → the resumer's own send is refused, nothing goes out
    resumer.cancel(t.id);
    await expect(tasks.send(t.id, RESUME_PROMPT, { asResume: true })).rejects.toBeInstanceOf(ResumeSupersededError);
    expect(sends).toEqual([]);
    // the same while the task is running
    db.updateTask(t.id, { resumeAt: now, resumeReason: null, status: "running" });
    await expect(tasks.send(t.id, RESUME_PROMPT, { asResume: true })).rejects.toBeInstanceOf(ResumeSupersededError);
    expect(db.getTask(t.id)!.resumeAt).toBe(now); // untouched
    db.updateTask(t.id, { status: "error" });
    // a passing failure: the process refuses the text → plan pushed by LATE_RETRY, a note, nothing dropped
    ctl.failSend = true;
    expect(await resumer.tick()).toEqual([]);
    expect(db.getTask(t.id)!.resumeAt).toBe(now + LATE_RETRY_MS);
    expect(statuses(t.id).at(-1)).toContain("再試行します");
    // recorded as the task's stop (#949), waiting on this path's own timer — not a second retry of its own
    expect(tasks.stopOf(t.id, "resume-send")).toMatchObject({ op: "resume.send", reason: "transient", state: "waiting", conditions: [{ key: "resumeAt", met: false }], actions: [{ attempt: 1, ok: false }] });
    // and the retry goes through
    now += LATE_RETRY_MS + 1;
    expect(await resumer.tick()).toEqual([t.id]);
    await settle();
    expect(sends).toEqual([RESUME_PROMPT]);
    expect(db.getTask(t.id)!.status).toBe("done");
    expect(tasks.stopOf(t.id, "resume-send")).toMatchObject({ state: "resolved", actions: [{ ok: false }, { ok: true }] });
  });

  test("a runner refusing to start with a 429 on stderr (error + session.end without a banner) is a stop with no known time → fallback delay", async () => {
    const turn: AgentEvent[] = [{ t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" }, { t: "error", message: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}' }, { t: "session.end", status: "error", summary: "runner exited (1)" }];
    boot([turn]);
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    expect(db.getTask(t.id)!.resumeAt).toBe(STOP_TS + FALLBACK_DELAY_MS);
    expect(statuses(t.id).at(-1)).toContain("15 分後");
    // the resumed turn fails the same way → the fallback doubles
    now = STOP_TS + FALLBACK_DELAY_MS + 1;
    expect(await resumer.tick()).toEqual([t.id]);
    await settle();
    expect(db.getTask(t.id)!.resumeAt).toBe(now + 2 * FALLBACK_DELAY_MS);
  });

  test("an ordinary error is not a stop: no plan, nothing sent", async () => {
    boot([[{ t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" }, { t: "session.end", status: "error", summary: "Cannot read properties of undefined" }]]);
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    expect(db.getTask(t.id)!.resumeAt).toBeNull();
    now += 24 * 3600 * 1000;
    expect(await resumer.tick()).toEqual([]);
  });
});

describe("a turn the daemon's stop cut continues on the next start (interrupted.ts)", () => {
  let home: string;
  let db: Db;
  let starts: StartOptions[];
  let sends: string[];
  let enabled: boolean;
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const statuses = (id: string) => db.listEvents(id).map((e) => e.ev).filter((e): e is Extract<AgentEvent, { t: "status" }> => e.t === "status").map((e) => e.text);
  // a turn still in flight when the daemon stops: it started, nothing ended it
  const HANGING: AgentEvent[] = [{ t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" }, { t: "message.delta", role: "assistant", text: "working…" }];
  const daemon = (turns: AgentEvent[][]) => {
    const tasks = new TaskManager(db, new Map([["claude", fakeAdapter(turns, starts, sends)]]), () => undefined, { idleMs: -1 });
    const resumer = new RateLimitResumer(db, tasks, { enabled: () => enabled });
    return { tasks, resumer };
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-interrupted-"));
    db = new Db(join(home, "db.sqlite"));
    starts = [];
    sends = [];
    enabled = true;
  });
  afterEach(() => {
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("the shutdown notes the cut turn and plans it; the next daemon's first tick sends the stop's own prompt on the same session; a finished task is left alone", async () => {
    const a = daemon([HANGING]);
    const t = a.tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    const finished = a.tasks.create({ cwd: home, title: "f", prompt: "go", runner: "claude" });
    await settle();
    db.updateTask(finished.id, { status: "done" }); // its process is still there, idle
    const before = Date.now();
    await a.tasks.shutdown();
    expect(db.getTask(t.id)!.status).not.toBe("running");
    expect(db.getTask(t.id)!.resumeAt).toBeGreaterThanOrEqual(before);
    expect(statuses(t.id).some((s) => s.startsWith(STOP_NOTE) && s.includes("自動再開します"))).toBe(true);
    expect(db.getTask(finished.id)!.resumeAt).toBeNull();

    const b = daemon([OK_TURN]);
    expect(await b.resumer.tick()).toEqual([t.id]);
    await settle();
    expect(starts.at(-1)!.resumeSessionId).toBe("sess-1");
    expect(starts.at(-1)!.prompt).toBe(STOP_RESUME_PROMPT);
    expect(db.getTask(t.id)!.status).toBe("done");
    expect(db.getTask(t.id)!.resumeAt).toBeNull();
    await b.tasks.shutdown();
  });

  test("auto-resume off: the plan is only recorded; a usage-limit stop after a daemon stop gets the limit's prompt", async () => {
    enabled = false;
    const a = daemon([HANGING]);
    const t = a.tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    await a.tasks.shutdown();
    const b = daemon([LIMIT_TURN]);
    expect(await b.resumer.tick()).toEqual([]);
    expect(db.getTask(t.id)!.resumeAt).not.toBeNull();
    const evs = () => db.listEvents(t.id).map((e) => e.ev);
    expect(lastStopWasDaemon(evs())).toBe(true);
    db.appendEvent(t.id, { t: "message.delta", role: "user", text: STOP_RESUME_PROMPT });
    db.appendEvent(t.id, { t: "status", text: "使用上限で停止: …" });
    expect(lastStopWasDaemon(evs())).toBe(false);
    expect(lastStopWasDaemon([])).toBe(false);
    await b.tasks.shutdown();
  });

  test(`${MAX_STOP_RESUMES} cuts in a row are the last continued (a task whose work takes the host down must not loop); a turn that ends ok or the person's message starts the count over`, async () => {
    const note: AgentEvent = { t: "status", text: `${STOP_NOTE}。…` };
    const resume: AgentEvent = { t: "message.delta", role: "user", text: STOP_RESUME_PROMPT };
    expect(consecutiveStops([note, resume, note])).toBe(2);
    expect(consecutiveStops([note, { t: "session.end", status: "ok" }, resume, note])).toBe(1);
    expect(consecutiveStops([note, resume, { t: "message.delta", role: "user", text: "つづけて" }, note])).toBe(1);
    expect(consecutiveStops([{ t: "status", text: "使用上限で停止: …" }])).toBe(0);

    for (let i = 1; i <= MAX_STOP_RESUMES + 1; i++) {
      const d = daemon([HANGING]);
      const t = i === 1 ? d.tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" }) : db.listTasks()[0]!;
      if (i > 1) await d.tasks.send(t.id, STOP_RESUME_PROMPT, { asResume: true });
      await settle();
      await d.tasks.shutdown();
      const planned = db.getTask(t.id)!.resumeAt !== null;
      expect(planned).toBe(i <= MAX_STOP_RESUMES);
    }
    expect(statuses(db.listTasks()[0]!.id).at(-1)).toContain("自動再開しません");
  });

  test("a daemon that died without its shutdown: the next start closes the orphan and plans it the same way; no session, no plan", () => {
    const now = Date.now();
    const mk = (id: string, sess: string | null) => db.insertTask({ id, workspaceId: null, title: id, runner: "claude", cwd: home, scope: [home], status: "running", runnerSessionId: sess, executionMode: "local", cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now });
    mk("task_a", "sess-a");
    mk("task_b", null);
    expect(abortOrphanedTasks(db, now)).toEqual(["task_a", "task_b"]);
    expect(db.getTask("task_a")).toMatchObject({ status: "aborted", resumeAt: now });
    expect(statuses("task_a").at(-1)).toStartWith(STOP_NOTE);
    expect(db.getTask("task_b")).toMatchObject({ status: "aborted", resumeAt: null });
  });

  test("a shutdown that planned the turn and was then killed mid-abort (left running) is one stop, not two", async () => {
    const a = daemon([HANGING]);
    const t = a.tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    await a.tasks.shutdown();
    db.updateTask(t.id, { status: "running" }); // what a SIGKILL during the abort leaves
    expect(abortOrphanedTasks(db)).toEqual([t.id]);
    expect(statuses(t.id).filter((s) => s.startsWith(STOP_NOTE))).toHaveLength(1);
    expect(consecutiveStops(db.listEvents(t.id).map((e) => e.ev))).toBe(1);
  });

  test("「今すぐ再開」on a stop-planned task (auto-resume off) sends the stop's prompt, not the usage-limit one", async () => {
    enabled = false;
    const a = daemon([HANGING]);
    const t = a.tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    await a.tasks.shutdown();
    const b = daemon([OK_TURN]);
    await b.resumer.resumeNow(t.id);
    await settle();
    expect(starts.at(-1)!.prompt).toBe(STOP_RESUME_PROMPT);
    expect(statuses(t.id)).toContain("中断されたターンを今すぐ再開します");
    await b.tasks.shutdown();
  });

  test("a turn waiting on a permission is cut and planned too", async () => {
    const ask: AgentEvent = { t: "permission.ask", id: "p1", kind: "exec", tool: "Bash", input: {}, detail: "ls" };
    const a = daemon([[...HANGING, ask]]);
    const t = a.tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    expect(db.getTask(t.id)!.status).toBe("waiting");
    await a.tasks.shutdown();
    expect(db.getTask(t.id)!.resumeAt).not.toBeNull();
  });
});

describe("settings tunables (#835): the resumer and the daemon-stop resume read quotaAndResume on every use", () => {
  let home: string;
  let db: Db;
  let starts: StartOptions[];
  let sends: string[];
  let now: number;
  let tunables: ResumeTunables;
  const settle = () => new Promise((r) => setTimeout(r, 20));
  const statuses = (id: string) => db.listEvents(id).map((e) => e.ev).filter((e): e is Extract<AgentEvent, { t: "status" }> => e.t === "status").map((e) => e.text);
  // a stop with no reset time anywhere: the wait is the setting's
  const NO_TIME: AgentEvent[] = [{ t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" }, { t: "error", message: 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}' }, { t: "session.end", status: "error", summary: "runner exited (1)" }];
  const HANGING: AgentEvent[] = [{ t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" }, { t: "message.delta", role: "assistant", text: "working…" }];
  const daemon = (turns: AgentEvent[][], maxStopResumes?: () => number) => {
    const tasks = new TaskManager(db, new Map([["claude", fakeAdapter(turns, starts, sends)]]), () => undefined, { idleMs: -1, maxStopResumes });
    const resumer = new RateLimitResumer(db, tasks, { enabled: () => true, now: () => now, tunables: () => tunables });
    resumer.start(3_600_000);
    return { tasks, resumer };
  };
  let d: ReturnType<typeof daemon> | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-tunables-"));
    db = new Db(join(home, "db.sqlite"));
    starts = [];
    sends = [];
    now = STOP_TS;
    tunables = { retryDelayMs: FALLBACK_DELAY_MS, retryMaxDelayMs: MAX_FALLBACK_DELAY_MS, maxLimitStops: MAX_CONSECUTIVE_STOPS, resumePrompt: "使用上限がリセットされました。中断した箇所から作業を続けてください。" };
  });
  afterEach(async () => {
    d?.resumer.stop();
    await d?.tasks.shutdown();
    d = undefined;
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("the defaults are today's constants: the default text after the head is RESUME_PROMPT", async () => {
    d = daemon([NO_TIME, OK_TURN]);
    const t = d.tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    now = db.getTask(t.id)!.resumeAt! + 1;
    expect(await d.resumer.tick()).toEqual([t.id]);
    expect(sends).toEqual([RESUME_PROMPT]);
  });

  test("maxLimitStops 1: a resumed turn that stops again is not resumed", async () => {
    tunables.maxLimitStops = 1;
    d = daemon([LIMIT_TURN]);
    const t = d.tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    expect(db.getTask(t.id)!.resumeAt).not.toBeNull(); // the person's turn: planned
    now = db.getTask(t.id)!.resumeAt! + 1;
    expect(await d.resumer.tick()).toEqual([t.id]);
    await settle();
    expect(db.getTask(t.id)!.resumeAt).toBeNull();
    expect(statuses(t.id).at(-1)).toContain("これ以上は再開しません");
  });

  test("retryDelayMs 60 s / retryMaxDelayMs 120 s: a stop with no known time waits 60 s, then 120 s, then 120 s", async () => {
    tunables = { ...tunables, retryDelayMs: 60_000, retryMaxDelayMs: 120_000 };
    d = daemon([NO_TIME]);
    const t = d.tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    const waits: number[] = [db.getTask(t.id)!.resumeAt! - now];
    for (let i = 0; i < 2; i++) {
      now = db.getTask(t.id)!.resumeAt! + 1;
      expect(await d.resumer.tick()).toEqual([t.id]);
      await settle();
      waits.push(db.getTask(t.id)!.resumeAt! - now);
    }
    expect(waits).toEqual([60_000, 120_000, 120_000]);
    expect(statuses(t.id)[0]).toContain("1 分後に試します");
    expect(planResumeAt({ text: "x", source: "none" }, 0, 3, tunables)).toBe(120_000);
  });

  test("resumePrompt: sent after the head, still the daemon's own text to the stop counter; a change takes effect on the next tick", async () => {
    tunables.resumePrompt = "続けて";
    d = daemon([NO_TIME]);
    const t = d.tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    now = db.getTask(t.id)!.resumeAt! + 1;
    await d.resumer.tick();
    await settle();
    expect(sends).toEqual([`${AUTO_RESUME_HEAD} 続けて`]);
    const note: AgentEvent = { t: "status", text: `${STOP_NOTE}。…` };
    expect(consecutiveStops([note, { t: "message.delta", role: "user", text: sends[0]! }, note])).toBe(2); // not a person's message
    tunables = { ...tunables, resumePrompt: "再開して" };
    now = db.getTask(t.id)!.resumeAt! + 1;
    await d.resumer.tick();
    await settle();
    expect(sends.at(-1)).toBe(`${AUTO_RESUME_HEAD} 再開して`);
  });

  test("resumePrompt: 「今すぐ再開」sends the setting's text after the head too", async () => {
    tunables.resumePrompt = "続けて";
    d = daemon([NO_TIME, OK_TURN]);
    const t = d.tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    await d.resumer.resumeNow(t.id);
    await settle();
    expect(sends).toEqual([`${AUTO_RESUME_HEAD} 続けて`]);
  });

  test("maxStopResumes 1: a second daemon stop in a row is not resumed, by the shutdown or at the next start", async () => {
    let t: Task | undefined;
    for (let i = 1; i <= 2; i++) {
      const s = daemon([HANGING], () => 1);
      t = i === 1 ? s.tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" }) : t!;
      if (i > 1) await s.tasks.send(t.id, STOP_RESUME_PROMPT, { asResume: true });
      await settle();
      s.resumer.stop();
      await s.tasks.shutdown();
      expect(db.getTask(t.id)!.resumeAt !== null).toBe(i === 1);
    }
    expect(statuses(t!.id).at(-1)).toContain("自動再開しません");
    // a daemon that died: the next start's orphan pass uses the same count
    const at = Date.now();
    db.updateTask(t!.id, { status: "running", resumeAt: null });
    expect(abortOrphanedTasks(db, at, 1)).toEqual([t!.id]);
    expect(db.getTask(t!.id)!.resumeAt).toBeNull();
    db.updateTask(t!.id, { status: "running", resumeAt: null });
    expect(abortOrphanedTasks(db, at, 10)).toEqual([t!.id]);
    expect(db.getTask(t!.id)!.resumeAt).toBe(at);
  });
});

describe("GitHub API limit met by a turn's commands (#550)", () => {
  const LINE = "GraphQL: API rate limit already exceeded for user ID 1.";
  const GH_RESET = RESETS_AT + 1200;
  const call = (id: string, name: string, input: unknown, summary: string, ok: boolean): AgentEvent[] => [
    { t: "tool.call", id, name, input, summary: name },
    { t: "tool.result", id, ok, summary },
  ];
  const start: AgentEvent = { t: "session.start", runner: "claude", runnerSessionId: "sess-1", cwd: "/tmp" };
  const end = (text = "Waiting for the GraphQL budget to return."): AgentEvent[] => [{ t: "message.delta", role: "assistant", text }, { t: "session.end", status: "ok", summary: text }];
  const GH_TURN: AgentEvent[] = [start, ...call("c1", "Bash", { command: "gh pr view 1" }, `Exit code 1\n${LINE}`, false), ...end()];

  let home: string;
  let db: Db;
  let tasks: TaskManager;
  let starts: StartOptions[];
  let sends: string[];
  let now: number;
  let enabled: boolean;
  let budget: { remaining: number; limit: number; resetsAt: number } | null;
  let resumer: RateLimitResumer;
  const ctl: { failSend?: boolean } = {};
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const statuses = (id: string) => db.listEvents(id).map((e) => e.ev).filter((e): e is Extract<AgentEvent, { t: "status" }> => e.t === "status").map((e) => e.text);
  const boot = (turns: AgentEvent[][]) => {
    tasks = new TaskManager(db, new Map([["claude", fakeAdapter(turns, starts, sends, ctl)]]), () => undefined, { idleMs: -1 });
    resumer = new RateLimitResumer(db, tasks, { enabled: () => enabled, now: () => now, githubBudget: async () => budget });
    resumer.start(3_600_000);
  };
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sb-ghlimit-"));
    db = new Db(join(home, "db.sqlite"));
    starts = [];
    sends = [];
    now = STOP_TS;
    enabled = true;
    budget = { remaining: 0, limit: 5000, resetsAt: GH_RESET };
    ctl.failSend = false;
  });
  afterEach(async () => {
    resumer.stop();
    await tasks.shutdown();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  test("githubLimitHit: the line at the head of a result counts, a read tool's or an indented quote does not", () => {
    boot([OK_TURN]); // nothing runs; the hooks expect a resumer
    expect(githubLimitHit("Bash", `Exit code 1\n${LINE}`)).toBe(LINE);
    expect(githubLimitHit("Bash", "gh: API rate limit exceeded for user ID 1.\nexit=1")).toBe("gh: API rate limit exceeded for user ID 1.");
    expect(githubLimitHit("Bash", "ok\n  GraphQL: API rate limit exceeded for user ID 1.")).toBeUndefined();
    expect(githubLimitHit("Grep", "packages/x.ts:3: // API rate limit exceeded for user")).toBeUndefined();
    expect(githubLimitHit("Read", `1\t${LINE}`)).toBeUndefined();
  });

  test("a turn that ended ok after a command met the limit: resumeAt is GitHub's reset + a minute with reason github and a note; due and on, the tick sends the GitHub follow-up; off, it only waits", async () => {
    boot([GH_TURN, OK_TURN]);
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    let cur = db.getTask(t.id)!;
    expect(cur.status).toBe("done");
    expect(cur.resumeAt).toBe(GH_RESET * 1000 + RESUME_MARGIN_MS);
    expect(cur.resumeReason).toBe("github");
    expect(statuses(t.id).at(-1)).toContain(GITHUB_NOTE);
    expect(statuses(t.id).at(-1)).toContain(`${fmtTime(cur.resumeAt!, now)} に自動再開します`);
    expect(statuses(t.id).at(-1)).toContain("rateLimit");
    expect(await resumer.tick()).toEqual([]);
    now = cur.resumeAt! + 1;
    enabled = false;
    expect(await resumer.tick()).toEqual([]);
    expect(db.getTask(t.id)!.resumeAt).toBe(cur.resumeAt);
    enabled = true;
    expect(await resumer.tick()).toEqual([t.id]);
    await settle();
    expect(sends).toEqual([GITHUB_RESUME_PROMPT]);
    cur = db.getTask(t.id)!;
    expect(cur.resumeAt).toBeNull();
    expect(cur.resumeReason).toBeNull();
  });

  test("the same command succeeding later in the turn takes the limit out; a quote in a read or off the line head is no hit; the line at the head of an ok result is", async () => {
    const same = [start, ...call("c1", "Bash", { command: "gh pr view 1" }, `Exit code 1\n${LINE}`, false), ...call("c2", "Bash", { command: "gh pr view 1" }, "ok", true), ...end("done")];
    const quotes = [start, ...call("c1", "Grep", { pattern: "rate limit" }, "packages/x.ts:3: // API rate limit exceeded for user", true), ...call("c2", "Bash", { command: "cat log" }, `log:\n  ${LINE}`, true), ...end("done")];
    const loop = [start, ...call("c1", "Bash", { command: "until gh pr view 1; do sleep 60; done; date" }, `${LINE}\n${LINE}\nok`, true), ...end()];
    for (const [turn, planned] of [[same, false], [quotes, false], [loop, true]] as const) {
      boot([turn, OK_TURN]);
      const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
      await settle();
      const cur = db.getTask(t.id)!;
      expect([turn === loop ? "loop" : turn === same ? "same" : "quotes", cur.resumeAt !== null, cur.resumeReason]).toEqual([turn === loop ? "loop" : turn === same ? "same" : "quotes", planned, planned ? "github" : null]);
      resumer.stop();
      await tasks.shutdown();
    }
  });

  test("a turn that ended on another error after meeting the limit is planned too; a cancel while the budget is read leaves no plan; a failed GitHub follow-up keeps its reason", async () => {
    // an unrelated error at the end: not the runner's limit, still GitHub's
    const errTurn: AgentEvent[] = [start, ...call("c1", "Bash", { command: "gh pr view 1" }, `Exit code 1\n${LINE}`, false), { t: "session.end", status: "error", summary: "runner exited (1)" }];
    boot([errTurn, OK_TURN]);
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    expect(db.getTask(t.id)).toMatchObject({ status: "error", resumeAt: GH_RESET * 1000 + RESUME_MARGIN_MS, resumeReason: "github" });
    resumer.cancel(t.id); // not in the ticks below
    resumer.stop();
    await tasks.shutdown();

    // the budget read is slow; the person cancels the plan (or replies) meanwhile: the late answer plans nothing
    let release!: (b: typeof budget) => void;
    const slow = new Promise<typeof budget>((r) => (release = r));
    tasks = new TaskManager(db, new Map([["claude", fakeAdapter([GH_TURN, OK_TURN], starts, sends, ctl)]]), () => undefined, { idleMs: -1 });
    resumer = new RateLimitResumer(db, tasks, { enabled: () => enabled, now: () => now, githubBudget: () => slow });
    resumer.start(3_600_000);
    const t2 = tasks.create({ cwd: home, title: "t2", prompt: "go", runner: "claude" });
    await settle();
    expect(db.getTask(t2.id)!.resumeAt).toBeNull();
    await tasks.send(t2.id, "続けて"); // a reply: the turn the plan was for is over
    await settle();
    release(budget);
    await settle();
    expect(db.getTask(t2.id)!.resumeAt).toBeNull();
    expect(statuses(t2.id).some((x) => x.startsWith(GITHUB_NOTE))).toBe(false);
    resumer.stop();
    await tasks.shutdown();

    // the person cancels while the read is pending and nothing is planned yet: the late answer plans nothing either
    let release2!: (b: typeof budget) => void;
    const slow2 = new Promise<typeof budget>((r) => (release2 = r));
    tasks = new TaskManager(db, new Map([["claude", fakeAdapter([GH_TURN, OK_TURN], starts, sends, ctl)]]), () => undefined, { idleMs: -1 });
    resumer = new RateLimitResumer(db, tasks, { enabled: () => enabled, now: () => now, githubBudget: () => slow2 });
    resumer.start(3_600_000);
    const t4 = tasks.create({ cwd: home, title: "t4", prompt: "go", runner: "claude" });
    await settle();
    resumer.cancel(t4.id);
    release2(budget);
    await settle();
    expect(db.getTask(t4.id)!.resumeAt).toBeNull();
    expect(statuses(t4.id).at(-1)).toContain("取り消しました");
    expect(await resumer.tick()).toEqual([]);
    resumer.stop();
    await tasks.shutdown();

    // 中断 of the finished task while the read is pending: the same; and two limited turns in a row with reads still
    // open each keep their own marker — the older answer plans nothing, the newer turn gets its plan
    const reads: Array<(b: typeof budget) => void> = [];
    tasks = new TaskManager(db, new Map([["claude", fakeAdapter([GH_TURN, GH_TURN, GH_TURN, OK_TURN], starts, sends, ctl)]]), () => undefined, { idleMs: -1 });
    resumer = new RateLimitResumer(db, tasks, { enabled: () => enabled, now: () => now, githubBudget: () => new Promise((r) => reads.push(r)) });
    resumer.start(3_600_000);
    const t5 = tasks.create({ cwd: home, title: "t5", prompt: "go", runner: "claude" });
    await settle();
    await tasks.abort(t5.id);
    reads.shift()!(budget);
    await settle();
    expect(db.getTask(t5.id)!.resumeAt).toBeNull();
    const t6 = tasks.create({ cwd: home, title: "t6", prompt: "go", runner: "claude" });
    await settle();
    await tasks.send(t6.id, "もう一度"); // the second turn meets the limit too; both reads are open
    await settle();
    expect(reads).toHaveLength(2);
    reads.shift()!(budget); // the first turn's answer: superseded, and it must not take the second turn's marker
    await settle();
    expect(db.getTask(t6.id)!.resumeAt).toBeNull();
    reads.shift()!(budget);
    await settle();
    expect(db.getTask(t6.id)).toMatchObject({ resumeAt: GH_RESET * 1000 + RESUME_MARGIN_MS, resumeReason: "github" });
    resumer.cancel(t6.id);
    resumer.stop();
    await tasks.shutdown();

    // the follow-up could not be sent: the retry keeps the GitHub reason, and sends the GitHub prompt when it can
    boot([GH_TURN, OK_TURN]);
    const t3 = tasks.create({ cwd: home, title: "t3", prompt: "go", runner: "claude" });
    await settle();
    now = db.getTask(t3.id)!.resumeAt! + 1;
    ctl.failSend = true;
    expect(await resumer.tick()).toEqual([]);
    expect(db.getTask(t3.id)).toMatchObject({ resumeAt: now + LATE_RETRY_MS, resumeReason: "github" });
    now += LATE_RETRY_MS + 1;
    expect(await resumer.tick()).toEqual([t3.id]);
    await settle();
    expect(sends.at(-1)).toBe(GITHUB_RESUME_PROMPT);
  });

  test("the budget not readable: a fallback delay; back already: a short retry; 「今すぐ再開」sends the GitHub follow-up and the daemon-stop prompt is not it", async () => {
    budget = null;
    boot([GH_TURN, OK_TURN, OK_TURN]);
    const t = tasks.create({ cwd: home, title: "t", prompt: "go", runner: "claude" });
    await settle();
    expect(db.getTask(t.id)!.resumeAt).toBe(now + FALLBACK_DELAY_MS);
    expect(statuses(t.id).at(-1)).toContain("残量を読めない");
    await resumer.resumeNow(t.id);
    await settle();
    expect(sends.at(-1)).toBe(GITHUB_RESUME_PROMPT);
    expect(db.getTask(t.id)!.resumeAt).toBeNull();
    expect(lastStopWasDaemon(db.listEvents(t.id).map((e) => e.ev))).toBe(false);
    // the note alone decides: a daemon stop and its follow-up before it do not make the next resume the stop's
    expect(lastStopWasDaemon([{ t: "status", text: `${STOP_NOTE}（1 回目）` }, { t: "message.delta", role: "user", text: STOP_RESUME_PROMPT }, { t: "status", text: `${GITHUB_NOTE}: x。01:00 に自動再開します` }])).toBe(false);
    // back already (the host's wait is over): a short retry, not a wait until a reset that passed
    budget = { remaining: 4000, limit: 5000, resetsAt: GH_RESET };
    resumer.stop();
    await tasks.shutdown();
    boot([GH_TURN, OK_TURN]);
    const t2 = tasks.create({ cwd: home, title: "t2", prompt: "go", runner: "claude" });
    await settle();
    expect(db.getTask(t2.id)!.resumeAt).toBe(now + LATE_RETRY_MS);
  });
});

describe("fallbackRunner (#834)", () => {
  const now = Date.parse("2026-10-24T03:00:00Z");
  const later = Math.floor(now / 1000) + 3600; // seconds, like the quota rows
  const rows = (q: Partial<Record<RunnerId, Array<[string, number, number]>>>) => (r: RunnerId) => (q[r] ?? []).map(([window, utilization, resetsAt]) => ({ window, utilization, resetsAt }));
  const all = () => true;
  const cfg = (fallback: RunnerId[], fallbackAt = 0.9) => ({ fallback, fallbackAt });
  test.each<[string, RunnerId, RunnerId[], Partial<Record<RunnerId, Array<[string, number, number]>>>, (r: RunnerId) => boolean, RunnerId, boolean]>([
    ["not at its limit: as it is", "claude", ["codex"], { claude: [["five_hour", 0.89, later]] }, all, "claude", false],
    ["at its limit: the order's next", "claude", ["claude", "codex", "dak"], { claude: [["five_hour", 0.95, later]] }, all, "codex", true],
    ["after the last, back to the head", "dak", ["claude", "codex", "dak"], { dak: [["five_hour", 0.95, later]] }, all, "claude", true],
    ["not in the order: from the head", "claude", ["codex", "dak"], { claude: [["seven_day", 1, later]] }, all, "codex", true],
    ["the next at its limit too: skipped", "claude", ["claude", "codex", "dak"], { claude: [["five_hour", 0.95, later]], codex: [["seven_day", 0.9, later]] }, all, "dak", true],
    ["an undetected one: skipped", "claude", ["codex", "dak"], { claude: [["five_hour", 0.95, later]] }, (r) => r !== "codex", "dak", true],
    ["every one at its limit: the decided one", "claude", ["codex"], { claude: [["five_hour", 0.95, later]], codex: [["five_hour", 0.99, later]] }, all, "claude", false],
    ["an empty order: the decided one", "claude", [], { claude: [["five_hour", 1, later]] }, all, "claude", false],
    ["a window that has reset is not the limit", "claude", ["codex"], { claude: [["five_hour", 1, Math.floor(now / 1000) - 1]] }, all, "claude", false],
  ])("%s", (_, runner, fallback, q, installed, want, moved) => {
    const r = fallbackRunner(runner, cfg(fallback), rows(q), installed, now);
    expect(r.runner).toBe(want);
    expect(!!r.from).toBe(moved);
  });

  test("from names the window; the note is the transcript's line", () => {
    const r = fallbackRunner("claude", cfg(["codex"], 0.8), rows({ claude: [["five_hour", 0.5, later], ["seven_day", 0.85, later]] }), () => true, now);
    expect(r).toEqual({ runner: "codex", from: { runner: "claude", window: "seven_day", utilization: 0.85, resetsAt: later * 1000 } });
    expect(fallbackNote(r.runner, r.from!, now)).toBe(`claude が上限（0.85、${fmtTime(later * 1000, now)} に戻る）のため codex で開始`);
  });
});
