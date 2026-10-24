/*
 * Every time the Web UI shows is JST (Asia/Tokyo), whatever the browser's time zone is (#2028). `at` is epoch ms.
 */

const PARTS = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });

const p = (n: number) => String(n).padStart(2, "0");

function parts(at: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const o: Record<string, number> = {};
  for (const x of PARTS.formatToParts(new Date(at))) if (x.type !== "literal") o[x.type] = Number(x.value);
  return { y: o.year!, mo: o.month!, d: o.day!, h: o.hour!, mi: o.minute!, s: o.second! };
}

/** `YYYY-MM-DD`: the JST date. */
export function jstDay(at: number): string {
  const t = parts(at);
  return `${t.y}-${p(t.mo)}-${p(t.d)}`;
}

/** `HH:MM:SS`. */
export function jstTime(at: number): string {
  const t = parts(at);
  return `${p(t.h)}:${p(t.mi)}:${p(t.s)}`;
}

/** `M/D HH:MM`. */
export function jstStamp(at: number): string {
  const t = parts(at);
  return `${t.mo}/${t.d} ${p(t.h)}:${p(t.mi)}`;
}

/** `YYYY/MM/DD HH:MM:SS`. */
export function jstDateTime(at: number): string {
  const t = parts(at);
  return `${t.y}/${p(t.mo)}/${p(t.d)} ${p(t.h)}:${p(t.mi)}:${p(t.s)}`;
}

/** `HH:MM` on the same JST date as `now`, else `M/D HH:MM`. */
export function jstClock(at: number, now = Date.now()): string {
  if (jstDay(at) !== jstDay(now)) return jstStamp(at);
  const t = parts(at);
  return `${p(t.h)}:${p(t.mi)}`;
}
