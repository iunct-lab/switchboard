import type { Schedule } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { home } from "./i18n/home.ts";
import { REASON_LABEL } from "./interventions.ts";
import { ago } from "./inProgress.ts";

export type StuckSchedule = Schedule & { stuck: NonNullable<Schedule["stuck"]> };

/** The schedules whose Tasks stopped the same way in a row (#4479), the longest-stuck first; Home's section is these, none = no section. */
export function stuckSchedules(rows: Schedule[]): StuckSchedule[] {
  return rows.filter((s): s is StuckSchedule => s.stuck !== null).sort((a, b) => a.stuck.firstAt - b.stuck.firstAt);
}

/** The reason as a person reads it: its label and the stop's own words (`判断待ち: lock が残っている`); a code with no label is said as it is. */
export function stuckReason(stuck: StuckSchedule["stuck"]): string {
  const label = (REASON_LABEL as Record<string, string>)[stuck.reason] ?? stuck.reason;
  return stuck.evidence.trim() ? `${label}: ${stuck.evidence.trim()}` : label;
}

/** The second line of a row: how many times in a row, why, since when, and that the clock no longer fires it. */
export function stuckLine(s: StuckSchedule, now: number): string {
  return t(home.stuckLine, { count: s.stuck.count, reason: stuckReason(s.stuck), since: ago(s.stuck.firstAt, now) });
}
