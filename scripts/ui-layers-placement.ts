/**
 * bun scripts/ui-layers-placement.ts [--days 30] [--repo <owner/name>] — the screen PBIs (Project Area `web`) closed in the
 * last `days` days, and those whose body has no line starting `**置き場所**:` (docs/design/ui-layers.md: a PBI that changes
 * the screen names where its change sits). Names them only: no lint, no CI step. Reads the app's stored values as
 * `flow-report.ts` does (BACKLOG_URL, inside the app's Task); prints `{"checked":<n>,"missing":[{number,title}]}`.
 * Exit 0 = printed / 2 = bad arguments, or the stored values could not be read.
 */
import { closedPbis } from "../packages/core/src/flow.ts";
import { readRecords, type StoredRecords } from "../ops-kit/src/backlog-client.ts";

/** A body line that starts `**置き場所**:` (a full-width colon or any other start does not count). */
const PLACED = /^\*\*置き場所\*\*:/m;

/** The screen PBIs closed in the period (`checked`), and those without the placement line, by number. */
export function missingPlacement(records: StoredRecords, days: number, now: number): { checked: number; missing: Array<{ number: number; title: string }> } {
  const screens = closedPbis(records, days, now).filter((p) => p.fields?.Area === "web");
  const missing = screens.filter((p) => !PLACED.test(p.body)).sort((a, b) => a.number - b.number).map(({ number, title }) => ({ number, title }));
  return { checked: screens.length, missing };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : (process.argv[i + 1] ?? ""); // a flag without its value is refused, not the default
}

if (import.meta.main) {
  const days = Number(arg("--days") ?? 30);
  if (!Number.isInteger(days) || days < 1) {
    console.error("usage: bun scripts/ui-layers-placement.ts [--days 30] [--repo <owner/name>]");
    process.exit(2);
  }
  let records: StoredRecords;
  try {
    records = await readRecords(process.env, { fresh: false, repo: arg("--repo"), cwd: process.cwd() });
  } catch (e) {
    console.error(`アプリの保存値を読めません: ${(e as Error).message}`);
    process.exit(2);
  }
  console.log(JSON.stringify(missingPlacement(records, days, Date.now())));
}
