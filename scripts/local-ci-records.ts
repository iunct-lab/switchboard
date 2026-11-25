/**
 * The tag CI's records on the records branch (never merged): main's bundle and bytes of the perf check's base measure,
 * and the tag's counts. They are written after a result and do not decide it (scripts/local-ci.ts keeps the pass or
 * fail; this file is a support file, merge-gate's `security:gate-support`).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BYTES_RECORDS_HEADER, BYTES_RECORDS_PATH, bytesRows, COUNTS_RECORDS_HEADER, COUNTS_RECORDS_PATH, countsRows, type Env, recordRow, RECORDS_BRANCH, RECORDS_HEADER, RECORDS_PATH, type Budget, type JourneyBytes } from "./perf-ratchet.ts";
import type { Deps } from "./local-ci.ts";

/**
 * Appends one row (when, js, css, main's sha) to bundle.tsv on the records branch of `repo`, from the
 * perf-base.json the CI wrote in `dir` (main's tip measured in the same run); "none" without that file. A measure is a
 * row: the same main measured twice is two rows.
 */
export async function recordBundle(repo: string, dir: string, measuredAt: string, sh: Deps["sh"]): Promise<"recorded" | "none"> {
  const file = join(dir, "perf-base.json");
  if (!existsSync(file)) return "none";
  const row = recordRow(measuredAt, JSON.parse(readFileSync(file, "utf8")) as { sha: string; bundle: { js: number; css: number } });
  await appendRecord(repo, RECORDS_PATH, RECORDS_HEADER, [row], `${RECORDS_BRANCH}: bundle ${measuredAt}`, sh);
  return "recorded";
}

/**
 * Appends main's `bytes` of the same measure to bytes.tsv on the records branch, a row per response's path
 * (`bytesRows`); "none" without perf-base.json or without its `journeys` (a main measured before perf-ratchet measured them).
 */
export async function recordBytes(repo: string, dir: string, measuredAt: string, sh: Deps["sh"]): Promise<"recorded" | "none"> {
  const file = join(dir, "perf-base.json");
  if (!existsSync(file)) return "none";
  const base = JSON.parse(readFileSync(file, "utf8")) as { sha: string; journeys?: Record<string, JourneyBytes> };
  if (!base.journeys) return "none";
  await appendRecord(repo, BYTES_RECORDS_PATH, BYTES_RECORDS_HEADER, bytesRows(measuredAt, { sha: base.sha, journeys: base.journeys }), `${RECORDS_BRANCH}: bytes ${measuredAt}`, sh);
  return "recorded";
}

/**
 * Appends the counts of `dir`'s perf-result.json (the median of `--runs 5` this run measured) to counts.tsv on the records
 * branch, a row per count of `tag` at `sha` (`countsRows`); "none" without that file.
 */
export async function recordCounts(repo: string, dir: string, measuredAt: string, env: Env, tag: string, sha: string, sh: Deps["sh"]): Promise<"recorded" | "none"> {
  const file = join(dir, "perf-result.json");
  if (!existsSync(file)) return "none";
  await appendRecord(repo, COUNTS_RECORDS_PATH, COUNTS_RECORDS_HEADER, countsRows(measuredAt, env, tag, sha, JSON.parse(readFileSync(file, "utf8")) as Budget), `${RECORDS_BRANCH}: counts ${tag} ${measuredAt}`, sh);
  return "recorded";
}

/**
 * Appends `rows` to `path` on the records branch of `repo`, with `header` when the file is new. The branch is made once
 * (a root commit with a README, never merged). The file goes by the contents API with its sha; a 409 or 422 (another run
 * wrote first, or made the file first) reads it again and puts once more. A file the API no longer returns in base64
 * (over 1 MB) is an error, not an empty file: putting a row on it would replace every row.
 */
async function appendRecord(repo: string, path: string, header: string, rows: string[], message: string, sh: Deps["sh"]): Promise<void> {
  const api = (...a: string[]) => sh(["gh", "api", ...a]);
  const http = (code: number) => (e: unknown) => new RegExp(`HTTP ${code}\\b`).test(e instanceof Error ? e.message : String(e));
  const absent = <T>(e: unknown): T | undefined => {
    if (http(404)(e)) return undefined;
    throw e;
  };
  if (!(await api(`repos/${repo}/git/ref/heads/${RECORDS_BRANCH}`).then(() => true, absent<boolean>))) {
    const sha = async (...a: string[]) => (await api(...a, "-q", ".sha")).trim();
    const blob = await sha(`repos/${repo}/git/blobs`, "-f", "content=perf records; never merged", "-f", "encoding=utf-8");
    const tree = await sha(`repos/${repo}/git/trees`, "-f", "tree[][path]=README", "-f", "tree[][mode]=100644", "-f", "tree[][type]=blob", "-f", `tree[][sha]=${blob}`);
    const commit = await sha(`repos/${repo}/git/commits`, "-f", `message=${RECORDS_BRANCH}: root`, "-f", `tree=${tree}`);
    // 422: another run made the branch in between
    await api(`repos/${repo}/git/refs`, "-f", `ref=refs/heads/${RECORDS_BRANCH}`, "-f", `sha=${commit}`).catch((e: unknown) => {
      if (!http(422)(e)) throw e;
    });
  }
  const work = mkdtempSync(join(tmpdir(), "switchboard.perf-record."));
  try {
    for (let attempt = 1; ; attempt++) {
      type File = { sha: string; content: string; encoding?: string };
      const now = await api(`repos/${repo}/contents/${path}?ref=${RECORDS_BRANCH}`).then((o) => JSON.parse(o) as File, absent<File>);
      if (now && now.encoding !== "base64") throw new Error(`${RECORDS_BRANCH}/${path} を contents API で読めない（encoding ${now.encoding ?? "なし"}。1 MB を超えたら分ける）。書かない`);
      const text = now ? Buffer.from(now.content.replace(/\s/g, ""), "base64").toString("utf8") : `${header}\n`;
      const body = { message, branch: RECORDS_BRANCH, content: Buffer.from(`${text}${text.endsWith("\n") ? "" : "\n"}${rows.join("\n")}\n`).toString("base64"), ...(now ? { sha: now.sha } : {}) };
      // the body by a file: the whole file in base64 does not fit in the arguments for long
      const input = join(work, "put.json");
      writeFileSync(input, JSON.stringify(body));
      try {
        await api("-X", "PUT", `repos/${repo}/contents/${path}`, "--input", input);
        return;
      } catch (e) {
        if (attempt > 1 || !(http(409)(e) || http(422)(e))) throw e;
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
