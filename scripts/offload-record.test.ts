// test-reads: none
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKey, fileLog, recordDays, type OffloadRecord } from "./offload-record.ts";

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
    // a recording's mtime
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
