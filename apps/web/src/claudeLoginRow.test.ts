import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunnerInfo } from "@switchboard/protocol";
import type { Health } from "./api/daemon.ts";
import { LoginSettings } from "./components/LoginSettings.tsx";

const runner = (r: Partial<RunnerInfo>) => ({ id: "claude", available: true, permissionModes: [], models: [], efforts: [], ...r }) as RunnerInfo;
const render = (rs: RunnerInfo[], bedrock: Record<string, { region: string }> = {}, login?: Health["login"]) =>
  renderToStaticMarkup(createElement(LoginSettings, { health: { runners: rs, login } as Health, tasks: [], bedrock, onBedrock: () => undefined, onChanged: async () => undefined, onError: () => undefined }));
const html = (r: RunnerInfo) => render([r]);

test("logged in: the kind and a logout button, no login buttons", () => {
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

test("codex has its own row with login, and dak has none", () => {
  const h = html(runner({ id: "codex", login: "expired" }));
  expect(h).toContain("Codex");
  expect(h).toContain("ログアウト中");
  expect(html(runner({ id: "dak" as RunnerInfo["id"], login: "expired" }))).not.toContain("ログアウト中");
});

test("the four rows share one shape, Switchboard first; inside the host it has no button", () => {
  const h = render([runner({ login: "ok", loginKind: "claude.ai" }), runner({ id: "codex", login: "ok" })]);
  expect([...h.matchAll(/<b class="login-who">([^<]+)<\/b>/g)].map((x) => x[1])).toEqual(["Switchboard", "Claude Code", "Codex"]);
  expect(h).toContain("このホストの中ではログイン不要");
  expect(h.match(/ログアウト<\/button>/g)).toHaveLength(2);
  expect(render([], {}, "passkey")).toContain("ログアウト</button>");
});

const withBedrock = (r: RunnerInfo) => render([r], { [r.id]: { region: "ap-northeast-1" } });

test("Bedrock is offered only by an explicit button, also while the Claude login has lapsed", () => {
  const h = withBedrock(runner({ login: "expired", bedrockAvailable: true }));
  expect(h).toContain("ログアウト中");
  expect(h).toContain("Amazon Bedrock を使う");
  expect(h).toContain("Amazon Bedrock のリージョン");
  expect(withBedrock(runner({ login: "ok", loginKind: "claude.ai", bedrockAvailable: false }))).not.toContain("Amazon Bedrock を使う");
});

test("while on Bedrock the row says so and offers the way back, no login or logout", () => {
  const h = withBedrock(runner({ login: "ok", loginKind: "bedrock", bedrockAvailable: true }));
  expect(h).toContain("使用中: サードパーティのプラットフォーム（Amazon Bedrock）");
  expect(h).toContain("Claude アカウントに戻す");
  expect(h).not.toContain("ログアウト</button>");
  expect(h).not.toContain("でログイン");
});

test("the saved region stays editable on Bedrock, and the way to Bedrock is there while the login status is unknown", () => {
  const on = withBedrock(runner({ login: "ok", loginKind: "bedrock", bedrockAvailable: true }));
  expect(on).toContain('value="ap-northeast-1"');
  expect(on).toContain("リージョンを保存");
  const unknown = withBedrock(runner({ login: "unknown", bedrockAvailable: true }));
  expect(unknown).toContain("Amazon Bedrock を使う");
  expect(unknown).not.toContain("ログアウト");
  expect(withBedrock(runner({ login: "unknown", bedrockAvailable: false }))).not.toContain("Amazon Bedrock");
});

test("the explanation is visible text, not only a tooltip", () => {
  expect(withBedrock(runner({ login: "expired", bedrockAvailable: true }))).toContain("Switchboard は鍵を持ちません");
});

test("before the health is read the Switchboard row is left out, not shown as needing no login", () => {
  const h = renderToStaticMarkup(createElement(LoginSettings, { health: null, tasks: [], bedrock: {}, onBedrock: () => undefined, onChanged: async () => undefined, onError: () => undefined }));
  expect(h).not.toContain("Switchboard");
  expect(h).not.toContain("ログイン不要");
});

test("the Bedrock switch names the runner as its row does", () => {
  const h = html(runner({ login: "ok", loginKind: "claude.ai", bedrockAvailable: true }));
  expect([...h.matchAll(/<b class="login-who">([^<]+)<\/b>/g)].map((x) => x[1])).toEqual(["Switchboard", "Claude Code", "Claude Code"]);
});

test("bedrock from the CLI: the place is named and neither the switch nor the way back is offered", () => {
  const h = render([runner({ login: "ok", loginKind: "bedrock", bedrockFrom: "cli", bedrockAvailable: true })]);
  expect(h).toContain("使用中: Amazon Bedrock（CLI の設定）");
  expect(h).toContain("CLAUDE_CODE_USE_BEDROCK");
  expect(h).not.toContain("Amazon Bedrock を使う");
  expect(h).not.toContain("Claude アカウントに戻す");
  expect(render([runner({ id: "codex", login: "ok", loginKind: "bedrock", bedrockFrom: "cli" })])).toContain("model_provider");
});

test("still on bedrock: a note with the count only when Tasks remain and the runner is no longer on Bedrock", () => {
  const note = (r: Partial<RunnerInfo>) => render([runner({ login: "ok", loginKind: "claude.ai", ...r })]);
  expect(note({ bedrockRunning: 2 })).toContain("Amazon Bedrock で始めた Task が 2 件、まだ Bedrock で動いています");
  expect(note({ bedrockRunning: 0 })).not.toContain("まだ Bedrock で動いています");
  expect(note({})).not.toContain("まだ Bedrock で動いています");
  expect(render([runner({ login: "ok", loginKind: "bedrock", bedrockFrom: "settings", bedrockRunning: 2, bedrockAvailable: true })])).not.toContain("まだ Bedrock で動いています");
  // the CLI's own Bedrock: the next Task runs on Bedrock too, so the note would be wrong
  expect(render([runner({ login: "ok", loginKind: "bedrock", bedrockFrom: "cli", bedrockRunning: 2 })])).not.toContain("まだ Bedrock で動いています");
});
