import { closeSync, openSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { currentRepo } from "./repo.ts";
export type Bump = "major" | "minor" | "patch";

const BREAKING = /^[a-z]+(\([^)]*\))?!:/;
const FEAT = /^feat(\([^)]*\))?:/;

export function bumpType(subjects: string[]): Bump {
  if (subjects.some((s) => BREAKING.test(s))) return "major";
  if (subjects.some((s) => FEAT.test(s))) return "minor";
  return "patch";
}

export function nextVersion(latestTag: string | null, bump: Bump): string {
  if (!latestTag) return "v0.1.0";
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(latestTag);
  if (!m) throw new Error(`not a semver tag: ${latestTag}`);
  const [maj, min, pat] = m.slice(1).map(Number) as [number, number, number];
  if (bump === "major") return `v${maj + 1}.0.0`;
  if (bump === "minor") return `v${maj}.${min + 1}.0`;
  return `v${maj}.${min}.${pat + 1}`;
}

export function releaseNotes(commits: { sha: string; subject: string }[], prevTag: string | null, tag: string, repo = currentRepo()): string {
  const lines = commits.map(({ subject }) => {
    const m = /^(.*?)\s*\(#(\d+)\)$/.exec(subject);
    return m ? `- #${m[2]} ${m[1]}` : `- ${subject}`;
  });
  if (prevTag) lines.push("", `https://github.com/${repo}/compare/${prevTag}...${tag}`);
  return lines.join("\n") + "\n";
}

/** The newest strict `vX.Y.Z` tag of a `--sort=-v:refname` list; hand-made `v1.0` or `v1.0.0-rc1` are ignored, never fatal. */
export function latestSemver(tags: string[]): string | null {
  return tags.find((t) => /^v\d+\.\d+\.\d+$/.test(t)) ?? null;
}

export type Sh = (cmd: string[], input?: string) => { ok: boolean; out: string };

const lines = (out: string) => out.split("\n").filter(Boolean);

function commitsIn(sh: Sh, range: string) {
  return lines(must(sh, ["git", "log", "--format=%H%x09%s", range])).map((l) => {
    const [s, ...rest] = l.split("\t");
    return { sha: s!, subject: rest.join("\t") };
  });
}

/** The tag is pushed to `origin`, so it is `origin` (not gh's default repository) that must be `repo`. */
export function checkOrigin(sh: Sh, repo: string) {
  const url = must(sh, ["git", "remote", "get-url", "origin"]);
  const here = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?\/?$/.exec(url)?.[1];
  if (here?.toLowerCase() !== repo.toLowerCase()) throw new Error(`origin of the clone in the cwd is ${url}, not ${repo}`);
}

const RETRY = Symbol("retry");

/** Another strict `vX.Y.Z` tag on `sha` or a descendant of it, if any. */
function newerContaining(sh: Sh, sha: string, own: string): string | undefined {
  return lines(must(sh, ["git", "tag", "-l", "v*", "--sort=-v:refname"])).filter((t) => t !== own && /^v\d+\.\d+\.\d+$/.test(t)).find((t) => sh(["git", "merge-base", "--is-ancestor", sha, t]).ok);
}

function once(sha: string, sh: Sh, repo: string | undefined, target: string): string | typeof RETRY {
  const R = repo ? ["-R", repo] : [];
  const all = lines(must(sh, ["git", "tag", "-l", "v*", "--sort=-v:refname"]));
  const own = latestSemver(lines(must(sh, ["git", "tag", "--points-at", sha, "--list", "v*", "--sort=-v:refname"])));
  if (own) {
    if (sh(["gh", "release", "view", own, ...R]).ok) return `${sha} already has ${own} and its release`;
    const prev = latestSemver(all.slice(all.indexOf(own) + 1));
    must(sh, ["gh", "release", "create", own, "--title", own, "--notes-file", "-", "--verify-tag", ...R], releaseNotes(commitsIn(sh, prev ? `${prev}..${sha}` : sha), prev, own, target));
    return `created the missing release for ${own}`;
  }
  const latest = latestSemver(all);
  // A slower run for an older commit must not tag it after a newer one was tagged.
  if (latest && sh(["git", "merge-base", "--is-ancestor", sha, latest]).ok) return `${sha} is already contained in ${latest}`;
  if (!sh(["git", "merge-base", "--is-ancestor", sha, "origin/main"]).ok) throw new Error(`${sha} is not on origin/main`);
  const commits = commitsIn(sh, latest ? `${latest}..${sha}` : sha);
  const tag = nextVersion(latest, bumpType(commits.map((c) => c.subject)));
  must(sh, ["git", "tag", tag, sha]);
  // Another clone may have pushed the same version first: drop ours, read its tags again, decide again.
  if (!sh(["git", "push", "origin", tag]).ok) {
    sh(["git", "tag", "-d", tag]);
    return RETRY;
  }
  // Another clone may have tagged a descendant under another name before our push landed (an older fix → v1.0.1 after
  // its descendant's v1.1.0): ours would come after a newer commit's tag, so it is taken back. A descendant tagged after
  // this check pushed after ours, which keeps the order. A run cut off before this leaves a tag the next run gives its
  // Release: the versions are still the ones one run after the other would have made (the test "same tags as in turn").
  must(sh, ["git", "fetch", "origin", "--tags", "--force"]);
  const newer = newerContaining(sh, sha, tag);
  if (newer) {
    must(sh, ["git", "push", "origin", `:refs/tags/${tag}`]);
    sh(["git", "tag", "-d", tag]);
    return `${sha} is already contained in ${newer} (tagged by another run meanwhile; ${tag} taken back)`;
  }
  must(sh, ["gh", "release", "create", tag, "--title", tag, "--notes-file", "-", "--verify-tag", ...R], releaseNotes(commits, latest, tag, target));
  return `tagged ${sha} as ${tag}`;
}

/**
 * Tags `sha` and creates its GitHub Release when `sha` is on origin/main, without waiting for CI: a tag is not a CI
 * pass, scripts/tag-ci.ts runs CI on the tags and writes the result into their Releases. The tags and main are read from
 * origin first, so a run never builds on a tag GitHub does not have. A merge whose run was coalesced
 * away gets no tag of its own and goes into the next tag's notes. A tag already on `sha` whose Release is missing (the
 * push worked, `gh release create` did not) gets its Release now. A push that is rejected (another clone took that
 * version) drops the local tag and starts over from the tags then on origin, at most 3 times.
 * `repo`: another repository's backlog stage Task tags its merge from that repository's clone (the cwd) with --repo.
 */
export function run(sha: string, sh: Sh, repo?: string): string {
  if (repo) checkOrigin(sh, repo);
  const target = repo ?? currentRepo();
  for (let attempt = 1; attempt <= 3; attempt++) {
    must(sh, ["git", "fetch", "origin", "--tags", "--force", "+refs/heads/main:refs/remotes/origin/main"]);
    const r = once(sha, sh, repo, target);
    if (r !== RETRY) return r;
  }
  throw new Error("failed: git push of the tag was rejected 3 times (other clones tagging at the same time)");
}

const STALE_LOCK_MS = 30 * 60_000;

/**
 * One release-tag at a time on this clone (#915): a lock file in the git directory, made with O_EXCL. Another clone is
 * not seen by it — that race is the rejected push in `run`. A lock older than 30 minutes is a crashed run's and is taken.
 */
export function withReleaseLock<T>(gitDir: string, fn: () => T, now = Date.now()): T {
  const path = join(gitDir, "switchboard-release-tag.lock");
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch {
    if (now - statSync(path).mtimeMs < STALE_LOCK_MS) throw new Error(`another release-tag is running on this clone (${path})`);
    rmSync(path, { force: true });
    fd = openSync(path, "wx");
  }
  closeSync(fd);
  try {
    return fn();
  } finally {
    rmSync(path, { force: true });
  }
}

export const spawnSh: Sh = (cmd, input) => {
  const p = Bun.spawnSync(cmd, { stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stderr: "inherit" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim() };
};

export function must(sh: Sh, cmd: string[], input?: string): string {
  const r = sh(cmd, input);
  if (!r.ok) throw new Error(`failed: ${cmd.join(" ")}`);
  return r.out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const sha = args[0];
  const repoAt = args.indexOf("--repo");
  const repo = repoAt >= 0 ? args[repoAt + 1] : undefined;
  if (!sha || sha === "--repo" || (repoAt >= 0 && !/^[\w.-]+\/[\w.-]+$/.test(repo ?? ""))) {
    console.error("usage: bun scripts/release-tag.ts <sha> [--repo <owner/name>]");
    process.exit(2);
  }
  try {
    console.log(withReleaseLock(must(spawnSh, ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]), () => run(sha, spawnSh, repo)));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
