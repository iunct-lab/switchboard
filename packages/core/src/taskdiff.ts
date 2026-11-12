import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentEvent, EventEnvelope, StagedChange, Task, TaskDiffFile, TaskDiffSnapshot } from "@switchboard/protocol";
import { safeRealpath } from "./mcp.ts";

/**
 * "差分" tab (proposal Screen B, issue #12): the files a task changed, as diffs, with deep links to the editor.
 * Sources, in order: staged writes (not yet applied), then the working tree of each scope root that is inside a git
 * repository (compared with HEAD), restricted to the paths the transcript shows the runner touched (Write/Edit tool
 * calls, artifact events). If the transcript names nothing, every change under the root is shown (the runner may have
 * used a shell). Then each git worktree outside the scope that the transcript wrote to (compared with its fork point
 * from origin/HEAD, so committed work shows too), and the written places that no longer exist (`removed`).
 */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_FILES = 60;
const MAX_DIFF_BYTES = 200_000;

export async function collectTaskDiff(task: Task, events: EventEnvelope[], staged: StagedChange[], scratch: Array<string | undefined> = [tmpdir(), process.env.TMPDIR]): Promise<TaskDiffFile[]> {
  const scopeRoots = (task.scope.length ? task.scope : [task.cwd]).map(canonical);
  const touched = touchedPaths(events, scopeRoots);
  const outside = await outsideRoots(touched, scopeRoots, scratch);
  const out: TaskDiffFile[] = [];
  for (const c of staged) {
    if (c.status !== "pending") continue;
    out.push({ path: c.path, rel: c.rel, stat: c.stat, diff: c.diff, source: "staging", stagedId: c.id });
  }
  // scope roots compare with HEAD as before; an outside worktree (its top) compares with its fork point from origin/HEAD
  // and lists only what was written outside the scope (the scope's own files are already listed from the scope root)
  const sources = [
    ...scopeRoots.map((root) => ({ root, outside: false })),
    ...outside.roots.map((root) => ({ root, outside: true })),
  ];
  for (const { root, outside: isOutside } of sources) {
    const top = await gitTop(root);
    if (!top) continue;
    const inRoot = [...touched].filter((p) => under(p, root) && !(isOutside && scopeRoots.some((r) => under(p, r))));
    const base = isOutside ? await diffBase(top) : (await gitHasHead(top)) ? "HEAD" : EMPTY_TREE;
    const files = await gitChangedFiles(top, root, inRoot.length ? inRoot : null, base);
    for (const f of files.slice(0, MAX_FILES)) {
      const abs = join(top, f.rel);
      const diff = capDiff(f.untracked ? await gitNoIndexDiff(top, f.rel) : await gitDiff(top, base, f.rel));
      out.push({ path: abs, rel: relative(root, abs).split(sep).join("/") || f.rel, stat: f.stat, diff, source: "worktree", root: top });
    }
    if (files.length > MAX_FILES) out.push({ path: root, rel: `… ${files.length - MAX_FILES} more changed files`, stat: "", diff: "", source: "worktree", root: top });
  }
  for (const path of outside.removed) out.push({ path, rel: path, stat: "", diff: "", source: "removed" });
  return out;
}

/** The tool calls whose input names a file the Task wrote. */
export const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "fileChange", "fs.write", "fs.patch"];
const SNAPSHOT_MARK = "\n… (snapshot truncated)";
const droppedNote = (n: number) => `… ${n} files dropped (snapshot truncated)`;
const DROPPED_NOTE = /^… (\d+) files dropped \(snapshot truncated\)$/; // reads back what droppedNote wrote

/**
 * The next copy of a Task's diff (#3833): the live worktree rows (seen now), plus the rows of the previous copy whose
 * working tree no longer exists (kept as they were, with the time they were last seen). Staging and removed rows are not copied.
 */
export function mergeSnapshot(prev: TaskDiffSnapshot | null, live: TaskDiffFile[], at: number, exists: (p: string) => boolean = existsSync): TaskDiffSnapshot {
  const files: TaskDiffFile[] = [];
  for (const f of live) if (f.source === "worktree" && f.root) files.push({ ...f, at });
  for (const f of prev?.files ?? []) {
    if (!f.root || exists(f.root)) continue;
    files.push({ ...f, source: "worktree", at: f.at ?? prev!.at });
  }
  return { at, files };
}

/**
 * Keep a copy under `maxBytes` (as JSON): cut the largest diffs first (each marked "… (snapshot truncated)"), and if the
 * rows alone are still over, drop whole rows: those whose working tree still exists first (the next copy rebuilds them
 * from the tree), the rest last (a removed place cannot be rebuilt), oldest first within each. Each root that lost rows
 * keeps one row that says how many, carrying the root so it follows the place like any copied row.
 */
export function capSnapshot(s: TaskDiffSnapshot, maxBytes = 1_000_000, exists: (p: string) => boolean = existsSync): TaskDiffSnapshot {
  // the marker rows of an earlier cut are not rows to drop: their counts seed the per-root tally and one summed row is written back
  const dropped = new Map<string, number>(); // root -> rows dropped
  const files: TaskDiffFile[] = [];
  for (const f of s.files) {
    const m = DROPPED_NOTE.exec(f.rel);
    if (m) dropped.set(f.root ?? "", (dropped.get(f.root ?? "") ?? 0) + Number(m[1]));
    else files.push({ ...f });
  }
  const note = (root: string, n: number): TaskDiffFile => ({ path: root, rel: droppedNote(n), stat: "", diff: "", source: "worktree", root, at: s.at });
  const notesSize = () => [...dropped].reduce((a, [root, n]) => a + Buffer.byteLength(JSON.stringify(note(root, n))) + 1, 0);
  const sizes = files.map((f) => Buffer.byteLength(JSON.stringify(f)) + 1);
  let total = 2 + sizes.reduce((a, b) => a + b, 0);
  while (total + notesSize() > maxBytes) {
    let i = 0;
    for (let k = 1; k < files.length; k++) if (files[k]!.diff.length > files[i]!.diff.length) i = k;
    const big = files[i];
    if (!big || big.diff.length <= SNAPSHOT_MARK.length) break;
    const body = big.diff.endsWith(SNAPSHOT_MARK) ? big.diff.slice(0, -SNAPSHOT_MARK.length) : big.diff;
    const over = total + notesSize() - maxBytes;
    big.diff = body.slice(0, Math.max(0, Math.min(Math.floor(body.length / 2), body.length - over - 1))) + SNAPSHOT_MARK;
    const n = Buffer.byteLength(JSON.stringify(big)) + 1;
    total += n - sizes[i]!;
    sizes[i] = n;
  }
  const notes = () => [...dropped].map(([root, n]) => note(root, n));
  if (total + notesSize() <= maxBytes) return { at: s.at, files: [...files, ...notes()] };
  const gone = new Set<number>();
  const rebuildable = files.map((f) => !f.root || exists(f.root));
  const order = files.map((_, i) => i).sort((a, b) => Number(rebuildable[b]) - Number(rebuildable[a]) || (files[a]!.at ?? s.at) - (files[b]!.at ?? s.at) || b - a);
  for (const i of order) {
    if (total + notesSize() <= maxBytes) break;
    gone.add(i);
    total -= sizes[i]!;
    const root = files[i]!.root ?? "";
    dropped.set(root, (dropped.get(root) ?? 0) + 1);
  }
  const kept = files.filter((_, i) => !gone.has(i));
  return { at: s.at, files: [...kept, ...notes()] };
}

/** The live rows, with the copied rows of a removed place added right after its `removed` row. */
export function withSnapshot(live: TaskDiffFile[], snap: TaskDiffSnapshot | null): TaskDiffFile[] {
  if (!snap) return live;
  const out: TaskDiffFile[] = [];
  for (const f of live) {
    out.push(f);
    if (f.source !== "removed") continue;
    for (const s of snap.files) if (s.root && (s.root === f.path || under(s.root, f.path))) out.push({ ...s, source: "snapshot", at: s.at ?? snap.at });
  }
  return out;
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir + sep);

/**
 * Touched paths outside every scope root: the git worktrees they live in (`roots`, as toplevels) and the places the
 * Task wrote that no longer exist (`removed`). A vanished place inside a repository is left to `git status`; one in a
 * scratch directory is dropped; otherwise the first missing segment below the deepest existing ancestor is reported.
 */
export async function outsideRoots(touched: Set<string>, roots: string[], scratch: Array<string | undefined> = [tmpdir(), process.env.TMPDIR]): Promise<{ roots: string[]; removed: string[] }> {
  const scratchDirs = scratch.filter((s): s is string => !!s).map(canonical);
  const dirs = new Set<string>();
  for (const p of touched) if (!roots.some((r) => under(p, r))) dirs.add(dirname(p));
  const tops = new Set<string>();
  const removed = new Set<string>();
  for (const dir of dirs) {
    let a = dir;
    while (!existsSync(a) && dirname(a) !== a) a = dirname(a);
    const top = await gitTop(a);
    if (top) {
      if (!roots.some((r) => under(top, r))) tops.add(top);
    } else if (a !== dir && !scratchDirs.some((s) => under(a, s))) {
      removed.add(join(a, relative(a, dir).split(sep)[0]!));
    }
  }
  return { roots: [...tops], removed: [...removed] };
}

/** What a worktree is compared with: the fork point from origin/HEAD, else HEAD, else the empty tree. */
async function diffBase(top: string): Promise<string> {
  if (!(await gitHasHead(top))) return EMPTY_TREE;
  if ((await run(top, ["rev-parse", "--verify", "-q", "refs/remotes/origin/HEAD"])).code === 0) {
    const mb = await run(top, ["merge-base", "HEAD", "refs/remotes/origin/HEAD"]);
    if (mb.code === 0 && mb.out.trim()) return mb.out.trim();
  }
  return "HEAD";
}

/** Real path with symlinks resolved on the deepest existing ancestor (so new files under /var → /private/var too). */
function canonical(p: string): string {
  return safeRealpath(resolve(p));
}

/** Absolute (real) paths the transcript says were written. */
export function touchedPaths(events: EventEnvelope[], roots: string[]): Set<string> {
  const base = roots[0] ?? "/";
  const abs = (p: string) => canonical(isAbsolute(p) ? p : resolve(base, p));
  const out = new Set<string>();
  for (const { ev } of events) {
    if (ev.t === "tool.call") {
      const input = ev.input as { file_path?: unknown; notebook_path?: unknown; path?: unknown; changes?: Array<{ path?: unknown }> } | null;
      const writeTool = WRITE_TOOLS.includes(ev.name);
      if (!writeTool || !input || typeof input !== "object") continue;
      if (typeof input.file_path === "string") out.add(abs(input.file_path));
      if (typeof input.notebook_path === "string") out.add(abs(input.notebook_path));
      if (typeof input.path === "string") out.add(abs(input.path));
      for (const c of input.changes ?? []) if (typeof c?.path === "string") out.add(abs(c.path));
    } else if (ev.t === "artifact") {
      out.add(abs(ev.path));
    }
  }
  return out;
}

async function run(cwd: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["git", "-c", "core.quotePath=false", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0" } });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out, err };
}

async function gitTop(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const r = await run(dir, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? canonical(r.out.trim()) : null;
}

async function gitHasHead(top: string): Promise<boolean> {
  return (await run(top, ["rev-parse", "--verify", "-q", "HEAD"])).code === 0;
}

/** Changed files under `root` (toplevel-relative `rel`), via NUL-separated porcelain so any filename survives. */
async function gitChangedFiles(top: string, root: string, only: string[] | null, base: string): Promise<Array<{ rel: string; stat: string; untracked: boolean }>> {
  const spec = only ? only.map((p) => relative(top, p)) : [relative(top, root) || "."];
  const r = await run(top, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ...spec]);
  if (r.code !== 0) return [];
  const files: Array<{ rel: string; stat: string; untracked: boolean }> = [];
  const parts = r.out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (!entry) continue;
    const code = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (code[0] === "R" || code[0] === "C") i++; // rename/copy: the next field is the source path
    const abs = join(top, rel);
    if (existsSync(abs) && statSync(abs).isDirectory()) continue;
    const untracked = code === "??";
    files.push({ rel, stat: untracked ? "new" : code.includes("D") ? "deleted" : "", untracked });
  }
  // committed since `base` with a clean working tree: `git status` does not list them
  const ns0 = await run(top, ["diff", "--name-status", "--no-renames", "-z", base, "--", ...spec]);
  if (ns0.code === 0) {
    const f = ns0.out.split("\0");
    for (let i = 0; i + 1 < f.length; i += 2) {
      const rel = f[i + 1]!;
      if (!files.some((x) => x.rel === rel)) files.push({ rel, stat: f[i]!.startsWith("D") ? "deleted" : "", untracked: false });
    }
  }
  const tracked = files.filter((f) => !f.untracked);
  if (tracked.length) {
    const ns = await run(top, ["diff", base, "--numstat", "-z", "--", ...tracked.map((f) => f.rel)]);
    if (ns.code === 0) {
      const fields = ns.out.split("\0");
      for (const field of fields) {
        const [a, d, rel] = field.split("\t");
        const f = files.find((x) => x.rel === rel);
        if (f && a !== undefined && d !== undefined) f.stat = a === "-" ? "binary" : `+${a} −${d}`;
      }
    }
  }
  return files;
}

async function gitDiff(top: string, base: string, rel: string): Promise<string> {
  return (await run(top, ["diff", base, "--", rel])).out;
}

async function gitNoIndexDiff(top: string, rel: string): Promise<string> {
  const r = await run(top, ["diff", "--no-index", "--", "/dev/null", rel]);
  return r.code <= 1 ? r.out : `(diff failed: ${r.err.trim()})`; // 1 = differences, ≥ 2 = error
}

function capDiff(d: string): string {
  return d.length > MAX_DIFF_BYTES ? d.slice(0, MAX_DIFF_BYTES) + "\n… (diff truncated)" : d;
}

export type { AgentEvent };
