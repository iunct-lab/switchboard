import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { NO_HOST } from "../ops-kit/src/secrets";
import { hidePaths, resolveRepo, resultSection, tagCi, tagCiExit, tagResult, TAG_CI_RESULT, type TagCiDeps } from "./tag-ci";

const ciYml = await Bun.file(new URL("../.github/workflows/ci.yml", import.meta.url)).text();
const ciTs = await Bun.file(new URL("./ci.ts", import.meta.url)).text();
// the worktrees and failure logs: never the real ~/.cache
const CACHE = mkdtempSync(join(tmpdir(), "sb-tag-ci-test-"));
afterAll(() => rmSync(CACHE, { recursive: true, force: true }));

const shaOf = (tag: string) => tag.replace(/\D/g, "").padEnd(40, "a").slice(0, 40);
const CHECK = "bun scripts/perf-ratchet.ts check perf-result.json || { cat perf-result.json; exit 1; }";

/**
 * A fake clone of o/r: `tags` newest first, each with its Release body (null = no Release) and how its CI goes
 * (`fail`: the step's script that fails and its output; none = every step passes). Edits of a Release change its body.
 */
function fake(tags: Array<{ tag: string; body: string | null; fail?: { at: string; output: string } }>, yml = ciYml) {
  const bodies = new Map(tags.map((t) => [t.tag, t.body]));
  const ran: Array<{ tag: string; script: string }> = [];
  const viewed: string[] = [];
  const worktrees: string[] = [];
  const edits: Array<{ tag: string; body: string }> = [];
  const tagOfDir = (dir: string) => /switchboard\.tag-ci-(v\d+\.\d+\.\d+)\./.exec(dir)?.[1] ?? "?";
  const d: TagCiDeps = {
    sh: async (cmd, _cwd, input) => {
      const c = cmd.join(" ");
      if (c.includes(" tag -l ")) return `${tags.map((t) => t.tag).join("\n")}\nv1.0\n`;
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
  };
  return { d, ran, viewed, worktrees, edits, bodies };
}

const testFail = { at: "bun test", output: "(fail) a > b\n1 fail" };

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

  test("raised only counts as pass", async () => {
    const raised = { at: CHECK, output: "ceilings: local\nraised: launch.ms = 900 (main 800)\n" };
    const f = fake([{ tag: "v2.0.0", body: "", fail: raised }, { tag: "v1.0.0", body: "" }]);
    const r = await tagCi(f.d, "o/r", "/repo", CACHE);
    expect(r.map((x) => `${x.tag} ${x.result}`)).toEqual(["v2.0.0 pass"]);
    expect(f.bodies.get("v2.0.0")).toContain(`[tag-ci] pass ${shaOf("v2.0.0")} (raised only)`);
    expect(f.bodies.get("v2.0.0")).toContain("    raised: launch.ms = 900 (main 800)");
    expect(tagResult(f.bodies.get("v2.0.0")!, shaOf("v2.0.0"))).toBe("pass");
    // over next to raised is a fail, and the walk goes on
    const over = { at: CHECK, output: "ceilings: local\nover: launch.ms = 900 > 800\nraised: launch.ms = 900 (main 800)\n" };
    const g = fake([{ tag: "v2.0.0", body: "", fail: over }, { tag: "v1.0.0", body: "" }]);
    expect((await tagCi(g.d, "o/r", "/repo", CACHE)).map((x) => `${x.tag} ${x.result}`)).toEqual(["v2.0.0 fail", "v1.0.0 pass"]);
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
