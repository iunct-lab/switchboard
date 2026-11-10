import { expect, test } from "bun:test";
import type { TaskDiffFile } from "@switchboard/protocol";
import { diffRows, diffTag } from "./diffView.ts";

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

const at = Date.UTC(2026, 10, 10, 3, 5); // 12:05 JST on 11/10
const snap = (path: string, when: number): TaskDiffFile => ({ ...file(path, "snapshot"), root: "/gone", at: when });

test("snapshot rows", () => {
  const a = snap("/gone/a.ts", at);
  const b = snap("/gone/b.ts", at);
  const r = diffRows([file("/gone", "removed"), a, b], at + 60_000);
  expect(r.files).toEqual([a, b]);
  expect(r.notes).toEqual(["書いた場所は削除済みです。12:05 に写した差分を出しています: /gone"]);
  // another day: the date comes first
  expect(diffRows([file("/gone", "removed"), a], at + 86_400_000).notes).toEqual(["書いた場所は削除済みです。11/10 12:05 に写した差分を出しています: /gone"]);
  // a removed place without a copy keeps the plain sentence
  expect(diffRows([file("/gone", "removed"), file("/w/x.ts", "worktree")], at).notes).toEqual(["このタスクが書いた場所は削除済みのため、差分を出せません: /gone"]);
});

test("diffTag", () => {
  expect(diffTag(file("/a", "staging"))).toBe("ステージング");
  expect(diffTag(file("/a", "worktree"))).toBe("作業ツリー");
  expect(diffTag(snap("/gone/a.ts", at), at)).toBe("記録 12:05");
});
