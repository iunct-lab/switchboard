// test-reads: packages/core/src/ packages/protocol/src/ apps/web/src/ scripts/ci.ts
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciSteps } from "./ci.ts";
import { check, isTest, lineCount, listedIn, measure, raisedAgainst, ROOTS, SOURCE_LIMIT, STILL_OVER, TEST_LIMIT } from "./file-size.ts";

test("file size: a source file of 1,001 lines fails and one of 1,000 passes; a test file of 2,001 fails and one of 2,000 passes", () => {
  expect([SOURCE_LIMIT, TEST_LIMIT]).toEqual([1000, 2000]);
  expect(check([{ path: "packages/core/src/a.ts", lines: 1000 }, { path: "apps/web/src/components/A.tsx", lines: 1000 }, { path: "packages/core/src/a.test.ts", lines: 2000 }], {})).toEqual([]);
  expect(check([{ path: "packages/core/src/a.ts", lines: 1001 }], {})).toEqual(["packages/core/src/a.ts: 1001 lines > 1000 (a source file): split it by feature"]);
  expect(check([{ path: "apps/web/src/components/A.tsx", lines: 1001 }], {})).toHaveLength(1);
  expect(check([{ path: "packages/core/src/a.test.ts", lines: 2001 }], {})).toEqual(["packages/core/src/a.test.ts: 2001 lines > 2000 (a test file): split it by feature"]);
  // a helper the tests share is a source file
  expect(isTest("packages/core/src/api-test-harness.ts")).toBe(false);
  expect(isTest("apps/web/src/a.test.tsx")).toBe(true);
});

test("file size: a listed file has exactly its ceiling's lines — above fails, below fails until the ceiling is lowered; an entry of a file within the limit or gone fails", () => {
  const over = { "packages/core/src/big.ts": 3000 };
  expect(check([{ path: "packages/core/src/big.ts", lines: 3000 }], over)).toEqual([]);
  // the room a file gave back is not kept: growing back to 3000 later would need the ceiling raised, which the base comparison refuses
  expect(check([{ path: "packages/core/src/big.ts", lines: 1200 }], over)).toEqual(["packages/core/src/big.ts: 1200 lines is under its ceiling 3000: lower the ceiling to 1200 in STILL_OVER (scripts/file-size.ts)"]);
  expect(check([{ path: "packages/core/src/big.ts", lines: 3001 }], over)).toEqual(["packages/core/src/big.ts: 3001 lines > its ceiling 3000 (the limit is 1000; the ceiling only goes down)"]);
  expect(check([{ path: "packages/core/src/big.ts", lines: 1000 }], over)).toEqual(["packages/core/src/big.ts: 1000 lines is within the limit of 1000: remove its entry from STILL_OVER (scripts/file-size.ts)"]);
  expect(check([], over)).toEqual(["packages/core/src/big.ts: not there any more: remove its entry from STILL_OVER (scripts/file-size.ts)"]);
});

test("file size: against the base's list a ceiling may go down or go away, never up, and no entry is added", () => {
  const base = { "packages/core/src/big.ts": 3000, "apps/web/src/B.tsx": 1500 };
  expect(raisedAgainst(base, base)).toEqual([]);
  expect(raisedAgainst({ "packages/core/src/big.ts": 2999 }, base)).toEqual([]);
  expect(raisedAgainst({ "packages/core/src/big.ts": 3001, "apps/web/src/B.tsx": 1500 }, base)).toEqual(["packages/core/src/big.ts: its ceiling 3001 > the base's 3000: a ceiling only goes down"]);
  expect(raisedAgainst({ ...base, "packages/core/src/new.ts": 1100 }, base)).toEqual(["packages/core/src/new.ts: added to STILL_OVER (the base's list does not have it): nothing is added to the list, split the file"]);
  // the base's list is read from the script's own text: this checkout's text gives this checkout's list
  expect(listedIn(readFileSync(join(import.meta.dir, "file-size.ts"), "utf8"))).toEqual(STILL_OVER);
  expect(listedIn("export const ROOTS = [];\n")).toBeNull();
  // a list emptied to one line is an empty list, not a text without one: every later run would otherwise fail
  expect(listedIn("export const STILL_OVER: Record<string, number> = {};\nexport const ROOTS = [];\n")).toEqual({});
  expect(listedIn("export const STILL_OVER: Record<string, number> = {};\nexport const X = {\n};\n")).toEqual({});
});

test("file size: the command fails a change that raises a ceiling with its file, or lists a new file, and passes one that lowers both", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard.file-size."));
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  };
  const script = readFileSync(join(import.meta.dir, "file-size.ts"), "utf8");
  // the checkout's state: the script with this list, and each listed file with this many lines
  const put = (list: Record<string, number>, lines: Record<string, number>) => {
    const text = script.replace(/^(export const STILL_OVER\b[^=]*=\s*\{)[\s\S]*?^\};/m, (_, head: string) => `${head}\n${Object.entries(list).map(([p, n]) => `  "${p}": ${n},`).join("\n")}\n};`);
    expect(listedIn(text)).toEqual(list);
    writeFileSync(join(dir, "scripts/file-size.ts"), text);
    for (const [p, n] of Object.entries(lines)) writeFileSync(join(dir, p), "x\n".repeat(n));
  };
  const run = (ref = "HEAD") => {
    const { FILE_SIZE_BASE_LIST: _, ...env } = process.env;
    const p = Bun.spawnSync([process.execPath, "scripts/file-size.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...env, FILE_SIZE_BASE_REF: ref } });
    return { code: p.exitCode, out: p.stdout.toString() };
  };
  try {
    for (const d of ["scripts", "packages/core/src", "packages/protocol/src", "apps/web/src"]) mkdirSync(join(dir, d), { recursive: true });
    put({ "packages/core/src/big.ts": 1200 }, { "packages/core/src/big.ts": 1200, "packages/core/src/other.ts": 900 });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    expect(run()).toEqual({ code: 0, out: "the ceilings are compared with HEAD\nfiles: 2 / over: 0 / still over (listed): 1\n" });
    // the file grows and its ceiling is raised to match: each alone would fail too, and both together still do
    put({ "packages/core/src/big.ts": 1300 }, { "packages/core/src/big.ts": 1300 });
    expect(run()).toEqual({ code: 1, out: "packages/core/src/big.ts: its ceiling 1300 > the base's 1200: a ceiling only goes down\nthe ceilings are compared with HEAD\nfiles: 2 / over: 1 / still over (listed): 1\n" });
    // another file grows over the limit and is put on the list
    put({ "packages/core/src/big.ts": 1200, "packages/core/src/other.ts": 1001 }, { "packages/core/src/big.ts": 1200, "packages/core/src/other.ts": 1001 });
    expect(run().code).toBe(1);
    expect(run().out).toContain("packages/core/src/other.ts: added to STILL_OVER");
    // the file shrinks: it fails until the ceiling follows, then passes
    put({ "packages/core/src/big.ts": 1200 }, { "packages/core/src/big.ts": 1100, "packages/core/src/other.ts": 900 });
    expect(run().out).toContain("lower the ceiling to 1100");
    put({ "packages/core/src/big.ts": 1100 }, {});
    expect(run().code).toBe(0);
    // a base that cannot be read fails, with why in one line: the comparison is not skipped (the files themselves are within their ceilings here)
    const none = run("no-such-ref");
    expect(none.code).toBe(1);
    expect(none.out).toStartWith("the ceilings cannot be compared with the base's (no-such-ref:scripts/file-size.ts: ");
    expect(none.out).toEndWith(")\nfiles: 2 / over: 0 / still over (listed): 1\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file size: FILE_SIZE_BASE_LIST is the base's list where there is no git: a ceiling above it fails, and the run says what it compared with; a value that is not such a JSON fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard.file-size."));
  const script = readFileSync(join(import.meta.dir, "file-size.ts"), "utf8");
  const run = (given: string) => {
    const { FILE_SIZE_BASE_REF: _, ...env } = process.env;
    const p = Bun.spawnSync([process.execPath, "scripts/file-size.ts"], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...env, FILE_SIZE_BASE_LIST: given } });
    return { code: p.exitCode, out: p.stdout.toString() };
  };
  try {
    for (const d of ["scripts", "packages/core/src", "packages/protocol/src", "apps/web/src"]) mkdirSync(join(dir, d), { recursive: true });
    // no .git: only the given list can be compared with
    writeFileSync(join(dir, "scripts/file-size.ts"), script.replace(/^(export const STILL_OVER\b[^=]*=\s*\{)[\s\S]*?^\};/m, (_, head: string) => `${head}\n  "packages/core/src/big.ts": 1200,\n};`));
    writeFileSync(join(dir, "packages/core/src/big.ts"), "x\n".repeat(1200));
    expect(run(JSON.stringify({ "packages/core/src/big.ts": 1200 }))).toEqual({ code: 0, out: "the ceilings are compared with FILE_SIZE_BASE_LIST\nfiles: 1 / over: 0 / still over (listed): 1\n" });
    expect(run(JSON.stringify({ "packages/core/src/big.ts": 1199 }))).toEqual({ code: 1, out: "packages/core/src/big.ts: its ceiling 1200 > the base's 1199: a ceiling only goes down\nthe ceilings are compared with FILE_SIZE_BASE_LIST\nfiles: 1 / over: 1 / still over (listed): 1\n" });
    expect(run(JSON.stringify({})).out).toContain("packages/core/src/big.ts: added to STILL_OVER");
    const notJson = run("{nope");
    expect(notJson.code).toBe(1);
    expect(notJson.out).toContain("the ceilings cannot be compared with the base's (FILE_SIZE_BASE_LIST: not JSON (");
    expect(run("[1200]")).toEqual({ code: 1, out: "the ceilings cannot be compared with the base's (FILE_SIZE_BASE_LIST: not a JSON object of path → ceiling)\nfiles: 1 / over: 0 / still over (listed): 1\n" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file size: measure counts the lines of the .ts and .tsx files under the roots, as wc -l does", () => {
  expect([lineCount(""), lineCount("a\n"), lineCount("a\nb"), lineCount("a\nb\n")]).toEqual([0, 1, 1, 2]);
  const dir = mkdtempSync(join(tmpdir(), "switchboard.file-size."));
  try {
    mkdirSync(join(dir, "src/components"), { recursive: true });
    mkdirSync(join(dir, "src/node_modules/x"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "x\n".repeat(1001));
    writeFileSync(join(dir, "src/components/B.tsx"), "x\n".repeat(3));
    writeFileSync(join(dir, "src/styles.css"), "x\n".repeat(5000));
    writeFileSync(join(dir, "src/node_modules/x/c.ts"), "x\n".repeat(5000));
    const files = measure(dir, ["src"]);
    expect(files).toEqual([{ path: "src/a.ts", lines: 1001 }, { path: "src/components/B.tsx", lines: 3 }]);
    expect(check(files, {})).toEqual(["src/a.ts: 1001 lines > 1000 (a source file): split it by feature"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file size: this checkout passes, every listed file is under the roots, and the CI runs the check", () => {
  expect(check(measure(join(import.meta.dir, "..")))).toEqual([]);
  for (const path of Object.keys(STILL_OVER)) expect(ROOTS.some((r) => path.startsWith(`${r}/`))).toBe(true);
  expect(ciSteps.map((s) => s.run)).toContain("bun scripts/file-size.ts");
});
