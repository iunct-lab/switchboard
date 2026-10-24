import { expect, test } from "bun:test";
import { eventsArchiveNotice } from "./events-archive.ts";

test("the notice shows the date, count and key (#1439)", () => {
  const at = Date.parse("2026-10-14T23:59:00+09:00");
  expect(eventsArchiveNotice({ key: "history/events/2026/task_a.12.jsonl.zst.age", at, count: 120 })).toBe("会話の記録は S3 に移しました（2026-10-14、120 件）: history/events/2026/task_a.12.jsonl.zst.age");
  // moved again after a resume: every key, oldest first
  expect(eventsArchiveNotice({ key: "history/events/2026/task_a.12.jsonl.zst.age\nhistory/events/2026/task_a.40.jsonl.zst.age", at, count: 41 })).toBe(
    "会話の記録は S3 に移しました（2026-10-14、41 件）: history/events/2026/task_a.12.jsonl.zst.age, history/events/2026/task_a.40.jsonl.zst.age",
  );
  expect(eventsArchiveNotice(null)).toBeNull();
});
