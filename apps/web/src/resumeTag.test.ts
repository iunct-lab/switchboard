import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "@switchboard/protocol";
import { fmtClock, ResumeTag } from "./components/ui.tsx";
import { Brief } from "./components/Brief.tsx";

// A task waiting on GitHub's API limit (#550) reads differently from one stopped on the runner's usage limit (#102).

const noop = () => undefined;
const at = Date.UTC(2026, 9, 13, 1, 0, 0);
const task: Task = { id: "task_gh", executionMode: "local", cloudSession: null, sourceCloudTaskId: null, workspaceId: null, title: "t", runner: "claude", cwd: "/fixture", scope: ["/fixture"], status: "done", runnerSessionId: "sess-1", model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: at, resumeReason: "github", resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "done", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 1, createdAt: 1, updatedAt: 1 };

test("ResumeTag: a GitHub wait says so (the Rail's compact form too); the runner's limit and no reason read as before; no plan, no tag", () => {
  const github = renderToStaticMarkup(createElement(ResumeTag, { resumeAt: at, reason: "github" }));
  expect(github).toContain("GitHub の上限待ち（");
  expect(github).toContain("に再開）");
  expect(github).toContain("GitHub の API 上限（1 時間の枠）で待機");
  expect(renderToStaticMarkup(createElement(ResumeTag, { resumeAt: at, reason: "github", compact: true }))).toContain(">GitHub 待ち<");
  for (const reason of ["limit", null] as const) {
    const limit = renderToStaticMarkup(createElement(ResumeTag, { resumeAt: at, reason }));
    expect(limit).toContain(">再開待ち ");
    expect(limit).toContain("ランナーの使用上限で停止");
    expect(limit).not.toContain("GitHub");
  }
  expect(renderToStaticMarkup(createElement(ResumeTag, { resumeAt: null, reason: "github" }))).toBe("");
});

test("Brief: the resume block is headed GitHub の API 上限 and opens with the GitHub sentence for a GitHub wait; the usage-limit wording stays for the rest", () => {
  const github = renderToStaticMarkup(createElement(Brief, { task, ledger: null, onAbort: noop, open: true, onClose: noop }));
  expect(github).toContain("<h5>GitHub の API 上限</h5>");
  expect(github).toContain("GitHub の API 上限で待っています。");
  expect(github).toContain("GitHub の枠がまだ戻っていなければ");
  expect(github).not.toContain("ランナーの使用上限で止まりました");
  for (const reason of ["limit", null] as const) {
    const limit = renderToStaticMarkup(createElement(Brief, { task: { ...task, resumeReason: reason }, ledger: null, onAbort: noop, open: true, onClose: noop }));
    expect(limit).toContain("<h5>使用上限</h5>");
    expect(limit).toContain("ランナーの使用上限で止まりました。");
    expect(limit).toContain("枠がまだ戻っていなければまた止まり");
  }
});

test("probe: a wait with a planned time shows when it tries and the fallback (#2237)", () => {
  const planned = at + 4 * 24 * 3600_000;
  const tag = renderToStaticMarkup(createElement(ResumeTag, { resumeAt: at, reason: "limit", plannedAt: planned }));
  expect(tag).toContain(`>再開待ち ${fmtClock(at)} に試す<`);
  expect(tag).toContain(`だめなら ${fmtClock(planned)} に再開`);
  const compact = renderToStaticMarkup(createElement(ResumeTag, { resumeAt: at, reason: "limit", plannedAt: planned, compact: true }));
  expect(compact).toContain(">再開待ち<");
  expect(compact).toContain(`だめなら ${fmtClock(planned)} に再開`);
  const limited = { ...task, resumeReason: "limit" as const, resumePlannedAt: planned };
  const brief = renderToStaticMarkup(createElement(Brief, { task: limited, ledger: null, onAbort: noop, open: true, onClose: noop, runners: [{ id: "claude", autoResume: true, models: [] }] as never }));
  expect(brief).toContain(`<b>${fmtClock(at)}</b> に 1 回試します（だめなら <b>${fmtClock(planned)}</b>）`);
  // no try planned: as before
  expect(renderToStaticMarkup(createElement(Brief, { task: { ...limited, resumePlannedAt: null }, ledger: null, onAbort: noop, open: true, onClose: noop, runners: [{ id: "claude", autoResume: true, models: [] }] as never }))).toContain("に同じセッションで自動再開します");
});
