/**
 * How many consecutive release tags would switch without a restart: under the old rule (only the files under
 * NO_RESTART_PREFIXES differ) and under the new one (also files the daemon does not read), both from sb-rescue's own
 * `restartNeededFor`. A pair is counted from its older tag (the running version): the list of what the daemon reads
 * is that tag's own, got the way sb-rescue gets it (`daemonReadsOf` on the tag's tree). A tag without that list (older
 * than the command, or it fails or is incomplete) is judged without one, as sb-rescue does: the two places only.
 *
 *   bun scripts/promote-restart-stats.ts [--since YYYY-MM-DD] [--json]
 *
 * `--since` defaults to 30 days ago. Reads the tags of the repository the script lies in; writes nothing to it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonReadsOf, NO_RESTART_PREFIXES, restartNeededFor, run, type DaemonReads } from "../rescue/src/releases.ts";

export interface StatPair {
  from: string;
  to: string;
  files: string[];
  /** What the daemon started from `from` reads; null when that could not be known. */
  reads: DaemonReads | null;
}

export interface PairCounts {
  pairs: number;
  /** Pairs without a restart under the old rule. */
  before: number;
  /** Pairs without a restart under the new rule. */
  after: number;
  /** Pairs whose older tag gave no list (judged by the old rule). */
  withoutList: number;
  /** Pairs that only the new rule lets through, by the places their other files lie in. */
  movedBy: Record<string, number>;
}

/** The place a file is counted under: `*.test.ts`, else its top folder (`docs/`), else the file itself. */
export function placeOf(file: string): string {
  if (file.endsWith(".test.ts")) return "*.test.ts";
  const slash = file.indexOf("/");
  return slash < 0 ? file : file.slice(0, slash + 1);
}

export function countPairs(pairs: StatPair[]): PairCounts {
  const out: PairCounts = { pairs: pairs.length, before: 0, after: 0, withoutList: 0, movedBy: {} };
  for (const p of pairs) {
    const before = !restartNeededFor(p.files, null);
    const after = !restartNeededFor(p.files, p.reads);
    if (before) out.before++;
    if (after) out.after++;
    if (!p.reads) out.withoutList++;
    if (after && !before) {
      const places = new Set(p.files.filter((f) => !NO_RESTART_PREFIXES.some((x) => f.startsWith(x))).map(placeOf));
      const key = [...places].sort().join(" + ");
      out.movedBy[key] = (out.movedBy[key] ?? 0) + 1;
    }
  }
  return out;
}

/** Tags `v*` created on or after `since` (YYYY-MM-DD, local time), oldest first. */
export async function tagsSince(repo: string, since: string): Promise<string[]> {
  const from = new Date(`${since}T00:00:00`).getTime();
  if (Number.isNaN(from)) throw new Error(`--since must be YYYY-MM-DD: ${since}`);
  const out = await run(["git", "-C", repo, "tag", "--list", "v*", "--sort=creatordate", "--format=%(refname:short) %(creatordate:iso-strict)"], repo);
  return out.split("\n").filter(Boolean).map((l) => l.split(" ")).filter(([, d]) => new Date(d!).getTime() >= from).map(([t]) => t!);
}

/** The list of what a daemon started from `tag` reads, from the tag's own command on a copy of its tree; null without one. */
export async function readsAt(repo: string, tag: string, timeoutMs = 10_000): Promise<DaemonReads | null> {
  const has = Bun.spawnSync(["git", "-C", repo, "cat-file", "-e", `${tag}:packages/core/src/daemon-reads.ts`], { stderr: "ignore" });
  if (has.exitCode !== 0) return null;
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "switchboard.restart-stats.")); // the tree is written, then removed
  try {
    await run(["sh", "-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", repo, tag, dir], repo);
    return await daemonReadsOf(dir, timeoutMs);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function pairsOf(repo: string, tags: string[]): Promise<StatPair[]> {
  const pairs: StatPair[] = [];
  for (let i = 1; i < tags.length; i++) {
    const [from, to] = [tags[i - 1]!, tags[i]!];
    // read as sb-rescue reads it (restartNeeded): raw paths, so a name git would quote still matches what is read
    const files = (await run(["git", "-C", repo, "diff", "--name-only", "-z", "--no-renames", from, to], repo, true)).split("\0").filter(Boolean);
    pairs.push({ from, to, files, reads: await readsAt(repo, from) });
  }
  return pairs;
}

const NOTE = "The list of what the daemon reads is the older tag's of each pair; the comparison is with the tag before, " +
  "not with the version the running core started from, so more pairs show here than switch in practice.";

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--since");
  const since = at >= 0 ? args[at + 1]! : new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const repo = await run(["git", "-C", import.meta.dir, "rev-parse", "--show-toplevel"], import.meta.dir);
  const tags = await tagsSince(repo, since);
  const counts = countPairs(await pairsOf(repo, tags));
  const range = tags.length > 0 ? `${tags[0]}..${tags[tags.length - 1]}` : "(no tags)";
  if (args.includes("--json")) {
    console.log(JSON.stringify({ since, range, ...counts, note: NOTE }));
  } else {
    console.log(`since ${since}: ${range}`);
    console.log(`pairs: ${counts.pairs}`);
    console.log(`without a restart, old rule (${NO_RESTART_PREFIXES.join(", ")}): ${counts.before}`);
    console.log(`without a restart, new rule (also files the daemon does not read): ${counts.after}`);
    console.log(`pairs whose older tag has no list (judged by the old rule): ${counts.withoutList}`);
    for (const [place, n] of Object.entries(counts.movedBy).sort((a, b) => b[1] - a[1])) console.log(`  moved by ${place}: ${n}`);
    console.log(NOTE);
  }
}
