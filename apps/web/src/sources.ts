// types only: a value import would pull the whole protocol (zod schemas) into the page's bundle
import type { SourceRow, SourceView } from "@switchboard/protocol";
import { t } from "./i18n.ts";
import { insights as m } from "./i18n/insights.ts";

export type SourceTableRow = { label: string; child: boolean; cells: string[] };

const DASH = "-";

/** A number of days with one decimal and the unit; null is not known and shows a dash, never 0. */
const days = (n: number | null): string => (n === null ? DASH : t(m.sourcesDays, { n: n.toFixed(1) }));

/** The cells after the first: 起きた要望 first, then the rest — a row of 派生 counts only what happened, so the rest is a dash. */
function cells(row: SourceRow): string[] {
  if (row.speaker === "派生") return [String(row.opened), DASH, DASH, DASH, DASH, DASH, DASH, DASH];
  return [String(row.opened), String(row.planned), String(row.dropped), String(row.delivered), days(row.daysToDeliver), String(row.stale), String(row.reverted), String(row.followUpBugs)];
}

/** One row per repository × speaker (the repository without its `owner/`), a route under it indented as `└ <route>`. */
export function sourceTableRows(view: SourceView): SourceTableRow[] {
  return view.rows.map((row) => ({
    label: row.route === null ? t(m.sourcesLabel, { repo: row.repo.replace(/^[^/]+\//, ""), speaker: row.speaker }) : t(m.sourcesRoute, { route: row.route }),
    child: row.route !== null,
    cells: cells(row),
  }));
}

/** The column heads; the two day counts the daemon used are in the heads of the columns they decide. */
export function sourceHeaders(view: SourceView): string[] {
  return [t(m.sourcesColSource), t(m.sourcesColOpened), t(m.sourcesColPlanned), t(m.sourcesColDropped), t(m.sourcesColDelivered), t(m.sourcesColMedian), t(m.sourcesColStale, { n: view.staleDays }), t(m.sourcesColReverted), t(m.sourcesColFollowUp, { n: view.reworkDays })];
}
