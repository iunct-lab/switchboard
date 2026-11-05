import { expect, test } from "bun:test";
import type { HeavyHistoryEntry } from "../../../ops-kit/src/heavy.ts";
import { estimateDone, runKind, typicalByKind, verdict } from "./ops-resources.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-11-03T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
// a finished run of `name` that took `min` minutes
const done = (name: string, min: number, exitCode: number | null = 0): HeavyHistoryEntry => ({ name, taskId: null, queuedAt: iso(T0), startedAt: iso(T0), endedAt: iso(T0 + min * MIN), exitCode });

test("same kind ignores numbers", () => {
  expect(runKind("local-ci 3314")).toBe(runKind("local-ci 3320"));
  expect(runKind("local-ci owner/repo#3314")).toBe("local-ci owner/repo##");
  expect(runKind("review codex")).not.toBe(runKind("review claude"));
  const t = typicalByKind([done("local-ci 3314", 10), done("local-ci 3320", 20), done("local-ci 3321", 30)]);
  expect(t.get(runKind("local-ci 9999"))).toEqual({ typicalMs: 20 * MIN, samples: 3 });
});

test("verdict: none under 3 runs, normal up to twice the median, long past it; failed runs are not counted", () => {
  // two successes and a failure that would make three: still none
  const two = typicalByKind([done("ci 1", 10), done("ci 2", 10), done("ci 3", 1, 1), done("ci 4", 1, null)]).get(runKind("ci 1"));
  expect(two).toEqual({ typicalMs: null, samples: 2 });
  expect(verdict(100 * MIN, two)).toBe("none");
  expect(verdict(100 * MIN, undefined)).toBe("none");
  // the median of 10, 12, 30 is 12 (the failed 1-minute runs would pull it to 10 or below)
  const three = typicalByKind([done("ci 1", 10), done("ci 2", 12), done("ci 3", 30), done("ci 4", 1, 1), done("ci 5", 1, 1)]).get(runKind("ci 1"));
  expect(three).toEqual({ typicalMs: 12 * MIN, samples: 3 });
  expect(verdict(24 * MIN, three)).toBe("normal"); // twice is still normal
  expect(verdict(24 * MIN + 1, three)).toBe("long");
  // an even count takes the mean of the two middle ones
  expect(typicalByKind([done("x", 10), done("x", 20), done("x", 30), done("x", 40)]).get("x")).toEqual({ typicalMs: 25 * MIN, samples: 4 });
});

test("eta: the last end when the waiting runs take the earliest free slot in their order; runs with no record are counted and left out", () => {
  const typical = typicalByKind([..."abc"].flatMap(() => [done("ci 1", 10), done("review codex", 20)]));
  const now = T0 + 4 * MIN;
  const running = [{ name: "ci 7", startedAt: iso(T0) }]; // 4 of its 10 minutes gone: 6 left
  const waiting = [
    { name: "review codex", queuedAt: iso(T0 + 1 * MIN) },
    { name: "ci 8", queuedAt: iso(T0 + 2 * MIN) },
  ];
  // one slot: 6 + 20 + 10
  expect(estimateDone(running, waiting, 1, typical, now)).toEqual({ etaMs: 36 * MIN, unknown: 0 });
  // two slots: the review starts at once (20), the ci after the running one (6 + 10)
  expect(estimateDone(running, waiting, 2, typical, now)).toEqual({ etaMs: 20 * MIN, unknown: 0 });
  // the waiting order is queuedAt's, not the list's
  expect(estimateDone([], [waiting[1]!, waiting[0]!], 2, typical, now)).toEqual({ etaMs: 20 * MIN, unknown: 0 });
  // a running one past its median has 0 left; one with no record, running or waiting, is counted and left out
  const late = [{ name: "ci 7", startedAt: iso(T0 - 60 * MIN) }, { name: "e2e chrome", startedAt: iso(T0) }];
  expect(estimateDone(late, [...waiting, { name: "new thing", queuedAt: iso(T0) }], 2, typical, now)).toEqual({ etaMs: 20 * MIN, unknown: 2 });
  // nothing running or waiting: no eta
  expect(estimateDone([], [], 1, typical, now)).toEqual({ etaMs: null, unknown: 0 });
});
