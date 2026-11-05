/**
 * Provenance (docs/design/process-kernel.md, K1): what a Task was started with — the process definition and the reason it
 * was chosen, the bundle of instructions it can read (hashes), the repository's head, the runner's settings and the size of
 * the instruction text. Written once when the Task is created (`Db.setTaskProvenance`), read at `GET /api/tasks/:id/provenance`
 * and grouped by `scripts/kernel-report.ts`. Nothing here is recomputed later: the record says what was true at the start.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Provenance, RunnerId } from "@switchboard/protocol";
import { PROCESS_SOURCE } from "./process-defs.ts";
import { SKILL_SOURCE, treeHash } from "./skillsync.ts";

/** The instruction files a runner reads at the root of the working directory, and the folder of project skills. */
export const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"];
export const REPO_SKILLS = ".claude/skills";

export type ProvenanceInput = {
  cwd: string;
  /** The meta workspace's path (where `ops-kit/skills` and `ops-kit/processes` are); null = not registered, so the bundle hashes are null. */
  metaPath: string | null;
  runner: RunnerId;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  process?: { id: string; version: number } | null;
  processReason?: string | null;
  now?: number;
};

const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();
const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

/** Bytes of every file under `dir`, following links to folders as the hash does. */
function treeBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const st = statSync(p);
    if (st.isDirectory()) n += treeBytes(p);
    else n += st.size;
  }
  return n;
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return p.exitCode === 0 ? p.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

/** One part of the record; anything that cannot be read (missing, a dangling link, no permission) is null, and never the whole record. */
function part<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** The record for a Task about to run in `cwd`. Never throws: a part that cannot be read is null (bytes: null), the rest is kept. */
export function collectProvenance(input: ProvenanceInput): Provenance {
  const { cwd, metaPath } = input;
  const skillsDir = metaPath ? join(metaPath, SKILL_SOURCE) : null;
  const processesDir = metaPath ? join(metaPath, PROCESS_SOURCE) : null;
  const repoSkills = join(cwd, REPO_SKILLS);
  const claudeMd = join(cwd, INSTRUCTION_FILES[0]!);
  return {
    v: 1,
    process: input.process ?? null,
    processReason: input.processReason ?? null,
    bundle: {
      skills: part(() => (skillsDir && isDir(skillsDir) ? treeHash(skillsDir) : null)),
      repoSkills: part(() => (isDir(repoSkills) ? treeHash(repoSkills) : null)),
      claudeMd: part(() => (isFile(claudeMd) ? sha256(claudeMd) : null)),
      processes: part(() => (processesDir && isDir(processesDir) ? treeHash(processesDir) : null)),
    },
    repo: { head: git(cwd, "rev-parse", "HEAD") },
    runner: input.runner,
    model: input.model,
    effort: input.effort,
    permissionMode: input.permissionMode,
    instructionBytes: part(() => INSTRUCTION_FILES.reduce((n, f) => n + (isFile(join(cwd, f)) ? statSync(join(cwd, f)).size : 0), 0) + (isDir(repoSkills) ? treeBytes(repoSkills) : 0)),
    recordedAt: input.now ?? Date.now(),
  };
}
