import { expect, test } from "bun:test";
import type { InboxNote } from "@switchboard/protocol";
import { noticeSource, splitInbox } from "./inbox.ts";

const note = (path: string, source?: InboxNote["source"]): InboxNote => ({ path, title: path, body: "b", created: "2026-10-23T00:00:00Z", status: "inbox", source });

test("splitInbox puts the daemon's notices apart from the user's drafts, keeping the order (#2401)", () => {
  const s = splitInbox([note("a"), note("n1", { schedule: "s", title: "検査" }), note("b"), note("n2", { schedule: "t", title: "待ち" })]);
  expect(s.notices.map((n) => n.path)).toEqual(["n1", "n2"]);
  expect(s.drafts.map((n) => n.path)).toEqual(["a", "b"]);
  expect(noticeSource(s.notices[0]!)).toBe("予定「検査」から");
  expect(noticeSource(s.drafts[0]!)).toBe("");
});
