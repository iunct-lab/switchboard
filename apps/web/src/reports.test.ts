import { expect, test } from "bun:test";
import type { ReportRow } from "@switchboard/protocol";
import { acrossParams, artifactMeta, kindLabel, reportMeta } from "./reports.ts";

const row = (over: Partial<ReportRow> = {}): ReportRow => ({ id: "art_1", taskId: "task_1", title: "weekly.html", kind: "file", source: "/x/weekly.html", entry: "weekly.html", mime: "text/html", size: 10, removedAt: null, createdAt: 0, updatedAt: Date.parse("2026-10-18T06:05:00+09:00"), taskTitle: "週報の Task", scheduleTitle: null, ...over });

test("reportMeta: the time it was last registered, then the schedule's title when one started the Task, else the Task's (#1835)", () => {
  expect(reportMeta(row())).toBe("10/18 06:05 · 週報の Task");
  expect(reportMeta(row({ scheduleTitle: "評価の週報（switchboard）" }))).toBe("10/18 06:05 · 評価の週報（switchboard）");
});

test("kindLabel: the kind a row of every artifact names (#1833)", () => {
  const k = (kind: ReportRow["kind"], mime: string) => kindLabel({ kind, mime });
  expect(k("file", "text/html")).toBe("HTML");
  expect(k("file", "image/svg+xml")).toBe("画像");
  expect(k("file", "image/png")).toBe("画像");
  expect(k("file", "text/plain")).toBe("テキスト");
  expect(k("file", "application/pdf")).toBe("PDF");
  expect(k("dir", "text/html")).toBe("フォルダ");
  expect(k("url", "text/uri-list")).toBe("URL");
});

test("artifactMeta: the kind, then the time and who made it (#1833)", () => {
  expect(artifactMeta(row({ mime: "image/png", title: "shot.png" }))).toBe("画像 · 10/18 06:05 · 週報の Task");
});

test("acrossParams: the words typed go into the query, trimmed; a blank one is left out (#1833)", () => {
  expect(acrossParams({ q: "  週報 " })).toBe("?q=%E9%80%B1%E5%A0%B1");
  expect(acrossParams({ q: "   " })).toBe("");
  expect(acrossParams({})).toBe("");
  expect(acrossParams({ limit: 50, q: "a b", before: "art_9" })).toBe("?limit=50&q=a+b&before=art_9");
});
