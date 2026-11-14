/**
 * bun scripts/post-audit.ts select [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--repo <owner/name>] — which merged PRs
 * the weekly post-merge audit reads again (PBI #4838). Prints `{ repo, period, selected: [{ pr, route, auditor, mergeSha }],
 * overflow }`; exit 0 / 2 when it could not read. Keeps nothing (the `[post-audit]` marks on the PRs are the record).
 *
 * A merged PR has one of three routes, decided from the marks that exist today: `recheck` (a recheck lifted the large PR),
 * `direct` (no main review mark: nobody read it), `review` (a main review exists). `direct` and `recheck` are all
 * candidates; `review` is a fixed number. Everything is ordered by hash of the period and the PR number (the same period
 * picks the same PRs). One run reads at most SWITCHBOARD_POST_AUDIT_MAX PRs: `direct` first, then the `review` sample
 * (reserved before the cap cuts), then `recheck` fills the rest; the PRs the cap left out are counted in `overflow`.
 * REST only: per PR the comments and pulls/<n>; the commits only for the selected ones (the auditor).
 *
 * `prompt <PR> [--repo] --dir <dir>` makes the material for one selected PR (a fresh clone at the merge commit, the diff,
 * the fixed viewpoints) and prints `{ cwd, prompt, out }` for `ops-kit job request review`. `record <PR> --out <file>
 * [--repo] [--workspace <id>] [--dry-run]` reads the reviewer's output (line 1 `pass` | `finding`, then `- <path>:<line>
 * <viewpoint> <what happens>`), posts `[post-audit] pass|finding <merge sha>` on the PR and, for a finding, files a
 * `bug` + `security` PBI unless an open PBI has the same title. `--dry-run` writes nothing and prints what it would.
 * Exit 0 / 2 (unreadable output or a failed call: no mark is written for an output it could not read).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { MARK_AUTHORS, REVIEW } from "./merge-gate";
import { mergedSince, parseMarks, period, POST_AUDIT, routeOf, spawnRun, type PrRecord, type Route, type Run } from "./merge-audit";

// the mark and the route live in merge-audit (its tally of the audit reads them too); re-exported so the audit side keeps one import
export { POST_AUDIT, routeOf, type Route };
import { currentRepo } from "./repo.ts";

export type Auditor = "claude" | "codex";

/** A merged PR with what the selection reads: the marks of merge-audit (with `reviewed`), the merge commit, whether an audit mark exists. */
export interface MergedPr extends PrRecord {
  mergeSha: string;
  audited: boolean;
}

/** The implementer is claude when a commit says `Co-Authored-By: Claude`; the audit is by the other runner. */
export function auditorOf(commits: { message: string }[]): Auditor {
  return commits.some((c) => /^Co-Authored-By: Claude/im.test(c.message)) ? "codex" : "claude";
}

export interface Selected { pr: number; route: Route; mergeSha: string }

export const DEFAULT_SAMPLE = 5;
export const DEFAULT_MAX = 15;

const rank = (since: string, until: string, n: number) => createHash("sha256").update(`${since}..${until}:${n}`).digest("hex");

/**
 * Without an audit mark, in this order, all by the smallest hash of `<since>..<until>:<PR>` (the same period picks the
 * same PRs, and a cap does not favour the oldest merges): `direct` all; `review` `sample` of them, reserved inside the cap
 * before `recheck` (only what `direct` left of `max`); then `recheck` fills the rest of `max`. `overflow` is the candidates
 * (all `direct` + `sample` `review` + all `recheck`) minus the selected.
 */
export function select(prs: MergedPr[], o: { since: string; until: string; sample: number; max: number }): { selected: Selected[]; overflow: number } {
  const routed = prs.filter((p) => !p.audited && p.mergedAt !== null).map((p) => ({ p, route: routeOf(p) }));
  const byHash = (route: Route) => routed.filter((x) => x.route === route)
    .sort((a, b) => rank(o.since, o.until, a.p.number).localeCompare(rank(o.since, o.until, b.p.number)));
  const direct = byHash("direct");
  const review = byHash("review").slice(0, o.sample);
  const recheck = byHash("recheck");
  const directTaken = direct.slice(0, o.max);
  const reviewTaken = review.slice(0, Math.max(0, o.max - directTaken.length));
  const recheckTaken = recheck.slice(0, Math.max(0, o.max - directTaken.length - reviewTaken.length));
  const taken = [...directTaken, ...reviewTaken, ...recheckTaken];
  const total = direct.length + review.length + recheck.length;
  return { selected: taken.map((x) => ({ pr: x.p.number, route: x.route, mergeSha: x.p.mergeSha })), overflow: total - taken.length };
}

/** The fixed viewpoints the audit reads (PBI: auth, secrets, input boundaries, permissions, dependencies and licences, personal data). */
export const VIEWPOINTS = ["認証", "秘密", "入力の境界", "権限", "依存とライセンス", "個人情報"] as const;

/** The audit prompt: the six viewpoints and the output shape `parseVerdict` reads. The reviewer reads in `.post-audit/diff.patch` and the clone. */
export function promptFor(a: { repo: string; pr: number; mergeSha: string; title: string }): string {
  return [
    `# マージ後の監査: ${a.repo}#${a.pr}`,
    "",
    `この作業ディレクトリは ${a.repo} をマージ commit ${a.mergeSha} で checkout した clone。PR #${a.pr}「${a.title}」の差分は .post-audit/diff.patch。`,
    "差分と、差分が触るコードの周り（呼び出し元・設定・テスト）を読み、次の観点で、マージされた変更に残った問題だけを探す。ファイルは書き換えない。",
    "",
    ...VIEWPOINTS.map((v, i) => `${i + 1}. ${v}`),
    "",
    "問題は、実際に起きる経路を示せるものだけ。好みの指摘・形式の指摘・推測だけのものは書かない。",
    "秘密の値（トークン・鍵・パスワード・認証に使える値）そのものは書かない。どのファイルのどの行にあるかと、何の値かだけを書く（出力は PR のコメントと Issue に写る）。",
    "",
    "## 出力の形",
    "1 行目は `pass`（問題なし）か `finding`（問題あり）の 1 語だけ。それ以外を 1 行目に書かない。",
    "`finding` のときは 2 行目以降に 1 件 1 行で `- <path>:<line> <観点> <何が起きるか>` を書く。",
    "",
  ].join("\n");
}

/** The first line says `pass` or `finding`; `items` are the `- ` lines after it. Anything else is null (no mark is written). */
export function parseVerdict(text: string): { verdict: "pass" | "finding"; items: string[] } | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  const verdict = first < 0 ? "" : lines[first]!.trim();
  if (verdict !== "pass" && verdict !== "finding") return null;
  const items = lines.slice(first + 1).map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter(Boolean);
  return { verdict, items };
}

export const pbiTitle = (repo: string, pr: number) => `PBI: マージ後の監査の指摘 — ${repo}#${pr}`;

/** The PBI a finding files: the title, and a body with the sections of `ops.config.json` `sections.pbi`, the speaker line and Story Points. */
export function pbiFor(a: { repo: string; pr: number; mergeSha: string; items: string[] }): { title: string; body: string } {
  const items = a.items.length > 0 ? a.items.map((i) => `- ${i}`) : ["- （指摘の行が出力に無かった。PR の `[post-audit] finding` の印と監査の出力を見る）"];
  return {
    title: pbiTitle(a.repo, a.pr),
    body: [
      "## ユーザーストーリー",
      `${a.repo} の開発者として、マージ後の監査が ${a.repo}#${a.pr}（マージ commit ${a.mergeSha}）に見つけた問題を確かめ、本物なら直したい。マージされたまま残る穴を放置しないために。`,
      "",
      "## 到達点 / 受け入れ条件",
      "監査の指摘（下）ごとに、本物か確かめ、本物なら直す。",
      ...items.map((i) => `- [ ] ${i.slice(2)}（検証: 指摘の経路を再現して直ったことを見る。本物でなければ理由を書いて閉じる）`),
      "",
      "## スコープ外",
      "- マージの取り消し・昇格の停止 — しない（直すのは通常の流れ）",
      "",
      "## 元要望",
      "なし（定期の検査 post-audit の指摘）",
      "",
      "## 出典",
      "- 誰の言葉: 定期の検査",
      `- 対象: ${a.repo}#${a.pr}、マージ commit ${a.mergeSha}。PR の \`[post-audit] finding\` の印に同じ commit がある`,
      "",
      "**Story Points**: 2",
      "**前提**: なし",
      "",
    ].join("\n"),
  };
}

const CLI = join(import.meta.dir, "../ops-kit/src/cli.ts");

/**
 * Clone at the merge commit and write the diff and the prompt under `<dir>/clone/.post-audit/`; prints the paths for the review job.
 * The prompt and the out file are inside the clone: the daemon's review job refuses a prompt or an out file outside its cwd.
 */
export async function prepare(pr: number, repo: string, dir: string, run: Run): Promise<{ cwd: string; prompt: string; out: string }> {
  const clone = join(dir, "clone");
  const pull = JSON.parse(await run(["gh", "api", `repos/${repo}/pulls/${pr}`])) as { merged_at: string | null; merge_commit_sha: string | null; title: string };
  if (!pull.merged_at || !pull.merge_commit_sha) throw new Error(`${repo}#${pr} はマージされていない`);
  await run(["gh", "repo", "clone", repo, clone, "--", "--filter=blob:none"]);
  await run(["git", "-C", clone, "checkout", "--detach", pull.merge_commit_sha]);
  const diff = await run(["gh", "pr", "diff", String(pr), "-R", repo]);
  const work = join(clone, ".post-audit");
  mkdirSync(work, { recursive: true });
  writeFileSync(join(work, "diff.patch"), diff);
  const prompt = join(work, "prompt.md");
  writeFileSync(prompt, promptFor({ repo, pr, mergeSha: pull.merge_commit_sha, title: pull.title }));
  return { cwd: clone, prompt, out: join(work, "audit-output.md") };
}

type Recorded = { repo: string; pr: number; mark: string; verdict: "pass" | "finding"; pbi: { title: string; body: string } | null; existing: number | null; dryRun: boolean };

/** The mark on the PR and, for a finding, the PBI (not when an open PBI has the same title). `dryRun` reads but writes nothing. */
export async function record(a: { pr: number; repo: string; text: string; dryRun: boolean; workspace?: string; backlogEnv?: boolean }, run: Run): Promise<Recorded> {
  const parsed = parseVerdict(a.text);
  if (!parsed) throw new Error("出力の 1 行目が pass でも finding でもない。印は書かない");
  const pull = JSON.parse(await run(["gh", "api", `repos/${a.repo}/pulls/${a.pr}`])) as { merged_at: string | null; merge_commit_sha: string | null };
  if (!pull.merged_at || !pull.merge_commit_sha) throw new Error(`${a.repo}#${a.pr} はマージされていない`);
  const mergeSha = pull.merge_commit_sha;
  const mark = `[post-audit] ${parsed.verdict} ${mergeSha}`;
  // the backlog of another repository: `--workspace` in a Task, else GH_REPO (CLAUDE.md)
  const backlog = (...args: string[]) => a.workspace ? ["bun", CLI, "backlog", ...args, "--workspace", a.workspace] : a.backlogEnv ? ["env", `GH_REPO=${a.repo}`, "bun", CLI, "backlog", ...args] : ["bun", CLI, "backlog", ...args];
  let pbi: Recorded["pbi"] = null;
  let existing: number | null = null;
  if (parsed.verdict === "finding") {
    pbi = pbiFor({ repo: a.repo, pr: a.pr, mergeSha, items: parsed.items });
    // `ops-kit backlog list --json` prints `{ items: [{ number, state, title, … }] }` (state OPEN | CLOSED)
    const open = JSON.parse(await run(backlog("list", "--label", "type:pbi", "--state", "open", "--search", pbi.title, "--json"))) as { items: { number: number; title: string; state: string }[] };
    existing = open.items.find((i) => i.state.toUpperCase() !== "CLOSED" && i.title === pbi!.title)?.number ?? null;
  }
  const result: Recorded = { repo: a.repo, pr: a.pr, mark, verdict: parsed.verdict, pbi, existing, dryRun: a.dryRun };
  if (a.dryRun) return result;
  if (pbi && existing === null) {
    const dir = mkdtempSync(join(tmpdir(), "post-audit."));
    try {
      writeFileSync(join(dir, "body.md"), pbi.body);
      await run(backlog("create", "--title", pbi.title, "--body-file", join(dir, "body.md"), "--label", "type:pbi", "--label", "bug", "--label", "security"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const lines = [mark, ...(parsed.verdict === "finding" ? ["", ...parsed.items.map((i) => `- ${i}`)] : [])];
  await run(["gh", "pr", "comment", String(a.pr), "-R", a.repo, "--body", lines.join("\n")]);
  return result;
}

const jsonLines = <T>(out: string) => out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as T);

/** The PRs merged in [since, until) with their marks (mergedSince finds them; a number that is no PR is skipped). */
export async function readMerged(p: { since: string; until: string }, run: Run, repo: string, now = Date.now()): Promise<MergedPr[]> {
  type Comment = { body: string; created_at: string; author_association: string };
  const numbers = await mergedSince(p.since.slice(0, 10), run, repo, now);
  const read = async (n: number): Promise<MergedPr | null> => {
    let pull: { merged_at: string | null; head: { sha: string }; merge_commit_sha: string | null };
    try {
      pull = JSON.parse(await run(["gh", "api", `repos/${repo}/pulls/${n}`]));
    } catch (e) {
      if (/HTTP 404/.test((e as Error).message)) return null;
      throw e;
    }
    if (!pull.merged_at || pull.merged_at < p.since || pull.merged_at >= p.until || !pull.merge_commit_sha) return null;
    const comments = jsonLines<Comment>(await run(["gh", "api", `repos/${repo}/issues/${n}/comments`, "--paginate", "-q", ".[] | {body, created_at, author_association}"]))
      .filter((c) => MARK_AUTHORS.includes(c.author_association));
    return {
      number: n, mergedAt: pull.merged_at, headSha: pull.head.sha, mergeSha: pull.merge_commit_sha, marks: parseMarks(comments),
      reviewed: comments.some((c) => REVIEW.test(c.body)), audited: comments.some((c) => POST_AUDIT.test(c.body)),
    };
  };
  const out: MergedPr[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (next < numbers.length) {
      const r = await read(numbers[next++]!);
      if (r) out.push(r);
    }
  }));
  return out.sort((a, b) => a.number - b.number);
}

const envInt = (env: Record<string, string | undefined>, name: string, dflt: number) => {
  const v = env[name];
  if (v === undefined || v === "") return dflt;
  if (!/^\d+$/.test(v)) throw new Error(`${name} は 0 以上の整数`);
  return Number(v);
};

/** The CLI; returns the exit code. `run` / `now` / `env` are injected for the tests. */
export async function main(args: string[], run: Run = spawnRun, now = Date.now(), env: Record<string, string | undefined> = process.env): Promise<number> {
  try {
    const usage = "使い方: post-audit.ts select [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--repo <owner/name>] | prompt <PR> --dir <dir> [--repo] | record <PR> --out <file> [--repo] [--workspace <id>] [--dry-run]";
    const cmd = args[0];
    if (cmd !== "select" && cmd !== "prompt" && cmd !== "record") throw new Error(usage);
    const rest = args.slice(1);
    const opt = (name: string) => {
      const i = rest.indexOf(name);
      return i >= 0 ? rest[i + 1] : undefined;
    };
    // `--repo` without a value is an error, not the current repository
    const repo = rest.includes("--repo") ? opt("--repo") ?? "" : currentRepo();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("--repo は owner/name");
    if (cmd !== "select") {
      const pr = Number(rest[0]);
      if (!Number.isInteger(pr) || pr <= 0) throw new Error(usage);
      if (cmd === "prompt") {
        const dir = opt("--dir");
        if (!dir) throw new Error(usage);
        console.log(JSON.stringify(await prepare(pr, repo, dir, run), null, 2));
      } else {
        const out = opt("--out");
        if (!out) throw new Error(usage);
        const r = await record({ pr, repo, text: readFileSync(out, "utf8"), dryRun: rest.includes("--dry-run"), workspace: opt("--workspace"), backlogEnv: repo !== currentRepo() }, run);
        if (r.existing !== null) console.error(`既にある #${r.existing}`);
        console.log(JSON.stringify(r, null, 2));
      }
      return 0;
    }
    const p = period(rest, now);
    const sample = envInt(env, "SWITCHBOARD_POST_AUDIT_SAMPLE", DEFAULT_SAMPLE);
    const max = envInt(env, "SWITCHBOARD_POST_AUDIT_MAX", DEFAULT_MAX);
    const prs = await readMerged(p, run, repo, now);
    const { selected, overflow } = select(prs, { ...p, sample, max });
    const withAuditor = [];
    for (const s of selected) {
      const commits = jsonLines<{ message: string }>(await run(["gh", "api", `repos/${repo}/pulls/${s.pr}/commits`, "--paginate", "-q", ".[] | {message: .commit.message}"]));
      withAuditor.push({ pr: s.pr, route: s.route, auditor: auditorOf(commits), mergeSha: s.mergeSha });
    }
    console.log(JSON.stringify({ repo, period: p, selected: withAuditor, overflow }, null, 2));
    return 0;
  } catch (e) {
    console.error(`読めなかった: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
