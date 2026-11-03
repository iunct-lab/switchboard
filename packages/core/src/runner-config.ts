import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, type Stats } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Workspace } from "@switchboard/protocol";
import { SKILL_MARKER, SKILL_TARGETS } from "./skillsync.ts";

/** What a runner reads from the repository at the start of a Task (#2576): before anyone has looked, a foreign repository's copy must not run. */
export const RUNNER_CONFIG_PATHS = [".claude/settings.json", ".claude/settings.local.json", ".claude/CLAUDE.md", ".claude/skills", ".claude/agents", ".claude/commands", ".claude/rules", ".claude/hooks", ".agents/skills", ".codex", "CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".mcp.json"];

const SHOWN_BYTES = 256 * 1024;

export type RunnerConfigFile = { path: string; content: string };
export type RunnerConfig = { files: RunnerConfigFile[]; hash: string };

export class RunnerConfigUnconfirmed extends Error {
  constructor(name: string) {
    super(`${name} は他者のリポジトリです。ランナーの設定（hooks など）を設定の「Workspace」で確認してから Task を始めてください`);
  }
}

const statOf = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
};

const realOf = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const within = (base: string, path: string) => path === base || path.startsWith(`${base}/`);

/**
 * The folders of the skills Switchboard placed itself (`syncSkills`), as real paths: they change with every Task, and they
 * are not the repository's. The marker alone does not make one: a repository could commit it to hide a skill, so nothing in the folder may be tracked.
 */
function placedSkills(base: string): Set<string> {
  const placed = new Set<string>();
  for (const target of SKILL_TARGETS) {
    const dir = realOf(join(base, target));
    if (dir === null || !within(base, dir) || !statSync(dir).isDirectory()) continue;
    const rel = relative(base, dir);
    const ls = Bun.spawnSync(["git", "-C", base, "ls-files", "-z", "--", rel], { stdout: "pipe", stderr: "pipe" });
    if (ls.exitCode !== 0) continue;
    const tracked = ls.stdout.toString().split("\0");
    for (const name of readdirSync(dir)) {
      const folder = join(dir, name);
      if (statOf(folder)?.isDirectory() && statOf(join(folder, SKILL_MARKER))?.isFile() && !tracked.some((t) => t === `${rel}/${name}` || t.startsWith(`${rel}/${name}/`))) placed.add(folder);
    }
  }
  return placed;
}

/**
 * The files that exist under RUNNER_CONFIG_PATHS, in path order, and one hash of them. A link inside the clone counts as
 * what it points at, which is what the runner reads (a link to a folder counts as well, for where it adds a file). Whatever
 * leads out of the clone is listed as the link: what it points at is its content, so nothing from outside is shown. The
 * hash is of the whole files, so a change past the shown part of a long one still asks again.
 */
export function runnerConfigOf(root: string): RunnerConfig {
  const base = realOf(root) ?? root;
  const placed = placedSkills(base);
  const found = new Map<string, { kind: "file" | "link"; bytes: Buffer }>();
  // a link out of the clone by where it ends up, not its first step: a chain is listed, and asks again, by its end
  const linkEntry = (rel: string) => {
    const end = realOf(join(base, rel));
    found.set(rel, { kind: "link", bytes: Buffer.from(end !== null && !within(base, end) ? end : readlinkSync(join(base, rel))) });
  };
  const walked = new Set<string>();
  const add = (rel: string) => {
    const full = join(base, rel);
    const st = statOf(full);
    if (!st) return;
    const real = realOf(full);
    if (real === null || !within(base, real)) {
      // the nearest link: `rel` itself, or a folder above it (one further up may stay inside the clone)
      const parts = rel.split("/");
      const link = parts.map((_, i) => parts.slice(0, i + 1).join("/")).reverse().find((p) => statOf(join(base, p))?.isSymbolicLink());
      if (link) linkEntry(link);
      return;
    }
    if (placed.has(real)) return;
    const target = statSync(full);
    if (target.isFile()) found.set(rel, { kind: "file", bytes: readFileSync(full) });
    else if (target.isDirectory()) {
      if (st.isSymbolicLink()) linkEntry(rel);
      if (within(join(base, ".git"), real) || walked.has(real)) return; // the same folder again is a loop of links, or listed already
      walked.add(real);
      for (const name of readdirSync(full)) if (name !== ".git") add(`${rel}/${name}`);
    }
  };
  for (const rel of RUNNER_CONFIG_PATHS) add(rel);
  const hash = createHash("sha256");
  const files = [...found.keys()].sort().map((path) => {
    const { kind, bytes } = found.get(path)!;
    hash.update(`${kind}\0${path}\0${bytes.length}\0`).update(bytes);
    const content = bytes.length > SHOWN_BYTES ? `${bytes.subarray(0, SHOWN_BYTES).toString("utf8").replace(/\uFFFD+$/, "")}\n以下省略（${bytes.length} バイト）` : bytes.toString("utf8");
    return { path, content };
  });
  return { files, hash: hash.digest("hex") };
}

/** The foreign workspace a Task at `cwd` (or naming `workspaceId`) would read the config of. Paths compare resolved: a spelling or a link to the clone is the clone. */
export function foreignWorkspaceOf(workspaces: Workspace[], at: { workspaceId?: string | null; cwd: string }): Workspace[] {
  const cwd = realOf(at.cwd) ?? resolve(at.cwd);
  return workspaces.filter((ws) => ws.upstream && (ws.id === at.workspaceId || within(realOf(ws.path) ?? ws.path, cwd)));
}
