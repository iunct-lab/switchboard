import type { StopSummary } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";

/** 停止の系列 (#939) を画面に出す文言: 何回目か、前回の回答、前回からの変化、次に必要な対処。記録に無いものは「不明」。 */
export interface StopDisplay {
  key: string;
  /** 見出し: 操作と対象、理由 */
  title: string;
  /** 「3 回目」「初回」 */
  count: string;
  /** 前回の回答。無ければ「なし」 */
  answer: string;
  /** 前回からの変化。無ければ「なし（同じ条件）」 */
  changes: string;
  /** 次に必要な対処 */
  next: string;
  /** 実施済みの再試行など */
  actions: string[];
  /** 人の操作が要るか（要らなければ「操作不要」と出す） */
  needsPerson: boolean;
  /** 長文は切って出す */
  evidence: string;
}

const UNKNOWN = t(m.unknown);
const MAX = 120;
const clip = (s: string) => (s.length > MAX ? `${s.slice(0, MAX)}…` : s);

const CHANGE_LABEL: Record<StopSummary["changes"][number]["kind"], string> = {
  cause: t(m.changeCause),
  answer: t(m.changeAnswer),
  "condition-met": t(m.changeConditionMet),
  condition: t(m.changeCondition),
};

const NEXT_TEXT: Record<StopSummary["next"], string> = {
  none: t(m.stopNextNone),
  resume: t(m.stopNextResume),
  wait: t(m.stopNextWait),
  retry: t(m.stopNextRetry),
  decide: t(m.stopNextDecide),
};

export function stopDisplay(s: StopSummary): StopDisplay {
  const answer = s.lastAnswer ? (s.lastAnswer.ref.startsWith("seq:") ? t(m.answeredByYou) : clip(s.lastAnswer.ref)) : t(m.none);
  return {
    key: s.key,
    title: `${clip(s.op)}${s.target ? ` ${clip(s.target)}` : ""}: ${s.reason === "disk-full" ? t(m.diskFull) : s.reason}`,
    count: s.count > 1 ? t(m.countNth, { n: s.count }) : t(m.countFirst),
    answer,
    changes: s.changes.length ? s.changes.map((c) => t(m.changeItem, { label: CHANGE_LABEL[c.kind] ?? UNKNOWN, detail: clip(c.detail) })).join(t(m.changeSep)) : s.count <= 1 ? t(m.none) : t(m.noneSame),
    next: NEXT_TEXT[s.next] ?? UNKNOWN,
    actions: s.actions.map((a) => `${t(m.action, { n: a.attempt, what: clip(a.what) })}${a.ok === true ? t(m.actionOk) : a.ok === false ? t(m.actionFailed) : ""}`),
    needsPerson: s.next === "decide",
    evidence: s.evidence ? clip(s.evidence) : UNKNOWN,
  };
}

/** 画面に出す系列: 解消済みで 1 回きりのものは出さない。新しく止まった順、操作が要るものが先。 */
export function shownStops(stops: StopSummary[]): StopSummary[] {
  return stops
    .filter((s) => s.state !== "resolved" || s.count > 1)
    .sort((a, b) => Number(b.next === "decide") - Number(a.next === "decide") || b.lastAt - a.lastAt);
}
