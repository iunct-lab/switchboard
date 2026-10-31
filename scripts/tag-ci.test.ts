import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { NO_HOST } from "../ops-kit/src/secrets";
import type { Filed, OpenRequest } from "./file-request";
import { failedIn, failureRequest, followUp, hidePaths, latestPass, latestPassTag, parseArgs, REQUEST_TITLE, resolveRepo, resultSection, tagCi, tagCiExit, tagResult, TAG_CI_RESULT, type FollowDeps, type TagCiDeps } from "./tag-ci";

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
function fake(tags: Array<{ tag: string; body: string | null; fail?: { at: string; output: string }; merged?: false }>, yml = ciYml) {
  const bodies = new Map(tags.map((t) => [t.tag, t.body]));
  const ran: Array<{ tag: string; script: string }> = [];
  const viewed: string[] = [];
  const worktrees: string[] = [];
  const edits: Array<{ tag: string; body: string }> = [];
  const tagOfDir = (dir: string) => /switchboard\.tag-ci-(v\d+\.\d+\.\d+)\./.exec(dir)?.[1] ?? "?";
  const d: TagCiDeps = {
    sh: async (cmd, _cwd, input) => {
      const c = cmd.join(" ");
      // `merged: false` = a tag after the commit given to --merged
      if (c.includes(" tag -l ")) return `${tags.filter((t) => !cmd.includes("--merged") || t.merged !== false).map((t) => t.tag).join("\n")}\nv1.0\n`;
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
    expect(q.bodies[0]).toContain("最後に通ったタグ: v1.0.0\nその間のコミット（v1.0.0..v3.0.0）:");
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
