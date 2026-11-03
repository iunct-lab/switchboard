/**
 * bun scripts/check-host-security.ts — the host's pending security updates, the kernel waiting for a reboot and the
 * pinned tools behind their distributors (PBI #3345). One line each; with nothing pending, one line with the counts.
 * Exit 0 = nothing pending / 1 = something is / 2 = cannot tell (never "nothing pending", and nothing filed).
 *
 * --file-request (the daily schedule, docs/design/check-host-security.md): on exit 1 also file through
 * scripts/file-request.ts: one request for what is urgent, one a week for the rest. The title is built from the state, so
 * the same state does not file twice. The exit code is the same with or without it. Whether an update can be reached over
 * the network is not judged here: the schedule's prompt reads ALAS for that. Read-only: no root, no package changes.
 */
import { createHash } from "node:crypto";
import { fileRequest, type Filed } from "./file-request.ts";
import { type Outdated, readPinsOutdated } from "./host-pins.ts";
import { type Advisory, hostRun, type KernelState, readHostUpdates, SEVERITIES } from "./host-updates.ts";

export interface State {
  advisories: Advisory[];
  kernel: KernelState;
  pins: Outdated[];
}

export interface Deps {
  readHostUpdates: () => Promise<{ advisories: Advisory[]; kernel: KernelState }>;
  readPins: () => Promise<Outdated[]>;
  fileRequest: (req: { title: string; body: string }) => Promise<Filed>;
  now: () => Date;
  log: (line: string) => void;
}

/** Distinct advisories of a severity: one advisory lists a row per package. */
const ids = (advisories: Advisory[], keep: (a: Advisory) => boolean) => [...new Set(advisories.filter(keep).map((a) => a.id))].sort();
const urgentAdvisory = (a: Advisory) => a.severity === "Critical" || a.severity === "Important" || a.severity === "unknown";

export function isClean(s: State): boolean {
  return s.advisories.length === 0 && !s.kernel.pending && s.pins.length === 0;
}

export function reportLines(s: State): string[] {
  if (isClean(s)) return ["異常なし（更新 0 / 再起動待ち なし / 固定版の遅れ 0）"];
  const count = (sev: Advisory["severity"]) => ids(s.advisories, (a) => a.severity === sev).length;
  const unknown = count("unknown");
  return [
    `updates: ${SEVERITIES.map((sev) => `${sev} ${count(sev)}`).join(" / ")}${unknown ? ` / unknown ${unknown}` : ""}`,
    s.kernel.pending ? `kernel: 再起動待ち（${s.kernel.why}）` : "kernel: 最新",
    ...s.pins.map((p) => `pins: ${p.name} ${p.pinned} → ${p.latest}${p.security ? "（security）" : ""}`),
  ];
}

/** ISO 8601 week, in UTC as the host is: `2026-W45`. The year is the week's own (the Thursday's). */
export function isoWeek(d: Date): string {
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7));
  const year = thursday.getUTCFullYear();
  const week = 1 + Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const TITLE_MAX = 256;

/** GitHub refuses titles over 256 characters. A long one is cut and keeps a hash of the whole, so it stays the same for the same state. */
function fitTitle(full: string): string {
  return full.length <= TITLE_MAX ? full : `${full.slice(0, TITLE_MAX - 12)} … ${createHash("sha1").update(full).digest("hex").slice(0, 8)}`;
}

const advisoryRows = (s: State, keep: (a: Advisory) => boolean) => s.advisories.filter(keep).map((a) => `- ${a.id} ${a.severity} ${a.pkg}`.trimEnd());
const pinRow = (p: Outdated) => `- ${p.name} ${p.pinned} → ${p.latest}${p.security ? "（security）" : ""}`;
const source = (date: string) => ["## 出典", "- 誰の言葉: 定期の検査", `\`bun scripts/check-host-security.ts --file-request\`（定期実行） / ${date}`];

/** What cannot wait for the week: updates rated Critical / Important or not understood, a pending reboot, a pinned tool behind a security release. */
export function urgentRequest(s: State, date: string): { title: string; body: string } | null {
  const pins = s.pins.filter((p) => p.security);
  const advisories = ids(s.advisories, urgentAdvisory);
  if (advisories.length === 0 && !s.kernel.pending && pins.length === 0) return null;
  const parts = [...(advisories.length ? [advisories.join(",")] : []), ...(s.kernel.pending ? ["再起動待ち"] : []), ...(pins.length ? [pins.map((p) => p.name).sort().join(",")] : [])];
  const body = [
    "## 要望",
    "ホストに対応の判断が要る更新があります。ネットワークから届くかの判定と根拠は、定期実行が `## 判断待ち` に書きます。",
    "",
    ...advisoryRows(s, urgentAdvisory),
    ...(s.kernel.pending ? [`- 再起動待ち: ${s.kernel.why}`] : []),
    ...pins.map(pinRow),
    "",
    "当て方は aws/README.md の「ホストの OS・カーネルの脆弱性（CVE）」。再起動・停止は人が判断する。",
    "",
    ...source(date),
  ].join("\n");
  return { title: fitTitle(`ホストの更新待ち: ${parts.join(" / ")}`), body };
}

/** The rest, once a week: rated Medium or Low, and pinned tools behind without a security release. */
export function weeklyRequest(s: State, now: Date): { title: string; body: string } | null {
  const minor = (a: Advisory) => !urgentAdvisory(a);
  const pins = s.pins.filter((p) => !p.security);
  const rows = [...advisoryRows(s, minor), ...pins.map(pinRow)];
  if (rows.length === 0) return null;
  return { title: `ホストの Medium 以下の更新（${isoWeek(now)}）`, body: ["## 要望", "急がない更新の一覧です。", "", ...rows, "", ...source(now.toISOString().slice(0, 10))].join("\n") };
}

const HOST_DEPS: Deps = {
  readHostUpdates: () => readHostUpdates(hostRun),
  readPins: () => readPinsOutdated(),
  fileRequest: (req) => fileRequest(req),
  now: () => new Date(),
  log: console.log,
};

function filedLine(req: { title: string }, r: Filed): string {
  if ("open" in r) return `要望: 既存 ${r.open}（起票しない）: ${req.title}`;
  return `要望: 起票 ${r.filed === null ? "（番号は上の出力）" : `#${r.filed}`}: ${req.title}`;
}

export async function main(args: string[], deps: Deps = HOST_DEPS): Promise<0 | 1 | 2> {
  const [updates, pins] = await Promise.allSettled([deps.readHostUpdates(), deps.readPins()]);
  if (updates.status === "rejected" || pins.status === "rejected") {
    const why = [updates, pins].flatMap((r) => (r.status === "rejected" ? [(r.reason as Error).message] : []));
    deps.log(`判定できない（${why.join(" / ")}）`);
    return 2;
  }
  const state: State = { ...updates.value, pins: pins.value };
  for (const l of reportLines(state)) deps.log(l);
  if (isClean(state)) return 0;
  if (args.includes("--file-request")) {
    const now = deps.now();
    for (const req of [urgentRequest(state, now.toISOString().slice(0, 10)), weeklyRequest(state, now)]) {
      if (!req) continue;
      try {
        deps.log(filedLine(req, await deps.fileRequest(req)));
      } catch (e) {
        deps.log(`要望: 起票できなかった（${(e as Error).message}）`);
      }
    }
  }
  return 1;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
