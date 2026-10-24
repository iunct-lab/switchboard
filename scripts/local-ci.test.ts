import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { ciSteps } from "./ci";
import { checkoutSteps, failLines, failureSummary, perfSteps, LOCAL_CI_RESULT, localCi, notify, perfVerdict, remoteRepo, reportResult, resultComment, resolveTarget, stepEnv, TargetError, type Deps } from "./local-ci";

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
    // the perf ratchet (#638) runs on the build, last
    expect(runs.slice(-2)).toEqual(["bun scripts/perf-bench.ts --runs 5 --json perf-result.json", "bun scripts/perf-ratchet.ts check perf-result.json || { cat perf-result.json; exit 1; }"]);
  });

  /**
   * `base`: what a step answers in the base's worktree (the one local-ci adds for main), by its script; unnamed steps pass.
   * `pullHead`: what refs/pull/<n>/head holds (none = the head the PR named last). `o.heads` / `o.bases`: what the PR names as its head and what the base
   * branch's tip is, one per read (the last repeats). `o.conflict`: the merge stops on a conflict; `o.mergeError`: it fails otherwise.
   */
  const deps = (failAt?: string, pullHead?: string, failOutput = "1 fail", base: Record<string, { code: number; output: string }> = {}, throwOnBase = false, o: { heads?: string[]; bases?: string[]; conflict?: boolean; mergeError?: boolean } = {}) => {
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
        if (cmd[0] === "gh") return JSON.stringify({ headRefOid: (named = next(heads)), baseRefName: "main" });
        if (cmd.includes("fetch")) fetched = cmd.at(-1)!;
        if (cmd.includes("rev-parse")) return `${fetched.startsWith("refs/heads/") ? next(bases) : (pullHead ?? named)}\n`;
        if (cmd.includes("merge") && (o.conflict || o.mergeError)) throw new Error(o.conflict ? "git -C merge failed: CONFLICT (content)" : "git -C merge failed: gpg failed to sign the data");
        if (cmd.includes("--diff-filter=U")) return o.conflict ? "a.ts\n" : "";
        if (cmd.includes("worktree") && cmd.includes("add")) {
          if (throwOnBase && cmd[cmd.indexOf("--detach") + 1]!.includes("-base.")) throw new Error("git worktree add failed: fatal: bad object");
          // the worktree gets the real ci.yml and scripts/ci.ts
          const dir = cmd[cmd.indexOf("--detach") + 1]!;
          await Bun.write(`${dir}/.github/workflows/ci.yml`, ciYml);
          await Bun.write(`${dir}/scripts/ci.ts`, ciTs);
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
        return failAt && script.trim() === failAt ? { code: 1, output: failOutput } : { code: 0, output: "ok" };
      },
      log: (l) => void logged.push(l),
    };
    return { d, calls, ran, envs, logged };
  };

  test("every step green → ok with the head sha; the worktree is removed", async () => {
    const { d, calls, ran, envs } = deps();
    const r = await localCi(42, "/repo", d, "example/development", CACHE);
    expect(r).toMatchObject({ ok: true, sha: SHA });
    expect(ran).toEqual(ciSteps.map((s) => s.run.trim()));
    // what Actions' pull_request run tests: the latest head merged here into the base branch's latest tip (#913)
    expect(calls.filter((c) => c.includes("fetch")).map((c) => c.slice(1).join(" "))).toEqual(["-C /repo fetch -q origin refs/heads/main", "-C /repo fetch -q origin refs/pull/42/head"]);
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
    expect(posted[0]).toContain("(fail) a > b");
    // the log's path on this host stays off the PR
    expect(posted[0]).not.toContain(CACHE);
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
    const { d, ran, calls } = deps("bun test");
    const r = await localCi(42, "/repo", d, "example/development", CACHE);
    expect(r.ok).toBe(false);
    expect(ran.at(-1)).toBe("bun test");
    expect(ran).not.toContain("bun run --cwd apps/web build");
    expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(true);
    rmSync(r.results.at(-1)!.log!.replace(/\/[^/]*$/, ""), { recursive: true, force: true });
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

  const CHECK = "bun scripts/perf-ratchet.ts check perf-result.json || { cat perf-result.json; exit 1; }";
  const BENCH = "bun scripts/perf-bench.ts --runs 5 --json perf-result.json";
  const JSON_DUMP = Array.from({ length: 60 }, (_, i) => `  "line${i}": ${i},`).join("\n");
  const perfRun = async (failAt: string, output: string, base: Record<string, { code: number; output: string }> = {}, throwOnBase = false) => {
    const { d, calls, logged, envs } = deps(failAt, SHA, output, base, throwOnBase);
    const r = await localCi(42, "/repo", d, "example/development", CACHE);
    const log = r.results.at(-1)!.log!;
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
    expect(r.perf).toEqual({ env: "local", over: [over], improved: [], raised: [], unknown: false });
    expect(summary).toContain(`head ${SHA} / base ${BASE}`);
    expect(summary).toContain(`環境: ceilings local, TMPDIR ${join(tmpdir(), "switchboard.local-ci-42-tmp.")}`);
    expect(summary).toContain(", CI=true");
    expect(summary).toContain(`超過（over）:\n${over}`);
    expect(perfResult).toBe('{"runs":5}');
    expect(logged.join("\n")).toContain(over);
    expect(logged.some((l) => l.startsWith("記録: "))).toBe(true);
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

  test("perf 原因不明: the bench failing is a failure with no verdict", async () => {
    const { r, summary } = await perfRun(BENCH, "Error: Chrome not found");
    expect(r.perf).toEqual({ env: null, over: [], improved: [], raised: [], unknown: true });
    expect(summary).toContain("環境: ceilings ?, TMPDIR ");
    expect(summary).toContain("原因不明（判定の行が無い）:\nError: Chrome not found");
  });

  test("perfSteps: the install, then the web build and every step after it", () => {
    expect(perfSteps(ciSteps).map((s) => s.run.trim().split("\n")[0])).toEqual([
      "bun install --frozen-lockfile",
      "bun run --cwd apps/web build",
      'if [ "$(git rev-parse --is-shallow-repository)" = true ]; then depth=--depth=1; else depth=; fi',
      "if fc-list ':family=Noto Sans' | grep -q . && fc-list ':family=Noto Sans CJK JP' | grep -q .; then exit 0; fi",
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
    expect(r.baseline).toEqual({ sha: BASE, verdict: { env: "local", over: [mainOver], improved: [], raised: [], unknown: false } });
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

  test("perfVerdict and failureSummary: kinds as printed; a step that is not perf keeps its tail", () => {
    expect(perfVerdict("ceilings: github\nover: a = 2 > ceiling 1\nperf ratchet: ok")).toEqual({ env: "github", over: ["over: a = 2 > ceiling 1"], improved: [], raised: [], unknown: false });
    const step = { name: "bun test", run: "bun test", code: 1, seconds: 1, tail: "(fail) x" };
    expect(failureSummary({ sha: "h", base: "b", step, env: {}, output: "(fail) x" })).toBe("head h / base b\n手順 bun test: exit 1\n(fail) x");
  });

  test("failLines: bun test's (fail) lines and perf-ratchet's over: lines, once each, in order", () => {
    expect(failLines("ok\n(fail) x > y\nnoise\n  over: launch.layoutShift 1 > 0\n(fail) x > y\n(pass) z")).toEqual(["(fail) x > y", "  over: launch.layoutShift 1 > 0"]);
    expect(failLines("all good")).toEqual([]);
  });

  test("--repo: gh -R, git -C and the clone are the given repository's", async () => {
    const { d, calls } = deps();
    const r = await localCi(42, "/other", d, "o/r", CACHE);
    expect(r.ok).toBe(true);
    const gh = calls.filter((c) => c[0] === "gh");
    expect(gh.length).toBeGreaterThan(0);
    for (const c of gh) expect(c[c.indexOf("-R") + 1]).toBe("o/r");
    const git = calls.filter((c) => c[0] === "git");
    expect(git.some((c) => c.join(" ") === "git -C /other fetch -q origin refs/pull/42/head")).toBe(true);
    // the clone, or the worktree local-ci added from it (the merge)
    for (const c of git) expect(c[2] === "/other" || c[2]!.startsWith(CACHE)).toBe(true);
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
  });
});

test("the result is reported as the repository's forge verification (#920): GitHub's is the PR comment; another service is said, nothing posted", async () => {
  const root = mkdtempSync(join(tmpdir(), "local-ci-forge-"));
  try {
    const calls: string[][] = [];
    const run = async (cmd: string[]) => (calls.push(cmd), "");
    await reportResult({ pr: 7, repo: "example/app", root }, "[local-ci] pass abc", run);
    expect(calls).toEqual([["gh", "pr", "comment", "7", "-R", "example/app", "--body", "[local-ci] pass abc"]]);
    require("node:fs").writeFileSync(join(root, "ops.config.json"), JSON.stringify({ forge: { service: "gitlab" } }));
    await expect(reportResult({ pr: 7, repo: "group/app", root }, "[local-ci] pass abc", run)).rejects.toThrow("サービス gitlab には対応していません");
    expect(calls).toHaveLength(1);
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
