#!/usr/bin/env bun
// 変更したファイルの一覧から、回すテストファイルの一覧と理由を出す。テストは実行しない。
//   bun scripts/test-select.ts <path>...        （引数が無ければ stdin から 1 行 1 パス）
// 1 行目は `full: <理由>`（全テストに倒した）か `selected: <件数>`、続けて `<テスト>  <理由>`。
// 依存は import と、テストの先頭の宣言 `// test-reads: <パスかディレクトリ（末尾 /）> …` を見る（ツリー全体を読むなら `./`、一時ディレクトリだけなら `none`）。
// テストの共通部品（TEST_HELPERS）も倒さず、ほかのコードと同じに import の木と宣言で選ぶ。import で辿れない読み方（子プロセスなど）は `test-reads` で宣言する。
// 判定できないものは全テストに倒す（classify）。
// 選ぶ数を減らす規則が下にある。その代わり、import で辿れない読み方（子プロセスなど）を `test-reads` で宣言していないテストは選ばれないことが増える
// （たとえば 1 の前は、消したファイルを含む変更は全テストに倒れて、そうしたテストも回っていた）:
//   1. 消した .ts/.tsx は全テストに倒さない。読んでいたファイルは同じ変更で直っているはずで、直っていなければ buildImportGraph が「解決できない」で全テストに倒す。
//   2. `export *` を 5 行以上並べたまとめ口（今は packages/protocol/src/index.ts）を `import { a }` と名前で読むファイルは、その名前を定義している部品へ直接つなぐ。
//      まとめ口を通ると、protocol のどのファイルを変えても protocol を読む全部に届く。`import * as`・default・見つからない名前はまとめ口へつなぐ。型だけの import は辿らない（型の変更は型検査が見る）。
//   3. packages/protocol/ の変更も全テストに倒さず、ほかと同じく木をたどる（scripts/test-changed.ts）。
//   4. 組み立ての口（COMPOSITION_ROOTS: server.ts と api-test-harness.ts）に別の変更から辿り着いたら、それを直に読むテストだけを選び、それを読むほかのファイル（harness・main.ts・scripts/*-e2e.ts など）へは辿らない。
//      core のほぼ全部が server.ts に届き、約 96 件の API テストが付いてくるため。変更が口そのものなら、どこでも止めずに先まで辿る。
// 選ばれなくなったテストを拾うのはタグの CI の全テスト（docs/design/local-ci.md の「Tag CI」）。local-ci がこの出力で bun test を絞る（scripts/local-ci.ts の selectTests）。
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const ROOT = join(import.meta.dir, "..");

/** 被 import 側 → import 元。キーは走査した .ts/.tsx の全部（無いキーは今のツリーに無いファイル）。 */
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

/** `export * from` がこの行数以上並んだファイルを、部品をまとめる口とする。 */
const BARREL_MIN = 5;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `spec` の読み込みが全部 `import { a, b as c }` / `export { a } from` の形ならその名前（`type` の付いたものは除く）。`import * as`・default・副作用だけ・動的 import が 1 つでもあれば undefined。 */
export function namedImports(src: string, spec: string): string[] | undefined {
  const q = escapeRe(spec);
  const quoted = src.match(new RegExp(`["']${q}["']`, "g"))?.length ?? 0;
  const names: string[] = [];
  let statements = 0;
  for (const m of src.matchAll(new RegExp(`\\b(?:import|export)\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${q}["']`, "g"))) {
    statements++;
    if (/^\s*(?:import|export)\s+type\b/.test(m[0])) continue;
    for (const part of m[1]!.split(",")) {
      const item = part.trim();
      if (!item || /^type\s/.test(item)) continue;
      names.push(item.split(/\s+as\s+/)[0]!.trim());
    }
  }
  return statements && statements === quoted ? names : undefined;
}

/** まとめ口の部品（`export * from` の先）と、各部品とまとめ口自身が実行時に定義する名前。部品が解決できなければ undefined。 */
function barrelParts(file: string, src: string, known: Set<string>, read: (p: string) => string): { defs: Map<string, string[]>; own: Set<string> } | undefined {
  const specs = [...src.matchAll(/^\s*export\s*\*\s*from\s*["']([^"']+)["']/gm)].map((m) => m[1]!);
  if (specs.length < BARREL_MIN) return undefined;
  const defs = new Map<string, string[]>();
  for (const spec of specs) {
    const part = resolveFile(normalize(join(dirname(file), spec)), known);
    if (!part) return undefined;
    const exported = new Bun.Transpiler({ loader: part.endsWith("x") ? "tsx" : "ts" }).scan(read(part).replace(/^#!.*/, "")).exports;
    for (const name of exported) defs.set(name, [...(defs.get(name) ?? []), part]);
  }
  const own = new Set(new Bun.Transpiler({ loader: file.endsWith("x") ? "tsx" : "ts" }).scan(src).exports);
  return { defs, own };
}

/** 相対 import と workspace パッケージ名を解決して逆辺にする。外部パッケージと node: は辿らない。
 *  まとめ口（`export *` を並べたファイル）は、名前で読むファイルを、その名前を定義している部品へ直接つなぐ。 */
export function buildImportGraph(files: string[], read: (p: string) => string): ImportGraph {
  const known = new Set(files);
  const packages = workspaces(files, read);
  const graph: ImportGraph = new Map();
  const code = files.filter(isCode);
  for (const f of code) graph.set(f, []);
  const barrels = new Map<string, NonNullable<ReturnType<typeof barrelParts>>>();
  for (const f of code) {
    const parts = barrelParts(f, read(f).replace(/^#!.*/, ""), known, read);
    if (parts) barrels.set(f, parts);
  }
  const link = (target: string, importer: string) => {
    const importers = graph.get(target) ?? [];
    if (!importers.includes(importer)) importers.push(importer);
    graph.set(target, importers);
  };
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
      const barrel = barrels.get(target);
      const names = barrel ? namedImports(read(f), path) : undefined;
      if (barrel && names?.length) {
        const found = names.map((n) => [...(barrel.defs.get(n) ?? []), ...(barrel.own.has(n) ? [target] : [])]);
        if (found.every((t) => t.length)) {
          for (const t of new Set(found.flat())) link(t, f);
          continue;
        }
      }
      link(target, f);
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
  if (path === "scripts/test-preload.ts") return "全テストの前後に走る部品";
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

export const matchesRead = (path: string, read: string) => read === "./" || (read.endsWith("/") ? path.startsWith(read) : path === read);

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

/** 多くの変更が辿り着く組み立ての口。別の変更から着いたときは直に読むテストだけを選び、その先へ辿らない（頭のコメントの 4）。 */
export const COMPOSITION_ROOTS = new Set(["packages/core/src/server.ts", "packages/core/src/api-test-harness.ts"]);

/** 幅優先の 1 歩。ファイル f（変更 origin から辿って着いた）から次に進む読み手。組み立ての口では、口そのものの変更でなければテスト以外へ進まない。口そのものの変更は、もう一つの口でも止めない。 */
export function readersToFollow(f: string, origin: string, graph: ImportGraph, testSet: Set<string>): string[] {
  const stop = COMPOSITION_ROOTS.has(f) && !COMPOSITION_ROOTS.has(origin);
  return (graph.get(f) ?? []).filter((importer) => !stop || testSet.has(importer));
}

/** 変更ファイルから逆辺をたどり（組み立ての口では readersToFollow のとおり止まる）、当たったテストと、たどった先を宣言で読むテストを選ぶ。判定できない変更が 1 つでもあれば全テスト。 */
export function select(changed: string[], graph: ImportGraph, tests: string[], reads: Map<string, string[]> = new Map()): Selection {
  const fulls: string[] = changed.length ? [] : ["変更の一覧が空"];
  for (const c of changed) {
    const why = classify(c);
    if (why) fulls.push(`${c}: ${why}`);
  }
  if (fulls.length) {
    const full = fulls.join("; ");
    return { tests, reasons: Object.fromEntries(tests.map((t) => [t, "全テスト"])), full };
  }
  const testSet = new Set(tests);
  const reasons: Record<string, string> = {};
  // 今のツリーに無い .ts/.tsx（消したファイル）は import の木に辺が無いので、辿る先が無いだけで全テストには倒さない（読んでいたファイルは同じ変更で直っていて、直っていなければ buildImportGraph が解決できないと言って全テストに倒す）。`test-reads` で読むテストは選ぶ
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
      for (const importer of readersToFollow(f, c, graph, testSet)) {
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
  const p = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root });
  // 読めなかった理由を stderr に残す（選ぶ結果は変えない。一覧が空なら何も選ばれず、黙っていると理由が辿れない）。
  if (p.exitCode !== 0) console.error(`git ls-files が exit ${p.exitCode} で失敗した: ${p.stderr.toString().trim()}`);
  const listed = p.stdout.toString();
  return listed.split("\n").filter((f) => f && existsSync(join(root, f)) && statSync(join(root, f)).isFile());
}

if (import.meta.main) {
  const changed = (process.argv.length > 2 ? process.argv.slice(2) : (await Bun.stdin.text()).split("\n")).map((l) => l.trim().replace(/^\.\//, "")).filter(Boolean);
  const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
  console.log(formatSelection(selectFrom(changed, repoFiles(ROOT), read)));
}
