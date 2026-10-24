/**
 * Run after `bun run --cwd apps/web build`: bun scripts/runner-login-e2e.ts. Requires Chrome (CHROME_BIN overrides).
 * #354: a runner whose login ran out shows "ログインする"; codex relays its device URL and code and the banner goes away
 * once the (fake) approval lands; claude offers a box for its page's code. Fake CLIs only — never a real login.
 * SCREENSHOT=<file.png> saves the banner with both logins open.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAdapter } from "@switchboard/protocol";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";

const home = mkdtempSync(join(tmpdir(), "sb-runner-login-e2e-"));
const flag = (r: string) => join(home, `${r}.loggedin`);
const cli = (name: string, body: string) => {
  const p = join(home, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
// codex: device URL and code, "approved" after 3 s; claude: URL, the prompt, the code on stdin
const codex = cli("codex", `printf '1. Open\\n   \\033[94mhttps://auth.example/codex/device\\033[0m\\n2. Enter this one-time code\\n   \\033[94mQ7RT-4KXPZ\\033[0m\\n'\nsleep 3\ntouch "${flag("codex")}"\nexit 0`);
const claude = cli("claude", `echo "If the browser didn't open, visit: https://claude.example/oauth/authorize?code=true"\nprintf "Paste code here if prompted > "\nread code\n[ "$code" = "good-code" ] || exit 1\ntouch "${flag("claude")}"\nexit 0`);
const adapter = (id: "claude" | "codex", bin: string): RunnerAdapter => ({
  id,
  loginArgs: [],
  async detect() {
    return { available: true, version: "fake", path: bin, login: existsSync(flag(id)) ? "ok" : "expired", loginHint: `${id} login` };
  },
  start() {
    throw new Error("no runs");
  },
});
const core = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [adapter("claude", claude), adapter("codex", codex)], { port: 0, selfdevChecks: false });
const base = `http://127.0.0.1:${core.server.port}`;
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
async function until<T>(fn: () => T | Promise<T>, label: string, ms = 20_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v as NonNullable<T>; await Bun.sleep(100); }
  throw new Error(`Timeout: ${label}`);
}
const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1200,900", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const tabs = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
  ws = new WebSocket(tabs.find((t) => t.type === "page")!.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, (v: any) => void>();
  const errors: string[] = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { pending.get(m.id)?.(m.result); pending.delete(m.id); }
    if (m.method === "Log.entryAdded" && m.params.entry.source === "security") errors.push(JSON.stringify(m.params));
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(m.params).slice(0, 200));
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
  const clickIn = (runner: string, label: string) => evaluate(`(() => { const b = [...document.querySelectorAll('.login-expired')].find(x => x.textContent.startsWith(${JSON.stringify(runner)})); const btn = b && [...b.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!btn || btn.disabled) return false; btn.click(); return true; })()`);
  await call("Runtime.enable");
  await call("Log.enable");
  await call("Page.navigate", { url: base });
  await until(() => evaluate(`document.querySelectorAll('.login-expired').length === 2`), "two banners");
  await until(() => clickIn("codex", "ログインする"), "codex ログインする");
  await until(() => clickIn("claude", "ログインする"), "claude ログインする");
  const codexShown = await until(() => evaluate(`(() => { const b = [...document.querySelectorAll('.login-expired')].find(x => x.textContent.startsWith('codex')); return b && b.querySelector('.device-code')?.textContent === 'Q7RT-4KXPZ' && b.querySelector('a.button')?.href === 'https://auth.example/codex/device'; })()`), "codex code and link");
  const claudeBox = await until(() => evaluate(`(() => { const b = [...document.querySelectorAll('.login-expired')].find(x => x.textContent.startsWith('claude')); return !!b?.querySelector('input') && b.querySelector('a.button')?.href.startsWith('https://claude.example/'); })()`), "claude box and link");
  if (process.env.SCREENSHOT) await Bun.write(process.env.SCREENSHOT, Buffer.from((await call("Page.captureScreenshot", { format: "png" })).data, "base64"));
  // claude: paste the code (the input is React-controlled: set it through the native setter)
  await evaluate(`(() => { const b = [...document.querySelectorAll('.login-expired')].find(x => x.textContent.startsWith('claude')); const i = b.querySelector('input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'good-code'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(() => clickIn("claude", "送る"), "claude 送る");
  // both banners go: codex once its fake approval lands, claude once the code went through
  await until(() => evaluate(`document.querySelectorAll('.login-expired').length === 0`), "banners gone", 30_000);
  const health = (await (await fetch(`${base}/api/health`)).json()) as { runners: Array<{ id: string; login?: string }> };
  assert(health.runners.every((r) => r.login === "ok"), `health: ${JSON.stringify(health.runners)}`);
  assert(!errors.length, `console errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify({ codexShown, claudeBox, bannersGone: true, logins: health.runners.map((r) => `${r.id}:${r.login}`), consoleErrors: errors.length }));
} finally {
  ws?.close();
  chrome.kill();
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
