import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertRecordings, recordingText, recordingsDir, requireRecordings, skipRecordings } from "./recordings.ts";

// #1945: recordings live outside Git. Absent and not asked for → skip; asked for (SWITCHBOARD_FIXTURES) and absent → fail.
const REL = "packages/x/fixtures/a.jsonl";
let root: string;
const saved = { fixtures: process.env.SWITCHBOARD_FIXTURES };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "recordings.test."));
});
afterEach(() => {
  if (saved.fixtures === undefined) delete process.env.SWITCHBOARD_FIXTURES; else process.env.SWITCHBOARD_FIXTURES = saved.fixtures;
  rmSync(root, { recursive: true, force: true });
});

test("recordings: unset and absent → the tests skip, nothing is required", () => {
  delete process.env.SWITCHBOARD_FIXTURES;
  expect(recordingsDir()).toBe(join(homedir(), ".switchboard", "fixtures"));
  expect(requireRecordings()).toBe(false);
  expect(skipRecordings(REL)).toBe(true);
  expect(recordingText(REL)).toBe("");
});

test("recordings: given and absent → the tests run and fail with recording instructions", () => {
  process.env.SWITCHBOARD_FIXTURES = join(root, "empty");
  expect(requireRecordings()).toBe(true);
  expect(skipRecordings(REL)).toBe(false);
  expect(() => assertRecordings(REL)).toThrow(".claude/skills/runner-adapter-recording/SKILL.md");
});

test("recordings: given and present → the tests run on the file", () => {
  const dir = join(root, "rec");
  mkdirSync(dirname(join(dir, REL)), { recursive: true });
  writeFileSync(join(dir, REL), "{}\n");
  process.env.SWITCHBOARD_FIXTURES = dir;
  expect(skipRecordings(REL)).toBe(false);
  expect(() => assertRecordings(REL)).not.toThrow();
  expect(recordingText(REL)).toBe("{}\n");
});

test("recordings: a standalone script skips (exit 0) when not asked for and fails (exit 2) when SWITCHBOARD_FIXTURES is given", () => {
  const script = `import { scriptRecording } from ${JSON.stringify(join(import.meta.dir, "recordings.ts"))}; scriptRecording(${JSON.stringify(REL)}); console.log("RAN-SENTINEL-1945");`;
  const run = (env: Record<string, string | undefined>) => {
    const e = { ...process.env, ...env } as Record<string, string>;
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
    const p = Bun.spawnSync(["bun", "-e", script], { env: e, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
  };
  const skipped = run({ SWITCHBOARD_FIXTURES: undefined, HOME: join(root, "nohome") });
  expect(skipped.code).toBe(0);
  expect(skipped.stderr).toContain("skipped: Missing recording");
  expect(skipped.stdout).toBe(""); // stdout stays for pass/fail and counts
  expect(skipped.stderr + skipped.stdout).not.toContain("RAN-SENTINEL-1945");
  const failed = run({ SWITCHBOARD_FIXTURES: join(root, "empty") });
  expect(failed.code).toBe(2);
  expect(failed.stderr).toContain(".claude/skills/runner-adapter-recording/SKILL.md");
});

test("recordings: an empty SWITCHBOARD_FIXTURES counts as unset (not the working directory)", () => {
  process.env.SWITCHBOARD_FIXTURES = "";
  expect(requireRecordings()).toBe(false);
  expect(recordingsDir()).toBe(join(homedir(), ".switchboard", "fixtures"));
});
