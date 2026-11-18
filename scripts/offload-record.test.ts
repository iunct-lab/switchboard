// test-reads: none
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKey, fileLog, findReusable, recordDays, reusableOutput, reuseHours, type OffloadLog, type OffloadRecord } from "./offload-record.ts";

const W = mkdtempSync(join(tmpdir(), "switchboard.offload-record."));
afterAll(() => rmSync(W, { recursive: true, force: true }));

const row = (at: string, build: string): OffloadRecord => ({ at, caller: "typecheck", kind: "ci", build, size: "small", tree: "/t" });

describe("buildKey", () => {
  const repo = join(W, "repo");
  const fixtures = join(W, "fixtures");
  const git = (...a: string[]) => Bun.$`git -C ${repo} ${a}`.quiet();
  const key = (script = "s", size: "small" | "medium" = "small", withFixtures = true) => buildKey(repo, script, { size, ...(withFixtures ? { fixtures } : {}) });

  test("same content gives the same key; each input changes it", async () => {
    mkdirSync(repo);
    mkdirSync(fixtures);
    await git("init", "-q");
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(fixtures, "r.json"), "{}");
    await git("add", "a.txt");
    const base = await key();
    expect(await key()).toBe(base);
    expect(await key("s2")).not.toBe(base);
    expect(await key("s", "medium")).not.toBe(base);
    expect(await key("s", "small", false)).not.toBe(base);
    // a recording is told by its content: the same length and mtime with other bytes is another key, and a touch alone is not
    utimesSync(join(fixtures, "r.json"), new Date(1e12), new Date(1e12));
    expect(await key()).toBe(base);
    writeFileSync(join(fixtures, "r.json"), "[]");
    utimesSync(join(fixtures, "r.json"), new Date(1e12), new Date(1e12));
    expect(await key()).not.toBe(base);
    const base2 = await key();
    // an untracked file
    writeFileSync(join(repo, "new.txt"), "n\n");
    const withNew = await key();
    expect(withNew).not.toBe(base2);
    // a tracked file's content
    writeFileSync(join(repo, "a.txt"), "changed\n");
    expect(await key()).not.toBe(withNew);
  });

  test("a tracked file deleted from the work tree is skipped", async () => {
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x");
    const before = await key();
    rmSync(join(repo, "new.txt"));
    const after = await key();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("fileLog", () => {
  test("append drops rows older than keepDays and skips unreadable lines on read", () => {
    const path = join(W, "sub", "log.jsonl");
    const now = Date.now();
    const old = new Date(now - 40 * 86_400_000).toISOString();
    const recent = new Date(now - 86_400_000).toISOString();
    const log = fileLog(path, 30);
    log.append(row(old, "old"));
    log.append(row(recent, "recent"));
    // the old row went at the second append; a broken line is skipped when reading
    writeFileSync(path, `${readFileSync(path, "utf8")}not json\n`);
    log.append(row(new Date(now).toISOString(), "now"));
    expect(log.read(0).map((r) => r.build)).toEqual(["recent", "now"]);
    expect(log.read(now - 3600_000).map((r) => r.build)).toEqual(["now"]);
    // a row less than a day past keepDays is left until the next day's rewrite (appends do not rewrite every time)
    const path2 = join(W, "sub", "log2.jsonl");
    const log2 = fileLog(path2, 30);
    log2.append(row(new Date(now - 30.5 * 86_400_000).toISOString(), "edge"));
    log2.append(row(new Date(now).toISOString(), "now"));
    expect(log2.read(0).map((r) => r.build)).toEqual(["edge", "now"]);
  });

  test("recordDays: a positive number from the environment, else 30", () => {
    expect(recordDays({})).toBe(30);
    expect(recordDays({ SWITCHBOARD_OFFLOAD_RECORD_DAYS: "7" })).toBe(7);
    expect(recordDays({ SWITCHBOARD_OFFLOAD_RECORD_DAYS: "0" })).toBe(30);
    expect(recordDays({ SWITCHBOARD_OFFLOAD_RECORD_DAYS: "x" })).toBe(30);
  });
});

describe("reuse", () => {
  const NOW = Date.parse("2026-11-17T12:00:00Z");
  const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
  const logOf = (rows: OffloadRecord[]): OffloadLog => ({ append: (r) => void rows.push(r), read: (since) => rows.filter((r) => Date.parse(r.at) >= since) });

  test("findReusable: the newest ci row of exactly this key inside the window; not an image row, another key, a row without a key, or one outside the window", () => {
    const rows: OffloadRecord[] = [
      { ...row(at(30), "old"), key: "k" },
      { ...row(at(5), "five"), key: "k" },
      { ...row(at(2), "two"), key: "k" },
      { ...row(at(1), "other"), key: "k2" },
      { ...row(at(1), "nokey") },
      { at: at(0.5), caller: "typecheck", kind: "image", build: "img", size: "small", key: "k", tree: "/t" },
    ];
    const log = logOf(rows);
    expect(findReusable(log, "k", 24, NOW)?.build).toBe("two");
    expect(findReusable(log, "k", 1.5, NOW)).toBeUndefined();
    expect(findReusable(log, "k3", 24, NOW)).toBeUndefined();
    expect(findReusable(log, "k", 48, NOW)?.build).toBe("two");
    // a width of 0 reuses nothing
    expect(findReusable(log, "k", 0, NOW)).toBeUndefined();
  });

  test("reusableOutput: only a build whose command ran to its end (its exit line) — a stop, a timeout, a failure before the command and an unreadable log are not", () => {
    expect(reusableOutput("sb-step: 0 begin 1\nsb-step: 0 exit 0 2\nsb-offload: exit 0\n")).toBe(true);
    expect(reusableOutput("sb-step: 0 begin 1\n(fail) a\nsb-step: 0 exit 1 2\nsb-offload: exit 1\n")).toBe(true);
    // no sb-step line and 130: stopped
    expect(reusableOutput("sb-offload: proj:1 ended STOPPED without the command's exit code\n")).toBe(false);
    expect(reusableOutput("sb-step: 0 begin 1\n")).toBe(false);
    expect(reusableOutput("sb-offload: proj:1 ended FAILED without the command's exit code\n")).toBe(false);
    expect(reusableOutput("sb-offload: no build proj:1\n")).toBe(false);
    expect(reusableOutput("")).toBe(false);
  });

  test("reuseHours: a number of 0 or more from the environment, else 24", () => {
    expect(reuseHours({})).toBe(24);
    expect(reuseHours({ SWITCHBOARD_OFFLOAD_REUSE_HOURS: "2" })).toBe(2);
    expect(reuseHours({ SWITCHBOARD_OFFLOAD_REUSE_HOURS: "0" })).toBe(0);
    expect(reuseHours({ SWITCHBOARD_OFFLOAD_REUSE_HOURS: "0.5" })).toBe(0.5);
    for (const bad of ["", "x", "-1"]) expect(reuseHours({ SWITCHBOARD_OFFLOAD_REUSE_HOURS: bad })).toBe(24);
  });
});
