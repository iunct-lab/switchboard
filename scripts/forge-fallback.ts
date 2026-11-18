/**
 * Runs one `gh` command of a PR's flow and, when GitHub cannot be used now, switches the branch to a local change:
 * `bun scripts/forge-fallback.ts --task <Task> --pbi <PBI> --head <branch> [--base main] [--pr <n>] -- <gh args…>`,
 * in the checkout, with BACKLOG_URL (the app's Task has it).
 * - gh succeeded: its output, exit 0. Nothing is made.
 * - gh failed because GitHub cannot be used for now (the kit's `outageOf`: the network did not answer, a 5xx, a rate
 *   limit with its reset time): the app is asked for a local change of the branch (`--pr`: the PR it stands in for). The
 *   app makes it only when it sees the outage itself (its own wait, or its own call: packages/core/src/forge-outage.ts) —
 *   this script's reading of one failed command decides nothing. Made: the switch is written on the Task and the PBI (kept
 *   by the app, sent to GitHub once it is back), the change's number, exit 3. A change of the branch already open is used
 *   as it is, and nothing is written again.
 * - gh failed for anything else — a wrong argument, a 422, and a 401 / 403 / 404 or a missing permission, which waiting
 *   does not mend (the token or the configuration: stop and report): its output, exit 1. Nothing is made.
 * - the switch itself could not be made (the app does not see an outage, is not reached, the Task is not stored): exit 2.
 * From exit 3 on the change goes the local way: `merge-gate.ts --change <n>` → `local-ci.ts --change <n>` →
 * `local-merge.ts <n>` — judged by the same rules as a PR. A change that stands in for a PR (`--pr`) is not merged
 * there: its review threads cannot be read. Nothing here pushes, and going back to the PR's flow is forge-resync's.
 */
import { BacklogUnknown, client, runBacklog, type Detail } from "../ops-kit/src/backlog-client.ts";
import { outageOf, responseOf, retryAtFromResponse, type GithubOutage } from "../ops-kit/src/gh.ts";

const USAGE = "usage: bun scripts/forge-fallback.ts --task <Task> --pbi <PBI> --head <枝> [--base main] [--pr <n>] -- <gh の引数…>";
/** The app's refusal of a second open change of a branch names the one there (checkLocalChange). */
const OPEN_CHANGE = /開いた変更 #(\d+)/;
const KIND: Record<GithubOutage["kind"], string> = { network: "障害", transient: "障害", primary: "上限", secondary: "上限" };

export type RunGh = (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface FallbackDeps {
  gh?: RunGh;
  env: Record<string, string | undefined>;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  log?: (s: string) => void;
  err?: (s: string) => void;
}

const spawnGh: RunGh = async (args, cwd) => {
  const p = Bun.spawn(["gh", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
};

/**
 * Why a failed gh call may mean GitHub cannot be used for now, or null: the kit's `outageOf`, nothing of its own. It only
 * decides whether the app is asked; whether a change is made is the app's own observation.
 */
export function unusable(stdout: string, stderr: string, now: number): GithubOutage["kind"] | null {
  const r = responseOf(stdout, stderr);
  const c = retryAtFromResponse(r, now);
  if (c?.kind === "auth") return null;
  // gh's line for a limit does not carry its end: whether GitHub gave one is read by the app from GitHub's own budget
  if (c?.kind === "primary" || c?.kind === "secondary") return c.kind;
  return outageOf(r, now)?.kind ?? null;
}

/** The line written on the Task and the PBI: why, and where the work goes on. */
export function switchNote(kind: GithubOutage["kind"], first: string, change: number, head: string): string {
  return `GitHub が使えないため（${KIND[kind]} ${kind}: ${first}）、ローカルの変更 L${change}（${head}）に切り替えました。レビュー・判定・マージはローカルの変更で進め、GitHub へは戻ってから送ります（force push なし）`;
}

export async function main(argv: string[], cwd: string, d: FallbackDeps): Promise<number> {
  const log = d.log ?? console.log;
  const err = d.err ?? console.error;
  const cut = argv.indexOf("--");
  const own = cut < 0 ? argv : argv.slice(0, cut);
  const ghArgs = cut < 0 ? [] : argv.slice(cut + 1);
  const opt = (flag: string) => {
    const at = own.indexOf(flag);
    return at < 0 ? undefined : own[at + 1];
  };
  const [task, pbi, head, base, pr] = [opt("--task"), opt("--pbi"), opt("--head"), opt("--base") ?? "main", opt("--pr")];
  const num = (s: string | undefined) => s !== undefined && /^\d+$/.test(s);
  const known = ["--task", "--pbi", "--head", "--base", "--pr"];
  if (!num(task) || !num(pbi) || !head || !base || (pr !== undefined && !num(pr)) || ghArgs.length === 0 || own.some((a, i) => (i % 2 === 0 ? !known.includes(a) : false)) || own.length % 2 !== 0) {
    err(USAGE);
    return 2;
  }
  const r = await (d.gh ?? spawnGh)(ghArgs, cwd);
  if (r.code === 0) {
    if (r.stdout) log(r.stdout.trimEnd());
    return 0;
  }
  const kind = unusable(r.stdout, r.stderr, (d.now ?? Date.now)());
  if (!kind) {
    err((r.stderr || r.stdout).trimEnd() || `gh ${ghArgs[0]} が exit ${r.code}`);
    // a login or permission failure is not an outage: nothing is switched, the person is told
    if (retryAtFromResponse(responseOf(r.stdout, r.stderr), (d.now ?? Date.now)())?.kind === "auth") err("GitHub の認証か権限の失敗です。待っても直らないので、ローカルの変更には切り替えません。止まって利用者に報告してください");
    return 1;
  }
  const first = (r.stderr || r.stdout).trim().split("\n")[0]!.slice(0, 200);
  try {
    // the Task as the app keeps it: its title, and the workspace everything below is written in
    const out: string[] = [];
    const errs: string[] = [];
    const code = await runBacklog(["view", task!, "--json"], d.env, { out: (s) => out.push(s), err: (s) => errs.push(s) }, { ...(d.fetch ? { fetch: d.fetch } : {}), cwd });
    if (code !== 0) throw new Error(`Task #${task} を読めない: ${errs.join(" ").trim() || `exit ${code}`}`);
    const detail = JSON.parse(out.join("\n")) as Detail;
    if (!detail.workspaceId) throw new Error("アプリの答えに workspaceId が無い（BACKLOG_URL のあるアプリの Task の中で実行する）");
    const api = client(d.env, d.fetch ?? fetch);
    const workspaceId = detail.workspaceId;
    let change: number;
    try {
      const made = (await api("POST", "", { workspaceId, title: detail.issue.title, body: `Closes #${task}\n\nGitHub が使えない間のローカルの変更（${kind}: ${first}）`, change: { head, base, ...(pr !== undefined ? { pr: Number(pr) } : {}) } })) as { number?: number | null };
      if (typeof made.number !== "number") throw new Error("変更に番号が付かなかった");
      change = made.number;
    } catch (e) {
      // the branch's change is already open (an earlier call switched): go on with it, and write nothing twice
      const open = e instanceof BacklogUnknown ? null : OPEN_CHANGE.exec((e as Error).message);
      if (!open) throw e;
      log(`L${open[1]}`);
      err(`枝 ${head} のローカルの変更 L${open[1]} が既にある（切り替え済み）。そのまま進める`);
      return 3;
    }
    const note = switchNote(kind, first, change, head);
    for (const n of new Set([Number(task), Number(pbi)])) await api("POST", `/${n}/comment`, { workspaceId, text: note });
    log(`L${change}`);
    err(note);
    return 3;
  } catch (e) {
    err(`切り替えられなかった: ${(e as Error).message}\ngh: ${first}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.cwd(), { env: process.env }));
