import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { BacklogItem, CreatedIssueRow, Task } from "@switchboard/protocol";
import { CreatedIssues } from "./components/CreatedIssues.tsx";
import { createdRowButtons, startCreatedRow } from "./createdIssues.ts";

const item = (over: Partial<BacklogItem>): BacklogItem => ({
  number: 1, title: "t", url: "https://github.com/o/r/issues/1", type: "pbi", stage: "in-progress", priority: null, storyPoints: null, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
  tasks: null, decision: null, activeTaskId: null, projectStatus: null, lastTask: null, replyWaiting: false, report: null, answeredAt: null, heldAt: null, confirmations: [], closable: false, progress: { closableByApi: false, closesOnAnswer: null }, onHold: false, flow: false, waits: [], waitsAt: null, waitsUntil: null, overlap: null, prereqs: [], stopSummary: [], mockupTask: null, mockups: [], workspaceId: "ws_meta", workspaceName: "switchboard", ...over,
});
const row = (number: number, title: string, kind: "request" | "pbi", it: Partial<BacklogItem> | null, workspaceId = "ws_meta"): CreatedIssueRow => ({
  repo: "o/r", number, workspaceId, title, url: `https://github.com/o/r/issues/${number}`, kind, item: it && item({ number, title, type: kind, workspaceId, url: `https://github.com/o/r/issues/${number}`, ...it }),
});
const html = (rows: CreatedIssueRow[]) =>
  renderToStaticMarkup(createElement(CreatedIssues, { rows, onStarted: () => undefined, onOpenTask: () => undefined, onError: () => undefined }));
const buttons = (h: string) => [...h.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((x) => x[1]);
const labels = (r: CreatedIssueRow) => createdRowButtons(r).map(([, l]) => l);

test("a Task that opened no Issue shows no section", () => {
  expect(html([])).toBe("");
});

test("one request: PBI にする and 直行で直す", () => {
  const req = row(6001, "要望: 一覧を更新順に並べる", "request", { stage: "request" });
  const h = html([req]);
  expect(h).toContain("この Task が作った Issue");
  expect(h).toContain(">#6001</a> 要望: 一覧を更新順に並べる");
  expect(h).toContain("要望のまま");
  expect(buttons(h)).toEqual(["PBI にする", "直行で直す"]);
  expect(createdRowButtons(req).map(([a]) => a)).toEqual(["to-pbi", "direct"]);
});

test("createdRowButtons: 直行で直す on another workspace's request too", () => {
  const other = row(6101, "要望: 別のリポジトリ", "request", { stage: "request" }, "ws_other");
  expect(createdRowButtons(other).map(([a]) => a)).toEqual(["to-pbi", "direct"]);
  expect(buttons(html([other]))).toEqual(["PBI にする", "直行で直す"]);
});

test("a request with its PBIs: the request (no item) has no button, a PBI waiting for Tasks is Task に分解, a Ready one 実装する", () => {
  const h = html([row(6001, "要望", "request", null), row(6002, "PBI: 更新順", "pbi", { stage: "needs-tasks" }), row(6003, "PBI: 並び順", "pbi", { stage: "ready" })]);
  expect(h).toContain("PBI 作成済み");
  expect(h).toContain("分解待ち");
  expect(h).toContain("Ready");
  expect(buttons(h)).toEqual(["Task に分解", "実装する"]);
  expect(createdRowButtons(row(6002, "x", "pbi", { stage: "needs-tasks" })).map(([a]) => a)).toEqual(["to-tasks"]);
  expect(createdRowButtons(row(6003, "x", "pbi", { stage: "ready" })).map(([a]) => a)).toEqual(["complete"]);
});

test("a PBI already split into Tasks but not Ready: the chip is the Backlog's 分解済み mark, the button Ready にする", () => {
  const split = row(6004, "PBI: 分解済み", "pbi", { stage: "needs-tasks", tasks: { total: 2, done: 0 } as BacklogItem["tasks"] });
  const h = html([split]);
  expect(h).toContain("分解済み・Ready 待ち");
  expect(h).not.toContain("分解待ち");
  expect(buttons(h)).toEqual(["Ready にする"]);
  expect(createdRowButtons(split).map(([a]) => a)).toEqual(["to-tasks"]);
});

test("in progress, needing a decision or closable: no button (状況を確認 and 閉じる stay on the Backlog)", () => {
  expect(labels(row(7, "x", "pbi", { stage: "in-progress" }))).toEqual([]);
  expect(labels(row(8, "x", "pbi", { stage: "needs-decision" }))).toEqual([]);
  expect(labels(row(9, "x", "pbi", { stage: "in-progress", closable: true }))).toEqual([]);
  expect(buttons(html([row(7, "x", "pbi", { stage: "in-progress" }), row(8, "x", "request", { stage: "needs-decision" })]))).toEqual([]);
});

test("a row whose stage Task runs links to it instead of a button", () => {
  const h = html([row(6002, "PBI", "pbi", { stage: "needs-tasks", activeTaskId: "task_x", lastTask: { id: "task_x", status: "running", createdAt: 0, statusAt: 0 } as BacklogItem["lastTask"] })]);
  expect(buttons(h)).toHaveLength(1);
  expect(buttons(h)[0]).toContain("実行中");
  expect(h).not.toContain("Task に分解");
});

const started = { id: "task_new" } as Task;
const run = async (start: () => Promise<Task>) => {
  const seen: string[] = [];
  await startCreatedRow(start, row(6001, "x", "request", { stage: "request" }), "to-pbi", { onStarted: (t) => seen.push(`started ${t.id}`), onOpenTask: (id) => seen.push(`open ${id}`), onError: (m) => seen.push(`error ${m}`) });
  return seen;
};
const refused = (status: number, message: string, body?: unknown) => () => Promise.reject(Object.assign(new Error(message), { status, body }));

test("start: the started Task opens; a 409 naming the running Task opens it; another refusal is the Backlog's line", async () => {
  expect(await run(() => Promise.resolve(started))).toEqual(["started task_new"]);
  expect(await run(refused(409, "already running", { taskId: "task_running" }))).toEqual(["open task_running"]);
  expect(await run(refused(409, "#6001 は重なりがあるので始めません", { error: "overlap" }))).toEqual(["error #6001 を始められませんでした: #6001 は重なりがあるので始めません"]);
});
