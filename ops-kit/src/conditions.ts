/**
 * Text that depends on a condition (which runner implements, how review is configured, whether the reader is the app's
 * Task, …) is written once in its source with both sides marked, and whoever hands the text to a runner renders it with
 * the conditions it knows, so the runner reads only its side (docs/design/skill-sync.md, "Splitting text by condition").
 *
 * The marks are whole lines:
 *
 *     <!-- when review=same -->
 *     …lines kept only when review is same…
 *     <!-- end when -->
 *
 * Several `key=value` in one mark are all required (AND). There is no nesting and no else: the other side is its own block.
 */

/** The conditions and their values. A new condition is one line here, and a value passed where the text is rendered. */
export const CONDITION_KEYS = {
  /** The runner that implements (the Task's runner). */
  runner: ["claude", "codex"],
  /** The review setting: the main reviewer is a new session of the same runner, or the other runner. */
  review: ["same", "other"],
  /** The recheck and post-merge audit setting: a new session of the main reviewer's runner, or a runner other than the main review's. */
  recheck: ["same", "other"],
  /** The main reviewer; follows from `runner` and `review` (`primaryReviewer`). */
  reviewer: ["claude", "codex"],
  /** Whether the reader is a Task the app started (`in`) or a session outside it (`out`). */
  task: ["in", "out"],
  /** Where the backlog is: issues and a Project on GitHub, or only the app's store (`app`; the kit names no app). */
  backlog: ["github", "app"],
  /** Whether the repository's `ops.config.json` names a merge gate. */
  mergeGate: ["on", "off"],
  /** Whether the repository's `ops.config.json` names an extra reviewer. */
  extra: ["on", "off"],
} as const;

export type ConditionKey = keyof typeof CONDITION_KEYS;
export type Conditions = { [K in ConditionKey]?: (typeof CONDITION_KEYS)[K][number] };

/** The main reviewer of a Task's PR: the Task's own runner when the setting is `same`, the other one otherwise. Null for a runner that reviews nothing. */
export function primaryReviewer(runner: string, review: "same" | "other"): "claude" | "codex" | null {
  if (runner !== "claude" && runner !== "codex") return null;
  return review === "same" ? runner : runner === "claude" ? "codex" : "claude";
}

/** Phrases that say a text depends on a condition; outside a block they must be listed in the inventory (`unmarkedConditions`). */
export const CONDITION_PHRASES: Partial<Record<ConditionKey, RegExp>> = {
  task: /アプリの Task の(中|外)|Task の(中|外)では/,
  backlog: /GitHub 連携|GitHub を使わない|ローカルのバックログ/,
  mergeGate: /mergeGate/,
  extra: /<extra>|追加のレビュアー/,
  review: /OPS_KIT_REVIEW_RUNNER|別のランナー|別ランナー/,
  recheck: /OPS_KIT_RECHECK_RUNNER/,
};

const OPEN = /^\s*<!-- when (\S.*?) -->\s*$/;
const CLOSE = /^\s*<!-- end when -->\s*$/;
const LOOKS_LIKE_MARK = /<!--\s*(end\s+)?when\b/;

export type ConditionLine = { line: number; text: string; when: Conditions | null; mark: boolean };

/** Every line with the block it is in (`when`; null outside a block). `mark` lines are the marks themselves. Throws `<path>:<line>: <reason>` on a broken mark. */
export function parseConditions(text: string, path: string): ConditionLine[] {
  const out: ConditionLine[] = [];
  let open: { when: Conditions; line: number } | null = null;
  const fail = (line: number, why: string): never => {
    throw new Error(`${path}:${line}: ${why}`);
  };
  text.split("\n").forEach((raw, i) => {
    const line = i + 1;
    const o = OPEN.exec(raw);
    if (o) {
      if (open) fail(line, `入れ子の印（${open.line} 行目の塊が閉じていない）`);
      const when: Partial<Record<ConditionKey, string>> = {};
      for (const pair of o[1]!.split(/\s+/)) {
        const [key, value, ...rest] = pair.split("=");
        const values = (CONDITION_KEYS as Record<string, readonly string[]>)[key ?? ""];
        if (!values || rest.length) fail(line, `知らない条件: ${pair}（キーは ${Object.keys(CONDITION_KEYS).join(" / ")}）`);
        if (!values!.includes(value ?? "")) fail(line, `知らない値: ${pair}（${key} は ${values!.join(" / ")}）`);
        if (key! in when) fail(line, `同じキーが 2 回ある: ${key}`);
        when[key as ConditionKey] = value!;
      }
      open = { when: when as Conditions, line };
      out.push({ line, text: raw, when: open.when, mark: true });
    } else if (CLOSE.test(raw)) {
      if (!open) fail(line, "開きの無い閉じの印");
      out.push({ line, text: raw, when: open!.when, mark: true });
      open = null;
    } else {
      if (LOOKS_LIKE_MARK.test(raw)) fail(line, "印の書式が違う（行全体で `<!-- when key=value -->` か `<!-- end when -->`）");
      out.push({ line, text: raw, when: open?.when ?? null, mark: false });
    }
  });
  if (open) fail((open as { line: number }).line, "閉じの無い印");
  return out;
}

/**
 * The text with only the blocks that match `conds`: a matching block keeps its lines without the marks, any other block
 * goes with its marks. A block that names a key `conds` does not give throws (the caller must know every condition
 * its text uses). A blank line left next to another by a removed mark or block is dropped.
 */
export function renderConditions(text: string, conds: Conditions, path: string): string {
  const out: string[] = [];
  let cut = false; // a mark or a dropped line since the last line written
  for (const l of parseConditions(text, path)) {
    if (l.when) {
      for (const k of Object.keys(l.when) as ConditionKey[]) if (conds[k] === undefined) throw new Error(`${path}:${l.line}: 条件 ${k} の値が渡されていない`);
    }
    if (l.mark || (l.when && !(Object.keys(l.when) as ConditionKey[]).every((k) => conds[k] === l.when![k]))) {
      cut = true;
      continue;
    }
    if (cut && l.text.trim() === "" && (out.length === 0 || out[out.length - 1]!.trim() === "")) continue;
    out.push(l.text);
    cut = false;
  }
  return out.join("\n");
}

/** Every combination of the values of the keys the text uses (one empty combination when it uses none). */
export function combinations(text: string, path = "(text)"): Conditions[] {
  const keys = [...new Set(parseConditions(text, path).flatMap((l) => (l.mark && l.when ? Object.keys(l.when) : [])))] as ConditionKey[];
  return keys.reduce<Conditions[]>((acc, k) => acc.flatMap((c) => (CONDITION_KEYS[k] as readonly string[]).map((v) => ({ ...c, [k]: v }) as Conditions)), [{}]);
}

/**
 * What is wrong with the marks of a text (empty = nothing): a broken mark, a combination whose rendering has no
 * frontmatter when another's has one (the whole frontmatter put inside a block), or a combination whose rendering has a
 * frontmatter (`---` … `---` at the top) without exactly one line of each key in `once` (a skill: `name`, `description`;
 * a block inside the frontmatter must leave each of them once on every side).
 */
export function checkConditions(text: string, path: string, once: string[] = []): string[] {
  let combos: Conditions[];
  try {
    combos = combinations(text, path);
  } catch (e) {
    return [(e as Error).message];
  }
  const errors: string[] = [];
  const rendered = combos.map((c) => ({ c, lines: renderConditions(text, c, path).split("\n") }));
  // a frontmatter inside a block is there for some values only: the others would be a file with no name
  const some = rendered.some((r) => r.lines[0] === "---");
  for (const { c, lines } of rendered) {
    const label = Object.entries(c).map(([k, v]) => `${k}=${v}`).join(" ") || "印なし";
    if (lines[0] !== "---") {
      if (some) errors.push(`${path}: frontmatter が無い（${label}）`);
      continue;
    }
    const end = lines.indexOf("---", 1);
    if (end < 0) {
      errors.push(`${path}: frontmatter が閉じていない（${label}）`);
      continue;
    }
    for (const key of once) {
      const n = lines.slice(1, end).filter((l) => l.startsWith(`${key}:`)).length;
      if (n !== 1) errors.push(`${path}: frontmatter の ${key}: が ${n} 行（${label}。条件ごとに 1 行）`);
    }
  }
  return errors;
}

/** Lines outside every block that hold a phrase of `CONDITION_PHRASES`: conditional text not split by a mark. */
export function unmarkedConditions(text: string, path: string): Array<{ key: ConditionKey; line: number; text: string }> {
  const hits: Array<{ key: ConditionKey; line: number; text: string }> = [];
  for (const l of parseConditions(text, path)) {
    if (l.when) continue;
    for (const [key, re] of Object.entries(CONDITION_PHRASES) as Array<[ConditionKey, RegExp]>) if (re.test(l.text)) hits.push({ key, line: l.line, text: l.text });
  }
  return hits;
}
