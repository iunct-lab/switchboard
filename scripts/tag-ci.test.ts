// test-reads: .github/workflows/ci.yml scripts/ci.ts
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { withHeavySlot } from "../ops-kit/src/heavy";
import { NO_HOST } from "../ops-kit/src/secrets";
import type { Filed, OpenRequest } from "./file-request";
import { stepWithIdle } from "./local-ci";
import { classifyMiss, failedIn, failedTestFiles, failureRequest, followUp, hidePaths, latestPass, latestPassTag, MAX_TAG_RUNS, parseArgs, waitForMore, REQUEST_TITLE, resolveRepo, resultSection, tagCi, tagCiExit, tagResult, TAG_CI_RESULT, type FollowDeps, type TagCiDeps, type TagCiEntry } from "./tag-ci";

const ciYml = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
const ciTs = await Bun.file(new URL("./ci.ts", import.meta.url)).text();
// the worktrees and failure logs: never the real ~/.cache
const CACHE = mkdtempSync(join(tmpdir(), "sb-tag-ci-test-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const shaOf = (tag: string) => tag.replace(/\D/g, "").padEnd(40, "a").slice(0, 40);
const CHECK = "bun scripts/perf-ratchet.ts check perf-result.json --base perf-base.json || { cat perf-result.json; exit 1; }";

/**
 * A fake clone of o/r: `tags` newest first, each with its Release body (null = no Release) and how its CI goes
 * (`fail`: the step's script that fails and its output; none = every step passes). Edits of a Release change its body.
 */
function fake(tags: Array<{ tag: string; body: string | null; at?: number; fail?: { at: string; output: string }; merged?: false }>, yml = ciYml, select?: string | Error, changed = "") {
  const bodies = new Map(tags.map((t) => [t.tag, t.body]));
  const ran: Array<{ tag: string; script: string }> = [];
  const viewed: string[] = [];
  const worktrees: string[] = [];
  const edits: Array<{ tag: string; body: string }> = [];
  const diffs: string[] = [];
  const tagOfDir = (dir: string) => /switchboard\.tag-ci-(v\d+\.\d+\.\d+)\./.exec(dir)?.[1] ?? "?";
  const d: TagCiDeps = {
    sh: async (cmd, _cwd, input) => {
      const c = cmd.join(" ");
      diffs.push(...(cmd.includes("diff") ? [cmd.at(-1)!] : []));
      if (cmd.includes("diff") && cmd.includes("--name-only")) return changed;
      if (cmd[0] === "env") {
        if (select instanceof Error) throw select;
        return select ?? "";
      }
      // `merged: false` = a tag after the commit given to --merged
      if (c.includes(" tag -l ")) return `${tags.filter((t) => !cmd.includes("--merged") || t.merged !== false).map((t) => t.tag).join("\n")}\nv1.0\n`;
      // `at` = the tag's creatordate in unix seconds
      if (c.includes(" for-each-ref ")) return tags.map((t) => `${t.tag}\t${t.at ?? ""}`).join("\n");
      if (c.includes(" rev-parse ")) return `${shaOf(cmd.at(-1)!.replace("^{commit}", ""))}\n`;
      if (c.startsWith("gh release view")) {
        viewed.push(cmd[3]!);
        const b = bodies.get(cmd[3]!);
        if (b == null) throw new Error("gh release view failed: release not found");
        return `${b}\n`;
      }
      if (c.startsWith("gh release edit")) {
        bodies.set(cmd[3]!, input!);
        edits.push({ tag: cmd[3]!, body: input! });
        return "";
      }
      if (cmd.includes("worktree") && cmd.includes("add")) {
        const dir = cmd[cmd.indexOf("--detach") + 1]!;
        worktrees.push(tagOfDir(dir));
        await Bun.write(`${dir}/.github/workflows/ci.yml`, yml);
        await Bun.write(`${dir}/scripts/ci.ts`, ciTs);
        if (select !== undefined) await Bun.write(`${dir}/scripts/test-select.ts`, "");
      }
      return "";
    },
    step: async (script, cwd) => {
      const tag = tagOfDir(cwd);
      ran.push({ tag, script: script.trim() });
      const f = tags.find((t) => t.tag === tag)?.fail;
      return f && script.trim() === f.at ? { code: 1, output: f.output } : { code: 0, output: "ok" };
    },
    log: () => undefined,
    slot: (_name, fn) => fn(),
    // no waiting for tags to pile up unless a test asks for it (#4079)
    env: { SWITCHBOARD_TAG_CI_MIN_TAGS: "0" },
  };
  return { d, ran, viewed, worktrees, edits, bodies, diffs };
}

const testFail = { at: "bun test", output: "(fail) a > b\n1 fail" };

describe("tag-ci: waits for tags to pile up (#4079)", () => {
  const NOW = 1_800_000_000_000;
  const H = 3_600_000;
  const unix = (msAgo: number) => (NOW - msAgo) / 1000;
  // three tags without a result, then one with: the newest at v3.0.0
  const piled = (ago: number[]) => fake([
    ...ago.map((a, i) => ({ tag: `v${ago.length - i}.0.0`, body: "- #1 x", at: unix(a) })),
    { tag: "v0.9.0", body: `x\n[tag-ci] pass ${shaOf("v0.9.0")}`, at: unix(100 * H) },
  ]);
  const withEnv = (f: ReturnType<typeof fake>, env: Record<string, string>, waits: string[] = []): TagCiDeps => ({ ...f.d, env, now: () => NOW, log: (l) => void waits.push(l), onWait: (r) => void waits.push(`wait: ${r}`) });

  test("waitForMore: fewer than min and young waits, the rest runs", () => {
    const p = (n: number, ago: number) => Array.from({ length: n }, (_, i) => ({ tag: `v${n - i}.0.0`, at: NOW - (i === n - 1 ? ago : 0) }));
    expect(waitForMore(p(3, H), NOW, 8, 6 * H)).toContain("3 件");
    expect(waitForMore(p(8, H), NOW, 8, 6 * H)).toBeNull();
    expect(waitForMore(p(3, 6 * H), NOW, 8, 6 * H)).toBeNull();
    expect(waitForMore([], NOW, 8, 6 * H)).toBeNull();
  });

  test("fewer than min and new: nothing runs, the Release is untouched, onWait hears why", async () => {
    const f = piled([2 * H, H, H / 2]);
    const waits: string[] = [];
    const r = await tagCi(withEnv(f, { SWITCHBOARD_TAG_CI_MIN_TAGS: "4" }, waits), "o/r", "/repo", CACHE);
    expect(r).toEqual([]);
    expect(f.worktrees).toEqual([]);
    expect(f.edits).toEqual([]);
    expect(waits.filter((w) => w.startsWith("wait: "))).toHaveLength(1);
    // the count reads down to the tag with a result and no further
    expect(f.viewed).toEqual(["v3.0.0", "v2.0.0", "v1.0.0", "v0.9.0"]);
  });

  test("min or more pile up: it runs", async () => {
    const f = piled([2 * H, H, H / 2]);
    const r = await tagCi(withEnv(f, { SWITCHBOARD_TAG_CI_MIN_TAGS: "3" }), "o/r", "/repo", CACHE);
    expect(r.map((e) => e.tag)).toEqual(["v3.0.0"]);
  });

  test("fewer than min but the oldest is MAX_WAIT old: it runs", async () => {
    const f = piled([7 * H, H, H / 2]);
    const r = await tagCi(withEnv(f, { SWITCHBOARD_TAG_CI_MIN_TAGS: "8" }), "o/r", "/repo", CACHE);
    expect(r.map((e) => e.tag)).toEqual(["v3.0.0"]);
  });

  test("the environment overrides the hours, and a bad value is the default (8 tags, 6 hours)", async () => {
    const run = async (env: Record<string, string>) => (await tagCi(withEnv(piled([7 * H, H, H / 2]), env), "o/r", "/repo", CACHE)).length;
    expect(await run({ SWITCHBOARD_TAG_CI_MAX_WAIT_HOURS: "8" })).toBe(0);
    expect(await run({ SWITCHBOARD_TAG_CI_MAX_WAIT_HOURS: "7" })).toBe(1);
    // bad: 8 tags / 6 hours, so the 7-hour-old oldest runs and a 5-hour-old one waits
    expect(await run({ SWITCHBOARD_TAG_CI_MIN_TAGS: "abc", SWITCHBOARD_TAG_CI_MAX_WAIT_HOURS: "-1" })).toBe(1);
    expect(await run({ SWITCHBOARD_TAG_CI_MIN_TAGS: "2.5", SWITCHBOARD_TAG_CI_MAX_WAIT_HOURS: "" })).toBe(1);
    const young = piled([5 * H, H, H / 2]);
    expect((await tagCi(withEnv(young, { SWITCHBOARD_TAG_CI_MIN_TAGS: "x", SWITCHBOARD_TAG_CI_MAX_WAIT_HOURS: "x" }), "o/r", "/repo", CACHE))).toEqual([]);
  });

  test("without onWait (another repository, --repo) it never waits", async () => {
    const f = piled([2 * H, H, H / 2]);
    const r = await tagCi({ ...f.d, env: { SWITCHBOARD_TAG_CI_MIN_TAGS: "8" }, now: () => NOW }, "o/r", "/repo", CACHE);
    expect(r.map((e) => e.tag)).toEqual(["v3.0.0"]);
  });

  test("a newest tag that already has a result is not a wait", async () => {
    const f = fake([{ tag: "v1.0.0", body: `x\n[tag-ci] pass ${shaOf("v1.0.0")}`, at: unix(H) }]);
    const r = await tagCi(withEnv(f, {}), "o/r", "/repo", CACHE);
    expect(r.map((e) => `${e.tag} ${e.result} ${e.ran}`)).toEqual(["v1.0.0 pass false"]);
  });
});

describe("tag-ci: a tag left without a Release", () => {
  test("the repair before the walk creates it, and the walk runs that tag instead of stopping there", async () => {
    const f = fake([{ tag: "v2.0.0", body: null }, { tag: "v1.0.0", body: "- #0 y" }]);
    const logs: string[] = [];
    const d: TagCiDeps = { ...f.d, log: (l) => void logs.push(l), repair: async () => (f.bodies.set("v2.0.0", "- #1 x"), ["v2.0.0"]) };
    const r = await tagCi(d, "o/r", "/repo", CACHE);
    expect(r.map((x) => `${x.tag} ${x.result}`)).toEqual(["v2.0.0 pass"]);
    expect(tagCiExit(r)).toBe(0);
    expect(logs.some((l) => l.startsWith("v2.0.0: Release が無かったので作った"))).toBe(true);
  });

  test("a repair that fails is logged, and the walk stops at the missing Release as before", async () => {
    const f = fake([{ tag: "v2.0.0", body: null }, { tag: "v1.0.0", body: "- #0 y" }]);
    const logs: string[] = [];
    const d: TagCiDeps = { ...f.d, log: (l) => void logs.push(l), repair: async () => { throw new Error("HTTP 502"); } };
    const r = await tagCi(d, "o/r", "/repo", CACHE);
    expect(r).toEqual([]);
    expect(tagCiExit(r)).toBe(2);
    expect(logs.some((l) => l.includes("Release の欠けを作れなかった（HTTP 502）"))).toBe(true);
    expect(f.ran).toEqual([]);
  });
});

describe("tag-ci", () => {
  test("records pass on the newest tag", async () => {
    const f = fake([{ tag: "v1.0.0", body: "- #1 x" }, { tag: "v0.9.0", body: "- #0 y" }]);
    const r = await tagCi(f.d, "o/r", "/repo", CACHE);
    expect(r).toEqual([{ tag: "v1.0.0", sha: shaOf("v1.0.0"), result: "pass", ran: true }]);
    expect(tagCiExit(r)).toBe(0);
    expect(f.edits.map((e) => e.tag)).toEqual(["v1.0.0"]);
    // the notes stay, the mark goes after them, and reading it back gives pass
    expect(f.edits[0]!.body).toStartWith("- #1 x\n\n## CI\n");
    expect(tagResult(f.bodies.get("v1.0.0")!, shaOf("v1.0.0"))).toBe("pass");
    expect(f.worktrees).toEqual(["v1.0.0"]);
    expect(f.ran.some((x) => x.script === "bun test")).toBe(true);
  });

  test("main's bundle and bytes are recorded once each from the tag's worktree, pass or fail; a failed record changes nothing (#4105)", async () => {
    for (const [fail, recordFails] of [[undefined, false], [testFail, false], [undefined, true]] as const) {
      const f = fake([{ tag: "v1.0.0", body: "- #1 x", fail }]);
      const puts: string[] = [];
      const contents: string[] = [];
      const logged: string[] = [];
      let removed = false;
      const d: TagCiDeps = {
        ...f.d,
        log: (l) => void logged.push(l),
        // the perf step leaves perf-base.json (with the journeys' bytes) in the tag's worktree
        step: async (script, cwd, env) => {
          await Bun.write(`${cwd}/perf-base.json`, JSON.stringify({ sha: "a".repeat(40), bundle: { js: 1000, css: 100 }, journeys: { "open-task": { bytes: 5, responses: { "/a": { count: 1, bytes: 5 } } } } }));
          await Bun.write(`${cwd}/perf-result.json`, JSON.stringify({ runs: 5, journeys: { "new-task": { msMedian: 9, msP90: 9, requests: 7, layoutCount: 6, recalcStyleCount: 8, layoutShift: 0.01, bytes: 5 } } }));
          return f.d.step(script, cwd, env);
        },
        sh: async (cmd, cwd, input) => {
          if (cmd.includes("worktree") && cmd.includes("remove")) removed = true;
          if (cmd[0] !== "gh" || cmd[1] !== "api") return f.d.sh(cmd, cwd, input);
          if (recordFails) throw new Error("gh api failed: gh: Server Error (HTTP 502)");
          if (cmd.includes("PUT")) {
            expect(removed).toBe(false);
            puts.push(cmd.find((a) => a.includes("/contents/"))!);
            contents.push(Buffer.from((JSON.parse(readFileSync(cmd[cmd.indexOf("--input") + 1]!, "utf8")) as { content: string }).content, "base64").toString("utf8"));
            return "{}";
          }
          if (cmd.some((a) => a.includes("/contents/"))) throw new Error("gh api failed: gh: Not Found (HTTP 404)");
          return "{}";
        },
      };
      const r = await tagCi(d, "o/r", "/repo", CACHE);
      expect(r[0]!.result).toBe(fail ? "fail" : "pass");
      expect(puts.map((p) => p.replace(/.*\/contents\//, ""))).toEqual(recordFails ? [] : ["bundle.tsv", "bytes.tsv", "counts.tsv"]);
      // the bytes record has the journey's per-path row, not only its header
      if (!recordFails) expect(contents[1]!).toContain(["open-task", "/a", "1", "5", "a".repeat(40)].join("\t"));
      // counts.tsv: a row per count of the tag (no times), with the tag and its commit
      if (!recordFails) expect(contents[2]!.split("\n").filter((l) => l.includes("\tjourneys.new-task.layoutCount\t"))).toEqual([expect.stringMatching(/^\S+\t(github|local)\tv1\.0\.0\t[0-9a-f]{40}\tjourneys\.new-task\.layoutCount\t6$/)]);
      expect(logged.filter((l) => l.includes("の記録")).length).toBe(3);
      expect(logged.some((l) => l.includes("の記録に失敗（結果は変えない）"))).toBe(recordFails);
      expect(removed).toBe(true);
    }
  });

  test("every test runs: the tag's bun test is never narrowed, even with the selection in the checkout (#3297)", async () => {
    const f = fake([{ tag: "v1.0.0", body: "- #1 x" }]);
    const sh = f.d.sh;
    const d: TagCiDeps = {
      ...f.d,
      sh: async (cmd, cwd, input) => {
        const out = await sh(cmd, cwd, input);
        if (cmd.includes("worktree") && cmd.includes("add")) await Bun.write(`${cmd[cmd.indexOf("--detach") + 1]!}/scripts/test-select.ts`, "");
        return out;
      },
    };
    await tagCi(d, "o/r", "/repo", CACHE);
    expect(f.ran.map((x) => x.script).filter((s) => s.startsWith("bun test"))).toEqual(["bun test"]);
  });

  test("one heavy slot for the whole run: no step starts while another heavy job holds the machine's slot", async () => {
    const home = mkdtempSync(join(CACHE, "home-"));
    const o = { home, mem: () => undefined, pollMs: 10, log: () => undefined };
    const f = fake([{ tag: "v1.0.0", body: "- #1 x" }]);
    let released = 0;
    let firstStep = 0;
    let names: string[] = [];
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    const other = withHeavySlot("local-ci o/r#1", async () => {
      holding();
      await Bun.sleep(100);
      released = performance.now();
    }, o);
    await held;
    const d: TagCiDeps = {
      ...f.d,
      step: async (script, cwd, env) => {
        firstStep ||= performance.now();
        return f.d.step(script, cwd, env);
      },
      slot: (name, fn) => {
        names = [...names, name];
        return withHeavySlot(name, fn, o);
      },
    };
    const [r] = await Promise.all([tagCi(d, "o/r", "/repo", CACHE, NO_HOST), other]);
    expect(names).toEqual(["tag-ci o/r"]);
    expect(r.map((x) => `${x.tag} ${x.result}`)).toEqual(["v1.0.0 pass"]);
    expect(firstStep).toBeGreaterThanOrEqual(released);
  });

  test("walks back v3 fail, v2 fail, v1 pass and stops at v1", async () => {
    const f = fake([{ tag: "v3.0.0", body: "", fail: testFail }, { tag: "v2.0.0", body: "", fail: testFail }, { tag: "v1.0.0", body: "" }, { tag: "v0.1.0", body: "" }]);
    const r = await tagCi(f.d, "o/r", "/repo", CACHE);
    expect(r.map((x) => `${x.tag} ${x.result} ${x.ran}`)).toEqual(["v3.0.0 fail true", "v2.0.0 fail true", "v1.0.0 pass true"]);
    expect(tagCiExit(r)).toBe(1);
    // v0 is not run nor even read
    expect(f.worktrees).toEqual(["v3.0.0", "v2.0.0", "v1.0.0"]);
    expect(f.viewed).not.toContain("v0.1.0");
    expect(tagResult(f.bodies.get("v3.0.0")!, shaOf("v3.0.0"))).toBe("fail");
    expect(f.bodies.get("v3.0.0")).toContain("`bun test` が落ちた:\n    (fail) a > b");
    expect(f.bodies.get("v0.1.0")).toBe("");
  });

  test("stops at a tag that already has a result", async () => {
    const f = fake([{ tag: "v2.0.0", body: "", fail: testFail }, { tag: "v1.0.0", body: `- n\n\n## CI\n[tag-ci] fail ${shaOf("v1.0.0")}` }, { tag: "v0.1.0", body: "" }]);
    const r = await tagCi(f.d, "o/r", "/repo", CACHE);
    expect(r.map((x) => `${x.tag} ${x.result} ${x.ran}`)).toEqual(["v2.0.0 fail true", "v1.0.0 fail false"]);
    expect(f.worktrees).toEqual(["v2.0.0"]);
    expect(f.edits.map((e) => e.tag)).toEqual(["v2.0.0"]);
  });

  test("--repo: a step with no output is cut, and the Release's section has the fail and the reason", async () => {
    const f = fake([{ tag: "v1.0.0", body: "- #1 x" }]);
    const r = await tagCi({ ...f.d, step: (script, _cwd, env) => (script.trim() === "bun test" ? stepWithIdle(1)("sleep 600", tmpdir(), env) : Promise.resolve({ code: 0, output: "ok" })) }, "o/r", "/repo", CACHE, NO_HOST);
    expect(r).toMatchObject([{ tag: "v1.0.0", result: "fail", fails: ["無進捗で打ち切り: 1 秒出力がなかった"] }]);
    const section = resultSection({ sha: shaOf("v1.0.0"), ok: false, step: r[0]!.step, fails: r[0]!.fails }, NO_HOST);
    expect(section).toContain(`[tag-ci] fail ${shaOf("v1.0.0")}`);
    expect(section).toContain("無進捗で打ち切り");
    expect(f.edits.at(-1)!.body).toContain("無進捗で打ち切り");
  });

  test("second run calls no step", async () => {
    const f = fake([{ tag: "v1.0.0", body: "- #1 x" }]);
    await tagCi(f.d, "o/r", "/repo", CACHE);
    const steps = f.ran.length;
    const r = await tagCi(f.d, "o/r", "/repo", CACHE);
    expect(f.ran.length).toBe(steps);
    expect(f.edits).toHaveLength(1);
    expect(r).toEqual([{ tag: "v1.0.0", sha: shaOf("v1.0.0"), result: "pass", ran: false }]);
    expect(tagCiExit(r)).toBe(0);
  });

  test("previous tag: the steps' env names the tag before as PERF_BASE_REF; the first tag gets none (#4219)", async () => {
    const f = fake([{ tag: "v3.0.0", body: "" }, { tag: "v2.0.0", body: "" }, { tag: "v1.0.0", body: "" }]);
    const seen = new Map<string, string | undefined>();
    const d: TagCiDeps = { ...f.d, step: (script, cwd, env) => (seen.set(/switchboard\.tag-ci-(v\d+\.\d+\.\d+)\./.exec(cwd)?.[1] ?? "?", env?.PERF_BASE_REF), f.d.step(script, cwd, env)) };
    await tagCi(d, "o/r", "/repo", CACHE);
    expect([...seen]).toEqual([["v3.0.0", "v2.0.0"]]);
    const g = fake([{ tag: "v1.0.0", body: "" }]);
    const first = new Map<string, string | undefined>();
    await tagCi({ ...g.d, step: (script, cwd, env) => (first.set("v1.0.0", env?.PERF_BASE_REF), g.d.step(script, cwd, env)) }, "o/r", "/repo", CACHE);
    expect([...first]).toEqual([["v1.0.0", undefined]]);
  });

  test("previous tag: grew and raised against it reach the Release's CI section with (raised/grew only)", async () => {
    const grew = "grew: bundle.js +1.10% (1000 → 1011 B) ≥ 1%: merging is the user's call (docs/design/perf.md)";
    const raised = "raised: launch.ms = 900 (main 800)";
    const f = fake([{ tag: "v2.0.0", body: "", fail: { at: CHECK, output: `ceilings: local\n${grew}\n` } }, { tag: "v1.0.0", body: "" }]);
    await tagCi(f.d, "o/r", "/repo", CACHE);
    expect(f.bodies.get("v2.0.0")).toContain(`[tag-ci] pass ${shaOf("v2.0.0")} (raised/grew only)`);
    expect(f.bodies.get("v2.0.0")).toContain(`    ${grew}`);
    expect(f.bodies.get("v2.0.0")).toContain("前のタグ");
    const g = fake([{ tag: "v2.0.0", body: "", fail: { at: CHECK, output: `ceilings: local\n${raised}\n` } }, { tag: "v1.0.0", body: "" }]);
    await tagCi(g.d, "o/r", "/repo", CACHE);
    expect(g.bodies.get("v2.0.0")).toContain(`(raised/grew only)`);
    expect(g.bodies.get("v2.0.0")).toContain(`    ${raised}`);
  });

  test("raised only counts as pass", async () => {
    const raised = { at: CHECK, output: "ceilings: local\nraised: launch.ms = 900 (main 800)\n" };
    const f = fake([{ tag: "v2.0.0", body: "", fail: raised }, { tag: "v1.0.0", body: "" }]);
    const r = await tagCi(f.d, "o/r", "/repo", CACHE);
    expect(r.map((x) => `${x.tag} ${x.result}`)).toEqual(["v2.0.0 pass"]);
    expect(f.bodies.get("v2.0.0")).toContain(`[tag-ci] pass ${shaOf("v2.0.0")} (raised/grew only)`);
    expect(f.bodies.get("v2.0.0")).toContain("    raised: launch.ms = 900 (main 800)");
    expect(tagResult(f.bodies.get("v2.0.0")!, shaOf("v2.0.0"))).toBe("pass");
    // over next to raised is a fail, and the walk goes on
    const over = { at: CHECK, output: "ceilings: local\nover: launch.ms = 900 > 800\nraised: launch.ms = 900 (main 800)\n" };
    const g = fake([{ tag: "v2.0.0", body: "", fail: over }, { tag: "v1.0.0", body: "" }]);
    expect((await tagCi(g.d, "o/r", "/repo", CACHE)).map((x) => `${x.tag} ${x.result}`)).toEqual(["v2.0.0 fail", "v1.0.0 pass"]);
  });

  test("improved only is a pass that keeps the lines as ceilings to lower; over is a wobble only when the range since the last pass does not reach perf-bench (#4124)", async () => {
    const pass = (tag: string) => `[tag-ci] pass ${shaOf(tag)}`;
    const improved = { at: CHECK, output: "ceilings: local\nimproved: launch.ms = 600 (ceiling 800)\n" };
    const a = fake([{ tag: "v2.0.0", body: "", fail: improved }, { tag: "v1.0.0", body: "" }]);
    const ra = await tagCi(a.d, "o/r", "/repo", CACHE, NO_HOST);
    expect(ra.map((x) => `${x.tag} ${x.result}`)).toEqual(["v2.0.0 pass"]);
    expect(a.bodies.get("v2.0.0")).toContain(`[tag-ci] pass ${shaOf("v2.0.0")} (improved only)`);
    expect(a.bodies.get("v2.0.0")).toContain("bun scripts/perf-ratchet.ts update");
    expect(a.bodies.get("v2.0.0")).toContain("    improved: launch.ms = 600 (ceiling 800)");
    expect(a.bodies.get("v2.0.0")).not.toContain("が落ちた:");
    expect(tagResult(a.bodies.get("v2.0.0")!, shaOf("v2.0.0"))).toBe("pass");

    const over = { at: CHECK, output: "ceilings: local\nover: launch.ms = 900 > 800\n" };
    const tags = [{ tag: "v3.0.0", body: "", fail: over }, { tag: "v2.0.0", body: "" }, { tag: "v1.0.0", body: pass("v1.0.0") }];
    // (b) the range since v1.0.0 (v2.0.0 had no result) holds only docs: a wobble
    const b = fake(tags, ciYml, undefined, "docs/design/a.md\naws/README.md\n");
    expect((await tagCi(b.d, "o/r", "/repo", CACHE, NO_HOST)).map((x) => `${x.tag} ${x.result}`)).toEqual(["v3.0.0 pass"]);
    expect(b.diffs).toContain("v1.0.0..v3.0.0");
    expect(b.bodies.get("v3.0.0")).toContain(`[tag-ci] pass ${shaOf("v3.0.0")} (wobble: perf-bench に届く変更なし)`);
    expect(b.bodies.get("v3.0.0")).toContain("揺れ（範囲に perf-bench に届く変更なし: v1.0.0..v3.0.0）");
    expect(b.bodies.get("v3.0.0")).toContain("    over: launch.ms = 900 > 800");
    expect(b.bodies.get("v3.0.0")).not.toContain("が落ちた:");
    // (c) a change under apps/web reaches it: a fail as before
    const c = fake(tags, ciYml, undefined, "docs/design/a.md\napps/web/src/main.ts\n");
    expect((await tagCi(c.d, "o/r", "/repo", CACHE, NO_HOST)).map((x) => `${x.tag} ${x.result}`)).toEqual(["v3.0.0 fail", "v2.0.0 pass"]);
    expect(c.bodies.get("v3.0.0")).toContain(`[tag-ci] fail ${shaOf("v3.0.0")}`);
    // (d) no tag passed before: it cannot say what the range is, a fail
    const d = fake([{ tag: "v3.0.0", body: "", fail: over }, { tag: "v2.0.0", body: "" }], ciYml, undefined, "docs/design/a.md\n");
    expect((await tagCi(d.d, "o/r", "/repo", CACHE, NO_HOST))[0]!.result).toBe("fail");
  });

  describe("an over in a range that reaches perf-bench: the tag that passed last is measured again (#4124)", () => {
    const pass = (tag: string) => `[tag-ci] pass ${shaOf(tag)}`;
    const over = (...keys: string[]) => ({ at: CHECK, output: `ceilings: local\n${keys.map((k) => `over: ${k} = 9 > ceiling 6\n`).join("")}` });
    const tags = (fail: { at: string; output: string }) => [{ tag: "v3.0.0", body: "", fail }, { tag: "v2.0.0", body: "" }, { tag: "v1.0.0", body: pass("v1.0.0") }];
    const REACH = "apps/web/src/main.ts\n";
    /** The fake with the measure of the previous tag: its perf-bench leaves a result (7 for every count), its check says `before`; `puts` = the records' paths and rows. */
    function again(t: ReturnType<typeof tags>, changed: string, before: string | "bench fails") {
      const f = fake(t, ciYml, undefined, changed);
      const puts: Array<{ path: string; text: string }> = [];
      const d: TagCiDeps = {
        ...f.d,
        step: async (script, cwd, env) => {
          if (script.includes("scripts/perf-bench.ts")) {
            if (before === "bench fails" && cwd.includes("tag-ci-v1.0.0.")) return { code: 1, output: "bench failed" };
            await Bun.write(`${cwd}/perf-result.json`, JSON.stringify({ journeys: { "new-task": { layoutCount: 7 } } }));
          }
          if (script.startsWith("bun scripts/perf-ratchet.ts check '")) return { code: before === "ok" || before.includes("perf ratchet: ok") ? 0 : 1, output: before };
          return f.d.step(script, cwd, env);
        },
        sh: async (cmd, cwd, input) => {
          if (cmd[0] === "gh" && cmd[1] === "api") {
            if (cmd.includes("PUT")) puts.push({ path: cmd.find((a) => a.includes("/contents/"))!, text: Buffer.from((JSON.parse(readFileSync(cmd[cmd.indexOf("--input") + 1]!, "utf8")) as { content: string }).content, "base64").toString("utf8") });
            else if (cmd.some((a) => a.includes("/contents/"))) throw new Error("gh api failed: gh: Not Found (HTTP 404)");
            return "{}";
          }
          return f.d.sh(cmd, cwd, input);
        },
      };
      return { f, d, puts };
    }
    const results = async (d: TagCiDeps) => (await tagCi(d, "o/r", "/repo", CACHE, NO_HOST)).map((x) => `${x.tag} ${x.result}`);

    test("(a) the tag before is over too: a wobble that passes with the mark; its counts are recorded", async () => {
      const a = again(tags(over("journeys.new-task.layoutCount")), REACH, "ceilings: local\nover: journeys.new-task.layoutCount = 7 > ceiling 6\n");
      expect(await results(a.d)).toEqual(["v3.0.0 pass"]);
      expect(a.f.worktrees).toEqual(["v3.0.0", "v1.0.0"]);
      expect(a.f.ran.filter((x) => x.tag === "v1.0.0").map((x) => x.script)).toContain("bun scripts/perf-bench.ts --runs 5 --json perf-result.json");
      expect(a.f.ran.filter((x) => x.tag === "v1.0.0").some((x) => x.script === "bun test")).toBe(false);
      expect(a.f.bodies.get("v3.0.0")).toContain(`[tag-ci] pass ${shaOf("v3.0.0")} (wobble: 前のタグ v1.0.0 も同じ数で外れた)`);
      expect(a.f.bodies.get("v3.0.0")).not.toContain("が落ちた:");
      const counts = a.puts.filter((p) => p.path.endsWith("/counts.tsv") && p.text.includes("\tv1.0.0\t"));
      expect(counts.map((p) => p.text.split("\n").filter((l) => l.includes("\tv1.0.0\t")))).toEqual([[expect.stringMatching(/\tv1\.0\.0\t[0-9a-f]{40}\tjourneys\.new-task\.layoutCount\t7$/)]]);
    });

    test("(b) the tag before stayed under the ceiling: a fail that says so, with the values", async () => {
      const b = again(tags(over("journeys.new-task.layoutCount")), REACH, "ceilings: local\nimproved: launch.ms = 1 (ceiling 2)\n");
      expect(await results(b.d)).toEqual(["v3.0.0 fail", "v2.0.0 pass"]);
      expect(b.f.bodies.get("v3.0.0")).toContain("    前のタグ v1.0.0 では収まった: journeys.new-task.layoutCount = 7 / 9");
    });

    test("(b) the tag before passed its check outright (no verdict line): a fail with the values, not an unknown", async () => {
      const b = again(tags(over("journeys.new-task.layoutCount")), REACH, "ceilings: local\nperf ratchet: ok\n");
      expect(await results(b.d)).toEqual(["v3.0.0 fail", "v2.0.0 pass"]);
      expect(b.f.bodies.get("v3.0.0")).toContain("    前のタグ v1.0.0 では収まった: journeys.new-task.layoutCount = 7 / 9");
    });

    test("(c) no over, or a range that does not reach perf-bench: the tag before is not measured", async () => {
      const none = again(tags({ at: CHECK, output: "ceilings: local\nimproved: launch.ms = 1 (ceiling 2)\n" }), REACH, "ok");
      expect(await results(none.d)).toEqual(["v3.0.0 pass"]);
      expect(none.f.worktrees).toEqual(["v3.0.0"]);
      const docs = again(tags(over("launch.ms")), "docs/design/a.md\n", "ok");
      expect(await results(docs.d)).toEqual(["v3.0.0 pass"]);
      expect(docs.f.worktrees).toEqual(["v3.0.0"]);
    });

    test("(d) the measure of the tag before fails: a fail as before", async () => {
      const x = again(tags(over("launch.ms")), REACH, "bench fails");
      expect(await results(x.d)).toEqual(["v3.0.0 fail", "v2.0.0 pass"]);
      expect(x.f.worktrees.filter((t) => t === "v1.0.0")).toEqual(["v1.0.0"]);
      expect(x.f.bodies.get("v3.0.0")).toContain(`[tag-ci] fail ${shaOf("v3.0.0")}`);
    });

    test("(e) two overs and only one of them also over before: a fail that names the other; one measure serves the tags of a walk", async () => {
      const two = over("journeys.new-task.layoutCount", "journeys.new-task.requests");
      const e = again([{ tag: "v3.0.0", body: "", fail: two }, { tag: "v2.0.0", body: "", fail: two }, { tag: "v1.0.0", body: pass("v1.0.0") }], REACH, "ceilings: local\nover: journeys.new-task.layoutCount = 7 > ceiling 6\n");
      expect(await results(e.d)).toEqual(["v3.0.0 fail", "v2.0.0 fail", "v1.0.0 pass"]);
      expect(e.f.bodies.get("v3.0.0")).toContain("前のタグ v1.0.0 では収まった: journeys.new-task.requests = ? / 9");
      expect(e.f.bodies.get("v3.0.0")).not.toContain("では収まった: journeys.new-task.layoutCount");
      // v2.0.0 also fails by the same over: v1.0.0 was measured once for both
      expect(e.f.worktrees.filter((t) => t === "v1.0.0")).toEqual(["v1.0.0"]);
    });
  });

  test("a perf check that is over is a fail written to the Release: the perf steps run in the tag CI, which a PR's local CI no longer runs (#4076)", async () => {
    const over = { at: CHECK, output: "ceilings: local\nover: launch.ms = 900 > 800\n" };
    const f = fake([{ tag: "v1.0.0", body: "", fail: over }]);
    const r = await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST);
    expect(r.map((x) => `${x.tag} ${x.result}`)).toEqual(["v1.0.0 fail"]);
    expect(r[0]!.step).toBe("bun scripts/perf-ratchet.ts check perf-result.json");
    expect(r[0]!.fails).toEqual(["over: launch.ms = 900 > 800"]);
    expect(f.ran.some((x) => x.script.includes("scripts/perf-bench.ts"))).toBe(true);
    expect(f.bodies.get("v1.0.0")).toContain(`[tag-ci] fail ${shaOf("v1.0.0")}`);
    expect(f.bodies.get("v1.0.0")).toContain("over: launch.ms = 900 > 800");
  });

  test("grew only (and grew next to raised) counts as pass", async () => {
    const grew = "grew: bundle.js +1.10% (1000 → 1011 B) ≥ 1%: merging is the user's call (docs/design/perf.md)";
    const f = fake([{ tag: "v2.0.0", body: "", fail: { at: CHECK, output: `ceilings: local\nbundle: js 1011 B (main 1000 B, +11 B, +1.10%) / css 50 B (main 50 B, +0 B, +0.00%)\n${grew}\n` } }, { tag: "v1.0.0", body: "" }]);
    const r = await tagCi(f.d, "o/r", "/repo", CACHE);
    expect(r.map((x) => `${x.tag} ${x.result}`)).toEqual(["v2.0.0 pass"]);
    expect(f.bodies.get("v2.0.0")).toContain(`[tag-ci] pass ${shaOf("v2.0.0")} (raised/grew only)`);
    expect(f.bodies.get("v2.0.0")).toContain(`    ${grew}`);
    const both = { at: CHECK, output: `ceilings: local\nraised: launch.ms = 900 (main 800)\n${grew}\n` };
    const g = fake([{ tag: "v2.0.0", body: "", fail: both }, { tag: "v1.0.0", body: "" }]);
    expect((await tagCi(g.d, "o/r", "/repo", CACHE)).map((x) => `${x.tag} ${x.result}`)).toEqual(["v2.0.0 pass"]);
    expect(g.bodies.get("v2.0.0")).toContain(`    raised: launch.ms = 900 (main 800)\n    ${grew}`);
  });

  test("raised next to a failed bun test is a fail naming both steps and their lines (the check keeps going, #2945)", async () => {
    const f = fake([{ tag: "v1.0.0", body: "", fail: { at: CHECK, output: "ceilings: local\nraised: launch.ms = 900 (main 800)\n" } }]);
    const test = { code: 1, output: "(fail) a > b\n1 fail" };
    const d: TagCiDeps = { ...f.d, step: async (script, cwd, env) => (script.trim() === "bun test" ? (f.ran.push({ tag: "v1.0.0", script: "bun test" }), test) : f.d.step(script, cwd, env)) };
    const r = await tagCi(d, "o/r", "/repo", CACHE, NO_HOST);
    expect(r.map((x) => `${x.tag} ${x.result}`)).toEqual(["v1.0.0 fail"]);
    expect(r[0]!.step).toBe("bun scripts/perf-ratchet.ts check perf-result.json / bun test");
    expect(r[0]!.fails).toEqual(["raised: launch.ms = 900 (main 800)", "(fail) a > b"]);
    expect(f.ran.at(-1)!.script).toBe("bun test");
    // a check with more lines than the Release keeps does not push bun test's lines out: each step gets its share
    const many = Array.from({ length: 25 }, (_, i) => `over: k${i} = 2 > ceiling 1`).join("\n");
    const g = fake([{ tag: "v1.0.0", body: "", fail: { at: CHECK, output: `ceilings: local\n${many}\n` } }]);
    const r2 = await tagCi({ ...g.d, step: async (script, cwd, env) => (script.trim() === "bun test" ? test : g.d.step(script, cwd, env)) }, "o/r", "/repo", CACHE, NO_HOST);
    expect(r2[0]!.fails).toHaveLength(11);
    expect(r2[0]!.fails!.at(-1)).toBe("(fail) a > b");
  });

  test("raised only is a fail when steps come after the check (they did not run)", async () => {
    const yml = `jobs:\n  ci:\n    steps:\n      - run: ${JSON.stringify(CHECK)}\n      - run: echo after\n`;
    const f = fake([{ tag: "v1.0.0", body: "", fail: { at: CHECK, output: "ceilings: local\nraised: launch.ms = 900 (main 800)\n" } }], yml);
    const r = await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST);
    expect(r.map((x) => `${x.tag} ${x.result}`)).toEqual(["v1.0.0 fail"]);
    expect(f.ran.map((x) => x.script)).toEqual([CHECK]);
  });

  test("the failed lines go without host paths, and not at all with a value usable for auth", async () => {
    const leak = { at: "bun test", output: `(fail) reads ${join(CACHE, "x")}\n(fail) under /home/someone/work/a.ts and /Users/example/b.ts\n` };
    const f = fake([{ tag: "v1.0.0", body: "", fail: leak }]);
    await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST);
    const body = f.bodies.get("v1.0.0")!;
    expect(body).toContain("    (fail) under ~/work/a.ts and ~/b.ts");
    expect(body).not.toContain("/home/someone");
    expect(hidePaths(`at ${CACHE}/w/a.ts`, { [`${CACHE}/w`]: "<checkout>" })).toBe("at <checkout>/a.ts");
    const key = "-----BEGIN " + "RSA PRIVATE KEY-----";
    const g = fake([{ tag: "v1.0.0", body: "", fail: { at: "bun test", output: `(fail) printed ${key}\n` } }]);
    await tagCi(g.d, "o/r", "/repo", CACHE, NO_HOST);
    const gb = g.bodies.get("v1.0.0")!;
    expect(gb).not.toContain(key);
    expect(gb).toContain("認証に使える値が含まれるので書かない");
    expect(tagResult(gb, shaOf("v1.0.0"))).toBe("fail");
    // the step's name is checked as its lines are: an unnamed step is named by its script
    const named = resultSection({ sha: shaOf("v1.0.0"), ok: false, step: `curl -H "x: ${key}" /home/someone/a`, fails: ["(fail) a"] }, NO_HOST);
    expect(named).not.toContain(key);
    expect(named).not.toContain("(fail) a");
    expect(resultSection({ sha: shaOf("v1.0.0"), ok: false, step: "bun /home/someone/x.ts" }, NO_HOST)).toContain("`bun ~/x.ts` が落ちた:");
  });

  test("--repo must be the origin of the working tree it runs in; without it, the script's clone", async () => {
    const run = (origin: string) => async (cmd: string[]) => (cmd.includes("rev-parse") ? "/w\n" : cmd.includes("get-url") ? `${origin}\n` : "");
    expect(await resolveRepo(["--repo", "o/r"], "/w", "/s", run("git@github.com:o/r.git"))).toEqual({ repo: "o/r", root: "/w" });
    expect(await resolveRepo([], "/w", "/s", run("https://github.com/x/y"))).toEqual({ repo: "x/y", root: "/s" });
    await expect(resolveRepo(["--repo", "o/r"], "/w", "/s", run("https://github.com/x/y"))).rejects.toThrow("--repo o/r と違う");
    await expect(resolveRepo(["12"], "/w", "/s", run("https://github.com/x/y"))).rejects.toThrow("知らない引数");
    await expect(resolveRepo(["--repo", "bad"], "/w", "/s", run("https://github.com/x/y"))).rejects.toThrow("owner/name");
  });

  test("a tag without a release is not run and the walk stops", async () => {
    const f = fake([{ tag: "v2.0.0", body: null }, { tag: "v1.0.0", body: "" }]);
    const r = await tagCi(f.d, "o/r", "/repo", CACHE);
    expect(r).toEqual([]);
    expect(tagCiExit(r)).toBe(2);
    expect(f.worktrees).toEqual([]);
    expect(f.viewed).toEqual(["v2.0.0"]);
  });

  test("tagResult reads the last mark of the sha", () => {
    const A = "a".repeat(40);
    const B = "b".repeat(40);
    expect(tagResult(`x\n[tag-ci] pass ${A}\n[tag-ci] fail ${B}\n[tag-ci] fail ${A}\n`, A)).toBe("fail");
    expect(tagResult(`[tag-ci] pass ${B}`, A)).toBeNull();
    // a mark only counts at the start of a line, and with the whole sha
    expect(tagResult(`see [tag-ci] pass ${A}`, A)).toBeNull();
    expect(tagResult(`[tag-ci] pass ${A}0`, A)).toBeNull();
    expect(TAG_CI_RESULT.exec(resultSection({ sha: A, ok: true }))?.slice(1)).toEqual(["pass", A]);
    expect(resultSection({ sha: A, ok: false, step: "s", fails: Array.from({ length: 30 }, (_, i) => `(fail) t${i}`) }).split("\n").filter((l) => l.startsWith("    (fail)"))).toHaveLength(20);
  });
});

/**
 * The request side over the fake clone: requests filed (an open one with the same title is not filed again, as
 * fileRequest does), comments, and what --repo printed. `git log` answers two commits.
 */
function requests(f: ReturnType<typeof fake>) {
  const open: OpenRequest[] = [];
  const comments: Array<{ ref: string; body: string }> = [];
  const printed: string[] = [];
  const bodies: string[] = [];
  const d: FollowDeps = {
    sh: async (cmd, cwd, input) => (cmd.includes("log") ? "abc1234 fix: a\ndef5678 feat: b\n" : f.d.sh(cmd, cwd, input)),
    log: () => undefined,
    file: async (req): Promise<Filed> => {
      const same = open.find((o) => o.title === req.title);
      if (same) return { open: same.ref };
      open.push({ ref: `#${100 + open.length}`, title: req.title });
      bodies.push(req.body);
      return { filed: 99 + open.length };
    },
    comment: async (ref, body) => void comments.push({ ref, body }),
    open: async () => [...open, { ref: "#7", title: "要望: ほかの検査" }],
    text: async (ref) => [bodies[Number(ref.slice(1)) - 100] ?? "", ...comments.filter((c) => c.ref === ref).map((c) => c.body)].join("\n"),
    print: (t) => void printed.push(t),
  };
  return { d, open, comments, printed, bodies };
}

describe("tag-ci: recordings and the walk (#3534)", () => {
  const saved = process.env.SWITCHBOARD_FIXTURES;
  afterEach(() => {
    if (saved === undefined) delete process.env.SWITCHBOARD_FIXTURES;
    else process.env.SWITCHBOARD_FIXTURES = saved;
  });
  const listing = (f: ReturnType<typeof fake>, out: string | Error, withList = true) => {
    const lists: string[] = [];
    const d: TagCiDeps = {
      ...f.d,
      log: (l) => void lists.push(l),
      sh: async (cmd, cwd, input) => {
        if (cmd.at(-1) === "list") {
          lists.push("listed");
          expect(cmd.slice(0, 2)).toEqual(["env", "-i"]); // the checkout's code runs in the steps' clean environment
          if (out instanceof Error) throw out;
          return out;
        }
        const r = await f.d.sh(cmd, cwd, input);
        if (withList && cmd.includes("worktree") && cmd.includes("add")) await Bun.write(`${cmd[cmd.indexOf("--detach") + 1]!}/scripts/fixtures.ts`, "");
        return r;
      },
    };
    return { d, lists };
  };

  test("recordings asked for and missing: nothing runs, no mark, no walk, the names are logged and given to onSkip, exit 2", async () => {
    process.env.SWITCHBOARD_FIXTURES = "/vault";
    const f = fake([{ tag: "v2.0.0", body: "- b" }, { tag: "v1.0.0", body: "- a" }]);
    const { d, lists } = listing(f, "present packages/a.jsonl\nmissing packages/b.jsonl\n");
    const skipped: Array<[string, string[]]> = [];
    const r = await tagCi({ ...d, onSkip: (tag, missing) => void skipped.push([tag, missing]) }, "o/r", "/repo", CACHE, NO_HOST);
    expect(skipped).toEqual([["v2.0.0", ["packages/b.jsonl"]]]);
    expect(r).toEqual([]);
    expect(tagCiExit(r)).toBe(2);
    expect(f.ran).toEqual([]);
    expect(f.edits).toEqual([]);
    expect(f.worktrees).toEqual(["v2.0.0"]);
    expect(lists.some((l) => l.includes("packages/b.jsonl"))).toBe(true);
  });

  test("recordings asked for and all there: the tag runs", async () => {
    process.env.SWITCHBOARD_FIXTURES = "/vault";
    const f = fake([{ tag: "v1.0.0", body: "- a" }]);
    const r = await tagCi(listing(f, "present packages/a.jsonl\n").d, "o/r", "/repo", CACHE, NO_HOST);
    expect(r.map((e) => e.result)).toEqual(["pass"]);
  });

  test("a checkout without the list (another repository) runs as before", async () => {
    process.env.SWITCHBOARD_FIXTURES = "/vault";
    const f = fake([{ tag: "v1.0.0", body: "- a" }]);
    const { d, lists } = listing(f, new Error("no such file"), false);
    expect((await tagCi(d, "o/r", "/repo", CACHE, NO_HOST)).map((e) => e.result)).toEqual(["pass"]);
    expect(lists).not.toContain("listed");
  });

  test("a list that cannot be read: not judged, no mark", async () => {
    process.env.SWITCHBOARD_FIXTURES = "/vault";
    const f = fake([{ tag: "v1.0.0", body: "- a" }]);
    expect(await tagCi(listing(f, new Error("broken")).d, "o/r", "/repo", CACHE, NO_HOST)).toEqual([]);
    expect(f.ran).toEqual([]);
    expect(f.edits).toEqual([]);
  });

  test("recordings asked for: the folder is synced with its branch before the list is read (#3532)", async () => {
    process.env.SWITCHBOARD_FIXTURES = "/vault";
    const f = fake([{ tag: "v1.0.0", body: "- a" }]);
    const { d, lists } = listing(f, "present packages/a.jsonl\n");
    const r = await tagCi({ ...d, sync: async () => void lists.push("synced") }, "o/r", "/repo", CACHE, NO_HOST);
    expect(r.map((e) => e.result)).toEqual(["pass"]);
    expect(lists.indexOf("synced")).toBeGreaterThanOrEqual(0);
    expect(lists.indexOf("synced")).toBeLessThan(lists.indexOf("listed"));
  });

  test("a failed sync is logged and the list still judges (#3532)", async () => {
    process.env.SWITCHBOARD_FIXTURES = "/vault";
    const f = fake([{ tag: "v1.0.0", body: "- a" }]);
    const { d, lists } = listing(f, "missing packages/b.jsonl\n");
    const r = await tagCi({ ...d, sync: async () => { throw new Error("no branch"); } }, "o/r", "/repo", CACHE, NO_HOST);
    expect(r).toEqual([]);
    expect(lists.some((l) => l.includes("同期できなかった") && l.includes("no branch"))).toBe(true);
    expect(lists).toContain("listed");
  });

  test("recordings not asked for: no sync", async () => {
    delete process.env.SWITCHBOARD_FIXTURES;
    const f = fake([{ tag: "v1.0.0", body: "- a" }]);
    let synced = false;
    await tagCi({ ...listing(f, "").d, sync: async () => void (synced = true) }, "o/r", "/repo", CACHE, NO_HOST);
    expect(synced).toBe(false);
  });

  test("recordings not asked for: the list is not read", async () => {
    delete process.env.SWITCHBOARD_FIXTURES;
    const f = fake([{ tag: "v1.0.0", body: "- a" }]);
    const { d, lists } = listing(f, "missing packages/b.jsonl\n");
    expect((await tagCi(d, "o/r", "/repo", CACHE, NO_HOST)).map((e) => e.result)).toEqual(["pass"]);
    expect(lists).not.toContain("listed");
  });

  test("the walk stops after MAX_TAG_RUNS tags, and says so", async () => {
    delete process.env.SWITCHBOARD_FIXTURES;
    const f = fake(["v5.0.0", "v4.0.0", "v3.0.0", "v2.0.0", "v1.0.0"].map((tag) => ({ tag, body: "- x", fail: testFail })));
    const { d, lists } = listing(f, "");
    const r = await tagCi(d, "o/r", "/repo", CACHE, NO_HOST);
    expect(r.map((e) => e.tag)).toEqual(["v5.0.0", "v4.0.0", "v3.0.0"].slice(0, MAX_TAG_RUNS));
    expect(lists.some((l) => l.includes("遡りをここで止める"))).toBe(true);
  });

  test("the newest tag's fail is reported before the walk: a cut walk loses no report", async () => {
    delete process.env.SWITCHBOARD_FIXTURES;
    const f = fake([{ tag: "v2.0.0", body: "- b", fail: testFail }, { tag: "v1.0.0", body: "- a" }]);
    const at: string[] = [];
    const onNewest = async (e: TagCiEntry[]) => { at.push(`${e.map((x) => x.tag)} ran=${f.worktrees.length}`); };
    await tagCi({ ...f.d, onNewest }, "o/r", "/repo", CACHE, NO_HOST);
    expect(at).toEqual(["v2.0.0 ran=1"]);
    expect(f.worktrees).toEqual(["v2.0.0", "v1.0.0"]);
  });

  test("a pass reports nothing before the end", async () => {
    delete process.env.SWITCHBOARD_FIXTURES;
    const f = fake([{ tag: "v1.0.0", body: "- a" }]);
    let called = 0;
    await tagCi({ ...f.d, onNewest: async () => void called++ }, "o/r", "/repo", CACHE, NO_HOST);
    expect(called).toBe(0);
  });
});

describe("tag-ci: a miss of the narrowed tests (#3297)", () => {
  // as bun prints it: the heading, the test's error, the (fail) line
  const red = { at: "bun test", output: "bun test v1.4.4\na.test.ts:\nerror: x\n(fail) one [1ms]\nb.test.ts:\n(pass) two\n(fail) three [1ms]\n\n 1 pass\n 2 fail\n" };
  const sectionOf = async (select: string | Error | undefined, tags = [{ tag: "v2.0.0", body: "x", fail: red }, { tag: "v1.0.0", body: "- #1 x\n\n## CI\n[tag-ci] pass " + shaOf("v1.0.0") }]) => {
    const f = fake(tags, ciYml, select);
    await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST);
    return { body: f.edits[0]!.body, diffs: f.diffs };
  };

  test("failedTestFiles: by the heading, an error outside a test too, not the closing list", () => {
    expect(failedTestFiles(red.output)).toEqual(["a.test.ts", "b.test.ts"]);
    expect(failedTestFiles("c.test.ts:\n# Unhandled error between tests\n---\nd.test.tsx:\n(pass) x\n")).toEqual(["c.test.ts"]);
    expect(failedTestFiles("a.test.ts:\n(fail) x\nb.test.ts:\n(pass) y\n\n2 tests failed:\n(fail) x\n(fail) z\n")).toEqual(["a.test.ts"]);
    expect(failedTestFiles("(fail) no heading\n")).toEqual([]);
  });

  test("classifyMiss: a selection of every test misses nothing", () => {
    expect(classifyMiss(["a", "b"], ["a"])).toEqual({ missed: ["b"], selected: ["a"] });
    expect(classifyMiss(["a"], null)).toEqual({ missed: [], selected: ["a"] });
  });

  test("a red bun test: the line in the Release, from the change since the tag before; failedIn still reads the failure", async () => {
    const { body, diffs } = await sectionOf("selected: 1\na.test.ts  x");
    expect(body).toContain("\nselection: missed 1 / selected 1（落ちたテストファイル 2 件）\n");
    expect(diffs).toEqual(["v1.0.0"]);
    expect(failedIn(body)).toEqual({ step: "bun test", fails: ["(fail) one [1ms]", "(fail) three [1ms]"] });
    expect(tagResult(body, shaOf("v2.0.0"))).toBe("fail");
  });

  test("a change it cannot judge chose every test: nothing missed", async () => {
    expect((await sectionOf("full: bun.lock: 依存の定義や設定")).body).toContain("selection: missed 0 / selected 2（");
  });

  test("unclassified: no tag before, no selection, a failed selection, no file in the output", async () => {
    expect((await sectionOf("selected: 0", [{ tag: "v1.0.0", body: "x", fail: red }])).body).toContain("selection: unclassified（前のタグが無い）");
    expect((await sectionOf(undefined)).body).toContain("selection: unclassified（前のタグとの差分か選択を読めない）");
    expect((await sectionOf(new Error("exit 1"))).body).toContain("selection: unclassified（前のタグとの差分か選択を読めない）");
    const f = fake([{ tag: "v2.0.0", body: "x", fail: red }, { tag: "v1.0.0", body: `[tag-ci] pass ${shaOf("v1.0.0")}` }], ciYml, "selected: 0");
    const sh = f.d.sh;
    await tagCi({ ...f.d, sh: async (cmd, cwd, input) => { if (cmd.includes("ls-files")) throw new Error("git failed"); return sh(cmd, cwd, input); } }, "o/r", "/repo", CACHE, NO_HOST);
    expect(f.edits[0]!.body).toContain("selection: unclassified（前のタグとの差分か選択を読めない）");
    const tags = [{ tag: "v2.0.0", body: "x", fail: testFail }, { tag: "v1.0.0", body: `[tag-ci] pass ${shaOf("v1.0.0")}` }];
    expect((await sectionOf("selected: 0", tags)).body).toContain("selection: unclassified（落ちたテストファイルを読めない）");
  });

  test("another step's red has no line", async () => {
    const tags = [{ tag: "v2.0.0", body: "x", fail: { at: "bun run typecheck", output: "a.test.ts:\n(fail) x\n" } }, { tag: "v1.0.0", body: `[tag-ci] pass ${shaOf("v1.0.0")}` }];
    expect((await sectionOf("selected: 0", tags)).body).not.toContain("selection:");
  });
});

describe("tag-ci --latest-pass", () => {
  const mark = (tag: string, r: "pass" | "fail") => `notes\n\n## CI\n[tag-ci] ${r} ${shaOf(tag)}\n`;

  test("latest pass skips fail and unrecorded tags", async () => {
    const f = fake([{ tag: "v3.0.0", body: mark("v3.0.0", "fail") }, { tag: "v2.0.0", body: "" }, { tag: "v1.5.0", body: null }, { tag: "v1.0.0", body: mark("v1.0.0", "pass") }, { tag: "v0.9.0", body: mark("v0.9.0", "pass") }]);
    expect(await latestPassTag(f.d.sh, "o/r", "/repo")).toBe("v1.0.0");
    // read only, newest first, and nothing older than the pass; no CI run, no Release edited
    expect(f.viewed).toEqual(["v3.0.0", "v2.0.0", "v1.5.0", "v1.0.0"]);
    expect(f.ran).toEqual([]);
    expect(f.edits).toEqual([]);
    expect(await latestPass(["v3.0.0", "v2.0.0", "v1.0.0"], async (t) => ({ "v3.0.0": "fail", "v1.0.0": "pass" } as const)[t as "v3.0.0"] ?? null)).toBe("v1.0.0");
  });

  test("latest pass with no pass exits 1", async () => {
    const f = fake([{ tag: "v2.0.0", body: mark("v2.0.0", "fail") }, { tag: "v1.0.0", body: mark("v1.0.0", "fail") }]);
    expect(await latestPassTag(f.d.sh, "o/r", "/repo")).toBeNull();
    expect(await latestPass([], async () => "pass")).toBeNull();
    // a pass mark of another commit (the tag was moved) is not this tag's pass
    const moved = fake([{ tag: "v1.0.0", body: `[tag-ci] pass ${"b".repeat(40)}` }]);
    expect(await latestPassTag(moved.d.sh, "o/r", "/repo")).toBeNull();
  });

  test("contained-in drops tags after the commit", async () => {
    const f = fake([{ tag: "v3.0.0", body: mark("v3.0.0", "pass"), merged: false }, { tag: "v2.0.0", body: mark("v2.0.0", "fail") }, { tag: "v1.0.0", body: mark("v1.0.0", "pass") }]);
    expect(await latestPassTag(f.d.sh, "o/r", "/repo")).toBe("v3.0.0");
    f.viewed.length = 0;
    expect(await latestPassTag(f.d.sh, "o/r", "/repo", "c0ffee")).toBe("v1.0.0");
    expect(f.viewed).toEqual(["v2.0.0", "v1.0.0"]);
  });

  test("the arguments: --latest-pass and --contained-in come off before --repo is read", () => {
    expect(parseArgs(["--latest-pass", "--contained-in", "abc", "--repo", "o/r"])).toEqual({ latestPass: true, containedIn: "abc", rest: ["--repo", "o/r"] });
    expect(parseArgs(["--repo", "o/r"])).toEqual({ latestPass: false, containedIn: undefined, rest: ["--repo", "o/r"] });
    expect(() => parseArgs(["--contained-in", "abc"])).toThrow("--latest-pass");
    expect(() => parseArgs(["--latest-pass", "--contained-in"])).toThrow("コミット");
  });
});

describe("tag-ci requests", () => {
  test("a run cut after the walk wrote the pass: the next run tells the open request (#3534)", async () => {
    const f = fake([{ tag: "v3.0.0", body: "- c\n\n## CI\n[tag-ci] fail " + shaOf("v3.0.0") + "\n\n`bun test` が落ちた:\n    (fail) a > b\n" }, { tag: "v2.0.0", body: "- b\n\n[tag-ci] pass " + shaOf("v2.0.0") }]);
    const q = requests(f);
    q.open.push({ ref: "#100", title: failureRequest({ tag: "v3.0.0", sha: shaOf("v3.0.0"), step: "bun test", fails: ["(fail) a > b"], lastPass: "v1.0.0", commits: [] }, "2026-10-30", NO_HOST).title });
    q.bodies[0] = `v3.0.0（${shaOf("v3.0.0").slice(0, 7)}）\n最後に通ったタグ: v1.0.0`;
    await followUp(await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, q.d, "2026-10-30", NO_HOST);
    expect(q.comments.map((c) => c.body)).toEqual([expect.stringContaining("最後に通ったタグ: v2.0.0")]);
    expect(q.comments[0]!.body).toContain("戻す先の候補: v2.0.0（間のマージ 2 件。戻すなら bun scripts/rollback-pr.ts v2.0.0 --repo o/r）");
  });

  test("filed before the walk, then the walk finds a pass: the open request is told once (#3534)", async () => {
    const f = fake([{ tag: "v3.0.0", body: "- c", fail: testFail }, { tag: "v2.0.0", body: "- b" }, { tag: "v1.0.0", body: "- a\n\n[tag-ci] pass " + shaOf("v1.0.0") }]);
    const q = requests(f);
    const entries = await tagCi({ ...f.d, onNewest: (e) => followUp(e, "o/r", "/repo", true, q.d, "2026-10-30", NO_HOST) }, "o/r", "/repo", CACHE, NO_HOST);
    await followUp(entries, "o/r", "/repo", true, q.d, "2026-10-30", NO_HOST);
    await followUp(entries, "o/r", "/repo", true, q.d, "2026-10-30", NO_HOST);
    expect(q.open.length).toBe(1);
    expect(q.comments.map((c) => c.body)).toEqual([expect.stringContaining("最後に通ったタグ: v2.0.0")]);
  });

  test("a failing newest tag files a request with the tag, step, lines, last pass and commits", async () => {
    const f = fake([{ tag: "v2.0.0", body: "", fail: testFail }, { tag: "v1.0.0", body: "" }]);
    const q = requests(f);
    await followUp(await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, q.d, "2026-10-30", NO_HOST);
    expect(q.open).toHaveLength(1);
    expect(q.open[0]!.title).toStartWith(`${REQUEST_TITLE}bun test で落ちる（`);
    const body = q.bodies[0]!;
    for (const s of ["落ちたタグ: v2.0.0（200aaaa）", "手順: bun test", "  (fail) a > b", "最後に通ったタグ: v1.0.0", "その間のコミット（v1.0.0..v2.0.0）:", "  abc1234 fix: a", "- 誰の言葉: 定期の検査", "- いつ: 2026-10-30", "## 派生 PBI"]) expect(body).toContain(s);
    // over: / raised: lines are lines as (fail) is
    const over = failureRequest({ tag: "v3.0.0", sha: "c".repeat(40), step: "check", fails: ["over: launch.ms = 900 > 800", "raised: x = 2 (main 1)"], lastPass: null, commits: [] }, "2026-10-30", NO_HOST);
    expect(over.body).toContain("  over: launch.ms = 900 > 800\n  raised: x = 2 (main 1)");
    expect(over.body).toContain("最後に通ったタグ: 不明");
  });

  test("the body names the rollback candidate and the merge count, all of them past the 50 listed", () => {
    const commits = Array.from({ length: 60 }, (_, i) => `h${i} fix: ${i}`);
    const r = (lastPass: string | null, cs: string[]) => failureRequest({ tag: "v3.0.0", sha: "c".repeat(40), step: "bun test", fails: ["(fail) a"], lastPass, commits: cs, repo: "o/r" }, "2026-10-30", NO_HOST);
    const withPass = r("v1.0.0", commits);
    expect(withPass.body).toContain("戻す先の候補: v1.0.0（v3.0.0 まで 60 件のマージ。戻すなら bun scripts/rollback-pr.ts v1.0.0 --repo o/r）");
    expect(withPass.body).not.toContain("h55 fix");
    expect(withPass.title).toBe(r("v2.0.0", []).title);
    expect(r(null, []).body).toContain("戻す先の候補: 不明（");
  });

  test("the same failure comments on the open request instead of filing", async () => {
    const f = fake([{ tag: "v2.0.0", body: "", fail: testFail }, { tag: "v1.0.0", body: "" }]);
    const q = requests(f);
    await followUp(await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, q.d, "2026-10-30", NO_HOST);
    const g = fake([{ tag: "v3.0.0", body: "", fail: testFail }, { tag: "v2.0.0", body: `[tag-ci] fail ${shaOf("v2.0.0")}` }]);
    await followUp(await tagCi(g.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, { ...q.d, sh: g.d.sh }, "2026-10-31", NO_HOST);
    expect(q.open).toHaveLength(1);
    expect(q.comments).toEqual([{ ref: "#100", body: `v3.0.0（${shaOf("v3.0.0").slice(0, 7)}）でも同じ失敗` }]);
    // another step's failure is another request
    const h = fake([{ tag: "v4.0.0", body: "", fail: { at: "bun run typecheck", output: "error TS1" } }, { tag: "v3.0.0", body: `[tag-ci] fail ${shaOf("v3.0.0")}` }]);
    await followUp(await tagCi(h.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, { ...q.d, sh: h.d.sh }, "2026-10-31", NO_HOST);
    expect(q.open).toHaveLength(2);
  });

  test("a pass comments on the open request once and does not close it", async () => {
    const f = fake([{ tag: "v2.0.0", body: "", fail: testFail }, { tag: "v1.0.0", body: "" }]);
    const q = requests(f);
    await followUp(await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, q.d, "2026-10-30", NO_HOST);
    const g = fake([{ tag: "v3.0.0", body: "" }, { tag: "v2.0.0", body: `[tag-ci] fail ${shaOf("v2.0.0")}` }]);
    await followUp(await tagCi(g.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, q.d);
    // a second run finds v3's result and says nothing again
    await followUp(await tagCi(g.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, q.d);
    expect(q.comments).toEqual([{ ref: "#100", body: "v3.0.0 で通った" }]);
    expect(q.open).toHaveLength(1);
  });

  test("a comment that failed to post is posted by the next run, once", async () => {
    const f = fake([{ tag: "v2.0.0", body: "", fail: testFail }, { tag: "v1.0.0", body: "" }]);
    const q = requests(f);
    await followUp(await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, q.d, "2026-10-30", NO_HOST);
    const down = { ...q.d, comment: async () => { throw new Error("app down"); } };
    // the same failure on v3: its comment fails, the next run (v3 read from before) posts it
    const g = fake([{ tag: "v3.0.0", body: "", fail: testFail }, { tag: "v2.0.0", body: `[tag-ci] fail ${shaOf("v2.0.0")}` }]);
    await expect(followUp(await tagCi(g.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, { ...down, sh: g.d.sh }, "2026-10-31", NO_HOST)).rejects.toThrow("app down");
    for (let i = 0; i < 2; i++) await followUp(await tagCi(g.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, { ...q.d, sh: g.d.sh }, "2026-10-31", NO_HOST);
    expect(q.comments).toEqual([{ ref: "#100", body: `v3.0.0（${shaOf("v3.0.0").slice(0, 7)}）でも同じ失敗` }]);
    // a pass whose comment failed: the same
    const h = fake([{ tag: "v4.0.0", body: "" }, { tag: "v3.0.0", body: `[tag-ci] fail ${shaOf("v3.0.0")}` }]);
    await expect(followUp(await tagCi(h.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, down)).rejects.toThrow("app down");
    for (let i = 0; i < 2; i++) await followUp(await tagCi(h.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, q.d);
    expect(q.comments.at(-1)).toEqual({ ref: "#100", body: "v4.0.0 で通った" });
    expect(q.comments).toHaveLength(2);
  });

  test("the last pass is read past a recorded fail, from the Releases", async () => {
    const f = fake([{ tag: "v3.0.0", body: "", fail: testFail }, { tag: "v2.0.0", body: `[tag-ci] fail ${shaOf("v2.0.0")}` }, { tag: "v1.0.0", body: `[tag-ci] pass ${shaOf("v1.0.0")}` }]);
    const q = requests(f);
    await followUp(await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, q.d, "2026-10-30", NO_HOST);
    expect(q.bodies[0]).toContain("最後に通ったタグ: v1.0.0\n戻す先の候補: v1.0.0（v3.0.0 まで");
  });

  test("a recorded fail whose request was not filed files it on the next run, once, without a comment", async () => {
    const f = fake([{ tag: "v2.0.0", body: "", fail: testFail }, { tag: "v1.0.0", body: "" }]);
    const q = requests(f);
    const first = await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST);
    // filing failed on the run that recorded v2
    await expect(followUp(first, "o/r", "/repo", true, { ...q.d, file: async () => { throw new Error("app down"); } }, "2026-10-30", NO_HOST)).rejects.toThrow("app down");
    const again = await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST);
    expect(again.map((x) => `${x.tag} ${x.ran}`)).toEqual(["v2.0.0 false"]);
    await followUp(again, "o/r", "/repo", true, q.d, "2026-10-31", NO_HOST);
    await followUp(again, "o/r", "/repo", true, q.d, "2026-10-31", NO_HOST);
    expect(q.open).toHaveLength(1);
    expect(q.comments).toEqual([]);
    // read back from the Release, the failure has the title the run would have given it
    expect(q.open[0]!.title).toBe(failureRequest({ tag: "v2.0.0", sha: shaOf("v2.0.0"), step: "bun test", fails: ["(fail) a > b"], lastPass: null, commits: [] }, "x", NO_HOST).title);
    expect(failedIn(f.bodies.get("v2.0.0")!)).toEqual({ step: "bun test", fails: ["(fail) a > b"] });
  });

  test("the request body has no home path", async () => {
    const leak = { at: "bun test", output: `(fail) reads ${join(CACHE, "x")}\n(fail) under /home/someone/work/a.ts and /Users/example/b.ts\n` };
    const f = fake([{ tag: "v1.0.0", body: "", fail: leak }]);
    const q = requests(f);
    await followUp(await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", true, q.d, "2026-10-30", NO_HOST);
    const body = q.bodies[0]!;
    expect(body).toContain("  (fail) under ~/work/a.ts and ~/b.ts");
    for (const p of ["/home/", "/Users/"]) expect(body).not.toContain(p);
    const r = failureRequest({ tag: "v1.0.0", sha: "a".repeat(40), step: "bun /home/someone/x.ts", fails: [], lastPass: "v0.9.0", commits: ["abc fix /root/y"] }, "2026-10-30", NO_HOST);
    expect(`${r.title}\n${r.body}`).not.toMatch(/\/home\/|\/root\//);
    // a value usable for auth leaves the step, lines and commits out
    const key = "-----BEGIN " + "RSA PRIVATE KEY-----";
    const k = failureRequest({ tag: "v1.0.0", sha: "a".repeat(40), step: "bun test", fails: [`(fail) ${key}`], lastPass: null, commits: [] }, "2026-10-30", NO_HOST);
    expect(`${k.title}\n${k.body}`).not.toContain(key);
    expect(k.body).toContain("認証に使える値が含まれるので書かない");
    // a value in a commit subject leaves the body's detail out but not the title: the same failure keeps its title
    const c = (commits: string[]) => failureRequest({ tag: "v1.0.0", sha: "a".repeat(40), step: "bun test", fails: ["(fail) a"], lastPass: "v0.9.0", commits }, "2026-10-30", NO_HOST);
    expect(c([`abc fix ${key}`]).title).toBe(c(["abc fix"]).title);
    expect(c([`abc fix ${key}`]).body).not.toContain(key);
    // a value after the 20 lines a Release keeps does not change the title either (read back, those lines are gone)
    const lines = Array.from({ length: 20 }, (_, i) => `(fail) t${i}`);
    const at = (fails: string[]) => failureRequest({ tag: "v1.0.0", sha: "a".repeat(40), step: "bun test", fails, lastPass: null, commits: [] }, "2026-10-30", NO_HOST).title;
    expect(at([...lines, `(fail) ${key}`])).toBe(at(lines));
  });

  test("--repo files no request and prints the body", async () => {
    const f = fake([{ tag: "v1.0.0", body: "", fail: testFail }]);
    const q = requests(f);
    await followUp(await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", false, q.d, "2026-10-30", NO_HOST);
    expect(q.open).toHaveLength(0);
    expect(q.printed).toHaveLength(1);
    expect(q.printed[0]).toContain("落ちたタグ: v1.0.0");
    // a later run that reads the recorded fail prints it again (the scheduled Task's stop has its reason every time)
    await followUp(await tagCi(f.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", false, q.d, "2026-10-30", NO_HOST);
    expect(q.printed).toHaveLength(2);
    expect(q.open).toHaveLength(0);
    // nor comments on a pass
    const g = fake([{ tag: "v2.0.0", body: "" }]);
    await followUp(await tagCi(g.d, "o/r", "/repo", CACHE, NO_HOST), "o/r", "/repo", false, q.d);
    expect(q.comments).toEqual([]);
  });
});
