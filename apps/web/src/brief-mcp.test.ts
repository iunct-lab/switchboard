import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "@switchboard/protocol";
import type { TaskDetail } from "./api/tasks.ts";
import { Brief } from "./components/Brief.tsx";
import { t } from "./i18n.ts";
import { brief as m } from "./i18n/brief.ts";

// The Brief names the MCP servers handed to the task's Claude: the user-wide ones are not.

const noop = () => undefined;
const task: Task = { id: "task_mcp", executionMode: "local", cloudSession: null, sourceCloudTaskId: null, workspaceId: null, title: "t", runner: "claude", cwd: "/fixture", scope: ["/fixture"], status: "done", runnerSessionId: "sess-1", model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "finished", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 1, createdAt: 1, updatedAt: 1 };
const detail = (t: Task, mcpServers: string[]): TaskDetail => ({ task: t, events: [], cost: { costUsd: 0, tokens: 0 }, history: null, attachments: [], localContinuations: [], sourceCloudTask: null, mcpServers });
const brief = (t: Task, mcpServers: string[]) => renderToStaticMarkup(createElement(Brief, { task: t, detail: detail(t, mcpServers), ledger: null, onAbort: noop, open: true, onClose: noop }));

test("Brief: 渡す MCP lists the handed servers, なし when none, and no row for a Codex task", () => {
  expect(brief(task, ["playwright", "docs"])).toContain("<span>渡す MCP</span><span title=\"mcp.yaml の servers から。ユーザー全体の ~/.claude.json の MCP は Task に渡さない\">playwright、docs</span>");
  expect(brief(task, [])).toContain("なし（ユーザー全体の MCP は渡さない）");
  expect(brief({ ...task, runner: "codex" }, [])).not.toContain("渡す MCP");
});

test("Brief: the Workspace MCP block has no issue button or token view and keeps the 渡す MCP row", () => {
  const html = brief(task, ["playwright"]);
  expect(html).toContain("Workspace MCP");
  expect(html).toContain("<span>渡す MCP</span>");
  expect(html).not.toContain("エンドポイントを発行");
  expect(html).not.toContain("URL+token をコピー");
});

test("Brief: a Codex task has no Workspace MCP heading at all", () => {
  expect(brief({ ...task, runner: "codex" }, [])).not.toContain("Workspace MCP");
});

test("Brief: 操作 の欄は差分タブを指すだけで、Phase の予告を出さない", () => {
  const html = brief(task, []);
  expect(html).toContain("変更したファイルは「差分」タブに。</div>");
  expect(html).not.toMatch(/Phase ?\d/);
});

test("Brief: the MCP row's words in English join the servers with a comma and keep the placeholders", () => {
  expect(t(m.mcpServers, undefined, "en")).toBe("MCP handed over");
  expect(["playwright", "docs"].join(t(m.mcpSeparator, undefined, "en"))).toBe("playwright, docs");
  expect(t(m.footprint, { files: "1,234", k: 56, more: "+" }, "en")).toBe("Files: 1,234 · about 56k tokens+");
  expect(t(m.footprint, { files: "1,234", k: 56, more: "+" })).toBe("1,234 ファイル · 約 56k トークン+");
});
