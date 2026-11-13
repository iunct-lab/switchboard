/**
 * CI on the release tags (#2953): a tag is made without waiting for CI (scripts/release-tag.ts), and
 * `bun scripts/tag-ci.ts [--repo <owner/name>]` runs the same steps as local-ci (ci.yml's `run:` steps, `bun scripts/ci.ts`
 * as that checkout's scripts/ci.ts steps, the same environment) on the newest `vX.Y.Z` tag that has no result yet, and
 * adds the result to the end of that tag's GitHub Release: `[tag-ci] pass|fail <sha>`. A fail walks back to the tag
 * before it, until a pass or a tag that already has a result; the tags walked past are not run. Before the walk, the
 * Releases missing from the newest tags are created (release-tag.ts's repairReleases: a tag whose `gh release create`
 * failed after its push). A tag whose Release still cannot be read is not run and the walk stops there. The perf steps (`bun scripts/perf-bench.ts`, `bun scripts/perf-ratchet.ts`) do not count toward the result: a tag whose only failed steps are perf's is a `[tag-ci] pass`, and the perf-ratchet's lines (`over:` / `raised:` / `grew:` / `improved:`, or a note that it could not judge) stay in the Release's `## CI` as a warning. Only a step that is not perf's turns a tag into a fail.
 * Output: one line of JSON, the tags looked at, newest first. Exit 0 = the newest tag passed (now or before), 1 = it
 * failed, 2 = nothing judged (no tag, no Release, not run, or recordings asked for and missing).
 * With SWITCHBOARD_FIXTURES given, a tag whose recordings are missing on this host is not run and gets no result: that
 * says what the host lacks, not how the tag is, and it stops the walk. Before that, Switchboard itself (no --repo) syncs
 * the recordings with their branch (#3532, `bun scripts/fixtures.ts sync`): the new ones go to it and the missing ones
 * come back from it; a failed sync is logged and the check above judges. At most MAX_TAG_RUNS tags run in one go.
 * For the newest tag (#2936; a fail before the walk and again after it, anything else after it; Switchboard itself, no --repo): a fail files a request (type:request, from a
 * scheduled check) unless one with the same title is open, which gets a comment naming the tag instead; a pass comments
 * on the open tag-CI requests (they stay open: the PBI that fixed it closes them). What an open request already says is
 * not said again. With --repo no request is filed: a fail prints the request's text to stderr on every run (the
 * scheduled Task reports it as its stop).
 * A run whose steps all ran and whose `bun test` passed (a perf-only fail too) also compares the type check's and bun
 * test's seconds with the `local.durations` ceilings of scripts/perf-budget.json (local-ci's `durationOver`): the `over:`
 * lines stay in the Release's `## CI` under `所要時間が上限を超えた（結果は変えない）:`, and the result, the exit code and
 * the requests do not change (a budget that cannot be read compares nothing).
 * A red `bun test` also gets a `selection:` line in the Release: of the test files that failed, how many a PR's narrowed
 * local-ci would have run for the change since the tag before (#3297, docs/merge-gate.md).
 * `--latest-pass [--contained-in <commit>]` (#2962) runs nothing: it prints the newest tag whose last result is pass
 * (a fail, no result and no Release are passed over), only from the tags in `<commit>`'s history when given (the
 * public sync gives the running release's commit). Exit 0 = printed, 1 = no tag passed (prints nothing), 2 = bad
 * arguments or an unknown commit.
 * A run waits (exit 0, the log says why, no mark anywhere) while fewer than SWITCHBOARD_TAG_CI_MIN_TAGS (default 8) tags
 * have no result, counted from the newest to the first tag with a result, and the oldest of them is younger than
 * SWITCHBOARD_TAG_CI_MAX_WAIT_HOURS (default 6) by its `creatordate` (#4079): the schedule can run more often than that.
 * After its report, the scheduled run (Switchboard itself, no --repo) looks at the public sync (#3601,
 * scripts/public-stall.ts): a tag newer than the newest pass for more than 24 hours files a request with the reasons
 * (the tags this run did not judge give theirs, e.g. the missing recordings), or comments on the open one. A failure
 * there is written to stderr and leaves the exit code alone.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { forgeTargetOf, originOf } from "../ops-kit/src/forge.ts";
import { withHeavySlot } from "../ops-kit/src/heavy.ts";
import { findSecrets, hostAws, type HostAws } from "../ops-kit/src/secrets.ts";
import { FILE_DEPS, type Filed, type OpenRequest, commentRequest, fileRequest, openRequests, requestText } from "./file-request.ts";
import { BYTES_RECORDS_PATH, COUNTS_RECORDS_PATH, envOf, RECORDS_BRANCH, RECORDS_PATH } from "./perf-ratchet.ts";
import { requireRecordings } from "./recordings.ts";
import { must, repairReleases, withReleaseLock } from "./release-tag.ts";
import { knownLines, readKnownFailures, subtractKnown, type Subtracted } from "./known-failures.ts";
import { durationOver, isPerfStep, recordBundle, recordBytes, recordCounts, remoteRepo, runCheckout, selectTests, step, stepEnv, stepSeconds, TargetError, type Deps } from "./local-ci.ts";

/** A result's line in a Release's body: pass or fail, then the tag's commit. */
export const TAG_CI_RESULT = /^\[tag-ci\] (pass|fail) ([0-9a-f]{40})(?=\s|$)/m;

/** The last result of `sha` in a Release's body, or null: a later run's line outweighs an earlier one. */
export function tagResult(releaseBody: string, sha: string): "pass" | "fail" | null {
  let last: "pass" | "fail" | null = null;
  for (const m of releaseBody.matchAll(new RegExp(TAG_CI_RESULT.source, "gm"))) if (m[2] === sha) last = m[1] as "pass" | "fail";
  return last;
}

/** A line without host paths: the given roots (the worktree, its TMPDIR) by name, then any home directory as `~`. */
export function hidePaths(line: string, roots: Record<string, string> = {}, home = homedir()): string {
  let out = line;
  for (const [path, name] of Object.entries(roots)) out = out.replaceAll(path, name);
  return out.replaceAll(home, "~").replace(/\/(?:home|Users)\/[^/\s]+|\/root(?=\/|\s|$)/g, "~");
}

/** The heading of the perf warning in a Release's `## CI`; its lines follow, indented by 4 spaces. */
export const PERF_WARNING_HEADING = "perf の警告（合否には数えない）:";
/** The headings of the known failures (known-failures.json, read at the tag's commit): not `が落ちた:`, which failedIn reads. */
export const KNOWN_HEADING = "既知の失敗を差し引いた（known-failures.json、このタグのコミットの登録）:";
export const KNOWN_EXPIRED_HEADING = "期限切れで差し引かなかった:";
/** `unreadable` = the registry at the tag's commit could not be read: nothing taken off, the walk goes on. */
export interface KnownResult { subtracted: Subtracted[]; expired: Subtracted[]; unreadable?: string }
/** A known-failures section in the Release: its heading and the entries (the same lines as local-ci's comment, at most 20). */
const knownSection = (title: string, xs: Subtracted[] | undefined): string[] => knownLines(title, xs?.slice(0, 20)).slice(1);

/** The heading of the seconds over `local.durations` (not `が落ちた:`: failedIn reads that one). */
export const DURATIONS_HEADING = "所要時間が上限を超えた（結果は変えない）:";

/** The warning lines (without their indent) a Release's body carries under PERF_WARNING_HEADING; the last heading's, only while the 4-space indented lines follow it. */
export function warningsOf(body: string): string[] {
  const lines = body.split("\n");
  const at = lines.lastIndexOf(PERF_WARNING_HEADING);
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (!l.startsWith("    ")) break;
    out.push(l.slice(4));
  }
  return out;
}

/** Worsenings counted as streaking: the same key out this many runs in a row (docs/design/perf.md, "Wobble and worsening"). */
export const PERF_STREAK = 3;

/** One tag CI result's perf warning lines, as read back from its Release. */
export interface PerfRun { tag: string; sha: string; lines: string[] }

/** The keys of the `over:` / `grew:` warning lines (`over: launch.ms = 900 > 800` -> `launch.ms`); `raised:`, `improved:`, the `bytes:` note and a no-verdict line name none. */
export function perfKeys(lines: string[]): string[] {
  const keys: string[] = [];
  for (const l of lines) {
    const m = /^\s*(?:over|grew): (\S+)/.exec(l);
    if (m && !keys.includes(m[1]!)) keys.push(m[1]!);
  }
  return keys;
}

/** The keys of `now` that also stand in each of the first PERF_STREAK - 1 of `earlier` (the warning lines of the earlier results, newest first). Fewer earlier results than that: none. */
export function perfStreak(now: string[], earlier: string[][]): string[] {
  const before = earlier.slice(0, PERF_STREAK - 1);
  if (before.length < PERF_STREAK - 1) return [];
  const sets = before.map((l) => perfKeys(l));
  return perfKeys(now).filter((k) => sets.every((s) => s.includes(k)));
}

/**
 * What goes at the end of the Release's body: the mark, for a fail the step and what it named, and the perf warning
 * (the perf steps' lines; they do not count toward the result), each at most 20 lines, without host paths. When the
 * step's name or its lines have a value usable for auth (`findSecrets`), none of them is written: the mark stays, a note
 * says why the rest is missing.
 */
export function resultSection(r: { sha: string; ok: boolean; step?: string; fails?: string[]; warnings?: string[]; durations?: string[]; selection?: string; known?: KnownResult }, host: HostAws = hostAws()): string {
  // the mark is `[tag-ci] pass|fail <sha>` alone: it is what tagResult reads
  const out = ["", "", "## CI", `[tag-ci] ${r.ok ? "pass" : "fail"} ${r.sha}`, "", "`bun scripts/tag-ci.ts` がこのタグのコミットで `.github/workflows/ci.yml` の手順（local-ci と同じ）を回した。"];
  // an unnamed step's name is its script's first line, which may hold a path or a value as much as its output
  const step = hidePaths(r.step ?? "");
  const detail = [
    ...(r.ok ? [] : [`\`${step}\` が落ちた:`]),
    ...(r.fails ?? []).slice(0, 20).map((l) => `    ${hidePaths(l)}`),
    // failedIn reads the lines under "が落ちた:" up to the first line that is not indented: the heading ends them
    ...knownSection(KNOWN_HEADING, r.known?.subtracted).map((l) => hidePaths(l)),
    ...knownSection(KNOWN_EXPIRED_HEADING, r.known?.expired).map((l) => hidePaths(l)),
    ...(r.known?.unreadable ? [`known-failures.json（このタグのコミットの登録）を読めなかったので差し引いていない: ${hidePaths(r.known.unreadable)}`] : []),
    ...(r.warnings?.length ? [PERF_WARNING_HEADING, ...r.warnings.slice(0, 20).map((l) => `    ${hidePaths(l)}`)] : []),
    // not the heading failedIn reads, and it ends the lines above it; the ceilings do not decide the result
    ...(r.durations?.length ? [DURATIONS_HEADING, ...r.durations.slice(0, 20).map((l) => `    ${hidePaths(l)}`)] : []),
  ];
  if (detail.length === 0) return `${out.join("\n")}\n`;
  const safe = findSecrets(detail.join("\n"), host).length === 0;
  // the line is numbers or a fixed text; failedIn reads the indented lines before it
  return `${[...out, "", ...(safe ? detail : ["（落ちた手順の名前か行に認証に使える値が含まれるので書かない。実行したホストの記録（~/.cache の下）を見る）"]), ...(r.selection ? ["", r.selection] : [])].join("\n")}\n`;
}

/** The test files bun's output names as failed: the file heading above a `(fail)` line or an error outside any test, up to the closing list of failures (it has no headings). */
export function failedTestFiles(output: string): string[] {
  const files = new Set<string>();
  let file: string | undefined;
  for (const line of output.split("\n")) {
    if (/^\d+ tests? failed:$/.test(line)) break;
    file = /^(\S+\.test\.tsx?):$/.exec(line)?.[1] ?? file;
    if (file && (line.startsWith("(fail)") || line.startsWith("# Unhandled error between tests"))) files.add(file);
  }
  return [...files];
}

/** `files` split by whether the selection had them; `selected: null` = it chose every test. */
export function classifyMiss(files: string[], selected: string[] | null): { missed: string[]; selected: string[] } {
  const chosen = (f: string) => selected === null || selected.includes(f);
  return { missed: files.filter((f) => !chosen(f)), selected: files.filter(chosen) };
}

/** The `selection:` line of a red `bun test`: the selection for what changed since the tag before, against what failed. */
async function selectionLine(output: string, before: string | undefined, dir: string, env: Record<string, string>, d: TagCiDeps): Promise<string> {
  const files = failedTestFiles(output);
  if (files.length === 0) return "selection: unclassified（落ちたテストファイルを読めない）";
  if (!before) return "selection: unclassified（前のタグが無い）";
  // the line is an extra: the tag's result must not go with it
  const s = await selectTests(dir, async () => before, env, d).catch(() => undefined);
  if (!s || s.unjudged) return "selection: unclassified（前のタグとの差分か選択を読めない）";
  const { missed, selected } = classifyMiss(files, s.files);
  return `selection: missed ${missed.length} / selected ${selected.length}（落ちたテストファイル ${files.length} 件）`;
}

const STRICT = /^v\d+\.\d+\.\d+$/;

/** The `vX.Y.Z` tags of the clone at `root`, newest first; with `merged`, only those in that commit's history. */
async function listTags(root: string, sh: (cmd: string[]) => Promise<string>, merged?: string): Promise<string[]> {
  const cmd = ["git", "-C", root, "tag", "-l", "v*", "--sort=-v:refname", ...(merged ? ["--merged", merged] : [])];
  return (await sh(cmd)).split("\n").map((t) => t.trim()).filter((t) => STRICT.test(t));
}

export interface TagCiDeps extends Omit<Deps, "sh"> {
  /** Today (UTC, YYYY-MM-DD) for the registry's `until`; tests give theirs. */
  today?: string;
  /** Runs a command; throws on a non-zero exit. `input` goes to its stdin. */
  sh: (cmd: string[], cwd?: string, input?: string) => Promise<string>;
  /** Called when the newest tag has failed, before the walk: what it reports stays if the walk is cut. followUp runs again after the walk. */
  onNewest?: (entries: TagCiEntry[]) => Promise<void>;
  /** Given for Switchboard itself only: called when a run's perf warning has keys that stood in the warning of the two results before it too (PERF_STREAK in a row). `lines` = this run's warning lines; `earlier` = those results, newest first. */
  onPerfStreak?: (tag: string, sha: string, keys: string[], lines: string[], earlier: PerfRun[]) => Promise<void>;
  /** Called for a tag not judged because of missing recordings: the public sync's watch names them (#3601). */
  onSkip?: (tag: string, missing: string[]) => void;
  /** With SWITCHBOARD_FIXTURES given, run first: syncs the recordings folder with its branch (Switchboard itself only). Throws on a failure. */
  sync?: () => Promise<void>;
  /** Creates the Releases missing from the newest tags and returns their names (release-tag.ts's repairReleases). */
  repair?: () => Promise<string[]>;
  /**
   * Given for Switchboard itself only (no --repo): the run may wait for more tags to pile up (#4079) and calls this
   * with the reason, as logged, instead of running. Without it the run never waits (the other repositories keep
   * running on every scheduled run: the PBI leaves their frequency alone).
   */
  onWait?: (reason: string) => void;
  /** The environment the wait's limits are read from (default process.env). */
  env?: Record<string, string | undefined>;
  /** The current time in ms (default Date.now()). */
  now?: () => number;
}

/** The tags without a result that pile up before a run (#4079): the number that makes it run, and the hours after which the oldest does. */
export const DEFAULT_MIN_TAGS = 8;
export const DEFAULT_MAX_WAIT_HOURS = 6;

/** A non-negative number from an environment value; anything else (empty, text, negative) is `fallback`. */
export function envNumber(raw: string | undefined, fallback: number, integer = false): number {
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 && (!integer || Number.isInteger(n)) ? n : fallback;
}

/**
 * Why this run waits, or null to run: `pending` = the tags without a result, newest first, `at` in ms. It waits while
 * there are fewer than `min` of them and the oldest is younger than `maxWaitMs`. No pending tag is not a wait: the walk
 * reads what the newest tag has.
 */
export function waitForMore(pending: Array<{ tag: string; at: number }>, now: number, min: number, maxWaitMs: number): string | null {
  if (pending.length === 0 || pending.length >= min) return null;
  const oldest = pending.reduce((a, b) => (b.at < a.at ? b : a));
  const age = now - oldest.at;
  if (age >= maxWaitMs) return null;
  const hours = (ms: number) => Math.round((ms / 3_600_000) * 10) / 10;
  return `結果の無いタグが ${pending.length} 件（${min} 件未満）で、最古の ${oldest.tag} から ${hours(age)} 時間（${hours(maxWaitMs)} 時間未満）。溜まるか時間がたつまで回さない`;
}

/** The tags of `tags` (newest first) with no result yet, read from the newest until a tag with a result, a Release that cannot be read, or `limit` of them. */
async function pendingTags(tags: string[], root: string, repo: string, limit: number, d: TagCiDeps): Promise<Array<{ tag: string; at: number }>> {
  const dates = new Map<string, number>();
  for (const line of (await d.sh(["git", "-C", root, "for-each-ref", "--format=%(refname:short)\t%(creatordate:unix)", "refs/tags/v*"])).split("\n")) {
    const [tag, unix] = line.split("\t");
    if (tag && Number.isFinite(Number(unix)) && unix) dates.set(tag, Number(unix) * 1000);
  }
  const out: Array<{ tag: string; at: number }> = [];
  for (const tag of tags) {
    if (out.length >= limit) break;
    const sha = (await d.sh(["git", "-C", root, "rev-parse", `${tag}^{commit}`])).trim();
    const body = await d.sh(["gh", "release", "view", tag, "-R", repo, "--json", "body", "-q", ".body"]).catch(() => null);
    if (body === null || tagResult(body, sha)) break;
    // a date that cannot be read counts as old: the run goes on rather than waiting for ever
    out.push({ tag, at: dates.get(tag) ?? 0 });
  }
  return out;
}

/** The tags run in one go: a step of the walk takes minutes, and a run that is cut leaves no result. */
export const MAX_TAG_RUNS = 3;

/** `step` / `fails`: a fail run now, the failed step and its lines (without host paths). */
export interface TagCiEntry { tag: string; sha: string; result: "pass" | "fail"; ran: boolean; step?: string; fails?: string[] }

/**
 * main's bundle and bytes as this tag's run measured them (perf-base.json in `dir`) and the tag's own counts
 * (perf-result.json), pass or fail, on the records branch (#4105; docs/design/perf.md "Bundle history"). A failure is logged and changes nothing; a GitLab target is not recorded.
 */
export async function recordMeasures(repo: string, root: string, dir: string, tag: string, sha: string, d: Pick<TagCiDeps, "sh" | "log">): Promise<void> {
  const at = new Date().toISOString();
  await recordOne(root, d, "bundle", RECORDS_PATH, (r, dr, t, sh) => recordBundle(r, dr, t, sh), repo, dir, at);
  await recordOne(root, d, "bytes", BYTES_RECORDS_PATH, (r, dr, t, sh) => recordBytes(r, dr, t, sh), repo, dir, at);
  await recordCountsOf(repo, root, dir, tag, sha, d, at);
}

/** The counts of `dir`'s perf-result.json as `tag`'s row on the records branch. */
async function recordCountsOf(repo: string, root: string, dir: string, tag: string, sha: string, d: Pick<TagCiDeps, "sh" | "log">, at = new Date().toISOString()): Promise<void> {
  await recordOne(root, d, "counts", COUNTS_RECORDS_PATH, (r, dr, t, sh) => recordCounts(r, dr, t, envOf(undefined), tag, sha, sh), repo, dir, at);
}

async function recordOne(
  root: string,
  d: Pick<TagCiDeps, "sh" | "log">,
  what: string,
  path: string,
  record: (repo: string, dir: string, at: string, sh: TagCiDeps["sh"]) => Promise<"recorded" | "none">,
  repo: string,
  dir: string,
  at: string,
): Promise<void> {
  await (async () => (forgeTargetOf(root, originOf(root)).service === "gitlab" ? "none" : record(repo, dir, at, d.sh)))().then(
    (r) => r === "recorded" && d.log(`${what}の記録: ${RECORDS_BRANCH}/${path} に足した`),
    (e: unknown) => d.log(`${what}の記録に失敗（結果は変えない）: ${e instanceof Error ? e.message : String(e)}`),
  );
}

/** One tag's CI in its own worktree; the result to record. */
async function runTag(tag: string, before: string | undefined, sha: string, repo: string, root: string, d: TagCiDeps, cache: string) {
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, `switchboard.tag-ci-${tag}.`));
  const tmp = mkdtempSync(join(tmpdir(), `switchboard.tag-ci-${tag}-tmp.`));
  try {
    await d.sh(["git", "-C", root, "worktree", "add", "-q", "--detach", dir, sha]);
    const env = { ...stepEnv(tmp), ...(before ? { PERF_BASE_REF: before } : {}) };
    // a checkout without the list (another repository) has no recordings to ask for; one that cannot say is not judged
    if (requireRecordings() && existsSync(join(dir, "scripts/fixtures.ts"))) {
      const vars = Object.entries(env).map(([k, v]) => `${k}=${v}`);
      const listed = await d.sh(["env", "-i", ...vars, process.execPath, "scripts/fixtures.ts", "list"], dir).catch(() => null);
      if (listed === null) return { missing: ["（録画の一覧を読めなかった）"] };
      const missing = listed.split("\n").filter((l) => l.startsWith("missing ")).map((l) => l.slice("missing ".length));
      if (missing.length > 0) return { missing };
    }
    const run = await runCheckout(dir, env, `tag-ci-${repo.replaceAll("/", "_")}`, d, cache);
    await recordMeasures(repo, root, dir, tag, sha, d);
    // every failed step: a perf step's failure does not stop bun test (#2945)
    const failed = run.results.filter((x) => x.code !== 0);
    // the perf steps do not count toward the result (runCheckout lets them all keep going): only the others' failures are the tag's, and the perf-ratchet's lines are a warning in the Release
    let counted = failed.filter((f) => !isPerfStep(f));
    // bun test alone failed with (fail) lines: what the registry at this tag's commit names, in date, is no failure (the same rule as local-ci's: subtractKnown)
    let known: KnownResult | undefined;
    const bunFail = counted.length === 1 && counted[0]!.name === "bun test" && (counted[0]!.fails ?? []).some((l) => l.startsWith("(fail) ")) ? counted[0]! : undefined;
    const bunOutput = run.outputs["bun test"];
    if (bunFail && bunOutput !== undefined) {
      // a registry that cannot be read takes nothing off and says so: it must not stop the walk at this tag
      const registry = await readKnownFailures(d.sh, root, sha).catch((e: unknown) => (e as Error).message.split("\n")[0]!);
      const s = typeof registry === "string" ? null : subtractKnown(bunOutput, bunFail.fails!, registry, d.today ?? new Date().toISOString().slice(0, 10));
      if (typeof registry === "string") known = { subtracted: [], expired: [], unreadable: registry };
      else if (s) {
        if (s.subtracted.length || s.expired.length) known = { subtracted: s.subtracted, expired: s.expired };
        counted = s.rest.length === 0 ? [] : [{ ...bunFail, fails: s.rest }];
      }
    }
    const perfFailed = failed.some((f) => isPerfStep(f));
    const p = run.perf;
    const warnings = !perfFailed ? [] : p && !p.unknown ? [...p.raised, ...p.grew, ...p.improved, ...p.over] : ["perf の判定ができなかった（bench が落ちたか、check が判定の前に止まった）"];
    // the Release keeps 20 lines: each failed step gets its share
    const fails = counted.flatMap((f) => (f.fails ?? []).slice(0, Math.floor(20 / counted.length)));
    const test = run.outputs["bun test"];
    const selection = test !== undefined ? await selectionLine(test, before, dir, env, d) : undefined;
    // every step ran and bun test passed: its seconds and the type check's against the ceilings; a CI without those steps is not compared
    const bunTest = run.results.find((x) => x.name === "bun test");
    const compared = run.results.length === run.steps.length && bunTest?.code === 0 && existsSync(join(dir, "scripts/ci.ts"));
    // a CI without those steps (stepSeconds throws) or a budget that cannot be read compares nothing: the result stays
    const durations = compared ? await (async () => durationOver(dir, stepSeconds(run.results)))().catch(() => []) : [];
    const step = counted.length ? counted.map((f) => f.name).join(" / ") : undefined;
    const hide = (l: string) => hidePaths(l, { [dir]: "<checkout>", [tmp]: "<tmp>" });
    return { sha, ok: counted.length === 0, step, fails: fails.map(hide), warnings: warnings.map(hide), durations: durations.map(hide), selection, ...(known ? { known } : {}) };
  } finally {
    await d.sh(["git", "-C", root, "worktree", "remove", "--force", dir]).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Walks the tags of `repo` (its clone at `root`) newest first: see the file's comment. `cache`: the worktrees and failure logs (~/.cache; tests give their own). */
export async function tagCi(d: TagCiDeps, repo: string, root: string, cache = join(homedir(), ".cache"), host: HostAws = hostAws()): Promise<TagCiEntry[]> {
  return walkTags(d, repo, root, cache, host);
}

async function walkTags(d: TagCiDeps, repo: string, root: string, cache: string, host: HostAws): Promise<TagCiEntry[]> {
  // one heavy slot for the whole run (every tag it walks): the same as local-ci, whose steps it runs with every test
  return d.slot(`tag-ci ${repo}`, async () => {
    await d.sh(["git", "-C", root, "fetch", "-q", "origin", "--tags", "--force"]);
    // a recording made since the last run reaches the branch, and one this host lost comes back before the check reads the folder
    if (d.sync && requireRecordings()) {
      try {
        await d.sync();
      } catch (e) {
        d.log(`録画を枝と同期できなかった（${(e as Error).message}）`);
      }
    }
    // a tag left without a Release would stop every run here until someone made it by hand (v1.149.0, v1.166.0)
    if (d.repair) {
      try {
        for (const t of await d.repair()) d.log(`${t}: Release が無かったので作った（タグの push の後の作成が失敗していた）`);
      } catch (e) {
        d.log(`Release の欠けを作れなかった（${(e as Error).message}）`);
      }
    }
    const tags = await listTags(root, d.sh);
    // fewer than MIN tags without a result and the oldest not yet MAX_WAIT old: wait for more (#4079); no mark, the Release is untouched
    const env = d.env ?? process.env;
    const min = envNumber(env.SWITCHBOARD_TAG_CI_MIN_TAGS, DEFAULT_MIN_TAGS, true);
    const maxWaitMs = envNumber(env.SWITCHBOARD_TAG_CI_MAX_WAIT_HOURS, DEFAULT_MAX_WAIT_HOURS) * 3_600_000;
    if (d.onWait && min > 0) {
      const reason = waitForMore(await pendingTags(tags, root, repo, min, d), d.now?.() ?? Date.now(), min, maxWaitMs);
      if (reason !== null) {
        d.log(reason);
        d.onWait(reason);
        return [];
      }
    }
    const out: TagCiEntry[] = [];
    for (const [i, tag] of tags.entries()) {
      const sha = (await d.sh(["git", "-C", root, "rev-parse", `${tag}^{commit}`])).trim();
      const body = await d.sh(["gh", "release", "view", tag, "-R", repo, "--json", "body", "-q", ".body"]).catch(() => null);
      if (body === null) {
        d.log(`${tag}: release が無いか読めない（release-tag.ts で作る）。ここで止める`);
        break;
      }
      const known = tagResult(body, sha);
      if (known) {
        d.log(`${tag}: 結果あり（${known}）`);
        out.push({ tag, sha, result: known, ran: false });
        break;
      }
      d.log(`${tag}（${sha.slice(0, 7)}）を回す`);
      const r = await runTag(tag, tags[i + 1], sha, repo, root, d, cache);
      if ("missing" in r) {
        d.log(`${tag}: 録画が足りないので判定しない（印は書かない）: ${r.missing.join(" ")}`);
        d.onSkip?.(tag, r.missing);
        break;
      }
      await d.sh(["gh", "release", "edit", tag, "-R", repo, "--notes-file", "-"], undefined, `${body.trimEnd()}${resultSection(r, host)}`.trimStart());
      d.log(`${tag}: ${r.ok ? "pass" : "fail"}${r.warnings.length ? `（perf の警告 ${r.warnings.length} 件）` : ""}`);
      if (r.warnings.length && d.onPerfStreak) await perfStreakOf(d, tag, sha, r.warnings, tags.slice(i + 1), repo, root);
      out.push({ tag, sha, result: r.ok ? "pass" : "fail", ran: true, ...(r.ok ? {} : { step: hidePaths(r.step ?? ""), fails: r.fails }) });
      if (r.ok) break;
      if (out.length === 1) await d.onNewest?.(out);
      if (out.filter((e) => e.ran).length >= MAX_TAG_RUNS) {
        d.log(`${MAX_TAG_RUNS} タグ回したので遡りをここで止める`);
        break;
      }
    }
    return out;
  });
}

/**
 * The warnings of the results of the PERF_STREAK - 1 tags after `tag` that have a mark, newest first; a streak is told to
 * d.onPerfStreak. Only every few tags gets a result (the tag CI waits for SWITCHBOARD_TAG_CI_MIN_TAGS tags and runs the
 * newest), so the tags without a mark are passed over with no count of their own: the read stops at those results or at a
 * Release that cannot be read.
 */
async function perfStreakOf(d: TagCiDeps, tag: string, sha: string, lines: string[], older: string[], repo: string, root: string): Promise<void> {
  try {
    const earlier: PerfRun[] = [];
    for (const t of older) {
      if (earlier.length >= PERF_STREAK - 1) break;
      const s = (await d.sh(["git", "-C", root, "rev-parse", `${t}^{commit}`])).trim();
      const body = await d.sh(["gh", "release", "view", t, "-R", repo, "--json", "body", "-q", ".body"]).catch(() => null);
      if (body === null) break;
      if (tagResult(body, s)) earlier.push({ tag: t, sha: s, lines: warningsOf(body) });
    }
    const keys = perfStreak(lines, earlier.map((e) => e.lines));
    if (keys.length) await d.onPerfStreak!(tag, sha, keys, lines, earlier);
  } catch (e) {
    d.log(`${tag}: perf の悪化が続いたかを読めなかった（${(e as Error).message}）`);
  }
}

/** The first tag of `tags` (newest first) whose result is pass, or null. Stops reading at it. */
export async function latestPass(tags: string[], resultOf: (tag: string) => Promise<"pass" | "fail" | null>): Promise<string | null> {
  for (const tag of tags) if ((await resultOf(tag)) === "pass") return tag;
  return null;
}

/** `--latest-pass`: see the file's comment. Reads the Releases of `repo`; runs and edits nothing. */
export async function latestPassTag(sh: TagCiDeps["sh"], repo: string, root: string, containedIn?: string): Promise<string | null> {
  await sh(["git", "-C", root, "fetch", "-q", "origin", "--tags", "--force"]);
  return latestPass(await listTags(root, sh, containedIn), async (tag) => {
    const sha = (await sh(["git", "-C", root, "rev-parse", `${tag}^{commit}`])).trim();
    const body = await sh(["gh", "release", "view", tag, "-R", repo, "--json", "body", "-q", ".body"]).catch(() => null);
    return body === null ? null : tagResult(body, sha);
  });
}

/** `--latest-pass` and `--contained-in <commit>` taken off the arguments; the rest is for resolveRepo. */
export function parseArgs(args: string[]): { latestPass: boolean; containedIn: string | undefined; rest: string[] } {
  const at = args.indexOf("--contained-in");
  const containedIn = at < 0 ? undefined : args[at + 1];
  if (at >= 0 && (!containedIn || containedIn.startsWith("--"))) throw new TargetError("--contained-in の後にコミットを書く");
  const latestPass = args.includes("--latest-pass");
  if (at >= 0 && !latestPass) throw new TargetError("--contained-in は --latest-pass と一緒に使う");
  return { latestPass, containedIn, rest: args.filter((a, i) => a !== "--latest-pass" && (at < 0 || (i !== at && i !== at + 1))) };
}

/** 0 = the newest tag passed, 1 = it failed, 2 = nothing judged. */
export const tagCiExit = (entries: TagCiEntry[]): number => (entries[0] === undefined ? 2 : entries[0].result === "pass" ? 0 : 1);

/** The start of every tag-CI request's title: a pass comments on the open ones. */
export const REQUEST_TITLE = "要望: タグの CI が ";

/**
 * The request for a failed newest tag. The title is the step and a hash of its lines, so the same failure (same step,
 * same `(fail)` / `over:` / `raised:` lines) gets the same title and fileRequest files it once. No host paths; when the
 * step, its lines or the commits hold a value usable for auth, they are left out and a note says so.
 */
export function failureRequest(
  r: { tag: string; sha: string; step: string; fails: string[]; lastPass: string | null; commits: string[]; repo?: string },
  date = new Date().toISOString().slice(0, 10),
  host: HostAws = hostAws(),
): { title: string; body: string } {
  const step = hidePaths(r.step);
  const fails = r.fails.map((l) => hidePaths(l));
  const commits = r.commits.map((l) => hidePaths(l));
  // the lines a Release keeps (at most 20): a fail read back from it gets the same title
  const hash = createHash("sha256").update(fails.slice(0, 20).join("\n")).digest("hex").slice(0, 8);
  const range = r.lastPass ? `${r.lastPass}..${r.tag}` : null;
  const detail = [
    `手順: ${step}`,
    "行:",
    ...(fails.length ? fails.slice(0, 20).map((l) => `  ${l}`) : ["  （行なし）"]),
    `最後に通ったタグ: ${r.lastPass ?? "不明（遡りで見つからない。前のタグの Release の [tag-ci] を見る）"}`,
    // one squash merge per commit and one tag per merge: the count is all of `commits` (only 50 are listed)
    r.lastPass
      ? `戻す先の候補: ${r.lastPass}（${r.tag} まで ${r.commits.length} 件のマージ。戻すなら bun scripts/rollback-pr.ts ${r.lastPass} --repo ${r.repo ?? "<owner/name>"}）`
      : "戻す先の候補: 不明（最後に通ったタグが見つからない。前のタグの Release の [tag-ci] を見て、通ったタグを探す）",
    ...(range ? [`その間のコミット（${range}）:`, ...(commits.length ? commits.slice(0, 50).map((l) => `  ${l}`) : ["  （なし）"])] : []),
  ];
  const safe = findSecrets([step, ...detail].join("\n"), host).length === 0;
  // the title is the failure's alone (the step and the lines a Release keeps, as resultSection checks them): the commits
  // differ from run to run for the same failure
  const named = findSecrets([step, ...fails.slice(0, 20)].join("\n"), host).length === 0;
  const title = `${REQUEST_TITLE}${named ? step.slice(0, 80) : "（名前を書けない手順）"} で落ちる（${hash}）`;
  const body = [
    "## 要望",
    `タグの CI で最新のタグ ${r.tag} が落ちた。直してほしい（この要望は直した PBI が閉じる）。`,
    "",
    "````text",
    `落ちたタグ: ${r.tag}（${r.sha.slice(0, 7)}）`,
    ...(safe ? detail : ["（手順の名前・行・コミットに認証に使える値が含まれるので書かない。実行したホストの記録（~/.cache の下）を見る）"]),
    "````",
    "",
    `結果の全文は落ちたタグの Release の \`## CI\`（\`gh release view ${r.tag} --json body -q .body\`）。`,
    "",
    "## 出典",
    "- 誰の言葉: 定期の検査",
    `- いつ: ${date}`,
    "- 経路: タグの CI（scripts/tag-ci.ts）",
    "",
    "## 添付",
    "なし",
    "",
    "## 派生 PBI",
    "",
    "## 解釈メモ",
    "- 同じ手順・同じ行の失敗は同じ題になる。次のタグも同じく落ちればこの要望にコメントが付き、あとのタグが通れば「<タグ> で通った」とコメントが付く（閉じない）",
  ].join("\n");
  return { title, body };
}

export interface FollowDeps {
  sh: TagCiDeps["sh"];
  log: (line: string) => void;
  file: (req: { title: string; body: string }) => Promise<Filed>;
  comment: (ref: string, body: string) => Promise<void>;
  open: () => Promise<OpenRequest[]>;
  /** An open request's body and comments: a comment already there is not posted again. */
  text: (ref: string) => Promise<string>;
  /** With --repo: where the request's text goes instead of filing it. */
  print: (text: string) => void;
}

/** The failed step and its lines as resultSection wrote them in a Release's body (the last ones), or null when it wrote none. */
export function failedIn(releaseBody: string): { step: string; fails: string[] } | null {
  const m = [...releaseBody.matchAll(/^`(.*)` が落ちた:\n((?: {4}.*(?:\n|$))*)/gm)].at(-1);
  return m ? { step: m[1]!, fails: m[2]!.split("\n").filter(Boolean).map((l) => l.slice(4)) } : null;
}

/** The newest tag before `tag` whose Release says pass, read without running (at most 50; a tag without a Release stops it). */
async function passBefore(tag: string, repo: string, root: string, sh: TagCiDeps["sh"]): Promise<string | null> {
  const tags = await listTags(root, sh);
  for (const t of tags.slice(tags.indexOf(tag) + 1, tags.indexOf(tag) + 51)) {
    const sha = (await sh(["git", "-C", root, "rev-parse", `${t}^{commit}`])).trim();
    const body = await sh(["gh", "release", "view", t, "-R", repo, "--json", "body", "-q", ".body"]).catch(() => null);
    if (body === null) return null;
    if (tagResult(body, sha) === "pass") return t;
  }
  return null;
}

/** The newest tag before the walk's last one whose Release says pass (a pass the walk met first). */
async function lastPassBefore(entries: TagCiEntry[], repo: string, root: string, sh: TagCiDeps["sh"]): Promise<string | null> {
  return entries.find((e) => e.result === "pass")?.tag ?? passBefore(entries.at(-1)!.tag, repo, root, sh);
}

/**
 * See the file's comment. `self` = Switchboard itself (no --repo). It runs on every run, for the newest
 * tag whether it was run now or read from before, and says only what the open request does not say yet: a run whose
 * filing or comment failed is made up by the next one. A fail read from before is read back from its Release.
 */
export async function followUp(entries: TagCiEntry[], repo: string, root: string, self: boolean, d: FollowDeps, date?: string, host?: HostAws): Promise<void> {
  const newest = entries[0];
  if (!newest) return;
  if (newest.result === "pass") {
    if (!self) return;
    const said = `${newest.tag} で通った`;
    for (const o of (await d.open()).filter((o) => o.title.startsWith(REQUEST_TITLE))) {
      if ((await d.text(o.ref)).split("\n").some((l) => l.trim() === said)) continue;
      await d.comment(o.ref, said);
      d.log(`要望 ${o.ref}: ${said}とコメントした`);
    }
    return;
  }
  const failed = newest.ran
    ? { step: newest.step ?? "", fails: newest.fails ?? [] }
    : failedIn(await d.sh(["gh", "release", "view", newest.tag, "-R", repo, "--json", "body", "-q", ".body"]));
  if (failed === null) {
    d.log(`${newest.tag}: Release に落ちた手順が書かれていない（認証に使える値で省いた）。要望は立てない`);
    return;
  }
  const lastPass = await lastPassBefore(entries, repo, root, d.sh);
  const commits = lastPass ? (await d.sh(["git", "-C", root, "log", "--format=%h %s", `${lastPass}..${newest.tag}`])).split("\n").filter(Boolean) : [];
  const req = failureRequest({ tag: newest.tag, sha: newest.sha, ...failed, lastPass, commits, repo }, date, host);
  if (!self) {
    d.print(`要望は立てない（--repo）。止まった理由として報告する:\n${req.title}\n\n${req.body}`);
    return;
  }
  const r = await d.file(req);
  if (!("open" in r)) {
    d.log(`要望を立てた: ${r.filed === null ? "番号不明" : `#${r.filed}`}`);
    return;
  }
  // the request's body (filed for this tag) or an earlier comment names the tag and its commit
  const named = `${newest.tag}（${newest.sha.slice(0, 7)}）`;
  const said = await d.text(r.open);
  if (!said.includes(named)) {
    await d.comment(r.open, `${named}でも同じ失敗`);
    d.log(`要望: 既存 ${r.open} にコメントした（起票しない）`);
  }
  // filed before the walk, or by a run cut after it: a nearer pass narrows the commits
  if (lastPass && !said.includes(`最後に通ったタグ: ${lastPass}`)) await d.comment(r.open, `最後に通ったタグ: ${lastPass}（間のコミット ${commits.length} 件）。戻す先の候補: ${lastPass}（間のマージ ${commits.length} 件。戻すなら bun scripts/rollback-pr.ts ${lastPass} --repo ${repo}）`);
}

/** The title of the request for a key that stayed out PERF_STREAK results in a row. */
export const perfStreakTitle = (key: string): string => `perf が悪化し続けている: ${key}`;

/**
 * One request per key (`type:request`, `誰の言葉: 定期の検査`), or a comment `<tag>（<sha7>）でも続いた` on the open one
 * with the same title (once per tag). `lines` = the run's warning lines; the key's own are quoted.
 */
export async function perfStreakFollow(tag: string, sha: string, keys: string[], lines: string[], d: FollowDeps, date = new Date().toISOString().slice(0, 10), earlier: PerfRun[] = []): Promise<void> {
  const named = `${tag}（${sha.slice(0, 7)}）`;
  for (const key of keys) {
    const of = (ls: string[]) => ls.filter((l) => perfKeys([l])[0] === key).map((l) => `    ${hidePaths(l)}`);
    // each tag of the streak with its own line for the key, this run first
    const mine = [{ tag, sha, lines }, ...earlier].flatMap((r) => [`  ${r.tag}（${r.sha.slice(0, 7)}）:`, ...of(r.lines)]);
    const req = {
      title: perfStreakTitle(key),
      body: [
        "## 要望",
        `タグの CI の perf の警告で、\`${key}\` が ${PERF_STREAK} 回の実行続けて天井を超えた・増えた（\`over:\` / \`grew:\`）。揺れではなく悪化の形なので、原因を絞って直してほしい（この要望は直した PBI が閉じる）。`,
        "",
        "````text",
        `続いたタグ: ${named}（この実行が ${PERF_STREAK} 回目）`,
        "行:",
        ...mine,
        "````",
        "",
        `各タグの行は Release の \`## CI\` の「${PERF_WARNING_HEADING}」（\`gh release view ${tag} --json body -q .body\`）。1 回や 2 回の外れは揺れとして要望にしない（docs/design/perf.md の「Wobble and worsening」）。`,
        "",
        "## 出典",
        "- 誰の言葉: 定期の検査",
        `- いつ: ${date}`,
        "- 経路: タグの CI（scripts/tag-ci.ts）",
        "",
        "## 添付",
        "なし",
        "",
        "## 派生 PBI",
        "",
        "## 解釈メモ",
        "- 同じ数の悪化が続く間は、次のタグごとにこの要望にコメントが付く（閉じない）",
      ].join("\n"),
    };
    const r = await d.file(req);
    if (!("open" in r)) {
      d.log(`要望を立てた（perf の悪化 ${key}）: ${r.filed === null ? "番号不明" : `#${r.filed}`}`);
      continue;
    }
    if (!(await d.text(r.open)).includes(named)) {
      await d.comment(r.open, `${named}でも続いた`);
      d.log(`要望: 既存 ${r.open} にコメントした（${key}）`);
    }
  }
}

/** The repository and its clone from `[--repo <owner/name>]`, as local-ci's resolveTarget reads them (GitHub only: the results go on GitHub Releases). */
export async function resolveRepo(args: string[], cwd: string, scriptRoot: string, run: Deps["sh"]): Promise<{ repo: string; root: string }> {
  const at = args.indexOf("--repo");
  const unknown = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
  if (unknown.length > 0) throw new TargetError(`知らない引数: ${unknown.join(" ")}`);
  const originAt = async (root: string) => (await run(["git", "-C", root, "remote", "get-url", "origin"]).catch(() => "")).trim();
  if (at < 0) {
    const url = await originAt(scriptRoot);
    const repo = remoteRepo(url);
    if (!repo) throw new TargetError(`${scriptRoot} の origin（${url ? "GitHub の owner/name として読めない URL" : "無し"}）から対象が分からない（--repo <owner/name> を付ける）`);
    return { repo, root: scriptRoot };
  }
  const repo = args[at + 1] ?? "";
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new TargetError(`--repo は owner/name の形で: ${repo || "（空）"}`);
  const root = (await run(["git", "-C", cwd, "rev-parse", "--show-toplevel"]).catch(() => {
    throw new TargetError(`${cwd} は git の作業ツリーでない（${repo} の作業ツリーから実行する）`);
  })).trim();
  const url = await originAt(root);
  const origin = remoteRepo(url);
  if (origin?.toLowerCase() !== repo.toLowerCase()) {
    throw new TargetError(`${root} の origin（${origin ?? (url ? "GitHub の owner/name として読めない URL" : "無し")}）が --repo ${repo} と違う（${repo} の作業ツリーから実行する）`);
  }
  return { repo, root };
}

const sh: TagCiDeps["sh"] = async (cmd, cwd, input) => {
  const p = Bun.spawn(cmd, { cwd, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} failed: ${err.trim()}`);
  return out;
};

if (import.meta.main) {
  let t: { repo: string; root: string };
  let a: ReturnType<typeof parseArgs>;
  try {
    a = parseArgs(process.argv.slice(2));
    t = await resolveRepo(a.rest, process.cwd(), join(import.meta.dir, ".."), sh);
  } catch (e) {
    if (!(e instanceof TargetError)) throw e;
    console.error(`${e.message}\nusage: bun scripts/tag-ci.ts [--repo <owner/name>]\n       bun scripts/tag-ci.ts --latest-pass [--contained-in <commit>] [--repo <owner/name>]`);
    process.exit(2);
  }
  if (a.latestPass) {
    const tag = await latestPassTag(sh, t.repo, t.root, a.containedIn).catch((e: Error) => {
      console.error(e.message);
      process.exit(2);
    });
    if (tag) console.log(tag);
    process.exit(tag ? 0 : 1);
  }
  // stdout is the JSON only
  const log = (l: string) => console.error(l);
  // fileRequest's own output goes to stderr: stdout is the JSON only
  const file = (req: { title: string; body: string }) => fileRequest(req, { ...FILE_DEPS, out: (o) => process.stderr.write(o) });
  const report = async (entries: TagCiEntry[]) => {
    try {
      await followUp(entries, t.repo, t.root, !process.argv.includes("--repo"), { sh, log, file, comment: commentRequest, open: openRequests, text: requestText, print: log });
    } catch (e) {
      console.error(`要望: 起票かコメントができなかった（${(e as Error).message}）`);
    }
  };
  const missingOf: Record<string, string[]> = {};
  let waited = false;
  const onWait = () => void (waited = true);
  const onSkip = (tag: string, missing: string[]) => void (missingOf[tag] = missing);
  const repair = async () => {
    const at = (cmd: string[], input?: string) => {
      const p = Bun.spawnSync(cmd, { cwd: t.root, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stderr: "inherit" });
      return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
    };
    // the same lock as release-tag.ts on this clone: the two would otherwise both create the missing Release
    return withReleaseLock(must(at, ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]), () => repairReleases(at, t.repo));
  };
  // fixtures.ts's own clone is t.root without --repo; its output goes to stderr: stdout is the JSON only
  const sync = async () => void log((await sh([process.execPath, join(import.meta.dir, "fixtures.ts"), "sync"], t.root)).trim());
  const self = !process.argv.includes("--repo");
  const onPerfStreak = (tag: string, sha: string, keys: string[], lines: string[], earlier: PerfRun[]) =>
    perfStreakFollow(tag, sha, keys, lines, { sh, log, file, comment: commentRequest, open: openRequests, text: requestText, print: log }, undefined, earlier);
  const entries = await tagCi({ sh, step, log, onNewest: report, onSkip, repair, ...(self ? { sync, onWait, onPerfStreak } : {}), slot: (name, fn) => withHeavySlot(name, fn) }, t.repo, t.root);
  console.log(JSON.stringify(entries));
  await report(entries);
  if (!process.argv.includes("--repo")) {
    try {
      // imported here: public-stall.ts imports this file
      const { publicTarget, skipReason, stallFollow } = await import("./public-stall.ts");
      const skipped = Object.fromEntries(Object.entries(missingOf).map(([tag, missing]) => [tag, skipReason(missing)]));
      await stallFollow(t.repo, t.root, { sh, log, file, comment: commentRequest, open: openRequests, text: requestText, print: log }, { target: publicTarget(t.root), skipped });
    } catch (e) {
      console.error(`公開の同期の見張り: 判定か起票ができなかった（${(e as Error).message}）`);
    }
  }
  // a wait is not "nothing judged": the next run decides
  process.exit(waited ? 0 : tagCiExit(entries));
}
