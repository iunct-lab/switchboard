import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateWords } from "./export-copy.ts";

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("private-words: reads the caller's list, ignoring comments and blank lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-kit-words-test."));
  made.push(dir);
  const file = join(dir, "words.txt");
  writeFileSync(file, "# synthetic words\n\n  quux-private-token  \nquux-other-token\n");
  expect(readPrivateWords(file)).toEqual(["quux-private-token", "quux-other-token"]);
  expect(() => readPrivateWords(join(dir, "missing.txt"))).toThrow("リストがありません");
});

test("private-words: an unspecified list fails instead of skipping the check", () => {
  expect(() => readPrivateWords()).toThrow("--words-file");
});
