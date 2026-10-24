/** Run after bun run --cwd apps/web build: bun scripts/knowledge-e2e.ts. Requires Chrome (CHROME_BIN overrides); SCREENSHOT saves the cleanup confirmation. Uses an isolated mocked homedir, a fake runner, and real API routes. */
import { expect, mock } from "bun:test";
import * as os from "node:os";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const scratch = mkdtempSync(join(os.tmpdir(), "switchboard-knowledge-e2e-"));
const user = join(scratch, "user");
mkdirSync(user, { recursive: true });
mock.module("node:os", () => ({ ...os, homedir: () => user }));
const repoRoot = resolve(import.meta.dir, "..");
const { loadConfig } = await import(`${repoRoot}/packages/core/src/config.ts`);
const { startServer } = await import(`${repoRoot}/packages/core/src/server.ts`);
const { renderFile, contentHash } = await import(`${repoRoot}/packages/core/src/materializer.ts`);

const until = async (fn: () => any, label: string) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const r = await fn(); if (r) return r; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
};
async function verify() {
  const cfg = loadConfig({ SWITCHBOARD_HOME: join(scratch, "data"), SWITCHBOARD_KNOWLEDGE: join(scratch, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(scratch, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  const core = await startServer(cfg, [{ id: "claude", detect: async () => ({ available: true }), start() { throw new Error("unused fake runner"); } }], { port: 0, selfdevChecks: false, dryRunRestart: true });
  const base = `http://127.0.0.1:${core.server.port}`;
  const fixture = join(scratch, "repo");
  mkdirSync(fixture, { recursive: true });
  spawnSync("git", ["init", "-q", fixture]);
  const old = "# handwritten project\n" + renderFile(null, [{ source: "rules/old.md", hash: contentHash("old"), body: "old" }]);
  writeFileSync(join(fixture, "CLAUDE.md"), old);
  spawnSync("git", ["-C", fixture, "add", "CLAUDE.md"]);
  spawnSync("git", ["-C", fixture, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]);
  const post = async (path: string, data: unknown) => (await fetch(base+path, { method: "POST", headers: {"content-type":"application/json"}, body:JSON.stringify(data) })).json();
  const workspace = await post("/api/workspaces", { name: "fixture-repository", path: fixture, kind: "repo" });
  await post("/api/knowledge/doc", { path: "rules/global.md", content: "---\ntitle: Global test\ntargets: [claude, agents-md]\n---\nGLOBAL_TEST\n" });
  await post("/api/knowledge/doc", { path: "rules/scoped.md", content: `---\ntitle: Repo test\nrepo: ${fixture}\ntargets: [claude]\n---\nREPO_ONLY\n` });
  const profile = join(scratch, "chrome");
  const chromeBin = [process.env.CHROME_BIN, "/usr/local/bin/chromium", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
  if (!chromeBin) { await core.stop(); throw new Error("Chrome not found: set CHROME_BIN"); }
  const chrome = Bun.spawn([chromeBin, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  let socket: WebSocket | undefined;
  try {
    const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
    const page = await until(async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p:any) => p.type === "page"), "Chrome page");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise<void>(r => socket!.onopen = () => r());
    let seq = 0; const pending = new Map<number, (v:any)=>void>();
    socket.onmessage = e => { const m=JSON.parse(String(e.data)); if(m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
    const call = (method:string, params:any={}) => new Promise<any>((r,j)=> { const id=++seq;pending.set(id,m=>m.error?j(new Error(JSON.stringify(m.error))):r(m.result));socket!.send(JSON.stringify({id,method,params})); });
    const evaluate = async (expression:string) => {const r=await call("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const click = async (expression:string) => until(() => evaluate(`(()=>{const el=${expression};if(!el||el.disabled)return false;el.click();return true;})()`), "click");
    await call("Page.enable");
    await call("Emulation.setDeviceMetricsOverride",{width:1280,height:1400,deviceScaleFactor:1,mobile:false});
    await call("Page.navigate",{url:base});
    await click(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Knowledge')`);
    await until(() => evaluate(`document.body.textContent.includes('リポジトリ指定のルールは書き出さない')`), "repo warning");
    expect(await evaluate(`document.body.textContent.includes('取り込み')`)).toBe(false);
    expect(await evaluate(`document.querySelectorAll('.kn-mat')[0].querySelector('select') === null`)).toBe(true);
    await click(`document.querySelectorAll('.kn-mat')[0].querySelector('button.pri')`);
    await until(()=>{try{return readFileSync(join(user,".claude","CLAUDE.md"),"utf8").includes("GLOBAL_TEST");}catch{return false;}},"user apply");
    expect(readFileSync(join(user,".claude","CLAUDE.md"),"utf8")).not.toContain("REPO_ONLY");
    expect(readFileSync(join(user,".codex","AGENTS.md"),"utf8")).toContain("GLOBAL_TEST");
    expect(readFileSync(join(fixture,"CLAUDE.md"),"utf8")).toBe(old);
    const statusBefore=spawnSync("git",["-C",fixture,"status","--short"],{encoding:"utf8"}).stdout;
    expect(statusBefore).toBe("");
    await evaluate(`(()=>{const s=document.querySelector('select[aria-label="管理ブロックを外すリポジトリ"]');s.value=${JSON.stringify(workspace.id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await until(()=>evaluate(`document.querySelectorAll('.kn-mat')[1].textContent.includes('CLAUDE.md')`),"cleanup preview");
    await click(`document.querySelectorAll('.kn-mat')[1].querySelector('.mat-file button')`);
    expect(await evaluate(`document.querySelectorAll('.kn-mat')[1].querySelector('pre.diff').textContent.includes('-old')`)).toBe(true);
    await click(`document.querySelectorAll('.kn-mat')[1].querySelector('button.pri')`);
    await until(()=>evaluate(`!!document.querySelector('[role=dialog]')`),"confirmation");
    expect(readFileSync(join(fixture,"CLAUDE.md"),"utf8")).toBe(old);
    expect(await evaluate(`document.querySelector('[role=dialog] pre.diff').textContent.includes('-old')`)).toBe(true);
    if (process.env.SCREENSHOT) await Bun.write(process.env.SCREENSHOT,Buffer.from((await call("Page.captureScreenshot",{format:"png"})).data,"base64"));
    const other = join(scratch, "other-repo");
    mkdirSync(other);
    const otherWs = await post("/api/workspaces", { path: other, name: "other-fixture" });
    // Refresh workspace options, then changing the cleanup scope must invalidate its pending confirmation.
    await call("Page.reload");
    await click(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Knowledge')`);
    await until(()=>evaluate(`!!document.querySelector('select[aria-label="管理ブロックを外すリポジトリ"]')`),"reload");
    const select = async (id: string) => {
      await until(() => evaluate(`!!document.querySelector('select[aria-label="管理ブロックを外すリポジトリ"] option[value="${id}"]')`), "workspace option");
      return evaluate(`(()=>{const s=document.querySelector('select[aria-label="管理ブロックを外すリポジトリ"]');s.value=${JSON.stringify(id)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    };
    await select(workspace.id);
    await until(()=>evaluate(`document.querySelectorAll('.kn-mat')[1].textContent.includes('CLAUDE.md')`),"reload cleanup preview");
    await click(`document.querySelectorAll('.kn-mat')[1].querySelector('button.pri')`);
    await until(()=>evaluate(`!!document.querySelector('[role=dialog]')`),"confirmation after reload");
    await select(otherWs.id);
    await until(()=>evaluate(`!document.querySelector('[role=dialog]') && document.querySelectorAll('.kn-mat')[1].textContent.includes('管理ブロックは残っていません')`),"scope change invalidates confirmation");
    expect(readFileSync(join(fixture,"CLAUDE.md"),"utf8")).toBe(old);
    await select(workspace.id);
    await until(()=>evaluate(`document.querySelectorAll('.kn-mat')[1].textContent.includes('CLAUDE.md')`),"original cleanup preview");
    await click(`document.querySelectorAll('.kn-mat')[1].querySelector('button.pri')`);
    await until(()=>evaluate(`!!document.querySelector('[role=dialog]')`),"original confirmation");
    await click(`document.querySelector('[role=dialog] button.ghost')`);
    expect(readFileSync(join(fixture,"CLAUDE.md"),"utf8")).toBe(old);
    await click(`document.querySelectorAll('.kn-mat')[1].querySelector('button.pri')`);
    await click(`document.querySelector('[role=dialog] button.pri')`);
    await until(()=>readFileSync(join(fixture,"CLAUDE.md"),"utf8")==="# handwritten project\n","cleanup applied");
    expect(spawnSync("git",["-C",fixture,"status","--short"],{encoding:"utf8"}).stdout.trim()).toBe("M CLAUDE.md");
    console.log("PASS: repo warnings / no import / user-level CLAUDE+AGENTS apply / repo stays clean / deletion preview / cancel preserves file / scope change invalidates confirmation / confirmation removes only managed block / M CLAUDE.md");
  } finally { socket?.close(); chrome.kill(); await chrome.exited; await core.stop(); }
}
try { await verify(); } finally { mock.restore(); rmSync(scratch, { recursive: true, force: true }); }
