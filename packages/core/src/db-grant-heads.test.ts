import { expect, test } from "bun:test";
import { Db } from "./db.ts";
import { migration } from "./db/migrations/0057-task-grant-heads.ts";

test("each head a grant was given for stays on record, though the row the gate reads keeps the newest head; only the person's are listed", () => {
  const db = new Db(":memory:");
  const H = "a".repeat(40), H2 = "b".repeat(40);
  db.recordMergeGrant({ taskId: "t_a", repo: "O/A", kind: "merge", target: 12, by: "owner", head: H }, 100);
  db.recordMergeGrant({ taskId: "t_a", repo: "O/A", kind: "merge", target: 12, by: "owner", head: H2 }, 200);
  db.recordMergeGrant({ taskId: "t_a", repo: "o/a", kind: "answer", target: 12, by: "task:other", head: H2 }, 210);
  db.recordMergeGrant({ taskId: "t_a", repo: "o/a", kind: "scope", target: 12, by: "owner", head: H2 }, 220);
  expect(db.hasMergeGrant("t_a", "o/a", "merge", 12, H)).toBe(false);
  expect(db.hasMergeGrant("t_a", "o/a", "merge", 12, H2)).toBe(true);
  expect(db.ownerMergeGrantsOf("o/a", [12])).toEqual([{ taskId: "t_a", target: 12, head: H, at: 100 }, { taskId: "t_a", target: 12, head: H2, at: 200 }]);
  // the same head allowed again later (a new ask after the first grant) keeps both times
  db.recordMergeGrant({ taskId: "t_a", repo: "o/a", kind: "merge", target: 12, by: "owner", head: H }, 300);
  expect(db.ownerMergeGrantsOf("o/a", [12]).map((g) => [g.head, g.at])).toEqual([[H, 100], [H2, 200], [H, 300]]);
  db.close();
});

test("the one-time copy of the grants kept so far lowercases the head and the repository", () => {
  const db = new Db(":memory:");
  const raw = (db as unknown as { sqlite: import("bun:sqlite").Database }).sqlite;
  raw.exec("DELETE FROM task_grant_heads");
  raw.query("INSERT INTO task_grants (task_id, repo, kind, target, by, source, at, head) VALUES ('t_a', 'O/A', 'answer', 7, 'owner', '', 50, ?)").run("A".repeat(40));
  migration.run(raw, () => new Set());
  expect(db.ownerMergeGrantsOf("o/a", [7])).toEqual([{ taskId: "t_a", target: 7, head: "a".repeat(40), at: 50 }]);
  db.close();
});
