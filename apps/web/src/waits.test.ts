import { expect, test } from "bun:test";
import type { WaitRecord } from "@switchboard/protocol";
import { shownWait, stalledFor, waitLabel, waitTag } from "./waits.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-11-10T09:00:00+09:00");
const w = (over: Partial<WaitRecord> = {}): WaitRecord => ({ kind: "command", key: "command:1", label: "PR 12 のマージ", since: T0, until: T0 + 30 * MIN, ...over });

test("waitLabel: what is waited for, how long so far and the limit; the list's form leaves the label out", () => {
  expect(waitLabel(w(), T0 + 3 * MIN + 59_000, false)).toBe("待ち: PR 12 のマージ 3 分 / 上限 30 分");
  expect(waitLabel(w(), T0 + 3 * MIN, true)).toBe("待ち 3/30 分");
  // counted in the unit of the limit: hours under two days, days from there
  expect(waitLabel(w({ kind: "job", label: "頼んだ仕事 job#5", until: T0 + 6 * HOUR }), T0 + 90 * MIN, false)).toBe("待ち: 頼んだ仕事 job#5 1 時間 / 上限 6 時間");
  expect(waitLabel(w({ kind: "depends", label: "PR #12", until: T0 + 3 * DAY }), T0 + 30 * HOUR, true)).toBe("待ち 1/3 日");
});

test("waitLabel: a wait past its limit says so", () => {
  expect(waitLabel(w(), T0 + 30 * MIN, false)).toBe("待ち超過: PR 12 のマージ 30 分 / 上限 30 分");
  expect(waitLabel(w(), T0 + 41 * MIN, true)).toBe("待ち超過 41/30 分");
});

test("waitLabel: the other side standing still for more than half of what it may is said with the wait", () => {
  const watched = w({ progressAt: T0 + 2 * MIN, stallSec: 600 });
  expect(stalledFor(watched, T0 + 7 * MIN)).toBeNull();
  expect(waitLabel(watched, T0 + 7 * MIN, false)).toBe("待ち: PR 12 のマージ 7 分 / 上限 30 分");
  expect(waitLabel(watched, T0 + 8 * MIN, false)).toBe("待ち: PR 12 のマージ 8 分 / 上限 30 分（無進捗 6 分）");
  expect(waitLabel(watched, T0 + 8 * MIN, true)).toBe("待ち 8/30 分（無進捗 6 分）");
  expect(stalledFor(w({ progressAt: null, stallSec: null }), T0 + DAY)).toBeNull();
});

test("the runner's silence: 応答なし and the minutes since its last event; the tooltip says when that was", () => {
  const silent = w({ kind: "output", key: "output", label: "ランナーの出力", until: T0 + 10 * MIN });
  expect(waitLabel(silent, T0 + 15 * MIN, false)).toBe("応答なし 15 分");
  expect(waitLabel(silent, T0 + 15 * MIN, true)).toBe("応答なし 15 分");
  const tag = waitTag({ waits: [silent] }, T0 + 15 * MIN, true)!;
  expect(tag).toMatchObject({ text: "応答なし 15 分", tone: "silent" });
  expect(tag.title).toStartWith("応答なし: 最後のイベントは 09:00");
});

test("waitTag: nothing without a wait; several show the silence, else one over its limit, else the one whose limit comes first — all in the tooltip", () => {
  expect(waitTag({ waits: null }, T0, false)).toBeNull();
  expect(waitTag({ waits: [] }, T0, false)).toBeNull();
  expect(waitTag({}, T0, false)).toBeNull();
  const pr = w({ kind: "depends", key: "pr#12", label: "PR #12", until: T0 + 3 * DAY });
  const job = w({ kind: "job", key: "job#5", label: "頼んだ仕事 job#5", until: T0 + 6 * HOUR });
  const first = waitTag({ waits: [pr, job] }, T0 + HOUR, false)!;
  expect(first).toEqual({ text: "待ち: 頼んだ仕事 job#5 1 時間 / 上限 6 時間", title: "待ち: PR #12 0 日 / 上限 3 日\n待ち: 頼んだ仕事 job#5 1 時間 / 上限 6 時間", tone: "wait" });
  expect(waitTag({ waits: [pr, job] }, T0 + 7 * HOUR, true)).toMatchObject({ text: "待ち超過 7/6 時間", tone: "over" });
  const silent = w({ kind: "output", key: "output", label: "ランナーの出力", until: T0 + 10 * MIN });
  expect(shownWait({ waits: [pr, job, silent] }, T0 + 7 * HOUR)).toBe(silent);
});

test("waitTag: the person's own waits and a planned resume within its time have their own places; a resume past its time is a wait over its limit", () => {
  const person = w({ kind: "person", key: "approval", label: "ツールの承認", until: T0 + 3 * DAY });
  const resume = w({ kind: "resume", key: "resume", label: "使用上限の解除", until: T0 + HOUR });
  expect(waitTag({ waits: [person] }, T0 + 10 * DAY, false)).toBeNull();
  expect(waitTag({ waits: [person, resume] }, T0 + 30 * MIN, false)).toBeNull();
  expect(waitTag({ waits: [person, resume] }, T0 + 2 * HOUR, false)).toMatchObject({ text: "待ち超過: 使用上限の解除 120 分 / 上限 60 分", tone: "over" });
});
