// 外のビルドの記録（offload-record.ts）と CodeBuild のビルドの開始・終了の時刻から、呼び出し元ごとの
// 件数・課金の分数・重複・続いた呼び出しを数える。手で回すときだけ使い、デーモンは読まない。額は出さない。

import { fileLog, offloadRecordPath, type OffloadRecord } from "./offload-record.ts";
import type { OffloadSize } from "./local-ci-offload.ts";

export interface BuildTime { start: number; end?: number; size: OffloadSize }
export interface UsageRow { caller: string; builds: number; minutes: Record<OffloadSize, number>; dupBuilds: number; dupMinutes: number; soon: number; running: number }

const IMAGE_CALLER = "イメージ作り";
const SIZES: OffloadSize[] = ["small", "medium", "large"];

/** 課金は始まった分ごと。 */
const billed = (b: BuildTime) => (b.end === undefined ? 0 : Math.ceil((b.end - b.start) / 60_000));

/**
 * 呼び出し元ごとの行。重複は `kind: "ci"` で、`windowHours` 以内の前の記録に同じ `key` があるもの。
 * `soon` は同じ `caller` と `tree` で、前の記録から `gapMinutes` 以内に始まった、`key` の違うものか `key` の無いもの。
 * ビルドの時刻が読めない記録は件数にだけ入る。`since`（epoch ms）より前の記録は数えず、その後の記録の重複と `soon` の比べる相手にだけ使う。
 */
export function usage(records: OffloadRecord[], builds: Map<string, BuildTime>, o: { windowHours: number; gapMinutes: number; since?: number }): UsageRow[] {
  const rows = new Map<string, UsageRow>();
  const sorted = [...records].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const lastKey = new Map<string, number>();
  const lastTree = new Map<string, { at: number; key?: string }>();
  for (const r of sorted) {
    const at = Date.parse(r.at);
    const counted = o.since === undefined || at >= o.since;
    if (!counted) {
      if (r.kind === "ci") {
        if (r.key !== undefined) lastKey.set(r.key, at);
        lastTree.set(`${r.caller}\0${r.tree}`, { at, key: r.key });
      }
      continue;
    }
    const caller = r.kind === "image" ? IMAGE_CALLER : r.caller;
    const row = rows.get(caller) ?? { caller, builds: 0, minutes: { small: 0, medium: 0, large: 0 }, dupBuilds: 0, dupMinutes: 0, soon: 0, running: 0 };
    rows.set(caller, row);
    const b = builds.get(r.build);
    const mins = b ? billed(b) : 0;
    row.builds++;
    if (b) {
      if (b.end === undefined) row.running++;
      else row.minutes[b.size] += mins;
    }
    if (r.kind === "ci") {
      if (r.key !== undefined) {
        const prev = lastKey.get(r.key);
        if (prev !== undefined && at - prev <= o.windowHours * 3_600_000) {
          row.dupBuilds++;
          row.dupMinutes += mins;
        }
        lastKey.set(r.key, at);
      }
      const tk = `${r.caller}\0${r.tree}`;
      const before = lastTree.get(tk);
      if (before && at - before.at <= o.gapMinutes * 60_000 && (r.key === undefined || before.key !== r.key)) row.soon++;
      lastTree.set(tk, { at, key: r.key });
    }
  }
  return [...rows.values()].sort((a, b) => a.caller.localeCompare(b.caller));
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function table(rows: UsageRow[], unreadable: number): string {
  const line = (c: string, r: Pick<UsageRow, "builds" | "minutes" | "dupBuilds" | "dupMinutes" | "soon" | "running">) =>
    `| ${c} | ${r.builds} | ${SIZES.map((s) => r.minutes[s]).join(" / ")} | ${r.dupBuilds} / ${r.dupMinutes} | ${r.soon} | ${r.running} |`;
  const total = {
    builds: sum(rows.map((r) => r.builds)),
    minutes: { small: sum(rows.map((r) => r.minutes.small)), medium: sum(rows.map((r) => r.minutes.medium)), large: sum(rows.map((r) => r.minutes.large)) },
    dupBuilds: sum(rows.map((r) => r.dupBuilds)),
    dupMinutes: sum(rows.map((r) => r.dupMinutes)),
    soon: sum(rows.map((r) => r.soon)),
    running: sum(rows.map((r) => r.running)),
  };
  return [
    "| caller | builds | minutes (small / medium / large) | duplicates (builds / minutes) | followed within the gap | running |",
    "|---|---|---|---|---|---|",
    ...rows.map((r) => line(r.caller, r)),
    line("total", total),
    ...(unreadable ? ["", `unreadable builds: ${unreadable}`] : []),
  ].join("\n");
}

const SIZE_OF: Record<string, OffloadSize> = { BUILD_GENERAL1_SMALL: "small", BUILD_GENERAL1_MEDIUM: "medium", BUILD_GENERAL1_LARGE: "large" };

/** The CLI prints times as ISO strings (epoch seconds in some configurations). */
const ms = (t: string | number | null): number | undefined => {
  if (typeof t === "number") return t * 1000;
  const n = t ? Date.parse(t) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** One `batch-get-builds` answer (`builds[].[id,startTime,endTime,environment.computeType]`) into `out`; a build with no start time is left out. */
export function readBuilds(text: string, sizeOf: Map<string, OffloadSize>, out = new Map<string, BuildTime>()): Map<string, BuildTime> {
  for (const [id, start, end, type] of JSON.parse(text) as [string, string | number | null, string | number | null, string | null][]) {
    const s = ms(start);
    if (s === undefined) continue;
    out.set(id, { start: s, end: ms(end), size: SIZE_OF[type ?? ""] ?? sizeOf.get(id) ?? "small" });
  }
  return out;
}

async function batchGet(ids: string[], records: OffloadRecord[]): Promise<Map<string, BuildTime>> {
  const sizeOf = new Map(records.map((r) => [r.build, r.size]));
  const out = new Map<string, BuildTime>();
  for (let i = 0; i < ids.length; i += 100) {
    const p = Bun.spawn(["aws", "codebuild", "batch-get-builds", "--ids", ...ids.slice(i, i + 100), "--query", "builds[].[id,startTime,endTime,environment.computeType]", "--output", "json"], { stdout: "pipe", stderr: "pipe" });
    const [text, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) {
      console.error(`aws codebuild batch-get-builds failed (exit ${code}): ${err.trim().split("\n")[0]}`);
      continue;
    }
    readBuilds(text, sizeOf, out);
  }
  return out;
}

function num(argv: string[], name: string, def: number): number {
  const i = argv.indexOf(name);
  if (i < 0) return def;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} needs a positive number`);
  return n;
}

export async function main(argv: string[]): Promise<number> {
  const days = num(argv, "--days", 7);
  const o = { windowHours: num(argv, "--window-hours", 24), gapMinutes: num(argv, "--gap-minutes", 10) };
  const since = Date.now() - days * 86_400_000;
  // the window before the range is read too, so the range's first builds are compared with what came just before them
  const all = fileLog(offloadRecordPath()).read(since - o.windowHours * 3_600_000);
  const records = all.filter((r) => Date.parse(r.at) >= since);
  const builds = await batchGet([...new Set(records.map((r) => r.build))], records);
  const unreadable = new Set(records.filter((r) => !builds.has(r.build)).map((r) => r.build)).size;
  console.log(table(usage(all, builds, { ...o, since }), unreadable));
  return 0;
}

if (import.meta.main) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
}
