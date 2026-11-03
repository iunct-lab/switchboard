/**
 * The host's pending security updates and whether the running kernel is behind (PBI #3345). Pure functions over the
 * commands' output, and a thin read of those commands. Read-only and without root: `dnf updateinfo list` and
 * `dnf check-update` work as a plain user (with a cache of their own), and nothing here installs anything. The severity
 * is Amazon's, taken as it stands.
 *
 * `--refresh` and `skip_if_unavailable` off for `amazonlinux`, as in aws/host/host-update.sh (#3344): a stale cache or a
 * skipped repository would read as "no updates". Without `-q` dnf prints its progress on stdout.
 */

export const SEVERITIES = ["Critical", "Important", "Medium", "Low"] as const;
export type Severity = (typeof SEVERITIES)[number] | "unknown";

export interface Advisory {
  id: string;
  /** "unknown" is a line or a severity not understood: it counts as Critical / Important, never as nothing. */
  severity: Severity;
  pkg: string;
}

/** `ALAS2023-2026-3350 Important/Sec. openssl-3.2.2-1.amzn2023.aarch64`, one line per advisory and package. */
export function parseUpdateinfo(text: string): Advisory[] {
  const out: Advisory[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(\S+)\s+(\S+)\s+(\S+)$/.exec(line);
    if (!m) {
      out.push({ id: line, severity: "unknown", pkg: "" });
      continue;
    }
    const severity = SEVERITIES.find((s) => s === m[2]!.split("/")[0]) ?? "unknown";
    out.push({ id: m[1]!, severity, pkg: m[3]! });
  }
  return out;
}

function compareSegments(a: string, b: string): number {
  const segments = (v: string) => v.match(/\d+|[a-zA-Z]+/g) ?? [];
  const [x, y] = [segments(a), segments(b)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const [p, q] = [x[i]!, y[i]!];
    const [pn, qn] = [/^\d/.test(p), /^\d/.test(q)];
    if (pn !== qn) return pn ? 1 : -1; // a number is newer than letters
    const c = pn ? Number(p) - Number(q) : p < q ? -1 : p > q ? 1 : 0;
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return Math.sign(x.length - y.length); // what has more segments left is newer
}

/** -1 / 0 / 1 as `a` is older than / the same as / newer than `b`: rpmvercmp without `~` and `^`, the version before the first `-` and then the release. */
export function compareRpm(a: string, b: string): number {
  const cut = (v: string) => (v.includes("-") ? [v.slice(0, v.indexOf("-")), v.slice(v.indexOf("-") + 1)] : [v, ""]) as [string, string];
  const [[av, ar], [bv, br]] = [cut(a), cut(b)];
  return compareSegments(av, bv) || compareSegments(ar, br);
}

/** A kernel's version as the three commands print it: no epoch (`0:`) and no architecture (`.aarch64`). */
function kernelVersion(v: string): string {
  return v.trim().replace(/^\d+:/, "").replace(/\.(aarch64|x86_64)$/, "");
}

export function newest(versions: string[]): string | null {
  return versions.reduce<string | null>((best, v) => (best === null || compareRpm(v, best) > 0 ? v : best), null);
}

/** The versions of `pkg` in `dnf check-update`'s rows (`kernel6.18.aarch64  6.18.60-130.170.amzn2023  amazonlinux`). */
export function availableVersions(text: string, pkg: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\S+)\.[^.\s]+\s+(\S+)\s+\S+$/.exec(line.trim());
    if (m?.[1] === pkg) out.push(m[2]!);
  }
  return out;
}

export interface KernelState {
  pending: boolean;
  why: string;
}

/** Pending when the running kernel is older than the newest installed one or the repository's. */
export function kernelState(k: { running: string; installed: string; available?: string | null }): KernelState {
  const [running, installed] = [kernelVersion(k.running), kernelVersion(k.installed)];
  const available = k.available ? kernelVersion(k.available) : null;
  if (available && compareRpm(available, installed) > 0 && compareRpm(running, available) < 0) return { pending: true, why: `動いている ${running} < リポジトリの最新 ${available}` };
  if (compareRpm(running, installed) < 0) return { pending: true, why: `動いている ${running} < インストール済み ${installed}` };
  return { pending: false, why: `動いている ${running} が最新` };
}

export class HostUpdatesUnreadable extends Error {}

export type Run = (cmd: string[]) => Promise<{ out: string; code: number }>;

const KERNEL_PACKAGE = "kernel6.18";
/** dnf on the host's 3.8 GB, bounded so that a hung mirror ends in "判定できない" and not in a Task that never finishes. */
const DNF = ["timeout", "300", "dnf", "-q", "--releasever=latest", "--setopt=amazonlinux.skip_if_unavailable=False"];

async function read(run: Run, name: string, cmd: string[], ok: number[]): Promise<{ out: string; code: number }> {
  let r: { out: string; code: number };
  try {
    r = await run(cmd);
  } catch (e) {
    throw new HostUpdatesUnreadable(`${name}: ${(e as Error).message}`);
  }
  if (!ok.includes(r.code)) throw new HostUpdatesUnreadable(`${name} exit ${r.code}`);
  return r;
}

const KERNEL_RELEASE = /^\d+\.\d+\.\d+-\S+$/;

/** One read of the host. Throws HostUpdatesUnreadable when any of it cannot be read: the caller must not say "nothing pending". */
export async function readHostUpdates(run: Run): Promise<{ advisories: Advisory[]; kernel: KernelState }> {
  const advisories = parseUpdateinfo((await read(run, "dnf updateinfo", [...DNF, "--refresh", "updateinfo", "list", "--security"], [0])).out);
  // the kernel of any kind of update, not only --security: a kernel waiting for a reboot is one whatever the advisory says
  const check = await read(run, "dnf check-update", [...DNF, "check-update", KERNEL_PACKAGE], [0, 100]);
  const available = availableVersions(check.out, KERNEL_PACKAGE);
  if (check.code === 100 && available.length === 0) throw new HostUpdatesUnreadable(`dnf check-update は更新ありと言うが ${KERNEL_PACKAGE} の行が読めない`);
  const running = (await read(run, "uname", ["uname", "-r"], [0])).out.trim();
  const rpm = (await read(run, "rpm", ["rpm", "-q", KERNEL_PACKAGE, "--qf", "%{VERSION}-%{RELEASE}.%{ARCH}\\n"], [0])).out;
  const installed = newest(rpm.split("\n").map((l) => l.trim()).filter(Boolean));
  if (!KERNEL_RELEASE.test(running)) throw new HostUpdatesUnreadable(`uname の出力が読めない: ${running.slice(0, 80)}`);
  if (!installed || !KERNEL_RELEASE.test(installed)) throw new HostUpdatesUnreadable(`rpm の出力が読めない: ${rpm.trim().slice(0, 80)}`);
  return { advisories, kernel: kernelState({ running, installed, available: newest(available) }) };
}

/** The real commands. dnf's stderr goes to this process's, the way check-models' read does. */
export async function hostRun(cmd: string[]): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { out, code };
}
