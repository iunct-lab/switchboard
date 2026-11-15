/**
 * 既知の失敗の登録（リポジトリの root の known-failures.json）の形式と読み取り。lint と、登録を差し引く側のスクリプトが同じ読み取りを使う。
 * 登録の行: {"test":"<ファイルのパス> > <テストの題>","issue":<番号>,"until":"YYYY-MM-DD"}
 * 書式は手で検べる（scripts/ から zod が解決できないので、同じ読み取りを両方が使えるように zod を使わない）。
 */

export interface KnownFailure { test: string; issue: number; until: string }

export const KNOWN_FAILURES_FILE = "known-failures.json";

function isRealDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 配列の k 番目（0 始まり）の要素が始まる行（1 始まり）。見つからなければ 1。 */
function lineOfElement(text: string, k: number): number {
  let line = 1, depth = 0, seen = -1, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\n") line++;
    if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") { if (depth === 1 && ++seen === k) return line; depth++; }
    else if (c === "]" || c === "}") depth--;
    else if (depth === 1 && !/[\s,]/.test(c) && ++seen === k) return line;
  }
  return 1;
}

export function parseKnownFailures(json: string): KnownFailure[] {
  if (json.trim() === "") return [];
  let v: unknown;
  try { v = JSON.parse(json); } catch (e) { throw new Error(`${KNOWN_FAILURES_FILE}: not valid JSON (${(e as Error).message})`); }
  if (!Array.isArray(v)) throw new Error(`${KNOWN_FAILURES_FILE}: must be an array`);
  return v.map((row, k) => {
    const at = `${KNOWN_FAILURES_FILE}: line ${lineOfElement(json, k)}`;
    if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error(`${at}: each entry must be an object`);
    const r = row as Record<string, unknown>;
    if (typeof r.test !== "string" || r.test === "") throw new Error(`${at}: test must be a non-empty string`);
    if (typeof r.issue !== "number" || !Number.isInteger(r.issue) || r.issue <= 0) throw new Error(`${at}: issue must be a positive integer`);
    if (!isRealDate(r.until)) throw new Error(`${at}: until must be a real date as YYYY-MM-DD`);
    return { test: r.test, issue: r.issue, until: r.until };
  });
}
