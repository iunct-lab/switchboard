// test-reads: ops-kit/bin/ ops-kit/src/cli.ts ops-kit/skills/
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWaitArgs, runWait, WAIT_CUT_EXIT, WAIT_CUT_LINE, WaitFile, type WaitDeps, type WaitOpts } from "./wait.ts";

const CLI = join(import.meta.dir, "..", "bin", "ops-kit");

/** A clock that only moves when the wait sleeps (and by `checkMs` per command), so no test waits. */
function fake(o: { check: (n: number, now: number) => number; progress?: (now: number) => string; env?: Record<string, string>; checkMs?: number; during?: (now: number) => void }) {
  let now = 1_000_000;
  let checks = 0;
  const lines: string[] = [];
  const deps: WaitDeps = {
    now: () => now,
    sleep: async (ms) => {
      o.during?.(now);
      now += ms;
    },
    run: async (cmd, r) => {
      now += o.checkMs ?? 0;
      if (r.capture) return { code: 0, stdout: o.progress?.(now) ?? "" };
      expect(cmd).toEqual(["check"]);
      return { code: o.check(++checks, now), stdout: "" };
    },
    env: o.env ?? {},
    pid: process.pid,
    err: (l) => lines.push(l),
  };
  return { deps, lines, checks: () => checks, now: () => now };
}

const opts = (over: Partial<WaitOpts> = {}): WaitOpts => ({ label: "PR 12 のマージ", keys: [], timeoutSec: 600, onTimeout: "fail", intervalSec: 5, check: ["check"], ...over });

test("parseWaitArgs: a wait for a person's answer or leave cannot go on when it runs out (proceed is refused); other waits may", () => {
  const args = (label: string, on: string) => ["--for", label, "--timeout", "60", "--on-timeout", on, "--", "true"];
  for (const label of ["利用者の承認", "PR #12 のレビュー", "## 回答 が付く", "マージの許可", "昇格の確認", "the owner's approval", "review of PR 12", "an answer on the Issue", "merge of the PR"]) {
    expect({ label, parsed: parseWaitArgs(args(label, "proceed")) }).toEqual({ label, parsed: null });
    expect(parseWaitArgs(args(label, "fail"))?.onTimeout).toBe("fail");
  }
  expect(parseWaitArgs(args("ビルド b-1 の完了", "proceed"))?.onTimeout).toBe("proceed");
});

test("parseWaitArgs: what is waited for, the limit and what a cut does are all required", () => {
  const full = ["--for", "x", "--timeout", "60", "--on-timeout", "fail", "--", "true"];
  expect(parseWaitArgs(full)).toEqual({ label: "x", keys: [], timeoutSec: 60, onTimeout: "fail", intervalSec: 5, check: ["true"] });
  for (const flag of ["--for", "--timeout", "--on-timeout"]) {
    const at = full.indexOf(flag);
    expect(parseWaitArgs([...full.slice(0, at), ...full.slice(at + 2)])).toBeNull();
  }
  expect(parseWaitArgs(["--for", "x", "--timeout", "0", "--on-timeout", "fail", "--", "true"])).toBeNull();
  // a limit is a time: a number too large to be one (400 digits read as Infinity) is refused, for every value in seconds
  const withTimeout = (v: string) => parseWaitArgs(["--for", "x", "--timeout", v, "--on-timeout", "fail", "--", "true"]);
  expect(withTimeout("604800")?.timeoutSec).toBe(604800);
  for (const v of ["604801", "9".repeat(17), "9".repeat(400)]) expect({ v, parsed: withTimeout(v) }).toEqual({ v, parsed: null });
  expect(parseWaitArgs([...full.slice(0, 6), "--interval", "9".repeat(400), "--", "true"])).toBeNull();
  expect(parseWaitArgs([...full.slice(0, 6), "--progress", "wc -c log", "--stall", "9".repeat(400), "--", "true"])).toBeNull();
  expect(parseWaitArgs(["--for", " ", "--timeout", "60", "--on-timeout", "fail", "--", "true"])).toBeNull();
  expect(parseWaitArgs(["--for", "x", "--timeout", "60", "--on-timeout", "retry", "--", "true"])).toBeNull();
  expect(parseWaitArgs(["--for", "x", "--timeout", "60", "--on-timeout", "fail"])).toBeNull();
  expect(parseWaitArgs(["--for", "x", "--timeout", "60", "--on-timeout", "fail", "--"])).toBeNull();
  // the progress command and its limit go together
  expect(parseWaitArgs([...full.slice(0, 6), "--progress", "wc -c log", "--", "true"])).toBeNull();
  expect(parseWaitArgs([...full.slice(0, 6), "--stall", "30", "--", "true"])).toBeNull();
  expect(parseWaitArgs([...full.slice(0, 6), "--progress", "wc -c log", "--stall", "30", "--interval", "2", "--", "sh", "-c", "x"])).toEqual({ label: "x", keys: [], timeoutSec: 60, onTimeout: "fail", intervalSec: 2, progress: "wc -c log", stallSec: 30, check: ["sh", "-c", "x"] });
});

test("runWait: the check succeeding ends the wait", async () => {
  const f = fake({ check: (n) => (n === 3 ? 0 : 1) });
  expect(await runWait(opts(), f.deps)).toEqual({ code: 0, reason: "ok", waitedSec: 10 });
  expect(f.lines).toEqual([]);
});

test("runWait: a check that never succeeds is cut at the limit — fail exits 124, proceed 0, both say why", async () => {
  const failed = fake({ check: () => 1 });
  expect(await runWait(opts({ timeoutSec: 60 }), failed.deps)).toEqual({ code: WAIT_CUT_EXIT, reason: "timeout", waitedSec: 60 });
  expect(failed.lines).toEqual([WAIT_CUT_LINE("timeout", "PR 12 のマージ", 60)]);
  expect(failed.lines[0]).toBe("待ちが切れた（上限）: PR 12 のマージ を 60 秒待った");
  const went = fake({ check: () => 1 });
  expect(await runWait(opts({ timeoutSec: 60, onTimeout: "proceed" }), went.deps)).toEqual({ code: 0, reason: "timeout", waitedSec: 60 });
  expect(went.lines).toHaveLength(1);
});

test("runWait: a slow check does not carry the wait past its limit", async () => {
  const f = fake({ check: () => 1, checkMs: 50_000 });
  const r = await runWait(opts({ timeoutSec: 60 }), f.deps);
  expect(r.reason).toBe("timeout");
  expect(f.checks()).toBe(2);
});

test("runWait: the other side standing still cuts the wait long before the limit; moving on, it lasts to the limit", async () => {
  // the other Task's log grows for 20 s, then stops
  const stuck = fake({ check: () => 1, progress: (now) => String(Math.min(now, 1_000_000 + 20_000)) });
  const r = await runWait(opts({ progress: "wc -c log", stallSec: 30 }), stuck.deps);
  expect(r).toMatchObject({ code: WAIT_CUT_EXIT, reason: "stalled" });
  expect(r.waitedSec).toBeLessThan(60);
  expect(stuck.lines).toEqual([`待ちが切れた（無進捗）: PR 12 のマージ を ${r.waitedSec} 秒待った`]);
  const moving = fake({ check: () => 1, progress: (now) => String(now) });
  expect(await runWait(opts({ progress: "wc -c log", stallSec: 30 }), moving.deps)).toMatchObject({ reason: "timeout", waitedSec: 600 });
});

test("runWait: inside a Task the wait has a record while it lasts; success removes it, a cut with fail leaves it with the reason", async () => {
  const home = mkdtempSync(join(tmpdir(), "ops-kit-wait-"));
  try {
    const waitsDir = (h: string) => join(h, "waits");
    const env = { OPS_KIT_WAITS_DIR: waitsDir(home), OPS_KIT_TASK_ID: "task_abc" };
    const seen: WaitFile[] = [];
    const read = () => readdirSync(waitsDir(home)).filter((n) => n.endsWith(".json")).map((n) => WaitFile.parse(JSON.parse(readFileSync(join(waitsDir(home), n), "utf8"))));
    const ok = fake({ check: (n) => (n === 2 ? 0 : 1), env, during: () => seen.push(...read()) });
    await runWait(opts({ timeoutSec: 60 }), ok.deps);
    expect(seen).toEqual([{ taskId: "task_abc", pid: process.pid, label: "PR 12 のマージ", keys: [], startedAt: 1_000_000, timeoutAt: 1_060_000, stallSec: null, progressAt: 1_000_000, cut: null }]);
    expect(read()).toEqual([]);
    const cut = fake({ check: () => 1, env });
    await runWait(opts({ timeoutSec: 60 }), cut.deps);
    expect(read()).toEqual([{ ...seen[0]!, cut: { reason: "timeout", at: 1_060_000 } }]);
    rmSync(waitsDir(home), { recursive: true });
    // a cut the caller goes on from is no stop: nothing is left
    const went = fake({ check: () => 1, env });
    await runWait(opts({ timeoutSec: 60, onTimeout: "proceed" }), went.deps);
    expect(read()).toEqual([]);
    // outside a Task nothing is written
    const outside = fake({ check: () => 1, env: { OPS_KIT_WAITS_DIR: join(home, "other") } });
    await runWait(opts({ timeoutSec: 60 }), outside.deps);
    expect(existsSync(join(home, "other"))).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("--key names the other side of a wait: repeatable, recorded in the record file; a malformed key is a usage error; a record with no keys still reads", async () => {
  const base = ["--for", "x", "--timeout", "60", "--on-timeout", "fail"];
  expect(parseWaitArgs([...base, "--key", "pr#12", "--key", "issue#5", "--", "true"])?.keys).toEqual(["pr#12", "issue#5"]);
  expect(parseWaitArgs([...base, "--", "true"])?.keys).toEqual([]);
  expect(parseWaitArgs([...base, "--key", "pr#1", "--key", "pr#1", "--", "true"])?.keys).toEqual(["pr#1"]);
  for (const bad of ["PR12", "pr#", "pr#1x", "task#3", " pr#1", "pr#1\n"]) expect({ bad, parsed: parseWaitArgs([...base, "--key", bad, "--", "true"]) }).toEqual({ bad, parsed: null });
  expect(parseWaitArgs([...base, "--key"].concat(["--", "true"]))).toBeNull();
  const home = mkdtempSync(join(tmpdir(), "ops-kit-wait-key-"));
  try {
    const env = { OPS_KIT_WAITS_DIR: join(home, "waits"), OPS_KIT_TASK_ID: "task_k" };
    await runWait(opts({ timeoutSec: 60, keys: ["pr#12", "issue#5"] }), fake({ check: () => 1, env }).deps);
    const [name] = readdirSync(join(home, "waits"));
    expect(WaitFile.parse(JSON.parse(readFileSync(join(home, "waits", name!), "utf8"))).keys).toEqual(["pr#12", "issue#5"]);
    // the shape of a record with no keys (before the field existed) is still read, with none
    const old = { taskId: "t", pid: 1, label: "x", startedAt: 1, timeoutAt: 2, stallSec: null, progressAt: 1 };
    expect(WaitFile.parse(old)).toMatchObject({ keys: [], cut: null });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  const cwd = mkdtempSync(join(tmpdir(), "ops-kit-wait-key-cwd-"));
  try {
    const r = Bun.spawnSync(["bun", CLI, "wait", ...base, "--key", "PR12", "--", "true"], { cwd, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(2);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("ops-kit wait: runs from a directory outside any repository; a missing required argument is a usage error", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ops-kit-wait-cwd-"));
  try {
    const env = { ...process.env, OPS_KIT_TASK_ID: undefined, OPS_KIT_WAITS_DIR: undefined };
    const run = (...args: string[]) => Bun.spawnSync(["bun", CLI, "wait", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
    expect(run("--for", "ファイルができる", "--timeout", "5", "--on-timeout", "fail", "--interval", "1", "--", "true").exitCode).toBe(0);
    const cut = run("--for", "決して来ないもの", "--timeout", "1", "--on-timeout", "fail", "--interval", "1", "--", "false");
    expect(cut.exitCode).toBe(124);
    expect(cut.stderr.toString()).toContain("待ちが切れた（上限）: 決して来ないもの を 1 秒待った");
    expect(run("--for", "決して来ないもの", "--timeout", "1", "--on-timeout", "proceed", "--interval", "1", "--", "false").exitCode).toBe(0);
    for (const missing of [["--timeout", "5", "--on-timeout", "fail"], ["--for", "x", "--on-timeout", "fail"], ["--for", "x", "--timeout", "5"]]) {
      const r = run(...missing, "--", "true");
      expect(r.exitCode).toBe(2);
      expect(r.stderr.toString()).toContain("wait --for <何を待つか> --timeout <秒> --on-timeout <fail|proceed>");
    }
    // a check that hangs is cut with the wait
    const hung = run("--for", "固まる判定", "--timeout", "1", "--on-timeout", "fail", "--", "sleep", "30");
    expect(hung.exitCode).toBe(124);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the shared skills wait in no bare until / while loop: a wait has a limit and says what it is for", () => {
  const skills = join(import.meta.dir, "..", "skills");
  const LOOP = /(^|[;&|(]\s*)(until|while)\s/;
  const loops: string[] = [];
  for (const name of readdirSync(skills)) {
    readFileSync(join(skills, name, "SKILL.md"), "utf8")
      .split("\n")
      .forEach((line, i) => {
        // a loop that reads lines (`| while IFS= read`) is no wait
        if (LOOP.test(line.trim()) && !/while\s+(IFS=\S*\s+)?read\b/.test(line)) loops.push(`${name}/SKILL.md:${i + 1}: ${line.trim().slice(0, 80)}`);
      });
  }
  expect(loops).toEqual([]);
  // the check sees one
  expect(LOOP.test("until gh pr view 12 | grep -q CLEAN; do sleep 30; done")).toBe(true);
});
