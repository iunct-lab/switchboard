import type { StopSummary } from "@switchboard/protocol";

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

const UNKNOWN = "不明";
const MAX = 120;
const clip = (s: string) => (s.length > MAX ? `${s.slice(0, MAX)}…` : s);

const CHANGE_LABEL: Record<StopSummary["changes"][number]["kind"], string> = {
  cause: "別の原因",
  answer: "新しい回答",
  "condition-met": "条件が成立",
  condition: "条件が変化",
};

const NEXT_TEXT: Record<StopSummary["next"], string> = {
  none: "解消済み・操作不要",
  resume: "回答または条件の成立を受けて再開します・操作不要",
  wait: "条件の変化待ち・操作不要",
  retry: "上限つきの再試行中・操作不要",
  decide: "あなたの判断が必要です",
};

export function stopDisplay(s: StopSummary): StopDisplay {
  const answer = s.lastAnswer ? (s.lastAnswer.ref.startsWith("seq:") ? "あなたの回答あり" : clip(s.lastAnswer.ref)) : "なし";
  return {
    key: s.key,
    title: `${clip(s.op)}${s.target ? ` ${clip(s.target)}` : ""}: ${s.reason}`,
    count: s.count > 1 ? `${s.count} 回目` : "初回",
    answer,
    changes: s.changes.length ? s.changes.map((c) => `${CHANGE_LABEL[c.kind] ?? UNKNOWN}（${clip(c.detail)}）`).join("、") : s.count <= 1 ? "なし" : "なし（同じ条件）",
    next: NEXT_TEXT[s.next] ?? UNKNOWN,
    actions: s.actions.map((a) => `${a.attempt} 回目: ${clip(a.what)}${a.ok === true ? "（成功）" : a.ok === false ? "（失敗）" : ""}`),
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
