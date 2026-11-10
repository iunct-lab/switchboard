import { expect, test } from "bun:test";
import type { TaskDiffFile } from "@switchboard/protocol";
import { diffRows } from "./diffView.ts";

const file = (path: string, source: TaskDiffFile["source"]): TaskDiffFile => ({ path, rel: path, source, stat: source === "removed" ? "" : "+1 -0", diff: "" });

test("removed rows become notes and are not files", () => {
  const r = diffRows([file("/w/switchboard-pbi1", "removed")]);
  expect(r.files).toEqual([]);
  expect(r.notes).toEqual(["このタスクが書いた場所は削除済みのため、差分を出せません: /w/switchboard-pbi1"]);
});

test("an empty diff keeps the no-change note", () => {
  const r = diffRows([]);
  expect(r.files).toEqual([]);
  expect(r.notes).toHaveLength(1);
  expect(r.notes[0]).toContain("このタスクによる変更はまだありません");
});

test("files and a removed place show both", () => {
  const a = file("/w/a.ts", "worktree");
  const r = diffRows([a, file("/gone", "removed")]);
  expect(r.files).toEqual([a]);
  expect(r.notes).toEqual(["このタスクが書いた場所は削除済みのため、差分を出せません: /gone"]);
});
