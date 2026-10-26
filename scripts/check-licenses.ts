/** bun run licenses:check — every dependency's license against scripts/licenses.allow.json. */

/** `bun pm licenses --json`: packages grouped under their license. */
export type LicenseReport = Record<string, Array<{ name: string; versions: string[]; license?: unknown }>>;

export interface Exception {
  name: string;
  license: string;
  reason: string;
  until: string;
}

export interface AllowList {
  allowed: string[];
  exceptions: Exception[];
}

export interface Violation {
  name: string;
  version: string;
  license: string;
  why: string;
}

const UNKNOWN = new Set(["", "UNKNOWN", "UNLICENSED", "SEE LICENSE IN LICENSE"]);

/** Throws on an allow list a person has to fix: an exception without a reason or a valid review date. */
export function validate(allow: AllowList): AllowList {
  if (!Array.isArray(allow?.allowed)) throw new Error("the allow list needs an \"allowed\" array of SPDX ids");
  if (!Array.isArray(allow.exceptions)) throw new Error("the allow list needs an \"exceptions\" array (it may be empty)");
  for (const e of allow.exceptions) {
    if (!e.name || !e.license) throw new Error(`exception without name or license: ${JSON.stringify(e)}`);
    if (!e.reason?.trim()) throw new Error(`exception for ${e.name} has no reason`);
    if (!isDay(e.until)) throw new Error(`exception for ${e.name} needs until: YYYY-MM-DD (a date that exists)`);
  }
  return allow;
}

/** YYYY-MM-DD that exists: Date.parse("2026-02-31") rolls over to March, so the date must come back unchanged. */
function isDay(s: unknown): boolean {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/** The expression without one pair of parentheses around all of it; "(MIT) AND (ISC)" is left as it is. */
function stripOuter(e: string): string {
  if (!e.startsWith("(") || !e.endsWith(")")) return e;
  let depth = 0;
  for (let i = 0; i < e.length; i++) {
    if (e[i] === "(") depth++;
    else if (e[i] === ")") depth--;
    if (depth === 0 && i < e.length - 1) return e;
  }
  return e.slice(1, -1).trim();
}

/** Parentheses left inside (a group joined to others) are not parsed: such an expression is never allowed (fail closed). */
export function unsupportedExpression(expr: string): boolean {
  return /[()]/.test(stripOuter(expr.trim()));
}

/** An SPDX expression is allowed when every AND part is, where an OR group needs only one allowed choice. */
export function allowedExpression(expr: string, allowed: Set<string>): boolean {
  if (unsupportedExpression(expr)) return false;
  const e = stripOuter(expr.trim());
  if (/\bOR\b/.test(e)) return e.split(/\s+OR\s+/).some((x) => allowedExpression(x, allowed));
  if (/\bAND\b/.test(e)) return e.split(/\s+AND\s+/).every((x) => allowedExpression(x, allowed));
  return allowed.has(e);
}

function licenseText(group: string, license: unknown): string {
  if (typeof license === "string") return license;
  if (license && typeof license === "object" && typeof (license as { type?: unknown }).type === "string") return (license as { type: string }).type;
  return group;
}

export function check(report: LicenseReport, allow: AllowList, today = new Date().toISOString().slice(0, 10)): Violation[] {
  const allowed = new Set(allow.allowed);
  const out: Violation[] = [];
  for (const [group, pkgs] of Object.entries(report)) {
    for (const p of pkgs) {
      const license = licenseText(group, p.license).trim();
      const unknown = UNKNOWN.has(license.toUpperCase());
      if (!unknown && allowedExpression(license, allowed)) continue;
      const ex = allow.exceptions.find((e) => e.name === p.name && e.license === license);
      if (ex && ex.until >= today) continue;
      const why = ex ? `exception expired on ${ex.until}` : unknown ? "unknown license" : unsupportedExpression(license) ? "SPDX expression with nested groups (not parsed)" : "not in the allow list";
      for (const version of p.versions.length ? p.versions : [""]) out.push({ name: p.name, version, license: license || "(none)", why });
    }
  }
  return out;
}

if (import.meta.main) {
  const allow = validate(await Bun.file(new URL("./licenses.allow.json", import.meta.url)).json() as AllowList);
  const p = Bun.spawn(["bun", "pm", "licenses", "--json"], { stdout: "pipe", stderr: "inherit" });
  const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) {
    console.error(`bun pm licenses failed (exit ${code})`);
    process.exit(2);
  }
  const report = JSON.parse(text) as LicenseReport;
  const violations = check(report, allow);
  const count = Object.values(report).reduce((n, g) => n + g.length, 0);
  for (const v of violations) console.error(`${v.name}@${v.version}  ${v.license}  (${v.why})`);
  if (violations.length) {
    console.error(`${violations.length} dependency license(s) not allowed — see scripts/licenses.allow.json (_notes)`);
    process.exit(1);
  }
  console.log(`licenses: ${count} packages, all allowed`);
}
