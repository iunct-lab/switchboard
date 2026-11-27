// test-reads: aws/host/archive.sh docs/design/host-disk.md
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The daily record (`disk-history.tsv`): one column per place of the budget in docs/design/host-disk.md, measured after
 * the old runner records moved to S3. `aws/host/archive.sh` runs against fake `df`, `aws`, `bun`, `tar` and `age` on PATH.
 */
const HERE = import.meta.dir;
const MB = 1024 * 1024;
let dir: string;
let home: string;

const fake = (name: string, body: string) => {
  writeFileSync(join(dir, "bin", name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, "bin", name), 0o755);
};
const put = (rel: string, mb: number, daysOld = 0) => {
  const f = join(home, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, Buffer.alloc(mb * MB));
  const t = new Date(Date.now() - daysOld * 86400_000);
  utimesSync(f, t, t);
};

// the place rows of the budget section: the first backtick name of each row of its table
function budgetPlaces(): string[] {
  const doc = readFileSync(join(HERE, "../../docs/design/host-disk.md"), "utf8");
  const section = doc.split("\n## ルートディスクの予算")[1]!.split("\n### 置き場所と上限")[1]!.split("\n### ")[0]!;
  return [...section.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]!);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-test-disk-record-"));
  home = join(dir, "home");
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(home, ".switchboard"), { recursive: true });
  writeFileSync(join(dir, "host.env"), `SB_DATA_BUCKET=bucket\nSB_REPO_DIR=${join(home, "repos", "switchboard")}\n`);
  fake("df", "echo Filesystem 1048576-blocks Used Available Capacity Mounted; echo /dev/x 20000 17000 3000 85% /");
  fake("aws", `[ "$1" = ssm ] && echo age1recipient; exit 0`);
  fake("bun", `[ "$1" = -e ] && exit 0; [ "$2" = export ] && echo pkg > "$3"; exit 0`);
  fake("tar", `cat "$7" > /dev/null; echo tarball`);
  fake("age", "cat");
  writeFileSync(join(home, ".switchboard", "switchboard.db"), Buffer.alloc(2 * MB));
  put(".switchboard/snapshots/a.db", 3);
  put(".switchboard/releases/r", 4);
  // 5 MiB of transcripts, 4 of them old: with a 1 MiB budget only the newest stays
  put(".claude/projects/-w/11111111-1111-4111-8111-111111111111.jsonl", 2, 30);
  put(".claude/projects/-w/22222222-2222-4222-8222-222222222222.jsonl", 2, 30);
  put(".codex/sessions/2026/09/01/rollout-2026-09-01T00-00-00-33333333-3333-4333-8333-333333333333.jsonl", 1, 1);
  put(".cache/other/f", 6);
  put(".cache/ms-playwright/f", 7);
  put(".local/share/docker/f", 8);
  put(".local/share/claude/f", 9);
  put(".bun/f", 10);
  put("repos/other/f", 11);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// docs/design/host-disk.md is left out of the public tree (publicSync.exclude): a public clone skips the count against it
test.skipIf(!existsSync(join(HERE, "../../docs/design/host-disk.md")))("the daily record has a column for every place of the budget, and the transcripts column is the size after the move", () => {
  const places = budgetPlaces();
  expect(places).toEqual(["os", "swap", "docker", "runner", "db", "snapshots", "switchboard", "transcripts", "cache", "repos", "other", "free"]);
  const r = Bun.spawnSync(["bash", join(HERE, "archive.sh")], {
    env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, SB_HOST_ENV: join(dir, "host.env"), HOME: home, SB_RUNNER_KEEP_MB: "1" },
    stderr: "pipe", stdout: "pipe",
  });
  expect(r.stderr.toString()).not.toContain("not recorded");
  expect(r.exitCode).toBe(0);
  expect(readFileSync(join(home, ".switchboard", "runner-archive.tsv"), "utf8").trim().split("\n")).toHaveLength(2); // the two old files moved

  const lines = readFileSync(join(home, ".switchboard", "disk-history.tsv"), "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  // date, used, and one column per place (the place `free` is the df free column)
  const cols = lines[0]!.split("\t");
  expect(cols).toHaveLength(places.length + 2);
  const [date, used, free, db, snapshots, sb, transcripts, cache, os, swap, docker, runner, repos, other] = cols;
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect([used, free]).toEqual(["17000", "3000"]);
  expect(Number(transcripts)).toBe(1); // after the move: 1 of the 5 MiB
  expect(Number(db)).toBe(2);
  expect(Number(snapshots)).toBe(3);
  // releases (4) and the small status files, rounded up: not the database (2), the snapshots (3), nor the archive's work folder
  expect(Number(sb)).toBeGreaterThanOrEqual(4);
  expect(Number(sb)).toBeLessThanOrEqual(5);
  expect(Number(cache)).toBe(6); // ms-playwright counts as runner
  expect(Number(docker)).toBe(8);
  expect(Number(runner)).toBe(26); // claude 9 + bun 10 + ms-playwright 7
  expect(Number(repos)).toBe(11);
  expect(Number(os)).toBeGreaterThan(0);
  expect(Number(swap)).toBeGreaterThanOrEqual(0); // the real /swapfile (2048 here), none elsewhere
  expect(Number(other)).toBe(Math.max(0, 17000 - Number(os) - Number(swap) - Number(docker) - Number(runner) - 2 - 3 - Number(sb) - 1 - 6 - 11));
});

// What the record leaves out and when it is written: a fake `df` whose used grows with the test HOME, a fake `du` that walks
// only the test folder (and logs what it was asked).
const ARCHIVE = resolve(HERE, "archive.sh");
let rdir: string;

beforeAll(() => {
  rdir = mkdtempSync(join(tmpdir(), "switchboard-test-disk-record-when-"));
});
afterAll(() => rmSync(rdir, { recursive: true, force: true }));

function scene(name: string, repoDir?: string) {
  const root = join(rdir, name);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".switchboard"), { recursive: true });
  writeFileSync(join(root, "host.env"), `SB_DATA_BUCKET=bucket\nSB_REPO_DIR=${repoDir ?? join(home, "repos", "switchboard")}\n`);
  const fake = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  // `used` grows with what is under the test HOME at the moment df is asked, as the real one would
  fake("df", `u=$(/usr/bin/du -sm "$HOME" | cut -f1); echo Filesystem 1048576-blocks Used Available Capacity Mounted; echo /dev/x 20000 $u $((20000 - u)) 1% /`);
  fake("aws", `[ "$1" = ssm ] && echo age1recipient; exit 0`);
  // the export writes a 50 MiB package, or fails with BUN_EXIT
  fake("bun", `[ "$1" = -e ] && exit 0; if [ "$2" = export ]; then [ -n "$BUN_EXIT" ] && exit "$BUN_EXIT"; head -c ${50 * MB} /dev/zero > "$3"; fi; exit 0`);
  // never walk the real system folders: log what was asked, and measure only what is inside the test folder
  fake("du", `echo "$*" >> "${join(root, "du.log")}"; for a in "$@"; do case "$a" in "${root}"/*) exec /usr/bin/du "$@";; esac; done; exit 0`);
  const put = (rel: string, mb: number) => {
    const f = join(home, rel);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, Buffer.alloc(mb * MB));
  };
  const run = (env: Record<string, string> = {}) =>
    Bun.spawnSync(["bash", ARCHIVE], {
      env: { PATH: `${bin}:/usr/bin:/bin`, SB_HOST_ENV: join(root, "host.env"), HOME: home, SB_RUNNER_KEEP_MB: "100", ...env },
      stdout: "pipe", stderr: "pipe",
    });
  const file = join(home, ".switchboard", "disk-history.tsv");
  const cols = () => readFileSync(file, "utf8").trim().split("\n")[0]!.split("\t");
  const duLog = () => readFileSync(join(root, "du.log"), "utf8").split("\n");
  return { home, put, run, file, cols, duLog };
}

test("used / other do not count the archive's own temporary output", () => {
  const t = scene("temp");
  expect(t.run().exitCode).toBe(0);
  const [, used] = t.cols();
  // nothing but a few status files is left on the disk after the run
  expect(Number(used)).toBeLessThan(10);
});

test("a failed export still leaves the day's disk line", () => {
  const t = scene("failed");
  expect(t.run({ BUN_EXIT: "1" }).exitCode).not.toBe(0);
  expect(existsSync(t.file)).toBe(true);
});

test("nested folders named like the excluded ones still count as switchboard", () => {
  const t = scene("nested");
  t.put(".switchboard/jobs/1/snapshots/f", 5);
  t.put(".switchboard/jobs/1/switchboard.db", 7);
  expect(t.run().exitCode).toBe(0);
  const [, , , , snapshots, sb] = t.cols();
  expect(Number(snapshots)).toBe(0);
  expect(Number(sb)).toBeGreaterThanOrEqual(12);
});

test("with SB_REPO_DIR at the top of the file system (the host tests' /nowhere) the record never walks the whole root", () => {
  const t = scene("root", "/nowhere");
  expect(t.run().exitCode).toBe(0);
  expect(t.duLog()).not.toContain("-xsm /");
});

// A day that fails or runs twice: the line is written on the way out, after the cleanup, and the last run of the day wins.
let fdir: string;

beforeAll(() => {
  fdir = mkdtempSync(join(tmpdir(), "switchboard-test-disk-record-day-"));
});
afterAll(() => rmSync(fdir, { recursive: true, force: true }));

function day(name: string) {
  const root = join(fdir, name);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".switchboard"), { recursive: true });
  writeFileSync(join(root, "host.env"), `SB_DATA_BUCKET=bucket\nSB_REPO_DIR=${join(home, "repos", "switchboard")}\n`);
  const fake = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  fake("df", "echo Filesystem 1048576-blocks Used Available Capacity Mounted; echo /dev/x 20000 17000 3000 85% /");
  fake("aws", `[ "$1" = ssm ] && echo age1recipient; exit 0`);
  // BUN_EXIT fails the export; BLOCK_STATUS also makes the status file impossible to write from then on
  fake("bun", `[ "$1" = -e ] && exit 0; if [ "$2" = export ]; then echo pkg > "$3"; [ -n "$BLOCK_STATUS" ] && rm -f "$HOME/.switchboard/archive.status" && mkdir "$HOME/.switchboard/archive.status"; [ -n "$BUN_EXIT" ] && exit "$BUN_EXIT"; fi; exit 0`);
  fake("tar", `cat "$7" > /dev/null; echo tarball`);
  fake("age", "cat");
  fake("du", `for a in "$@"; do case "$a" in "${root}"/*) exec /usr/bin/du "$@";; esac; done; exit 0`);
  const put = (rel: string, mb: number, daysOld = 0) => {
    const f = join(home, rel);
    mkdirSync(join(f, ".."), { recursive: true });
    writeFileSync(f, Buffer.alloc(mb * MB));
    const t = new Date(Date.now() - daysOld * 86400_000);
    utimesSync(f, t, t);
  };
  const run = (env: Record<string, string> = {}) =>
    Bun.spawnSync(["bash", ARCHIVE], {
      env: { PATH: `${bin}:/usr/bin:/bin`, SB_HOST_ENV: join(root, "host.env"), HOME: home, SB_RUNNER_KEEP_MB: "1", ...env },
      stdout: "pipe", stderr: "pipe",
    });
  const file = join(home, ".switchboard", "disk-history.tsv");
  const lines = () => readFileSync(file, "utf8").trim().split("\n").map((l) => l.split("\t"));
  return { home, put, run, file, lines };
}

test("a rerun that moves the transcripts after a failed run of the same day records the size after the move", () => {
  const t = day("rerun");
  writeFileSync(join(t.home, ".switchboard", "switchboard.db"), Buffer.alloc(MB));
  t.put(".claude/projects/-w/11111111-1111-4111-8111-111111111111.jsonl", 2, 30);
  t.put(".claude/projects/-w/22222222-2222-4222-8222-222222222222.jsonl", 2, 30);
  t.put(".codex/sessions/2026/09/01/rollout-2026-09-01T00-00-00-33333333-3333-4333-8333-333333333333.jsonl", 1, 1);
  expect(t.run({ BUN_EXIT: "1" }).exitCode).not.toBe(0);
  expect(t.run().exitCode).toBe(0);
  expect(readFileSync(join(t.home, ".switchboard", "runner-archive.tsv"), "utf8").trim().split("\n")).toHaveLength(2);
  const rows = t.lines();
  expect(rows).toHaveLength(1);
  expect(Number(rows[0]![6])).toBe(1); // transcripts column: 1 MiB stays on the disk
});

test("a failed day whose status line cannot be written still removes the temporary output and leaves the disk line", () => {
  const t = day("status");
  const r = t.run({ BUN_EXIT: "1", BLOCK_STATUS: "1" });
  expect(r.exitCode).not.toBe(0);
  expect({ line: existsSync(t.file), out: existsSync(join(t.home, ".switchboard", "archive-out")) }).toEqual({ line: true, out: false });
});

test("a run that fails while emptying the work folder still leaves the day's disk line", () => {
  const root = mkdtempSync(join(tmpdir(), "switchboard-test-disk-early-"));
  const home = join(root, "home");
  const locked = join(home, ".switchboard", "archive-out", "locked");
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    mkdirSync(join(locked, "x"), { recursive: true });
    chmodSync(locked, 0o500);
    writeFileSync(join(root, "host.env"), `SB_DATA_BUCKET=bucket\nSB_REPO_DIR=${join(home, "repos", "sb")}\n`);
    const fake = (n: string, body: string) => {
      writeFileSync(join(bin, n), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, n), 0o755);
    };
    fake("df", "echo Filesystem 1048576-blocks Used Available Capacity Mounted; echo /dev/x 20000 17000 3000 85% /");
    fake("du", "exit 0");
    const r = Bun.spawnSync(["bash", ARCHIVE], {
      env: { PATH: `${bin}:/usr/bin:/bin`, SB_HOST_ENV: join(root, "host.env"), HOME: home },
      stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(home, ".switchboard", "disk-history.tsv"))).toBe(true);
  } finally {
    chmodSync(locked, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

// The history itself: a same-day rerun keeps every other day, also in a file with a stray NUL; and the root is never walked.
let hdir: string;

beforeAll(() => {
  hdir = mkdtempSync(join(tmpdir(), "switchboard-test-disk-history-"));
});
afterAll(() => rmSync(hdir, { recursive: true, force: true }));

function hist(name: string, repoDir?: string) {
  const root = join(hdir, name);
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".switchboard"), { recursive: true });
  writeFileSync(join(root, "host.env"), `SB_DATA_BUCKET=bucket\nSB_REPO_DIR=${repoDir ?? join(home, "repos", "sb")}\n`);
  const fake = (n: string, body: string) => {
    writeFileSync(join(bin, n), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, n), 0o755);
  };
  fake("df", "echo Filesystem 1048576-blocks Used Available Capacity Mounted; echo /dev/x 20000 17000 3000 85% /");
  fake("aws", `[ "$1" = ssm ] && echo age1recipient; exit 0`);
  fake("bun", `[ "$1" = -e ] && exit 0; [ "$2" = export ] && echo pkg > "$3"; exit 0`);
  // logs what it was asked, walks nothing
  fake("du", `echo "$*" >> "${join(root, "du.log")}"; exit 0`);
  const run = () =>
    Bun.spawnSync(["bash", ARCHIVE], {
      env: { PATH: `${bin}:/usr/bin:/bin`, SB_HOST_ENV: join(root, "host.env"), HOME: home },
      stdout: "pipe", stderr: "pipe",
    });
  return { run, file: join(home, ".switchboard", "disk-history.tsv"), duLog: () => readFileSync(join(root, "du.log"), "utf8").split("\n") };
}

const todayUtc = new Date().toISOString().slice(0, 10);
const older = "2026-01-01\t1\t2\n2026-01-02\t3\t4\n";

test("a same-day rerun keeps the older days (plain file)", () => {
  const t = hist("plain");
  writeFileSync(t.file, `${older}${todayUtc}\t5\t6\n`);
  const r = t.run();
  expect(r.exitCode).toBe(0);
  expect(readFileSync(t.file, "utf8")).toContain("2026-01-01\t1\t2");
});

test("a same-day rerun keeps the older days when the file holds a NUL byte", () => {
  const t = hist("nul");
  writeFileSync(t.file, `${older}\0\0\0\0\n${todayUtc}\t5\t6\n`);
  const r = t.run();
  expect(r.exitCode).toBe(0);
  const after = readFileSync(t.file, "utf8");
  expect(after).toContain("2026-01-01\t1\t2");
  expect(after).toContain("2026-01-02\t3\t4");
});

test("a double-slash spelling of the root is not walked", () => {
  const t = hist("slash", "//usr/../sb");
  expect(t.run().exitCode).toBe(0);
  expect(t.duLog()).not.toContain("-xsm //");
});
