import { expect, test } from "bun:test";
import type { Ask } from "@switchboard/protocol";
import { STALL_RECHECK_GRACE_MS, readStall, stallAskOf, stallRecheckIn, stallRows } from "./queueStall.ts";

const ask = (over: Partial<Ask>): Ask => ({
  id: "a", kind: "decision", needs: "person", state: "open", at: 1, changedAt: 1, workspace: null, pbi: null, issue: null, task: null, reason: null, question: null, choices: [], questions: [], grants: [], grant: null, recommendation: null, next: null,
  source: { label: "記録", url: null, taskId: null }, route: "none", conditions: [], answers: [], place: null, mockups: [], blockers: [], resume: null, subject: null, policy: { scopes: [], note: null, defaults: null, applied: null, previous: null }, unblocks: [], waiting: [], priority: null, lastReply: null, stall: null, ...over,
});

const ws = { id: "w1", name: "switchboard" };
const pbi = (n: number) => ({ number: n, title: `PBI ${n}`, url: `https://github.com/o/r/issues/${n}` });
const stalled = ask({
  id: "notice:queue-stall@1000",
  kind: "notice",
  question: "キューが 1 時間 20 分止まっています",
  reason: "始められる PBI が無い（実装の Task 0 件）",
  stall: {
    since: 1000,
    person: [
      { askId: "stop:t1", workspace: ws, pbi: pbi(5796), label: "止まり: PR #5838 のマージの許可", taskId: "task_1", url: "https://github.com/o/r/issues/5797", held: 13, headMoved: true },
      { askId: "decision:5664", workspace: ws, pbi: pbi(5664), label: "判断待ち: 進め方の問い", taskId: null, url: "https://github.com/o/r/issues/5664", held: 8, headMoved: false },
    ],
    holders: [
      { workspace: ws, ref: "#4045 の順番", url: "https://github.com/o/r/issues/4045", pbi: pbi(4045), held: 16, working: null },
      { workspace: ws, ref: "PR #5845", url: "https://github.com/o/r/pull/5845", pbi: null, held: 9, working: false },
      { workspace: ws, ref: "Task #5841", url: null, pbi: null, held: 4, working: true },
    ],
  },
});

test("stallAskOf picks the stalled queue's notice and nothing else", () => {
  expect(stallAskOf([ask({ id: "decision:1" }), stalled, ask({ id: "notice:tag-ci@1", kind: "notice" })])?.id).toBe("notice:queue-stall@1000");
  expect(stallAskOf([ask({ id: "decision:1" }), ask({ id: "notice:tag-ci@1", kind: "notice" })])).toBeNull();
});

test("stall rows say the holders and the person's waits", () => {
  const rows = stallRows(stalled);
  expect(rows.person).toEqual([
    { text: "#5796 止まり: PR #5838 のマージの許可 — 13 件待ち", badge: "回答の後に head が動いた", href: "https://github.com/o/r/issues/5797", taskId: "task_1" },
    { text: "#5664 判断待ち: 進め方の問い — 8 件待ち", badge: null, href: "https://github.com/o/r/issues/5664", taskId: null },
  ]);
  expect(rows.holders).toEqual([
    { text: "#4045 の順番 — 16 件", href: "https://github.com/o/r/issues/4045" },
    { text: "PR #5845 — 9 件（作業していない）", href: "https://github.com/o/r/pull/5845" },
    { text: "Task #5841 — 4 件（作業中）", href: null },
  ]);
  expect(stallRows(ask({ id: "notice:x", kind: "notice" }))).toEqual({ person: [], holders: [] });
});

test("Home reads the queue again when the stall reaches the limit", () => {
  const MIN = 60_000;
  const q = { enabled: true, stall: { since: 0 } };
  expect(stallRecheckIn(q, 60 * MIN, 10 * MIN)).toBe(50 * MIN + 1000);
  expect(stallRecheckIn(q, 60 * MIN, 70 * MIN)).toBeNull();
  // past the limit, within the grace: once more at its end (a read that crossed the limit, a browser clock ahead)
  expect(stallRecheckIn(q, 60 * MIN, 60 * MIN + 100)).toBe(STALL_RECHECK_GRACE_MS - 100);
  expect(stallRecheckIn(q, 60 * MIN, 60 * MIN + STALL_RECHECK_GRACE_MS)).toBeNull();
  expect(stallRecheckIn({ enabled: false, stall: { since: 0 } }, 60 * MIN, 10 * MIN)).toBeNull();
  expect(stallRecheckIn({ enabled: true, stall: null }, 60 * MIN, 10 * MIN)).toBeNull();
});

test("Home's read clears the card and sets a clock only while the notice is not there", async () => {
  const MIN = 60_000;
  const api = (o: { asks?: Ask[]; settings?: "fail" }) => ({
    backlogQueue: async () => ({ enabled: true, stall: { since: 0 } }),
    asks: async () => ({ asks: o.asks ?? [] }),
    settings: async () => {
      if (o.settings === "fail") throw new Error("network");
      return { quotaAndResume: { queueStallMs: 60 * MIN } };
    },
  });
  expect(await readStall(api({ asks: [stalled] }), 10 * MIN)).toEqual({ ask: stalled, wait: null });
  expect(await readStall(api({}), 10 * MIN)).toEqual({ ask: null, wait: 50 * MIN + 1000 });
  // the limit cannot be read: no clock, and the card that was shown is still cleared
  expect(await readStall(api({ settings: "fail" }), 10 * MIN)).toEqual({ ask: null, wait: null });
});
