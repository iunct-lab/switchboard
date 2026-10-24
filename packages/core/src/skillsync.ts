import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

/**
 * Development-standard skills in every repository a task runs in (#469, docs/design/skill-sync.md): before a runner
 * starts, each skill of the meta workspace is copied into the task's repository where Claude Code and Codex read
 * project skills, and the copies are listed in `.git/info/exclude` so the repository's tracked files never change.
 * A copy, not a link: the permission check resolves a link to where it points, outside the repository's workspace.
 */
/** The shared development-flow skills, in the kit (the meta repository's own skills stay tracked in .claude/skills). */
export const SKILL_SOURCE = "ops-kit/skills";
/** Claude Code reads `.claude/skills`, Codex `.agents/skills`. */
export const SKILL_TARGETS = [".claude/skills", ".agents/skills"];
/** The file inside a placed copy that marks it as Switchboard's; it holds the hash of the source it was copied from. */
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
}

const stem = (f: string) => f.slice(0, f.length - extname(f).length);

/**
 * Which of the repository's `scripts/setup` entries are copies of the meta's tools (#557). Only names the meta has
 * (without the extension) count, so a repository's own scripts are not called copies. Nothing is changed: the scripts
 * are tracked files of the repository, not copies placed like the skills. A file that cannot be read throws.
 */
export function setupScripts({ metaPath, cwd }: { metaPath: string; cwd: string }): SetupScripts {
  const out: SetupScripts = { config: false, kit: [], copies: [] };
  const top = git(cwd, "rev-parse", "--show-toplevel");
  if (top === null) return out;
  const root = realpathSync(top);
  out.config = existsSync(join(root, "ops.config.json"));
  const names = (d: string) => (existsSync(d) ? readdirSync(d).sort() : []);
  const known = new Set(names(join(metaPath, SETUP_DIR)).map(stem));
  for (const f of names(join(root, SETUP_DIR))) {
    if (!known.has(stem(f))) continue;
    (readFileSync(join(root, SETUP_DIR, f), "utf8").includes("src/cli.ts") ? out.kit : out.copies).push(f);
  }
  return out;
}

function git(cwd: string, ...args: string[]): string | null {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : null;
}

/** A hash of every file under `dir` (relative path and content), without the marker. */
function treeHash(dir: string): string {
  const h = createHash("sha256");
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (statSync(p).isDirectory()) walk(p); // follows a link to a folder, as the dereferencing copy does
      else if (p !== join(dir, SKILL_MARKER)) h.update(`${relative(dir, p)}\0`).update(readFileSync(p)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}

/** A copy Switchboard placed: a real folder with the marker. */
const isCopy = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true && existsSync(join(p, SKILL_MARKER));

export function syncSkills({ metaPath, cwd }: { metaPath: string; cwd: string }): SkillSyncResult {
  const result: SkillSyncResult = { linked: [], unchanged: [], removed: [], skipped: [] };
  const top = git(cwd, "rev-parse", "--show-toplevel");
  if (top === null) return result;
  const root = realpathSync(top);
  // The meta checkout first, so its .claude/skills/<name> copies exist before another repository's old links are
  // judged (links placed while the source was the meta's .claude/skills lead through them)
  const metaTop = git(metaPath, "rev-parse", "--show-toplevel");
  if (metaTop !== null && realpathSync(metaTop) !== root) syncSkills({ metaPath, cwd: metaPath });

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

  for (const target of SKILL_TARGETS) {
    const dir = join(root, target);
    // A target that is the source directory itself (a link to it): nothing to place, and nothing there to remove
    if (existsSync(dir) && realpathSync(dir) === source) continue;
    for (const name of names) {
      const p = join(dir, name);
      const want = join(source, name);
      const hash = treeHash(want);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (st && isCopy(p) && readFileSync(join(p, SKILL_MARKER), "utf8").trim() === hash && treeHash(p) === hash) {
        result.unchanged.push(name);
      } else if (!st || isCopy(p) || oldLink(p)) {
        if (st?.isSymbolicLink()) unlinkSync(p);
        else rmSync(p, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        cpSync(want, p, { recursive: true, dereference: true });
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
