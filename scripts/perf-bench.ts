/**
 * Run after `bun run --cwd apps/web build`: bun scripts/perf-bench.ts [--runs N] [--json <file>] [--skip-loaded <reason>]. Requires Chrome
 * (CHROME_BIN overrides). Times the four journeys of #637 (launch / new-task / open-task / send) the same way each run:
 * a fresh daemon with a fake runner (a long task of 2,000 events; every other turn a reply of 200 deltas) and a fresh
 * headless Chrome tab at 1280 × 800. Prints, per journey, the median and p90 of `sb:<journey>` in ms and the counts that
 * do not wobble (API requests, Chrome's LayoutCount / RecalcStyleCount, the layout shift) as the median of the runs.
 * Then, once (LOADED_RUNS, not --runs), launch and send again on a daemon holding as much as the real home
 * (scripts/perf-load.ts): launch under a backlog import and the rescue page's status checks, send without them, and the
 * longest the daemon took to answer /api/health during the import (`loaded`, #2822, #3634). `--skip-loaded <reason>`:
 * local-ci gives it when the change does not reach this script (scripts/test-select.ts --loaded, #3635); the result then
 * holds `loadedSkipped` instead of `loaded`, and perf-ratchet leaves the `loaded` ceiling out.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import { LOAD, LONG_EVENTS, loadGh, longEvents, overlap, seedLoad } from "./perf-load.ts";
import { bundleOf } from "./perf-ratchet.ts";
import type { Journey, RunnerAdapter } from "@switchboard/protocol";

const { values: args } = parseArgs({ options: { runs: { type: "string", default: "5" }, json: { type: "string" }, "skip-loaded": { type: "string" } } });
const runs = Number(args.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer: ${args.runs}`);
const dist = join(import.meta.dir, "../apps/web/dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("apps/web/dist is missing: run `bun run --cwd apps/web build` first");

const REPLY_DELTAS = 200;
/** A loaded journey waits this long, not `until`'s 30 s: a daemon stuck for longer must read as over its ceiling, not as a timeout. */
const LOADED_WAIT_MS = 300_000;
/** `loaded` runs once, whatever --runs is (#3634): it tells a daemon stuck for minutes (the ceiling's ~90 times) from a
 * working one, and finer than that the host's load moves it more than more runs would settle; 5 runs took ~8 minutes. */
const LOADED_RUNS = 1;

const benchAdapter: RunnerAdapter = {
  id: "claude",
  detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${opts.resume ?? opts.prompt}`, cwd: opts.cwd });
      if (opts.prompt === "long") for (const ev of longEvents()) emit(ev);
      else for (let i = 0; i < REPLY_DELTAS; i++) emit({ t: "message.delta", role: "assistant", text: `word${i} `, messageId: "reply" });
      emit({ t: "session.end", status: "ok" });
      exit(0);
    });
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};

async function until<T>(fn: () => T | Promise<T>, label: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await Promise.resolve().then(fn).catch(() => null); // a page mid-navigation cannot evaluate yet
    if (value) return value as NonNullable<T>;
    await Bun.sleep(20);
  }
  throw new Error(`Timeout: ${label}`);
}

function findChrome(): string {
  const found = [process.env.CHROME_BIN, "/usr/bin/google-chrome", "/usr/local/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((p) => p && existsSync(p));
  if (!found) throw new Error("Chrome not found: set CHROME_BIN");
  return found;
}

/**
 * GitHub as the bench's daemon sees it: the GraphQL budget only (#549; the ledger asks for it), answered at once and
 * the same every run — the real gh would put GitHub's network into what the UI is timed on. Anything else fails.
 */
const benchGh = async (args: string[]) => args.some((a) => a.includes("rateLimit"))
  ? { code: 0, stdout: JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4000, resetAt: new Date(Date.now() + 30 * 60_000).toISOString() } } }), stderr: "" }
  : { code: 1, stdout: "", stderr: "no GitHub in the bench" };

/** A daemon of its own per run, so every run opens the same list and the same long task. */
async function daemon() {
  const home = mkdtempSync(join(tmpdir(), "sb-perf-bench-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  const core = await startServer(cfg, [benchAdapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: benchGh });
  const base = `http://127.0.0.1:${core.server.port}`;
  const stop = async () => {
    await core.stop();
    rmSync(home, { recursive: true, force: true });
  };
  try {
    const task = (await (await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cfg.repoRoot, title: "long", prompt: "long", runner: "claude" }) })).json()) as { id: string };
    await until(async () => ((await (await fetch(`${base}/api/tasks/${task.id}`)).json()) as { task: { status: string } }).task.status === "done", "the long task ends");
  } catch (e) {
    await stop();
    throw e;
  }
  return { base, stop };
}

type Sample = { ms: number; requests: number; layoutCount: number; recalcStyleCount: number; layoutShift: number };

/** The daemon of a loaded run: a copy of the seeded home; `generation` is its GitHub, raised to make an import rewrite everything. */
async function loadedDaemon(template: string) {
  const home = mkdtempSync(join(tmpdir(), "sb-perf-bench-loaded-"));
  cpSync(template, home, { recursive: true });
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  const github = { generation: 0 };
  const core = await startServer(cfg, [benchAdapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: loadGh(LOAD.backlogRecords / 10, github) });
  return {
    home, github, port: core.server.port!, base: `http://127.0.0.1:${core.server.port}`,
    stop: async () => {
      await core.stop();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

type Loaded = Awaited<ReturnType<typeof loadedDaemon>>;

type Around = (act: () => Promise<void>) => Promise<unknown>;

/** One tab of its own: connect, `play` it, close. */
async function withTab<T>(chromePort: string, play: (tab: Tab) => Promise<T>): Promise<T> {
  const target = (await (await fetch(`http://127.0.0.1:${chromePort}/json/new?about:blank`, { method: "PUT" })).json()) as { id: string; webSocketDebuggerUrl: string };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("CDP socket failed"));
  });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  let requests = 0;
  const inflight = new Set<string>();
  let lastNetwork = Date.now();
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result);
    }
    // the page's own timings sent to the daemon (#639, POST /api/perf) are not any journey's work
    const api = m.method === "Network.requestWillBeSent" ? new URL(m.params.request.url).pathname : "";
    if (api.startsWith("/api/") && api !== "/api/perf") {
      requests++;
      inflight.add(m.params.requestId);
      lastNetwork = Date.now();
    }
    if ((m.method === "Network.loadingFinished" || m.method === "Network.loadingFailed") && inflight.delete(m.params.requestId)) lastNetwork = Date.now();
  };
  const call = (method: string, params: object = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const metrics = async () => {
    const list = (await call("Performance.getMetrics")).metrics as Array<{ name: string; value: number }>;
    const get = (name: string) => list.find((x) => x.name === name)?.value ?? 0;
    return { layoutCount: get("LayoutCount"), recalcStyleCount: get("RecalcStyleCount") };
  };
  // what is still loading after a journey (the rest of a streamed reply, the refreshes it causes) belongs to that journey
  // 500ms: longer than Home's debounced suggestion (250ms), so the work a screen starts on its own is over
  // counted from the call too, not only from the last request: work the screen scheduled just now has not asked yet
  const settle = (wait?: number) => {
    lastNetwork = Math.max(lastNetwork, Date.now());
    return until(() => inflight.size === 0 && Date.now() - lastNetwork > 500, "the network goes quiet", wait);
  };
  const shift = () => evaluate("window.__sbShift ?? 0") as Promise<number>;

  try {
    await Promise.all(["Page.enable", "Runtime.enable", "Network.enable", "Performance.enable"].map((m) => call(m)));
    await call("Network.setBlockedURLs", { urls: ["*://fonts.googleapis.com/*", "*://fonts.gstatic.com/*"] }); // only the daemon answers
    await call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    // the running dot pulses every frame while a turn runs; that would count time, not work
    await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await call("Page.addScriptToEvaluateOnNewDocument", {
      source: "window.__sbShift = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__sbShift += e.value; }).observe({ type: 'layout-shift', buffered: true });",
    });
    const journey = async (name: Journey, act: () => Promise<unknown>, around: Around = (run) => run(), wait?: number): Promise<Sample> => {
      if (name !== "launch") await settle(wait); // what the screen loads before the action is not the journey's
      const m0 = await metrics();
      const r0 = requests;
      const s0 = name === "launch" ? 0 : await shift();
      let ms = 0;
      await around(async () => {
        await act();
        ms = await until(() => evaluate(`performance.getEntriesByName("sb:${name}", "measure")[0]?.duration`) as Promise<number | undefined>, `sb:${name}`, wait);
        await settle(wait);
      });
      const m1 = await metrics();
      return { ms, requests: requests - r0, layoutCount: m1.layoutCount - m0.layoutCount, recalcStyleCount: m1.recalcStyleCount - m0.recalcStyleCount, layoutShift: (await shift()) - s0 };
    };
    const click = (selector: string, text?: string) =>
      evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.trim() === ${JSON.stringify(text)}` : "true"}); if (!b || b.disabled) return false; b.click(); return true; })()`);
    const type = async (selector: string, text: string) => {
      await until(() => evaluate(`(() => { const t = document.querySelector(${JSON.stringify(selector)}); if (!t) return false; t.focus(); return true; })()`), selector);
      await call("Input.insertText", { text });
    };

    return await play({ call, evaluate, journey, click, type, settle });
  } finally {
    ws.close();
    await fetch(`http://127.0.0.1:${chromePort}/json/close/${target.id}`).catch(() => undefined);
  }
}

interface Tab {
  evaluate: (expression: string) => Promise<any>;
  call: (method: string, params?: object) => Promise<any>;
  journey: (name: Journey, act: () => Promise<unknown>, around?: Around, wait?: number) => Promise<Sample>;
  click: (selector: string, text?: string) => Promise<unknown>;
  type: (selector: string, text: string) => Promise<void>;
  settle: (wait?: number) => Promise<unknown>;
}

/** The four journeys in order. */
const runOnce = (chromePort: string, base: string) => withTab(chromePort, async ({ call, journey, click, type, evaluate }) => {
  const out = {} as Record<Journey, Sample>;
  out.launch = await journey("launch", () => call("Page.navigate", { url: `${base}/` }));
  // the Workspace is picked, not left to 自動 (that asks the runner which one, a turn of its own)
  await until(() => evaluate(`(() => { const s = document.querySelector("main.home select"); const o = s && [...s.options].find((o) => o.value); if (!o) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, o.value); s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`), "a workspace to pick");
  await type("main.home textarea", "bench");
  await until(() => evaluate(`!![...document.querySelectorAll("main .pri")].find((b) => b.textContent.trim() === "開始" && !b.disabled)`), "the start button");
  out["new-task"] = await journey("new-task", () => click("main .pri", "開始"));
  await until(() => click("header .tabs button", "Home"), "Home");
  out["open-task"] = await journey("open-task", () => until(() => click(".rail .it", "long"), "the long task in the rail"));
  await type(".composer textarea", "reply");
  out.send = await journey("send", () => until(() => click(".composer .pri"), "the send button"));
  return out;
});

/** launch under `overlap` (one import a run, #3634); send on the same loaded daemon without one; opening the long task in between is not timed. */
const runLoaded = (chromePort: string, d: Loaded, workspaceId: string) => withTab(chromePort, async ({ call, journey, click, type, settle }) => {
  const windows: number[] = [];
  const around: Around = async (run) => windows.push(await overlap({ ...d, workspaceId }, run));
  const launch = await journey("launch", () => call("Page.navigate", { url: `${d.base}/` }), around, LOADED_WAIT_MS);
  await settle(LOADED_WAIT_MS);
  await until(() => click(".rail .it", "long"), "the long task in the rail", LOADED_WAIT_MS);
  await settle(LOADED_WAIT_MS);
  await type(".composer textarea", "reply");
  const send = await journey("send", () => until(() => click(".composer .pri"), "the send button", LOADED_WAIT_MS), undefined, LOADED_WAIT_MS);
  return { launchMs: launch.ms, sendMs: send.ms, healthMaxMs: Math.max(...windows) };
});

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const p90 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.9) - 1]!;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;


/**
 * A fontconfig that shows Chrome only Noto Sans and Noto Sans CJK, so the text has the same size on every Linux machine:
 * the page's own fonts are blocked, and the OS's fallback moved the layout shift (no Japanese font: launch 0.28 → 0.38).
 * Without fontconfig (macOS) Chrome keeps the OS's fonts.
 */
function pinnedFonts(dir: string): string | undefined {
  if (!Bun.which("fc-list")) return undefined;
  const files = ["Noto Sans", "Noto Sans CJK JP"].flatMap((family) => {
    const found = Bun.spawnSync(["fc-list", `:family=${family}`, "file"]).stdout.toString().split("\n").map((l) => l.replace(/:\s*$/, "")).filter(Boolean);
    if (!found.length) throw new Error(`font not found: ${family} (Debian/Ubuntu: apt-get install fonts-noto-core fonts-noto-cjk)`);
    return found;
  });
  mkdirSync(join(dir, "fonts"));
  for (const f of new Set(files)) symlinkSync(f, join(dir, "fonts", basename(f)));
  const conf = join(dir, "fonts.conf");
  writeFileSync(conf, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><dir>${join(dir, "fonts")}</dir><cachedir>${join(dir, "fontcache")}</cachedir></fontconfig>\n`);
  return conf;
}

const profile = mkdtempSync(join(tmpdir(), "sb-perf-bench-chrome-"));
const fontsDir = mkdtempSync(join(tmpdir(), "sb-perf-bench-fonts-"));
const fontconfig = pinnedFonts(fontsDir);
const template = mkdtempSync(join(tmpdir(), "sb-perf-bench-template-")); // generated once: a copy per run costs a fraction of it
const chrome = Bun.spawn([findChrome(), "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--window-size=1280,800", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], {
  stdout: "ignore",
  stderr: "ignore",
  env: fontconfig ? { ...process.env, FONTCONFIG_FILE: fontconfig } : process.env,
});
try {
  const chromePort = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const samples: Array<Record<Journey, Sample>> = [];
  for (let i = 0; i < runs; i++) {
    const d = await daemon();
    try {
      samples.push(await runOnce(chromePort, d.base));
      console.log(`journeys: run ${i + 1} of ${runs} done`);
    } finally {
      await d.stop();
    }
  }
  const skipLoaded = args["skip-loaded"];
  const loadedRuns: Array<{ launchMs: number; sendMs: number; healthMaxMs: number }> = [];
  if (skipLoaded === undefined) {
    const { workspaceId } = await seedLoad(template);
    for (let i = 0; i < LOADED_RUNS; i++) {
      const d = await loadedDaemon(template);
      try {
        loadedRuns.push(await runLoaded(chromePort, d, workspaceId));
        // a line per run: CI cuts a step that prints nothing for 15 minutes, and a slow run must end as a number over its ceiling
        console.log(`loaded: run ${i + 1} of ${LOADED_RUNS}: /api/health max ${loadedRuns.at(-1)!.healthMaxMs} ms`);
      } finally {
        await d.stop();
      }
    }
  }
  const journeys = Object.fromEntries(
    (["launch", "new-task", "open-task", "send"] as const).map((name) => {
      const of = (k: keyof Sample) => samples.map((s) => s[name][k]);
      return [name, { msMedian: round(median(of("ms"))), msP90: round(p90(of("ms"))), requests: median(of("requests")), layoutCount: median(of("layoutCount")), recalcStyleCount: median(of("recalcStyleCount")), layoutShift: round(median(of("layoutShift")), 4) }];
    }),
  );
  const loadedMs = (xs: number[]) => ({ msMedian: round(median(xs)), msP90: round(p90(xs)) });
  const healthMs = loadedRuns.map((r) => r.healthMaxMs);
  const loaded = skipLoaded === undefined ? { ...LOAD, overlap: ["backlog-sync", "rescue-status"], journeys: { launch: loadedMs(loadedRuns.map((r) => r.launchMs)), send: loadedMs(loadedRuns.map((r) => r.sendMs)) }, healthMaxMs: round(median(healthMs)), healthMaxMsP90: round(p90(healthMs)) } : undefined;
  const result = { runs, journeys, bundle: bundleOf(dist), ...(loaded ? { loaded } : { loadedSkipped: skipLoaded }) };
  console.log(`runs: ${runs} (1280×800, headless Chrome, fonts: ${fontconfig ? "Noto Sans + Noto Sans CJK only" : "the OS's"}, fake runner: long task ${LONG_EVENTS} events, reply ${REPLY_DELTAS} deltas)`);
  console.log("| journey | ms median | ms p90 | requests | LayoutCount | RecalcStyleCount | layoutShift |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  for (const [name, j] of Object.entries(journeys)) console.log(`| ${name} | ${j.msMedian} | ${j.msP90} | ${j.requests} | ${j.layoutCount} | ${j.recalcStyleCount} | ${j.layoutShift} |`);
  console.log(`bundle (gzip): js ${result.bundle.js} B, css ${result.bundle.css} B`);
  if (!loaded) console.log(`\nloaded: 測らなかった（${skipLoaded}）`);
  else {
    console.log(`\nloaded: ${loaded.tasks} Tasks, ${loaded.backlogRecords} backlog records, ${loaded.operations} operations, under ${loaded.overlap.join(" + ")}`);
    console.log("| measure | median | p90 |\n|---|---:|---:|");
    console.log(`| launch ms | ${loaded.journeys.launch.msMedian} | ${loaded.journeys.launch.msP90} |`);
    console.log(`| send ms | ${loaded.journeys.send.msMedian} | ${loaded.journeys.send.msP90} |`);
    console.log(`| /api/health max ms | ${loaded.healthMaxMs} | ${loaded.healthMaxMsP90} |`);
  }
  if (args.json) await Bun.write(args.json, JSON.stringify(result, null, 2) + "\n");
} finally {
  chrome.kill();
  await chrome.exited;
  rmSync(profile, { recursive: true, force: true });
  rmSync(fontsDir, { recursive: true, force: true });
  rmSync(template, { recursive: true, force: true });
}
