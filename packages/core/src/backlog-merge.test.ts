import { expect, test } from "bun:test";
import { backlogFieldValue, conflictRevision, mergeBacklogField, sameBacklogValue } from "./backlog-merge.ts";

// One field of an edit against GitHub's (#887, 初期方式 A): base = what the edit was made on, local = made here, remote = GitHub.

test("the 3-way table: unchanged, one side, both to the same value, both to different values", () => {
  const rows: Array<[string, unknown, unknown, unknown, string]> = [
    ["neither changed", "a", "a", "a", "synced"],
    ["only here", "a", "mine", "a", "local"],
    ["only GitHub", "a", "a", "theirs", "remote"],
    ["both, to the same value", "a", "same", "same", "synced"],
    ["both, to different values", "a", "mine", "theirs", "conflict"],
  ];
  for (const [what, base, local, remote, want] of rows) expect([what, mergeBacklogField("title", base, local, remote)]).toEqual([what, want]);
});

test("closing and moving to another parent are fields like the others; null is a value (no milestone, no parent)", () => {
  expect(mergeBacklogField("state", "OPEN", "CLOSED", "OPEN")).toBe("local");
  expect(mergeBacklogField("state", "OPEN", "CLOSED", "CLOSED")).toBe("synced");
  expect(mergeBacklogField("parent", 3, 4, null)).toBe("conflict");
  expect(mergeBacklogField("milestone", null, "Phase 2", null)).toBe("local");
});

test("one form per field: a number field sent as text, a body's marker, a label's case", () => {
  expect(sameBacklogValue("field:Story Points", "5", 5)).toBe(true);
  expect(sameBacklogValue("field:Story Points", "5", 8)).toBe(false);
  expect(sameBacklogValue("body", "本文", "本文\n\n<!-- switchboard-op:0f1e2d3c-aaaa-bbbb-cccc-000000000000 -->")).toBe(true);
  const issue = { title: "t", body: "b", state: "OPEN", milestone: null, parent: null, labels: ["Needs-Decision"] };
  expect(backlogFieldValue("issue", issue, "label:needs-decision")).toBe(true);
  expect(backlogFieldValue("issue", issue, "label:type:pbi")).toBe(false);
});

test("not read is not empty: no record, or a field the record cannot have, is not compared", () => {
  expect(backlogFieldValue("issue", null, "title")).toBeUndefined();
  expect(backlogFieldValue("project-item", { fields: {} }, "member")).toBeUndefined();
  expect(backlogFieldValue("issue", { title: "t" }, "field:Status")).toBeUndefined();
  // a Project field with no value is null: GitHub lists only the fields that have one
  expect(backlogFieldValue("project-item", { fields: { Status: "Ready" } }, "field:Priority")).toBeNull();
});

test("a conflict's revision moves with GitHub's value and with the edit, not with nothing", () => {
  const op = { id: "op1", status: "conflict", payload: "mine", base: "a" };
  const r = conflictRevision(op, "theirs");
  expect(conflictRevision({ ...op }, "theirs")).toBe(r);
  expect(conflictRevision(op, "theirs again")).not.toBe(r);
  expect(conflictRevision({ ...op, payload: "mine again" }, "theirs")).not.toBe(r);
  expect(conflictRevision({ ...op, status: "pending" }, "theirs")).not.toBe(r);
  // not read is not GitHub's null (no milestone, no parent)
  expect(conflictRevision(op, undefined)).not.toBe(conflictRevision(op, null));
});
