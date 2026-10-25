import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunnerInfo } from "@switchboard/protocol";
import { ClaudeLoginRow } from "./components/ClaudeLoginRow.tsx";

const runner = (r: Partial<RunnerInfo>) => ({ id: "claude", available: true, permissionModes: [], models: [], efforts: [], ...r }) as RunnerInfo;
const html = (r: RunnerInfo) => renderToStaticMarkup(createElement(ClaudeLoginRow, { runner: r, onChanged: async () => undefined, onError: () => undefined }));

test("logged in: the kind and a logout button, no login buttons (#2528)", () => {
  const h = html(runner({ login: "ok", loginKind: "console" }));
  expect(h).toContain("ログイン中: Anthropic Console");
  expect(h).toContain("ログアウト</button>");
  expect(h).not.toContain("でログイン");
  expect(html(runner({ login: "ok", loginKind: "claude.ai" }))).toContain("ログイン中: Claude アカウント");
});

test("logged out: ログアウト中 and the two login buttons, no logout button", () => {
  const h = html(runner({ login: "expired" }));
  expect(h).toContain("ログアウト中");
  expect(h).toContain("Claude アカウントでログイン");
  expect(h).toContain("Anthropic Console でログイン");
  expect(h).not.toContain("ログアウト</button>");
});

test("another runner has no row", () => {
  expect(html(runner({ id: "codex", login: "expired" }))).toBe("");
});

const withBedrock = (r: RunnerInfo) => renderToStaticMarkup(createElement(ClaudeLoginRow, { runner: r, region: "ap-northeast-1", onBedrock: () => undefined, onChanged: async () => undefined, onError: () => undefined }));

test("Bedrock is offered only by an explicit button, also while the Claude login has lapsed (#1730)", () => {
  const h = withBedrock(runner({ login: "expired", bedrockAvailable: true }));
  expect(h).toContain("ログアウト中");
  expect(h).toContain("Amazon Bedrock を使う");
  expect(h).toContain("Amazon Bedrock のリージョン");
  expect(withBedrock(runner({ login: "ok", loginKind: "claude.ai", bedrockAvailable: false }))).not.toContain("Amazon Bedrock を使う");
});

test("while on Bedrock the row says so and offers the way back, no login or logout (#1730)", () => {
  const h = withBedrock(runner({ login: "ok", loginKind: "bedrock", bedrockAvailable: true }));
  expect(h).toContain("使用中: サードパーティのプラットフォーム（Amazon Bedrock）");
  expect(h).toContain("Claude アカウントに戻す");
  expect(h).not.toContain("ログアウト</button>");
  expect(h).not.toContain("でログイン");
});

test("the saved region stays editable on Bedrock, and the way to Bedrock is there while the login status is unknown (#1730)", () => {
  const on = withBedrock(runner({ login: "ok", loginKind: "bedrock", bedrockAvailable: true }));
  expect(on).toContain('value="ap-northeast-1"');
  expect(on).toContain("リージョンを保存");
  const unknown = withBedrock(runner({ login: "unknown", bedrockAvailable: true }));
  expect(unknown).toContain("Amazon Bedrock を使う");
  expect(unknown).not.toContain("ログアウト");
  expect(withBedrock(runner({ login: "unknown", bedrockAvailable: false }))).toBe("");
});

test("the explanation is visible text, not only a tooltip (#1730)", () => {
  expect(withBedrock(runner({ login: "expired", bedrockAvailable: true }))).toContain("Switchboard は鍵を持ちません");
});
