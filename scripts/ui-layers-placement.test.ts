import { expect, test } from "bun:test";
import type { StoredRecords } from "../ops-kit/src/backlog-client.ts";
import { missingPlacement } from "./ui-layers-placement.ts";

const now = Date.parse("2026-11-01T00:00:00Z");
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();

type Issue = StoredRecords["issues"][number];
const pbi = (number: number, o: { body: string; area?: string | null; closedAt?: string | null; state?: Issue["state"]; labels?: string[] }): Issue => ({
  number, title: `PBI ${number}`, url: "", state: o.state ?? "CLOSED", stateReason: null, body: o.body, labels: o.labels ?? ["type:pbi"],
  parent: null, subIssues: [], createdAt: daysAgo(60), updatedAt: daysAgo(1), closedAt: o.closedAt === undefined ? daysAgo(3) : o.closedAt,
  fields: o.area === null ? null : { Area: o.area ?? "web" },
});

const records = (issues: Issue[]): StoredRecords => ({
  workspaceId: "ws", service: "github", repository: "o/r", project: { owner: "o", number: 1 }, fetchedAt: now, top: [], issues, comments: [], unread: [], pulls: [],
});

test("names only the closed screen PBIs in the period without a `**置き場所**:` line", () => {
  const r = missingPlacement(records([
    pbi(9, { body: "## 背景\nなし" }), // named
    pbi(2, { body: "x\n**置き場所**: 天井 — 毎回は触らない" }), // has the line
    pbi(5, { body: "x\n**置き場所**： 床" }), // full-width colon: not the line → named
    pbi(3, { body: "x", area: "core" }), // not a screen PBI
    pbi(4, { body: "x", area: null }), // not in the Project
    pbi(6, { body: "x", closedAt: daysAgo(40) }), // out of the period
    pbi(7, { body: "x", state: "OPEN", closedAt: null }), // open
    pbi(8, { body: "x", labels: ["type:task"] }), // a Task
    pbi(10, { body: "前置き **置き場所**: 床" }), // not at a line start → named
  ]), 30, now);
  expect(r).toEqual({ checked: 4, missing: [{ number: 5, title: "PBI 5" }, { number: 9, title: "PBI 9" }, { number: 10, title: "PBI 10" }] });
});
