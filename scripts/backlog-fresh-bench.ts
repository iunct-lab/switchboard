/**
 * bun scripts/backlog-fresh-bench.ts --issue N [--runs 20] [--set-runs N] [--set-value V]   (#3436, PBI #3362)
 *
 * Measures the running daemon (BACKLOG_URL / BACKLOG_TOKEN_FILE, as `ops-kit backlog` finds it; outside a Task,
 * BACKLOG_URL=http://127.0.0.1:<port>/api/backlog and BACKLOG_TOKEN_FILE=<token file>, and GH_REPO or BACKLOG_WORKSPACE
 * to name the workspace). `--issue` is an Issue whose Status may be written (your own Task, say).
 *  - `ops-kit backlog view <issue> --fresh` as a whole (the command a Task runs: process start, the workspace lookup,
 *    POST /sync, the read), and `POST /sync` alone with the daemon's own split in the answer's `timings` (queueMs =
 *    behind an earlier send, sendMs = this send, importMs = the import).
 *  - `ops-kit backlog set <issue> Status <value>` as a whole, and the calls it makes one by one: the workspace lookup,
 *    the Issue's detail, the lookup again, the PATCH.
 *  - The change of GitHub's GraphQL `used` (`gh api rate_limit`, which costs none) over each part; a part during which
 *    the hour's window was reset is said to be unknown, not counted (docs/design/github-api-budget.md).
 *
 * The set writes the Issue's current Status back to it, which the app stores as nothing to send (no change on GitHub);
 * `--set-value V` makes every run a real edit instead, the Status going V, current, V, … and left at the current value
 * (twice the runs reach GitHub). `--set-runs 0` leaves the set out.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { runs: { type: "string", default: "20" }, "set-runs": { type: "string" }, "set-value": { type: "string" }, issue: { type: "string" } } });
const runs = Number(values.runs);
const setRuns = values["set-runs"] === undefined ? runs : Number(values["set-runs"]);
const issue = Number(values.issue);
const base = (process.env.BACKLOG_URL ?? "").replace(/\/+$/, "");
if (!base || !(runs >= 1) || !(issue > 0)) {
  console.error("usage: BACKLOG_URL=… [BACKLOG_TOKEN_FILE=…] bun scripts/backlog-fresh-bench.ts --issue N [--runs 20] [--set-runs N] [--set-value V]");
  process.exit(2);
}
const key = process.env.BACKLOG_TOKEN_FILE ? readFileSync(process.env.BACKLOG_TOKEN_FILE, "utf8").trim() : "";

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; ms: number }> {
  const t = performance.now();
  const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, ms: performance.now() - t };
}

const sh = async (cmd: string[]) => (await new Response(Bun.spawn(cmd, { stderr: "ignore" }).stdout).text()).trim();
/** One `ops-kit` command as a Task runs it: its wall time (ms); a failure stops the bench. */
async function cli(args: string[]): Promise<number> {
  const t = performance.now();
  const p = Bun.spawn(["ops-kit", ...args], { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  if ((await p.exited) !== 0) throw new Error(`ops-kit ${args.join(" ")} が失敗: ${err.trim().slice(0, 300)}`);
  return performance.now() - t;
}

/** GraphQL's `used` and the time its window resets (`gh api rate_limit` costs none). */
const graphql = async () => {
  const [used, reset] = (await sh(["gh", "api", "rate_limit", "--jq", '.resources.graphql | "\\(.used) \\(.reset)"'])).split(" ").map(Number);
  return { used: used!, reset: reset! };
};
/** What a part spent: the difference of `used`, unless the window was reset meanwhile (then it is not known). */
const spent = (before: { used: number; reset: number }, after: { used: number; reset: number }, n: number, what: string) =>
  after.reset !== before.reset
    ? `GraphQL 消費（${what}）: 不明（計測の間に 1 時間の窓が戻った。もう一度回す）`
    : `GraphQL 消費（${what}）: ${after.used - before.used}（${n} 回で。1 回あたり ${((after.used - before.used) / n).toFixed(2)}。ほかの呼び出しも混ざる）`;

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]!;
const row = (name: string, xs: number[]) => `| ${name} | ${pct(xs, 50).toFixed(0)} | ${pct(xs, 90).toFixed(0)} | ${Math.max(...xs).toFixed(0)} |`;
const table = (title: string, rows: Array<[string, number[]]>) => console.log([`\n${title}\n`, "| 段 | 中央値 ms | p90 ms | 最大 ms |", "|---|---|---|---|", ...rows.map(([n, xs]) => row(n, xs))].join("\n"));

const wanted = process.env.BACKLOG_WORKSPACE || undefined;
const repo = wanted ? null : (process.env.GH_REPO ?? (await sh(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]))).toLowerCase();
const findWorkspace = async () => {
  const r = await api("GET", "/syncs");
  const ws = (r.json?.syncs ?? []).find((s: any) => (wanted ? s.workspaceId === wanted : s.repository?.toLowerCase() === repo));
  if (!ws) throw new Error(`workspace が見つかりません（${wanted ?? repo}）`);
  return { id: ws.workspaceId as string, ms: r.ms };
};
const wsArgs = wanted ? ["--workspace", wanted] : [];

const { id } = await findWorkspace();

// view --fresh as a Task runs it
let g = await graphql();
const view: number[] = [];
for (let i = 0; i < runs; i++) view.push(await cli(["backlog", "view", String(issue), "--fresh", ...wsArgs]));
let g2 = await graphql();
table(`ops-kit backlog view ${issue} --fresh × ${runs}`, [["全体（コマンド）", view]]);
console.log(`\n${spent(g, g2, runs, "view --fresh")}`);

// POST /sync alone, with the daemon's split
g = await graphql();
const total: number[] = [], queue: number[] = [], send: number[] = [], imp: number[] = [];
for (let i = 0; i < runs; i++) {
  const r = await api("POST", "/sync", { workspaceId: id });
  if (r.status !== 200) throw new Error(`/sync が ${r.status}: ${JSON.stringify(r.json)}`);
  const t = r.json.timings;
  if (!t) throw new Error("応答に timings がありません（デーモンがこの変更を含む版ではありません）");
  total.push(r.ms), queue.push(t.queueMs), send.push(t.sendMs), imp.push(t.importMs);
}
g2 = await graphql();
table(`POST /sync × ${runs}（--fresh の中の 1 手）`, [["全体（往復）", total], ["queueMs（前の送信を待つ）", queue], ["sendMs（GitHub への送信）", send], ["importMs（取込み）", imp]]);
console.log(`\n${spent(g, g2, runs, "/sync")}`);

if (setRuns > 0) {
  const detail = await api("GET", `/${issue}?workspaceId=${encodeURIComponent(id)}`);
  const current = detail.json?.fields?.Status;
  if (typeof current !== "string") throw new Error(`#${issue} の Status が読めません`);
  const other = values["set-value"];
  // an empty value is a clear, which `backlog set` sends otherwise (null, no detail read): not what is measured here
  if (other === "") throw new Error("--set-value に空は使えません（backlog set は空を別の経路で消す）");
  // a real edit each run (V, current, V, …), else the current value written back; the last write leaves it as it was
  const valueAt = (i: number) => (other === undefined ? current : i % 2 === 0 ? other : current);
  const what = other === undefined ? `今の値 ${current} を書き戻す（保存する操作は無い）` : `${other} と ${current} を交互に（毎回の保存）`;

  // a run that fails part way still leaves the Issue at its current value
  const restore = async () => {
    if (other === undefined) return;
    const r = await api("PATCH", `/${issue}`, { workspaceId: id, fields: { Status: current } });
    if (r.status >= 300) throw new Error(`#${issue} の Status を ${current} に戻せませんでした（PATCH が ${r.status}）。手で戻してください`);
  };
  g = await graphql();
  const whole: number[] = [];
  try {
    for (let i = 0; i < setRuns; i++) whole.push(await cli(["backlog", "set", String(issue), "Status", valueAt(i), ...wsArgs]));
  } finally {
    await restore();
  }
  g2 = await graphql();
  table(`ops-kit backlog set ${issue} Status（${what}）× ${setRuns}`, [["全体（コマンド）", whole]]);
  console.log(`\n${spent(g, g2, setRuns, "set")}`);

  // the calls `backlog set` makes, one by one (ops-kit/src/backlog-client.ts)
  const lookup: number[] = [], read: number[] = [], patch: number[] = [], calls: number[] = [];
  try {
    for (let i = 0; i < setRuns; i++) {
      const t = performance.now();
      const a = await findWorkspace();
      const d = await api("GET", `/${issue}?workspaceId=${encodeURIComponent(a.id)}`);
      const p = await api("PATCH", `/${issue}`, { workspaceId: a.id, fields: { Status: valueAt(i) } });
      if (p.status >= 300) throw new Error(`PATCH が ${p.status}: ${JSON.stringify(p.json)}`);
      lookup.push(a.ms), read.push(d.ms), patch.push(p.ms), calls.push(performance.now() - t);
    }
  } finally {
    await restore();
  }
  table(`backlog set の呼び出し × ${setRuns}`, [["全体（呼び出しの和）", calls], ["findWorkspace（GET /syncs）", lookup], ["GET /:number（数値かを見る）", read], ["PATCH", patch]]);
}
