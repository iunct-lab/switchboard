import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Recordings live outside the checkout, with repository-relative names. */
export function recordingsDir(): string {
  return process.env.SWITCHBOARD_FIXTURES || join(homedir(), ".switchboard", "fixtures"); // empty counts as unset
}
export function recording(rel: string): string | undefined {
  const path = join(recordingsDir(), rel);
  return existsSync(path) ? path : undefined;
}
export function requireRecordings(): boolean {
  return !!process.env.SWITCHBOARD_FIXTURES;
}
export function recordingReason(rel: string): string {
  return `Missing recording: ${join(recordingsDir(), rel)}; record with your own runner outside Git: .claude/skills/runner-adapter-recording/SKILL.md`;
}

// Optional reads allow test modules to register their unrelated tests without recordings.
export function recordingText(rel: string): string {
  const path = recording(rel);
  return path ? readFileSync(path, "utf8") : "";
}
const reported = new Set<string>();
export function skipRecordings(...rels: string[]): boolean {
  const missing = rels.filter((rel) => !recording(rel));
  if (requireRecordings()) return false;
  for (const rel of missing) {
    if (!reported.has(rel)) console.error(`Skipping recording tests: ${recordingReason(rel)}`);
    reported.add(rel);
  }
  return missing.length > 0;
}
export function assertRecordings(...rels: string[]): void {
  for (const rel of rels) if (!recording(rel)) throw new Error(recordingReason(rel));
}
/** Standalone replay scripts follow the same rule: skipped (exit 0) when the recording is absent and not asked for, failed (exit 2) when SWITCHBOARD_FIXTURES is given. */
export function scriptRecording(rel: string): string {
  const path = recording(rel);
  if (path) return path;
  if (!requireRecordings()) {
    console.error(`skipped: ${recordingReason(rel)}`); // stderr: an E2E keeps stdout for pass/fail and counts
    process.exit(0);
  }
  console.error(recordingReason(rel));
  process.exit(2);
}
