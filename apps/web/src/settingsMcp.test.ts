import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskSummary } from "@switchboard/protocol";
import { McpCard, McpEndpoint, mcpSelection, mcpTaskChoices } from "./components/Settings.tsx";

// The Workspace MCP endpoint is issued from a folded Settings card, for a Task that is still running and not a cloud one.

const mk = (id: string, patch: Partial<TaskSummary> = {}): TaskSummary => ({ id, title: `title ${id}`, status: "running", executionMode: "local", updatedAt: 1, ...patch }) as TaskSummary;
const noop = () => undefined;

test("mcpTaskChoices drops ended and cloud Tasks and lists the newest first", () => {
  const tasks = [mk("old", { updatedAt: 1 }), mk("new", { updatedAt: 9 }), mk("done", { status: "done" }), mk("err", { status: "error" }), mk("abort", { status: "aborted" }), mk("cloud", { executionMode: "cloud" }), mk("idle", { status: "idle", updatedAt: 5 }), mk("archived", { status: "idle", archivedAt: 3 })];
  expect(mcpTaskChoices(tasks).map((x) => x.id)).toEqual(["new", "idle", "old"]);
});

test("the Workspace MCP card is a closed details with its title and hint", () => {
  const html = renderToStaticMarkup(createElement(McpCard, { tasks: [mk("a")], onError: noop }));
  expect(html).toContain("<summary><h5>Workspace MCP</h5></summary>");
  expect(html.slice(0, html.indexOf("<summary>"))).not.toContain(" open");
  expect(html).toContain("ホストの外の端末からは 401");
});

test("McpEndpoint says there is no running Task with no choice, and offers a select and the issue button with one", () => {
  const none = renderToStaticMarkup(createElement(McpEndpoint, { tasks: [mk("d", { status: "done" })], onError: noop }));
  expect(none).toContain("動いている Task がありません");
  expect(none).not.toContain("<select");
  const some = renderToStaticMarkup(createElement(McpEndpoint, { tasks: [mk("a")], onError: noop }));
  expect(some).toContain("<select");
  expect(some).toContain("title a");
  expect(some).toContain("エンドポイントを発行");
});

test("an issued endpoint stays tied to its Task: a reorder of the list or the Task leaving it hides it instead of showing it under another Task", () => {
  const issued = { id: "a", url: "u", token: "t" };
  // Issued for "a" with nothing picked by hand; then "b" moved to the top of the list.
  expect(mcpSelection([mk("b"), mk("a")], "", issued)).toEqual({ id: "b", shown: null });
  // Issuing pins the pick, so the same reorder keeps "a" selected and shown.
  expect(mcpSelection([mk("b"), mk("a")], "a", issued)).toEqual({ id: "a", shown: issued });
  // "a" ended and left the list.
  expect(mcpSelection([mk("b")], "a", issued)).toEqual({ id: "b", shown: null });
  expect(mcpSelection([], "", null)).toEqual({ id: "", shown: null });
});
