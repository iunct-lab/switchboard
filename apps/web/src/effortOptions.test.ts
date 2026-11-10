// test-reads: apps/web/src/modelOptions.ts apps/web/src/presets.ts apps/web/src/i18n.ts apps/web/src/i18n/home.ts
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
  const task: Task = { id: "task_e", executionMode: "local", cloudSession: null, sourceCloudTaskId: null, workspaceId: null, title: "e", runner: "claude", cwd: "/w", scope: ["/w"], status: "done", runnerSessionId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: "high", origin: "switchboard", resumeAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 1, createdAt: 1, updatedAt: 1 };
  const runners: RunnerInfo[] = [{ id: "claude", available: true, permissionModes: [], models: [], efforts: [{ value: "high", label: "深い" }] }];
  const render = (t: Task) => renderToStaticMarkup(createElement(Brief, { task: t, ledger: null, onAbort: () => {}, open: true, onClose: () => {}, runners }));
  test("a local task's effort is a select (changeable from the next turn); the cloud task has none", () => {
    const html = render(task);
    expect(html).toContain('aria-label="思考の深さ"');
    expect(html).toContain("思考の深さ: 深い");
    expect(render({ ...task, effort: null })).toContain("思考の深さ: CLI 既定");
    expect(html).toContain("新しい思考の深さで再開"); // done: the next reply
    expect(render({ ...task, status: "running" })).toContain("変更は次のターンから");
    const cloud = render({ ...task, executionMode: "cloud" });
    expect(cloud).not.toContain('aria-label="思考の深さ"');
    expect(cloud).toContain("公式 Web で操作してください");
  });
});

describe("in English (#2442)", () => {
  // the language is read once when i18n.ts loads: a fresh process with the browser's choice set to en
  test("the CLI default, a listed model and a preset's target read in English", () => {
    const at = (f: string) => JSON.stringify(new URL(f, import.meta.url).pathname);
    const code = `globalThis.localStorage = { getItem: (k) => (k === "switchboard.lang" ? "en" : null) };
const { effortLabel } = await import(${at("./effortOptions.ts")});
const { modelOptions } = await import(${at("./modelOptions.ts")});
const { presetRow } = await import(${at("./presets.ts")});
console.log(JSON.stringify([effortLabel(null), modelOptions({ models: [{ value: "m-1", label: "M" }], cliDefaultModel: "m-1" }, "").map((o) => o.label), presetRow({ name: "x", text: "{{target}}" }).target]));`;
    const r = Bun.spawnSync([process.execPath, "-e", code]);
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toEqual(["CLI default", ["CLI default (m-1)", "M (m-1)"], "Target: choose an Issue / PR"]);
  });
});
