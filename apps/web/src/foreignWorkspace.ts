import { t } from "./i18n.ts";
import { common } from "./i18n/common.ts";
/** The one line above a foreign repository's runner config (#2576). */
export function runnerConfigSummary(files: { path: string }[]): string {
  return files.length ? t(common.configFiles, { n: files.length, list: files.map((f) => f.path).join(t(common.configListSep)) }) : t(common.configNone);
}
