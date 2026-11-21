#!/usr/bin/env bun
// test-select を過去の変更に当てて、選び方の分布と赤のテストの取りこぼしを出す。読むだけで何も書かない。
//   bun scripts/test-select-replay.ts [--days 14]   過去の変更に当てる
//   bun scripts/test-select-replay.ts --per-file     今のツリーのソースを 1 本ずつ当て、広がりの上位 20 本を出す
// 依存は今のツリーのものを使う（宣言は過去のコミットに無い）。ただし後のコミットで消えた・動いたファイル（今のツリーに無く、その変更では消していない）は、
// その変更の時点でそれを読み込んでいたファイル（今もあるもの）に置き換えて当てる（retarget）。置き換え先が無く、テストなら外す。どちらでもなければそのまま渡して全テストに倒す。
// その変更で消したファイルは依存を辿れないので、置き換えずにそのまま渡す。
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { buildImportGraph, classify, isTest, matchesRead, parseReads, select, type ImportGraph, type Selection } from "./test-select";

const ROOT = join(import.meta.dir, "..");
const REPO_FLAG = ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"];

export type ChangeGroup = { changed: string[]; deleted: string[]; commit: string };

/** `git log --format=%x00%H %s --name-status --no-renames`（新しい順）を課題番号ごとにまとめる。番号の無いコミットは 1 件ずつ。
 *  deleted は、いちばん新しい状態が消えているファイル。commit は、その課題でいちばん新しいコミット。 */
export function groupChanges(log: string): ChangeGroup[] {
  const groups = new Map<string, { changed: Set<string>; deleted: Set<string>; commit: string }>();
  log.split("\0").slice(1).forEach((entry, i) => {
    const [head = "", ...lines] = entry.split("\n");
    const space = head.indexOf(" ");
    const commit = space < 0 ? head : head.slice(0, space);
    const key = head.slice(space + 1).match(/#(\d+)/)?.[1] ?? `commit-${i}`;
    const group = groups.get(key) ?? { changed: new Set<string>(), deleted: new Set<string>(), commit };
    for (const line of lines) {
      const [status, path] = line.split("\t");
      if (!status || !path?.trim() || group.changed.has(path)) continue;
      group.changed.add(path);
      if (status === "D") group.deleted.add(path);
    }
    groups.set(key, group);
  });
  return [...groups.values()].filter((g) => g.changed.size).map((g) => ({ changed: [...g.changed], deleted: [...g.deleted], commit: g.commit }));
}

const isCode = (p: string) => /\.tsx?$/.test(p);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** commit の時点で path（拡張子を除いた名前）を読み込んでいたファイルのうち、今もあるもの。 */
export function importersAt(commit: string, path: string, has: (p: string) => boolean): string[] {
  const stem = basename(path).replace(/\.(tsx?|js)$/, "");
  const re = `from ["'][^"']*/${escapeRe(stem)}(\\.tsx?|\\.js)?["']`;
  const p = Bun.spawnSync(["git", "grep", "-l", "-E", re, commit, "--", "*.ts", "*.tsx"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = p.exitCode === 0 ? p.stdout.toString() : "";
  return out.split("\n").map((l) => l.slice(commit.length + 1)).filter((f) => f && f !== path && has(f));
}

/** 今のツリーに無く、その変更で消してもいない .ts/.tsx（後で消えた・動いたもの）を、当時の読み込み元に置き換える。
 *  読み込み元が無ければ、テストは外し、それ以外はそのまま残す（vanished に挙げ、select が全テストに倒す）。 */
export function retarget(
  group: ChangeGroup,
  has: (p: string) => boolean,
  importers: (commit: string, path: string) => string[],
): { changed: string[]; vanished: string[] } {
  const changed = new Set<string>();
  const vanished: string[] = [];
  for (const p of group.changed) {
    if (!isCode(p) || has(p) || group.deleted.includes(p)) {
      changed.add(p);
      continue;
    }
    const from = importers(group.commit, p);
    if (from.length) for (const f of from) changed.add(f);
    else if (!isTest(p)) {
      changed.add(p);
      vanished.push(p);
    }
  }
  return { changed: [...changed], vanished };
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

type Red = { where: string; name: string; group: ChangeGroup; rerunPassed?: boolean };
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
function changedBetween(repo: string, base: string, head: string): ChangeGroup {
  const local = run(["git", "diff", "--name-status", "--no-renames", `${base}...${head}`]);
  const out = local ?? run(["gh", "api", `repos/${repo}/compare/${base}...${head}`, "-q", '.files[]|(if .status=="removed" then "D" else "M" end)+"\t"+.filename']);
  const group = groupChanges(`\0${head} x\n${out ?? ""}`)[0];
  return group ?? { changed: [], deleted: [], commit: head };
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
    const group = changedBetween(repo, mark[2]!, mark[1]!);
    for (const name of failedTests(body)) reds.push({ where: `PR #${url.split("/").at(-1)}`, name, group, rerunPassed: passed.has(mark[1]!) });
  }
  const releases = must(["gh", "api", `repos/${repo}/releases?per_page=100`, "--paginate", "-q", '.[]|select(.body//""|test("\\\\[tag-ci\\\\] fail"))|select(.published_at>"' + since + '")|{tag:.tag_name,body:.body}']);
  for (const line of releases.split("\n").filter(Boolean)) {
    const { tag, body } = JSON.parse(line) as { tag: string; body: string };
    const range = body.match(/compare\/(\S+)\.\.\.(\S+)/);
    if (!range) continue;
    const group = changedBetween(repo, range[1]!, range[2]!);
    for (const name of failedTests(body)) reds.push({ where: `tag ${tag}`, name, group });
  }
  return reds;
}

const WIDE = 100;

/** source を変えたときに選ばれるテストの数を返す関数。block を渡さなければ select と同じ数。block のファイルへ着いたら、それを直に読むテストは選び、ほかの読み手へは辿らない。 */
function counter(graph: ImportGraph, tests: string[], reads: Map<string, string[]>) {
  const testSet = new Set(tests);
  const declared = new Map<string, string[]>();
  const readBy = (f: string) => {
    if (!declared.has(f)) declared.set(f, [...reads].filter(([, rs]) => rs.some((r) => matchesRead(f, r))).map(([t]) => t));
    return declared.get(f)!;
  };
  return (source: string, block?: string): number => {
    if (classify(source)) return tests.length; // 判定できない変更は全テスト
    const found = new Set<string>();
    const seen = new Set([source]);
    for (const f of seen) {
      if (testSet.has(f)) found.add(f);
      for (const t of readBy(f)) found.add(t);
      for (const i of graph.get(f) ?? []) if (f !== block || isTest(i)) seen.add(i);
    }
    return found.size;
  };
}

/** source から読み込む側へ辿って着くファイル（source 自身を除く）。 */
function reachable(source: string, graph: ImportGraph): Set<string> {
  const seen = new Set([source]);
  for (const f of seen) for (const i of graph.get(f) ?? []) seen.add(i);
  seen.delete(source);
  return seen;
}

export type PerFileRow = { file: string; through: number; stopping: number; own: number; direct: number };

/** 今のツリーのソースを 1 本ずつ当てる。WIDE 件以上になるものと、広がりの上位を返す。 */
export function perFile(sources: string[], graph: ImportGraph, tests: string[], reads: Map<string, string[]>, top = 20) {
  const count = counter(graph, tests, reads);
  const own = new Map(sources.map((s) => [s, count(s)]));
  const wide = sources.filter((s) => own.get(s)! >= WIDE);
  const through = new Map<string, string[]>();
  for (const s of wide) for (const f of reachable(s, graph)) through.set(f, [...(through.get(f) ?? []), s]);
  const rows: PerFileRow[] = [...through].filter(([f]) => !isTest(f)).map(([file, via]) => ({
    file,
    through: via.length,
    stopping: via.filter((s) => count(s, file) < WIDE).length,
    own: own.get(file) ?? count(file),
    direct: (graph.get(file) ?? []).filter(isTest).length,
  }));
  rows.sort((a, b) => b.stopping - a.stopping || b.through - a.through || a.file.localeCompare(b.file));
  return { own, wide, rows: rows.slice(0, top) };
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

  if (process.argv.includes("--per-file")) {
    const code = files.filter((f) => /\.tsx?$/.test(f) && !isTest(f));
    const { own, wide, rows } = perFile(code, graph, tests, reads);
    console.log(`1 本変えて ${WIDE} 件以上: ${wide.length} 本（ソース ${code.length} 本、テスト ${tests.length} 本）`);
    const byDir = new Map<string, number>();
    for (const f of wide) byDir.set(dirname(f), (byDir.get(dirname(f)) ?? 0) + 1);
    console.log("ディレクトリ別（多い順、上位 10）:");
    for (const [dir, n] of [...byDir].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10)) console.log(`  ${n}  ${dir}`);
    console.log(`1 本ずつの件数の中央値 ${[...own.values()].sort((a, b) => a - b)[Math.floor(own.size / 2)] ?? 0}`);
    console.log("上位 20（通る = そこを通って 100 件以上に広がるソースの数、止めると = そこを直に読むテストは選び、ほかの読み手へ辿らないと 100 件未満になるソースの数）:");
    console.log("| ファイル | 通る | 止めると | 自身の件数 | 直に読むテスト |");
    console.log("|---|---|---|---|---|");
    for (const r of rows) console.log(`| ${r.file} | ${r.through} | ${r.stopping} | ${r.own} | ${r.direct} |`);
    process.exit(0);
  }

  const present = new Set(files);
  const has = (p: string) => present.has(p);
  const cache = new Map<string, string[]>();
  const importers = (commit: string, path: string) => {
    const key = `${commit} ${path}`;
    if (!cache.has(key)) cache.set(key, importersAt(commit, path, has));
    return cache.get(key)!;
  };
  /** 変更に当てる。select が「今のツリーに無い」と言うファイルは、同じ変更で消したものと、後で消えて読み込み元も無いものに分けて理由を書く。 */
  const pickGroup = (group: ChangeGroup): Selection => {
    const { changed, vanished } = retarget(group, has, importers);
    if (!changed.length && group.changed.length) return { tests: [], reasons: {} }; // 後で消えたテストだけの変更。今のツリーで回すものは無い
    const s = pick(changed);
    if (!s.full) return s;
    const why = (part: string) => {
      const path = part.slice(0, part.indexOf(": "));
      if (!part.includes("今のツリーに無い")) return part;
      return `${path}: ${group.deleted.includes(path) ? "その変更で消した（依存は辿れない）" : vanished.includes(path) ? "後で消えて、読み込み元も無い" : "今のツリーに無い"}`;
    };
    return { ...s, full: s.full.split("; ").map(why).join("; ") };
  };

  const log = run(["git", "log", `--since=${days}.days`, "--format=%x00%H %s", "--name-status", "--no-renames"]) ?? "";
  const picks = groupChanges(log).map(pickGroup);
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
    const s = pickGroup(red.group);
    if (red.group.changed.length === 0) missed.push(`変更を読めない  ${red.where}  ${red.name}`);
    else if (candidates.length === 0) missed.push(`名前が今のテストに無い  ${red.where}  ${red.name}`);
    else if (candidates.some((c) => s.tests.includes(c))) chosen++;
    else if (red.rerunPassed) flaky++; // 同じ head の再実行で通った赤は、変更が壊したのではない
    else missed.push(`選ばれない  ${red.where}  ${candidates[0]}  ${red.name}  変更 ${red.group.changed.length} 件`);
  }
  console.log(`赤のテスト ${reds.length} 件: 選ばれた ${chosen} 件、選ばれないが同じ head の再実行で通った ${flaky} 件、ほか ${missed.length} 件`);
  for (const m of [...new Set(missed)]) console.log(`  ${m}`);
}
