import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { extraReviewerOf, mergeGateOf } from "../../../ops-kit/src/config.ts";
import { type Conditions, primaryReviewer, renderConditions } from "../../../ops-kit/src/conditions.ts";
import { findRepoRoot } from "./config.ts";

/**
 * Development-standard skills in every repository a task runs in (docs/design/skill-sync.md): before a runner
 * starts, each skill of the meta workspace is copied into the task's repository where Claude Code and Codex read
 * project skills, and the copies are listed in `.git/info/exclude` so the repository's tracked files never change.
 * The copy is rendered for the Task: of the source's condition blocks (`ops-kit/src/conditions.ts`) only the side that
 * matches the Task's runner, the review setting and the repository stays.
 * A copy, not a link: the permission check resolves a link to where it points, outside the repository's workspace.
 */
/** The shared development-flow skills, in the kit (the meta repository's own skills stay tracked in .claude/skills). */
export const SKILL_SOURCE = "ops-kit/skills";
/** Where each runner reads project skills. A Task writes only its own runner's place, so Tasks of the two runners never rewrite each other's copies. */
export const SKILL_TARGET_OF = { claude: ".claude/skills", codex: ".agents/skills" } as const;
export const SKILL_TARGETS: string[] = Object.values(SKILL_TARGET_OF);
/** The file inside a placed copy that marks it as Switchboard's; it holds the hash of the copy's content as it was rendered. */
export const SKILL_MARKER = ".switchboard-skill";

const BLOCK_START = "# >>> switchboard skills (managed)";
const BLOCK_END = "# <<< switchboard skills";

export interface SkillSyncResult {
  linked: string[];
  unchanged: string[];
  removed: string[];
  /** A skill the repository has of its own (a real folder, or a link somewhere else); left as it is. */
  skipped: Array<{ name: string; path: string }>;
}

/** Where a repository keeps its operating tools (the scripts that run the backlog). */
export const SETUP_DIR = "scripts/setup";

export interface SetupScripts {
  /** The repository has its own `ops.config.json`. */
  config: boolean;
  /** Entries (named like the meta's) that call the shared kit's CLI (`src/cli.ts`), the kit itself or a bundled copy. */
  kit: string[];
  /** Entries named like the meta's that do not call the kit: copies of the tools from before the kit. */
  copies: string[];
  /** The repository has no `ops.config.json` and its workspace's settings are kept on Switchboard's side (the kit is handed them by `OPS_KIT_CONFIG`). */
  saved?: boolean;
}

const stem = (f: string) => f.slice(0, f.length - extname(f).length);

/**
 * Which of the repository's `scripts/setup` entries are copies of the meta's tools. Only names the meta has
 * (without the extension) count, so a repository's own scripts are not called copies. Nothing is changed: the scripts
 * are tracked files of the repository, not copies placed like the skills. A file that cannot be read throws.
 */
export function setupScripts({ metaPath, cwd, saved = "" }: { metaPath: string; cwd: string; /** The workspace's saved settings' file ("" = none). */ saved?: string }): SetupScripts {
  const out: SetupScripts = { config: false, kit: [], copies: [] };
  const top = git(cwd, "rev-parse", "--show-toplevel");
  if (top === null) return out;
  const root = realpathSync(top);
  out.config = existsSync(join(root, "ops.config.json"));
  // one rule (the kit's `configFileOf`): the repository's own file when it has one, else the saved settings
  if (!out.config && saved && existsSync(saved)) out.saved = true;
  const names = (d: string) => (existsSync(d) ? readdirSync(d).sort() : []);
  const known = new Set(names(join(metaPath, SETUP_DIR)).map(stem));
  for (const f of names(join(root, SETUP_DIR))) {
    if (!known.has(stem(f))) continue;
    (readFileSync(join(root, SETUP_DIR, f), "utf8").includes("src/cli.ts") ? out.kit : out.copies).push(f);
  }
  return out;
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  } catch {
    return null; // no git on this host
  }
}

/** The files under `dir` (paths from `dir`, sorted), without the marker. Follows a link to a folder, as the dereferencing copy does. */
function filesOf(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p !== join(dir, SKILL_MARKER)) out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

/** A hash of every file under `dir` (relative path and content), without the marker; `content` gives what a file holds once rendered (default: as it is). */
export function treeHash(dir: string, content: (rel: string) => Uint8Array | string = (rel) => readFileSync(join(dir, rel))): string {
  const h = createHash("sha256");
  for (const rel of filesOf(dir)) h.update(`${rel}\0`).update(content(rel)).update("\0");
  return h.digest("hex");
}

/** The first line of a placed SKILL.md's body: the copy is the Task's side only, and a session outside a Task reads the source. */
export const skillHeader = (sourcePath: string) =>
  `> アプリの Task 向けに描いた写し（task=in）。Task の外（SWITCHBOARD_TASK_ID が無い）では原本 ${sourcePath} を読む（原本は条件ごとの記載を全部持ち、条件を書いた印の行で分けてある）`;

/**
 * What a file of a skill holds in the copy: a Markdown file with only the blocks that match `conds`, and SKILL.md with
 * `skillHeader` right after its frontmatter. Any other file as it is.
 */
function renderedFile(sourceDir: string, rel: string, conds: Conditions): Uint8Array | string {
  const path = join(sourceDir, rel);
  if (!rel.endsWith(".md")) return readFileSync(path);
  const text = renderConditions(readFileSync(path, "utf8"), conds, path);
  if (rel !== "SKILL.md") return text;
  const lines = text.split("\n");
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1;
  lines.splice(end + 1, 0, ...(end < 0 ? [skillHeader(path), ""] : ["", skillHeader(path)]));
  return lines.join("\n");
}

/** The conditions of a repository's copies besides the runner: the review setting, and what the repository's `ops.config.json` and workspace say. */
function conditionsOf(root: string, runner: "claude" | "codex", review: "same" | "other", recheck: "same" | "other", backlog: "github" | "switchboard", saved: string): Conditions {
  // `saved`: the settings kept on Switchboard's side, read when the repository has no `ops.config.json` ("" = none; never the daemon's own environment)
  return { runner, review, recheck, reviewer: primaryReviewer(runner, review)!, task: "in", backlog: backlog === "github" ? "github" : "app", mergeGate: mergeGateOf(root, saved) ? "on" : "off", extra: extraReviewerOf(root, saved) ? "on" : "off" };
}

/** A copy Switchboard placed: a real folder with the marker. */
const isCopy = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true && existsSync(join(p, SKILL_MARKER));
/** What the marker holds while a copy is being placed (never a hash): `syncSkills` writes it first and the hash last. */
export const SKILL_INCOMPLETE = "incomplete";
/** A real folder with nothing in it: a placing that stopped before its first write. It holds no skill of anyone's, so it is placed like a missing one. */
const emptyDir = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true && readdirSync(p).length === 0;

export interface SkillSyncOptions {
  metaPath: string;
  cwd: string;
  /** The Task's runner: only its place is written (`SKILL_TARGET_OF`). A runner that reads neither place gets nothing; without a runner both places are written, each for its own runner. */
  runner?: string;
  /** The review setting now (default `other`). */
  review?: "same" | "other";
  /** The recheck and audit setting now (default `other`). */
  recheck?: "same" | "other";
  /** Where the backlog of the repository at `root` is kept (default `github`); asked for the Task's repository and for the meta checkout. */
  backlog?: (root: string) => "github" | "switchboard";
  /** The saved settings' file of the workspace of the repository at `root` (default none): `mergeGate` and `extraReviewer` are read from it when the repository has no `ops.config.json`. */
  savedConfig?: (root: string) => string;
}

export function syncSkills(opts: SkillSyncOptions): SkillSyncResult {
  const { metaPath, cwd, runner, review = "other", recheck = "other", backlog = () => "github" as const, savedConfig = () => "" } = opts;
  const result: SkillSyncResult = { linked: [], unchanged: [], removed: [], skipped: [] };
  const top = git(cwd, "rev-parse", "--show-toplevel");
  if (top === null) return result;
  const root = realpathSync(top);
  // The meta checkout first, so its .claude/skills/<name> copies exist before another repository's old links are
  // judged (links placed while the source was the meta's .claude/skills lead through them)
  const metaTop = git(metaPath, "rev-parse", "--show-toplevel");
  if (metaTop !== null && realpathSync(metaTop) !== root) syncSkills({ ...opts, cwd: metaPath });

  const source = existsSync(join(metaPath, SKILL_SOURCE)) ? realpathSync(join(metaPath, SKILL_SOURCE)) : resolve(metaPath, SKILL_SOURCE);
  const names = existsSync(source) ? readdirSync(source).filter((n) => existsSync(join(source, n, "SKILL.md"))).sort() : [];
  const inSource = (p: string) => p.startsWith(source + sep);
  const linkTarget = (p: string) => resolve(dirname(p), readlinkSync(p));
  // An old link Switchboard placed (before the copies): it points into the source, or leads there through another
  // link or through the meta checkout's .claude/skills (placed while the source was the meta's .claude/skills, whose <name>
  // the meta run above has since made a copy). Replaced by a copy on this run; a link anywhere else is the user's.
  const metaRoot = metaTop === null ? null : realpathSync(metaTop);
  const oldLink = (p: string) => {
    if (!lstatSync(p).isSymbolicLink()) return false;
    if (inSource(linkTarget(p))) return true;
    try {
      const real = realpathSync(p);
      return inSource(real) || (metaRoot !== null && real.startsWith(join(metaRoot, ".claude/skills") + sep) && isCopy(real));
    } catch {
      return false;
    }
  };

  const mine = (Object.entries(SKILL_TARGET_OF) as Array<["claude" | "codex", string]>).filter(([r]) => runner === undefined || r === runner);
  for (const [targetRunner, target] of mine) {
    const dir = join(root, target);
    const conds = conditionsOf(root, targetRunner, review, recheck, backlog(root), savedConfig(root));
    // A target that is the source directory itself (a link to it): nothing to place, and nothing there to remove
    if (existsSync(dir) && realpathSync(dir) === source) continue;
    for (const name of names) {
      const p = join(dir, name);
      const want = join(source, name);
      const hash = treeHash(want, (rel) => renderedFile(want, rel, conds));
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (st && isCopy(p) && readFileSync(join(p, SKILL_MARKER), "utf8").trim() === hash && treeHash(p) === hash) {
        result.unchanged.push(name);
      } else if (!st || isCopy(p) || oldLink(p) || emptyDir(p)) {
        // The folder is Switchboard's from its first write to its last: the marker goes in before anything else, saying
        // the copy is not complete, and gets the hash only after every file is there. A copy that stopped part-way is
        // then never a folder without a marker (which would read as the repository's own skill and be left as it is):
        // it is a marked copy whose marker is not the hash, placed again on the next run and not verified until then.
        if (st?.isSymbolicLink()) unlinkSync(p);
        mkdirSync(p, { recursive: true });
        writeFileSync(join(p, SKILL_MARKER), `${SKILL_INCOMPLETE}\n`);
        for (const e of readdirSync(p)) if (e !== SKILL_MARKER) rmSync(join(p, e), { recursive: true, force: true });
        cpSync(want, p, { recursive: true, dereference: true });
        for (const rel of filesOf(want)) if (rel.endsWith(".md")) writeFileSync(join(p, rel), renderedFile(want, rel, conds));
        writeFileSync(join(p, SKILL_MARKER), `${hash}\n`);
        result.linked.push(name);
      } else {
        result.skipped.push({ name, path: p });
      }
    }
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (names.includes(name)) continue;
      if (isCopy(p)) rmSync(p, { recursive: true });
      else if (oldLink(p)) unlinkSync(p);
      else continue;
      result.removed.push(name);
    }
  }
  result.linked = [...new Set(result.linked)];
  result.unchanged = [...new Set(result.unchanged)].filter((n) => !result.linked.includes(n));
  result.removed = [...new Set(result.removed)];

  // info/exclude is shared by every worktree of the repository, so the block lists every Switchboard copy (or old link) in
  // any of them — including one of a skill that left the source, until that worktree's next start removes it — and
  // nothing where no worktree has one (a skill skipped here may still be a copy in another worktree).
  const worktrees = (git(root, "worktree", "list", "--porcelain") ?? `worktree ${root}`).split("\n").flatMap((l) => (l.startsWith("worktree ") ? [l.slice(9)] : []));
  const excluded = new Set<string>();
  for (const w of worktrees) {
    for (const t of SKILL_TARGETS) {
      try {
        for (const n of readdirSync(join(w, t))) {
          const p = join(w, t, n);
          if (isCopy(p) || oldLink(p)) excluded.add(`/${t}/${n}`);
        }
      } catch {
        // no such folder in that worktree
      }
    }
  }
  writeExcludeBlock(resolve(root, git(root, "rev-parse", "--git-path", "info/exclude") ?? ".git/info/exclude"), [...excluded].sort());
  return result;
}

/**
 * Whether every copy Switchboard placed where the Task's runner reads its skills (the repository of `cwd`) is the one
 * `syncSkills` would place now — the same source rendered for the same conditions (runner, review setting, backlog,
 * merge gate, extra reviewer), by the marker and by the files. Reads only. For a start whose `syncSkills` failed: a
 * copy that is not verified here may have been rendered for another review setting, and nothing else tells the runner
 * the setting. A copy whose placing stopped part-way is a marked copy too (`SKILL_INCOMPLETE`), and is not verified.
 * True where there is no copy (not a repository, no folder, the repository's own skills): the runner then reads no text
 * of Switchboard's. It throws when the source cannot be rendered — the copies are then not verified.
 */
export function skillCopiesCurrent(opts: SkillSyncOptions): boolean {
  const { metaPath, cwd, runner, review = "other", recheck = "other", backlog = () => "github" as const, savedConfig = () => "" } = opts;
  const top = git(cwd, "rev-parse", "--show-toplevel");
  if (top === null) return true;
  const root = realpathSync(top);
  const source = existsSync(join(metaPath, SKILL_SOURCE)) ? realpathSync(join(metaPath, SKILL_SOURCE)) : resolve(metaPath, SKILL_SOURCE);
  for (const [targetRunner, target] of Object.entries(SKILL_TARGET_OF) as Array<["claude" | "codex", string]>) {
    if (runner !== undefined && targetRunner !== runner) continue;
    const dir = join(root, target);
    if (!existsSync(dir) || realpathSync(dir) === source) continue;
    const conds = conditionsOf(root, targetRunner, review, recheck, backlog(root), savedConfig(root));
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (!isCopy(p)) continue;
      const want = join(source, name);
      // a copy of a skill the source no longer has is not what a sync would leave there
      if (!existsSync(join(want, "SKILL.md"))) return false;
      const hash = treeHash(want, (rel) => renderedFile(want, rel, conds));
      if (readFileSync(join(p, SKILL_MARKER), "utf8").trim() !== hash || treeHash(p) !== hash) return false;
    }
  }
  return true;
}

const MANAGED_LINE = new RegExp(`^/(${SKILL_TARGETS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})/[^/]+$`);

/**
 * Rewrite only the managed block; every other line stays as the user wrote it (a line the user put inside the block
 * is kept, just outside it). A block whose end marker was cut by a hand edit ends at the first line that is not a
 * managed path. No lines → no block.
 */
function writeExcludeBlock(file: string, lines: string[]) {
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  const all = before === "" ? [] : before.replace(/\n$/, "").split("\n");
  const start = all.indexOf(BLOCK_START);
  let outside = all;
  if (start >= 0) {
    const end = all.indexOf(BLOCK_END, start + 1);
    let stop = start + 1;
    while (end < 0 && stop < all.length && MANAGED_LINE.test(all[stop]!)) stop++;
    const inner = all.slice(start + 1, end >= 0 ? end : stop);
    outside = [...all.slice(0, start), ...inner.filter((l) => !MANAGED_LINE.test(l)), ...all.slice(end >= 0 ? end + 1 : stop)];
  }
  const text = [...outside, ...(lines.length === 0 ? [] : [BLOCK_START, ...lines, BLOCK_END])].join("\n");
  const after = text === "" ? "" : `${text}\n`;
  if (after === before) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, after);
}

let kitSkills: Set<string> | undefined;
/**
 * A text the app wrote for a Task, naming the kit's skills where that Task's runner reads them: the texts are written
 * with Claude Code's place (`.claude/skills/<name>/`), and a Task of another runner has its copies in its own place
 * only (`SKILL_TARGET_OF`). A skill the repository tracks itself (not the kit's) stays where Git has it.
 */
export function skillPathsFor(text: string, runner: string, kit: ReadonlySet<string> = (kitSkills ??= new Set(readdirSync(join(findRepoRoot(import.meta.dir), SKILL_SOURCE))))): string {
  const place = runner === "claude" ? undefined : (SKILL_TARGET_OF as Record<string, string>)[runner];
  if (!place) return text;
  // `.claude/skills/…` is how the app's texts name the place of the copies as a whole
  return text.replace(/\.claude\/skills\/([a-z0-9-]+)\//g, (all, name: string) => (kit.has(name) ? `${place}/${name}/` : all)).replaceAll(`${SKILL_TARGET_OF.claude}/…`, `${place}/…`);
}
