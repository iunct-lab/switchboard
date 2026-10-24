import { expect, test } from "bun:test";
import type { Schedule } from "@switchboard/protocol";
import { scheduleCreateInput, scheduleDraft, scheduleEditPatch } from "./scheduleEdit.ts";

const base = { id: "s1", title: "夜間", cron: "0 3 * * *", workspaceId: "w1", runner: "claude", model: "opus", effort: "high", prompt: "go", action: "prompt", budgetUsd: 2, enabled: true } as unknown as Schedule;

test("scheduleEditPatch: nothing changed is an empty patch", () => {
  expect(scheduleEditPatch(base, scheduleDraft(base))).toEqual({ patch: {} });
});

test("scheduleEditPatch: stored whitespace around title and prompt is not a change", () => {
  const padded = { ...base, title: " 夜間 ", prompt: " go " } as Schedule;
  expect(scheduleEditPatch(padded, scheduleDraft(padded))).toEqual({ patch: {} });
});

test("scheduleEditPatch: only the changed field is sent", () => {
  expect(scheduleEditPatch(base, { ...scheduleDraft(base), cron: "30 4 * * *" })).toEqual({ patch: { cron: "30 4 * * *" } });
  expect(scheduleEditPatch(base, { ...scheduleDraft(base), title: " 夜間 " })).toEqual({ patch: {} });
});

test("scheduleEditPatch: a runner change carries the reset model and effort", () => {
  expect(scheduleEditPatch(base, { ...scheduleDraft(base), runner: "codex", model: "", effort: "" })).toEqual({ patch: { runner: "codex", model: "", effort: "" } });
});

test("scheduleEditPatch: an empty budget is no budget, a typo sends nothing", () => {
  expect(scheduleEditPatch(base, { ...scheduleDraft(base), budget: "" })).toEqual({ patch: { budgetUsd: null } });
  expect("error" in scheduleEditPatch(base, { ...scheduleDraft(base), budget: "abc" })).toBe(true);
  expect("error" in scheduleEditPatch(base, { ...scheduleDraft(base), budget: "0" })).toBe(true);
});

test("scheduleEditPatch: backlog-next keeps its workspace and prompt", () => {
  const b = { ...base, action: "backlog-next", prompt: "" } as Schedule;
  expect(scheduleEditPatch(b, { ...scheduleDraft(b), workspaceId: "other", prompt: "x" })).toEqual({ patch: {} });
});

test("scheduleCreateInput (#1924): a prompt schedule keeps its workspace and trimmed prompt; the meta-only kinds take the meta workspace and no prompt; insights runs on claude whatever runner the form held and keeps the shown model and effort", () => {
  const form = { title: " 夜間 ", cron: "0 3 * * *", wsId: "w1", metaId: "meta", runner: "codex" as const, model: "gpt-6", effort: "high", prompt: " go ", budgetUsd: 2 };
  expect(scheduleCreateInput({ ...form, action: "prompt" })).toEqual({ title: "夜間", cron: "0 3 * * *", workspaceId: "w1", runner: "codex", model: "gpt-6", effort: "high", prompt: "go", action: "prompt", budgetUsd: 2 });
  expect(scheduleCreateInput({ ...form, action: "backlog-next" })).toEqual({ title: "夜間", cron: "0 3 * * *", workspaceId: "meta", runner: "codex", model: "gpt-6", effort: "high", prompt: "", action: "backlog-next", budgetUsd: 2 });
  expect(scheduleCreateInput({ ...form, action: "insights", model: "claude-opus-5-5", effort: "max" })).toEqual({ title: "夜間", cron: "0 3 * * *", workspaceId: "meta", runner: "claude", model: "claude-opus-5-5", effort: "max", prompt: "", action: "insights", budgetUsd: 2 });
  // no budget typed: the field is absent, not null (the server's nullable budget means "no limit" only when sent so)
  expect(scheduleCreateInput({ ...form, action: "prompt", budgetUsd: undefined })).toMatchObject({ budgetUsd: undefined });
});
