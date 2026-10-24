import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Rubric } from "@switchboard/protocol";
import defaultRubric from "./rubric.default.json";

/**
 * The rubric the judge scores a task against (#1219). The default ships here; the person edits their own copy at
 * `rubricPath(home)` (Text stays text — no screen, no table). Read once at boot: an edit takes effect on the next start.
 */
export const DEFAULT_RUBRIC: Rubric = Rubric.parse(defaultRubric);

export function rubricPath(home: string): string {
  return join(home, "evals", "rubric.json");
}

/** `id@version`, as kept on every judge row so old scores can be told from new ones after an edit. */
export const rubricKey = (r: Rubric) => `${r.id}@${r.version}`;

/** The person's rubric when there is one and it reads; otherwise the default, with one warning saying why. */
export function loadRubric(home: string, log: (msg: string) => void = console.warn): Rubric {
  const path = rubricPath(home);
  if (!existsSync(path)) return DEFAULT_RUBRIC;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    log(`rubric: ${path} は読めないので既定を使う (${String((e as Error).message ?? e).split("\n")[0]})`);
    return DEFAULT_RUBRIC;
  }
  const r = Rubric.safeParse(parsed);
  if (!r.success) {
    log(`rubric: ${path} は読めないので既定を使う (${r.error.issues[0]?.path.join(".") || "root"}: ${r.error.issues[0]?.message ?? "invalid"})`);
    return DEFAULT_RUBRIC;
  }
  return r.data;
}
