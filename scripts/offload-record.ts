// 外のビルドを始めるたびに 1 行（呼び出し元・ビルドの id・大きさ・入力の鍵・作業ツリー・時刻）を足す記録。
// 集計するのは 1 本のスクリプトだけで、デーモンは読まない。書くのは hostOffload の log だけ。

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { OffloadSize } from "./local-ci.ts";

export type OffloadCaller = "local-ci" | "tag-ci" | "test-changed" | "typecheck";

/** `kind: "image"` は ci イメージ作りのビルドで、入力の鍵を持たない。`at` はどちらも ci のビルドが始まった時刻（イメージ作りはその前に終わっている）。 */
export interface OffloadRecord { at: string; caller: OffloadCaller; kind: "ci" | "image"; build: string; size: OffloadSize; key?: string; tree: string }

export interface OffloadLog {
  append(r: OffloadRecord): void;
  /** `sinceMs`（epoch ms）以後の行。読めない行は飛ばす。 */
  read(sinceMs: number): OffloadRecord[];
}

const DEFAULT_DAYS = 30;

export const offloadRecordPath = () => join(process.env.HOME || homedir(), ".cache", "switchboard.offload-builds.jsonl");

/** 何日分残すか。`SWITCHBOARD_OFFLOAD_RECORD_DAYS` の正の数、無いか読めなければ 30。 */
export function recordDays(env: Record<string, string | undefined>): number {
  const n = Number(env.SWITCHBOARD_OFFLOAD_RECORD_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAYS;
}

function readLines(path: string): OffloadRecord[] {
  if (!existsSync(path)) return [];
  const out: OffloadRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as OffloadRecord;
      if (r && typeof r.at === "string" && Number.isFinite(Date.parse(r.at))) out.push(r);
    } catch {
      // a line that cannot be read is skipped
    }
  }
  return out;
}

/** `path` の JSON Lines。`append` は `keepDays` より 1 日以上古い行があれば、`keepDays` より古い行を落として書き直す。 */
export function fileLog(path: string, keepDays = recordDays(process.env)): OffloadLog {
  return {
    append(r) {
      mkdirSync(dirname(path), { recursive: true });
      const cut = Date.now() - keepDays * 86_400_000;
      const old = readLines(path);
      const kept = old.filter((x) => Date.parse(x.at) >= cut);
      // rewrite at most about once a day: a rewrite can drop a line another process appends meanwhile
      if (!old.some((x) => Date.parse(x.at) < cut - 86_400_000)) {
        appendFileSync(path, `${JSON.stringify(r)}\n`);
        return;
      }
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, [...kept, r].map((x) => JSON.stringify(x)).join("\n") + "\n");
      renameSync(tmp, path);
    },
    read: (sinceMs) => readLines(path).filter((x) => Date.parse(x.at) >= sinceMs),
  };
}

const DEFAULT_REUSE_HOURS = 24;

/** 同じ入力の鍵のビルドの結果を使い回す時間の幅。`SWITCHBOARD_OFFLOAD_REUSE_HOURS` の 0 以上の数（0 = 使い回さない）、無いか読めなければ 24。 */
export function reuseHours(env: Record<string, string | undefined>): number {
  const raw = env.SWITCHBOARD_OFFLOAD_REUSE_HOURS;
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REUSE_HOURS;
}

/**
 * `key` と同じ入力の鍵で、`hours` 時間以内に始まった ci のビルドのうち、いちばん新しい行。鍵がまったく同じものだけで、
 * 近い鍵・鍵の無い行・イメージ作りの行は拾わない。`hours` が 0 以下なら無し。
 */
export function findReusable(log: OffloadLog, key: string, hours: number, now: number): OffloadRecord | undefined {
  if (!(hours > 0)) return undefined;
  return log.read(now - hours * 3_600_000).filter((r) => r.kind === "ci" && r.key === key && Date.parse(r.at) <= now).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

/**
 * 集めたビルドの出力が使い回せるか: コマンドが終わりまで回って自分の終了コードを出した（`sb-offload: exit <n>` の行がある）ビルドだけ。
 * 中断・時間切れ・始まる前の失敗・読めないログ（どれもその行が無い）は、入力の結果ではないので使い回さない。
 */
export const reusableOutput = (output: string): boolean => /^sb-offload: exit \d+$/m.test(output);

/** 前のビルドの結果を使ったときの 1 行（test-changed と typecheck で同じ）。 */
export const reusedLine = (r: { build: string; at: string }): string => `外: 前のビルド ${r.build}（${r.at} に開始）の結果を使った。回し直すなら --force`;

async function gitOut(cwd: string, args: string[], input?: string): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, env: process.env, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const [out, , code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args[0]} failed (exit ${code})`);
  return out;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/**
 * 外のビルドの入力の鍵: sha256 に `script`・大きさ・作業ツリーの各ファイルのパスと内容の hash（一覧は aws/host/offload.sh と同じ
 * 追跡 + 未追跡。消えたファイルとディレクトリは飛ばす）・録画の各ファイルの相対パスと内容の hash を入れる（大きさと mtime では
 * 見分けない: 同じ長さ・同じ時刻で中身だけ違う録画が、前のビルドの結果を使い回させない）。
 */
export async function buildKey(cwd: string, script: string, run: { size: OffloadSize; fixtures?: string }): Promise<string> {
  const h = createHash("sha256");
  h.update(`script\0${script}\0size\0${run.size}\0`);
  const listed = [...(await gitOut(cwd, ["ls-files", "-c", "--recurse-submodules", "-z"])).split("\0"), ...(await gitOut(cwd, ["ls-files", "-o", "--exclude-standard", "-z"])).split("\0")];
  const paths = [...new Set(listed.filter(Boolean))].sort().filter((p) => {
    try {
      return statSync(join(cwd, p)).isFile();
    } catch {
      return false;
    }
  });
  const hashes = paths.length ? (await gitOut(cwd, ["hash-object", "--stdin-paths"], paths.join("\n") + "\n")).split("\n").filter(Boolean) : [];
  paths.forEach((p, i) => h.update(`${p}\0${hashes[i]}\0`));
  if (run.fixtures && existsSync(run.fixtures)) {
    const files = filesUnder(run.fixtures).sort();
    const of = files.length ? (await gitOut(cwd, ["hash-object", "--no-filters", "--stdin-paths"], files.join("\n") + "\n")).split("\n").filter(Boolean) : [];
    if (of.length !== files.length) throw new Error("recordings could not be hashed");
    files.forEach((f, i) => h.update(`fixture\0${relative(run.fixtures!, f)}\0${of[i]}\0`));
  }
  return h.digest("hex");
}
