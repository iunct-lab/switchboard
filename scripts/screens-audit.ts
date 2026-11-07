/**
 * Every screen, photographed on a phone held upright and on a PC (#4030): run after `bun run --cwd apps/web build`.
 *
 *   bun scripts/screens-audit.ts [--home <dir>] [--out <dir>] [--screens home,backlog-queue,…] [--widths phone,pc] [--max-frames 8]
 *
 * A candidate daemon (SWITCHBOARD_CANDIDATE=1: nothing it holds is sent or resumed; no runner; a gh that answers
 * nothing, so the stored backlog only) runs on a copy of the data: `--home` names a SWITCHBOARD_HOME to use as it is;
 * without it `~/.switchboard/switchboard.db` (sqlite .backup), its artifacts and attachments, and `~/Knowledge` are copied
 * under `~/.cache` (not `/tmp`, which is RAM) and removed at the end (the pictures stay).
 * It refuses a build older than what it reads (`BUILD_INPUTS`: a rebase or an edit not built would show the old screens).
 * Each screen is opened at 390×844 (phone, touch) and 1280×900 (pc), and the widest element that scrolls down is moved
 * one screen at a time, each frame saved as `<width>-<screen>-<n>.png` in `--out`. One line per screen counts what
 * is wrong whatever it looks like (`judge`): elements reaching past the right edge, and text squeezed into a column
 * of one character; and rows a bar (`header`) takes beyond what its items need (`extraRows`), the header measured
 * once more per width with 新しい版 in it (`<width>-header-new-version.png`). The rest is for a person to look at — open the pictures. CHROME_BIN overrides Chrome.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Width = "phone" | "pc";
export const WIDTHS: Record<Width, { width: number; height: number; mobile: boolean }> = {
  phone: { width: 390, height: 844, mobile: true },
  pc: { width: 1280, height: 900, mobile: false },
};

/** A screen: its path, and the Backlog layout to keep before it opens (the 表示 is kept in the browser). */
export interface Screen {
  name: string;
  path: string;
  layout?: "list" | "board" | "queue";
}

/** The header's screens and the Backlog's three layouts; `task` opens the newest stage Task (`taskId`). */
export function screens(taskId: string | null): Screen[] {
  return [
    { name: "home", path: "/" },
    ...(taskId ? [{ name: "task", path: `/task/${taskId}` }] : []),
    { name: "knowledge", path: "/knowledge" },
    { name: "ledger", path: "/ledger" },
    { name: "insights", path: "/insights" },
    { name: "backlog-list", path: "/backlog", layout: "list" as const },
    { name: "backlog-board", path: "/backlog", layout: "board" as const },
    { name: "backlog-queue", path: "/backlog", layout: "queue" as const },
    { name: "resources", path: "/resources" },
    { name: "schedules", path: "/schedules" },
    { name: "approvals", path: "/approvals" },
    { name: "settings", path: "/settings" },
  ];
}

export interface Args {
  home: string | null;
  out: string | null;
  screens: string[] | null;
  widths: Width[];
  /** The most frames per screen and width (8 = about 6,000 px of a phone panel); a longer screen is cut there, and says so. */
  maxFrames: number;
}

/** The command line; an unknown flag or width throws. */
export function parseArgs(argv: string[]): Args {
  const args: Args = { home: null, out: null, screens: null, widths: ["phone", "pc"], maxFrames: 8 };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i]!, argv[i + 1]];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    if (flag === "--home") args.home = value;
    else if (flag === "--out") args.out = value;
    else if (flag === "--screens") args.screens = value.split(",").filter(Boolean);
    else if (flag === "--max-frames") {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new Error(`--max-frames needs a whole number of 1 or more: ${value}`);
      args.maxFrames = n;
    }
    else if (flag === "--widths") {
      const ws = value.split(",").filter(Boolean);
      for (const w of ws) if (!(w in WIDTHS)) throw new Error(`unknown width: ${w} (phone, pc)`);
      args.widths = ws as Width[];
    } else throw new Error(`unknown flag: ${flag}`);
    i++;
  }
  return args;
}

/** One box of an element on the page as the browser measured it (CSS px), its text, and whether it is a tab of the header. */
export interface Box {
  left: number;
  right: number;
  width: number;
  /** The width inside the padding and the border: what the text has. */
  contentWidth: number;
  height: number;
  /** How many lines its own text takes as drawn (the line boxes of its text nodes): a tall table cell holding one short line is 1. */
  textLines: number;
  fontSize: number;
  text: string;
  inHeaderTabs: boolean;
  /** Not drawn (`checkVisibility()`: inside a closed `<details>`, `display: none`). */
  hidden: boolean;
  /**
   * Inside a box below the screen's `main` that scrolls sideways only (`overflow-x: auto | scroll` and nothing to scroll
   * down: a wide table's `.table-scroll`): it does not widen the page. A box that scrolls down has `overflow-x: auto` too
   * (CSS turns the other axis to auto), so what reaches past its edge still counts.
   */
  inSideScroller: boolean;
}

/**
 * What is wrong whatever it looks like: `overflow` = elements whose right edge is past the viewport (left out: the
 * header's tabs and what sits in a box that scrolls sideways, which do not widen the page, and what is not drawn), `squeezed` = elements with their own text of two characters or more,
 * narrower than two characters of their font and with that text on four lines or more (a column of one character per
 * line). An element inside one counted is counted too.
 */
export function judge(boxes: Box[], viewport: number): { overflow: number; squeezed: number } {
  const overflow = boxes.filter((b) => !b.inHeaderTabs && !b.inSideScroller && !b.hidden && b.width > 0 && b.right > viewport + 1).length;
  const squeezed = boxes.filter((b) => {
    if (b.hidden) return false;
    return b.text.trim().length >= 2 && b.contentWidth > 0 && b.contentWidth < b.fontSize * 2 && b.textLines >= 4;
  }).length;
  return { overflow, squeezed };
}

/** A bar (a `header`) as drawn: the width its items may take, the gap between them, and its items in their order. */
export interface Band {
  width: number;
  gap: number;
  items: Array<{ top: number; bottom: number; width: number }>;
}

/**
 * Rows a bar takes beyond what its items need (2026-11-07: the phone's header took a third row for 救援画面 alone, and
 * a fourth beside 新しい版). Taken: the tall items (the tabs; 80 % of the tallest or more) make the rows, top first,
 * an item starting above a row's bottom joining it; a shorter item (a link centred on the bar) touching no row takes
 * one of its own. Needed: the items in their order, put on a row while they fit the bar's width with its gap between
 * them. A row an item cannot share (wider than the bar) is needed too.
 */
export function extraRows(band: Band): number {
  const tallest = Math.max(0, ...band.items.map((it) => it.bottom - it.top));
  const rows: Array<{ top: number; bottom: number }> = [];
  for (const it of [...band.items].filter((it) => it.bottom - it.top >= tallest * 0.8).sort((a, b) => a.top - b.top)) {
    const row = rows.at(-1);
    if (row && it.top < row.bottom) row.bottom = Math.max(row.bottom, it.bottom);
    else rows.push({ top: it.top, bottom: it.bottom });
  }
  for (const it of band.items.filter((it) => it.bottom - it.top < tallest * 0.8))
    if (!rows.some((r) => it.top < r.bottom && it.bottom > r.top)) rows.push({ top: it.top, bottom: it.bottom });
  const taken = rows.length;
  let needed = 0;
  let used = Infinity;
  for (const it of band.items) {
    if (used + band.gap + it.width <= band.width + 0.5) used += band.gap + it.width;
    else (needed++, (used = it.width));
  }
  return Math.max(0, taken - needed);
}

/**
 * What the page runs to read its bars: each `header`'s items (its children, and a `nav`'s children in place of the
 * `nav`), drawn ones only, in their order. A slot held by an invisible copy (`visibility: hidden`) takes its room, so it
 * counts. The gap is the bar's own (the larger one when its items sit in a box with another).
 */
const MEASURE_BANDS = `[...document.querySelectorAll('header')].map((h) => { const st = getComputedStyle(h); const items = [...h.children].flatMap((c) => c.tagName === 'NAV' ? [...c.children] : [c]).filter((e) => e.checkVisibility()).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0).map((r) => ({ top: r.top, bottom: r.bottom, width: r.width })); return { width: h.clientWidth - (parseFloat(st.paddingLeft) || 0) - (parseFloat(st.paddingRight) || 0), gap: parseFloat(st.columnGap) || 0, items }; })`;

/**
 * `GET /api/daemon/release` as sb-rescue's daemon answers it with nothing newer: the copy runs without sb-rescue, so its
 * own answer (`managed: false`) would leave 救援画面 out of the header, which the daemon in use always shows.
 */
export const RELEASE_AS_MANAGED = { managed: true, rescuePage: "/rescue/", ahead: 0, busyTasks: 0, dirty: false, current: null, previous: null, state: "idle", busy: false, lastError: null, history: [], hold: null };

/** The same with a newer version to promote: the header carries 新しい版 too, its widest form. Measured once per width. */
export const RELEASE_WITH_NEW_VERSION = { ...RELEASE_AS_MANAGED, ahead: 3, head: "0123456789abcdef0123456789abcdef01234567", headSubject: "screens-audit" };

/** What the page runs to measure: every element with a box, as `Box`. */
const MEASURE = `(() => { const textLines = (e) => { const tops = new Set(); for (const n of e.childNodes) { if (n.nodeType !== 3 || !n.textContent.trim()) continue; const r = document.createRange(); r.selectNodeContents(n); for (const q of r.getClientRects()) if (q.width > 0) tops.add(Math.round(q.top)); } return tops.size; }; const sideScroller = (e) => { for (let x = e.parentElement; x && !x.matches('main, body'); x = x.parentElement) if (['auto', 'scroll'].includes(getComputedStyle(x).overflowX) && x.scrollHeight <= x.clientHeight + 1) return true; return false; }; return [...document.querySelectorAll('body *')].map((e) => {
  const r = e.getBoundingClientRect();
  const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
  const st = getComputedStyle(e);
  const inner = r.width - ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth'].reduce((a, k) => a + (parseFloat(st[k]) || 0), 0);
  return { left: r.left, right: r.right, width: r.width, contentWidth: inner, height: r.height, textLines: textLines(e), fontSize: parseFloat(getComputedStyle(e).fontSize) || 0, text: own, inHeaderTabs: !!e.closest('nav.tabs'), hidden: !e.checkVisibility(), inSideScroller: sideScroller(e) };
}).filter((b) => b.width > 0 && b.height > 0); })()`;

/**
 * The widest element that scrolls down (the page's own, or the screen's main panel; on a PC the Task list on the left
 * often scrolls further but is not the screen), the one scrolling furthest among equals, kept on window for the frames.
 */
const SCROLLER = `(() => { const els = [document.scrollingElement, ...document.querySelectorAll('*')].filter((e) => e && e.scrollHeight > e.clientHeight + 20 && getComputedStyle(e).overflowY !== 'hidden' && e.clientHeight > 300); els.sort((a, b) => (b.clientWidth - a.clientWidth) || ((b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))); window.__sc = els[0] || document.scrollingElement; return { sh: window.__sc.scrollHeight, ch: window.__sc.clientHeight }; })()`;

/** What the build of the screens reads (`apps/web` and the protocol's values it imports), from the repository's root. */
export const BUILD_INPUTS = ["apps/web/src", "apps/web/public", "apps/web/index.html", "apps/web/vite.config.ts", "packages/protocol/src"];

/** The inputs of the build changed after it, tests left out: the pictures would show the screens as they were before. */
export function staleBuild(root: string): string[] {
  const built = statSync(join(root, "apps/web/dist/index.html")).mtimeMs;
  const files = BUILD_INPUTS.map((p) => join(root, p)).filter((p) => existsSync(p)).flatMap((p) =>
    statSync(p).isDirectory() ? readdirSync(p, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => join(d.parentPath, d.name)) : [p],
  );
  return files.filter((f) => !/\.test\.tsx?$/.test(f) && statSync(f).mtimeMs > built);
}

/** How many frames page through `scrollHeight` with `clientHeight` per frame (60 px shown twice), at most `max`. */
export const frameCount = (scrollHeight: number, clientHeight: number, max = 8) => Math.max(1, Math.min(max, Math.ceil(scrollHeight / Math.max(1, clientHeight - 60))));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(import.meta.dir, "..");
  if (!existsSync(join(root, "apps/web/dist/index.html"))) throw new Error("build the screens first: bun run --cwd apps/web build");
  const stale = staleBuild(root);
  if (stale.length) throw new Error(`changed after the build (${stale.slice(0, 3).join(", ")}${stale.length > 3 ? ", …" : ""}): bun run --cwd apps/web build`);
  const chromeBin = [process.env.CHROME_BIN, "/usr/bin/google-chrome", "/usr/local/bin/chromium"].find((p) => p && existsSync(p));
  if (!chromeBin) throw new Error("Chrome not found: set CHROME_BIN");
  mkdirSync(join(homedir(), ".cache"), { recursive: true });
  const work = mkdtempSync(join(homedir(), ".cache", "switchboard.screens-audit."));
  // everything made from here (the copy, the daemon, Chrome) goes in the finally, however it ends
  let home = args.home;
  const profile = join(work, "chrome");
  let core: Awaited<ReturnType<typeof import("../packages/core/src/server.ts").startServer>> | null = null;
  let chrome: ReturnType<typeof Bun.spawn> | null = null;
  let ws: WebSocket | undefined;
  try {
    if (!home) {
      home = join(work, "home");
      mkdirSync(home);
      const live = join(homedir(), ".switchboard");
      const db = join(live, "switchboard.db");
      if (existsSync(db)) {
        const r = Bun.spawnSync(["sqlite3", db, `.backup '${join(home, "switchboard.db")}'`]);
        if (r.exitCode !== 0) throw new Error(`copying the data: ${r.stderr.toString()}`);
      }
      // what the screens show besides the database (Knowledge's notes, Insights' reports, attachments): copied too, so the
      // copy's start finds them (a missing note's index entry would be dropped) and nothing of the real ones is written
      for (const [from, to] of [[join(live, "artifacts"), join(home, "artifacts")], [join(live, "attachments"), join(home, "attachments")], [join(homedir(), "Knowledge"), join(home, "knowledge")]] as const)
        if (existsSync(from)) cpSync(from, to, { recursive: true });
    }
    const out = resolve(args.out ?? join(work, "shots"));
    mkdirSync(out, { recursive: true });
    const { loadConfig } = await import("../packages/core/src/config.ts");
    const { startServer } = await import("../packages/core/src/server.ts");
    core = await startServer(
      loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_PORT: "0", SWITCHBOARD_CANDIDATE: "1", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "no-history"), SWITCHBOARD_HISTORY_POLL_MS: "0" }),
      [],
      { port: 0, gh: async () => ({ code: 1, stdout: "", stderr: "no gh in screens-audit" }) },
    );
    const base = `http://127.0.0.1:${core.server.port}`;
    const task = core.db.listTasks().filter((t) => t.stage).sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id ?? null;
    const list = screens(task).filter((s) => !args.screens || args.screens.includes(s.name));
    chrome = Bun.spawn([chromeBin, "--headless=new", "--no-sandbox", "--no-first-run", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdout: "ignore", stderr: "ignore" });
    const until = async <T>(f: () => T | Promise<T>, label: string): Promise<NonNullable<T>> => {
      for (const end = Date.now() + 30_000; Date.now() < end; await Bun.sleep(200)) {
        const v = await f();
        if (v) return v as NonNullable<T>;
      }
      throw new Error(`timeout: ${label}`);
    };
    const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome");
    const url = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>).find((t) => t.type === "page")?.webSocketDebuggerUrl, "page");
    ws = new WebSocket(url);
    await new Promise<void>((r) => (ws!.onopen = () => r()));
    let seq = 0;
    const pending = new Map<number, (m: { result?: { result?: { value?: unknown }; data?: string } }) => void>();
    let release: object = RELEASE_AS_MANAGED;
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id) pending.get(m.id)?.(m), pending.delete(m.id);
      // the release's answer as under sb-rescue (`release`), so the header carries 救援画面 as it does in use
      else if (m.method === "Fetch.requestPaused")
        ws!.send(JSON.stringify({ id: ++seq, method: "Fetch.fulfillRequest", params: { requestId: m.params.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify(release)).toString("base64") } }));
    };
    const call = (method: string, params: object = {}) => new Promise<{ result?: { result?: { value?: unknown }; data?: string } }>((r) => { const id = ++seq; pending.set(id, r); ws!.send(JSON.stringify({ id, method, params })); });
    const evaluate = async <T>(expression: string) => (await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value as T;
    await call("Page.enable");
    await call("Runtime.enable");
    await call("Fetch.enable", { patterns: [{ urlPattern: "*/api/daemon/release*", requestStage: "Request" }] });
    for (const w of args.widths) {
      const size = WIDTHS[w];
      await call("Emulation.setDeviceMetricsOverride", { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: size.mobile });
      await call("Emulation.setTouchEmulationEnabled", { enabled: size.mobile });
      for (const s of list) {
        if (s.layout) {
          await call("Page.navigate", { url: base + "/" });
          await Bun.sleep(800);
          await evaluate(`localStorage.setItem('switchboard.backlog.view', JSON.stringify({ sort: 'default', stages: [], types: [], priorities: [], query: '', layout: '${s.layout}' }))`);
        }
        await call("Page.navigate", { url: base + s.path });
        // the screens read the daemon after they open: wait for the requests to settle
        await Bun.sleep(5000);
        const verdict = judge(await evaluate<Box[]>(MEASURE), size.width);
        const extra = ((await evaluate<Band[]>(MEASURE_BANDS)) ?? []).reduce((n, b) => n + extraRows(b), 0);
        const sc = await evaluate<{ sh: number; ch: number }>(SCROLLER);
        const needed = frameCount(sc?.sh ?? size.height, sc?.ch ?? size.height, Number.MAX_SAFE_INTEGER);
        const frames = Math.min(needed, args.maxFrames);
        for (let i = 0; i < frames; i++) {
          await evaluate(`window.__sc.scrollTop = ${i} * (window.__sc.clientHeight - 60)`);
          await Bun.sleep(300);
          const shot = await call("Page.captureScreenshot", { format: "png" });
          await Bun.write(join(out, `${w}-${s.name}-${i}.png`), Buffer.from(shot.result!.data!, "base64"));
        }
        console.log(`${w} ${s.name}: はみ出し ${verdict.overflow} / 1 字幅の縦書き ${verdict.squeezed} / 帯の余分な段 ${extra} / ${frames} 枚${needed > frames ? `（全体は ${needed} 枚分。--max-frames ${needed} で全部）` : ""}`);
      }
      // the header once more with 新しい版 in it (the screens' own answer has none): its rows and a picture
      if (list.length) {
        release = RELEASE_WITH_NEW_VERSION;
        await call("Page.navigate", { url: base + list[0]!.path });
        await Bun.sleep(5000);
        const extra = ((await evaluate<Band[]>(MEASURE_BANDS)) ?? []).reduce((n, b) => n + extraRows(b), 0);
        const shot = await call("Page.captureScreenshot", { format: "png" });
        await Bun.write(join(out, `${w}-header-new-version.png`), Buffer.from(shot.result!.data!, "base64"));
        console.log(`${w} ヘッダー（新しい版あり、${list[0]!.name}）: 帯の余分な段 ${extra}`);
        release = RELEASE_AS_MANAGED;
      }
    }
    console.log(`画面: ${out}`);
  } finally {
    ws?.close();
    chrome?.kill();
    await core?.stop();
    rmSync(profile, { recursive: true, force: true });
    // the copy of the data made here goes (about 1 GB); the pictures stay
    if (!args.home) rmSync(join(work, "home"), { recursive: true, force: true });
  }
  process.exit(0);
}

if (import.meta.main) await main();
