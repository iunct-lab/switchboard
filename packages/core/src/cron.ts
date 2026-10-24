/**
 * Five-field cron (minute hour day-of-month month day-of-week) with `*`, lists, ranges and steps, evaluated in the
 * daemon's local time. Day-of-month and day-of-week combine with OR when both are restricted (as in Vixie cron).
 */
export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

const ALIASES: Record<string, string> = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@nightly": "0 3 * * *" };
const NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function parseCron(expr: string): CronSpec {
  const e = ALIASES[expr.trim().toLowerCase()] ?? expr.trim();
  const fields = e.split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron needs 5 fields (minute hour day month weekday), got "${expr}"`);
  const [mi, ho, dm, mo, dw] = fields as [string, string, string, string, string];
  const spec: CronSpec = {
    minute: field(mi, 0, 59),
    hour: field(ho, 0, 23),
    dom: field(dm, 1, 31),
    month: field(mo, 1, 12),
    dow: field(dw, 0, 7),
    domAny: dm === "*",
    dowAny: dw === "*",
  };
  if (spec.dow.has(7)) spec.dow.add(0); // 7 = Sunday too
  return spec;
}

function field(src: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of src.split(",")) {
    const m = part.trim().toLowerCase().match(/^(\*|[a-z]{3}|\d+)(?:-([a-z]{3}|\d+))?(?:\/(\d+))?$/);
    if (!m) throw new Error(`bad cron field "${part}"`);
    const val = (s: string) => (s in NAMES ? NAMES[s]! : Number(s));
    const step = m[3] ? Number(m[3]) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      lo = min;
      hi = max;
    } else {
      lo = val(m[1]!);
      hi = m[2] ? val(m[2]) : m[3] ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) throw new Error(`cron field "${part}" out of range ${min}-${max}`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function matches(spec: CronSpec, d: Date): boolean {
  if (!spec.minute.has(d.getMinutes()) || !spec.hour.has(d.getHours()) || !spec.month.has(d.getMonth() + 1)) return false;
  const domOk = spec.dom.has(d.getDate());
  const dowOk = spec.dow.has(d.getDay());
  if (spec.domAny && spec.dowAny) return true;
  if (spec.domAny) return dowOk;
  if (spec.dowAny) return domOk;
  return domOk || dowOk;
}

/** Next matching minute strictly after `from` (local time), or null if none within ~5 years. */
export function nextRun(expr: string | CronSpec, from = new Date()): Date | null {
  const spec = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = from.getTime() + 5 * 366 * 24 * 3600 * 1000;
  while (d.getTime() < limit) {
    if (!spec.month.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    const domOk = spec.dom.has(d.getDate());
    const dowOk = spec.dow.has(d.getDay());
    const dayOk = spec.domAny && spec.dowAny ? true : spec.domAny ? dowOk : spec.dowAny ? domOk : domOk || dowOk;
    if (!dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!spec.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!spec.minute.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    // Belt-and-suspenders: `matches()` re-derives the same month/day/hour/minute conditions independently (it's the
    // spec-conformance check used in tests and available to callers) — used here for real instead of being dead
    // production code, so the two implementations can't silently drift apart. Should always hold at this point;
    // if it doesn't, advance by a minute and keep walking rather than returning a wrong match.
    if (matches(spec, d)) return d;
    d.setMinutes(d.getMinutes() + 1, 0, 0);
  }
  return null;
}
