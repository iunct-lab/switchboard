#!/usr/bin/env bun
// テストの棚卸しの候補を根拠の数字つきで出す。消すかは決めない（PR のレビューで決める）。
//   bun scripts/test-audit.ts candidates [--json <file>]
//   bun scripts/test-audit.ts growth [--weeks N] [--json <file>]
// 全テストを 1 回回し（赤なら候補を出さない）、遅い・似た・赤にならないテストの上位を表で出す。--json は全件を書く。
// growth は直近 N 週（既定 5）の週の末の origin/main を数え直し、製品と道具のテスト・本体の増えを表にする。exit は常に 0。
// exit 0 = 出した / 1 = 止まった（テストが赤、実行の結果や git log を読めない） / 2 = 引数
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

export const SLOW_SECONDS = 0.1;
export const SIMILAR_JACCARD = 0.8;
export const QUIET_DAYS = 90;
export const QUIET_BODY_CHANGES = 10;
/** テストの変更がこの割合以下なら「テストが変わらない」とみなす。0 回だけを見ると、一度でも触ったテストが候補から消える。 */
export const QUIET_TEST_SHARE = 0.02;
/** これ以上のテストに触るコミットは一括の変更（全テストへの宣言の追加など）とみなし、テストの変更に数えない。 */
export const BULK_TEST_FILES = 50;
const TOP = 20;

export type TestCase = { file: string; describe: string; name: string; seconds: number };
export type Slow = TestCase & { share: number };
export type Similar = { file: string; describe: string; a: string; b: string; jaccard: number };
export type Quiet = { test: string; body: string; bodyChanges: number; testChanges: number; fixTouches: number };

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string): string => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ENTITIES[e]!);

/** `bun test --reporter=junit` の XML から testcase を読む。閉じていない・形の違う XML は空を返す。 */
export function parseJunit(xml: string): TestCase[] {
  if (!/<testsuites\b/.test(xml) || !xml.trimEnd().endsWith("</testsuites>")) return [];
  const cases: TestCase[] = [];
  for (const [, attrs = ""] of xml.matchAll(/<testcase\b((?:\s+[\w:-]+="[^"]*")*)\s*\/?>/g)) {
    const attr = (name: string) => attrs.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
    const [name, file, time] = [attr("name"), attr("file"), attr("time")];
    if (name === undefined || file === undefined || time === undefined) return [];
    cases.push({ file: decode(file), describe: decode(attr("classname") ?? ""), name: decode(name), seconds: Number(time) });
  }
  return cases;
}

/** 遅いテストを時間の降順で。share は全テストの時間に占める割合。 */
export function slowCandidates(cases: TestCase[]): Slow[] {
  const total = cases.reduce((sum, c) => sum + c.seconds, 0);
  return cases
    .filter((c) => c.seconds >= SLOW_SECONDS)
    .map((c) => ({ ...c, share: c.seconds / total }))
    .sort((a, b) => b.seconds - a.seconds);
}

const TEST_FILE = /\.test\.(tsx?)$/;

const words = (name: string): Set<string> => new Set(name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

function jaccard(a: Set<string>, b: Set<string>): number {
  const common = [...a].filter((w) => b.has(w)).length;
  const union = a.size + b.size - common;
  return union === 0 ? 0 : common / union;
}

/** 同じファイルの同じ describe で、名前の語が似ているテストの組を似ている順に。 */
export function similarCandidates(cases: TestCase[]): Similar[] {
  const groups = new Map<string, TestCase[]>();
  for (const c of cases) {
    const key = `${c.file}\0${c.describe}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const pairs: Similar[] = [];
  for (const group of groups.values()) {
    const named = group.map((c) => ({ c, set: words(c.name) }));
    named.forEach(({ c, set }, i) => {
      for (const other of named.slice(i + 1)) {
        const value = jaccard(set, other.set);
        if (value >= SIMILAR_JACCARD) pairs.push({ file: c.file, describe: c.describe, a: c.name, b: other.c.name, jaccard: value });
      }
    });
  }
  return pairs.sort((a, b) => b.jaccard - a.jaccard);
}

/**
 * 本体が since 以降によく変わるのにテストがほとんど変わらず、履歴全体で fix のコミットにも入っていない組を、本体の変更の多い順に。
 * log は `git log --format=%x00%ct%x20%s --name-only`（全履歴）。since は epoch 秒。
 */
export function quietCandidates(files: string[], log: string, since: number): Quiet[] {
  const changes = new Map<string, number>();
  const fixes = new Map<string, number>();
  for (const entry of log.split("\0").slice(1)) {
    const [head = "", ...lines] = entry.split("\n");
    const at = Number(head.split(" ", 1)[0]);
    const paths = new Set(lines.map((p) => p.trim()).filter(Boolean));
    if ([...paths].filter((p) => TEST_FILE.test(p)).length >= BULK_TEST_FILES) continue;
    for (const path of paths) {
      if (at >= since) changes.set(path, (changes.get(path) ?? 0) + 1);
      if (/fix/i.test(head)) fixes.set(path, (fixes.get(path) ?? 0) + 1);
    }
  }
  return files
    .map((test) => {
      const body = test.replace(TEST_FILE, ".$1");
      return { test, body, bodyChanges: changes.get(body) ?? 0, testChanges: changes.get(test) ?? 0, fixTouches: fixes.get(test) ?? 0 };
    })
    .filter((q) => q.bodyChanges >= QUIET_BODY_CHANGES && q.testChanges / q.bodyChanges <= QUIET_TEST_SHARE && q.fixTouches === 0)
    .sort((a, b) => b.bodyChanges - a.bodyChanges);
}

const table = (title: string, head: string[], rows: string[][], total: number): string =>
  [`## ${title}（${total} 件）`, `| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.slice(0, TOP).map((r) => `| ${r.join(" | ")} |`)].join("\n");

export function formatCandidates(slow: Slow[], similar: Similar[], quiet: Quiet[]): string {
  return [
    table("遅い", ["秒", "割合", "ファイル", "テスト"], slow.map((s) => [s.seconds.toFixed(3), `${(s.share * 100).toFixed(2)}%`, s.file, s.name]), slow.length),
    table("似た", ["Jaccard", "ファイル", "テスト A", "テスト B"], similar.map((s) => [s.jaccard.toFixed(2), s.file, s.a, s.b]), similar.length),
    table("赤にならない", ["本体の変更", "テストの変更", "fix", "テスト"], quiet.map((q) => [String(q.bodyChanges), String(q.testChanges), String(q.fixTouches), q.test]), quiet.length),
  ].join("\n\n");
}

/** bun test の出力から、落ちたテストと件数の行だけを取り出す。 */
export const failureLines = (output: string): string[] => output.split("\n").filter((line) => line.startsWith("(fail)") || /^\s*\d+ (pass|fail|error)\b/.test(line));

async function candidates(jsonPath: string | undefined): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "switchboard.test-audit."));
  try {
    const out = join(dir, "junit.xml");
    const { SWITCHBOARD_SUPERVISED: _, ...env } = process.env;
    const run = Bun.spawn(["bun", "test", "--reporter=junit", `--reporter-outfile=${out}`], { cwd: ROOT, env, stdout: "ignore", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(run.stderr).text(), run.exited]);
    if (code !== 0) {
      console.error(`bun test が赤なので候補を出しません（exit ${code}）\n${failureLines(stderr).join("\n")}`);
      return 1;
    }
    const cases = parseJunit(readFileSync(out, "utf8"));
    if (cases.length === 0) {
      console.error("bun test の結果を読めません");
      return 1;
    }
    const log = Bun.spawnSync(["git", "log", "--format=%x00%ct%x20%s", "--name-only"], { cwd: ROOT });
    if (log.exitCode !== 0) {
      console.error(`git log が失敗しました: ${log.stderr.toString().trim()}`);
      return 1;
    }
    const slow = slowCandidates(cases);
    const similar = similarCandidates(cases);
    const quiet = quietCandidates([...new Set(cases.map((c) => c.file))], log.stdout.toString(), Date.now() / 1000 - QUIET_DAYS * 86_400);
    console.log(formatCandidates(slow, similar, quiet));
    if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify({ slow, similar, quiet }, null, 2)}\n`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type GrowthCounts = { testCases: number; testLines: number; bodyLines: number };
export type GrowthWeek = { weekEnd: string; product: GrowthCounts; tools: GrowthCounts };

const PRODUCT_DIRS = ["packages", "apps"];
const TOOL_DIRS = ["scripts", "ops-kit", "aws", "rescue"];
const WEEK_SECONDS = 7 * 86_400;

/** 直近の週で、道具のテストの行数の増えが本体（製品＋道具の本体）の行数の増えを上回ったか。2 週未満は判定できない。 */
export function growthAlert(weeks: GrowthWeek[]): { alert: boolean; toolTestLinesDelta: number; bodyLinesDelta: number } | null {
  const [prev, last] = weeks.slice(-2);
  if (weeks.length < 2 || !prev || !last) return null;
  const toolTestLinesDelta = last.tools.testLines - prev.tools.testLines;
  const bodyLinesDelta = last.product.bodyLines + last.tools.bodyLines - (prev.product.bodyLines + prev.tools.bodyLines);
  return { alert: toolTestLinesDelta > bodyLinesDelta && toolTestLinesDelta > 0, toolTestLinesDelta, bodyLinesDelta };
}

export function formatGrowth(weeks: GrowthWeek[]): string {
  const head = ["週の末", "製品 件数", "製品 テスト行", "製品 本体行", "道具 件数", "道具 テスト行", "道具 本体行"];
  const rows = weeks.map((w) => [w.weekEnd, ...[w.product, w.tools].flatMap((c) => [c.testCases, c.testLines, c.bodyLines])]);
  const verdict = growthAlert(weeks);
  const line = !verdict
    ? "判定できません（2 週以上が要ります）"
    : `${verdict.alert ? "棚卸しを早める" : "棚卸しは早めません"}: 直近の週の道具のテスト行の増え ${verdict.toolTestLinesDelta}、本体行の増え ${verdict.bodyLinesDelta}`;
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`), "", line].join("\n");
}

/** rev の時点で pathspec に当たる行の数（git grep -c の和）。 */
function grepCount(rev: string, args: string[], pathspecs: string[]): number {
  const run = Bun.spawnSync(["git", "grep", "-c", ...args, rev, "--", ...pathspecs], { cwd: ROOT });
  if (run.exitCode > 1) throw new Error(`git grep が失敗しました: ${run.stderr.toString().trim()}`);
  return run.stdout.toString().split("\n").filter(Boolean).reduce((sum, l) => sum + Number(l.slice(l.lastIndexOf(":") + 1)), 0);
}

/** rev の時点の、dirs 以下のテストの件数・テストの行数・本体の行数。テストは *.test.ts(x)、本体はそれ以外の .ts / .tsx。 */
export function countAt(rev: string, dirs: string[]): GrowthCounts {
  const glob = (...exts: string[]) => dirs.flatMap((d) => exts.map((e) => `:(glob)${d}/**/*${e}`));
  const tests = glob(".test.ts", ".test.tsx");
  const body = [...glob(".ts", ".tsx"), ":(exclude,glob)**/*.test.ts", ":(exclude,glob)**/*.test.tsx"];
  return {
    testCases: grepCount(rev, ["-E", "-e", "^[[:space:]]*(test|it)(\\.[A-Za-z]+)?\\("], tests),
    testLines: grepCount(rev, ["-e", ""], tests),
    bodyLines: grepCount(rev, ["-e", ""], body),
  };
}

function growth(weeks: number, jsonPath: string | undefined): number {
  const base = Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "origin/main"], { cwd: ROOT }).exitCode === 0 ? "origin/main" : "HEAD";
  const today = Math.floor(Date.now() / 1000 / 86_400) * 86_400 + 86_400;
  const rows: GrowthWeek[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const end = today - i * WEEK_SECONDS;
    const rev = Bun.spawnSync(["git", "rev-list", "-1", `--before=${end}`, base], { cwd: ROOT }).stdout.toString().trim();
    const zero = { testCases: 0, testLines: 0, bodyLines: 0 };
    const weekEnd = new Date((end - 1) * 1000).toISOString().slice(0, 10);
    rows.push({ weekEnd, product: rev ? countAt(rev, PRODUCT_DIRS) : zero, tools: rev ? countAt(rev, TOOL_DIRS) : zero });
  }
  console.log(formatGrowth(rows));
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify({ weeks: rows, verdict: growthAlert(rows) }, null, 2)}\n`);
  return 0;
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const usage = () => {
    console.error("usage: bun scripts/test-audit.ts candidates [--json <file>] | growth [--weeks N] [--json <file>]");
    process.exit(2);
  };
  const option = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const known = (flags: string[]) => args.length === 2 * args.filter((a) => a.startsWith("--")).length && args.every((a, i) => (i % 2 === 0 ? flags.includes(a) : !a.startsWith("--")));
  if (command === "candidates" && known(["--json"])) process.exit(await candidates(option("--json")));
  const weeks = Number(option("--weeks") ?? 5);
  if (command === "growth" && known(["--weeks", "--json"]) && Number.isInteger(weeks) && weeks >= 1) process.exit(growth(weeks, option("--json")));
  usage();
}
