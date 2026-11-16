import { expect, test } from "bun:test";
import { githubRowView, loginPath, loginRowView } from "./loginRow.ts";

test("the claude row names the login in use and offers logout (#2528)", () => {
  expect(loginRowView({ id: "claude", login: "ok", loginKind: "claude.ai" })).toEqual({ text: "ログイン中: Claude アカウント", logout: true });
  expect(loginRowView({ id: "claude", login: "ok", loginKind: "console" })).toEqual({ text: "ログイン中: Anthropic Console", logout: true });
});

test("a kind that is not known is left out, the logout button stays", () => {
  expect(loginRowView({ id: "claude", login: "ok" })).toEqual({ text: "ログイン中", logout: true });
});

test("a login that ran out or was logged out shows ログアウト中 without logout", () => {
  expect(loginRowView({ id: "claude", login: "expired" })).toEqual({ text: "ログアウト中", logout: false });
});

test("other runners and an unknown login have no row", () => {
  expect(loginRowView({ id: "codex", login: "ok" })).toBeNull();
  expect(loginRowView({ id: "dak" })).toBeNull();
  expect(loginRowView({ id: "claude", login: "unknown" })).toBeNull();
});

test("on Amazon Bedrock (#1730) the row says so, with neither logout nor login", () => {
  expect(loginRowView({ id: "claude", login: "ok", loginKind: "bedrock" })).toEqual({ text: "使用中: サードパーティのプラットフォーム（Amazon Bedrock）", logout: false, bedrock: true });
});

test("codex on Amazon Bedrock (#1731) gets the same row; on its own login it still has none", () => {
  expect(loginRowView({ id: "codex", login: "ok", loginKind: "bedrock" })).toEqual({ text: "使用中: サードパーティのプラットフォーム（Amazon Bedrock）", logout: false, bedrock: true });
  expect(loginRowView({ id: "codex", login: "expired" })).toBeNull();
});

test("gh's login goes to its own path; a runner's stays under /api/runners", () => {
  expect(loginPath("gh")).toBe("/api/github/login");
  expect(loginPath("claude")).toBe("/api/runners/claude/login");
});

test("gh's row: the login button only while logged out; the account once in; no button without gh", () => {
  expect(githubRowView({ login: "none" })).toEqual({ text: "GitHub: ログインしていません（clone とバックログに要ります）", login: true });
  expect(githubRowView({ login: "ok", account: "octocat" })).toEqual({ text: "GitHub: octocat でログイン中", login: false });
  expect(githubRowView({ login: "ok" })).toEqual({ text: "GitHub: ログイン中", login: false });
  expect(githubRowView({ login: "missing" })).toMatchObject({ login: false });
});
