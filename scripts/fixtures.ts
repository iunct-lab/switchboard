/**
 * The recordings' list, and their second copy (#3532): the branch `recordings-vault` of the repository (never merged,
 * like `feedback-assets`; the public sync sends main's tree only). Written with git's plumbing, not in a working tree.
 *   bun scripts/fixtures.ts list             present / missing for each name in RECORDINGS
 *   bun scripts/fixtures.ts save [--create]  every file of the recordings folder onto the branch (a changed one replaces
 *                                            the branch's); nothing is pushed when the tree is the same. Without the
 *                                            branch it stops unless --create: a clone of a public fork would publish them
 *   bun scripts/fixtures.ts fetch            the branch's files the folder lacks (an existing file is not overwritten)
 *   bun scripts/fixtures.ts sync             save, then fetch (tag-ci.ts runs it before the walk)
 * Exit 2 = no branch on origin, a push refused, or (fetch / sync) names of RECORDINGS still missing.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { recording, recordingsDir } from "./recordings.ts";

export const VAULT_BRANCH = "recordings-vault";
export const RECORDINGS = [
  "packages/adapters/adk/fixtures/adk-2.13.0-artifact.sse",
  "packages/adapters/adk/fixtures/adk-2.13.0-ask-deny.sse",
  "packages/adapters/adk/fixtures/adk-2.13.0-ask.sse",
  "packages/adapters/adk/fixtures/adk-2.13.0-native-allow.sse",
  "packages/adapters/adk/fixtures/adk-2.13.0-native.sse",
  "packages/adapters/adk/fixtures/adk-2.13.0-text.sse",
  "packages/adapters/agui/fixtures/agui-1.0.0-disconnect.sse",
  "packages/adapters/agui/fixtures/agui-1.0.0-interrupt-resume.sse",
  "packages/adapters/agui/fixtures/agui-1.0.0-interrupt.sse",
  "packages/adapters/agui/fixtures/agui-1.0.0-server.log",
  "packages/adapters/agui/fixtures/agui-1.0.0-text.sse",
  "packages/adapters/agui/fixtures/agui-1.0.0-tool.sse",
  "packages/adapters/claude/fixtures/classifier-ask.jsonl",
  "packages/adapters/claude/fixtures/classifier-stop.jsonl",
  "packages/adapters/claude/fixtures/cloud-start.txt",
  "packages/adapters/claude/fixtures/cloud-trust-prompt.txt",
  "packages/adapters/claude/fixtures/background-notification.jsonl",
  "packages/adapters/claude/fixtures/effort-high.jsonl",
  "packages/adapters/claude/fixtures/fork-turn-tool.jsonl",
  "packages/adapters/claude/fixtures/fork-turn.jsonl",
  "packages/adapters/claude/fixtures/guard-unavailable.jsonl",
  "packages/adapters/claude/fixtures/question-tool.jsonl",
  "packages/adapters/claude/fixtures/resume-cost.jsonl",
  "packages/adapters/claude/fixtures/resume-missing.jsonl",
  "packages/adapters/claude/fixtures/resume-turn.jsonl",
  "packages/adapters/claude/fixtures/teleport-session.jsonl",
  "packages/adapters/claude/fixtures/terminal-session.jsonl",
  "packages/adapters/claude/fixtures/write-with-permission.jsonl",
  "packages/adapters/codex/fixtures/approval-and-second-turn.jsonl",
  "packages/adapters/codex/fixtures/auto-review-0.155.0-alpha.2.6.jsonl",
  "packages/adapters/codex/fixtures/decline-and-interrupt.jsonl",
  "packages/adapters/codex/fixtures/effort-high.jsonl",
  "packages/adapters/codex/fixtures/exec-workspace-write.jsonl",
  "packages/adapters/codex/fixtures/question-tool.jsonl",
  "packages/adapters/codex/fixtures/resume.jsonl",
  "packages/adapters/codex/fixtures/subagent-0.166.0.jsonl",
  "packages/adapters/dak/fixtures/artifact-spill.sse",
  "packages/adapters/dak/fixtures/attachment-image.sse",
  "packages/adapters/dak/fixtures/text-reply.sse",
  "packages/adapters/dak/fixtures/tool-calls.sse",
  "packages/core/fixtures/osc7501-claude.jsonl",
  "packages/core/fixtures/otel-classifier-ask.jsonl",
  "packages/core/fixtures/otel-classifier-stop.jsonl",
  "packages/core/fixtures/otel-tool-decision.jsonl",
  "packages/core/fixtures/suggest-claude.jsonl",
  "packages/core/fixtures/suggest-workspace-claude.jsonl"
] as const;

export class VaultError extends Error {}

type Git = (args: string[], opts?: { input?: string; env?: Record<string, string> }) => Buffer;

function gitAt(root: string): Git {
  return (args, opts = {}) => {
    const p = Bun.spawnSync(["git", "-C", root, ...args], {
      stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
      env: { ...process.env, ...opts.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) throw new VaultError(`git ${args[0]} failed: ${p.stderr.toString().trim()}`);
    return p.stdout;
  };
}

/** The branch's commit on origin, fetched into this clone, or null when origin has no such branch. */
function remoteTip(git: Git, branch: string): string | null {
  let line: string;
  try {
    line = git(["ls-remote", "origin", `refs/heads/${branch}`]).toString().trim();
  } catch (e) {
    throw new VaultError(`origin を読めない（${(e as Error).message}）`);
  }
  if (!line) return null;
  git(["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  return line.split(/\s/)[0]!;
}

/** Every file under `dir`, as names relative to it (empty when the folder is missing). */
function vaultFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true, withFileTypes: true }) as import("node:fs").Dirent[])
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)))
    .sort();
}

/** `save`: see the file's comment. Returns the pushed commit, or null when the branch already had every file as it is. */
export function saveVault(root: string, dir = recordingsDir(), opts: { create?: boolean; branch?: string } = {}): string | null {
  const branch = opts.branch ?? VAULT_BRANCH;
  const git = gitAt(root);
  const tip = remoteTip(git, branch);
  if (!tip && !opts.create) throw new VaultError(`origin に枝 ${branch} が無い（公開の clone・fork では作らない。非公開のリポジトリで作るなら save --create）`);
  const files = vaultFiles(dir);
  const scratch = mkdtempSync(join(tmpdir(), "switchboard.fixtures-index."));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    git(tip ? ["read-tree", tip] : ["read-tree", "--empty"], { env });
    if (files.length > 0) {
      const blobs = git(["hash-object", "-w", "--stdin-paths"], { input: files.map((f) => join(dir, f)).join("\n") + "\n" }).toString().trim().split("\n");
      git(["update-index", "--add", "--index-info"], { env, input: files.map((f, i) => `100644 ${blobs[i]}\t${f}\n`).join("") });
    }
    const tree = git(["write-tree"], { env }).toString().trim();
    if (tip && git(["rev-parse", `${tip}^{tree}`]).toString().trim() === tree) return null;
    const commit = git(["commit-tree", tree, ...(tip ? ["-p", tip] : []), "-m", `recordings: save ${files.length} files from the recordings folder`]).toString().trim();
    try {
      git(["push", "-q", "origin", `${commit}:refs/heads/${branch}`]);
    } catch (e) {
      throw new VaultError(`枝 ${branch} に push できない（公開の clone・fork、または先に別の save が書いた。${(e as Error).message}）`);
    }
    return commit;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `fetch`: see the file's comment. Returns the names written. */
export function fetchVault(root: string, dir = recordingsDir(), branch = VAULT_BRANCH): string[] {
  const git = gitAt(root);
  const tip = remoteTip(git, branch);
  if (!tip) throw new VaultError(`origin に枝 ${branch} が無い（公開の clone・fork には録画を配らない。自分のランナーで録る: .claude/skills/runner-adapter-recording/SKILL.md）`);
  const written: string[] = [];
  for (const entry of git(["ls-tree", "-r", "-z", tip]).toString().split("\0").filter(Boolean)) {
    const [meta, name] = entry.split("\t") as [string, string];
    const [, type, oid] = meta.split(" ");
    if (type !== "blob") continue;
    const dest = join(dir, name);
    mkdirSync(dirname(dest), { recursive: true });
    try {
      // "wx": a file made there meanwhile (a recording run) or a link at the name is left alone, not written through
      writeFileSync(dest, git(["cat-file", "blob", oid!]), { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    written.push(name);
  }
  return written;
}

if (import.meta.main) {
  const command = process.argv[2];
  const root = join(import.meta.dir, "..");
  if (command === "list") {
    for (const rel of RECORDINGS) console.log(`${recording(rel) ? "present" : "missing"} ${rel}`);
    process.exit(0);
  }
  if (command !== "save" && command !== "fetch" && command !== "sync") {
    console.error("Usage: bun scripts/fixtures.ts list|save [--create]|fetch|sync");
    process.exit(2);
  }
  let failed = false;
  const attempt = (what: () => void) => {
    try {
      what();
    } catch (e) {
      if (!(e instanceof VaultError)) throw e;
      console.error(e.message);
      failed = true;
    }
  };
  if (command === "save" || command === "sync") {
    attempt(() => {
      const commit = saveVault(root, recordingsDir(), { create: process.argv.includes("--create") });
      console.log(commit ? `saved to ${VAULT_BRANCH} (${commit.slice(0, 7)})` : `${VAULT_BRANCH} is up to date`);
    });
  }
  if (command === "fetch" || command === "sync") {
    attempt(() => {
      for (const rel of fetchVault(root)) console.log(`fetched ${rel}`);
      for (const rel of RECORDINGS.filter((r) => !recording(r))) {
        console.error(`missing ${rel} (not on ${VAULT_BRANCH}; record: .claude/skills/runner-adapter-recording/SKILL.md)`);
        failed = true;
      }
    });
  }
  process.exit(failed ? 2 : 0);
}
