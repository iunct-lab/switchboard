import type { Health } from "./api.ts";
import { jstStamp } from "./time.ts";
import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";

/** The top banner for a problem with the daily history archive (#1201). */
export function archiveBanner(p: NonNullable<Health["archive"]>): string {
  const at = jstStamp(p.at);
  if (p.kind === "failed") return t(m.archiveFailed, { at, code: p.detail ?? t(m.unknown) });
  if (p.kind === "stuck") return t(m.archiveStuck, { at });
  return t(m.archiveMissing, { at });
}
