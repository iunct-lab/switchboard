import type { InterventionReason, InterventionWindow } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { panels as m } from "./i18n/panels.ts";

/** A count that may not be known: null shows 不明 and takes part in no change (never 0). */
export type Counted = number | null;

export type InterventionRow = { key: string; label: string; now: string; before: string; change: string };

const show = (n: Counted): string => (n === null ? t(m.unknown) : String(+n.toFixed(1)));

/** now − before as +3 / -2 / ±0; a dash when either is not known. */
const diff = (now: Counted, before: Counted): string => {
  if (now === null || before === null) return "—";
  const d = +(now - before).toFixed(1);
  return d === 0 ? "±0" : d > 0 ? `+${d}` : String(d);
};

/** A count told with the places that could not be counted: `3（不明 2）`. */
const withUnknown = (count: number, unknown: number): string => (unknown > 0 ? t(m.withUnknown, { count, unknown }) : String(count));

/**
 * The comparison table of one period against the one before (#651): by kind, the total, re-asks, manual resumes after what
 * the PBI waited for, and the interventions a finished PBI took (per PBI). What the records could not tell is 不明, not 0.
 */
export function interventionRows(now: InterventionWindow, before: InterventionWindow): InterventionRow[] {
  // places that could not be counted have no time and may belong to either period: the counts are "at least" and no difference is told
  const partial = now.unknown + before.unknown > 0;
  const plain = (key: string, label: string, a: number, b: number): InterventionRow =>
    partial ? { key, label, now: t(m.atLeast, { n: a }), before: t(m.atLeast, { n: b }), change: "—" } : { key, label, now: String(a), before: String(b), change: diff(a, b) };
  return [
    plain("approval", t(m.rowApproval), now.byKind.approval, before.byKind.approval),
    plain("classifier", t(m.rowClassifier), now.byKind.classifier, before.byKind.classifier),
    plain("decision", t(m.rowDecision), now.byKind.decision, before.byKind.decision),
    plain("resume", t(m.rowResume), now.byKind.resume, before.byKind.resume),
    plain("total", t(m.rowTotal), now.total, before.total),
    plain("reAsks", t(m.rowReAsks), now.reAsks, before.reAsks),
    { key: "afterWaits", label: t(m.rowAfterWaits), now: withUnknown(now.resumesAfterWaits.count, now.resumesAfterWaits.unknown), before: withUnknown(before.resumesAfterWaits.count, before.resumesAfterWaits.unknown), change: partial || now.resumesAfterWaits.unknown + before.resumesAfterWaits.unknown > 0 ? "—" : diff(now.resumesAfterWaits.count, before.resumesAfterWaits.count) },
    { key: "perPbi", label: t(m.rowPerPbi), now: show(now.completed.perPbi), before: show(before.completed.perPbi), change: partial ? "—" : diff(now.completed.perPbi, before.completed.perPbi) },
  ];
}

/** The line that says which PBIs the numbers are over: finished ones (and the unknown among them) and the interventions on PBIs still open. */
export function populationLine(w: InterventionWindow): string {
  return t(m.population, { done: w.completed.pbis, unknown: w.completed.unknownPbis, open: w.open.pbis, openInterventions: w.open.interventions, doneInterventions: w.done.interventions });
}

/** The places that could not be counted at all: told so that the totals read as "at least". */
export const unknownLine = (w: InterventionWindow): string | null => (w.unknown > 0 ? t(m.uncounted, { n: w.unknown }) : null);

export const REASON_LABEL: Record<InterventionReason["reason"], string> = {
  "usage-limit": t(m.reasonUsageLimit),
  "github-limit": t(m.reasonGithubLimit),
  "disk-full": t(m.reasonDiskFull),
  transient: t(m.reasonTransient),
  auth: t(m.reasonAuth),
  permission: t(m.reasonPermission),
  input: t(m.reasonInput),
  decision: t(m.reasonDecision),
  depends: t(m.reasonDepends),
  unknown: t(m.unknown),
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
