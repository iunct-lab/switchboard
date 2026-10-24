import { describe, expect, test } from "bun:test";
import type { LoadKind, OpsLatency } from "@switchboard/protocol";
import { fmtBytes, fmtSize, kindLabel, latencyRows, loadDays, reasonLabel, stopsTable, taskLoadLine, topGroups } from "./ops.ts";

describe("ops stops table (#2093)", () => {
  test("newest day first, only the causes that occurred, totals, distinct tasks", () => {
    const t = stopsTable([
      { day: "2026-10-19", reason: "oomd", stops: 2, turns: 3, taskIds: ["a", "b"] },
      { day: "2026-10-20", reason: "promote", stops: 4, turns: 0, taskIds: [] },
      { day: "2026-10-20", reason: "oomd", stops: 1, turns: 2, taskIds: ["b", "c"] },
    ]);
    expect(t.reasons).toEqual(["oomd", "promote"]);
    expect(t.days.map((d) => d.day)).toEqual(["2026-10-20", "2026-10-19"]);
    expect(t.days[0]).toMatchObject({ turns: 2, taskIds: ["b", "c"] });
    expect(t.days[0]!.counts).toMatchObject({ oomd: 1, promote: 4, crash: 0 });
    expect(t.total).toMatchObject({ day: "合計", turns: 5, taskIds: ["a", "b", "c"] });
    expect(t.total.counts).toMatchObject({ oomd: 3, promote: 4 });
  });

  test("no rows: no columns, no days", () => {
    expect(stopsTable([])).toMatchObject({ reasons: [], days: [], total: { turns: 0, taskIds: [] } });
  });

  test("every cause has a label", () => {
    expect(Object.values(reasonLabel)).toEqual(["oomd の kill", "再起動", "ホストの停止", "昇格", "クラッシュ", "不明"]);
  });
});

describe("ops load (#2086)", () => {
  const GB = 1024 ** 3;
  const hour = (h: string, maxMem: number, limitHits: number, maxSwap = 0, memMax: number | null = 4 * GB) => ({ hour: h, maxMem, memMax, maxSwap, limitHits, maxCpuPct: null, maxPressureFull: null, maxDockerMem: null });

  test("loadDays: JST days newest first, the day's peaks, the ratio to the limit, limit hits added up", () => {
    const d = loadDays([hour("2026-10-19 23", 2 * GB, 1, 100), hour("2026-10-20 09", 3 * GB, 5, 50), hour("2026-10-20 10", 1 * GB, 2, 300), hour("2026-10-21 00", GB, 0, 0, null)]);
    expect(d.map((x) => x.day)).toEqual(["2026-10-21", "2026-10-20", "2026-10-19"]);
    expect(d[1]).toEqual({ day: "2026-10-20", maxMem: 3 * GB, memMax: 4 * GB, ratio: 0.75, limitHits: 7, maxSwap: 300 });
    expect(d[0]!.ratio).toBeNull(); // no limit
  });

  test("topGroups: largest first, what each is called, cut at 10", () => {
    const g = (taskId: string | null, owner: "task" | "daemon" | "other", kind: LoadKind, maxRss: number) => ({ taskId, owner, kind, maxRss, cpuMs: 1000 });
    const top = topGroups([g("t1", "task", "runner", 100), g(null, "daemon", "judge", 300), g("t2", "task", "browser", 1.2 * GB), g(null, "other", "other", 50)]);
    expect(top.map((t) => t.label)).toEqual(["Task t2 の headless Chrome", "デーモンの採点", "Task t1 の ランナー本体", "その他"]);
    expect(top.map((t) => t.taskId)).toEqual(["t2", null, "t1", null]);
    // outside any task: told apart by kind, and each row has its own key
    const others = topGroups([g(null, "other", "browser", 600), g(null, "other", "other", 50)]);
    expect(others.map((t) => t.label)).toEqual(["その他の headless Chrome", "その他"]);
    expect(new Set(others.map((t) => t.key)).size).toBe(2);
    expect(topGroups(Array.from({ length: 15 }, (_, i) => g(`t${i}`, "task", "test", i)))).toHaveLength(10);
    expect(fmtBytes(1.2 * GB)).toBe("1.2 GB");
    expect(fmtBytes(350 * 1024 ** 2)).toBe("350 MB");
  });

  test("taskLoadLine: the total and the kinds, largest first; null without rows", () => {
    const g = (kind: LoadKind, maxRss: number) => ({ taskId: "t1", owner: "task" as const, kind, maxRss, cpuMs: 0 });
    expect(taskLoadLine([g("runner", 0.4 * GB), g("browser", 0.8 * GB)])).toBe("最大 1.2 GB（headless Chrome 819 MB / ランナー本体 410 MB）");
    expect(taskLoadLine([g("runner", 1.5 * GB), g("subagent", 30 * 1024 ** 2)])).toBe("最大 1.5 GB（ランナー本体 1.5 GB / サブエージェント 30 MB）");
    expect(taskLoadLine([])).toBeNull();
  });

  test("every kind has a label", () => {
    expect(Object.keys(kindLabel)).toEqual(["runner", "subagent", "test", "browser", "docker", "build", "judge", "archive", "backlog", "other"]);
  });
});

describe("API latency rows (#2104)", () => {
  const stat = (route: string, p90: number, bytesP50: number | null = 2048, method = "GET") => ({ method, route, count: 1234, p50: p90 / 2, p90, bytesP50 });
  test("the top 10 by the API's order, each with its own days, the newest first", () => {
    const l: OpsLatency = {
      days: 7,
      total: Array.from({ length: 12 }, (_, i) => stat(`/api/r${i}`, 5000 - i * 100)),
      byDay: [
        { day: "2026-10-20", ...stat("/api/r0", 300) },
        { day: "2026-10-22", ...stat("/api/r0", 4000) },
        { day: "2026-10-21", ...stat("/api/r1", 200) },
        { day: "2026-10-21", ...stat("/api/r0", 100, null, "POST") }, // another method: not r0's GET
      ],
    };
    const rows = latencyRows(l);
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.route).slice(0, 2)).toEqual(["/api/r0", "/api/r1"]);
    expect(rows[0]).toMatchObject({ key: "GET /api/r0", method: "GET", count: "1,234", p50: "2.5 s", p90: "5.0 s", bytes: "2.0 KB" });
    expect(rows[0]!.days).toEqual([
      { day: "2026-10-22", p50: "2.0 s", p90: "4.0 s", count: 1234 },
      { day: "2026-10-20", p50: "150 ms", p90: "300 ms", count: 1234 },
    ]);
    expect(rows[1]!.days.map((d) => d.day)).toEqual(["2026-10-21"]);
    expect(rows[2]!.days).toEqual([]);
  });

  test("bytes: — when none were known; B / KB / MB", () => {
    expect(latencyRows({ days: 7, total: [stat("/api/x", 10, null)], byDay: [] })[0]!.bytes).toBe("—");
    expect([850, 12_595, 3_460_301].map(fmtSize)).toEqual(["850 B", "12.3 KB", "3.3 MB"]);
  });
});
