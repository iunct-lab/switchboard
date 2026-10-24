import { expect, test } from "bun:test";
import { FORGES, LOCAL, MOMENTS, REMOTE, replay, runBacklogRaceBench } from "./backlog-race-bench.ts";

// The window of 初期方式 A, replayed (#927, #928), and what the read after the write closes of it since #1329: on GitHub as it is the
// history gives the other editor's value back and the edit is held; only a field with no history and a revision evicted from it stay open.

test("--fixture: every moment on every forge, nothing from the run in the output but the values", async () => {
  const r = await runBacklogRaceBench();
  expect(r.mode).toBe("fixture");
  expect(r.scenarios.map((s) => [s.moment, s.forge])).toEqual(FORGES.flatMap((f) => MOMENTS.map((m) => [m, f])));
  // what A sees and what B needs are in the output, read off the runs (Task #927 step 3)
  expect(r.a).toEqual({ detects: ["notice-lost", "before-check", "between-check-and-write", "history-deleted", "history-unreadable", "after-write", "answer-lost"], loses: ["history-evicted"], recovers: ["between-check-and-write"] });
  expect(r.b.needs).toEqual([expect.stringContaining("no edit history"), expect.stringContaining("evicted from the history")]);
  // the read after the write stays one call: each scenario asks at most what it asked before the history came along
  // (PR #1323: one read when the check holds, else check + write + read after) plus one
  // per forge: the conditional forge refused the write in four moments (check + refused write, no read after)
  const before: Record<string, Record<string, number>> = {
    github: { "notice-lost": 1, "before-check": 1, "between-check-and-write": 3, "history-deleted": 3, "history-evicted": 3, "history-unreadable": 3, "after-write": 3, "answer-lost": 3 },
    "github-project-field": { "notice-lost": 1, "before-check": 1, "between-check-and-write": 3, "history-deleted": 3, "history-evicted": 3, "history-unreadable": 3, "after-write": 3, "answer-lost": 3 },
    conditional: { "notice-lost": 1, "before-check": 1, "between-check-and-write": 2, "history-deleted": 2, "history-evicted": 2, "history-unreadable": 2, "after-write": 3, "answer-lost": 3 },
  };
  for (const sc of r.scenarios) expect([sc.moment, sc.forge, sc.calls, sc.calls <= before[sc.forge]![sc.moment]! + 1]).toEqual([sc.moment, sc.forge, sc.calls, true]);
  const out = JSON.stringify(r);
  for (const leaked of ["query", "/work/app", "acme/app", "I_12"]) expect(out).not.toContain(leaked);
});

test("the other edit before the check — theirs lost in the notice, or made before the send — is held with their value, nothing written", async () => {
  for (const moment of ["notice-lost", "before-check"] as const) for (const forge of FORGES) {
    expect(await replay(moment, forge)).toMatchObject({ value: REMOTE, local: "held", told: true, lost: [], writes: 0 });
  }
});

test("between the check and the write: on GitHub as it is the read after the write finds theirs in the history and holds the edit with their value; a Project field without a history loses it; a conditional write is refused and held (#1329)", async () => {
  expect(await replay("between-check-and-write", "github")).toMatchObject({ value: LOCAL, local: "held", told: true, lost: [], recoverable: [REMOTE], traced: false, historyRead: true, writes: 1 });
  expect(await replay("between-check-and-write", "github-project-field")).toMatchObject({ value: LOCAL, local: "done", told: false, lost: [REMOTE], recoverable: [], historyRead: false, writes: 1 });
  // with the condition: the write here is refused, checked again and held; v2 stays, v3 is kept with the operation
  expect(await replay("between-check-and-write", "conditional")).toMatchObject({ value: REMOTE, local: "held", told: true, lost: [], writes: 0 });
});

test("the same window with their revision deleted from the history: held with a trace of the edit; evicted: lost, the window stays; unreadable: held as unverified (#1329)", async () => {
  expect(await replay("history-deleted", "github")).toMatchObject({ value: LOCAL, local: "held", lost: [], recoverable: [], traced: true, historyRead: true });
  expect(await replay("history-evicted", "github")).toMatchObject({ value: LOCAL, local: "done", lost: [REMOTE], recoverable: [], traced: false, historyRead: true });
  expect(await replay("history-unreadable", "github")).toMatchObject({ value: LOCAL, local: "held", lost: [], recoverable: [], traced: false, historyRead: false });
  // a field with no history (the forge answers the body's history query with an empty one, standing in for a Project field the send reads the value of only): the revision's fate changes nothing — the value is lost either way
  for (const moment of ["history-deleted", "history-evicted", "history-unreadable"] as const) expect(await replay(moment, "github-project-field")).toMatchObject({ value: LOCAL, local: "done", lost: [REMOTE], recoverable: [], traced: false, historyRead: false });
  for (const moment of ["history-deleted", "history-evicted", "history-unreadable"] as const) expect(await replay(moment, "conditional")).toMatchObject({ value: REMOTE, local: "held", lost: [], traced: false });
});

test("right after the write: theirs lands on the value they read before it — seen by the read after and held; a conditional write refuses theirs", async () => {
  for (const forge of ["github", "github-project-field"] as const) expect(await replay("after-write", forge)).toMatchObject({ value: REMOTE, local: "held", remoteLanded: true, lost: [] });
  expect(await replay("after-write", "conditional")).toMatchObject({ value: LOCAL, local: "done", remoteLanded: false, lost: [] });
});

test("a write whose answer was lost: the send asks again after the wait, sees theirs on the value it wrote, and holds — nothing is written twice", async () => {
  for (const forge of FORGES) expect(await replay("answer-lost", forge)).toMatchObject({ value: REMOTE, local: "held", lost: [], writes: 1 });
});
