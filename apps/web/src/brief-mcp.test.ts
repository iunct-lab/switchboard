import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "@switchboard/protocol";
import type { TaskDetail } from "./api.ts";
import { Brief } from "./components/Brief.tsx";

// The Brief names the MCP servers handed to the task's Claude (#2090): the user-wide ones are not.

const noop = () => undefined;
const task: Task = { id: "task_mcp", executionMode: "local", cloudSession: null, sourceCloudTaskId: null, workspaceId: null, title: "t", runner: "claude", cwd: "/fixture", scope: ["/fixture"], status: "done", runnerSessionId: "sess-1", model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "done", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null, statusAt: 1, createdAt: 1, updatedAt: 1 };
const detail = (t: Task, mcpServers: string[]): TaskDetail => ({ task: t, events: [], cost: { costUsd: 0, tokens: 0 }, history: null, attachments: [], localContinuations: [], sourceCloudTask: null, mcpServers });
const brief = (t: Task, mcpServers: string[]) => renderToStaticMarkup(createElement(Brief, { task: t, detail: detail(t, mcpServers), ledger: null, onAbort: noop, open: true, onClose: noop }));

test("Brief: 渡す MCP lists the handed servers, なし when none, and no row for a Codex task", () => {
  expect(brief(task, ["playwright", "docs"])).toContain("<span>渡す MCP</span><span title=\"mcp.yaml の servers から。ユーザー全体の ~/.claude.json の MCP は Task に渡さない（#2090）\">playwright、docs</span>");
  expect(brief(task, [])).toContain("なし（ユーザー全体の MCP は渡さない）");
  expect(brief({ ...task, runner: "codex" }, [])).not.toContain("渡す MCP");
});
