/**
 * bun scripts/rescue-e2e.ts — the rescue page in a real browser at phone width, with Switchboard down (#178).
 * Uses the installed bundle (rescue/install.ts) and a tiny fixture repository; needs Chrome (CHROME_BIN overrides).
 * Run from a Switchboard Task or the host's shell too: the host sb-rescue's variables (SWITCHBOARD_*) are not inherited.
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitFile, daemonSource, freePort, health, makeRepo, until } from "../rescue/src/fixture.ts";

const f = await makeRepo();
const crashFlag = join(f.root, "crash");
const v2 = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("v2", `if (require("node:fs").existsSync(${JSON.stringify(crashFlag)})) { console.error("v2: cannot start"); process.exit(1); }`), `v2: crashes once the flag exists ${"x".repeat(120)}`);
Bun.spawnSync(["git", "-C", f.repo, "tag", "v0.2.0", v2]); // a release tag (#282): shown before the sha
const [port, rescuePort] = [await freePort(), await freePort()];
// A stand-in for `claude` on PATH: the bundle starts its real default command line, and no quota is spent.
mkdirSync(join(f.root, "bin"));
writeFileSync(join(f.root, "bin", "claude"), '#!/bin/sh\necho "fake claude: $*"\nn=0\nwhile IFS= read -r line; do n=$((n+1)); [ $n -le 6 ] && { echo "prompt: $line"; sleep 0.3; }; done\necho "fake claude done"\n');
chmodSync(join(f.root, "bin", "claude"), 0o755);
// SWITCHBOARD_RESCUE_HOST=0.0.0.0 and the like would make the fixture's rescue page ask for a token (rescue/src/main.ts)
const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SWITCHBOARD_")));
const env = { ...inherited, PATH: `${join(f.root, "bin")}:${process.env.PATH}`, SWITCHBOARD_HOME: f.home, SWITCHBOARD_PORT: String(port), SWITCHBOARD_RESCUE_PORT: String(rescuePort), SWITCHBOARD_REPO_ROOT: f.repo };
const say = (line: string) => console.log(`[e2e] ${line}`);
const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message); };
const rows = () => { const db = new Database(join(f.home, "switchboard.db")); try { return (db.query("select name from notes order by name").all() as Array<{ name: string }>).map((r) => r.name); } finally { db.close(); } };
const procs: Array<{ kill(signal?: number | NodeJS.Signals): void; exited: Promise<number> }> = [];

try {
  const db = new Database(join(f.home, "switchboard.db"));
  db.exec("create table notes (name text); insert into notes values ('before')");
  db.close();

  await Bun.spawn([process.execPath, join(import.meta.dir, "..", "rescue", "install.ts")], { env, stdout: "ignore", stderr: "inherit" }).exited;
  const bundle = join(f.home, "rescue", "sb-rescue.js");
  assert(existsSync(bundle), "install.ts wrote no bundle");
  await Bun.spawn(["git", "-C", f.repo, "checkout", "-q", "HEAD~1"], {}).exited; // first release = v1
  const rescue = Bun.spawn([process.execPath, bundle], { env, cwd: f.root, stdout: "ignore", stderr: "inherit" });
  procs.push(rescue);
  const base = `http://127.0.0.1:${rescuePort}`;
  const status = () => fetch(`${base}/api/status`).then((r) => r.json()) as Promise<{ current: string; state: string; busy: string | null; unhealthy: string | null; history: Array<{ action: string; reason: string }> }>;
  assert((await until(() => health(port), "v1 up", 30_000)).version === "v1", "v1 did not start from the bundle");
  say(`bundle ${bundle} runs v1 on :${port}, rescue page on :${rescuePort}`);

  await fetch(`${base}/api/promote`, { method: "POST", body: JSON.stringify({ commit: v2 }) });
  await until(async () => (await status()).history[0]?.action === "promote", "v2 promoted", 60_000);
  say(`promoted v2: ${(await status()).history[0]!.reason}`);

  writeFileSync(crashFlag, "");
  await Bun.spawn(["pkill", "-f", join(f.home, "releases", v2, "packages")], {}).exited;
  await until(async () => (await status()).state === "failed", "crash loop ends in failed", 30_000);
  say(`Switchboard is down: state=failed, ${(await status()).unhealthy}`);

  const profile = join(f.root, "chrome");
  const chrome = Bun.spawn([process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
  procs.push(chrome);
  const cdpPort = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const tab = await until(async () => ((await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page"), "Chrome page");
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  const dialogs: string[] = [];
  let interceptionError: unknown;
  let statusAsks = 0;
  const call = (method: string, params: object = {}): Promise<any> => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
    if (m.method === "Fetch.requestPaused") {
      void (async () => {
        const { requestId } = m.params;
        const response = await call("Fetch.getResponseBody", { requestId });
        const body = JSON.parse(response.base64Encoded ? Buffer.from(response.body, "base64").toString("utf8") : response.body);
        body.rebuild = true;
        await call("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(body)).toString("base64") });
      })().catch((e) => { interceptionError = e; });
    }
    if (m.method === "Network.requestWillBeSent" && new URL(m.params.request.url).pathname.endsWith("/api/status")) statusAsks++;
    if (m.method === "Page.javascriptDialogOpening") { dialogs.push(m.params.message); void call("Page.handleJavaScriptDialog", { accept: true }); }
  };
  const evaluate = async (expression: string) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await call("Page.navigate", { url: `${base}/` });
  await until(() => evaluate(`document.getElementById("state").textContent.includes("応答なし")`), "page shows that Switchboard is down");
  say(`page at 390px: "${await evaluate(`document.getElementById("state").textContent`)}"`);
  assert(await evaluate(`getComputedStyle(document.getElementById("rebuild-row")).display === "none"`), "rebuild: false must hide the rebuild row");
  assert(await evaluate(`[...document.querySelectorAll("[hidden]")].every((e) => getComputedStyle(e).display === "none")`), "every hidden element must have display: none");
  say("rebuild: false hides the row; every [hidden] element has display: none");
  const width = await evaluate("document.documentElement.scrollWidth");
  assert(width <= 390, `the page scrolls sideways at 390px (scrollWidth ${width})`);
  const small = await evaluate(`[...document.querySelectorAll("button")].filter((b) => b.getClientRects().length > 0 && b.getBoundingClientRect().height < 44).length`);
  assert(small === 0, `${small} button(s) are shorter than 44px`);
  say(`scrollWidth=${width}, every button is at least 44px tall, log lines=${await evaluate(`document.getElementById("log").textContent.split("\\n").length`)}`);
  await until(() => evaluate(`document.getElementById("disk-usage").textContent.includes("ルートディスク") && document.querySelectorAll("#sweeps li").length > 0 && [...document.querySelectorAll("#sweeps li")].every((li) => li.textContent.includes("自動の片付け")) && document.getElementById("tmp-usage").textContent.includes("使用") && document.querySelectorAll("#tmp-list li").length > 0`), "the disk section shows the root disk, the automatic cleans, /tmp's usage and the entries");
  const tmpWidth = await evaluate("document.documentElement.scrollWidth");
  assert(tmpWidth <= 390, `the page scrolls sideways at 390px with the disk section listed (scrollWidth ${tmpWidth})`);
  const tmpSmall = await evaluate(`[...document.querySelectorAll("button")].filter((b) => b.getClientRects().length > 0 && b.getBoundingClientRect().height < 44).length`);
  assert(tmpSmall === 0, `${tmpSmall} button(s) are shorter than 44px with the disk section listed`);
  // tmp-clean is not pressed: the bundle reads this host's real /tmp; bun test rescue removes on a fake one
  say(`disk at 390px: "${await evaluate(`document.getElementById("disk-usage").textContent`)}", sweeps: "${await evaluate(`[...document.querySelectorAll("#sweeps li")].map((li) => li.textContent).join(" / ")`)}", "${await evaluate(`document.getElementById("tmp-usage").textContent`)}", first: "${await evaluate(`document.querySelector("#tmp-list li").textContent`)}", button: "${await evaluate(`document.getElementById("tmp-clean").textContent`)}"`);

  await evaluate(`document.getElementById("rollback").click()`);
  assert((await until(() => health(port), "v1 back", 30_000)).version === "v1", "rollback did not bring v1 up");
  await until(() => evaluate(`document.getElementById("state").textContent.includes("動いています") && document.getElementById("history").textContent.includes("戻した")`), "page shows the rollback");
  say(`clicked 前の版に戻す (confirm: "${dialogs.at(-1)}") → v1 answers; page: "${await evaluate(`document.getElementById("state").textContent`)}" / history: "${await evaluate(`document.querySelector("#history li").textContent`)}"`);

  const tagged = await evaluate(`[...document.getElementById("release").options].map((o) => o.textContent).find((t) => t.startsWith("v0.2.0 ${v2.slice(0, 7)} v2: crashes")) ?? ""`);
  assert(tagged, "the release list does not show the tag before the sha");
  say(`release list: "${tagged.slice(0, 60)}…", 前の版: "${(await evaluate(`document.getElementById("previous").textContent`)).slice(0, 30)}…"`);

  const add = new Database(join(f.home, "switchboard.db"));
  add.exec("insert into notes values ('after')");
  add.close();
  assert(rows().join() === "after,before", "row was not added");
  await until(() => evaluate(`document.getElementById("snapshot").value.includes("before-${v2.slice(0, 7)}")`), "snapshot offered");
  await evaluate(`document.getElementById("restore").click()`);
  await until(() => rows().join() === "before", "the snapshot brought the database back", 30_000);
  await until(() => health(port), "daemon up after the restore", 30_000);
  say(`clicked DB をスナップショットから戻す (confirm: "${dialogs.at(-1)!.slice(0, 40)}…") → rows ${JSON.stringify(rows())}`);
  const versionBefore = (await status()).current;
  await evaluate(`document.getElementById("agent-start").click()`);
  const first = await until(() => evaluate(`document.getElementById("agent-output").textContent.length`), "agent output appears");
  const grown = await until(async () => { const n = await evaluate(`document.getElementById("agent-output").textContent.length`); return n > first ? n : null; }, "agent output keeps growing");
  await until(() => evaluate(`document.getElementById("agent-output").textContent.includes("fake claude done")`), "agent finished", 30_000);
  const output: string = await evaluate(`document.getElementById("agent-output").textContent`);
  assert(output.includes("--output-format stream-json --verbose --permission-mode acceptEdits --allowedTools") && !/Bash\(bun/.test(output) && !/dangerously/.test(output), "the agent was not started with the allowlist");
  assert((await status()).current === versionBefore && (await status()).history[0]!.action === "restore-db", "the agent run changed the release or the history");
  say(`clicked 救援エージェントを起動 (confirm: "${dialogs.at(-1)}") → output grew ${first} → ${grown} chars while running; first line: "${output.split("\n")[0]!.slice(0, 90)}…"; state: "${await evaluate(`document.getElementById("agent-state").textContent`)}"; current unchanged`);
  assert((await evaluate("document.documentElement.scrollWidth")) <= 390, "the page scrolls sideways with agent output");
  await call("Fetch.enable", { patterns: [{ urlPattern: "*/api/status*", requestStage: "Response" }] });
  await until(() => interceptionError || evaluate(`!document.getElementById("rebuild-row").hidden && getComputedStyle(document.getElementById("rebuild-row")).display !== "none" && !document.getElementById("rebuild").disabled`), "rebuild: true shows an enabled rebuild button");
  assert(!interceptionError, `status interception failed: ${interceptionError}`);
  say("rebuild: true (intercepted status) shows the row and enables the button");
  await call("Fetch.disable");
  // a hidden tab stops asking for the status; back to visible it asks at once, then every 2 s (#2814)
  await call("Network.enable");
  const visibility = (state: "hidden" | "visible") => evaluate(`Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "${state}" }); Object.defineProperty(document, "hidden", { configurable: true, get: () => ${state === "hidden"} }); document.dispatchEvent(new Event("visibilitychange"))`);
  await visibility("hidden");
  await Bun.sleep(500); // a request already on its way
  const hiddenFrom = statusAsks;
  await Bun.sleep(6000);
  const hiddenAsks = statusAsks - hiddenFrom;
  assert(hiddenAsks === 0, `the hidden tab asked for the status ${hiddenAsks} times in 6 s`);
  const shownFrom = statusAsks;
  await visibility("visible");
  await Bun.sleep(1000);
  const atOnce = statusAsks - shownFrom;
  assert(atOnce >= 1, "coming back to visible did not ask for the status at once");
  await Bun.sleep(4000);
  const after = statusAsks - shownFrom - atOnce;
  assert(after >= 1 && after <= 3, `back to visible, the status was asked ${after} times in 4 s (every 2 s expected)`);
  say(`visibility: hidden 6 s → +${hiddenAsks} /api/status; visible → +${atOnce} within 1 s, then +${after} in 4 s`);
  ws.close();
  say("PASS");
} finally {
  for (const p of procs) { p.kill("SIGTERM"); await p.exited; }
  rmSync(f.root, { recursive: true, force: true });
}
