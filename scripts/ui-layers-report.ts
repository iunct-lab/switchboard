/**
 * bun scripts/ui-layers-report.ts --metrics <file> --placement <file> --ratings <file> --out <html> [--history <path>]
 * — the monthly floor / ceiling / walls report (docs/design/ui-layers.md). Takes the measures (`ui-layers-metrics.ts`'s
 * JSON), the placement check (`ui-layers-placement.ts`'s JSON) and the three ratings the Task wrote
 * (`{"floor":"…","ceiling":"…","walls":"…"}`), each as a JSON file, and writes one self-contained HTML file (no external
 * CSS, JS or fonts: it opens in the artifact sandbox, docs/design/artifacts.md) with each measure beside the last run's.
 * The inputs go next to it as `<out>.json`. The history is one JSON line per run in `$SWITCHBOARD_HOME/ui-layers/history.jsonl`
 * (`~/.switchboard` without it); "the last run" is its last line, and this run is appended once the report is written.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { UiMetrics } from "./ui-layers-metrics.ts";

export interface HistoryEntry {
  date: string;
  metrics: UiMetrics;
}

export interface ReportInput {
  date: string;
  metrics: UiMetrics;
  previous: HistoryEntry | null;
  ratings: { floor: string; ceiling: string; walls: string };
  missing: Array<{ number: number; title: string }>;
  checked: number;
}

const LABELS: Array<[keyof UiMetrics, string]> = [
  ["homeComposeVisible", "Home の作成フォームで常に見える操作の数"],
  ["settingsSections", "Settings の節の数"],
  ["screens", "画面の数"],
  ["urlScreens", "URL で直接開ける画面の数"],
];

const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

export function renderReport(input: ReportInput): string {
  const { metrics, previous } = input;
  const rows = LABELS.map(([key, label]) => {
    const now = metrics[key];
    // a measure the last run did not have (added since) is new here too
    const last = previous?.metrics[key];
    const before = typeof last === "number" ? String(last) : "初回";
    const diff = typeof last === "number" ? signed(now - last) : "初回";
    return `<tr><td>${escape(label)}</td><td>${escape(String(now))}</td><td>${before}</td><td>${diff}</td></tr>`;
  }).join("\n");
  const missing = input.missing.length
    ? `<ul>${input.missing.map((p) => `<li>#${p.number} ${escape(p.title)}</li>`).join("")}</ul>`
    : "<p>なし</p>";
  const since = previous ? `前回: ${escape(previous.date)}` : "前回: なし（初回）";
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>床・天井・壁の点検 ${escape(input.date)}</title>
<style>
body { font-family: system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
table { border-collapse: collapse; }
th, td { border: 1px solid #999; padding: .3rem .6rem; text-align: left; }
td:not(:first-child) { text-align: right; }
</style>
</head>
<body>
<h1>床・天井・壁の点検 ${escape(input.date)}</h1>
<p>${since}</p>
<h2>床（Low Floor）</h2>
<p>${escape(input.ratings.floor)}</p>
<h2>天井（High Ceiling）</h2>
<p>${escape(input.ratings.ceiling)}</p>
<h2>壁（Wide Walls）</h2>
<p>${escape(input.ratings.walls)}</p>
<h2>指標</h2>
<table>
<tr><th>指標</th><th>今回</th><th>前回</th><th>差</th></tr>
${rows}
</table>
<h2>置き場所の行が無い画面の PBI</h2>
<p>期間内に閉じた画面の PBI ${input.checked} 件のうち ${input.missing.length} 件</p>
${missing}
</body>
</html>
`;
}

/** The last run in the history, or null; a broken last line (a write cut short) is skipped for the one before it. */
export function lastHistory(path: string): HistoryEntry | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]!) as HistoryEntry;
    } catch {
      continue;
    }
  }
  return null;
}

export function appendHistory(path: string, entry: HistoryEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export const defaultHistoryPath = (env: Record<string, string | undefined>): string =>
  join(env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard"), "ui-layers", "history.jsonl");

/** Writes the report and its inputs, then appends this run to the history (nothing is appended when a step throws). */
export function writeReport(opts: { metrics: UiMetrics; placement: { checked: number; missing: Array<{ number: number; title: string }> }; ratings: ReportInput["ratings"]; out: string; history: string; date: string }): ReportInput {
  const input: ReportInput = { date: opts.date, metrics: opts.metrics, previous: lastHistory(opts.history), ratings: opts.ratings, missing: opts.placement.missing, checked: opts.placement.checked };
  writeFileSync(opts.out, renderReport(input));
  writeFileSync(`${opts.out.replace(/\.html?$/, "")}.json`, `${JSON.stringify(input, null, 2)}\n`);
  appendHistory(opts.history, { date: opts.date, metrics: opts.metrics });
  return input;
}

/** Today in the host's time zone, YYYY-MM-DD. */
const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const [metrics, placement, ratings, out] = ["--metrics", "--placement", "--ratings", "--out"].map(arg);
  if (!metrics || !placement || !ratings || !out) {
    console.error("usage: bun scripts/ui-layers-report.ts --metrics <file> --placement <file> --ratings <file> --out <html> [--history <path>]");
    process.exit(2);
  }
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const history = arg("--history") ?? defaultHistoryPath(process.env);
  writeReport({ metrics: read(metrics), placement: read(placement), ratings: read(ratings), out, history, date: today() });
  console.log(out);
}
