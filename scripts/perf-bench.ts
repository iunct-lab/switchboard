/**
 * Run after `bun run --cwd apps/web build`: bun scripts/perf-bench.ts [--runs N] [--json <file>]. Requires Chrome
 * (CHROME_BIN overrides). Times the four journeys of #637 (launch / new-task / open-task / send) the same way each run:
 * a fresh daemon with a fake runner (a long task of 2,000 events; every other turn a reply of 200 deltas) and a fresh
 * headless Chrome tab at 1280 × 800. Prints, per journey, the median and p90 of `sb:<journey>` in ms and the counts that
 * do not wobble (API requests, Chrome's LayoutCount / RecalcStyleCount, the layout shift) as the median of the runs.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { AgentEvent, Journey, RunnerAdapter } from "@switchboard/protocol";

const { values: args } = parseArgs({ options: { runs: { type: "string", default: "5" }, json: { type: "string" } } });
const runs = Number(args.runs);
if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer: ${args.runs}`);
const dist = join(import.meta.dir, "../apps/web/dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("apps/web/dist is missing: run `bun run --cwd apps/web build` first");

const LONG_EVENTS = 2_000;
const REPLY_DELTAS = 200;

/** The long task's history: tool calls, their results and assistant text, in a fixed order. */
function longEvents(): AgentEvent[] {
  const out: AgentEvent[] = [];
  for (let i = 0; out.length < LONG_EVENTS; i++) {
    out.push({ t: "tool.call", id: `c${i}`, name: "Read", input: { file_path: `src/file${i}.ts` }, summary: `Read src/file${i}.ts` });
    out.push({ t: "tool.result", id: `c${i}`, ok: true, summary: `${40 + (i % 7)} lines` });
    out.push({ t: "message.delta", role: "assistant", text: `Step ${i}: the file reads as expected. `, messageId: `m${i}` });
    out.push({ t: "message.delta", role: "assistant", text: "Moving on to the next one.\n", messageId: `m${i}` });
  }
  return out.slice(0, LONG_EVENTS);
}

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

/** One tab of its own: connect, time the four journeys in order, close. */
async function runOnce(chromePort: string, base: string): Promise<Record<Journey, Sample>> {
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
  const settle = () => {
    lastNetwork = Math.max(lastNetwork, Date.now());
    return until(() => inflight.size === 0 && Date.now() - lastNetwork > 500, "the network goes quiet");
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
    const out = {} as Record<Journey, Sample>;
    const journey = async (name: Journey, act: () => Promise<unknown>) => {
      if (name !== "launch") await settle(); // what the screen loads before the action is not the journey's
      const m0 = await metrics();
      const r0 = requests;
      const s0 = name === "launch" ? 0 : await shift();
      await act();
      const ms = await until(() => evaluate(`performance.getEntriesByName("sb:${name}", "measure")[0]?.duration`) as Promise<number | undefined>, `sb:${name}`);
      await settle();
      const m1 = await metrics();
      out[name] = { ms, requests: requests - r0, layoutCount: m1.layoutCount - m0.layoutCount, recalcStyleCount: m1.recalcStyleCount - m0.recalcStyleCount, layoutShift: (await shift()) - s0 };
    };
    const click = (selector: string, text?: string) =>
      evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.trim() === ${JSON.stringify(text)}` : "true"}); if (!b || b.disabled) return false; b.click(); return true; })()`);
    const type = async (selector: string, text: string) => {
      await until(() => evaluate(`(() => { const t = document.querySelector(${JSON.stringify(selector)}); if (!t) return false; t.focus(); return true; })()`), selector);
      await call("Input.insertText", { text });
    };

    await journey("launch", () => call("Page.navigate", { url: `${base}/` }));
    // the Workspace is picked, not left to 自動 (that asks the runner which one, a turn of its own)
    await until(() => evaluate(`(() => { const s = document.querySelector("main.home select"); const o = s && [...s.options].find((o) => o.value); if (!o) return false; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(s, o.value); s.dispatchEvent(new Event("change", { bubbles: true })); return true; })()`), "a workspace to pick");
    await type("main.home textarea", "bench");
    await until(() => evaluate(`!![...document.querySelectorAll("main .pri")].find((b) => b.textContent.trim() === "開始" && !b.disabled)`), "the start button");
    await journey("new-task", () => click("main .pri", "開始"));
    await until(() => click("header .tabs button", "Home"), "Home");
    await journey("open-task", () => until(() => click(".rail .it", "long"), "the long task in the rail"));
    await type(".composer textarea", "reply");
    await journey("send", () => until(() => click(".composer .pri"), "the send button"));
    return out;
  } finally {
    ws.close();
    await fetch(`http://127.0.0.1:${chromePort}/json/close/${target.id}`).catch(() => undefined);
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const p90 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.9) - 1]!;
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

function bundle() {
  const assets = join(dist, "assets");
  const size = (ext: string) => readdirSync(assets).filter((f) => f.endsWith(ext)).reduce((n, f) => n + Bun.gzipSync(readFileSync(join(assets, f))).length, 0);
  return { js: size(".js"), css: size(".css") };
}

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
    } finally {
      await d.stop();
    }
  }
  const journeys = Object.fromEntries(
    (["launch", "new-task", "open-task", "send"] as const).map((name) => {
      const of = (k: keyof Sample) => samples.map((s) => s[name][k]);
      return [name, { msMedian: round(median(of("ms"))), msP90: round(p90(of("ms"))), requests: median(of("requests")), layoutCount: median(of("layoutCount")), recalcStyleCount: median(of("recalcStyleCount")), layoutShift: round(median(of("layoutShift")), 4) }];
    }),
  );
  const result = { runs, journeys, bundle: bundle() };
  console.log(`runs: ${runs} (1280×800, headless Chrome, fonts: ${fontconfig ? "Noto Sans + Noto Sans CJK only" : "the OS's"}, fake runner: long task ${LONG_EVENTS} events, reply ${REPLY_DELTAS} deltas)`);
  console.log("| journey | ms median | ms p90 | requests | LayoutCount | RecalcStyleCount | layoutShift |");
  console.log("|---|---:|---:|---:|---:|---:|---:|");
  for (const [name, j] of Object.entries(journeys)) console.log(`| ${name} | ${j.msMedian} | ${j.msP90} | ${j.requests} | ${j.layoutCount} | ${j.recalcStyleCount} | ${j.layoutShift} |`);
  console.log(`bundle (gzip): js ${result.bundle.js} B, css ${result.bundle.css} B`);
  if (args.json) await Bun.write(args.json, JSON.stringify(result, null, 2) + "\n");
} finally {
  chrome.kill();
  await chrome.exited;
  rmSync(profile, { recursive: true, force: true });
  rmSync(fontsDir, { recursive: true, force: true });
}
