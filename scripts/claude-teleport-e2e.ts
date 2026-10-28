/** #1132 / #1306: isolated Git/history/config, real daemon + PTY + headless Chrome + fake CLI.
 * Build web first. No live Cloud, credentials or production daemon. Debug output contains assertion labels only. */
import { scriptRecording } from "./recordings.ts";
const recordingPath = scriptRecording("packages/adapters/claude/fixtures/teleport-session.jsonl");
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "../packages/adapters/claude/src/index.ts";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
const home = mkdtempSync(join(tmpdir(), "switchboard.teleport-e2e."));
let core: Awaited<ReturnType<typeof startServer>> | undefined;
let chrome: ReturnType<typeof Bun.spawn> | undefined, ws: WebSocket | undefined;
let cases = 0, consoleErrors = 0, pass = false, cloudTitle = "";
const savedEnv = { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
const gitBin = Bun.which("git")!;
const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
console.log = console.info = console.warn = console.error = () => {};
const assert = (ok: unknown, label: string) => { if (!ok) throw new Error(label); };
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const v = await fn(); if (v) return v as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`timeout: ${label}`);
}
function git(path: string, ...args: string[]) {
  const r = Bun.spawnSync([gitBin, "-C", path, ...args], { stdout: "pipe", stderr: "pipe" });
  assert(r.exitCode === 0, "fixture Git"); return r.stdout.toString().trim();
}
try {
  const repo = join(home, "repo"), projects = join(home, "claude-config", "projects"), pdir = join(projects, "fixture");
  const configDir = join(home, "claude-config"), globalGit = join(home, "global-gitconfig");
  mkdirSync(configDir, { recursive: true }); writeFileSync(join(configDir, "settings.json"), '{"permissions":{"defaultMode":"default"}}\n');
  writeFileSync(globalGit, "[user]\n  name = Fixture\n  email = fixture@example.invalid\n");
  process.env.CLAUDE_CONFIG_DIR = configDir; process.env.GIT_CONFIG_GLOBAL = globalGit; process.env.GIT_CONFIG_NOSYSTEM = "1";
  mkdirSync(repo); mkdirSync(pdir, { recursive: true }); git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(repo, "README.md"), "fixture\n"); git(repo, "add", "."); git(repo, "commit", "-m", "fixture");
  git(repo, "remote", "add", "origin", "https://github.com/acme/fixture.git");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD"); git(repo, "branch", "--set-upstream-to=origin/main");
  writeFileSync(join(repo, "README.md"), "dirty fixture\n"); writeFileSync(join(repo, "untracked.txt"), "collision\n");
  const settingsSnapshot = (dir = configDir): unknown[] => readdirSync(dir, { withFileTypes: true }).filter(f => dir !== configDir || f.name !== "projects").sort((a,b) => a.name.localeCompare(b.name)).map(f => [f.name, f.isDirectory() ? settingsSnapshot(join(dir, f.name)) : readFileSync(join(dir, f.name)).toString("base64")]);
  const snapshot = () => [git(repo, "rev-parse", "HEAD"), git(repo, "symbolic-ref", "HEAD"), git(repo, "for-each-ref", "--format=%(refname) %(objectname)"), git(repo, "status", "--porcelain"), git(repo, "config", "--local", "--list"), git(repo, "diff", "HEAD"), readFileSync(join(repo, ".git", "index")).toString("base64"), readFileSync(join(repo, "untracked.txt"), "utf8"), JSON.stringify(settingsSnapshot()), readFileSync(globalGit, "utf8")].join("\n");
  const before = snapshot(), capture = join(home, "capture.jsonl"), mode = join(home, "mode"), help = join(home, "help"), target = join(home, "target"), cli = join(home, "claude");
  const cloudId = "session_0123456789abcdefghijklmn", wrongCloud = "session_9999999999abcdefghijklmn", uuid = "11111111-1111-4111-8111-111111111111";
  const fixture = readFileSync(recordingPath, "utf8").replaceAll("/work/repo", repo);
  const fixtureFile = join(home, "fixture.jsonl"); writeFileSync(fixtureFile, fixture);
  writeFileSync(mode, "ok"); writeFileSync(help, "id"); writeFileSync(target, cloudId);
  const binDir = join(home, "bin"); mkdirSync(binDir);
  writeFileSync(join(binDir, "git"), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);const operations=['fetch','checkout','switch','stash','reset','clean','commit','push','restore','pull','rebase'];
appendFileSync(${JSON.stringify(capture)},JSON.stringify({gitCall:true,gitChange:operations.find(op=>args.includes(op))??null})+'\\n');
const p=Bun.spawn([${JSON.stringify(gitBin)},...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit'});process.exit(await p.exited);
`); chmodSync(join(binDir, "git"), 0o755); process.env.PATH = binDir + ":" + (savedEnv.PATH ?? "");
  writeFileSync(cli, `#!${process.execPath}\nimport {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2), get=p=>readFileSync(p,'utf8').trim();if(JSON.parse(get(${JSON.stringify(join(configDir, 'settings.json'))})).permissions.defaultMode!=='default')throw Error('fixture settings changed');const log=x=>appendFileSync(${JSON.stringify(capture)},JSON.stringify(x)+'\\n');
if(args.includes('--version')) {console.log('2.1.334');process.exit(0);}
if(args[0]==='auth') {console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));process.exit(0);}
if(args[0]==='--help') {console.log(get(${JSON.stringify(help)})==='unsupported'?'Usage':get(${JSON.stringify(help)})==='picker'?'--teleport Resume':'--teleport [session] Resume');process.exit(0);}
log({args,cwd:process.cwd(),tty:!!process.stdin.isTTY});
if(args[0]==='--cloud') {const id=args[1]==='fixture'?'session_conflictingabcdefghijklmn':'${cloudId}';console.log('Created cloud session: '+id);console.log('View: https://claude.ai/code/'+id);console.log('Resume with: claude --teleport '+id);process.exit(0);}
if(args[0]==='--teleport') {
 const m=get(${JSON.stringify(mode)}), errors={unpushed:'branch is not pushed',repo:'repository mismatch',account:'account mismatch',permission:'permission denied',provider:'Bedrock unsupported',subscription:'API keys are not supported'};
 if(errors[m]) {console.log(errors[m]);process.exit(1);}
 console.log(m==='wrong-cloud'?'${wrongCloud}':get(${JSON.stringify(target)}));
 const rd=Bun.stdin.stream().getReader(), read=async()=>new TextDecoder().decode((await rd.read()).value??new Uint8Array());
 // Like the real CLI (#1865): after resuming it waits for input. The resumed conversation is logged, and /exit prints the
 // evidence, only once the session has recorded an entry (/rename); /exit alone ends with neither. ok = no question; prompt = asks first.
 let pend='';const line=async()=>{while(!pend.includes('\\n'))pend+=(await read()).replace(/\\r/g,'\\n');const i=pend.indexOf('\\n'),l=pend.slice(0,i);pend=pend.slice(i+1).replace(/^\\n+/,'');return l;};
 const resumedThenExit=async()=>{console.log('Session resumed');let named=false;for(;;){const raw=await line();log({stdin:raw});
  if(raw.startsWith('/rename ')){named=true;console.log('Session renamed to: '+raw.slice(8));continue;}
  if(raw.trim()!=='/exit'){console.log('Unexpected input');process.exit(1);}
  if(named){console.log('claude --resume ${uuid}');writeFileSync(${JSON.stringify(join(pdir, `${uuid}.jsonl`))},readFileSync(${JSON.stringify(fixtureFile)}));}process.exit(0);}};
 if(m==='ok') await resumedThenExit();
 console.log('Fixture approval: dirty/untracked collision; type y or n');
 const answer=(await read()).trim();log({answer});
 if(answer!=='y') {console.log('Cancelled');process.exit(1);}
 if(m==='prompt') await resumedThenExit();
 console.log('Session resumed');
 if(m!=='unknown')console.log('claude --resume '+(m==='wrong-uuid'?'22222222-2222-4222-8222-222222222222':'${uuid}'));
 process.exit(0);
}
let buf='';for await(const chunk of Bun.stdin.stream()){buf+=new TextDecoder().decode(chunk);let n;while((n=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);if(m.type==='user'){log({prompt:m.message.content});if(JSON.stringify(m.message.content).includes('HOLD')){while(!(await Bun.file(${JSON.stringify(join(home, 'release'))}).exists()))await Bun.sleep(50);}console.log(JSON.stringify({type:'system',subtype:'init',session_id:'${uuid}',cwd:process.cwd()}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'fixture resumed reply',session_id:'${uuid}'}));process.exit(0);}}}
`);
  chmodSync(cli, 0o755);
  const adapter = createClaudeAdapter({ bin: cli, claudeHome: join(home, "claude-config") });
  const port = Array.from({ length: 100 }, (_, i) => 47911 + i).find(p => Bun.spawnSync(["lsof", `-iTCP:${p}`, "-sTCP:LISTEN"], { stdout: "ignore", stderr: "ignore" }).exitCode === 1);
  assert(port, "free daemon port");
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: home, SWITCHBOARD_CLAUDE_PROJECTS: projects, SWITCHBOARD_CODEX_HOME: join(home, "codex"), SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  const boot = () => startServer(cfg, [adapter], { port, selfdevChecks: false, gh: async () => ({ code: 1, stdout: "", stderr: "fixture" }), judge: async () => { throw new Error("fixture judge disabled"); }, rubricJudge: async () => { throw new Error("fixture rubric judge disabled"); } });
  core = await boot();
  const base = `http://127.0.0.1:${core.server.port}`;
  const post = async (path: string, body: object) => { const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); assert(r.ok, "fixture API"); return r.json(); };
  const workspace = await post("/api/workspaces", { path: repo });
  const profile = join(home, "chrome");
  chrome = Bun.spawn([process.env.CHROME_BIN ?? "/usr/local/bin/chromium", "--headless=new", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1200,900", "about:blank"], { stdout: "ignore", stderr: "ignore" });
  const debug = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome");
  const tab = await until(async () => { const tabs = await fetch(`http://127.0.0.1:${debug}/json/list`).then(r => r.json()); return tabs.find((t: { type: string }) => t.type === "page"); }, "Chrome page");
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws!.onopen = () => resolve(); ws!.onerror = () => reject(new Error("CDP connect")); });
  let seq = 0, ptyConnected = 0;
  const ptySockets = new Set<string>();
  const pending = new Map<number, { resolve: (value: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = event => { const m = JSON.parse(String(event.data)); if (m.method === "Network.webSocketCreated" && m.params.url.includes("/ws/pty")) ptySockets.add(m.params.requestId); if (m.method === "Network.webSocketHandshakeResponseReceived" && ptySockets.has(m.params.requestId) && m.params.response.status === 101) ptyConnected++;  if (m.id) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p?.reject(new Error("CDP command")); else p?.resolve(m.result); } if (m.method === "Log.entryAdded" && m.params.entry.source === "security") consoleErrors++; if (m.method === "Runtime.exceptionThrown" || m.method === "Runtime.consoleAPICalled" && m.params.type === "error") consoleErrors++; };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error("CDP timeout")); }, 15000); pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => { const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); assert(!r.exceptionDetails, "browser evaluation"); return r.result?.value; };
  const set = async (selector: string, value: string) => assert(await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e)return false;Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return true;})()`), "set input");
  const click = async (selector: string) => assert(await evaluate(`(() => {const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return false;e.click();return true;})()`), `click once: ${selector}`);
  const homePage = async () => { await call("Page.navigate", { url: base }); await until(() => evaluate(`!!document.querySelector('.compose [aria-label="実行場所"]') && !!document.querySelector('.fields select option[value="${workspace.id}"]')`), "Home and Workspace options"); };
  const entries = () => { try { return readFileSync(capture, "utf8").trim().split("\n").map(l => JSON.parse(l)); } catch { return []; } };
  let expectedSpawns = 0;
  const teleportEntries = () => entries().filter(e => e.args?.[0] === "--teleport");
  // Observe past the public-help timeout plus fixture startup; a handshake alone precedes CLI output.
  const quiet = async (count: number) => {
    const end = Date.now() + 6000;
    do { assert(teleportEntries().length === count && entries().every(e => !e.gitChange), "no delayed Teleport or Git mutation"); await Bun.sleep(50); } while (Date.now() < end);
  };
  const clickText = async (text: string, twice = false) => assert(await evaluate(`(() => {const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)return false;e.click();${twice ? "e.click();" : ""}return true;})()`), `click text: ${text}`);
  const openCloud = async (title = cloudTitle) => {
    await call("Page.navigate", { url: base });
    await until(() => evaluate(`!![...document.querySelectorAll('.rail button')].find(e=>e.title.startsWith(${JSON.stringify(title)}))`), "Cloud in rail");
    await click(`.rail button[title^=${JSON.stringify(title)}]`);
    await until(() => evaluate(`!!document.querySelector('.cloud-session')`), "Cloud detail");
  };
  const terminalText = () => evaluate(`document.querySelector('.terminal')?.textContent??''`);
  const terminalInput = async (answer: string) => {
    await click(".terminal .xterm-helper-textarea");
    await call("Input.insertText", { text: answer });
    await call("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await call("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };
  // The progress the Cloud screen shows (#1306); the status events count how many Teleports have finished for a Task.
  const progressText = (): Promise<string> => evaluate(`document.querySelector('.cloud-session [data-testid="teleport-progress"]')?.textContent??''`);
  const statusCount = (id: string) => core!.db.listEvents(id).filter(e => e.ev.t === "status" && !e.ev.text.startsWith("作業コピー ")).length; // the start notice is not an end
  const inputs = () => entries().filter(e => e.answer !== undefined || e.stdin !== undefined).length;
  let watched = "", statusBefore = 0, cloudTaskId = "", inputsBefore = 0;
  const cloudId2task = () => cloudTaskId;
  const start = async (m: string, h = "id") => {
    writeFileSync(mode, m); writeFileSync(help, h); writeFileSync(target, cloudId); await openCloud();
    watched = cloudId2task(); statusBefore = statusCount(watched); inputsBefore = inputs();
    const count = teleportEntries().length; expectedSpawns = count + (h === "unsupported" ? 0 : 1); await clickText("ローカルで続ける", true);
    if (h !== "unsupported") await until(() => teleportEntries().length === count + 1, "one explicit Teleport");
    return count;
  };
  // Done when the daemon recorded the end (record and progress are one synchronous step) and the screen shows that end.
  const ended = async (onCloudScreen = true) => {
    await until(() => statusCount(watched) > statusBefore, "Teleport finished");
    const t = (await fetch(`${base}/api/tasks/${watched}`).then(r => r.json())).teleport;
    if (onCloudScreen) await until(async () => (await progressText()).includes(t.phase === "done" ? "取込みを確認しました" : t.message), "end shown on the Cloud screen");
    assert(snapshot() === before && entries().every(e => !e.gitChange), "Git/branch/refs/config unchanged, no mutating Git command"); assert(teleportEntries().length === expectedSpawns, "no delayed double spawn");
  };
  /** The CLI asked: the screen shows the question without answering it, then the person answers in the terminal tab. */
  const answerInTerminal = async (text: string) => {
    await until(() => evaluate(`!![...document.querySelectorAll('.cloud-session button')].find(e=>e.textContent.trim()==='ターミナルで答える')`), "question with the terminal link");
    assert((await progressText()).includes("Fixture approval"), "the CLI's question is shown");
    assert(inputs() === inputsBefore && snapshot() === before, "no automatic answer, Git unchanged");
    await clickText("ターミナルで答える");
    await until(async () => (await terminalText()).includes("Fixture approval"), "terminal shows the question");
    await terminalInput(text);
  };
  const localScreen = () => until(() => evaluate(`!!document.querySelector('.composer textarea') && document.querySelector('.main').textContent.includes('元Cloud Taskを開く')`), "Local Task conversation screen");
  const openLocalByLink = async () => {
    await until(() => evaluate(`!![...document.querySelectorAll('.cloud-session button')].find(e=>e.textContent.startsWith('ローカルの Task:'))`), "Local link");
    await evaluate(`[...document.querySelectorAll('.cloud-session button')].find(e=>e.textContent.startsWith('ローカルの Task:')).click()`);
    await localScreen();
  };
  const backToCloudFromHead = async () => {
    await evaluate(`[...document.querySelectorAll('.task-head button')].find(e=>e.textContent.trim()==='元Cloud Taskを開く').click()`);
    await until(() => evaluate(`!!document.querySelector('.cloud-session') && !document.querySelector('.composer textarea')`), "back to the Cloud Task from the head");
  };
  // #1634: right after the automatic switch, the head's switch line names the Cloud Task and is in the viewport without scrolling.
  const switchedVisible = () => evaluate(`(() => { const e = document.querySelector('.task-head .switched-from-cloud'); if (!e) return false; const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && e.textContent.includes(${JSON.stringify(cloudTitle)}); })()`);
  await call("Network.enable");
  await call("Runtime.enable");
  await call("Log.enable"); await homePage();
  await until(() => evaluate(`!!document.querySelector('[aria-label="承認モード"] option[value="plan"]')`), "runner modes loaded");
  await set('[aria-label="実行場所"]', "cloud"); await set(".fields select", workspace.id);
  await set(".compose textarea", "cloud fixture"); await until(() => evaluate(`!!document.querySelector(".compose button.pri") && !document.querySelector(".compose button.pri").disabled`), "Cloud preparation"); await click(".compose button.pri");
  const cloud = await until(() => core!.db.listTasks().find(t => t.executionMode === "cloud" && t.status === "idle" && t.cloudSession), "Cloud launcher ended");
  cloudTitle = cloud.title; cloudTaskId = cloud.id;
  // #1395: the continuation runs in its own worktree; the fake CLI's history is written with that cwd.
  const wc = join(realpathSync(repo), ".claude", "worktrees", `teleport-${cloud.id}`);
  writeFileSync(fixtureFile, fixture.replaceAll(repo, wc));
  await until(() => evaluate(`!!document.querySelector('.cloud-session a')`), "Cloud reference");
  assert(teleportEntries().length === 0 && snapshot() === before && cloud.runnerSessionId === null, "launcher exit has no Teleport/Git effect"); cases++;
  const connectedBefore = ptyConnected; await clickText("ターミナル"); await until(() => ptyConnected > connectedBefore, "reserved Terminal connected");
  await quiet(0); assert(teleportEntries().length === 0, "Terminal tab alone reserves only");
  await openCloud(); assert(teleportEntries().length === 0, "reload does not start"); cases++;
  // No question: the daemon ends the CLI itself and the Local Task opens, with no terminal input at all.
  const connectedBeforeOk = ptyConnected, okCount = await start("ok");
  const seen: string[] = [];
  const sample = setInterval(() => { void progressText().then(t => { if (t && seen.at(-1) !== t) seen.push(t); }).catch(() => undefined); }, 50);
  try { await localScreen(); } finally { clearInterval(sample); }
  await until(switchedVisible, "switch line visible without scrolling"); cases++;
  // Moving away inside the app (no reload) clears it: back to Cloud from the head, then the Local Task again by its link.
  await backToCloudFromHead(); await clickText("Local Taskを確認"); await openLocalByLink();
  await until(() => evaluate(`document.querySelector('.task-head').textContent.includes('Cloudから取込み')`), "the head's mark after reopening");
  assert(!(await evaluate(`!!document.querySelector('.switched-from-cloud')`)), "switch line gone after moving away in the app"); cases++;
  assert(teleportEntries().length === okCount + 1 && JSON.stringify(teleportEntries().at(-1).args) === JSON.stringify(["--teleport", cloudId]) && teleportEntries().at(-1).cwd === wc && teleportEntries().at(-1).tty, "ID/worktree cwd/PTY exact");
  const inTeleport = seen.findIndex(t => t.includes("Teleport中")), inImport = seen.findIndex(t => t.includes("取込み中"));
  assert(inTeleport >= 0 && inImport > inTeleport, "progress moves from Teleport中 to 取込み中");
  assert(JSON.stringify(entries().filter(e => e.stdin !== undefined).map(e => e.stdin)) === JSON.stringify(["/rename continued-from-cloud", "/exit"]) && entries().every(e => e.answer === undefined), "the CLI received /rename and /exit only");
  assert(ptyConnected === connectedBeforeOk, "the terminal tab was never opened");
  await ended(false);
  const local = await until(() => core!.db.listLocalTasksForCloud(cloud.id)[0], "linked Local");
  const events = core.db.listEvents(local.id), messages = events.filter(e => e.ev.t === "message.delta");
  assert(local.runnerSessionId === uuid && messages.some(e => e.ev.t === "message.delta" && e.ev.text.includes("リポジトリの構成")) && messages.some(e => e.ev.t === "message.delta" && e.ev.text.includes("どうぞ")), "full earlier/final conversation");
  assert(await evaluate(`document.querySelector('.transcript').textContent.includes('リポジトリの構成') && document.querySelector('.transcript').textContent.includes('どうぞ')`), "history on the Local screen"); cases++;
  const eventCount = events.length, tokens = core.db.taskCost(local.id).tokens;
  await openCloud(); await clickText("Local Taskを確認");
  await until(() => evaluate(`!![...document.querySelectorAll('.cloud-session button')].find(e=>e.textContent.startsWith('ローカルの Task:'))`), "Local link");
  assert(await evaluate(`document.querySelector('.cloud-session').textContent.includes('自動同期しません')`), "no Cloud sync notice");
  assert(await evaluate(`document.querySelector('.cloud-session').textContent.includes(${JSON.stringify("作業コピー: " + wc)})`), "work copy path on the Cloud screen");
  assert(realpathSync(core.db.getTask(local.id)!.cwd) === wc && core.db.getTask(local.id)!.workspaceId === workspace.id, "the Local Task's cwd is the work copy, in the same Workspace"); cases++;
  await openLocalByLink();
  // Opened by hand: the head marks the import and links back, without the switch line; the link returns to the Cloud Task.
  assert(await evaluate(`(() => { const h = document.querySelector('.task-head'); return !document.querySelector('.switched-from-cloud') && h.textContent.includes('Cloudから取込み') && [...h.querySelectorAll('button')].some(e=>e.textContent.trim()==='元Cloud Taskを開く'); })()`), "opened by hand: mark and link in the head, no switch line");
  await backToCloudFromHead(); cases++;
  await clickText("Local Taskを確認"); await openLocalByLink();
  assert(await evaluate(`document.querySelector('.side').textContent.includes(${JSON.stringify("作業コピー: " + wc)})`), "work copy path on the Local screen");
  await set(".composer textarea", "continue fixture"); await click(".composer button.pri");
  await until(() => entries().some(e => e.args?.includes("--resume")), "Local CLI resume");
  const resumed = entries().find(e => e.args?.includes("--resume"));
  assert(resumed.args[resumed.args.indexOf("--resume") + 1] === uuid && resumed.cwd === wc && !resumed.args.includes("--teleport"), "normal --resume exact UUID");
  await until(() => !core!.tasks.isLive(local.id), "Local end"); cases++;
  // A question: shown with the terminal link, never answered by Switchboard; reload and reconnect neither restart nor lose it.
  const askCount = await start("prompt", "picker");
  await until(() => evaluate(`!!document.querySelector('.cloud-session [data-testid="teleport-progress"] pre')`), "question shown");
  assert(JSON.stringify(teleportEntries().at(-1).args) === '["--teleport"]', "public picker fallback");
  assert(core.db.listLocalTasksForCloud(cloud.id).length === 1 && inputs() === inputsBefore, "no automatic approval/import");
  await openCloud(); // reload: the open question comes back from the daemon
  await until(() => evaluate(`!!document.querySelector('.cloud-session [data-testid="teleport-progress"] pre')`), "question after reload");
  assert(teleportEntries().length === askCount + 1, "reload has no duplicate spawn");
  const blocked = await fetch(`${base}/api/tasks/${local.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "must not resume while Terminal runs" }) });
  assert(blocked.status === 409 && (await blocked.json() as any).error.includes("Teleport"), "live Terminal blocks Local resume");
  const resumptionCount = entries().filter(e => e.args?.includes("--resume")).length;
  await answerInTerminal("n"); await ended();
  assert(teleportEntries().length === askCount + 1 && entries().filter(e => e.args?.includes("--resume")).length === resumptionCount && core.db.listLocalTasksForCloud(cloud.id).length === 1, "cancel cannot resume/import"); cases++;
  // The same question answered in the terminal: Switchboard then ends the CLI and opens the Local Task by itself.
  await start("prompt"); await answerInTerminal("y");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }); // a phone's width (#1634)
  try { await localScreen(); await until(switchedVisible, "switch line visible without scrolling at 390px"); }
  finally { await call("Emulation.clearDeviceMetricsOverride"); }
  cases++; await ended(false);
  assert(entries().filter(e => e.answer === "y").length === 1 && entries().filter(e => e.stdin === "/exit").length === 2, "one answer from the person, /rename and /exit from the daemon"); cases++;
  for (const [m, hint] of [["unpushed", "push済み"], ["repo", "同じリポジトリ"], ["account", "同じアカウント"], ["permission", "アクセス権"], ["provider", "サブスクリプション"], ["subscription", "サブスクリプション"]]) {
    await start(m); await ended();
    assert((await progressText()).includes(hint) && core.db.listLocalTasksForCloud(cloud.id).length === 1, "localized failure preserves ownership"); cases++;
  }
  const unsupportedCount = await start("ok", "unsupported");
  await until(async () => (await progressText()).includes("更新"), "unsupported guidance"); assert(snapshot() === before && entries().every(e => !e.gitChange), "unsupported leaves Git/config");
  assert(teleportEntries().length === unsupportedCount && (await progressText()).includes("更新"), "unsupported help cannot launch"); cases++;
  for (const m of ["unknown", "wrong-cloud", "wrong-uuid"]) {
    await start(m, m === "wrong-cloud" ? "picker" : "id"); await answerInTerminal("y"); await ended();
    assert(core.db.listLocalTasksForCloud(cloud.id).length === 1 && core.db.listEvents(cloud.id).at(-1)?.ev.t === "status", "unconfirmed result records status, no extra link");
    assert((await progressText()).includes("未確認"), "unconfirmed shown on the Cloud screen"); cases++;
  }
  // #1395: a Local Task at work in the clone is not stopped, refused or touched; the continuation runs in the worktree.
  const releaseFile = join(home, "release");
  const busy = core.tasks.create({ runner: "claude", workspaceId: workspace.id, cwd: repo, title: "busy fixture", prompt: "HOLD busy" });
  await until(() => entries().some(e => JSON.stringify(e.prompt ?? "").includes("HOLD busy")) && core!.tasks.isLive(busy.id), "busy Local Task at work in the clone");
  const busyCount = await start("ok"); await localScreen(); await ended(false);
  assert(teleportEntries().length === busyCount + 1 && teleportEntries().at(-1).cwd === wc, "Teleport started in the worktree despite the busy Local Task");
  assert(core.tasks.isLive(busy.id) && core.db.getTask(busy.id)!.status === "running", "the busy Local Task kept running");
  assert(!JSON.stringify((await fetch(`${base}/api/tasks/${watched}`).then(r => r.json())).teleport ?? "").includes("終わってから押してください"), "no wait-until-finished message");
  const reply = await fetch(`${base}/api/tasks/${busy.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "still reachable" }) });
  assert(reply.ok, "a reply to the busy Local Task is not refused"); cases++;
  // During a Teleport that is waiting for an answer: a new Task and a reply in the clone, independent of the worktree.
  await start("prompt");
  await until(() => evaluate(`!!document.querySelector('.cloud-session [data-testid="teleport-progress"] pre')`), "question shown");
  const during = core.tasks.create({ runner: "claude", workspaceId: workspace.id, cwd: repo, title: "during teleport", prompt: "new while Teleport runs" });
  await until(() => entries().some(e => JSON.stringify(e.prompt ?? "").includes("new while Teleport runs")), "new Local Task started in the clone during Teleport");
  const wcStatus = git(wc, "status", "--porcelain"), wcHead = git(wc, "rev-parse", "HEAD");
  assert(core.db.getTask(during.id)!.cwd === repo && !git(repo, "status", "--porcelain").includes(".claude"), "the clone's Git state shows no work copy");
  assert(wcStatus === "" && wcHead === git(repo, "rev-parse", "HEAD"), "the work copy is a clean checkout of the clone's HEAD, independent of its dirty files");
  // Both sides edit at once: neither edit shows up on the other side, and the busy Task is still reachable mid-Teleport.
  writeFileSync(join(repo, "clone-edit.txt"), "clone"); writeFileSync(join(wc, "wc-edit.txt"), "worktree");
  assert(git(wc, "status", "--porcelain") === "?? wc-edit.txt", "the work copy sees only its own edit");
  assert(git(repo, "status", "--porcelain").includes("clone-edit.txt") && !git(repo, "status", "--porcelain").includes("wc-edit.txt") && !existsSync(join(repo, "wc-edit.txt")) && !existsSync(join(wc, "clone-edit.txt")), "the clone sees only its own edits");
  const midReply = await fetch(`${base}/api/tasks/${busy.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "reply during Teleport" }) });
  assert(midReply.ok, "a reply in the clone is not refused while Teleport runs");
  const midNew = await fetch(`${base}/api/tasks/${during.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "reply to the new Task" }) });
  assert(midNew.ok, "a reply to the new Task is not refused while Teleport runs");
  rmSync(join(repo, "clone-edit.txt")); rmSync(join(wc, "wc-edit.txt"));
  await answerInTerminal("n"); await ended();
  writeFileSync(releaseFile, "go"); await until(() => !core!.tasks.isLive(busy.id), "busy Local Task end"); cases++;
  // A second Cloud cannot claim a session already linked to the original Cloud.
  const conflicting = core.tasks.create({ runner: "claude", workspaceId: workspace.id, cwd: repo, title: "conflicting fixture", prompt: "fixture", executionMode: "cloud" });
  await until(() => !core!.tasks.isLive(conflicting.id), "second launcher end");
  writeFileSync(mode, "prompt"); writeFileSync(help, "id"); writeFileSync(target, conflicting.cloudSession?.id ?? core.db.getTask(conflicting.id)!.cloudSession!.id); await openCloud("conflicting fixture");
  expectedSpawns = teleportEntries().length + 1; watched = conflicting.id; statusBefore = statusCount(watched); inputsBefore = inputs();
  await clickText("ローカルで続ける"); await answerInTerminal("y"); await ended();
  assert(core.db.listLocalTasksForCloud(conflicting.id).length === 0 && (await progressText()).includes("未確認"), "conflicting owner refused"); cases++;
  // Re-scan/restart must neither duplicate imported events nor lose source navigation.
  core.history.scan();
  assert(core.db.listTasksBySession("claude", uuid).length === 1, "one owner after scan");
  const afterResumeEvents = core.db.listEvents(local.id).length, afterResumeTokens = core.db.taskCost(local.id).tokens;
  assert(afterResumeEvents >= eventCount && afterResumeTokens >= tokens, "continuation retained");
  await call("Page.navigate", { url: "about:blank" }); await core.stop(); core = await boot();
  core.history.scan();
  assert(core.db.listEvents(local.id).length === afterResumeEvents && core.db.taskCost(local.id).tokens === afterResumeTokens && core.db.getTask(local.id)?.sourceCloudTaskId === cloud.id, "restart idempotent history/usage/link");
  const finalSpawns = teleportEntries().length; await openCloud();
  const reconnectedBefore = ptyConnected; await clickText("ターミナル"); await until(() => ptyConnected > reconnectedBefore, "reserved Terminal connected");
  await quiet(finalSpawns); assert(teleportEntries().length === finalSpawns && snapshot() === before && entries().some(e => e.gitCall), "restart/reload cannot spawn or mutate Git, Git spy exercised"); cases++;
  assert(consoleErrors === 0, "console errors"); pass = true;
} catch (e) {
  if (process.env.E2E_DEBUG_FILE) writeFileSync(process.env.E2E_DEBUG_FILE, JSON.stringify({ error: e instanceof Error ? e.message : "assertion failed", tasks: core?.db.listTasks().map(t => ({ status: t.status, mode: t.executionMode, reference: !!t.cloudSession })) }));
  process.exitCode = 1;
} finally {
  ws?.close(); chrome?.kill(); if (chrome) await chrome.exited; if (core) await core.stop();
  for (const [key,value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(home, { recursive: true, force: true }); Object.assign(console, originalConsole);
  console.log(JSON.stringify({ result: pass ? "pass" : "fail", cases, consoleErrors }));
}
