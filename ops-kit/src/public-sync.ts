/**
 * Sends the tree of a (private) repository's main to its public repository as one new commit, without its history.
 * The public repository, what goes, the files left out and the files rewritten come from the repository's `ops.config.json`
 * (`publicSync`); the checks and the `Private-Main:` trailer are the kit's. The commit is made with `git commit-tree <tree> -p <public main>`, so no
 * private commit becomes an ancestor and a push carries only the tree and the public repository's own history.
 * The first sync pushes a root commit to the empty public `main`; every later one opens a PR from `sync/<tag>` and merges it
 * (Rebase and merge) itself: a public PR is public once opened, so a human merge would check nothing. The version then gets
 * its public tag and Release in the same run.
 * Nothing private goes into the public commit, branch, PR or Release: the title is the version and there is no body (the
 * private commit subjects are internal notes; their list once carried private sha, issue numbers and host details). Which private commit
 * a public tree came from is kept in the private repository, as `refs/public-sync/trees/<public tree>` on `origin`.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { independentSync, type Publication } from "./public-version.ts";
import { findSecrets, NO_HOST, type HostAws } from "./secrets.ts";

/** The user names fixtures and docs write in home paths: placeholders, not a person's. */
const PLACEHOLDER_USERS = ["dev", "example", "me", "x", "<you>"];
/** The same rule as ci.yml's `no personal home paths`: the placeholders fixtures and docs use pass. `\/` so that this line is not a match itself. */
export const HOME_PATH = String.raw`\/Users\/(?!(${PLACEHOLDER_USERS.join("|")})(?![A-Za-z0-9._-])|")`;
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}/g;
/** Domains whose addresses are placeholders or public service addresses, not a person's. */
const EMAIL_OK = /@((.+\.)?example\.(com|org|invalid)|github\.com|users\.noreply\.github\.com|anthropic\.com|claude\.ai)$/i;
/** Private refs, one per public tree sent: the tree survives any merge method on the public side, the commit sha does not. */
export const TREES = "refs/public-sync/trees";
/** git's empty tree: what the first sync is compared with. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The public-side set every public tree gets (`ops-kit/public/`, public-kit.test.ts): its one placeholder is the public repository's `owner/name`. */
const KIT_PUBLIC = join(import.meta.dir, "..", "public");
export const PUBLIC_REPO = "__PUBLIC_REPO__";
export const README_SECTION = "## How this repository works";
const TEMPLATES = ".github/ISSUE_TEMPLATE";
const KIT_TEMPLATES = ["config.yml", "request.yml"];
const WORKFLOW = ".github/workflows/close-pull-requests.yml";
const SECURITY = "SECURITY.md";

/** `s` as literal text in a pattern, for `git grep -P` and JavaScript alike. */
const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * `repo` (`owner/name`) as a whole name: not inside a longer owner or name (`o/app` is not in `xo/app` or `o/app-public`),
 * while `.git` or a full stop may follow. One source for `git grep -P` and JavaScript, used with the case ignored.
 */
export function repoPattern(repo: string): string {
  return String.raw`(?<![A-Za-z0-9._-])${literal(repo)}(?![A-Za-z0-9_-]|\.(?!git(?![A-Za-z0-9._-]))[A-Za-z0-9._-])`;
}

/**
 * `user` in the path forms a home or a per-user temporary directory takes: `/home/<you>`, `/Users/<you>`,
 * `pytest-of-<you>`, `C:\Users\<you>` (also with the backslashes doubled, as JSON and JavaScript strings write them), not
 * inside a longer name. None for no name, one of the placeholders HOME_PATH lets pass, or one of `serviceUsers`: users
 * that are no one's (a host template's service user), whose homes the docs describe on purpose, compared ignoring case. `\/` as in HOME_PATH.
 */
function userPathPattern(user: string, serviceUsers: string[]): string | undefined {
  const same = (name: string) => name.toLowerCase() === user.toLowerCase(); // as the search, which ignores case
  if (!user || PLACEHOLDER_USERS.some(same) || serviceUsers.some(same)) return undefined;
  return String.raw`(\/home\/|\/Users\/|pytest-of-|C:\\\\?Users\\\\?)${literal(user)}(?![A-Za-z0-9._-])`;
}

/** The OS user running the sync; none when the system has no entry for it (a container's bare uid). */
function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "";
  }
}

/** `err`: the first line of stderr, kept for the commands whose reason the operator needs (a refused merge). */
export type Run = (cmd: string[], opts?: { input?: string; env?: Record<string, string> }) => { code: number; out: string; err?: string };

/**
 * `privateRepo`: this repository (`owner/name`); `target`: the public one. `include`: what goes public (paths, `dir/`
 * for a directory; omitted = the whole tree): a top-level entry added later stays private until it is named, a file
 * added under a named directory goes. `exclude`: the
 * exceptions inside it, files that only make sense in the private repository. `rewrite`: public-facing files in which
 * `privateRepo` is replaced by `target`.
 * `adopted`: the changes merged only on the public main are already in the private main, so the sync may replace them.
 * `user`: the name of the OS user running the sync, looked for in paths (default `os.userInfo().username`);
 * `serviceUsers`: OS users that are no one's, not looked for. `host`: the host's AWS names and accounts (`hostAws()`), looked for in
 * the change. */
export type Options = { host?: HostAws; privateRepo: string; target: string; include?: string[]; exclude?: string[]; rewrite?: string[]; versioning?: "independent"; source?: string; targetUrl?: string; dryRun?: boolean; adopted?: boolean; user?: string; serviceUsers?: string[] };

const ok = (r: { code: number; out: string }, cmd: string[]) => {
  if (r.code !== 0) throw new Error(`failed: ${cmd.join(" ")}`);
  return r.out;
};

/**
 * Which lines are `## ` headings: not the ones inside a fenced code block (CommonMark: a fence of 3+ backticks or
 * tildes opens it, and only a fence of the same character, at least as long, with nothing after it, closes it).
 */
function headings(lines: string[]): boolean[] {
  let fence: string | null = null;
  return lines.map((l) => {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (m && fence === null) {
      fence = m[1]!;
      return false;
    }
    if (m && fence !== null && m[1]![0] === fence[0] && m[1]!.length >= fence.length && m[2]!.trim() === "") {
      fence = null;
      return false;
    }
    return fence === null && l.startsWith("## ");
  });
}

/** The `## How this repository works` heading of a README, if it has one (outside fenced code). */
export function policySectionAt(readme: string): number {
  const lines = readme.split("\n");
  const heading = headings(lines);
  return lines.findIndex((l, i) => heading[i] && l.trimEnd() === README_SECTION);
}

/**
 * The README with the kit's policy section: in place of its own `## How this repository works` (up to the next `## `
 * heading), else before its first `## ` heading, else at the end. One blank line around the section; the same input
 * gives the same output on the next sync, so an unchanged repository sends nothing.
 */
export function withPolicySection(readme: string, section: string): string {
  const lines = readme.split("\n");
  const heading = headings(lines);
  let start = policySectionAt(readme);
  let end: number;
  if (start >= 0) {
    end = heading.findIndex((h, i) => h && i > start);
    if (end < 0) end = lines.length;
  } else {
    start = heading.indexOf(true);
    if (start < 0) start = lines.length;
    end = start;
  }
  const before = lines.slice(0, start);
  while (before.length && before[before.length - 1]!.trim() === "") before.pop();
  const after = lines.slice(end);
  while (after.length && after[0]!.trim() === "") after.shift();
  return [...before, ...(before.length ? [""] : []), section.trimEnd(), ...(after.length ? ["", ...after] : [""])].join("\n");
}

export function personalEmails(text: string): string[] {
  return [...new Set((text.match(EMAIL) ?? []).filter((e) => !EMAIL_OK.test(e)))];
}

/** git at the repository's top: `raw` gives the exit code, `git` the output (or a throw). */
type Git = { raw: (args: string[], o?: Parameters<Run>[1]) => ReturnType<Run>; git: (args: string[], o?: Parameters<Run>[1]) => string };

function gitAt(run: Run): Git {
  // Every git command runs at the repository's top: a path given to ls-files / update-index / ls-tree is relative to
  // the directory git runs in, while `<rev>:<path>` is not — and `ops-kit` may be started from a subdirectory.
  const top = ok(run(["git", "rev-parse", "--show-toplevel"]), ["git", "rev-parse", "--show-toplevel"]);
  const raw = (args: string[], o?: Parameters<Run>[1]) => run(["git", "-C", top, ...args], { ...o, env: { GIT_TERMINAL_PROMPT: "0", ...o?.env } }); // exit code wanted (`git grep` on a tree is limited to the directory git runs in, too)
  return { raw, git: (args, o) => ok(raw(args, o), ["git", ...args]) };
}

/** The tree to publish: the source tree, only what `include` names and without `exclude`, with `rewrite` pointing at the public repository. One builder for the sync and `check`. */
export function publicTree(src: string, opts: Pick<Options, "privateRepo" | "target" | "include" | "exclude" | "rewrite">, { raw, git }: Git): { tree: string; log: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "public-sync."));
  const log: string[] = [];
  const privateName = repoPattern(opts.privateRepo);
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    git(["read-tree", src], { env });
    const all = git(["ls-files", "-z", "--cached"], { env }).split("\0").filter(Boolean); // -z: paths as they are, unquoted
    const under = (p: string, entry: string) => (entry.endsWith("/") ? p.startsWith(entry) : p === entry);
    const named = (p: string) => !opts.include || opts.include.some((e) => under(p, e));
    // a directory written without its trailing slash would match no file: everything under it would go (include: none)
    for (const e of [...(opts.include ?? []), ...(opts.exclude ?? [])]) {
      if (!e.endsWith("/") && !all.includes(e) && all.some((p) => p.startsWith(`${e}/`))) throw new Error(`publicSync: ${e} is a directory: write it as ${e}/`);
    }
    const leftOut = (p: string) => !named(p) || (opts.exclude ?? []).some((e) => under(p, e));
    const out = all.filter(leftOut);
    // index only: `git rm --cached` refuses an entry that differs from both HEAD and the working tree (a --source tag);
    // the paths go on stdin, so a long list does not hit the limit of a command line
    if (out.length) git(["update-index", "--force-remove", "-z", "--stdin"], { env, input: out.map((p) => `${p}\0`).join("") });
    // checked once more in the index: update-index skips a path it cannot find, and a name that is not UTF-8 comes
    // back from ls-files as other bytes than git holds
    const stray = git(["ls-files", "-z", "--cached"], { env }).split("\0").filter((p) => p && leftOut(p));
    if (stray.length) throw new Error(`left in the tree although include / exclude leave it out:\n${stray.join("\n")}`);
    if (opts.include) {
      const missing = opts.include.filter((e) => !all.some((p) => under(p, e)));
      log.push(`included ${opts.include.join(", ")}: ${all.filter(named).length} of ${all.length} files${missing.length ? ` (not in the tree: ${missing.join(", ")})` : ""}`);
    }
    for (const e of opts.exclude ?? []) {
      const n = all.filter((p) => named(p) && under(p, e)).length;
      if (n) log.push(`excluded ${e}${e.endsWith("/") ? ` (${n} files)` : ""}`);
    }
    const left = new Set(out);
    for (const p of opts.rewrite ?? []) {
      if (left.has(p) || raw(["cat-file", "-e", `${src}:${p}`]).code !== 0) continue; // not sent: nothing to rewrite
      const body = git(["cat-file", "blob", `${src}:${p}`]);
      const rewritten = body.replace(new RegExp(privateName, "gi"), () => opts.target); // whole names only: the public name may start with the private one
      if (rewritten === body) continue;
      const blob = git(["hash-object", "-w", "--stdin"], { input: rewritten + "\n" });
      const mode = git(["ls-tree", src, "--", p]).split(" ")[0];
      git(["update-index", "--cacheinfo", `${mode},${blob},${p}`], { env });
      log.push(`rewrote ${opts.privateRepo} → ${opts.target} in ${p}`);
    }
    // The public-side set, in every tree (no setting): the Issue forms become the one request form, the workflow that
    // closes outside pull requests is added, SECURITY.md only where the repository has none, and README.md gets the
    // policy section. Read from the index, so excluded and rewritten files are seen as they will be sent.
    const kit = (rel: string) => readFileSync(join(KIT_PUBLIC, rel), "utf8").replaceAll(PUBLIC_REPO, opts.target);
    const indexed = (p: string) => git(["ls-files", "--cached", "--", p], { env }).split("\n").filter(Boolean);
    const put = (p: string, body: string) => git(["update-index", "--add", "--cacheinfo", `100644,${git(["hash-object", "-w", "--stdin"], { input: body })},${p}`], { env });
    const forms = indexed(TEMPLATES);
    if (forms.length) git(["update-index", "--force-remove", "--", ...forms], { env });
    for (const f of KIT_TEMPLATES) put(`${TEMPLATES}/${f}`, kit(`${TEMPLATES}/${f}`));
    log.push(`public kit: ${TEMPLATES}/ is ${KIT_TEMPLATES.join(", ")}${forms.length ? ` (removed ${forms.map((p) => p.slice(TEMPLATES.length + 1)).join(", ")})` : ""}`);
    put(WORKFLOW, kit(WORKFLOW));
    log.push(`public kit: added ${WORKFLOW}`);
    const own = [SECURITY, `.github/${SECURITY}`, `docs/${SECURITY}`].find((p) => indexed(p).length); // where GitHub reads it
    if (own) log.push(`public kit: kept the repository's ${own}`);
    else {
      put(SECURITY, kit(SECURITY));
      log.push(`public kit: added ${SECURITY}`);
    }
    const readme = git(["ls-files", "-s", "--", "README.md"], { env });
    if (!readme) throw new Error(`README.md is not in the tree: the public kit's "${README_SECTION}" section has nowhere to go`);
    const current = `${git(["cat-file", "blob", readme.split(/\s+/)[1]!])}\n`;
    const next = withPolicySection(current, kit("README.section.md"));
    put("README.md", next);
    const placed = next.split("\n");
    const placedHeadings = headings(placed);
    const section = policySectionAt(next);
    const after = placed.find((l, i) => i > section && placedHeadings[i]);
    log.push(`public kit: README.md — ${policySectionAt(current) >= 0 ? `replaced ${README_SECTION}` : after ? `inserted ${README_SECTION} before ${after}` : `appended ${README_SECTION} (no ## heading)`}`);
    return { tree: git(["write-tree"], { env }), log };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What the tree to publish must not hold, the same for the sync and `check`: the private repository's name (the
 * rewrite already replaced it where readers need the public one) in the files (binary ones too: -a) and their paths, a
 * home path (CI's rule), an address of a person, a secret-shaped value by the rules (with `host`'s AWS names and accounts
 * when given: `check` passes them where the host has them; the sync's first check does not). Throws on the first kind
 * found, with where.
 * git grep: 0 = a match, 1 = none, anything else = it failed, which must stop too.
 */
export function checkTree(tree: string, privateRepo: string, { raw, git }: Git, host: HostAws = NO_HOST): void {
  const privateName = repoPattern(privateRepo);
  const privateNames = raw(["grep", "-ainoP", "-e", privateName, tree]);
  if (privateNames.code !== 0 && privateNames.code !== 1) throw new Error("git grep for private repository failed");
  // -z: the paths as they are (without it git quotes a path with a tab or a non-ASCII letter, and `\t` hides the boundary)
  const paths = git(["ls-tree", "-r", "-z", "--name-only", tree]).split("\0").filter(Boolean);
  const inPaths = paths.filter((p) => new RegExp(privateName, "i").test(p));
  if (privateNames.code === 0 || inPaths.length) {
    throw new Error(`private repository name in public output:\n${privateNames.out}${inPaths.map((p) => `\n(path) ${p}`).join("")}`);
  }
  const home = raw(["grep", "-anP", HOME_PATH, tree, "--", ":!.github/workflows/ci.yml"]);
  if (home.code === 0) throw new Error(`a personal home path in the tree:\n${home.out}`);
  if (home.code !== 1) throw new Error("git grep for home paths failed");
  const mails = raw(["grep", "-ahoE", EMAIL.source, tree]);
  if (mails.code !== 0 && mails.code !== 1) throw new Error("git grep for e-mail addresses failed");
  const found = personalEmails(mails.out);
  if (found.length) throw new Error(`a personal e-mail address in the tree (${found.length})`);
  // every line of every file against the secret rules, as the sync reads a first sync
  const secrets = secretsBetween(EMPTY_TREE, tree, host, git).map((h) => `${h.file}:${h.line} (${h.kind})`);
  if (secrets.length) throw new Error(`${TREE_SECRETS}\n${[...new Set(secrets)].join("\n")}`);
}

const TREE_SECRETS = "a secret-shaped value in the tree:";

/**
 * A stop on a secret-shaped value in the tree, with one more line when origin/main's tree, built by origin/main's own
 * publicSync, passes `check`: the source is a tag from before the fix, checked by this kit's newer rules (the scheduled
 * sync sends the running release's tag, which lags main until the next promotion). The stop reads as waiting for a newer
 * tag rather than as a value to remove; the sync still stops. `main` loads origin/main's options (it may throw).
 */
export function withStaleNote(message: string, main: () => Pick<Options, "privateRepo" | "target" | "include" | "exclude" | "rewrite">, run: Run): string {
  if (!message.startsWith(TREE_SECRETS)) return message;
  try {
    check({ ...main(), source: "origin/main" }, run);
  } catch {
    return message;
  }
  return `${message}\norigin/main's tree has none: the source is older than the fix. Send a tag that has it once that tag runs (promote it), with no edit`;
}

/**
 * The lines `to` adds over `from`, by file, against the kit's secret rules (the same as the gh guard's) with `host`'s AWS
 * names and accounts. A hit says the kind and the place, never the value; `line` counts the file's added lines, which
 * from the empty tree are its lines.
 */
function secretsBetween(from: string, to: string, host: HostAws, git: Git["git"]): Array<{ file: string; line: number; kind: string }> {
  // --text: a file git calls binary is read too. The added lines of a file are read as one text (in order), so a rule that
  // looks at the label above a value sees an added label; an unchanged label line is not in the diff.
  const diff = git(["diff", "--text", "--no-textconv", "--unified=0", "--no-color", "--no-ext-diff", from, to]);
  const added = new Map<string, string[]>();
  let file = "";
  let header = false; // between `diff --git` and the first hunk: an added line can begin with "++ " too
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) header = true;
    else if (header && line.startsWith("+++ ")) file = line.slice(6);
    else if (line.startsWith("@@")) header = false;
    else if (!header && line.startsWith("+")) {
      const lines = added.get(file) ?? [];
      lines.push(line.slice(1));
      added.set(file, lines);
    }
  }
  return [...added].flatMap(([file, lines]) => findSecrets(lines.join("\n"), host).map((h) => ({ file, ...h })));
}

/**
 * The checks of the tree to publish, without sending or reading the public side (no network): the tree of `source`
 * (default HEAD) built as the sync builds it, then `checkTree`. For CI, so that a change stops before it is merged
 * rather than at the sync after its tag.
 */
export function check(opts: Pick<Options, "host" | "privateRepo" | "target" | "include" | "exclude" | "rewrite" | "source">, run: Run): string {
  const g = gitAt(run);
  const src = g.git(["rev-parse", "--verify", `${opts.source ?? "HEAD"}^{commit}`]);
  const { tree } = publicTree(src, opts, g);
  checkTree(tree, opts.privateRepo, g, opts.host);
  return `public check: ok (${g.git(["ls-tree", "-r", "--name-only", tree]).split("\n").filter(Boolean).length} files)`;
}

export function sync(opts: Options, run: Run, publication?: Publication): string {
  if (opts.versioning && !publication) return independentSync(opts, run, (p, dryRun) => sync({ ...opts, dryRun: dryRun ?? opts.dryRun }, run, p));
  if (opts.target.toLowerCase() === opts.privateRepo.toLowerCase()) throw new Error(`the public repository is the private one (${opts.target}): set publicSync.target to another repository`);
  const source = opts.source ?? "origin/main";
  const url = opts.targetUrl ?? `https://github.com/${opts.target}.git`;
  const privateName = repoPattern(opts.privateRepo);
  const g = gitAt(run);
  const { raw, git } = g;
  const log: string[] = [];

  const src = git(["rev-parse", "--verify", `${source}^{commit}`]);
  // A --source that names a tag is a version: its name goes into the title, and later onto the public side as a release.
  const tag = publication?.version ?? (opts.source && raw(["rev-parse", "--verify", "-q", `refs/tags/${opts.source}`]).code === 0 ? opts.source : undefined);
  const remote = raw(["ls-remote", url, "refs/heads/main"], { env: { GIT_TERMINAL_PROMPT: "0" } });
  if (remote.code !== 0 && !opts.dryRun) throw new Error(`cannot read ${url} (does ${opts.target} exist?)`);
  if (remote.code !== 0) log.push(`${opts.target}: not reachable — dry-run as the first sync`);
  const initial = remote.code !== 0 || remote.out === "";

  // The public main must be exactly what the last sync left; anything merged only there would be overwritten.
  let parent: string | undefined;
  let lastPrivate: string | undefined;
  const publicMain = () => {
    git(["fetch", "-q", url, "+refs/heads/main:refs/public-sync/main"], { env: { GIT_TERMINAL_PROMPT: "0" } });
    return git(["rev-parse", "refs/public-sync/main"]);
  };
  const recorded = (commit: string) => raw(["rev-parse", "--verify", "-q", `${TREES}/${git(["rev-parse", `${commit}^{tree}`])}`]).out || undefined;
  if (!initial) {
    parent = publicMain();
    git(["fetch", "-q", "origin", `+${TREES}/*:${TREES}/*`], { env: { GIT_TERMINAL_PROMPT: "0" } });
    lastPrivate = recorded(parent);
    if (!lastPrivate) {
      if (!opts.adopted)
        throw new Error(`${opts.target} main changed after the last sync (its tree is not one this script sent): bring those changes into ${opts.privateRepo}, then sync with --adopted`);
      log.push(`${opts.target} main changed after the last sync: replaced (--adopted)`);
    }
    // a sync PR a failed run left open is merged now (only on a public main this script left, so nothing there is lost)
    // only a PR of this script: from a branch of the public repository itself (a fork's `sync/…` is someone else's), whose
    // tree has a record here (the record is pushed before the PR is opened)
    const [open, openBranch] = ok(run(["gh", "pr", "list", "-R", opts.target, "--state", "open", "--json", "number,headRefName,isCrossRepository", "-q", '.[] | select((.headRefName | startswith("sync/")) and (.isCrossRepository | not)) | "\\(.number) \\(.headRefName)"']), ["gh", "pr", "list"]).split("\n")[0]!.split(" ");
    if (open && openBranch) {
      git(["fetch", "-q", url, `+refs/heads/${openBranch}:refs/public-sync/pr`], { env: { GIT_TERMINAL_PROMPT: "0" } });
      if (!recorded("refs/public-sync/pr")) throw new Error(`sync PR #${open} on ${opts.target} has a tree this script did not send: close it`);
    }
    if (open && (opts.dryRun || !lastPrivate)) {
      if (!lastPrivate) throw new Error(`sync PR #${open} is still open on ${opts.target}: close it first (the public main changed after the last sync)`);
      log.push(`dry-run: would merge sync PR #${open} on ${opts.target}`);
    } else if (open) {
      merge(open, opts, run, log);
      parent = publicMain();
      lastPrivate = recorded(parent);
      if (!lastPrivate) throw new Error(`${opts.target} main after merging sync PR #${open} has no record of its tree in ${opts.privateRepo}`);
    }
    releaseLast(parent, opts, run, git, log);
  }

  const built = publicTree(src, opts, g);
  const tree = built.tree;
  log.push(...built.log);

  if (parent && tree === git(["rev-parse", `${parent}^{tree}`])) return [...log, `nothing to sync: ${opts.target} main already has this tree`].join("\n");

  // never backwards: a source older than the last sync would put an old tree on the public side (a hand run with a newer
  // commit, then the daily run with the latest tag)
  if (lastPrivate && src !== lastPrivate && raw(["merge-base", "--is-ancestor", src, lastPrivate]).code === 0)
    throw new Error(`${source} is older than what ${opts.target} has: nothing is sent backwards (send a newer tag)`);
  const title = tag ?? "sync";
  const branch = `sync/${tag ?? tree.slice(0, 7)}`;
  const message = `${title}\n`;

  checkTree(tree, opts.privateRepo, g);
  // The same in the message, and no address of a person in the author / committer the commit will carry (env and
  // config, as git itself resolves them).
  if (new RegExp(privateName, "i").test(message)) throw new Error("private repository name in public output:\n(commit message)");
  // -z: the paths as they are (without it git quotes a path with a tab or a non-ASCII letter, and `\t` hides the boundary)
  const paths = git(["ls-tree", "-r", "-z", "--name-only", tree]).split("\0").filter(Boolean);
  // The name of the OS user running the sync in a path: in the files (-a), their paths (from the tree's root, so a
  // top-level home/<you>/ counts) and the message. A placeholder name, a service user, or none, is not looked for.
  const userPath = userPathPattern(opts.user ?? osUser(), opts.serviceUsers ?? []);
  if (userPath) {
    const userFiles = raw(["grep", "-ainP", userPath, tree]); // -i: a Windows path ignores case
    if (userFiles.code !== 0 && userFiles.code !== 1) throw new Error("git grep for the OS user's name failed");
    const re = new RegExp(userPath, "i");
    const userPaths = paths.filter((p) => re.test(`/${p}`));
    const userMessage = re.test(message);
    if (userFiles.code === 0 || userPaths.length || userMessage) {
      throw new Error(`the OS user's name in a path in public output (a user that is no one's goes in publicSync.serviceUsers):\n${userFiles.out}${userPaths.map((p) => `\n(path) ${p}`).join("")}${userMessage ? "\n(commit message)" : ""}`);
    }
  }
  const ident = ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"].map((v) => git(["var", v])).join("\n");
  const found = personalEmails(`${message}\n${ident}`);
  if (found.length) throw new Error(`a personal e-mail address in the commit message or the author / committer (${found.length}); commit as your users.noreply.github.com address`);
  if (new RegExp(HOME_PATH).test(message)) throw new Error("a personal home path in the commit message");
  // what changes on the public side (every file the first time), with the host's AWS names and accounts too (the shapes
  // alone, the tree check above already judged in every file)
  const secrets = secretsBetween(parent ? `${parent}^{tree}` : EMPTY_TREE, tree, opts.host ?? NO_HOST, git).map((h) => `${h.file} (${h.kind})`);
  if (secrets.length) throw new Error(`a secret-shaped value in what would go public:\n${[...new Set(secrets)].join("\n")}`);
  log.push(`checks: no private repository name, no personal home path${userPath ? ", no path with the OS user's name" : ""}, no personal e-mail address, no secret-shaped value in the change`);

  publication?.prepare(tree);
  if (opts.dryRun) {
    log.push(`dry-run: would ${initial ? "push a root commit to main" : `open a PR from ${branch}`} on ${opts.target} with tree ${tree}`, "", message);
    return log.join("\n");
  }
  // the record of where this tree came from stays private, and goes first: a sync on the public side without its record
  // would stop the next run as "changed after the last sync". A record whose sync never lands (a failed push, a PR closed
  // unmerged) is one nothing looks up.
  git(["push", "-q", "origin", `${src}:${TREES}/${tree}`]);
  const commit = git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"], { input: message });
  if (initial) {
    git(["push", "-q", url, `${commit}:refs/heads/main`]);
    log.push(`pushed the first sync ${commit.slice(0, 7)} to ${opts.target} main`);
  } else {
    // Forced: a closed sync PR of the same tag leaves its branch behind, and no open sync PR uses it (checked above).
    git(["push", "-q", url, `+${commit}:refs/heads/${branch}`]);
    const pr = ok(run(["gh", "pr", "create", "-R", opts.target, "--base", "main", "--head", branch, "--title", title, "--body-file", "-"], { input: "" }), ["gh", "pr", "create"]);
    log.push(`opened ${pr}`);
    // a failed merge leaves the PR open with the reason; the next run merges it
    merge(branch, opts, run, log);
  }
  releaseLast(publicMain(), opts, run, git, log);
  return log.join("\n");
}

/** Rebase and merge (the public main takes PRs only, rebased): the head commit keeps its title, the version. */
function merge(pr: string, opts: Options, run: Run, log: string[]): void {
  const r = run(["gh", "pr", "merge", pr, "-R", opts.target, "--rebase", "--delete-branch"]);
  if (r.code !== 0) throw new Error(`could not merge sync PR ${pr} on ${opts.target} (it stays open; the next run merges it): ${r.err || `gh pr merge exited ${r.code}`}`);
  log.push(`merged sync PR ${pr} on ${opts.target}`);
}

/**
 * The version of the last sync on the public main (a commit titled `v1.2.3`) as a public tag and GitHub Release on
 * that commit, once: made through the API (`gh release create --target`), so nothing is pushed and no public workflow is
 * needed. A bare --target-url is not GitHub: its commits are not on the public repository.
 */
function releaseLast(last: string, opts: Options, run: Run, git: (args: string[]) => string, log: string[]): void {
  const version = /^v\d+\.\d+\.\d+$/.exec(git(["log", "-1", "--format=%s", last]))?.[0];
  if (!version) return;
  if (opts.targetUrl) return void log.push("release: skipped (--target-url)");
  if (opts.versioning) {
    const url = `https://github.com/${opts.target}.git`;
    const tags = git(["ls-remote", url, `refs/tags/${version}`, `refs/tags/${version}^{}`]);
    const target = tags.trim().split("\n").at(-1)?.split(/\s/)[0];
    if (target && target !== last) throw new Error(`public tag ${version} points at another commit`);
    const releases = ok(run(["gh", "api", "--paginate", `repos/${opts.target}/releases`, "--jq", ".[].tag_name"]), ["gh", "api", "releases"]);
    if (releases.split("\n").includes(version)) {
      if (!target) throw new Error(`public Release ${version} has no tag`);
      return;
    }
  } else if (run(["gh", "release", "view", version, "-R", opts.target, "--json", "tagName"]).code === 0) return;
  if (opts.dryRun) return void log.push(`dry-run: would release ${version} on ${opts.target} at ${last.slice(0, 7)}`);
  ok(run(["gh", "release", "create", version, "-R", opts.target, "--target", last, "--title", version, "--notes", ""]), ["gh", "release", "create"]);
  log.push(`released ${version} on ${opts.target} at ${last.slice(0, 7)}`);
}

export const spawnRun: Run = (cmd, o) => {
  const p = Bun.spawnSync(cmd, {
    stdin: o?.input === undefined ? "ignore" : new TextEncoder().encode(o.input),
    env: { ...process.env, ...o?.env },
    stderr: "pipe",
  });
  return { code: p.exitCode ?? 1, out: p.stdout.toString().replace(/\n$/, ""), err: p.stderr.toString().trim().split("\n")[0] };
};
