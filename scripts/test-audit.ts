#!/usr/bin/env bun
// テストの棚卸しの候補を根拠の数字つきで出す。消すかは決めない（PR のレビューで決める）。
//   bun scripts/test-audit.ts candidates [--json <file>]
// 全テストを 1 回回し（赤なら候補を出さない）、遅い・似た・赤にならないテストの上位を表で出す。--json は全件を書く。
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

if (import.meta.main) {
  const [command, flag, jsonPath, ...rest] = process.argv.slice(2);
  const valid = command === "candidates" && rest.length === 0 && (flag === undefined || (flag === "--json" && jsonPath !== undefined));
  if (!valid) {
    console.error("usage: bun scripts/test-audit.ts candidates [--json <file>]");
    process.exit(2);
  }
  process.exit(await candidates(jsonPath));
}
