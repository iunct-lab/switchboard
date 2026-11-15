/**
 * 既知の失敗の登録（root の known-failures.json）を読み、テストの失敗の行から差し引く。
 * 登録の行: {"test":"<ファイルのパス> > <テストの題>","issue":<番号>,"until":"YYYY-MM-DD"}
 * 照合は `<ファイル> > <題>` の完全一致（ファイルは bun の出力の見出しの行から、題は `(fail)` 行から。failedTests）。
 * 登録の形式と読み取り（parseKnownFailures）は共通キットの ops-kit/src/known-failures.ts（lint と同じ読み取り）。
 */
import type { Deps } from "./local-ci";
import { KNOWN_FAILURES_FILE, parseKnownFailures, type KnownFailure } from "../ops-kit/src/known-failures.ts";

export { KNOWN_FAILURES_FILE, parseKnownFailures, type KnownFailure };
export interface Subtracted { /** `<ファイル> > <題>` */ test: string; issue: number; until: string }

/** `ref` のコミットの known-failures.json を読む（作業ツリーは読まない）。ref にファイルが無ければ []、ほかの失敗（ref が無いなど）は投げる。有無は git の文言でなく ls-tree で見る。 */
export async function readKnownFailures(sh: Deps["sh"], repoRoot: string, ref: string): Promise<KnownFailure[]> {
  if (!(await sh(["git", "-C", repoRoot, "ls-tree", "--name-only", ref, "--", KNOWN_FAILURES_FILE])).trim()) return [];
  return parseKnownFailures(await sh(["git", "-C", repoRoot, "show", `${ref}:${KNOWN_FAILURES_FILE}`]));
}

/**
 * bun test の出力の `(fail)` 行と、そのテストの名前 `<ファイル> > <題>`。bun は `(fail)` 行にファイルを書かない（`(fail) <describe> > <題> [<n>ms]`）。
 * ファイルは、その前に出る見出しの行 `<ファイルのパス>:` から取る。見出しの前の `(fail)` 行は題だけ（登録とは一致しない）。最後の `N tests failed:` の一覧（同じ行の繰り返し）は読まない。
 */
export function failedTests(output: string): Array<{ line: string; test: string }> {
  const out: Array<{ line: string; test: string }> = [];
  let file: string | undefined;
  for (const l of output.split("\n")) {
    // bun's closing list of the failures repeats the `(fail)` lines without headings (tag-ci's failedTestFiles stops there too)
    if (/^\d+ tests? failed:$/.test(l)) break;
    const head = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/.exec(l);
    if (head) file = head[1];
    else if (l.startsWith("(fail) ")) {
      const title = l.slice("(fail) ".length).replace(/ \[[\d.]+m?s\]$/, "");
      out.push({ line: l, test: file ? `${file} > ${title}` : title });
    }
  }
  return out;
}

/** bun の集計の ` N fail` と ` N error(s)` の合計（`bun test` を何回かに分けて回した出力も足す）。 */
function summary(output: string): { fail: number; error: number } {
  let fail = 0, error = 0;
  for (const l of output.split("\n")) {
    const f = /^ (\d+) fail$/.exec(l), e = /^ (\d+) errors?$/.exec(l);
    if (f) fail += Number(f[1]);
    if (e) error += Number(e[1]);
  }
  return { fail, error };
}

/**
 * 落ちた `bun test` の手順の出力 `output` と、その手順の失敗の行 `fails`（failLines）から、登録に当たる `(fail)` 行を差し引く。
 * until が today 以上（当日まで有効）の登録に当たる行は subtracted、過ぎた登録に当たる行は rest に残して expired にも入れる。同じテストの登録が複数あれば期限の遅い方を使う。
 * `(fail)` でない行（`over:` など）は常に rest。差し引かない（null）のは、`(fail)` 行が無いとき、bun の集計の fail の数が `(fail)` 行の数と合わないか error があるとき
 * （ファイルの読み込みの失敗やテストの間の例外は `(fail)` 行を出さないので、登録済みの行だけを見て pass にすると隠れる）。
 */
export function subtractKnown(output: string, fails: string[], known: KnownFailure[], today: string): { rest: string[]; subtracted: Subtracted[]; expired: Subtracted[] } | null {
  const failed = failedTests(output);
  const { fail, error } = summary(output);
  if (failed.length === 0 || fail !== failed.length || error > 0) return null;
  const subtracted: Subtracted[] = [], expired: Subtracted[] = [];
  const kept = new Set<string>();
  for (const { line, test } of failed) {
    const hit = known.filter((k) => k.test === test).sort((a, b) => b.until.localeCompare(a.until))[0];
    if (!hit) { kept.add(line); continue; }
    const item = { test, issue: hit.issue, until: hit.until };
    if (hit.until >= today) subtracted.push(item);
    else { kept.add(line); expired.push(item); }
  }
  return { rest: fails.filter((l) => !l.startsWith("(fail) ") || kept.has(l)), subtracted, expired };
}

/** 結果のコメント・Release に並べる節: 空行、見出し、`` - `<テスト名>`（#<番号>、期限 <日付>） ``。xs が空なら何も出さない。 */
export const knownLines = (title: string, xs: Subtracted[] | undefined): string[] =>
  xs?.length ? ["", title, ...xs.map((x) => `- \`${x.test}\`（#${x.issue}、期限 ${x.until}）`)] : [];
