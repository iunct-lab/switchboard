/**
 * Run after `bun run --cwd apps/web build`: bun scripts/ui-text-e2e.ts --lang ja|en --out <dir> [--dist <apps/web/dist>] [screen…].
 * Requires Chrome or Chromium (`chromium` on PATH; CHROME_BIN overrides). The language switch (docs/design/ui-language.md, "Language switch"): a daemon with a
 * fake runner and fake data (a finished Task, the backlog fixture, a note, a Ledger usage), the browser's language set in
 * localStorage, and each screen's `document.body.innerText` written to `<dir>/<screen>.txt`. Comparing two runs (`diff -r`)
 * shows what a change did to the wording; `--dist` serves another build (the one before the change). The file is the screen's
 * wording, not its layout: the data directory reads `<home>`, every number `N`, and the lines are sorted with repeats
 * dropped, so clock times, timings and the order of measured rows do not show up as changes.
 * The running build's sha (Insights' `いまの起動: N:N（<sha>）`) reads `<sha>`, so two builds compare equal.
 * With `--lang en` the lines with kana or kanji are listed per screen and any one that is not expected (`EXPECTED_JA`, the
 * fixture's Issue comments) exits 1. Screens: home task backlog settings ledger knowledge insights schedules (all by default).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import type { GhRunner } from "../packages/core/src/backlog.ts";
import { importing, sending } from "../packages/core/fixtures/github-import.ts";
import type { RunnerAdapter } from "@switchboard/protocol";

const SCREENS = { home: ["/", "home"], task: ["/task/", "task"], backlog: ["/backlog", "backlog"], settings: ["/settings", "settings"], ledger: ["/ledger", "ledger"], knowledge: ["/knowledge", "knowledge"], insights: ["/insights", "evals-screen"], schedules: ["/schedules", "schedules"] } as const;
type Screen = keyof typeof SCREENS;
/** A screen's text as its wording: the data directory as `<home>`, numbers as `N`, lines sorted without repeats, blanks or lone paths. */
export function wording(text: string, home: string): string[] {
  const lines = text.split("\n").map((l) => l.split(home).join("<home>").replace(/\b(?=[0-9]*[a-f])[0-9a-f]{7,40}\b/g, "<sha>").replace(/\d+/g, "N").trimEnd()).filter((l) => l.trim() && !/^\/\S*$/.test(l.trim())); // a line that is only a path (Insights' slowest API routes) is data
  return [...new Set(lines)].sort();
}
/** A line a reader of English only cannot read: kana or kanji in it. */
export const JAPANESE = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u;
/** Lines that stay Japanese in English mode on purpose: the Language card names Japanese in Japanese, as language pickers do. */
const ENDONYMS = new Set(["日本語"]);
/**
 * Japanese that English mode shows on purpose (docs/design/ui-language.md, "What switches"): a line containing one of these is
 * expected. Each is a value the daemon builds or sends, not the web UI's wording. A new entry needs its reason here.
 */
const EXPECTED_JA: Array<[text: string, why: string]> = [
  ["既定。前回このリポジトリで使ったランナーがあればそれを優先する", "routing reason from packages/core/config/routing.yaml (daemon-built, not switched)"],
  ["床・天井・壁の点検", "the schedule title the daemon seeds (packages/core/src/server.ts)"],
  ["使用上限がリセットされました。中断した箇所から作業を続けてください。", "the default auto-resume prompt, sent to a Task (packages/core/src/ratelimit.ts)"],
  ["[Switchboard 自動再開]", "the auto-resume marker, compared by the daemon (packages/core/src/evals.ts)"],
];

const { values, positionals } = parseArgs({ args: Bun.argv.slice(2), options: { lang: { type: "string" }, out: { type: "string" }, dist: { type: "string" } }, allowPositionals: true });
const lang = values.lang;
if ((lang !== "ja" && lang !== "en") || !values.out) {
  console.error("usage: bun scripts/ui-text-e2e.ts --lang ja|en --out <dir> [--dist <apps/web/dist>] [screen…]");
  process.exit(2);
}
const unknown = positionals.filter((s) => !(s in SCREENS));
if (unknown.length) {
  console.error(`unknown screen: ${unknown.join(" ")} (${Object.keys(SCREENS).join(" ")})`);
  process.exit(2);
}
const screens = (positionals.length ? positionals : Object.keys(SCREENS)) as Screen[];
const out = resolve(values.out);
mkdirSync(out, { recursive: true });

const fixtures = join(import.meta.dir, "..", "packages", "core", "fixtures");
// The backlog fixture with English titles: Issue titles are data, not the app's wording (ui-language.md), so they must not count.
const pages = (JSON.parse(readFileSync(join(fixtures, "backlog-graphql.json"), "utf8")) as Array<{ data: { repository: { issues: { nodes: Array<{ number: number; title: string }> } } } }>).map((p) => {
  for (const n of p.data.repository.issues.nodes) n.title = `Item ${n.number}`;
  return p;
});
const decisions = readFileSync(join(fixtures, "backlog-decisions.json"), "utf8");
// The fixture's Issue comments are data written in Japanese by the workflow; the daemon parses their headings (`## 判断待ち`,
// `### 済んだこと`), so they are kept and their lines are expected in English mode.
const commentLines = new Set(
  Object.values((JSON.parse(decisions) as { data: { repository: Record<string, { comments: { nodes: Array<{ body: string }> } }> } }).data.repository)
    .flatMap((i) => i.comments.nodes.flatMap((c) => c.body.split("\n").map((l) => l.trim()))),
);
/** A Japanese line English mode shows on purpose: a whole line that is expected, or one whose Japanese is all expected text (the words around it must be English). */
const expectedJa = (line: string): boolean =>
  ENDONYMS.has(line.trim()) || commentLines.has(line.trim()) || !JAPANESE.test(EXPECTED_JA.reduce((rest, [text]) => rest.split(text).join(""), line));
const gh: GhRunner = async (args) => {
  if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
  if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
  if (args[0] === "issue") return { code: 0, stdout: "", stderr: "" };
  if (args.some((a) => a.includes("rateLimit {"))) return { code: 0, stdout: '{"data":{"rateLimit":{"remaining":0,"cost":1}}}', stderr: "" };
  if (args.some((a) => a.includes("issueOrPullRequest"))) return { code: 0, stdout: '{"data":{"repository":{}}}', stderr: "" };
  if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: decisions, stderr: "" };
  return { code: 0, stdout: JSON.stringify(args.includes("after=CURSOR1") ? pages[1] : pages[0]), stderr: "" };
};
delete process.env.SWITCHBOARD_PROJECT_URL;

// A runner that answers once, reports a usage for the Ledger and ends.
const adapter: RunnerAdapter = {
  id: "claude", detect: async () => ({ available: true }),
  start(opts, emit) {
    let exit!: (code: number | null) => void;
    const exited = new Promise<number | null>((r) => (exit = r));
    queueMicrotask(() => {
      emit({ t: "session.start", runner: "claude", runnerSessionId: "s-ui-text", cwd: opts.cwd });
      emit({ t: "message.delta", role: "assistant", text: "Done: the change is in." });
      emit({ t: "usage", source: "reported", model: "claude-sonnet-5", inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });
      emit({ t: "session.end", status: "ok" });
      exit(0);
    });
    return { send() {}, respondPermission() {}, async abort() { exit(null); }, async close() { exit(0); }, exited };
  },
};

const home = mkdtempSync(join(tmpdir(), "sb-ui-text-e2e-"));
mkdirSync(join(home, "knowledge", "notes"), { recursive: true });
writeFileSync(join(home, "knowledge", "notes", "2026-11-05-note.md"), "---\ntitle: a note\ntags: [demo]\n---\n# A note\n\nWritten in English.\n");
const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
if (values.dist) cfg.webDist = resolve(values.dist);
const core = await startServer(cfg, [adapter], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(sending(gh)) });
const base = `http://127.0.0.1:${core.server.port}`;
async function until<T>(fn: () => T | Promise<T>, label: string): Promise<NonNullable<T>> {
  const end = Date.now() + 20_000;
  while (Date.now() < end) { const value = await fn(); if (value) return value as NonNullable<T>; await Bun.sleep(50); }
  throw new Error(`Timeout: ${label}`);
}
const created = (await (await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: cfg.repoRoot, title: "Finished task", prompt: "Make the change", runner: "claude" }) })).json()) as { id: string };
await until(async () => ((await (await fetch(`${base}/api/tasks/${created.id}`)).json()) as { task: { status: string } }).task.status !== "running", "the task ends");
await fetch(`${base}/api/backlog?refresh=1`);

const profile = join(home, "chrome");
const chrome = Bun.spawn([process.env.CHROME_BIN ?? "chromium", "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,1600", "about:blank"], { stdout: "ignore", stderr: "ignore" });
let ws: WebSocket | undefined;
let failed = 0;
let expected = 0;
try {
  const port = await until(() => { try { return readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]; } catch { return null; } }, "Chrome port");
  const pageUrl = await until(async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>).find((t) => t.type === "page")?.webSocketDebuggerUrl ?? null, "Chrome page");
  ws = new WebSocket(pageUrl);
  await new Promise<void>((ok, ng) => { ws!.onopen = () => ok(); ws!.onerror = () => ng(new Error("CDP socket failed")); });
  let seq = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data));
    if (m.id) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p?.reject(new Error(JSON.stringify(m.error))) : p?.resolve(m.result); }
  };
  const call = (method: string, params: object = {}): Promise<any> => new Promise((ok, ng) => { const id = ++seq; pending.set(id, { resolve: ok, reject: ng }); ws!.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression: string) => {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call("Page.enable");
  await call("Page.navigate", { url: base });
  await until(() => evaluate(`!!document.querySelector('.main.home')`), "Home");
  await evaluate(`localStorage.setItem("switchboard.lang", ${JSON.stringify(lang)})`);
  for (const screen of screens) {
    const [path, cls] = SCREENS[screen];
    await call("Page.navigate", { url: `${base}${screen === "task" ? `${path}${created.id}` : path}` });
    await until(() => evaluate(`!!document.querySelector('.main.${cls}') && document.documentElement.lang === ${JSON.stringify(lang)}`), `${screen} opens in ${lang}`);
    await Bun.sleep(1500); // the screen's data lands after its first paint
    const text = (await evaluate(`document.body.innerText`)) as string;
    writeFileSync(join(out, `${screen}.txt`), `${wording(text, home).join("\n")}\n`);
    if (lang === "en") {
      const ja = text.split("\n").filter((l) => JAPANESE.test(l));
      const left = ja.filter((l) => !expectedJa(l));
      expected += ja.length - left.length;
      if (left.length) {
        failed += left.length;
        console.log(`${screen}: ${left.length} line(s) with Japanese`);
        for (const l of left) console.log(`  ${l}`);
      }
    }
  }
} finally {
  ws?.close();
  chrome.kill();
  await chrome.exited;
  await core.stop();
  rmSync(home, { recursive: true, force: true });
}
console.log(`${screens.length} screen(s) written to ${out}${lang === "en" ? `; ${failed} line(s) with Japanese (${expected} expected: EXPECTED_JA, the fixture's comments, 日本語)` : ""}`);
process.exit(failed ? 1 : 0);
