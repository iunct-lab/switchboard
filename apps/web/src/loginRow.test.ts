import { expect, test } from "bun:test";
import { githubRowView, loginPath, loginRowView, logoutConfirmText, switchboardRowView } from "./loginRow.ts";

const BEDROCK = "使用中: サードパーティのプラットフォーム（Amazon Bedrock）";

test("the claude row names the login in use and offers logout", () => {
  expect(loginRowView({ id: "claude", available: true, login: "ok", loginKind: "claude.ai" })).toEqual({ id: "claude", label: "Claude Code", text: "ログイン中: Claude アカウント", action: "logout" });
  expect(loginRowView({ id: "claude", available: true, login: "ok", loginKind: "console" })).toMatchObject({ text: "ログイン中: Anthropic Console", action: "logout" });
});

test("a kind that is not known is left out, the logout button stays", () => {
  expect(loginRowView({ id: "claude", available: true, login: "ok" })).toMatchObject({ text: "ログイン中", action: "logout" });
});

test("a login that ran out or was logged out shows ログアウト中 with the login button, for claude and codex", () => {
  expect(loginRowView({ id: "claude", available: true, login: "expired" })).toMatchObject({ text: "ログアウト中", action: "login" });
  expect(loginRowView({ id: "codex", available: true, login: "expired" })).toEqual({ id: "codex", label: "Codex", text: "ログアウト中", action: "login" });
});

test("codex has a row too: logged in with logout, no kind in the text", () => {
  expect(loginRowView({ id: "codex", available: true, login: "ok" })).toEqual({ id: "codex", label: "Codex", text: "ログイン中", action: "logout" });
});

test("a missing tool or an unknown state says so with no button; a runner with no login row gives null", () => {
  expect(loginRowView({ id: "claude", available: false })).toMatchObject({ text: expect.stringContaining("道具がありません"), action: null });
  expect(loginRowView({ id: "codex", available: false, login: "ok" })).toMatchObject({ text: expect.stringContaining("道具がありません"), action: null });
  expect(loginRowView({ id: "codex", available: true, login: "unknown" })).toMatchObject({ text: "状態を確かめられません", action: null });
  expect(loginRowView({ id: "dak", available: true })).toBeNull();
});

test("on Amazon Bedrock the row says so, with neither logout nor login (claude and codex)", () => {
  expect(loginRowView({ id: "claude", available: true, login: "ok", loginKind: "bedrock" })).toEqual({ id: "claude", label: "Claude Code", text: BEDROCK, action: null, bedrock: true });
  expect(loginRowView({ id: "codex", available: true, login: "expired", loginKind: "bedrock" })).toEqual({ id: "codex", label: "Codex", text: BEDROCK, action: null, bedrock: true });
});

test("switchboard's row: passkey logs out; the token and no login (inside the host) have no button", () => {
  expect(switchboardRowView("passkey")).toEqual({ id: "switchboard", label: "Switchboard", text: "ログイン中（パスキー）", action: "logout" });
  expect(switchboardRowView("token")).toEqual({ id: "switchboard", label: "Switchboard", text: "トークンで接続中", action: null });
  expect(switchboardRowView(undefined)).toEqual({ id: "switchboard", label: "Switchboard", text: "このホストの中ではログイン不要", action: null });
});

test("gh's login goes to its own path; a runner's stays under /api/runners", () => {
  expect(loginPath("gh")).toBe("/api/github/login");
  expect(loginPath("claude")).toBe("/api/runners/claude/login");
});

test("gh's row: login while logged out, logout with the account once in, no button without gh", () => {
  expect(githubRowView({ login: "none" })).toEqual({ id: "gh", label: "GitHub", text: "ログインしていません（clone とバックログに要ります）", action: "login" });
  expect(githubRowView({ login: "ok", account: "octocat" })).toEqual({ id: "gh", label: "GitHub", text: "octocat でログイン中", action: "logout" });
  expect(githubRowView({ login: "ok" })).toMatchObject({ text: "ログイン中", action: "logout" });
  expect(githubRowView({ login: "missing" })).toMatchObject({ action: null });
});

test("the logout confirmation counts the running Tasks of the same runner; gh counts every running Task", () => {
  const tasks = [
    { runner: "codex", status: "running" as const },
    { runner: "codex", status: "background" as const },
    { runner: "claude", status: "running" as const },
    { runner: "codex", status: "done" as const },
  ];
  expect(logoutConfirmText("codex", tasks)).toContain("2 件");
  expect(logoutConfirmText("claude", tasks)).toContain("1 件");
  expect(logoutConfirmText("gh", tasks)).toContain("3 件");
  expect(logoutConfirmText("codex", [])).not.toContain("動いている Task");
});

test("bedrock from the CLI: the row says where it is set, with neither logout, login nor a way back", () => {
  const view = loginRowView({ id: "claude", available: true, login: "ok", loginKind: "bedrock", bedrockFrom: "cli" });
  expect(view).toEqual({ id: "claude", label: "Claude Code", text: "使用中: Amazon Bedrock（CLI の設定）", action: null, bedrock: "cli" });
  expect(loginRowView({ id: "codex", available: true, login: "ok", loginKind: "bedrock", bedrockFrom: "settings" })?.bedrock).toBe(true);
});
