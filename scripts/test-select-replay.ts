#!/usr/bin/env bun
// test-select を過去の変更に当てて、選び方の分布と赤のテストの取りこぼしを出す。読むだけで何も書かない。
//   bun scripts/test-select-replay.ts [--days 14]
// 依存は今のツリーのものを使う（宣言は過去のコミットに無い）。
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildImportGraph, isTest, parseReads, select, type Selection } from "./test-select";

const ROOT = join(import.meta.dir, "..");
const REPO_FLAG = ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"];

/** `git log --format=%x00%s --name-only` を課題番号ごとにまとめる。番号の無いコミットは 1 件ずつ。 */
export function groupChanges(log: string): string[][] {
  const groups = new Map<string, Set<string>>();
  log.split("\0").slice(1).forEach((entry, i) => {
    const [subject = "", ...paths] = entry.split("\n");
    const key = subject.match(/#(\d+)/)?.[1] ?? `commit-${i}`;
    const files = groups.get(key) ?? new Set<string>();
    for (const p of paths) if (p.trim()) files.add(p.trim());
    groups.set(key, files);
  });
  return [...groups.values()].filter((g) => g.size).map((g) => [...g]);
}

export type Distribution = { groups: number; median: number; p90: number; full: number; fullRate: number };

/** 回すテスト数の分布。全テストに倒したものは数に含め、割合を別に出す。 */
export function distribution(selections: Selection[]): Distribution {
  const counts = selections.map((s) => s.tests.length).sort((a, b) => a - b);
  const at = (q: number) => counts[Math.min(counts.length - 1, Math.ceil(q * counts.length) - 1)] ?? 0;
  const full = selections.filter((s) => s.full).length;
  return { groups: counts.length, median: at(0.5), p90: at(0.9), full, fullRate: counts.length ? full / counts.length : 0 };
}

/** 記録の `(fail) a > b [1.00ms]` からテストの名前を取り出す。 */
export function failedTests(body: string): string[] {
  const names = [...body.matchAll(/^\s*\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map((m) => m[1]!.trim());
  return [...new Set(names)];
}

/** テストの名前からテストファイルを探す。名前の最後の段がソースにあるもの。見つからなければ空。 */
export function findTestFiles(name: string, tests: Array<{ path: string; src: string }>): string[] {
  const last = name.split(" > ").at(-1)!;
  return tests.filter((t) => t.src.includes(last)).map((t) => t.path);
}

type Red = { where: string; name: string; changed: string[]; rerunPassed?: boolean };
const run = (cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString() : undefined;
};

/** 読めなければ止める。空のまま進むと「赤 0 件」の成功に見える。 */
function must(cmd: string[]): string {
  const out = run(cmd);
  if (out === undefined) throw new Error(`読めない: ${cmd.join(" ")}`);
  return out;
}

/** base...head の変更。手元に無いコミットは compare API で読む。 */
function changedBetween(repo: string, base: string, head: string): string[] {
  const local = run(["git", "diff", "--name-only", `${base}...${head}`]);
  const out = local ?? run(["gh", "api", `repos/${repo}/compare/${base}...${head}`, "-q", ".files[].filename"]);
  return (out ?? "").split("\n").filter(Boolean);
}

/** local-ci の PR コメントと tag-ci の Release 本文から、`bun test` の赤を集める。 */
function collectReds(repo: string, since: string): Red[] {
  const reds: Red[] = [];
  const comments = must(["gh", "api", `repos/${repo}/issues/comments?since=${since}&per_page=100`, "--paginate", "-q", '.[]|select(.body|startswith("[local-ci] "))|{url:.issue_url,body:.body}']);
  const records = comments.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { url: string; body: string });
  const passed = new Set(records.flatMap(({ body }) => body.match(/^\[local-ci\] pass (\w+)/)?.[1] ?? []));
  for (const { url, body } of records) {
    const mark = body.match(/^\[local-ci\] fail (\w+) base=(\w+)/);
    if (!mark || !body.includes("`bun test` が exit")) continue;
    const changed = changedBetween(repo, mark[2]!, mark[1]!);
    for (const name of failedTests(body)) reds.push({ where: `PR #${url.split("/").at(-1)}`, name, changed, rerunPassed: passed.has(mark[1]!) });
  }
  const releases = must(["gh", "api", `repos/${repo}/releases?per_page=100`, "--paginate", "-q", '.[]|select(.body//""|test("\\\\[tag-ci\\\\] fail"))|select(.published_at>"' + since + '")|{tag:.tag_name,body:.body}']);
  for (const line of releases.split("\n").filter(Boolean)) {
    const { tag, body } = JSON.parse(line) as { tag: string; body: string };
    const range = body.match(/compare\/(\S+)\.\.\.(\S+)/);
    if (!range) continue;
    const changed = changedBetween(repo, range[1]!, range[2]!);
    for (const name of failedTests(body)) reds.push({ where: `tag ${tag}`, name, changed });
  }
  return reds;
}

if (import.meta.main) {
  const flag = process.argv.indexOf("--days");
  const days = flag > 0 ? Number(process.argv[flag + 1]) : 14;
  const files = (run(["git", "ls-files"]) ?? "").split("\n").filter((f) => f && existsSync(join(ROOT, f)) && statSync(join(ROOT, f)).isFile());
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  const tests = files.filter(isTest).sort();
  const graph = buildImportGraph(files, read);
  const reads = new Map(tests.map((t) => [t, parseReads(read(t))]));
  const sources = tests.map((path) => ({ path, src: read(path) }));
  const pick = (changed: string[]) => select(changed, graph, tests, reads);

  const log = run(["git", "log", `--since=${days}.days`, "--format=%x00%s", "--name-only"]) ?? "";
  const picks = groupChanges(log).map(pick);
  const d = distribution(picks);
  console.log(`変更 ${d.groups} 件（テスト ${tests.length} ファイル）: 中央値 ${d.median}、p90 ${d.p90}、全テストに倒した ${d.full} 件（${(d.fullRate * 100).toFixed(1)}%）`);
  const fullWhy = new Map<string, number>();
  for (const s of picks) for (const part of s.full?.split("; ") ?? []) {
    const why = part.includes(": ") ? part.slice(part.indexOf(": ") + 2) : part;
    fullWhy.set(why, (fullWhy.get(why) ?? 0) + 1);
  }
  for (const [why, n] of [...fullWhy].sort((a, b) => b[1] - a[1])) console.log(`  ${n}  ${why}`);

  const repo = must(["gh", ...REPO_FLAG]).trim();
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19) + "Z";
  const reds = collectReds(repo, since);
  let chosen = 0;
  let flaky = 0;
  const missed: string[] = [];
  for (const red of reds) {
    const candidates = findTestFiles(red.name, sources);
    const s = pick(red.changed);
    if (red.changed.length === 0) missed.push(`変更を読めない  ${red.where}  ${red.name}`);
    else if (candidates.length === 0) missed.push(`名前が今のテストに無い  ${red.where}  ${red.name}`);
    else if (candidates.some((c) => s.tests.includes(c))) chosen++;
    else if (red.rerunPassed) flaky++; // 同じ head の再実行で通った赤は、変更が壊したのではない
    else missed.push(`選ばれない  ${red.where}  ${candidates[0]}  ${red.name}  変更 ${red.changed.length} 件`);
  }
  console.log(`赤のテスト ${reds.length} 件: 選ばれた ${chosen} 件、選ばれないが同じ head の再実行で通った ${flaky} 件、ほか ${missed.length} 件`);
  for (const m of [...new Set(missed)]) console.log(`  ${m}`);
}
