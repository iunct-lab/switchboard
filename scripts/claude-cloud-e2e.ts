/** #1114: build web first; CHROME_BIN=<Chrome> bun scripts/claude-cloud-e2e.ts.
 * Own empty DB, local Git fixtures, real Claude adapter + fake CLI. No live Cloud or authentication.
 * stdout contains only pass/fail and counts. E2E_DEBUG_FILE optionally receives assertion labels.
 */
import { scriptRecording } from "./recordings.ts";
const recordingPath = scriptRecording("packages/adapters/claude/fixtures/cloud-trust-prompt.txt");
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAdapter, Task } from "@switchboard/protocol";
import { createClaudeAdapter } from "../packages/adapters/claude/src/index.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";

const home = mkdtempSync(join(tmpdir(), "switchboard.cloud-e2e."));
let core: Awaited<ReturnType<typeof startServer>> | undefined;
let chrome: ReturnType<typeof Bun.spawn> | undefined;
let ws: WebSocket | undefined;
let cases = 0, consoleErrors = 0, pass = false, shadowStarts = 0;
const oldForce = process.env.CCR_FORCE_BUNDLE;
const oldConfigDir = process.env.CLAUDE_CONFIG_DIR;
const configDir = join(home, "claude-config"); // no .claude.json at first: folder trust is "unknown" and Cloud starts as before
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
console.log = console.info = console.warn = console.error = () => {};
const assert = (ok: unknown, label: string) => { if (!ok) throw new Error(label); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const v = await fn(); if (v) return v as NonNullable<T>; await Bun.sleep(100); }
  throw new Error(`timeout: ${label}`);
}
function git(path: string, ...args: string[]) {
  const r = Bun.spawnSync(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  assert(r.exitCode === 0, "fixture Git"); return r.stdout.toString().trim();
}
function repo(name: string, remote: boolean) {
  const path = join(home, name); mkdirSync(path); git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Fixture"); git(path, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(path, "README.md"), "fixture\n"); git(path, "add", "."); git(path, "commit", "-m", "fixture");
  if (remote) {
    git(path, "remote", "add", "origin", `https://github.com/acme/${name}.git`);
    git(path, "update-ref", "refs/remotes/origin/main", "HEAD"); git(path, "branch", "--set-upstream-to=origin/main");
    writeFileSync(join(path, "README.md"), "unpushed\n"); git(path, "commit", "-am", "unpushed fixture");
  }
  writeFileSync(join(path, "README.md"), "dirty fixture\n"); writeFileSync(join(path, "untracked.txt"), "excluded\n");
  return path;
}
const snapshot = (path: string) => [git(path, "rev-parse", "HEAD"), git(path, "status", "--porcelain"), git(path, "config", "--local", "--list"), git(path, "diff", "HEAD"), readFileSync(join(path, ".git", "index")).toString("base64"), readFileSync(join(path, "untracked.txt"), "utf8")].join("\n");
try {
  const a = repo("app", true), b = repo("other", true), unknown = repo("unknown", false);
  const before = [a, b, unknown].map(snapshot);
  const capture = join(home, "capture.jsonl"), cli = join(home, "claude");
  writeFileSync(cli, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('--version')) {console.log('2.1.293');process.exit(0);}
if(args[0]==='auth') {console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0);}
const log=(x)=>appendFileSync(${JSON.stringify(capture)},JSON.stringify(x)+'\\n');
log({args,cwd:process.cwd(),tty:[!!process.stdin.isTTY,!!process.stdout.isTTY,!!process.stderr.isTTY],force:process.env.CCR_FORCE_BUNDLE,device:process.env.DEVICE_AUTH_URL,token:process.env.DEVICE_AUTH_TOKEN_FILE,mcp:Object.keys(process.env).filter(k=>k.startsWith('SWITCHBOARD_MCP_'))});
if(args[0]==='--cloud') {
 if(args[1]==='trust') {process.stdout.write(${JSON.stringify(readFileSync(recordingPath, "utf8"))});await Bun.sleep(30000);process.exit(1);}
 const errors={deny:'permission denied on private repository',auth:'not logged in',provider:'Bedrock unsupported',policy:'allow_remote_sessions policy disabled',unsupported:'unknown argument --cloud',key:'API keys are not supported for cloud'};
 if(errors[args[1]]) {process.stderr.write(errors[args[1]]+' fixture-secret');process.exit(1);}
 const id='session_0123456789abcdefghijklmn';
 process.stdout.write('\\x1b[32mCreated cloud session: '+id+'\\nView: https://claude.ai/code/'+id+'?from=cli\\n');
 await Bun.sleep(20);process.stdout.write('Resume with: claude --teleport '+id+'\\x1b[0m\\n');process.exit(0);
}
let buf='';for await (const chunk of Bun.stdin.stream()) {buf+=new TextDecoder().decode(chunk);let n;while((n=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);if(m.type==='user') {log({localPrompt:m.message.content}); console.log(JSON.stringify({type:'system',subtype:'init',session_id:'00000000-0000-4000-8000-000000000001',cwd:process.cwd()}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'fixture reply',session_id:'00000000-0000-4000-8000-000000000001'}));process.exit(0);}}}
`);
  chmodSync(cli, 0o755);
  const other: RunnerAdapter = { id: "codex", detect: async () => ({ available: true, version: "fixture", login: "ok" }), start() { shadowStarts++; throw new Error("unexpected shadow"); } };
  process.env.CCR_FORCE_BUNDLE = "1";
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const port = Array.from({ length: 100 }, (_, i) => 47911 + i).find(p => Bun.spawnSync(["lsof", `-iTCP:${p}`, "-sTCP:LISTEN"], { stdout: "ignore", stderr: "ignore" }).exitCode === 1);
  assert(port, "free daemon port");
  core = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: home, SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_CODEX_HOME: join(home, "codex"), SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [createClaudeAdapter({ bin: cli, claudeHome: join(home, "claude-config") }), other], { port, selfdevChecks: false, gh: async () => ({ code: 1, stdout: "", stderr: "fixture" }), judge: async () => { throw new Error("fixture judge disabled"); }, rubricJudge: async () => { throw new Error("fixture rubric judge disabled"); } });
  const base = `http://127.0.0.1:${core.server.port}`;
  const post = async (path: string, body: object) => { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); assert(r.ok, "fixture API"); return r.json(); };
  const workspaces = await Promise.all([a, b, unknown].map(path => post("/api/workspaces", { path })));
  const profile = join(home, "chrome");
  chrome = Bun.spawn([process.env.CHROME_BIN ?? "/usr/local/bin/chromium", "--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1200,900", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  const debug = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome");
  const tab = await until(async () => { const tabs = await fetch(`http://127.0.0.1:${debug}/json/list`).then(r => r.json()); return tabs.find((t: { type: string }) => t.type === "page"); }, "Chrome page");
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP connect")); });
  let seq = 0;
  let holdPreparation = false, heldRequest: string | undefined;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = event => { const m = JSON.parse(String(event.data)); if (m.method === "Fetch.requestPaused") { const request = m.params; if (holdPreparation && !heldRequest && request.request.postData?.includes(workspaces[0].id)) heldRequest = request.requestId; else void call("Fetch.continueRequest", { requestId: request.requestId }).catch(() => consoleErrors++); } if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p?.reject(new Error("CDP command")); else p?.resolve(m.result); } if (m.method === "Log.entryAdded" && m.params.entry.source === "security") consoleErrors++; if (m.method === "Runtime.exceptionThrown" || m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrors++; };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout")); }, 15000); pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => { const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); assert(!r.exceptionDetails, "browser evaluation"); return r.result?.value; };
  const set = async (selector: string, value: string) => assert(await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return true;})()`), "set input");
  const click = async (selector: string) => assert(await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.click();return true;})()`), "click once");
  const homePage = async () => { await call("Page.navigate", { url: base }); await until(() => evaluate(`!!document.querySelector('.compose [aria-label="実行場所"]') && !!document.querySelector('.fields select option[value="${workspaces[0].id}"]')`), "Home and Workspace options"); };
  const entries = () => { try { return readFileSync(capture, "utf8").trim().split("\n").map(l => JSON.parse(l)); } catch { return []; } };
  const latest = () => core!.db.listTasks().sort((x, y) => y.createdAt - x.createdAt)[0];
  await call("Runtime.enable");
  await call("Log.enable"); await homePage();
  assert(await evaluate(`document.querySelector('[aria-label="実行場所"]').value==='local'`), "Local default");
  await until(() => evaluate(`!!document.querySelector('[aria-label="承認モード"] option[value="plan"]')`), "runner modes loaded");
  await set(".fields select", workspaces[0].id); await set(".compose textarea", "local fixture"); await set('[aria-label="承認モード"]', "plan"); await click(".compose button.pri");
  await until(() => entries().some(e => e.localPrompt && JSON.stringify(e.localPrompt).includes("local fixture")), "Local prompt");
  const local = entries().find(e => e.args?.includes("plan"));
  assert(local && local.cwd === a && local.args.includes("--input-format") && local.args.includes("plan") && local.force === "1" && local.device && local.token && entries().some(e => e.localPrompt && JSON.stringify(e.localPrompt).includes("local fixture")), "Local cwd/options/prompt"); cases++;
  // A saved Local shadow choice must never leak into Cloud.
  core.db.setSetting("settings", { shadowRunner: "codex", judge: { enabled: false } });
  for (const width of [1200, 390]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: width === 390 });
    for (const [index, prompt] of [[0, "app-none"], [1, "web-setup-fixture"], [2, "unknown-remote"]] as const) {
      await homePage(); await set('[aria-label="実行場所"]', "cloud"); await set(".compose textarea", prompt);
      assert(await evaluate(`document.querySelector('.compose button.pri').disabled`), "Cloud requires Workspace");
      await set(".fields select", workspaces[index].id);
      await until(() => evaluate(`document.querySelector('.compose').textContent.includes('Bundle')`), "transfer notice");
      if (index !== 2) await until(() => evaluate(`document.querySelector('.compose').textContent.includes(${JSON.stringify(index === 0 ? "acme/app" : "acme/other")})`), "current Git preparation");
      assert(await evaluate(`!document.querySelector('[aria-label="承認モード"]') && document.querySelector('.compose').textContent.includes('未追跡')`), "Cloud options and untracked notice");
      const count = core.db.listTasks().length; await click(".compose button.pri");
      const task = await until(() => { const t = latest(); return core!.db.listTasks().length > count && t?.cloudSession && t.status === "idle" && t; }, "Cloud idle reference") as Task;
      assert(task.outcome === "unknown" && task.runnerSessionId === null && task.shadowOf === null, "Cloud not Done / Local resume / shadow");
      await until(() => evaluate(`!!document.querySelector('.cloud-session a')`), "official link");
      assert(await evaluate(`(() => {const e=document.querySelector('.cloud-session a');const r=e.getBoundingClientRect();return e.href==='https://claude.ai/code/session_0123456789abcdefghijklmn'&&e.rel.includes('noopener')&&e.rel.includes('noreferrer')&&!document.querySelector('.composer')&&r.left>=0&&r.right<=innerWidth;})()`), "mobile link / no Local composer");
      const captured = entries().filter(e => e.args?.[0] === "--cloud").at(-1);
      assert(JSON.stringify(captured.args) === JSON.stringify(["--cloud", prompt]) && captured.cwd === [a,b,unknown][index] && captured.tty.every(Boolean) && !captured.force && !captured.device && !captured.token && captured.mcp.length === 0, "Cloud PTY/argv/env"); cases++;
    }
  }
  for (const [prompt, help] of [["deny", "/web-setup"], ["auth", "claude auth login"], ["provider", "外部 provider"], ["policy", "管理者"], ["unsupported", "更新"], ["key", "APIキー"]]) {
    await homePage(); await set('[aria-label="実行場所"]', "cloud"); await set(".fields select", workspaces[0].id); await set(".compose textarea", prompt);
    const count = core.db.listTasks().length; await click(".compose button.pri");
    await until(() => core!.db.listTasks().length > count && latest()?.status === "error", "Cloud error");
    await until(() => evaluate(`document.querySelector('.main')?.textContent.includes(${JSON.stringify(help)})`), "error view");
    assert(latest().cloudSession === null && latest().outcome === "unknown", "error is unconfirmed");
    assert(!await evaluate(`document.body.textContent.includes('fixture-secret')`), "raw error redacted"); cases++;
  }
  // Folder trust (#1288): the guidance shows before Start for a known-untrusted folder, no CLI is started, nothing is written.
  const cloudStarts = () => entries().filter(e => e.args?.[0] === "--cloud").length;
  const guidance = (path: string) => `このフォルダ（${path}）は Claude Code でまだ信頼されていないため`;
  mkdirSync(configDir, { recursive: true });
  const configFile = join(configDir, ".claude.json");
  const untrustedConfig = JSON.stringify({ projects: { "/somewhere/else": { hasTrustDialogAccepted: true } } });
  writeFileSync(configFile, untrustedConfig);
  await homePage(); await set('[aria-label="実行場所"]', "cloud"); await set(".fields select", workspaces[0].id); await set(".compose textarea", "untrusted fixture");
  await until(() => evaluate(`document.querySelector('.compose').textContent.includes(${JSON.stringify(guidance(a))})`), "guidance before Start");
  let starts = cloudStarts(), count = core.db.listTasks().length; await click(".compose button.pri");
  await until(() => core!.db.listTasks().length > count && latest()?.status === "error", "untrusted Cloud error");
  await until(() => evaluate(`document.querySelector('.main')?.textContent.includes(${JSON.stringify(guidance(a))})`), "guidance on the Task");
  assert(cloudStarts() === starts && readFileSync(configFile, "utf8") === untrustedConfig, "untrusted: no CLI start, config unchanged"); cases++;
  writeFileSync(configFile, JSON.stringify({ projects: { [a]: { hasTrustDialogAccepted: true } } }));   // approved by the person in their own terminal
  await homePage(); await set('[aria-label="実行場所"]', "cloud"); await set(".fields select", workspaces[0].id); await set(".compose textarea", "after approval");
  await until(() => evaluate(`document.querySelector('.compose').textContent.includes('Bundle')`), "preparation after approval");
  assert(await evaluate(`!document.querySelector('.compose').textContent.includes(${JSON.stringify(guidance(a))})`), "no guidance once trusted");
  starts = cloudStarts(); count = core.db.listTasks().length; await click(".compose button.pri");
  await until(() => { const t = latest(); return core!.db.listTasks().length > count && t?.cloudSession && t.status === "idle"; }, "Cloud creation passes after approval");
  assert(cloudStarts() === starts + 1, "trusted: CLI started"); cases++;
  rmSync(configFile);   // unknown: starts, and the CLI's own dialog is stopped with the same guidance
  await homePage(); await set('[aria-label="実行場所"]', "cloud"); await set(".fields select", workspaces[0].id); await set(".compose textarea", "trust");
  starts = cloudStarts(); count = core.db.listTasks().length; await click(".compose button.pri");
  await until(() => core!.db.listTasks().length > count && latest()?.status === "error", "trust dialog stop");
  await until(() => evaluate(`document.querySelector('.main')?.textContent.includes(${JSON.stringify(guidance(a))})`), "guidance after dialog");
  assert(cloudStarts() === starts + 1, "unknown: CLI started"); cases++;
  // Release an older read-only preparation response after the new Workspace's response.
  await homePage(); await set('[aria-label="実行場所"]', "cloud"); await set(".compose textarea", "workspace race");
  await call("Fetch.enable", { patterns: [{ urlPattern: "*/api/tasks/suggest", requestStage: "Request" }] });
  holdPreparation = true; await set(".fields select", workspaces[0].id);
  await until(() => heldRequest, "old preparation held"); await set(".fields select", workspaces[1].id);
  await until(() => evaluate(`document.querySelector('.compose').textContent.includes('acme/other')`), "new Workspace response");
  await call("Fetch.fulfillRequest", { requestId: heldRequest, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify({ runner: "claude", available: true, reason: "fixture", cloudPreparation: { repository: "stale-poison", branch: "main", dirty: false, unpushed: false, warnings: ["fixture"] } })).toString("base64") });
  await Bun.sleep(300);
  assert(await evaluate(`document.querySelector('.compose').textContent.includes('acme/other') && !document.querySelector('.compose').textContent.includes('stale-poison')`), "stale preparation ignored");
  holdPreparation = false; await call("Fetch.disable"); cases++;
  await click('input[name="runner"][value="codex"]');
  await until(() => evaluate(`!document.querySelector('[aria-label="実行場所"]')`), "runner changed"); await click('input[name="runner"][value="claude"]');
  await until(() => evaluate(`document.querySelector('[aria-label="実行場所"]')?.value==='local'`), "runner reset Local"); cases++;
  assert(shadowStarts === 0 && JSON.stringify(before) === JSON.stringify([a,b,unknown].map(snapshot)), "Git unchanged / no shadow");
  assert(consoleErrors === 0, "console errors"); pass = true;
} catch (e) {
  if (process.env.E2E_DEBUG_FILE) writeFileSync(process.env.E2E_DEBUG_FILE, e instanceof Error ? e.message : "assertion failed");
  process.exitCode = 1;
} finally {
  ws?.close(); chrome?.kill(); if (chrome) await chrome.exited; if (core) await core.stop();
  if (oldForce === undefined) delete process.env.CCR_FORCE_BUNDLE; else process.env.CCR_FORCE_BUNDLE = oldForce;
  if (oldConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldConfigDir;
  rmSync(home, { recursive: true, force: true });
  Object.assign(console, originalConsole);
  console.log(JSON.stringify({ result: pass ? "pass" : "fail", cases, consoleErrors }));
}
