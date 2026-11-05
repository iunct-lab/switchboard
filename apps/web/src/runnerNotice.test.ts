import { expect, test } from "bun:test";
import type { RunnerInfo } from "@switchboard/protocol";
import { startBlockedReason, unavailableNotice, unavailableNotices } from "./runnerNotice.ts";

const info = (id: RunnerInfo["id"], available: boolean, note?: string): RunnerInfo => ({ id, available, note, permissionModes: [], models: [], efforts: [], bedrockAvailable: false });

test("unavailableNotice: a usable runner has none", () => {
  expect(unavailableNotice(info("claude", true, "ok"), "claude")).toBeNull();
});

test("unavailableNotice: the daemon's note when it gave one", () => {
  expect(unavailableNotice(info("codex", false, '"codex" not found on PATH. Install Codex CLI: x'), "codex")).toBe('"codex" not found on PATH. Install Codex CLI: x');
});

test("unavailableNotice: without a note (or without the daemon's list), what is missing and what to do", () => {
  expect(unavailableNotice(info("claude", false), "claude")).toContain("インストール");
  expect(unavailableNotice(undefined, "claude")).toContain("claude が PATH にありません");
  expect(unavailableNotice(undefined, "codex")).toContain("curl -fsSL https://chatgpt.com/codex/install.sh | sh");
  expect(unavailableNotice(undefined, "dak")).toContain("docker compose up");
  // an ADK server added in Settings (#3384): its label, else its id
  expect(unavailableNotice({ ...info("custom:sample", false), label: "Sample" }, "custom:sample")).toBe("Sample に到達できません");
  expect(unavailableNotice(undefined, "custom:sample")).toBe("custom:sample に到達できません");
});

test("unavailableNotices: the listed runners that cannot be used; none before the daemon listed them", () => {
  expect(unavailableNotices(undefined)).toEqual([]);
  expect(unavailableNotices([info("claude", true), info("codex", false, "no codex"), info("dak", false)])).toEqual([
    { id: "codex", text: "no codex" },
    { id: "dak", text: expect.stringContaining("docker compose up") },
  ]);
});

const ok = { prompt: "直す", stale: false, attachBusy: false, runnerOk: true, cloud: false, ws: true, anyRunnerOk: true };

test("startBlockedReason: null when 開始 can be pressed", () => {
  expect(startBlockedReason(ok)).toBeNull();
  expect(startBlockedReason({ ...ok, ws: false })).toBeNull(); // 自動: the daemon picks the Workspace
});

test("startBlockedReason: each reason", () => {
  expect(startBlockedReason({ ...ok, prompt: "  " })).toBe("本文を書いてください");
  expect(startBlockedReason({ ...ok, stale: true })).toBe("Workspace を変えたので、本文に入れ直してください");
  expect(startBlockedReason({ ...ok, attachBusy: true })).toBe("添付のアップロードが終わるまで待ってください");
  expect(startBlockedReason({ ...ok, runnerOk: false, anyRunnerOk: false })).toMatch(/^使えるランナーがありません。/);
  expect(startBlockedReason({ ...ok, runnerOk: false })).toBe("選んだランナーは使えません。使えるランナーを選んでください");
  expect(startBlockedReason({ ...ok, cloud: true, ws: false })).toBe("Cloud は Workspace を選んでください");
});

test("startBlockedReason: an upload does not hold a Cloud start (Cloud sends no attachments)", () => {
  expect(startBlockedReason({ ...ok, cloud: true, attachBusy: true })).toBeNull();
});

test("startBlockedReason: the first reason wins, in the order the person fixes them", () => {
  const all = { prompt: "", stale: true, attachBusy: true, runnerOk: false, cloud: false, ws: false, anyRunnerOk: false };
  expect(startBlockedReason(all)).toBe("本文を書いてください");
  expect(startBlockedReason({ ...all, prompt: "x" })).toBe("Workspace を変えたので、本文に入れ直してください");
  expect(startBlockedReason({ ...all, prompt: "x", stale: false })).toBe("添付のアップロードが終わるまで待ってください");
  expect(startBlockedReason({ ...all, prompt: "x", stale: false, attachBusy: false })).toMatch(/^使えるランナーがありません。/);
  expect(startBlockedReason({ ...all, prompt: "x", stale: false, attachBusy: false, anyRunnerOk: true, runnerOk: true, cloud: true })).toBe("Cloud は Workspace を選んでください");
});
