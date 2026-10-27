import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { recording, recordingsDir } from "./recordings.ts";

export const RECORDINGS_COMMIT = "fcfbb6918f3ca4443a5d6b366c6fabd5a60303ec";
export const RECORDINGS = [
  "packages/adapters/claude/fixtures/ask-user-question.jsonl",
  "packages/adapters/claude/fixtures/cloud-start.txt",
  "packages/adapters/claude/fixtures/cloud-trust-prompt.txt",
  "packages/adapters/claude/fixtures/background-notification.jsonl",
  "packages/adapters/claude/fixtures/effort-high.jsonl",
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
  "packages/adapters/codex/fixtures/resume.jsonl",
  "packages/adapters/dak/fixtures/artifact-spill.sse",
  "packages/adapters/dak/fixtures/attachment-image.sse",
  "packages/adapters/dak/fixtures/text-reply.sse",
  "packages/adapters/dak/fixtures/tool-calls.sse",
  "packages/core/fixtures/suggest-claude.jsonl",
  "packages/core/fixtures/suggest-workspace-claude.jsonl"
] as const;

if (import.meta.main) {
  const command = process.argv[2];
  if (command !== "fetch" && command !== "list") {
    console.error("Usage: bun scripts/fixtures.ts fetch|list");
    process.exit(2);
  }
  if (command === "fetch") {
    const commit = Bun.spawnSync(["git", "cat-file", "-e", `${RECORDINGS_COMMIT}^{commit}`], { cwd: join(import.meta.dir, "..") });
    if (commit.exitCode !== 0) {
      console.error(`Cannot fetch recordings: this clone does not contain the private history at ${RECORDINGS_COMMIT}. Existing recordings are not distributed.`);
      console.error("Record with your own runner outside Git: .claude/skills/runner-adapter-recording/SKILL.md");
      process.exit(2);
    }
  }
  let missing = 0;
  for (const rel of RECORDINGS) {
    if (command === "list") {
      console.log(`${recording(rel) ? "present" : "missing"} ${rel}`);
      continue;
    }
    const result = Bun.spawnSync(["git", "show", `${RECORDINGS_COMMIT}:${rel}`], { cwd: join(import.meta.dir, "..") });
    if (result.exitCode !== 0) {
      // recorded after RECORDINGS_COMMIT: only the vault has it
      if (recording(rel)) console.log(`kept ${rel}`);
      else {
        console.error(`missing ${rel} (not in history; record: .claude/skills/runner-adapter-recording/SKILL.md)`);
        missing++;
      }
      continue;
    }
    const dest = join(recordingsDir(), rel);
    mkdirSync(dirname(dest), { recursive: true });
    await Bun.write(dest, result.stdout);
    console.log(`fetched ${rel}`);
  }
  console.log("To re-record, follow .claude/skills/runner-adapter-recording/SKILL.md with a real runner; keep recordings outside Git.");
  if (missing) process.exit(2);
}
