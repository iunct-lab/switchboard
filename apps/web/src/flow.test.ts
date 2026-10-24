import { describe, expect, test } from "bun:test";
import { FlowStage, type FlowPbi, type FlowSummary, type FlowView } from "@switchboard/protocol";
import { bottleneckLine, flowRows, slowRow, span } from "./flow.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const summary = (p50: Partial<Record<FlowStage, number | null>>, bottleneck: FlowStage | null = null): FlowSummary => ({
  stages: Object.fromEntries(FlowStage.options.map((st) => [st, { p50: p50[st] ?? null, p90: p50[st] === undefined || p50[st] === null ? null : p50[st]! * 2, count: p50[st] == null ? 0 : 3 }])) as FlowSummary["stages"],
  bottleneck,
  closed: 3,
  storyPoints: 9,
});
const view = (current: FlowSummary, previous: FlowSummary): FlowView => ({ days: 30, fetchedAt: 0, current, previous, slowest: [], errors: [], unread: [] });

describe("flow screen", () => {
  test("rows and colors", () => {
    const rows = flowRows(
      view(
        summary({ request: 10 * MIN, split: 60 * MIN, wait: 20 * HOUR, build: 5 * MIN, "review-wait": 4 * MIN, review: 30 * MIN, close: 8 * MIN }, "wait"),
        summary({ request: 10 * MIN, split: 40 * MIN, wait: 10 * HOUR, build: 5 * MIN, "review-wait": 5 * MIN, review: 40 * MIN, close: 8 * MIN }),
      ),
    );
    expect(rows.map((r) => r.stage)).toEqual([...FlowStage.options]); // seven rows, in the order of the way
    const by = Object.fromEntries(rows.map((r) => [r.stage, r]));
    expect(by.split).toMatchObject({ now: "1 時間", before: "40 分", change: "+50%", tone: "slower" });
    expect(by.wait).toMatchObject({ now: "20 時間", change: "+100%", tone: "slower" });
    expect(by.review).toMatchObject({ change: "-25%", tone: "faster" });
    expect(by["review-wait"]).toMatchObject({ change: "-20%", tone: "faster" }); // exactly 20% counts
    expect(by.request).toMatchObject({ change: "+0%", tone: "same" });
    expect(by.build.tone).toBe("same");
    expect(bottleneckLine(view(summary({ wait: 20 * HOUR }, "wait"), summary({})))).toBe("着手待ち（中央値 20 時間）");
  });

  test("unknown stage shows dash", () => {
    const rows = flowRows(view(summary({ build: 5 * MIN }), summary({ split: 5 * MIN })));
    const by = Object.fromEntries(rows.map((r) => [r.stage, r]));
    expect(by.split).toMatchObject({ now: "—", p90: "—", before: "5 分", change: "—", tone: "same" }); // nothing now: no change is told
    expect(by.build).toMatchObject({ now: "5 分", before: "—", change: "—", tone: "same" }); // nothing before: nothing to compare
    expect(span(null)).toBe("—");
    expect(span(30_000)).toBe("1 分未満");
    expect(span(49 * HOUR)).toBe("2 日");
    expect(bottleneckLine(view(summary({}), summary({})))).toBeNull();
  });

  test("a slow PBI shows its total and its longest stage", () => {
    const pbi = { repo: "o/r", number: 7, title: "PBI: x", url: "https://github.com/o/r/issues/7", stages: { request: null, split: HOUR, wait: 3 * HOUR, build: 30 * MIN } } as unknown as FlowPbi;
    expect(slowRow(pbi)).toEqual({ number: 7, title: "PBI: x", url: "https://github.com/o/r/issues/7", total: "4.5 時間", longest: "着手待ち 3 時間" });
    // no stage known at all: no time is told (an empty sum is not "1 分未満")
    expect(slowRow({ ...pbi, stages: { request: null, split: null } } as unknown as FlowPbi)).toMatchObject({ total: "—", longest: "—" });
  });
});
