import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunnerInfo, Task } from "@switchboard/protocol";
import { Brief } from "./components/Brief.tsx";
import { effortLabel, effortOptions } from "./effortOptions.ts";

const claude = { efforts: [{ value: "low", label: "low" }, { value: "high", label: "high" }] };

describe("effortOptions (#833)", () => {
  test("the CLI default comes first, then the runner's efforts", () => {
    expect(effortOptions(claude, "")).toEqual([
      { value: "", label: "CLI 既定" },
      { value: "low", label: "low" },
      { value: "high", label: "high" },
    ]);
    expect(effortOptions(undefined, "")).toEqual([{ value: "", label: "CLI 既定" }]);
  });

  test("a current value not on the list (saved by a version that listed it) stays selectable; one on the list is not doubled", () => {
    expect(effortOptions(claude, "ultra").at(-1)).toEqual({ value: "ultra", label: "ultra" });
    expect(effortOptions(claude, "high")).toHaveLength(3);
  });
});

describe("effortLabel (#833)", () => {
  test("empty / null is the CLI default; a listed value reads as its label; another as it is", () => {
    expect(effortLabel(null, claude)).toBe("CLI 既定");
    expect(effortLabel("", claude)).toBe("CLI 既定");
    expect(effortLabel("high", { efforts: [{ value: "high", label: "深い" }] })).toBe("深い");
    expect(effortLabel("ultra", claude)).toBe("ultra");
    expect(effortLabel("high")).toBe("high");
  });
});

describe("Brief (#833)", () => {
  const task: Task = { id: "task_e", executionMode: "local", cloudSession: null, sourceCloudTaskId: null, workspaceId: null, title: "e", runner: "claude", cwd: "/w", scope: ["/w"], status: "done", runnerSessionId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: "high", origin: "switchboard", resumeAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null, statusAt: 1, createdAt: 1, updatedAt: 1 };
  const runners: RunnerInfo[] = [{ id: "claude", available: true, permissionModes: [], models: [], efforts: [{ value: "high", label: "深い" }] }];
  const render = (t: Task) => renderToStaticMarkup(createElement(Brief, { task: t, ledger: null, onAbort: () => {}, open: true, onClose: () => {}, runners }));
  const ROW = (text: string) => `<span>思考の深さ</span><span class="brief-effort" title="作成時に決まり、途中では変えられません">${text}</span>`;

  test("shows the task's effort by the runner's label, read-only; empty is CLI 既定", () => {
    expect(render(task)).toContain(ROW("深い"));
    expect(render({ ...task, effort: null })).toContain(ROW("CLI 既定"));
    expect(render({ ...task, effort: "ultra" })).toContain(ROW("ultra")); // no longer on the list: as it is
    expect(render(task)).not.toContain('aria-label="思考の深さ"'); // no select: fixed at creation
  });
});
