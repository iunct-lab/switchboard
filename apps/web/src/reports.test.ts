import { expect, test } from "bun:test";
import type { ReportRow } from "@switchboard/protocol";
import { reportMeta } from "./reports.ts";

const row = (over: Partial<ReportRow> = {}): ReportRow => ({ id: "art_1", taskId: "task_1", title: "weekly.html", kind: "file", source: "/x/weekly.html", entry: "weekly.html", mime: "text/html", size: 10, removedAt: null, createdAt: 0, updatedAt: Date.parse("2026-10-18T06:05:00+09:00"), taskTitle: "週報の Task", scheduleTitle: null, ...over });

test("reportMeta: the time it was last registered, then the schedule's title when one started the Task, else the Task's (#1835)", () => {
  expect(reportMeta(row())).toBe("10/18 06:05 · 週報の Task");
  expect(reportMeta(row({ scheduleTitle: "評価の週報（switchboard）" }))).toBe("10/18 06:05 · 評価の週報（switchboard）");
});
