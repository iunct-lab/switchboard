// test-reads: .github/workflows/ci.yml scripts/ci.ts scripts/recordings.ts
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ciExit, ciSteps } from "./ci";
import { withHeavySlot } from "../ops-kit/src/heavy";
import { RECORDS_HEADER } from "./perf-ratchet";
import { checkoutSteps, DURATION_STEP, groupScript, HOST_TESTS, hostOffload, OFFLOAD_GROUPS, parseGroup, placeSteps, recordBundle, existingPass, failLines, failureSummary, perfSteps, LOCAL_CI_RESULT, localCi, main, mainFork, markerSeconds, narrowPerfStep, narrowTestStep, notify, perfVerdict, readTarget, remoteRepo, reportResult, resultComment, resolveTarget, reusablePass, selectTests, SHARED_ENTRY, sh as realSh, stepEnv, stepSeconds, stepWithIdle, TargetError, testsOf, type Deps, type LocalCiResult } from "./local-ci";

const ciYml = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
const ciTs = await Bun.file(new URL("./ci.ts", import.meta.url)).text();
/** The head and base of a pass mark; undefined = not a pass. */
const passOf = (body: string) => {
  const m = LOCAL_CI_RESULT.exec(body);
  return m?.[1] === "pass" ? [m[2], m[3]] : undefined;
};
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BASE = "3333333333333333333333333333333333333333";
// local-ci's worktrees and failure logs: never the real ~/.cache (a failure removes that PR's earlier logs)
const CACHE = mkdtempSync(join(tmpdir(), "sb-local-ci-test-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

describe("local-ci", () => {
  test("the steps are what Actions runs: ci.yml's one run: step is scripts/ci.ts, expanded into its steps in order (#912)", async () => {
    expect([...ciYml.matchAll(/^\s+- (?:name: .*\n\s+)?run: (.*)$/gm)].map((m) => m[1])).toEqual(["bun scripts/ci.ts"]);
    expect(await checkoutSteps(join(import.meta.dir, ".."), { PATH: process.env.PATH ?? "" })).toEqual(ciSteps);
    const runs = ciSteps.map((s) => s.run.trim());
    expect(runs).toContain("bun test");
    expect(runs).toContain("bun run typecheck");
    expect(runs).toContain("bun run --cwd apps/web build");
    // the perf ratchet (#638) runs on the build, then bun test last (#2945)
    expect(runs.slice(-3)).toEqual(["bun scripts/perf-bench.ts --runs 5 --json perf-result.json", "bun scripts/perf-ratchet.ts check perf-result.json --base perf-base.json || { cat perf-result.json; exit 1; }", "bun test"]);
  });

  /**
   * `base`: what a step answers in the base's worktree (the one local-ci adds for main), by its script; unnamed steps pass.
   * `pullHead`: what refs/pull/<n>/head holds (none = the head the PR named last). `o.heads` / `o.bases`: what the PR names as its head and what the base
   * branch's tip is, one per read (the last repeats). `o.conflict`: the merge stops on a conflict; `o.mergeError`: it fails otherwise.
   */
  const deps = (failAt?: string, pullHead?: string, failOutput = "1 fail", base: Record<string, { code: number; output: string }> = {}, throwOnBase = false, o: { heads?: string[]; bases?: string[]; conflict?: boolean; mergeError?: boolean; noCiTs?: boolean; budget?: unknown; select?: string; loaded?: string } = {}) => {
    const next = (xs: string[]) => (xs.length > 1 ? xs.shift()! : xs[0]!);
    const heads = [...(o.heads ?? [SHA])];
    const bases = [...(o.bases ?? [BASE])];
    let fetched = "";
    let named = "";
    const calls: string[][] = [];
    const ran: string[] = [];
    const envs: Record<string, string>[] = [];
    const logged: string[] = [];
    const d: Deps = {
      sh: async (cmd) => {
        calls.push(cmd);
        if (cmd[0] === "env") return (cmd.includes("--loaded") ? o.loaded : o.select) ?? "";
        if (cmd.includes("merge-base")) return "f".repeat(40) + "\n";
        if (cmd[0] === "gh") return JSON.stringify({ headRefOid: (named = next(heads)), baseRefName: "main" });
        if (cmd.includes("fetch")) fetched = cmd.at(-1)!;
        if (cmd.includes("rev-parse")) return `${fetched.startsWith("+refs/heads/") ? next(bases) : (pullHead ?? named)}\n`;
        if (cmd.includes("merge") && (o.conflict || o.mergeError)) throw new Error(o.conflict ? "git -C merge failed: CONFLICT (content)" : "git -C merge failed: gpg failed to sign the data");
        if (cmd.includes("--diff-filter=U")) return o.conflict ? "a.ts\n" : "";
        if (cmd.includes("worktree") && cmd.includes("add")) {
          if (throwOnBase && cmd[cmd.indexOf("--detach") + 1]!.includes("-base.")) throw new Error("git worktree add failed: fatal: bad object");
          // the worktree gets the real ci.yml and scripts/ci.ts
          const dir = cmd[cmd.indexOf("--detach") + 1]!;
          await Bun.write(`${dir}/.github/workflows/ci.yml`, o.noCiTs ? ciYml.replace(SHARED_ENTRY, "make check") : ciYml);
          if (!o.noCiTs) await Bun.write(`${dir}/scripts/ci.ts`, ciTs);
          if (o.budget) await Bun.write(`${dir}/scripts/perf-budget.json`, JSON.stringify(o.budget));
          if (o.select !== undefined) await Bun.write(`${dir}/scripts/test-select.ts`, "");
        }
        return "";
      },
      step: async (script, cwd, env) => {
        ran.push(script.trim());
        envs.push(env);
        // the bench leaves its result in the worktree, as the real one does
        if (cwd.includes("-base.")) {
          const b = base[script.trim()] ?? { code: 0, output: "ok" };
          if (script.includes("perf-bench.ts") && b.code === 0) await Bun.write(join(cwd, "perf-result.json"), '{"runs":5,"base":true}');
          return b;
        }
        if (script.includes("perf-bench.ts") && script.trim() !== failAt) await Bun.write(join(cwd, "perf-result.json"), '{"runs":5}');
        if (failAt && script.trim() === failAt) return { code: 1, output: failOutput };
        // the check reads the bench's result, as the real one does: none after a failed bench
        if (script.includes("perf-ratchet.ts check") && !existsSync(join(cwd, "perf-result.json"))) return { code: 1, output: "ENOENT: no such file or directory, open 'perf-result.json'" };
        return { code: 0, output: "ok" };
      },
      log: (l) => void logged.push(l),
      slot: (_name, fn) => fn(),
    };
    return { d, calls, ran, envs, logged };
  };

  describe("the narrowed bun test (#3297)", () => {
    const opts = (select: string) => [undefined, undefined, "1 fail", {}, false, { select }] as const;
    const tests = (ran: string[]) => ran.filter((r) => r.startsWith("bun test") || r.startsWith('echo "no test'));

    test("a selection runs those files as exact paths; the step keeps its name and the seconds line", async () => {
      const { d, ran, calls } = deps(...opts("selected: 2\na.test.ts  a.ts → a.test.ts\nscripts/it's.test.ts  x"));
      const r = await localCi(42, "/repo", d, "example/development", CACHE);
      // the change since the fork from the default branch, not since the base branch: a stacked PR's base is the PR below
      expect(calls.find((c) => c.includes("diff") && c.includes("--no-renames"))!.at(-1)).toBe("f".repeat(40));
      expect(tests(ran)).toEqual(["bun test './a.test.ts' './scripts/it'\\''s.test.ts'"]);
      expect(r.selection).toMatchObject({ files: ["a.test.ts", "scripts/it's.test.ts"] });
      expect(r.seconds?.test).toBeNumber();
      expect(r.results.find((x) => x.run.startsWith("bun test"))!.name).toBe("bun test");
    });

    test("no test selected: an echo in its place, the step stays", async () => {
      const { d, ran } = deps(...opts("selected: 0"));
      await localCi(42, "/repo", d, "example/development", CACHE);
      expect(tests(ran)).toEqual(['echo "no test files selected"']);
    });

    test("a `full:` selection runs every test and keeps why", async () => {
      const { d, ran } = deps(...opts("full: bun.lock: 依存の定義や設定\na.test.ts  全テスト"));
      const r = await localCi(42, "/repo", d, "example/development", CACHE);
      expect(tests(ran)).toEqual(["bun test"]);
      expect(r.selection).toMatchObject({ files: null, reason: "bun.lock: 依存の定義や設定" });
    });

    test("`all` never asks the selection and runs every test", async () => {
      const { d, ran, calls } = deps(...opts("selected: 0"));
      const r = await localCi(42, "/repo", d, "example/development", CACHE, { all: true });
      expect(tests(ran)).toEqual(["bun test"]);
      expect(r.selection).toBeUndefined();
      expect(calls.some((c) => c[0] === "env")).toBe(false);
    });

    test("an output it cannot read, a failing tool or no tool: every test, with the reason", async () => {
      const dir = mkdtempSync(join(CACHE, "select-"));
      const ls = "a.test.ts\nb.ts\nweb/c.test.tsx\n";
      const logged: string[] = [];
      const fake = (tool: () => string): Pick<Deps, "sh" | "log"> => ({ sh: async (c) => (c[0] === "env" ? tool() : c.includes("ls-files") ? ls : "a.ts\0"), log: (l) => void logged.push(l) });
      const failed = { files: null, reason: "選択を実行できなかった（実行したホストのログを見る）" };
      const base = async () => BASE;
      expect(await selectTests(dir, base, {}, fake(() => ""))).toEqual({ files: null, total: 2, reason: "scripts/test-select.ts が無い", unjudged: true });
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts/test-select.ts"), "");
      expect(await selectTests(dir, base, {}, fake(() => "selected: 3\na.test.ts  x"))).toMatchObject(failed);
      expect(await selectTests(dir, base, {}, fake(() => { throw new Error("env -i PATH=/home/u/bin failed: x\ny"); }))).toMatchObject(failed);
      expect(await selectTests(dir, () => Promise.reject(new Error("no main")), {}, fake(() => "selected: 0"))).toMatchObject(failed);
      expect(logged).toEqual(["テストの選択に失敗: 出力を読めない: selected: 3", "テストの選択に失敗: env -i PATH=/home/u/bin failed: x\ny", "テストの選択に失敗: no main"]);
      expect(await selectTests(dir, base, {}, fake(() => `full: 依存を読めない: ${dir}/a.ts: x`))).toMatchObject({ reason: "依存を読めない: <checkout>/a.ts: x" });
      expect(await selectTests(dir, base, {}, fake(() => "selected: 1\na.test.ts  x"))).toEqual({ files: ["a.test.ts"], total: 2, reason: "変更 1 ファイルから選んだ" });
    });

    test("a stack: a file only the PR below touched reaches the selection, with a rename's both paths", async () => {
      const dir = mkdtempSync(join(CACHE, "stack-"));
      const git = (...a: string[]) => realSh(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
      await git("init", "-q", "-b", "main");
      await git("remote", "add", "origin", dir);
      writeFileSync(join(dir, "old.ts"), "0\n".repeat(40));
      await git("add", ".");
      await git("commit", "-qm", "main");
      await git("checkout", "-qb", "lower");
      writeFileSync(join(dir, "lower.ts"), "1\n");
      await git("mv", "old.ts", "new.ts");
      await git("add", ".");
      await git("commit", "-qm", "lower");
      await git("checkout", "-qb", "top");
      writeFileSync(join(dir, "top.ts"), "2\n");
      await git("add", ".");
      await git("commit", "-qm", "top");
      // what localCi does: the head merged into its base, here the branch below
      await git("checkout", "-q", "lower");
      await git("merge", "-q", "--no-ff", "--no-edit", "top");
      mkdirSync(join(dir, "scripts"));
      writeFileSync(join(dir, "scripts/test-select.ts"), "");
      let args: string[] = [];
      const sh: Deps["sh"] = async (c, cwd) => {
        if (c[0] === "gh") return "main\n";
        if (c[0] !== "env") return realSh(c, cwd);
        if (c.includes("--loaded")) return "loaded: run  x";
        args = c.slice(c.indexOf("scripts/test-select.ts") + 1);
        expect(cwd).toBe(dir);
        return "selected: 0";
      };
      await selectTests(dir, () => mainFork(dir, "o/r", sh), { PATH: "/p" }, { sh, log: () => undefined });
      expect(args.sort()).toEqual(["lower.ts", "new.ts", "old.ts", "top.ts"]);
    });

    test("narrowTestStep: another CI without bun test is an error, not a silent full run", () => {
      expect(() => narrowTestStep([{ name: "x", run: "make" }], ["a.test.ts"])).toThrow("`bun test`");
    });
  });

  describe("perf-bench's loaded only for a change that reaches it (#3635)", () => {
    const SKIP = "変更 1 ファイルのどれも scripts/perf-bench.ts に届かない";
    const opts = (loaded: string) => [undefined, undefined, "1 fail", {}, false, { select: "selected: 0", loaded }] as const;
    const bench = (ran: string[]) => ran.filter((r) => r.startsWith("bun scripts/perf-bench.ts"));

    test("skip: perf-bench gets --skip-loaded and the reason, and the comment says it was not measured", async () => {
      const { d, ran, calls } = deps(...opts(`loaded: skip  ${SKIP}`));
      const r = await localCi(42, "/repo", d, "example/development", CACHE);
      expect(calls.some((c) => c[0] === "env" && c.includes("scripts/test-select.ts") && c.includes("--loaded"))).toBe(true);
      expect(bench(ran)).toEqual([`bun scripts/perf-bench.ts --runs 5 --json perf-result.json --skip-loaded '${SKIP}'`]);
      expect(r.selection?.loaded).toEqual({ run: false, reason: SKIP });
      expect(r.results.find((x) => x.run.startsWith("bun scripts/perf-bench.ts"))!.name).toBe("bun scripts/perf-bench.ts --runs 5 --json perf-result.json");
      expect(resultComment(r)).toContain(`loaded（量と重なりの計測）: 測らなかった（${SKIP}）`);
    });

    test("run, `all`, or an answer it cannot read: perf-bench measures loaded as it is", async () => {
      for (const [o, all] of [[opts("loaded: run  packages/core/src/server.ts → scripts/perf-bench.ts"), false], [opts(`loaded: skip  ${SKIP}`), true], [opts("selected: 0"), false]] as const) {
        const { d, ran, logged } = deps(...o);
        const r = await localCi(42, "/repo", d, "example/development", CACHE, all ? { all: true } : undefined);
        expect(bench(ran)).toEqual(["bun scripts/perf-bench.ts --runs 5 --json perf-result.json"]);
        expect(resultComment(r)).not.toContain("測らなかった");
        if (o[5].loaded === "selected: 0") expect(logged).toContain("loaded の判定に失敗（測る）: 出力を読めない: selected: 0");
      }
    });

    test("narrowPerfStep quotes the reason and leaves a CI without perf-bench as it is", () => {
      expect(narrowPerfStep([{ name: "b", run: "bun scripts/perf-bench.ts --runs 5" }], "it's")).toEqual([{ name: "b", run: "bun scripts/perf-bench.ts --runs 5 --skip-loaded 'it'\\''s'" }]);
      expect(narrowPerfStep([{ name: "x", run: "make" }], "r")).toEqual([{ name: "x", run: "make" }]);
    });
  });

  test("every step green → ok with the head sha; the worktree is removed", async () => {
    const { d, calls, ran, envs } = deps();
    const r = await localCi(42, "/repo", d, "example/development", CACHE);
    expect(r).toMatchObject({ ok: true, sha: SHA });
    expect(ran).toEqual(ciSteps.map((s) => s.run.trim()));
    // what Actions' pull_request run tests: the latest head merged here into the base branch's latest tip (#913)
    expect(calls.filter((c) => c.includes("fetch")).map((c) => c.slice(1).join(" "))).toEqual(["-C /repo fetch -q origin +refs/heads/main:refs/local-ci/42/base", "-C /repo fetch -q origin +refs/pull/42/head:refs/local-ci/42/head"]);
    const add = calls.find((c) => c.includes("worktree") && c.includes("add"))!;
    expect(add.at(-1)).toBe(BASE);
    expect(calls.find((c) => c.includes("merge"))!.slice(-4)).toEqual(["-q", "--no-ff", "--no-edit", SHA]);
    expect(calls.find((c) => c.includes("merge"))![2]).toBe(add[add.indexOf("--detach") + 1]);
    expect(Object.keys(envs[0]!).sort()).toEqual(["CI", "HOME", "PATH", "TMPDIR", ...(process.env.SWITCHBOARD_FIXTURES === undefined ? [] : ["SWITCHBOARD_FIXTURES"])].sort());
    // TMPDIR is under the OS temp dir the `local` perf ceilings were measured with, not ~/.cache (#1056)
    expect(envs[0]!.TMPDIR).toStartWith(join(tmpdir(), "switchboard.local-ci-42-tmp."));
    expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(true);
    const body = resultComment(r);
    expect(passOf(body)).toEqual([SHA, BASE]);
  });

  test("step seconds in pass marker: a checkout without scripts/ci.ts (--repo) passes without the seconds, not with an error (#1886)", async () => {
    const { d } = deps(undefined, undefined, "1 fail", {}, false, { noCiTs: true });
    const r = await localCi(42, "/repo", d, "example/other", CACHE);
    expect(r.ok).toBe(true);
    expect(r.seconds).toBeUndefined();
    expect(markerSeconds(resultComment(r))).toBeUndefined();
  });

  test("step seconds in pass marker: the type check's and bun test's seconds on the line after the first, read back by markerSeconds (#1886)", async () => {
    const { d } = deps();
    const r = await localCi(42, "/repo", d, "example/development", CACHE);
    // the checkout has scripts/ci.ts: a pass carries the seconds of both steps
    expect(Object.keys(r.seconds!).sort()).toEqual(["test", "typecheck"]);
    const results = r.results.map((x) => (x.run.trim() === "bun run typecheck" ? { ...x, seconds: 51.23 } : x.run.trim() === "bun test" ? { ...x, seconds: 42.96 } : x));
    const timed = { ...r, results, seconds: stepSeconds(results) };
    expect(timed.seconds).toEqual({ typecheck: 51.2, test: 43 });
    const body = resultComment(timed);
    expect(passOf(body)).toEqual([SHA, BASE]);
    expect(body.split("\n")[1]).toBe('<!-- local-ci-seconds {"typecheck":51.2,"test":43} -->');
    expect(markerSeconds(body)).toEqual({ typecheck: 51.2, test: 43 });
    // a fail has none; a pass without seconds (--repo) has none
    expect(markerSeconds(resultComment({ ...timed, ok: false }))).toBeUndefined();
    expect(markerSeconds(resultComment({ ...timed, seconds: undefined }))).toBeUndefined();
    // this repository's CI without bun test: an error, not a pass without the seconds
    expect(() => stepSeconds(results.filter((x) => x.name !== "bun test"))).toThrow("`bun test`");
  });

  test("test duration ceiling: seconds over the checkout's `local` ceiling fail the run with an over: line, and it exits like a failed step (#1887)", async () => {
    const { d, logged } = deps(undefined, undefined, "1 fail", {}, false, { budget: { local: { durations: { typecheck: 60, test: -1 } } } });
    const r = await localCi(42, "/repo", d, "example/development", CACHE);
    expect(r.ok).toBe(false);
    expect(r.seconds).toBeUndefined();
    expect(ciExit(r.results)).toBe(1);
    const failed = r.results.at(-1)!;
    expect(failed.name).toBe(DURATION_STEP);
    expect(failed.fails![0]).toStartWith("over: durations.test = ");
    expect(failLines(failed.tail)).toEqual(failed.fails!);
    expect(logged).toContain(failed.fails![0]!);
    const body = resultComment(r);
    expect(passOf(body)).toBeUndefined();
    expect(body).toContain(`結果: \`${DURATION_STEP}\` が exit 1。\n`); // no log of its own to point to
    expect(body).toContain(`\n\`\`\`\n${failed.fails![0]}\n\`\`\``);
  });

  test("test duration ceiling: within the ceilings, or a budget without them, passes with the seconds (#1887)", async () => {
    for (const budget of [{ local: { durations: { typecheck: 60, test: 50 } } }, { local: {} }, { github: {} }]) {
      const r = await localCi(42, "/repo", deps(undefined, undefined, "1 fail", {}, false, { budget }).d, "example/development", CACHE);
      expect(r.ok).toBe(true);
      expect(r.seconds).toBeDefined();
    }
  });

  test("test duration ceiling: a narrowed run is not compared on bun test, a full fall-back and the type check are (#3297)", async () => {
    const run = (select: string, durations: object) => {
      const { d } = deps(undefined, undefined, "1 fail", {}, false, { budget: { local: { durations } }, select });
      const step: Deps["step"] = async (script, cwd, env) => {
        if (script.startsWith("bun test")) await Bun.sleep(300);
        return d.step(script, cwd, env);
      };
      return localCi(42, "/repo", { ...d, step }, "example/development", CACHE);
    };
    const narrowed = "selected: 1\na.test.ts  x";
    expect((await run(narrowed, { typecheck: 60, test: 0.1 })).ok).toBe(true);
    expect(await run(narrowed, { typecheck: -1, test: 50 })).toMatchObject({ ok: false, selection: { files: ["a.test.ts"] } });
    expect((await run("full: x", { typecheck: 60, test: 0.1 })).ok).toBe(false);
  });

  test("the comment says what bun test covered; the mark stays (#3297)", () => {
    const r: LocalCiResult = { sha: SHA, base: BASE, ok: true, seconds: { typecheck: 1, test: 2 }, results: [{ name: "bun test", run: "bun test", code: 0, seconds: 2, tail: "" }] };
    const narrowed = resultComment({ ...r, selection: { files: ["a.test.ts", "b.test.ts"], total: 200, reason: "x" } });
    const full = resultComment({ ...r, selection: { files: null, total: 200, reason: "bun.lock: 依存の定義や設定" } });
    const all = resultComment(r);
    expect(narrowed).toContain("テスト: 2 / 200 ファイル（影響範囲の選択）");
    expect(full).toContain("テスト: 全 200 ファイル（全テストに倒した: bun.lock: 依存の定義や設定）");
    expect(all).toContain("テスト: 全ファイル（--all）");
    expect(testsOf(narrowed)).toEqual({ ran: 2, total: 200 });
    expect(testsOf(full)).toEqual({ ran: null, total: 200 });
    expect(testsOf(all)).toBeUndefined();
    for (const body of [narrowed, full, all]) {
      expect(passOf(body)).toEqual([SHA, BASE]);
      expect(markerSeconds(body)).toEqual({ typecheck: 1, test: 2 });
    }
    expect(resultComment({ ...r, ok: false, conflict: true, results: [] })).not.toContain("テスト:");
    expect(resultComment({ ...r, selection: { files: null, total: 1, reason: "長".repeat(1000) } })).toContain(`${"長".repeat(300)}…）`);
  });

  test("refs/pull/<n>/head that is not the PR's head yet is an error, and nothing runs", async () => {
    const { d, ran } = deps(undefined, "2222222222222222222222222222222222222222");
    await expect(localCi(42, "/repo", d, "example/development", CACHE)).rejects.toThrow("refs/pull/42/head");
    expect(ran).toEqual([]);
  });

  test("a head that does not merge into the base: a conflict, nothing runs, the result says so and has no pass mark", async () => {
    const { d, ran, calls } = deps(undefined, SHA, "", {}, false, { conflict: true });
    const r = await localCi(42, "/repo", d, "example/development", CACHE);
    expect(r).toMatchObject({ ok: false, conflict: true, sha: SHA, base: BASE, results: [] });
    expect(ran).toEqual([]);
    expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(true);
    const body = resultComment(r);
    expect(body.split("\n")[0]).toBe(`[local-ci] fail ${SHA} base=${BASE}`);
    expect(body).toContain("衝突");
    expect(passOf(body)).toBeUndefined();
  });

  test("a merge that fails without a conflict (signing, a broken clone) is an error, not the PR's conflict", async () => {
    const { d, ran } = deps(undefined, SHA, "", {}, false, { mergeError: true });
    await expect(localCi(42, "/repo", d, "example/development", CACHE)).rejects.toThrow("gpg failed");
    expect(ran).toEqual([]);
  });

  /** A run, then notify with a fake post: what was posted. `o`: the reads of the PR's head and the base's tip, the run's first. */
  const runAndNotify = async (failAt: string | undefined, o: { heads?: string[]; bases?: string[] } = {}) => {
    // the (fail) line far above the last 30 lines, as in a long bun test run
    const { d, logged } = deps(failAt, undefined, ["(fail) a > b [1ms]", ...Array.from({ length: 100 }, (_, i) => `line ${i}`), "1 fail"].join("\n"), {}, false, o);
    const r = await localCi(42, "/repo", d, "example/development", CACHE);
    if (r.results.at(-1)?.log) rmSync(r.results.at(-1)!.log!.replace(/\/[^/]*$/, ""), { recursive: true, force: true });
    const posted: string[] = [];
    const sent = await notify({ pr: 42, repo: "example/development", root: "/repo" }, r, d, async (_t, body) => void posted.push(body));
    return { r, sent, posted, logged };
  };

  test("notify: all green → one pass mark naming head and base, with every step", async () => {
    const { sent, posted } = await runAndNotify(undefined);
    expect(sent).toBe(true);
    expect(posted).toHaveLength(1);
    expect(passOf(posted[0]!)).toEqual([SHA, BASE]);
    // the first line only (#3118): what merge-gate reads; the seconds line is hidden in GitHub's view
    expect(posted[0]!.split("\n")[1]).toStartWith("<!-- local-ci-seconds ");
    expect(posted[0]).toContain(`対象: head \`${SHA}\` を base \`${BASE}\` にマージ`);
    expect(posted[0]!.split("\n").filter((l) => l.startsWith("| `")).length).toBe(ciSteps.length);
  });

  test("notify: a failure is posted as a result without a pass mark, naming the step and its (fail) lines", async () => {
    const { sent, posted } = await runAndNotify("bun test");
    expect(sent).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.split("\n")[0]).toBe(`[local-ci] fail ${SHA} base=${BASE}`);
    expect(passOf(posted[0]!)).toBeUndefined();
    expect(posted[0]).toContain("結果: `bun test` が exit 1");
    // in a fenced block: 4 spaces after the paragraph line would join it (CommonMark)
    expect(posted[0]).toContain("が exit 1。全文は実行したホストの記録（~/.cache の下）。\n```\n(fail) a > b [1ms]\n```");
    // the log's path on this host stays off the PR
    expect(posted[0]).not.toContain(CACHE);
  });

  describe("main: the command's exit", () => {
    /** A clone of example/development (forgeTargetOf reads its origin), the fake deps answering the origin's URL. */
    const command = async (o: { conflict?: boolean }, post: (body: string) => Promise<void>) => {
      const root = mkdtempSync(join(CACHE, "main-root-"));
      Bun.spawnSync(["git", "init", "-q", root]);
      Bun.spawnSync(["git", "-C", root, "remote", "add", "origin", "https://github.com/example/development.git"]);
      const x = deps(undefined, SHA, "", {}, false, o);
      const fake = x.d.sh;
      x.d.sh = async (cmd, cwd) => (cmd.includes("get-url") ? "https://github.com/example/development.git\n" : fake(cmd, cwd));
      try {
        return await main(["42"], root, x.d, async (_t, body) => post(body), root, CACHE);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    test("main: posting fails → 1", async () => {
      expect(await command({}, () => Promise.reject(new Error("HTTP 403")))).toBe(1);
    });

    test("main: a conflict → 1 after posting the fail result", async () => {
      const posted: string[] = [];
      expect(await command({ conflict: true }, async (b) => void posted.push(b))).toBe(1);
      expect(posted).toHaveLength(1);
      expect(posted[0]!.split("\n")[0]).toBe(`[local-ci] fail ${SHA} base=${BASE}`);
      expect(posted[0]).toContain("衝突");
    });

    test("main: all green, posted → 0", async () => {
      expect(await command({}, async () => undefined)).toBe(0);
    });
  });

  test("resultComment: a fail line starting with a fence (failLines keeps any line with over:) gets a longer fence around it", () => {
    const line = "```ts over: x = 2 > ceiling 1";
    expect(failLines(`a\n${line}\nb`)).toEqual([line]);
    const r: LocalCiResult = { sha: SHA, base: BASE, ok: false, results: [{ name: "perf", run: "perf", code: 1, seconds: 1, tail: "", fails: [line] }] };
    expect(resultComment(r)).toContain(`\n\`\`\`\`\n${line}\n\`\`\`\`\n`);
  });

  test("readTarget reads the refs it fetched into, not FETCH_HEAD", async () => {
    const OTHER = "9".repeat(40);
    const refs: Record<string, string> = {};
    const calls: string[][] = [];
    const sh = async (c: string[]) => {
      calls.push(c);
      if (c[0] === "gh") return JSON.stringify({ headRefOid: SHA, baseRefName: "main" });
      if (c[3] === "fetch") {
        const [src, dst] = c.at(-1)!.replace(/^\+/, "").split(":");
        refs[dst!] = src === "refs/heads/main" ? BASE : SHA;
        // another local-ci in the same clone fetched in between
        refs.FETCH_HEAD = OTHER;
      }
      if (c[3] === "rev-parse") return `${refs[c[4]!] ?? "missing"}\n`;
      return "";
    };
    expect(await readTarget(42, CACHE, "example/development", { sh })).toEqual({ head: SHA, base: BASE });
    expect(calls.filter((c) => c[3] === "rev-parse").map((c) => c[4])).toEqual(["refs/local-ci/42/base", "refs/local-ci/42/head"]);
  });

  test("notify: the head or the base moved during the run → nothing posted (a pass for the old pair is not one for the new)", async () => {
    const NEW = "4444444444444444444444444444444444444444";
    for (const o of [{ heads: [SHA, NEW] }, { bases: [BASE, NEW] }]) {
      const { sent, posted, logged } = await runAndNotify(undefined, o);
      expect([sent, posted]).toEqual([false, []]);
      expect(logged.at(-1)).toContain("結果を投稿しない");
    }
  });

  test("LOCAL_CI_RESULT: pass or fail, the head, then the base; no base, a short sha or another word after it is no result", () => {
    expect(LOCAL_CI_RESULT.exec(`[local-ci] pass ${SHA} base=${BASE}\n\nx`)?.slice(1)).toEqual(["pass", SHA, BASE]);
    expect(LOCAL_CI_RESULT.exec(`[local-ci] fail ${SHA} base=${BASE}`)?.slice(1)).toEqual(["fail", SHA, BASE]);
    for (const body of [`[local-ci] pass ${SHA}`, `[local-ci] pass ${SHA.slice(0, 7)} base=${BASE}`, `[local-ci] pass ${SHA} base=${BASE.slice(0, 7)}`, `[local-ci] pass ${SHA}x base=${BASE}`, `[local-ci] pass ${SHA} base=${BASE}x`, `ok [local-ci] pass ${SHA} base=${BASE}`]) expect(LOCAL_CI_RESULT.test(body)).toBe(false);
  });

  test("stepEnv preserves only explicitly supplied recordings and excludes other SWITCHBOARD_* values", () => {
    const env = stepEnv("/home/x/.cache/t", { PATH: "/bin", SWITCHBOARD_FIXTURES: "/caller/recordings", SWITCHBOARD_SUPERVISED: "1", SWITCHBOARD_HOST: "0.0.0.0", TMPDIR: "/tmp" });
    expect(env).toEqual({ PATH: "/bin", HOME: expect.any(String), SWITCHBOARD_FIXTURES: "/caller/recordings", CI: "true", TMPDIR: "/home/x/.cache/t" });
  });

  test("stepEnv: missing recordings skip when unset and fail when explicitly supplied", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-ci-recordings."));
    try {
      const file = join(root, "replay.test.ts");
      await Bun.write(file, `import { test } from "bun:test";
import { skipRecordings, assertRecordings } from ${JSON.stringify(join(import.meta.dir, "recordings.ts"))};
const rel = "missing-1964/recording.jsonl";
test.skipIf(skipRecordings(rel))("replay", () => assertRecordings(rel));`);
      for (const explicit of [false, true]) {
        const env = stepEnv(root, { PATH: process.env.PATH, ...(explicit ? { SWITCHBOARD_FIXTURES: join(root, "empty") } : {}) });
        expect(env.SWITCHBOARD_FIXTURES).toBe(explicit ? join(root, "empty") : undefined);
        const p = Bun.spawn(["bun", "test", file], { env, stdout: "pipe", stderr: "pipe" });
        const [output, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
        expect(code).toBe(explicit ? 1 : 0);
        expect(output).toContain(explicit ? "1 fail" : "1 skip");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a failing step stops there and is not ok (nothing to post)", async () => {
    const { d, ran, calls } = deps("bun run typecheck");
    const r = await localCi(42, "/repo", d, "example/development", CACHE);
    expect(r.ok).toBe(false);
    expect(ran.at(-1)).toBe("bun run typecheck");
    expect(ran).not.toContain("bun run --cwd apps/web build");
    expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(true);
    rmSync(r.results.at(-1)!.log!.replace(/\/[^/]*$/, ""), { recursive: true, force: true });
  });

  test("a step with no output is cut, and the reason reaches fails and the comment", async () => {
    const { d } = deps();
    const r = await localCi(42, "/repo", { ...d, step: (script, cwd, env) => (script.trim() === "bun test" ? stepWithIdle(1)("sleep 600", tmpdir(), env) : d.step(script, cwd, env)) }, "example/development", CACHE);
    expect(r.ok).toBe(false);
    const failed = r.results.find((x) => x.code !== 0)!;
    expect(failed.code).toBe(124);
    expect(failed.fails).toEqual(["無進捗で打ち切り: 1 秒出力がなかった"]);
    const comment = resultComment(r);
    expect(comment.split("\n")[0]).toStartWith("[local-ci] fail ");
    expect(comment).toContain("\n```\n無進捗で打ち切り: 1 秒出力がなかった\n```");
    rmSync(failed.log!.slice(0, failed.log!.lastIndexOf("/")), { recursive: true, force: true });
  });

  test("a step that keeps printing past the threshold passes", async () => {
    const r = await stepWithIdle(2)("for i in 1 2 3 4 5; do echo $i; sleep 1; done", tmpdir(), stepEnv(tmpdir()));
    expect(r.code).toBe(0);
    expect(r.output.trim().split("\n")).toEqual(["1", "2", "3", "4", "5"]);
  }, 10_000);

  test("a step's output is stdout then stderr, so a stderr line is not caught inside a partial stdout line", async () => {
    const r = await stepWithIdle(5)("printf partial; echo '(fail) a' >&2; sleep 0.1; echo done", tmpdir(), stepEnv(tmpdir()));
    expect(failLines(r.output)).toEqual(["(fail) a"]);
  });

  test("a step still stops at its first failure (bash -e)", async () => {
    expect(await stepWithIdle(5)("false\necho after", tmpdir(), stepEnv(tmpdir()))).toEqual({ code: 1, output: "" });
  });

  test("a failing step: its full output is kept in a log under the cache dir, and the (fail) and over: lines are printed even when they are not in the last 30 lines", async () => {
    const output = ["(fail) a > b [5.00ms]", "over: launch.layoutShift 0.31 > 0.29", ...Array.from({ length: 100 }, (_, i) => `line ${i}`)].join("\n");
    const { d, logged } = deps("bun test", SHA, output);
    const r = await localCi(42, "/repo", d, "example/development", CACHE);
    const log = r.results.at(-1)!.log!;
    try {
      expect(log).toStartWith(join(CACHE, "switchboard.local-ci-example_development-42-log."));
      expect(log).toEndWith("-bun_test.log");
      expect(readFileSync(log, "utf8")).toBe(output);
      expect(logged.filter((l) => !l.startsWith("▶")).slice(0, 2)).toEqual(["(fail) a > b [5.00ms]", "over: launch.layoutShift 0.31 > 0.29"]);
      expect(logged).toContain(`全文: ${log}`);
      expect(logged.at(-1)).toBe("✗ bun test: exit 1");
      // a passing step keeps nothing
      expect(r.results.filter((x) => x.code === 0).every((x) => x.log === undefined)).toBe(true);
    } finally {
      rmSync(log.slice(0, log.lastIndexOf("/")), { recursive: true, force: true });
    }
    expect(existsSync(log)).toBe(false);
  });

  const CHECK = "bun scripts/perf-ratchet.ts check perf-result.json --base perf-base.json || { cat perf-result.json; exit 1; }";
  const BENCH = "bun scripts/perf-bench.ts --runs 5 --json perf-result.json";
  const JSON_DUMP = Array.from({ length: 60 }, (_, i) => `  "line${i}": ${i},`).join("\n");
  const perfRun = async (failAt: string, output: string, base: Record<string, { code: number; output: string }> = {}, throwOnBase = false) => {
    const { d, calls, logged, envs } = deps(failAt, SHA, output, base, throwOnBase);
    const r = await localCi(42, "/repo", d, "example/development", CACHE);
    const log = r.results.find((x) => x.code !== 0)!.log!;
    const dir = log.slice(0, log.lastIndexOf("/"));
    const summary = existsSync(join(dir, "summary.md")) ? readFileSync(join(dir, "summary.md"), "utf8") : "";
    const perfResult = existsSync(join(dir, "perf-result.json")) ? readFileSync(join(dir, "perf-result.json"), "utf8") : undefined;
    const baseResult = existsSync(join(dir, "perf-result.base.json")) ? readFileSync(join(dir, "perf-result.base.json"), "utf8") : undefined;
    const files = readdirSync(dir);
    const worktrees = (verb: string) => calls.filter((c) => c.includes("worktree") && c.includes(verb)).length;
    rmSync(dir, { recursive: true, force: true });
    // a failure posts nothing: the only gh call is reading the head
    expect(calls.filter((c) => c[0] === "gh").map((c) => c.slice(0, 4).join(" "))).toEqual(["gh pr view 42"]);
    expect(r.ok).toBe(false);
    return { r, summary, logged, perfResult, baseResult, files, calls, envs, adds: worktrees("add"), removes: worktrees("remove") };
  };

  test("perf over: the over line, head / base and the environment are in summary.md and on the console, even under a long JSON dump; perf-result.json is kept", async () => {
    const over = "over: journeys.launch.layoutShift = 0.3015 > ceiling 0.2371";
    const { r, summary, logged, perfResult } = await perfRun(CHECK, `ceilings: local\n${over}\n{\n${JSON_DUMP}\n}`);
    expect(r.perf).toEqual({ env: "local", over: [over], improved: [], raised: [], grew: [], unknown: false });
    expect(summary).toContain(`head ${SHA} / base ${BASE}`);
    expect(summary).toContain(`環境: ceilings local, TMPDIR ${join(tmpdir(), "switchboard.local-ci-42-tmp.")}`);
    expect(summary).toContain(", CI=true");
    expect(summary).toContain(`超過（over）:\n${over}`);
    expect(perfResult).toBe('{"runs":5}');
    expect(logged.join("\n")).toContain(over);
    expect(logged.some((l) => l.startsWith("記録: "))).toBe(true);
  });

  test("a GitLab project in a subgroup keeps its failure log too: every slash of its path goes (#892)", async () => {
    const { d } = deps("bun test", SHA, "(fail) x");
    const r = await localCi(42, "/repo", d, "group/sub/app", CACHE);
    const log = r.results.at(-1)!.log!;
    try {
      expect(log).toStartWith(join(CACHE, "switchboard.local-ci-group_sub_app-42-log."));
      expect(readFileSync(log, "utf8")).toBe("(fail) x");
    } finally {
      rmSync(log.replace(/\/[^/]*$/, ""), { recursive: true, force: true });
    }
  });

  test("a new failure of a PR replaces its earlier failure logs; another PR's and another repository's same number stay", async () => {
    const old = mkdtempSync(join(CACHE, "switchboard.local-ci-example_development-42-log."));
    const other = mkdtempSync(join(CACHE, "switchboard.local-ci-example_development-420-log."));
    const otherRepo = mkdtempSync(join(CACHE, "switchboard.local-ci-o_r-42-log."));
    try {
      const { r } = await perfRun(CHECK, "ceilings: local\nover: journeys.launch.layoutShift = 0.3 > ceiling 0.2371");
      expect(r.ok).toBe(false);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(other)).toBe(true);
      expect(existsSync(otherRepo)).toBe(true);
    } finally {
      rmSync(old, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("perf raised: a ceiling above main's is its own kind, not ok", async () => {
    const raised = "raised: local.bundle.js ceiling 195136 > main's 195128 (raising a ceiling is merged by hand)";
    const { r, summary } = await perfRun(CHECK, `ceilings: local\n${raised}\n{\n${JSON_DUMP}\n}`);
    expect(r.perf).toMatchObject({ raised: [raised], over: [], improved: [], unknown: false });
    expect(summary).toContain(`main より予算引上げ（raised）:\n${raised}`);
  });

  test("perf improved: a beaten ceiling is the request to lower it", async () => {
    const improved = "improved: journeys.launch.layoutShift = 0.1688 < ceiling 0.2371 − 2 × 0.03: lower it with `bun scripts/perf-ratchet.ts update perf-result.json --env local`";
    const { r, summary } = await perfRun(CHECK, `ceilings: local\n${improved}\n{\n${JSON_DUMP}\n}`);
    expect(r.perf).toMatchObject({ improved: [improved], unknown: false });
    expect(summary).toContain(`改善による予算更新要求（improved）:\n${improved}`);
  });

  test("perf 原因不明: a check that failed without a verdict line says so, with its last lines", async () => {
    const { r, summary } = await perfRun(CHECK, "ceilings: local\nerror: the result has no journeys.launch.layoutShift");
    expect(r.perf).toMatchObject({ unknown: true, over: [], improved: [], raised: [] });
    expect(summary).toContain("原因不明（判定の行が無い）:\nceilings: local\nerror: the result has no journeys.launch.layoutShift");
  });

  test("perf 原因不明: the bench failing is a failure with no verdict, named by the bench's error (not the check failing after it)", async () => {
    const { r, summary } = await perfRun(BENCH, "Error: Chrome not found");
    // the check keeps going after the bench and fails on the missing result: both fail, the bench is the cause
    expect(r.results.filter((x) => x.code !== 0).map((x) => x.run)).toEqual([BENCH, CHECK]);
    expect(summary).toContain(`手順 ${BENCH}: exit 1`);
    expect(summary).not.toContain("ENOENT");
    expect(r.perf).toEqual({ env: null, over: [], improved: [], raised: [], grew: [], unknown: true });
    expect(summary).toContain("環境: ceilings ?, TMPDIR ");
    expect(summary).toContain("原因不明（判定の行が無い）:\nError: Chrome not found");
  });

  test("perfSteps: the install, then the web build up to the perf check (not bun test after it)", () => {
    expect(perfSteps(ciSteps).map((s) => s.run.trim().split("\n")[0])).toEqual([
      "bun install --frozen-lockfile",
      "bun run --cwd apps/web build",
      'if [ "$(git rev-parse --is-shallow-repository)" = true ]; then depth=--depth=1; else depth=; fi',
      "if fc-list ':family=Noto Sans' | grep -q . && fc-list ':family=Noto Sans CJK JP' | grep -q .; then exit 0; fi",
      "bun scripts/perf-ratchet.ts base origin/main perf-base.json",
      BENCH,
      CHECK,
    ]);
    expect(() => perfSteps([{ name: "x", run: "bun test" }])).toThrow("perfSteps");
  });

  const OVER = "over: journeys.launch.layoutShift = 0.3015 > ceiling 0.2371";
  test("perf over and main over the same key: main でも超過, main measured in its own worktree the same way", async () => {
    const mainOver = "over: journeys.launch.layoutShift = 0.2943 > ceiling 0.2371";
    const { r, summary, baseResult, files, adds, removes, calls, envs } = await perfRun(CHECK, `ceilings: local\n${OVER}`, { [CHECK]: { code: 1, output: `ceilings: local\n${mainOver}` } });
    // main is checked out at the merge's first parent and measured in the PR's environment (TMPDIR too)
    expect(calls.filter((c) => c.includes("worktree") && c.includes("add")).at(-1)!.at(-1)).toBe(BASE);
    expect(new Set(envs.map((e) => JSON.stringify(e))).size).toBe(1);
    expect(r.baseline).toEqual({ sha: BASE, verdict: { env: "local", over: [mainOver], improved: [], raised: [], grew: [], unknown: false } });
    expect(summary).toContain(`main（${BASE.slice(0, 7)}）との比較:\njourneys.launch.layoutShift: main でも超過（PR の変更によらない）\nmain の over:\n${mainOver}`);
    expect(baseResult).toBe('{"runs":5,"base":true}');
    expect(files.filter((f) => f.startsWith("base-")).length).toBe(perfSteps(ciSteps).length);
    expect([adds, removes]).toEqual([2, 2]);
  });

  test("perf over and main within its ceilings: PR 固有の悪化", async () => {
    const { r, summary } = await perfRun(CHECK, `ceilings: local\n${OVER}`, { [CHECK]: { code: 0, output: "ceilings: local\nperf ratchet: ok" } });
    expect(r.baseline?.verdict).toMatchObject({ over: [], unknown: false });
    expect(summary).toContain("journeys.launch.layoutShift: PR 固有の悪化");
  });

  test("perf over and main's measure failing: main の計測に失敗（原因不明）", async () => {
    const { r, summary, adds, removes } = await perfRun(CHECK, `ceilings: local\n${OVER}`, { [BENCH]: { code: 1, output: "Error: Chrome not found" } });
    expect(r.baseline).toEqual({ sha: BASE, verdict: null });
    expect(summary).toContain(`main（${BASE.slice(0, 7)}）との比較:\nmain の計測に失敗（原因不明）`);
    expect([adds, removes]).toEqual([2, 2]);
  });

  test("perf over and main's worktree failing to start: the PR's summary is still written, main の計測に失敗（原因不明）", async () => {
    const { r, summary, logged } = await perfRun(CHECK, `ceilings: local\n${OVER}`, {}, true);
    expect(r.baseline).toEqual({ sha: BASE, verdict: null });
    expect(summary).toContain(`超過（over）:\n${OVER}`);
    expect(summary).toContain("main の計測に失敗（原因不明）");
    expect(logged.some((l) => l.startsWith("main の計測が止まった: git worktree add failed"))).toBe(true);
  });

  test("perf raised only: main is not measured", async () => {
    const { r, summary, adds } = await perfRun(CHECK, "ceilings: local\nraised: local.bundle.js ceiling 195136 > main's 195128 (raising a ceiling is merged by hand)");
    expect(r.baseline).toBeUndefined();
    expect(summary).not.toContain("との比較");
    expect(adds).toBe(1);
  });

  test("perf and bun test both failing: the comment names both steps with their raised: and (fail) lines (#2945)", async () => {
    const raised = "raised: local.journeys.launch.requests ceiling 14 > main's 13 (raising a ceiling is merged by hand)";
    const { d, ran, logged } = deps(CHECK, SHA, `ceilings: local\n${raised}\n{\n${JSON_DUMP}\n}`);
    const failing: Deps = { ...d, step: async (script, cwd, env) => (script.trim() === "bun test" ? (ran.push("bun test"), { code: 1, output: "(fail) a > b\n1 fail" }) : d.step(script, cwd, env)) };
    const r = await localCi(42, "/repo", failing, "example/development", CACHE);
    const failed = r.results.filter((x) => x.code !== 0);
    try {
      // the perf check failed before bun test, and bun test still ran
      expect(ran.indexOf(CHECK)).toBeLessThan(ran.indexOf("bun test"));
      expect(failed.map((x) => x.name)).toEqual(["bun scripts/perf-ratchet.ts check perf-result.json", "bun test"]);
      expect(r.ok).toBe(false);
      expect(ciExit(r.results)).toBe(1);
      expect(r.perf).toMatchObject({ raised: [raised], unknown: false });
      // one log dir with both steps' whole output and the perf summary
      expect(new Set(failed.map((x) => x.log!.slice(0, x.log!.lastIndexOf("/")))).size).toBe(1);
      expect(readFileSync(failed[1]!.log!, "utf8")).toBe("(fail) a > b\n1 fail");
      expect(logged).toContain("✗ bun test: exit 1");
      expect(logged).toContain("✗ bun scripts/perf-ratchet.ts check perf-result.json: exit 1");
      const body = resultComment(r);
      expect(body).toContain(`結果: \`bun scripts/perf-ratchet.ts check perf-result.json\` が exit 1。全文は実行したホストの記録（~/.cache の下）。\n\`\`\`\n${raised}\n\`\`\``);
      expect(body).toContain("結果: `bun test` が exit 1。全文は実行したホストの記録（~/.cache の下）。\n```\n(fail) a > b\n```");
      expect(body).toContain("| `bun scripts/perf-ratchet.ts check perf-result.json` | exit 1 |");
      expect(body).toContain("| `bun test` | exit 1 |");
    } finally {
      rmSync(failed[0]!.log!.replace(/\/[^/]*$/, ""), { recursive: true, force: true });
    }
  });

  test("bundle lines: a pass's comment has the bundle line; a grew fail's comment has the bundle line and the grew: line under its result", async () => {
    const small = "bundle: js 1005 B (main 1000 B, +5 B, +0.50%) / css 50 B (main 50 B, +0 B, +0.00%)";
    const header = "bundle（gzip、マージ後と main の先端の差）:";
    // a pass: the check's output is not kept as a failure, its bundle line still reaches the comment
    const { d } = deps();
    const passing: Deps = { ...d, step: async (script, cwd, env) => (script.trim() === CHECK ? { code: 0, output: `ceilings: local\n${small}\nperf ratchet: ok` } : d.step(script, cwd, env)) };
    const ok = await localCi(42, "/repo", passing, "example/development", CACHE);
    expect(ok.ok).toBe(true);
    expect(ok.bundle).toEqual([small]);
    expect(resultComment(ok)).toContain(`${header}\n    ${small}`);
    // a grew fail: the bundle line, and the grew: line under the check's result
    const big = "bundle: js 1011 B (main 1000 B, +11 B, +1.10%) / css 50 B (main 50 B, +0 B, +0.00%)";
    const grew = "grew: bundle.js +1.10% (1000 → 1011 B) ≥ 1%: merging is the user's call (docs/design/perf.md)";
    const { r, adds } = await perfRun(CHECK, `ceilings: local\n${big}\n${grew}\n{\n${JSON_DUMP}\n}`);
    expect(r.perf).toMatchObject({ grew: [grew], unknown: false });
    expect(r.bundle).toEqual([big, grew]);
    // grew alone does not measure main (it is measured by the check's own base already)
    expect(adds).toBe(1);
    const body = resultComment(r);
    expect(body).toContain(`${header}\n    ${big}\n    ${grew}`);
    expect(body).toContain(`結果: \`bun scripts/perf-ratchet.ts check perf-result.json\` が exit 1。全文は実行したホストの記録（~/.cache の下）。\n\`\`\`\n${grew}\n\`\`\``);
    // no check output, no bundle part; a conflict has none either
    expect(resultComment({ ...r, bundle: undefined })).not.toContain(header);
    expect(resultComment({ ...r, conflict: true })).not.toContain(header);
  });

  test("perfVerdict and failureSummary: kinds as printed; a step that is not perf keeps its tail", () => {
    expect(perfVerdict("ceilings: github\nover: a = 2 > ceiling 1\nperf ratchet: ok")).toEqual({ env: "github", over: ["over: a = 2 > ceiling 1"], improved: [], raised: [], grew: [], unknown: false });
    const grew = "grew: bundle.js +1.10% (1000 → 1011 B) ≥ 1%: merging is the user's call (docs/design/perf.md)";
    const p = perfVerdict(`ceilings: local\nbundle: js 1011 B (main 1000 B, +11 B, +1.10%) / css 50 B (main 50 B, +0 B, +0.00%)\n${grew}`);
    expect(p).toMatchObject({ grew: [grew], over: [], unknown: false });
    const check = { name: "check", run: "bun scripts/perf-ratchet.ts check perf-result.json", code: 1, seconds: 1, tail: grew };
    expect(failureSummary({ sha: "h", base: "b", step: check, env: {}, output: grew, perf: p })).toContain(`1% 以上の増加（grew）:\n${grew}`);
    const step = { name: "bun test", run: "bun test", code: 1, seconds: 1, tail: "(fail) x" };
    expect(failureSummary({ sha: "h", base: "b", step, env: {}, output: "(fail) x" })).toBe("head h / base b\n手順 bun test: exit 1\n(fail) x");
  });

  test("failLines: bun test's (fail) lines and perf-ratchet's over: / raised: / improved: lines, once each, in order", () => {
    expect(failLines("ok\n(fail) x > y\nnoise\n  over: launch.layoutShift 1 > 0\n(fail) x > y\n(pass) z")).toEqual(["(fail) x > y", "  over: launch.layoutShift 1 > 0"]);
    const raised = "raised: local.journeys.launch.requests ceiling 14 > main's 13 (raising a ceiling is merged by hand)";
    const improved = "improved: journeys.launch.layoutShift = 0.1 < ceiling 0.2 − 2 × 0.03: lower it";
    expect(failLines(`ceilings: local\n${raised}\n${improved}\n  "raised": 1,\nperf ratchet: x`)).toEqual([raised, improved]);
    const grew = "grew: bundle.css +2.00% (100 → 102 B) ≥ 1%: merging is the user's call (docs/design/perf.md)";
    expect(failLines(`bundle: js 1 B (main 1 B, +0 B, +0.00%) / css 102 B (main 100 B, +2 B, +2.00%)\n${grew}`)).toEqual([grew]);
    expect(failLines("all good")).toEqual([]);
  });

  test("localCi records main's bundle once, from its finally, pass or fail; a failed record changes nothing and the worktree still goes", async () => {
    for (const [failAt, recordFails] of [[undefined, false], ["bun test", false], [undefined, true]] as const) {
      const { d } = deps(failAt);
      const order: string[] = [];
      const logged: string[] = [];
      const recording: Deps = {
        ...d,
        log: (l) => void logged.push(l),
        // the CI's base step leaves perf-base.json in the PR's worktree
        step: async (script, cwd, env) => {
          if (!cwd.includes("-base.")) writeFileSync(join(cwd, "perf-base.json"), JSON.stringify({ sha: BASE, bundle: { js: 1000, css: 100 } }));
          return d.step(script, cwd, env);
        },
        sh: async (c, cwd) => {
          if (c[0] !== "gh" || c[1] !== "api") {
            if (c.includes("worktree") && c.includes("remove")) order.push("remove");
            return d.sh(c, cwd);
          }
          if (recordFails) throw new Error("gh api failed: gh: Server Error (HTTP 502)");
          if (c.includes("PUT")) return order.push("put"), "{}";
          if (c.some((a) => a.includes("/contents/"))) throw new Error("gh api failed: gh: Not Found (HTTP 404)");
          return "{}";
        },
      };
      const r = await localCi(42, "/repo", recording, "example/development", CACHE);
      expect(r.ok).toBe(failAt === undefined);
      expect(order).toEqual(recordFails ? ["remove"] : ["put", "remove"]);
      expect(logged.filter((l) => l.startsWith("bundle の記録"))).toEqual([recordFails ? "bundle の記録に失敗（結果は変えない）: gh api failed: gh: Server Error (HTTP 502)" : "bundle の記録: perf-records/bundle.tsv に 1 行足した"]);
      if (failAt) rmSync(r.results.find((x) => x.code !== 0)!.log!.replace(/\/[^/]*$/, ""), { recursive: true, force: true });
    }
  });

  test("--repo: gh -R, git -C and the clone are the given repository's", async () => {
    const { d, calls } = deps();
    const r = await localCi(42, "/other", d, "o/r", CACHE);
    expect(r.ok).toBe(true);
    const gh = calls.filter((c) => c[0] === "gh");
    expect(gh.length).toBeGreaterThan(0);
    for (const c of gh) expect(c[c.indexOf("-R") + 1]).toBe("o/r");
    const git = calls.filter((c) => c[0] === "git");
    expect(git.some((c) => c.join(" ") === "git -C /other fetch -q origin +refs/pull/42/head:refs/local-ci/42/head")).toBe(true);
    // the clone, or the worktree local-ci added from it (the merge)
    for (const c of git) expect(c[2] === "/other" || c[2]!.startsWith(CACHE)).toBe(true);
  });

  test("reuse pass for same head", async () => {
    const OTHER = "9999999999999999999999999999999999999999";
    const pass = (sha: string) => `[local-ci] pass ${sha} base=${BASE}\n`;
    const c = (body: string, createdAt: string, url = "https://x/7#issuecomment-1", authorAssociation = "MEMBER") => ({ body, createdAt, url, authorAssociation });
    const fake = (comments: unknown[]) => async (cmd: string[]) => JSON.stringify({ headRefOid: SHA, comments });
    const found = (comments: unknown[]) => {
      return existingPass(7, "o/r", fake(comments));
    };
    expect(await found([c(pass(SHA), "2026-11-01T00:00:00Z")])).toBe("https://x/7#issuecomment-1");
    // a run is due: another head, not the first line, no authority, none at all
    expect(await found([c(pass(OTHER), "2026-11-01T00:00:00Z")])).toBeUndefined();
    expect(await found([c(`note\n${pass(SHA)}`, "2026-11-01T00:00:00Z")])).toBeUndefined();
    expect(await found([c(pass(SHA), "2026-11-01T00:00:00Z", "u", "NONE")])).toBeUndefined();
    expect(await found([])).toBeUndefined();
    // as merge-gate counts it: the newest result rules; the first line alone is a pass (#3118)
    expect(await found([c(pass(SHA), "2026-11-01T00:00:00Z"), c(`[local-ci] fail ${SHA} base=${BASE}\n`, "2026-11-01T01:00:00Z")])).toBeUndefined();
    expect(await found([c(`[local-ci] fail ${SHA} base=${BASE}\n`, "2026-11-01T00:00:00Z"), c(pass(SHA), "2026-11-01T01:00:00Z", "new")])).toBe("new");
    expect(await found([c(`[local-ci] pass ${SHA} base=${BASE}\n`, "2026-11-01T00:00:00Z")])).toBe("https://x/7#issuecomment-1");
    // --force and --all run past a pass that would be reused; what cannot be read is a normal run
    const repo = { pr: 7, repo: "o/r", root: join(import.meta.dir, "..") };
    const reusable = fake([c(pass(SHA), "2026-11-01T00:00:00Z")]);
    expect(await reusablePass(repo, reusable)).toBe("https://x/7#issuecomment-1");
    expect(await reusablePass({ ...repo, force: true }, reusable)).toBeUndefined();
    expect(await reusablePass({ ...repo, all: true }, reusable)).toBeUndefined();
    expect(await reusablePass(repo, async () => { throw new Error("read"); })).toBeUndefined();
  });

  test("resolveTarget: default, --repo, and the TargetError cases", async () => {
    const run = (origin: string | null, toplevel: string | null = "/w/other") => {
      const calls: string[][] = [];
      const sh: Deps["sh"] = async (cmd) => {
        calls.push(cmd);
        if (cmd.includes("--show-toplevel")) {
          if (toplevel === null) throw new Error("not a git repository");
          return `${toplevel}\n`;
        }
        if (cmd.includes("get-url")) {
          if (origin === null) throw new Error("no such remote");
          return `${origin}\n`;
        }
        throw new Error(`unexpected ${cmd.join(" ")}`);
      };
      return { sh, calls };
    };
    // no --repo: the clone the script is in and its origin, wherever it runs from; no origin to read = exit 2
    const none = run("git@github.com:example/development.git");
    expect(await resolveTarget(["7"], "/w/other", "/meta", none.sh)).toEqual({ pr: 7, repo: "example/development", root: "/meta" });
    expect(none.calls).toEqual([["git", "-C", "/meta", "remote", "get-url", "origin"]]);
    expect(await resolveTarget(["--all", "7"], "/w/other", "/meta", none.sh)).toEqual({ pr: 7, repo: "example/development", root: "/meta", all: true });
    expect(await resolveTarget(["7", "--force"], "/w/other", "/meta", none.sh)).toEqual({ pr: 7, repo: "example/development", root: "/meta", force: true });
    // --repo: the working tree it runs in, whose origin is that repository (https or ssh, with or without .git)
    for (const url of ["https://github.com/o/r.git", "https://github.com/o/r", "git@github.com:o/r.git", "ssh://git@github.com/o/r.git"]) {
      const x = run(url);
      expect(await resolveTarget(["7", "--repo", "o/r"], "/w/other/sub", "/meta", x.sh)).toEqual({ pr: 7, repo: "o/r", root: "/w/other" });
      expect(x.calls[0]).toEqual(["git", "-C", "/w/other/sub", "rev-parse", "--show-toplevel"]);
      expect(x.calls[1]).toEqual(["git", "-C", "/w/other", "remote", "get-url", "origin"]);
    }
    const fails = async (args: string[], x: ReturnType<typeof run>, msg: string) => {
      const e = await resolveTarget(args, "/w/other", "/meta", x.sh).catch((err) => err);
      expect(e).toBeInstanceOf(TargetError);
      expect(e.message).toContain(msg);
    };
    await fails(["7"], run(null), "--repo <owner/name> を付ける");
    await fails(["7"], run("https://x-access-token:SECRET@example.com/o/r.git"), "読めない URL");
    await fails(["7", "--repo", "o/r"], run("https://github.com/example/development.git"), "example/development");
    await fails(["7", "--repo", "o/r"], run("https://github.com/o/r2.git"), "--repo o/r");
    await fails(["7", "--repo", "o/r"], run(null), "無し");
    await fails(["7", "--repo", "o/r"], run("https://github.com/o/r.git", null), "作業ツリーでない");
    await fails(["7", "--repo", "bad"], run("https://github.com/o/r.git"), "owner/name");
    await fails(["7", "--repo"], run("https://github.com/o/r.git"), "owner/name");
    await fails(["--repo", "o/r"], run("https://github.com/o/r.git"), "PR 番号");
    await fails(["7", "--repo=o/r"], run("https://github.com/o/r.git"), "知らない引数: --repo=o/r");
    await fails(["7", "--rep", "o/r"], run("https://github.com/o/r.git"), "知らない引数: --rep o/r");
    await fails(["7", "8"], run("https://github.com/o/r.git"), "知らない引数: 8");
    await fails(["--repo=o/r", "7"], run("https://github.com/o/r.git"), "知らない引数: --repo=o/r");
    // an origin that is not owner/name is not printed (it may carry a token)
    const e = await resolveTarget(["7", "--repo", "o/r"], "/w/other", "/meta", run("https://x-access-token:SECRET@example.com/o/r.git").sh).catch((err) => err);
    expect(e).toBeInstanceOf(TargetError);
    expect(e.message).not.toContain("SECRET");
    expect(remoteRepo("https://gitlab.com/o/r.git")).toBeUndefined();
    // a forge naming the app (#2488): no PR to run, whatever the origin
    const appTree = mkdtempSync(join(CACHE, "app-forge-"));
    writeFileSync(join(appTree, "ops.config.json"), JSON.stringify({ forge: { service: "app" } }));
    for (const args of [["7"], ["7", "--repo", "o/r"]]) {
      const x = await resolveTarget(args, appTree, appTree, run("https://github.com/o/r.git", appTree).sh).catch((err) => err);
      expect(x).toBeInstanceOf(TargetError);
      expect(x.message).toContain("--change <n> で回す");
    }
    // a forge that cannot be read is the target's error too (exit 2), not a crash
    writeFileSync(join(appTree, "ops.config.json"), "{");
    expect(await resolveTarget(["7", "--repo", "o/r"], appTree, appTree, run("https://github.com/o/r.git", appTree).sh).catch((err) => err)).toBeInstanceOf(TargetError);
  });
  describe("off the host: sb-offload (#2305)", () => {
    const REC = ["packages/core/src/core.test.ts", "packages/adapters/claude/src/parse.test.ts"];
    /** The fake deps with a fake offload: each build's script, size and when it started and ended; `answer` gives a group's code and log from its steps. */
    const withOffload = (answer?: (steps: string[], script: string) => { code: number; output: string } | undefined, o: Parameters<typeof deps>[5] = {}, failAt?: string) => {
      const x = deps(failAt, undefined, "1 fail", {}, false, o);
      const builds: Array<{ script: string; size: string; cwd: string; start: number; end: number }> = [];
      const fake = x.d.sh;
      x.d.sh = async (cmd, cwd) => (cmd.includes("grep") && cmd.includes("-l") ? `${REC.join("\n")}\n` : fake(cmd, cwd));
      x.d.offload = {
        bun: "1.4.4",
        codex: "0.166.0",
        run: async (script, cwd, size) => {
          const start = performance.now();
          await Bun.sleep(30);
          const names = [...script.matchAll(/^bash -e -c '(.*?)'; c=\$\?/gm)].map((m) => m[1]!.replaceAll(`'\\''`, "'"));
          const given = answer?.(names, script);
          builds.push({ script, size, cwd, start, end: performance.now() });
          if (given) return given;
          return { code: 0, output: names.flatMap((n, i) => [`sb-step: ${i} begin 100`, `ran ${n}`, "", `sb-step: ${i} exit 0 ${101 + i}`]).join("\n") };
        },
      };
      return { ...x, builds };
    };

    test("typecheck, licenses and bun test go to the builds, not to a step here; the rest stays here, the files that read recordings too", async () => {
      const { d, ran, builds } = withOffload();
      const r = await localCi(42, "/repo", d, "example/development", CACHE);
      expect(r.ok).toBe(true);
      const sent = builds.map((b) => [...b.script.matchAll(/^bash -e -c '(.*?)'; c=/gm)].map((m) => m[1]));
      expect(sent).toEqual([["bun run licenses:check", "bun run typecheck"], [`bun test --path-ignore-patterns='\\''${REC[0]}'\\'' --path-ignore-patterns='\\''${REC[1]}'\\''`]]);
      for (const moved of ["bun run licenses:check", "bun run typecheck", "bun test"]) expect(ran).not.toContain(moved);
      // git over the checkout, the install the web build needs, the web build and perf, main's fetch: here
      expect(ran).toContain(ciSteps[0]!.run.trim());
      expect(ran).toContain("bun run --cwd apps/web build");
      expect(ran.some((s) => s.includes("git fetch"))).toBe(true);
      expect(ran).toContain(`bun test './${REC[0]}' './${REC[1]}'`);
      // the results in the CI's order, with the host's recordings run after bun test
      expect(r.results.map((x) => x.name)).toEqual([...ciSteps.map((s) => s.name), HOST_TESTS]);
      expect(r.results.find((x) => x.name === "bun test")!.seconds).toBe(1);
      expect(resultComment(r)).toContain(`| \`${HOST_TESTS}\` | pass |`);
    });

    test("the two builds run at the same time, each with its size", async () => {
      const { d, builds } = withOffload();
      await localCi(42, "/repo", d, "example/development", CACHE);
      expect(builds.map((b) => b.size)).toEqual(OFFLOAD_GROUPS.map((g) => g.size));
      expect(builds.every((b) => b.size === "small")).toBe(true);
      const [a, b] = builds;
      expect(Math.max(a!.start, b!.start)).toBeLessThan(Math.min(a!.end, b!.end));
    });

    test("bun test failing off the host: the comment names it with its (fail) lines, a fail mark", async () => {
      const { d } = withOffload((names) => (names[0]!.startsWith("bun test") ? { code: 1, output: "sb-offload: sent the work tree\nsb-step: 0 begin 10\n(fail) a > b [1ms]\n1 fail\n\nsb-step: 0 exit 1 20\nsb-offload: exit 1" } : undefined));
      const r = await localCi(42, "/repo", d, "example/development", CACHE);
      expect(r.ok).toBe(false);
      const body = resultComment(r);
      expect(LOCAL_CI_RESULT.exec(body)?.[1]).toBe("fail");
      expect(body).toContain("結果: `bun test` が exit 1");
      expect(body).toContain("(fail) a > b [1ms]");
      expect(r.results.find((x) => x.name === "bun test")!.log).toStartWith(CACHE);
      // after the step that stopped the run, nothing is listed (as one run here would have stopped)
      expect(r.results.at(-1)!.name).toBe("bun test");
    });

    test("the scripts carry no token or recordings, and the real sb-offload runs without a GitHub token in its environment", async () => {
      const { d, builds, envs } = withOffload();
      const saved = { gh: process.env.GH_TOKEN, github: process.env.GITHUB_TOKEN, path: process.env.PATH };
      process.env.GH_TOKEN = "gho_offloadtesttoken";
      process.env.GITHUB_TOKEN = "ghs_offloadtesttoken";
      const bin = mkdtempSync(join(CACHE, "bin-"));
      try {
        await localCi(42, "/repo", d, "example/development", CACHE);
        for (const b of builds) {
          expect(b.script).not.toMatch(/GH_TOKEN|GITHUB_TOKEN|offloadtesttoken|SWITCHBOARD_FIXTURES/);
          // origin is the repository's URL with no credentials
          expect(b.script).toContain("git remote add origin 'https://github.com/example/development.git'");
        }
        expect(envs.every((e) => !("GH_TOKEN" in e) && !("GITHUB_TOKEN" in e))).toBe(true);
        writeFileSync(join(bin, "sb-offload"), '#!/bin/sh\nenv\necho "args: $*"\nexit 3\n', { mode: 0o755 });
        process.env.PATH = `${bin}:${saved.path}`;
        const real = hostOffload()!;
        expect(real.bun).toBe(Bun.version);
        const out = await real.run("echo x", bin, "small");
        expect(out.code).toBe(3);
        expect(out.output).toContain("args: --size small echo x");
        expect(out.output).not.toContain("offloadtesttoken");
      } finally {
        for (const [k, v] of [["GH_TOKEN", saved.gh], ["GITHUB_TOKEN", saved.github], ["PATH", saved.path]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    });

    test("without sb-offload every step runs here, as before", async () => {
      const saved = process.env.PATH;
      process.env.PATH = mkdtempSync(join(CACHE, "empty-path-"));
      try {
        expect(hostOffload()).toBeUndefined();
      } finally {
        process.env.PATH = saved;
      }
      const { d, ran } = deps();
      const r = await localCi(42, "/repo", d, "example/development", CACHE);
      expect(ran).toEqual(ciSteps.map((s) => s.run.trim()));
      expect(r.results.map((x) => x.name)).not.toContain(HOST_TESTS);
    });

    test("a build that timed out, was stopped or failed before its steps: a failure with the reason, never run again here", async () => {
      for (const [code, reason] of [[124, "時間切れ"], [130, "中断"], [1, "ビルドの失敗"]] as const) {
        const { d, ran } = withOffload((names) => (names[0]!.startsWith("bun test") ? { code, output: code === 124 ? "sb-step: 0 begin 10\n(pass) x\n" : "sb-offload: no free build in 15 minutes (2 run at a time)" } : undefined));
        const r = await localCi(42, "/repo", d, "example/development", CACHE);
        const t = r.results.find((x) => x.name === "bun test")!;
        expect(t.code).toBe(code);
        expect(t.fails).toContain(`sb-offload: exit ${code}（${reason}）`);
        const body = resultComment(r);
        expect(LOCAL_CI_RESULT.exec(body)?.[1]).toBe("fail");
        expect(body).toContain(`sb-offload: exit ${code}（${reason}）`);
        expect(ran.some((s) => s.startsWith("bun test --path"))).toBe(false);
      }
    });

    test("seconds off the host are not compared with the host's `local` ceilings", async () => {
      const budget = { local: { journeys: {}, durations: { typecheck: 0.5, test: 0.5 } } };
      const { d } = withOffload(undefined, { budget });
      const r = await localCi(42, "/repo", d, "example/development", CACHE);
      expect(r.ok).toBe(true);
      expect(r.seconds).toEqual({ typecheck: 2, test: 1 });
    });

    test("placeSteps: a narrowed selection is split between the build and here; a group the CI does not have is left out", () => {
      const steps = [{ name: "bun install --frozen-lockfile", run: "bun install --frozen-lockfile" }, { name: "bun test", run: "bun test" }];
      const p = placeSteps(steps, ["a.test.ts", REC[0]!], REC);
      expect(p.groups).toEqual([{ size: "small", steps: [{ name: "bun test", run: "bun test './a.test.ts'" }] }]);
      expect(p.host).toEqual([steps[0], { name: HOST_TESTS, run: `bun test './${REC[0]}'` }]);
      expect(p.order).toEqual(["bun install --frozen-lockfile", "bun test", HOST_TESTS]);
      expect(placeSteps(steps, ["a.test.ts"], REC).host[1]).toEqual({ name: HOST_TESTS, run: 'echo "no test files selected"' });
    });

    test("parseGroup: each step between its marks with its seconds; the steps after a failure are not listed; no mark at all is the setup's failure", () => {
      const s = [{ name: "a", run: "a" }, { name: "b", run: "b" }, { name: "c", run: "c" }];
      const log = "setup\nsb-step: 0 begin 10.5\nA\n\nsb-step: 0 exit 0 12\nsb-step: 1 begin 12\nB\n\nsb-step: 1 exit 2 15\nsb-offload: exit 2";
      expect(parseGroup(log, s, 2).map((r) => [r.name, r.code, r.seconds, r.output])).toEqual([["a", 0, 1.5, "A\n"], ["b", 2, 3, "B\n"]]);
      const setup = parseGroup("sb-setup: bun install が失敗\nsb-offload: exit 1", s, 1);
      expect(setup.map((r) => [r.name, r.code])).toEqual([["a", 1]]);
      expect(setup[0]!.output).toContain("sb-setup: bun install が失敗");
      // a build that ended 0 without the step's exit mark is no pass
      expect(parseGroup("sb-step: 0 begin 1\n", s, 0)[0]!.code).toBe(1);
      // every step marked a pass, but the build was stopped before it ended: no pass either
      const stopped = parseGroup("sb-step: 0 begin 1\nA\nsb-step: 0 exit 0 2\n", [s[0]!], 130);
      expect(stopped.map((r) => [r.name, r.code])).toEqual([["a", 130]]);
      expect(failLines(stopped[0]!.output)).toEqual(["sb-offload: exit 130（中断）"]);
    });

    test("recordings: with SWITCHBOARD_FIXTURES, only the steps here get it, the files that read recordings among them; no build's script holds it or its path", async () => {
      const saved = process.env.SWITCHBOARD_FIXTURES;
      const fixtures = mkdtempSync(join(CACHE, "fixtures-"));
      for (const given of [fixtures, undefined]) {
        if (given === undefined) delete process.env.SWITCHBOARD_FIXTURES;
        else process.env.SWITCHBOARD_FIXTURES = given;
        try {
          const { d, ran, envs, builds } = withOffload();
          await localCi(42, "/repo", d, "example/development", CACHE);
          const at = ran.indexOf(`bun test './${REC[0]}' './${REC[1]}'`);
          expect(at).toBeGreaterThanOrEqual(0);
          // the host's run of the recordings reads them when given, and skips them (as before) when not
          expect(envs[at]!.SWITCHBOARD_FIXTURES).toBe(given);
          for (const b of builds) {
            expect(b.script).not.toContain("SWITCHBOARD_FIXTURES");
            expect(b.script).not.toContain(fixtures);
          }
          // the real sb-offload's environment (what hostOffload starts it with) has neither
          const bin = mkdtempSync(join(CACHE, "bin-fixtures-"));
          writeFileSync(join(bin, "sb-offload"), "#!/bin/sh\nenv\n", { mode: 0o755 });
          const path = process.env.PATH;
          process.env.PATH = `${bin}:${path}`;
          try {
            const out = await hostOffload()!.run("x", bin, "small");
            expect(out.output).toContain("PATH=");
            expect(out.output).not.toContain("SWITCHBOARD_FIXTURES");
            expect(out.output).not.toContain(fixtures);
          } finally {
            process.env.PATH = path;
          }
        } finally {
          if (saved === undefined) delete process.env.SWITCHBOARD_FIXTURES;
          else process.env.SWITCHBOARD_FIXTURES = saved;
        }
      }
    });

    test("groupScript: git with PCRE, a tmpfs TMPDIR, not root, this host's Bun and Codex, each step between marks and stopping at a failure", () => {
      const script = groupScript([{ name: "x", run: "echo 'it'" }], { bun: "1.4.4", codex: "0.166.0", repo: "o/r" });
      for (const part of ["dnf reinstall -y -q git-core", "mount -t tmpfs", "su - sb -c", "bash -s 'bun-v1.4.4'", "npm i -g '@openai/codex@0.166.0'", "git remote add origin 'https://github.com/o/r.git'", "bun install --frozen-lockfile", `bash -e -c 'echo '\\''it'\\'''; c=$?`, '[ "$c" -eq 0 ] || exit "$c"']) expect(script).toContain(part);
      // a repository that is not owner/name (a local change's workspace) gets no origin
      expect(groupScript([], { bun: "1", repo: "ws_1" })).not.toContain("remote add");
    });
  });
});

test("recordBundle: appends one row per run to perf-records/bundle.tsv, creating the branch once; no perf-base.json writes nothing", async () => {
  const dir = mkdtempSync(join(CACHE, "record-"));
  // a fake GitHub: the branch, bundle.tsv with its blob sha, and every gh api call
  let branch = false;
  let file: { text: string; sha: string } | undefined;
  let conflictOnce = false;
  let tooBig = false;
  const calls: string[][] = [];
  const puts: Array<{ branch: string; sha?: string; text: string }> = [];
  const sh: Deps["sh"] = async (c) => {
    calls.push(c);
    const path = c.find((a) => a.startsWith("repos/"))!;
    if (path.endsWith("/git/ref/heads/perf-records")) {
      if (!branch) throw new Error("gh api repos/o/r/git/ref/heads/perf-records failed: gh: Not Found (HTTP 404)");
      return "{}";
    }
    if (path.endsWith("/git/blobs") || path.endsWith("/git/trees") || path.endsWith("/git/commits")) return "f".repeat(40);
    if (path.endsWith("/git/refs")) return void (branch = true), "{}";
    if (path.includes("/contents/bundle.tsv?ref=perf-records")) {
      if (!file) throw new Error("gh api repos/o/r/contents failed: gh: Not Found (HTTP 404)");
      return JSON.stringify({ sha: file.sha, encoding: tooBig ? "none" : "base64", content: tooBig ? "" : Buffer.from(file.text).toString("base64").replace(/(.{60})/g, "$1\n") });
    }
    if (c.includes("PUT")) {
      const body = JSON.parse(readFileSync(c[c.indexOf("--input") + 1]!, "utf8")) as { branch: string; sha?: string; content: string };
      const text = Buffer.from(body.content, "base64").toString("utf8");
      puts.push({ branch: body.branch, sha: body.sha, text });
      if (conflictOnce) {
        conflictOnce = false;
        file = { text: `${file!.text}2026-11-02T10:00:00.000Z\t1\t1\t${"c".repeat(40)}\n`, sha: "moved" };
        throw new Error("gh api -X PUT failed: gh: bundle.tsv does not match moved (HTTP 409)");
      }
      file = { text, sha: `sha${puts.length}` };
      return "{}";
    }
    throw new Error(`unexpected ${c.join(" ")}`);
  };
  try {
    expect(await recordBundle("o/r", dir, "2026-11-02T00:00:00.000Z", sh)).toBe("none");
    expect(calls).toEqual([]);
    const A = "a".repeat(40);
    writeFileSync(join(dir, "perf-base.json"), JSON.stringify({ sha: A, bundle: { js: 1000, css: 100 } }));
    expect(await recordBundle("o/r", dir, "2026-11-02T01:00:00.000Z", sh)).toBe("recorded");
    expect(calls.filter((c) => c.some((a) => a.endsWith("/git/refs"))).map((c) => c.slice(c.indexOf("-f"))).flat()).toEqual(["-f", "ref=refs/heads/perf-records", "-f", `sha=${"f".repeat(40)}`]);
    expect(puts[0]).toEqual({ branch: "perf-records", sha: undefined, text: `${RECORDS_HEADER}\n2026-11-02T01:00:00.000Z\t1000\t100\t${A}\n` });
    // the same main again: one more row, the branch is not made again, the PUT names the file's sha
    expect(await recordBundle("o/r", dir, "2026-11-02T02:00:00.000Z", sh)).toBe("recorded");
    expect(calls.filter((c) => c.some((a) => a.endsWith("/git/refs")))).toHaveLength(1);
    expect(puts[1]!.sha).toBe("sha1");
    expect(puts[1]!.text.split("\n").filter(Boolean)).toHaveLength(3);
    // a 409 (another run wrote first): read again and put once more on top of it
    conflictOnce = true;
    expect(await recordBundle("o/r", dir, "2026-11-02T03:00:00.000Z", sh)).toBe("recorded");
    expect(puts.at(-1)!.sha).toBe("moved");
    expect(file!.text.split("\n").filter(Boolean).map((l) => l.split("\t")[0])).toEqual(["measured_at", "2026-11-02T01:00:00.000Z", "2026-11-02T02:00:00.000Z", "2026-11-02T10:00:00.000Z", "2026-11-02T03:00:00.000Z"]);
    // the body goes by a file, not in the arguments
    expect(calls.filter((c) => c.includes("PUT")).every((c) => !c.some((a) => a.startsWith("content=")))).toBe(true);
    // over 1 MB the API leaves the content out: an error, and nothing is put (a put would replace every row)
    tooBig = true;
    const before = puts.length;
    await expect(recordBundle("o/r", dir, "2026-11-02T04:00:00.000Z", sh)).rejects.toThrow("1 MB");
    expect(puts.length).toBe(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the result is reported as the repository's forge verification (#920): GitHub's is the PR comment; another service is said, nothing posted", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-ci-forge-"));
  try {
    // a checkout of GitHub (one without a remote is the app's: the "local change" tests)
    Bun.spawnSync(["git", "init", "-q", root]);
    Bun.spawnSync(["git", "-C", root, "remote", "add", "origin", "https://github.com/example/app.git"]);
    const calls: string[][] = [];
    const run = async (cmd: string[]) => (calls.push(cmd), "");
    await reportResult({ pr: 7, repo: "example/app", root }, "[local-ci] pass abc", run);
    expect(calls).toEqual([["gh", "pr", "comment", "7", "-R", "example/app", "--body", "[local-ci] pass abc"]]);
    require("node:fs").writeFileSync(join(root, "ops.config.json"), JSON.stringify({ forge: { service: "gitea" } }));
    await expect(reportResult({ pr: 7, repo: "group/app", root }, "[local-ci] pass abc", run)).rejects.toThrow("サービス gitea には対応していません");
    expect(calls).toHaveLength(1);
    // GitLab's (#924): a note on the MR through glab, on the project its forge names (checked against the origin)
    Bun.spawnSync(["git", "-C", root, "remote", "set-url", "origin", "git@gitlab.example.com:group/app.git"]);
    require("node:fs").writeFileSync(join(root, "ops.config.json"), JSON.stringify({ forge: { service: "gitlab", host: "gitlab.example.com", project: "group/app" } }));
    const lab: string[][] = [];
    await reportResult({ pr: 7, repo: "ignored/here", root }, "[local-ci] pass abc", run, async (cmd) => (lab.push(cmd), "{}"));
    expect(lab).toEqual([["glab", "api", "--hostname", "gitlab.example.com", "-X", "POST", "-f", "body=[local-ci] pass abc", "projects/group%2Fapp/merge_requests/7/notes"]]);
    expect(calls).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a GitLab checkout runs on the MR (#892): its head from refs/merge-requests/<iid>/head, its target branch's tip, the project from the forge", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-ci-gitlab-"));
  try {
    Bun.spawnSync(["git", "init", "-q", root]);
    Bun.spawnSync(["git", "-C", root, "remote", "add", "origin", "https://gitlab.example.com/group/sub/app.git"]);
    require("node:fs").writeFileSync(join(root, "ops.config.json"), JSON.stringify({ forge: { service: "gitlab", host: "gitlab.example.com", project: "group/sub/app" } }));
    const fail = async (c: string[]): Promise<string> => {
      throw new Error(`not asked: ${c.join(" ")}`);
    };
    expect(await resolveTarget(["7"], root, root, fail)).toEqual({ pr: 7, repo: "group/sub/app", root });
    const HEAD = "1".repeat(40);
    const BASE = "2".repeat(40);
    const calls: string[][] = [];
    let last = "";
    const sh = async (c: string[]) => {
      calls.push(c);
      if (c[3] === "fetch") last = c[6]!;
      if (c[3] === "rev-parse") return `${last === "+refs/heads/main:refs/local-ci/7/base" ? BASE : last === "+refs/merge-requests/7/head:refs/local-ci/7/head" ? HEAD : "x"}\n`;
      if (c[0] === "gh") throw new Error("gh is not asked for a GitLab MR");
      return "";
    };
    const glab = async (c: string[]) => (calls.push(c), JSON.stringify({ iid: 7, web_url: "u", state: "opened", source_branch: "b", target_branch: "main", sha: HEAD }));
    expect(await readTarget(7, root, "group/sub/app", { sh }, glab)).toEqual({ head: HEAD, base: BASE });
    expect(calls.map((c) => c.at(-1))).toEqual(["projects/group%2Fsub%2Fapp/merge_requests/7", "+refs/heads/main:refs/local-ci/7/base", "refs/local-ci/7/base", "+refs/merge-requests/7/head:refs/local-ci/7/head", "refs/local-ci/7/head"]);
    const moved = async (c: string[]) => JSON.stringify({ iid: 7, web_url: "u", state: "opened", source_branch: "b", target_branch: "main", sha: "3".repeat(40) });
    await expect(readTarget(7, root, "group/sub/app", { sh }, moved)).rejects.toThrow("refs/merge-requests/7/head は 1111111 で");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a result holding an account id of the host's AWS config, written bare, is not posted (#2346)", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-ci-aws-"));
  const id = ["8642", "9753", "1086"].join("");
  require("node:fs").writeFileSync(join(root, "aws-config"), `[profile x-admin]\nsso_account_id = ${id}\n`);
  const saved = process.env.AWS_CONFIG_FILE;
  process.env.AWS_CONFIG_FILE = join(root, "aws-config");
  try {
    const calls: string[][] = [];
    const run = async (cmd: string[]) => (calls.push(cmd), "");
    const refused = reportResult({ pr: 7, repo: "example/app", root }, `[local-ci] fail\nメモ ${id}`, run);
    await expect(refused).rejects.toThrow("account-id");
    await expect(refused).rejects.not.toThrow(id);
    expect(calls).toEqual([]);
  } finally {
    if (saved === undefined) delete process.env.AWS_CONFIG_FILE;
    else process.env.AWS_CONFIG_FILE = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("two local-ci runs do not overlap: each takes one heavy slot for its whole run", async () => {
  const home = mkdtempSync(join(CACHE, "home-"));
  type Span = { run: string; start: number; end: number };
  const spans: Span[] = [];
  const names: string[] = [];
  const run = (label: string): Deps => ({
    sh: async (cmd) => {
      if (cmd[0] === "gh" && cmd.at(-1) === "headRefOid") return JSON.stringify({ headRefOid: SHA });
      if (cmd[0] === "gh") return JSON.stringify({ headRefOid: SHA, baseRefName: "main" });
      if (cmd.includes("rev-parse")) return `${cmd.at(-1)!.endsWith("/base") ? BASE : SHA}\n`;
      if (cmd.includes("worktree") && cmd.includes("add")) {
        const dir = cmd[cmd.indexOf("--detach") + 1]!;
        await Bun.write(`${dir}/.github/workflows/ci.yml`, ciYml.replace(SHARED_ENTRY, "make check")); // one step, no scripts/ci.ts
      }
      return "";
    },
    step: async () => {
      const span = { run: label, start: performance.now(), end: 0 };
      await Bun.sleep(50);
      span.end = performance.now();
      spans.push(span);
      return { code: 0, output: "ok" };
    },
    log: () => undefined,
    slot: (name, fn) => {
      names.push(name);
      return withHeavySlot(name, fn, { home, mem: () => undefined, pollMs: 10, log: () => undefined });
    },
  });
  const [a, b] = await Promise.all([localCi(42, "/repo", run("a"), "example/development", CACHE, { all: true }), localCi(43, "/repo", run("b"), "example/other", CACHE, { all: true })]);
  expect(a.ok && b.ok).toBe(true);
  expect(names.sort()).toEqual(["local-ci example/development#42", "local-ci example/other#43"]);
  const of = (r: string) => spans.filter((s) => s.run === r);
  expect(of("a").length).toBeGreaterThan(0);
  expect(of("b").length).toBeGreaterThan(0);
  const [first, second] = of("a")[0]!.start < of("b")[0]!.start ? [of("a"), of("b")] : [of("b"), of("a")];
  expect(Math.max(...first.map((s) => s.end))).toBeLessThanOrEqual(Math.min(...second.map((s) => s.start)));
});

describe("local change (#2488)", () => {
  const BACKLOG = "http://app/api/backlog";
  /** A repository with no remote: main with a ci.yml whose one step is `run`, and sb/5-x one commit ahead. */
  function repo(run: string) {
    const dir = mkdtempSync(join(tmpdir(), "local-ci-change-"));
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false", ...a]).stdout.toString().trim();
    git("init", "-q", "-b", "main");
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/ci.yml"), `jobs:\n  check:\n    steps:\n      - run: ${run}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "ci");
    git("checkout", "-q", "-b", "sb/5-x");
    writeFileSync(join(dir, "b.txt"), "b\n");
    git("add", "-A");
    git("commit", "-q", "-m", "b");
    git("checkout", "-q", "main");
    return { dir, git, tip: (b: string) => git("rev-parse", b) };
  }
  /** The app: change #7 of `r`'s branches, its comments, and the comments posted. `onRead` runs at each read of the change. */
  function app(r: ReturnType<typeof repo>, comments: { body: string; createdAt: string }[] = [], onRead = () => {}) {
    const posted: unknown[] = [];
    const fetch = async (url: string, init: RequestInit = {}) => {
      const path = url.replace(BACKLOG, "");
      if (path === "") return new Response(JSON.stringify({ syncs: [{ workspaceId: "ws_l", backlog: "switchboard", repository: "ws_l", syncedAt: 1, syncing: false, sync: { state: "synced", reason: null, pendingCount: 0 } }], items: [] }));
      if (path === "/7/comment") return posted.push(JSON.parse(String(init.body))), new Response("{}", { status: 202 });
      onRead();
      return new Response(JSON.stringify({ workspaceId: "ws_l", issue: { number: 7, title: "変更", state: "OPEN", labels: [], milestone: null, parent: null, subIssues: [], body: "", url: "", change: { head: "sb/5-x", base: "main", mergeCommit: null, mergedAt: null } }, changeRefs: { head: r.tip("sb/5-x"), base: r.tip("main") }, comments: comments.map((c, i) => ({ id: `sb:${i}`, ...c })), fields: null, fetchedAt: 1, localId: null, pending: 0, held: [], sync: { state: "synced", reason: null, lastSuccessfulSync: 1 } }));
    };
    return { fetch, posted };
  }
  const env = { BACKLOG_URL: BACKLOG, BACKLOG_WORKSPACE: "ws_l" };
  async function run(r: ReturnType<typeof repo>, a: ReturnType<typeof app>, args: string[] = []) {
    const gh: string[][] = [];
    const logs: string[] = [];
    const d: Deps = {
      sh: async (cmd, cwd) => {
        if (cmd[0] === "gh") gh.push(cmd);
        return realSh(cmd, cwd);
      },
      step: stepWithIdle(60),
      log: (l) => logs.push(l),
      slot: (_name, fn) => fn(),
    };
    const code = await main(["--change", "7", ...args], r.dir, d, async () => { throw new Error("reportResult called"); }, r.dir, CACHE, { env, fetch: a.fetch });
    expect(gh).toEqual([]);
    return { code, logs };
  }
  const dirs: string[] = [];
  afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
  const fresh = (step: string) => {
    const r = repo(step);
    dirs.push(r.dir);
    return r;
  };

  test("pass: head merged into the base's tip, the pass mark of both goes on the change; again is not run", async () => {
    const r = fresh("test -f b.txt");
    const a = app(r);
    expect((await run(r, a)).code).toBe(0);
    expect(a.posted).toHaveLength(1);
    const posted = a.posted[0] as { workspaceId: string; text: string };
    expect(posted.workspaceId).toBe("ws_l");
    expect(passOf(posted.text)).toEqual([r.tip("sb/5-x"), r.tip("main")]);
    // the run's worktree is gone after it
    expect(readdirSync(CACHE).filter((f) => f.startsWith("switchboard.local-ci-change-ws_l-7."))).toEqual([]);
    const again = app(r, [{ body: posted.text, createdAt: new Date().toISOString() }]);
    const second = await run(r, again);
    expect([second.code, again.posted.length]).toEqual([0, 0]);
    expect(second.logs.join("\n")).toContain("既に pass");
    // --force runs it again and posts
    const forced = app(r, [{ body: posted.text, createdAt: new Date().toISOString() }]);
    expect([(await run(r, forced, ["--force"])).code, forced.posted.length]).toEqual([0, 1]);
  });

  test("fail: the fail mark goes on the change, exit 1; its log dir is the change's", async () => {
    const r = fresh("exit 1");
    const a = app(r);
    expect((await run(r, a)).code).toBe(1);
    const text = (a.posted[0] as { text: string }).text;
    expect(LOCAL_CI_RESULT.exec(text)?.slice(1)).toEqual(["fail", r.tip("sb/5-x"), r.tip("main")]);
    expect(readdirSync(CACHE).some((f) => f.startsWith("switchboard.local-ci-change-ws_l-7-log."))).toBe(true);
  });

  test("a branch that moved during the run: nothing posted, exit 1", async () => {
    const r = fresh("echo ok");
    let reads = 0;
    const a = app(r, [], () => {
      // the first read is the target's, the second the run's own; the third (after the run) sees a new base
      if (++reads === 3) {
        writeFileSync(join(r.dir, "z.txt"), "z\n");
        r.git("add", "-A");
        r.git("commit", "-q", "-m", "z");
      }
    });
    const res = await run(r, a);
    expect([res.code, a.posted.length]).toEqual([1, 0]);
    expect(res.logs.join("\n")).toContain("実行中に変わった");
  });

  test("not run (2): a PR number or --repo with it; not a change", async () => {
    const r = fresh("echo ok");
    for (const extra of [["12"], ["--repo", "a/b"]]) expect((await run(r, app(r), extra)).code).toBe(2);
    // a checkout with an origin keeps its PRs on its service: nothing is run or posted on a PR of that number
    r.git("remote", "add", "origin", "https://github.com/example/app.git");
    const a = app(r);
    expect([(await run(r, a)).code, a.posted.length]).toEqual([2, 0]);
  });
});
