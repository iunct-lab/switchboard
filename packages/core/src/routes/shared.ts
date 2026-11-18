import type { Db } from "../db.ts";
import type { Routes } from "../server/context.ts";

export function clampLimit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return 200;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(5000, Math.round(n)) : 200;
}

/** `?days=` of the Ledger / routing endpoints: 1..90, default 7. Like `clampLimit`, an unusable value falls back. */
export function clampDays(raw: string | null): number {
  if (raw === null || raw.trim() === "") return 7; // Number("") is 0, which used to mean "one day"
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(90, Math.round(n)) : 7;
}

/**
 * `?limit=` of the decision-log export: 1..5000, default 200. Anything that is not a usable count — absent, empty,
 * zero, negative, not a number — falls back to the default rather than 400ing an export. (`Number("")` is 0, which
 * is why the emptiness check comes first: `?limit=` alone used to mean "one row".)
 */
/**
 * The query of a list across Tasks, or the error's text. `limit` is an integer 1..100 (default 20);
 * `q` is trimmed, blank = none, at most 200 characters; `before` must name an artifact (the previous page's last row).
 */
export function acrossQuery(url: URL, db: Db): { q?: string; before?: string; limit: number } | string {
  const raw = url.searchParams.get("limit");
  // absent = 20; a supplied value (even a blank one) must be digits in range — nothing is quietly defaulted or rounded
  const limit = raw === null ? 20 : /^[0-9]+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return "limit must be an integer 1..100";
  const q = url.searchParams.get("q")?.trim() || undefined;
  if (q && q.length > 200) return "q must be at most 200 characters";
  const before = url.searchParams.get("before") ?? undefined;
  if (before !== undefined && !db.getArtifact(before)) return "before must be the id of an artifact";
  return { q, before, limit };
}

export function knowledgeError(e: unknown): string {
  const msg = String((e as Error).message ?? e);
  return msg.replace(/\/(?:[^/\s'"]+\/)+[^/\s'"]*/g, "<path>");
}

export function knowledgeStatus(e: unknown): number {
  const code = (e as { code?: string }).code;
  if (code === "ENOENT" || /not found/.test(String((e as Error).message ?? e))) return 404;
  if (code === "EACCES" || code === "EPERM") return 403;
  return 400;
}

/** The groups' routes as one table, in the order given (one object spread of every group is a union too large for the type checker). */
export function joinRoutes(...groups: Routes[]): Routes {
  return Object.assign({}, ...groups) as Routes;
}
