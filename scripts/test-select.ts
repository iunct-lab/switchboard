#!/usr/bin/env bun
// 変更したファイルの一覧から、回すテストファイルの一覧と理由を出す。テストは実行しない。
//   bun scripts/test-select.ts <path>...        （引数が無ければ stdin から 1 行 1 パス）
// 1 行目は `full: <理由>`（全テストに倒した）か `selected: <件数>`、続けて `<テスト>  <理由>`。
// 依存は import と、テストの先頭の宣言 `// test-reads: <パスかディレクトリ（末尾 /）> …` を見る（一時ディレクトリだけなら `none`）。
// テストの共通部品（TEST_HELPERS）も倒さず、ほかのコードと同じに import の木と宣言で選ぶ。import で辿れない読み方（子プロセスなど）は `test-reads` で宣言する。
// 判定できないものは全テストに倒す（classify）。local-ci がこの出力で bun test を絞る（scripts/local-ci.ts の selectTests）。
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** 被 import 側 → import 元。キーは走査した .ts/.tsx の全部（無いキーは「今のツリーに無い」）。 */
export type ImportGraph = Map<string, string[]>;
export type Selection = { tests: string[]; reasons: Record<string, string>; full?: string };

const isCode = (p: string) => /\.tsx?$/.test(p);
export const isTest = (p: string) => /\.test\.tsx?$/.test(p);

/** workspace パッケージの名前 → ディレクトリと入口。 */
function workspaces(files: string[], read: (p: string) => string): Map<string, { dir: string; entry: string }> {
  const out = new Map<string, { dir: string; entry: string }>();
  for (const f of files) {
    if (f !== "package.json" && !f.endsWith("/package.json")) continue;
    const pkg = JSON.parse(read(f)) as { name?: string; main?: string; exports?: string | Record<string, string> };
    if (!pkg.name) continue;
    const dir = dirname(f);
    const main = (typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."]) ?? pkg.main ?? "src/index.ts";
    out.set(pkg.name, { dir, entry: normalize(join(dir, main)) });
  }
  return out;
}

/** import の書き方を実在のファイルに直す。拡張子の省略、ディレクトリの index、.js と書いた .ts。 */
function resolveFile(base: string, known: Set<string>): string | undefined {
  const js = base.match(/^(.*)\.js$/)?.[1];
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  if (js) candidates.push(`${js}.ts`, `${js}.tsx`);
  return candidates.find((c) => known.has(c));
}

/** 相対 import と workspace パッケージ名を解決して逆辺にする。外部パッケージと node: は辿らない。 */
export function buildImportGraph(files: string[], read: (p: string) => string): ImportGraph {
  const known = new Set(files);
  const packages = workspaces(files, read);
  const graph: ImportGraph = new Map();
  const code = files.filter(isCode);
  for (const f of code) graph.set(f, []);
  for (const f of code) {
    const transpiler = new Bun.Transpiler({ loader: f.endsWith("x") ? "tsx" : "ts" });
    let imports: { path: string }[];
    try {
      imports = transpiler.scanImports(read(f).replace(/^#!.*/, ""));
    } catch (e) {
      throw new Error(`${f}: ${e instanceof Error ? e.message : e}`);
    }
    for (const { path } of imports) {
      let target: string | undefined;
      if (path.startsWith(".")) {
        target = resolveFile(normalize(join(dirname(f), path)), known);
      } else {
        const name = path.split("/").slice(0, path.startsWith("@") ? 2 : 1).join("/");
        const pkg = packages.get(name);
        if (!pkg) continue;
        target = path === name ? resolveFile(pkg.entry, known) : resolveFile(normalize(join(pkg.dir, path.slice(name.length + 1))), known);
      }
      if (!target) throw new Error(`${f}: ${path} を解決できない`);
      const importers = graph.get(target) ?? [];
      if (!importers.includes(f)) importers.push(f);
      graph.set(target, importers);
    }
  }
  return graph;
}

/** テストの共通部品。全テストには倒さず、選んだ理由の行に「共通部品 <path> を読む」を付けるためだけに使う。読むテストは import の木と `test-reads` で選ぶ（漏れはタグの CI が拾う）。 */
const TEST_HELPERS = [/(^|\/)fixtures\/[^/]+\.ts$/, /(^|\/)fixture\.ts$/, /-fake-[^/]+\.ts$/, /-harness\.ts$/];

/** 宣言か import で判定する種類。ほかの拡張子は分類できない。 */
const JUDGED = /\.(tsx?|js|md|sh|ya?ml|json|html|css|txt|tmpl|service|timer)$/;

/** 依存を判定できない変更なら全テストに倒す理由を返す。 */
export function classify(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (name === "package.json" || name === "bun.lock" || name === "bunfig.toml" || /^tsconfig.*\.json$/.test(name)) return "依存の定義や設定";
  if (path.startsWith(".github/workflows/") || path === "scripts/ci.ts") return "CI の手順";
  if (path.startsWith("scripts/test-select")) return "判定の道具自体";
  return JUDGED.test(name) ? undefined : "分類できないファイル";
}

/** テストの先頭（コメント・空行・import の続く範囲）の `// test-reads:` を読む。 */
export function parseReads(src: string): string[] {
  const reads: string[] = [];
  for (const line of src.split("\n")) {
    const declared = line.match(/^\/\/ test-reads:(.*)$/);
    if (declared) reads.push(...declared[1]!.trim().split(/\s+/).filter(Boolean));
    else if (line.trim() && !/^(\/\/|#!|import\b)/.test(line)) break;
  }
  return reads;
}

const matchesRead = (path: string, read: string) => (read.endsWith("/") ? path.startsWith(read) : path === read);

/** テストがリポジトリを読みうる印。ファイルを読む道具と、外のプロセス、文字列でない動的 import。 */
const READS_FILES = /\b(readFile|readFileSync|readdir|readdirSync|existsSync|statSync|lstatSync|copyFileSync|cpSync|spawn|spawnSync|execSync|execFileSync)\b|\bBun\.(file|Glob|\$)|\$`|\bimport\((?!["'])/;
const FINDS_REPO = /import\.meta\.(dir|url)|process\.cwd\(\)/;

/** パスを読むのに宣言の無いテストと、`none` と宣言したのにリポジトリの場所を取るテストを返す。 */
export function findUndeclared(tests: Array<{ path: string; src: string }>): string[] {
  return tests
    .filter(({ src }) => {
      const reads = parseReads(src);
      if (!reads.length) return READS_FILES.test(src) || FINDS_REPO.test(src);
      return reads.includes("none") && FINDS_REPO.test(src);
    })
    .map((t) => t.path);
}

/** 今のツリーのどのファイルにも当たらない宣言を返す。古いパスと末尾 `/` の無いディレクトリは、黙ってテストを選ばなくなる。 */
export function findStaleReads(tests: Array<{ path: string; src: string }>, files: string[]): string[] {
  return tests.flatMap(({ path, src }) =>
    parseReads(src)
      .filter((r) => r !== "none" && !files.some((f) => matchesRead(f, r)))
      .map((r) => `${path}: ${r}`),
  );
}

/** 変更ファイルから逆辺を推移的にたどり、当たったテストと、たどった先を宣言で読むテストを選ぶ。判定できない変更が 1 つでもあれば全テスト。 */
export function select(changed: string[], graph: ImportGraph, tests: string[], reads: Map<string, string[]> = new Map()): Selection {
  const fulls: string[] = changed.length ? [] : ["変更の一覧が空"];
  for (const c of changed) {
    const why = classify(c) ?? (isCode(c) && !graph.has(c) ? "今のツリーに無い（消したファイルの依存は辿れない）" : undefined);
    if (why) fulls.push(`${c}: ${why}`);
  }
  if (fulls.length) {
    const full = fulls.join("; ");
    return { tests, reasons: Object.fromEntries(tests.map((t) => [t, "全テスト"])), full };
  }
  const testSet = new Set(tests);
  const reasons: Record<string, string> = {};
  for (const c of changed) {
    const tag = TEST_HELPERS.some((re) => re.test(c)) ? `共通部品 ${c} を読む: ` : "";
    const from = new Map<string, string | null>([[c, null]]);
    const queue = [c];
    for (let f = queue.shift(); f !== undefined; f = queue.shift()) {
      if (testSet.has(f) && !reasons[f]) {
        const chain = [f];
        for (let p = from.get(f); p; p = from.get(p)) chain.unshift(p);
        reasons[f] = chain.length === 1 ? `${f}（変更したテスト）` : `${tag}${chain.join(" → ")}`;
      }
      for (const [test, declared] of reads) {
        if (reasons[test] || !declared.some((r) => matchesRead(f, r))) continue;
        const chain = [f];
        for (let p = from.get(f); p; p = from.get(p)) chain.unshift(p);
        reasons[test] = `${tag}${chain.join(" → ")} ← ${test}（test-reads）`;
      }
      for (const importer of graph.get(f) ?? []) {
        if (from.has(importer)) continue;
        from.set(importer, f);
        queue.push(importer);
      }
    }
  }
  return { tests: tests.filter((t) => reasons[t]), reasons };
}

/** 依存を読めなければ、それも判定できない変更として全テストに倒す。 */
export function selectFrom(changed: string[], files: string[], read: (p: string) => string): Selection {
  const tests = files.filter(isTest).sort();
  try {
    return select(changed, buildImportGraph(files, read), tests, new Map(tests.map((t) => [t, parseReads(read(t))])));
  } catch (e) {
    const full = `依存を読めない: ${e instanceof Error ? e.message : e}`;
    return { tests, reasons: Object.fromEntries(tests.map((t) => [t, "全テスト"])), full };
  }
}

export function formatSelection(s: Selection): string {
  const head = s.full ? `full: ${s.full}` : `selected: ${s.tests.length}`;
  return [head, ...s.tests.map((t) => `${t}  ${s.reasons[t]}`)].join("\n");
}

/** 今のツリーのファイル（追跡と未追跡。消したものは除く）。 */
export function repoFiles(root: string): string[] {
  const listed = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root }).stdout.toString();
  return listed.split("\n").filter((f) => f && existsSync(join(root, f)) && statSync(join(root, f)).isFile());
}

if (import.meta.main) {
  const changed = (process.argv.length > 2 ? process.argv.slice(2) : (await Bun.stdin.text()).split("\n")).map((l) => l.trim().replace(/^\.\//, "")).filter(Boolean);
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  console.log(formatSelection(selectFrom(changed, repoFiles(ROOT), read)));
}
