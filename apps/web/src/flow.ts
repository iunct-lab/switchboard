// types only: a value import would pull the whole protocol (zod schemas) into the page's bundle
import type { FlowPbi, FlowStage, FlowView } from "@switchboard/protocol";

/** The stages in the order of the way, request to close. */
const STAGES: readonly FlowStage[] = ["request", "split", "wait", "build", "review-wait", "review", "close"];

/** The stages of a PBI's way from the request to its close (#650), as the 流れ section names them. */
export const STAGE_LABEL: Record<FlowStage, string> = {
  request: "起票",
  split: "分解",
  wait: "着手待ち",
  build: "実装",
  "review-wait": "レビュー待ち",
  review: "レビュー対応",
  close: "締め",
};

/** A length of time in the unit `ago` uses (分 / 時間 / 日); null is not known and shows a dash, never 0. */
export function span(ms: number | null): string {
  if (ms === null) return "—";
  const min = ms / 60_000;
  if (min < 1) return "1 分未満";
  if (min < 60) return `${Math.round(min)} 分`;
  if (min < 24 * 60) return `${+(min / 60).toFixed(1)} 時間`;
  return `${+(min / (24 * 60)).toFixed(1)} 日`;
}

/** At least this much slower (or faster) than the 30 days before is coloured. */
const CHANGE = 0.2;

export type FlowRow = { stage: FlowStage; label: string; now: string; p90: string; before: string; change: string; tone: "slower" | "faster" | "same" };

/** One row per stage: the median now and before, the change between them, and whether it is 20% or more slower / faster. */
export function flowRows(view: FlowView): FlowRow[] {
  return STAGES.map((stage) => {
    const now = view.current.stages[stage];
    const before = view.previous.stages[stage];
    const known = now.p50 !== null && before.p50 !== null && before.p50 > 0;
    const ratio = known ? now.p50! / before.p50! : 1;
    return {
      stage,
      label: STAGE_LABEL[stage],
      now: span(now.p50),
      p90: span(now.p90),
      before: span(before.p50),
      change: known ? `${ratio >= 1 ? "+" : ""}${Math.round((ratio - 1) * 100)}%` : "—",
      tone: ratio >= 1 + CHANGE ? "slower" : ratio <= 1 - CHANGE ? "faster" : "same",
    };
  });
}

/** The stage the median is largest at, with its time; null when no stage is known. */
export function bottleneckLine(view: FlowView): string | null {
  const st = view.current.bottleneck;
  return st ? `${STAGE_LABEL[st]}（中央値 ${span(view.current.stages[st].p50)}）` : null;
}

/** A PBI of the slowest list: the sum of its known stages and the stage that took longest. */
export function slowRow(p: FlowPbi): { number: number; title: string; url: string; total: string; longest: string } {
  const known = STAGES.flatMap((st) => (p.stages[st] === null || p.stages[st] === undefined ? [] : [[st, p.stages[st]!] as const]));
  const top = known.reduce<(typeof known)[number] | null>((a, b) => (a && a[1] >= b[1] ? a : b), null);
  return { number: p.number, title: p.title, url: p.url, total: known.length ? span(known.reduce((s, [, v]) => s + v, 0)) : "—", longest: top ? `${STAGE_LABEL[top[0]]} ${span(top[1])}` : "—" };
}
