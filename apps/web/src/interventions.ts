import type { InterventionReason, InterventionWindow } from "@switchboard/protocol";

/** A count that may not be known: null shows 不明 and takes part in no change (never 0). */
export type Counted = number | null;

export type InterventionRow = { key: string; label: string; now: string; before: string; change: string };

const show = (n: Counted): string => (n === null ? "不明" : String(+n.toFixed(1)));

/** now − before as +3 / -2 / ±0; a dash when either is not known. */
const diff = (now: Counted, before: Counted): string => {
  if (now === null || before === null) return "—";
  const d = +(now - before).toFixed(1);
  return d === 0 ? "±0" : d > 0 ? `+${d}` : String(d);
};

/** A count told with the places that could not be counted: `3（不明 2）`. */
const withUnknown = (count: number, unknown: number): string => (unknown > 0 ? `${count}（不明 ${unknown}）` : String(count));

/**
 * The comparison table of one period against the one before (#651): by kind, the total, re-asks, manual resumes after what
 * the PBI waited for, and the interventions a finished PBI took (per PBI). What the records could not tell is 不明, not 0.
 */
export function interventionRows(now: InterventionWindow, before: InterventionWindow): InterventionRow[] {
  // places that could not be counted have no time and may belong to either period: the counts are "at least" and no difference is told
  const partial = now.unknown + before.unknown > 0;
  const plain = (key: string, label: string, a: number, b: number): InterventionRow =>
    partial ? { key, label, now: `${a} 以上`, before: `${b} 以上`, change: "—" } : { key, label, now: String(a), before: String(b), change: diff(a, b) };
  return [
    plain("approval", "承認", now.byKind.approval, before.byKind.approval),
    plain("classifier", "分類器の後", now.byKind.classifier, before.byKind.classifier),
    plain("decision", "判断", now.byKind.decision, before.byKind.decision),
    plain("resume", "再開", now.byKind.resume, before.byKind.resume),
    plain("total", "合計", now.total, before.total),
    plain("reAsks", "同じ理由の再質問", now.reAsks, before.reAsks),
    { key: "afterWaits", label: "依存解消後の手動再開", now: withUnknown(now.resumesAfterWaits.count, now.resumesAfterWaits.unknown), before: withUnknown(before.resumesAfterWaits.count, before.resumesAfterWaits.unknown), change: partial || now.resumesAfterWaits.unknown + before.resumesAfterWaits.unknown > 0 ? "—" : diff(now.resumesAfterWaits.count, before.resumesAfterWaits.count) },
    { key: "perPbi", label: "完了までの介入（PBI 1 件あたり）", now: show(now.completed.perPbi), before: show(before.completed.perPbi), change: partial ? "—" : diff(now.completed.perPbi, before.completed.perPbi) },
  ];
}

/** The line that says which PBIs the numbers are over: finished ones (and the unknown among them) and the interventions on PBIs still open. */
export function populationLine(w: InterventionWindow): string {
  return `完了した PBI ${w.completed.pbis} 件（不明 ${w.completed.unknownPbis} 件）· 未完了 ${w.open.pbis} 件の介入 ${w.open.interventions} 回 · 完了済みの PBI への介入 ${w.done.interventions} 回`;
}

/** The places that could not be counted at all: told so that the totals read as "at least". */
export const unknownLine = (w: InterventionWindow): string | null => (w.unknown > 0 ? `数えられなかった場所が ${w.unknown} 件あります（取り込み前の workspace、写しに無い Issue）。上の数は「それ以上」で、増減は出しません` : null);

export const REASON_LABEL: Record<InterventionReason["reason"], string> = {
  "usage-limit": "使用上限",
  "github-limit": "GitHub の上限",
  "disk-full": "ディスクの空き切れ",
  transient: "一時障害",
  auth: "認証",
  permission: "承認待ち",
  input: "入力待ち",
  decision: "判断待ち",
  depends: "依存の待ち",
  unknown: "不明",
};

export type ReasonRow = {
  reason: InterventionReason["reason"];
  label: string;
  /** This period's and the one before's count; 0 is a period with no stop of this reason (the records are there, so it is not unknown). */
  count: number;
  before: number;
  change: string;
  notAutoResumed: number;
  notAutoResumedBefore: number;
  /** The stops to look at, newest first: this period's and the one before's. */
  links: Link[];
  linksBefore: Link[];
};
type Link = { workspaceId: string | null; issue: number | null; url: string | null; taskId: string; at: number; evidence: string };

/**
 * The reasons work stopped in this period against the one before, most first (then by the one before's), each with where to
 * look in both periods — filtered to the workspace shown when `inView` is given (the counts stay the whole).
 */
export function reasonRows(now: InterventionWindow, before: InterventionWindow, inView: (workspaceId: string | null) => boolean = () => true): ReasonRow[] {
  const nowBy = new Map(now.reasons.map((r) => [r.reason, r]));
  const beforeBy = new Map(before.reasons.map((r) => [r.reason, r]));
  const links = (r: InterventionReason | undefined) => (r?.evidence ?? []).filter((e) => inView(e.workspaceId)).map((e) => ({ workspaceId: e.workspaceId, issue: e.issue, url: e.url, taskId: e.taskId, at: e.at, evidence: e.evidence }));
  return [...new Set([...nowBy.keys(), ...beforeBy.keys()])]
    .map((reason) => {
      const a = nowBy.get(reason);
      const b = beforeBy.get(reason);
      return { reason, label: REASON_LABEL[reason], count: a?.count ?? 0, before: b?.count ?? 0, change: diff(a?.count ?? 0, b?.count ?? 0), notAutoResumed: a?.notAutoResumed ?? 0, notAutoResumedBefore: b?.notAutoResumed ?? 0, links: links(a), linksBefore: links(b) };
    })
    .sort((x, y) => y.count - x.count || y.before - x.before);
}
