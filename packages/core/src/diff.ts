/**
 * Unified diff of two texts (line LCS; the inputs here are small: config files and staged edits).
 */
export function unifiedDiff(a: string, b: string, path: string, context = 3): string {
  if (a === b) return "";
  const split = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));
  const al = split(a);
  const bl = split(b);
  const aNoNl = a !== "" && !a.endsWith("\n");
  const bNoNl = b !== "" && !b.endsWith("\n");
  const n = al.length;
  const m = bl.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = al[i] === bl[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  type Op = { t: " " | "-" | "+"; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && al[i] === bl[j]) ops.push({ t: " ", s: al[i]!, ai: i++, bi: j++ });
    else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) ops.push({ t: "-", s: al[i]!, ai: i++, bi: j });
    else ops.push({ t: "+", s: bl[j]!, ai: i, bi: j++ });
  }
  // A change only in the final newline: the last line is the same text; mark it as changed so the diff is not empty.
  if (!ops.some((o) => o.t !== " ") && aNoNl !== bNoNl && ops.length) {
    const last = ops.pop()!;
    ops.push({ t: "-", s: last.s, ai: last.ai, bi: last.bi }, { t: "+", s: last.s, ai: last.ai, bi: last.bi });
  }
  if (!ops.some((o) => o.t !== " ")) return "";
  const lines = [`--- a/${path}`, `+++ b/${path}`];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.t === " ") {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let last = k;
    let end = k + 1;
    while (end < ops.length && end - last <= 2 * context) {
      if (ops[end]!.t !== " ") last = end;
      end++;
    }
    end = Math.min(ops.length, last + context + 1);
    const hunk = ops.slice(start, end);
    const aLen = hunk.filter((o) => o.t !== "+").length;
    const bLen = hunk.filter((o) => o.t !== "-").length;
    const aStart = aLen === 0 ? hunk[0]!.ai : hunk[0]!.ai + 1;
    const bStart = bLen === 0 ? hunk[0]!.bi : hunk[0]!.bi + 1;
    lines.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (let x = 0; x < hunk.length; x++) {
      const o = hunk[x]!;
      lines.push(`${o.t}${o.s}`);
      const isLastA = o.t !== "+" && o.ai === n - 1 && aNoNl;
      const isLastB = o.t !== "-" && o.bi === m - 1 && bNoNl;
      if ((o.t === "-" && isLastA) || (o.t === "+" && isLastB) || (o.t === " " && (isLastA || isLastB))) lines.push("\\ No newline at end of file");
    }
    k = end;
  }
  return lines.join("\n") + "\n";
}
