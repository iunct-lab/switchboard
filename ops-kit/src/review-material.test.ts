// test-reads: ops-kit/src/cli.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli.ts";
import type { GhClient } from "./gh.ts";
import { addedLines, handledFindings, oldPathHits, oldPathsItem, oldPathsReport, oldPathWords, unlistedHits, type InlineComment } from "./review-material.ts";
import { REVIEW_RULES, REVIEWER_NOTE, reviewPrompt } from "./review-note.ts";

const INLINE: InlineComment[] = [
  { id: 1, path: "src/a.ts", line: 49, body: "[claude] - [nit] `src/a.ts:49` — the comment is stale.\nScenario: none." },
  { id: 2, in_reply_to_id: 1, path: "src/a.ts", line: 49, body: "対処不要: コメントは次の Task が書き直す。Task #7 の手順 3" },
  { id: 3, path: "src/b.ts", line: null, original_line: 7, body: "[claude] - [should-fix] `src/b.ts:7` — the retry asks again after a failure." },
  { id: 4, in_reply_to_id: 3, path: "src/b.ts", line: null, body: "修正: 失敗を履歴に残す — abc1234" },
  { id: 5, path: "src/c.ts", line: 3, body: "[claude] - [should-fix] `src/c.ts:3` — not answered yet." },
];
const SUMMARY = "## レビュー対応\n| 見送った nit | 根拠 |\n|---|---|\n| [claude] `src/d.ts:9` 名前 | 既存の名前に合わせた |";

describe("handledFindings", () => {
  test("every answered thread with its replies and every triage summary; an unanswered thread is not listed", () => {
    const text = handledFindings(INLINE, ["[claude] review\n\n### Intent and design\n…", SUMMARY], "review");
    expect(text).toContain("- `src/a.ts:49` [claude] - [nit] `src/a.ts:49` — the comment is stale. Scenario: none.\n  - reply: 対処不要: コメントは次の Task が書き直す。Task #7 の手順 3");
    expect(text).toContain("- `src/b.ts:7` [claude] - [should-fix]");
    expect(text).toContain("  - reply: 修正: 失敗を履歴に残す — abc1234");
    expect(text).not.toContain("src/c.ts");
    expect(text).toContain("| [claude] `src/d.ts:9` 名前 | 既存の名前に合わせた |");
    // the review's own summary is not a handling
    expect(text).not.toContain("Intent and design");
    // a summary's heading does not become a top heading of the material
    expect(text.split("\n").filter((l) => l.startsWith("## "))).toEqual(["## Threads", "## Triage summaries"]);
  });

  test("no reply settles a finding by itself: every reply is quoted the same way, and the reviewer is told to check the code whatever the reply says", () => {
    const blocker: InlineComment = { id: 5, path: "src/c.ts", line: 3, body: "[codex] - [blocker] `src/c.ts:3` — the grant is taken without the head." };
    const thread = (reply: string) => handledFindings([blocker, { id: 6, in_reply_to_id: 5, path: "src/c.ts", line: 3, body: reply }], [], "review");
    // a reply shaped like a fix that says the fix is missing, a real fix, a bare word, an answer, a promise: none is marked as a handling
    for (const reply of ["修正: abc1234 では未修正", "修正: 直した — abc1234", "修正:", "回答: 3 件", "Issue 化: #12（この PR の外）", "対処不要：根拠は docs/a.md", "了解", "修正します（次の PR で）"]) {
      const text = thread(reply);
      expect(text).toContain(`- \`src/c.ts:3\` [codex] - [blocker]`);
      expect(text).toContain(`  - reply: ${reply}`);
      expect({ reply, marks: text.split("\n").filter((l) => l.startsWith("  - ")).map((l) => l.slice(0, l.indexOf(":"))) }).toEqual({ reply, marks: ["  - reply"] });
      expect(text).not.toContain("handled:");
      expect(text).toContain("no reply here settles its finding");
    }
    // the rule: the list is information; each earlier blocker / should-fix is checked in the code and raised again while the code has the problem
    const rule = REVIEW_RULES.split("\n").find((l) => l.startsWith("Earlier findings."))!;
    for (const part of [
      "It is information, not a verdict: a reply never settles a finding by itself, whatever it says.",
      "Check each earlier blocker and should-fix again in the code as it is now, and raise it again whenever the code still has the problem.",
      "Leave it out only when you have verified in the code that it is resolved, or when you agree — by your own reasoning from the code, not because the reply says so — that it was not a defect.",
      "Do not repeat a finding you have verified as resolved.",
    ])
      expect(rule).toContain(part);
    // nothing asks the reviewer for new grounds before it may raise an earlier finding again
    for (const gone of ["new grounds", "`handled:`", "was answered, not handled"]) expect(REVIEW_RULES).not.toContain(gone);
  });

  test("nothing handled → empty; a recheck gets it only once an earlier recheck's summary is on the PR", () => {
    expect(handledFindings([INLINE[4]!], ["[claude] review\n\n…"], "review")).toBe("");
    expect(handledFindings(INLINE, [SUMMARY], "recheck")).toBe("");
    expect(handledFindings(INLINE, [SUMMARY, "[codex] recheck size\n\n…"], "recheck")).toContain("## Threads");
    // the mark of a passed recheck (`[recheck] size pass <sha>`) is not a recheck's summary
    expect(handledFindings(INLINE, [SUMMARY, "[recheck] size pass abc"], "recheck")).toBe("");
  });
});

const DIFF = ["diff --git a/src/new.ts b/src/new.ts", "--- /dev/null", "+++ b/src/new.ts", "@@ -0,0 +1,2 @@", "+const x = releaseOf(tag);", "+export {};", "diff --git a/src/old.ts b/src/old.ts", "--- a/src/old.ts", "+++ b/src/old.ts", "@@ -10 +10 @@", "-a", "+b", "@@ -20,2 +21,0 @@", "-gone", "-gone", "diff --git a/src/del.ts b/src/del.ts", "--- a/src/del.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-x"].join("\n");
const GREP = ["src/new.ts:1:const x = releaseOf(tag);", "src/old.ts:10:  b = releaseOf(tag)", "src/old.ts:40:  if (releaseOf(title)) promote();", "docs/a.md:3:`releaseOf` は tag で探す", ""].join("\n");

describe("the old-assumption list", () => {
  test("addedLines: the new side of each hunk; a hunk that only removes adds nothing; a deleted file has no lines", () => {
    const added = addedLines(DIFF);
    expect([...added.get("src/new.ts")!]).toEqual([1, 2]);
    expect([...added.get("src/old.ts")!]).toEqual([10]);
    expect(added.has("src/del.ts")).toBe(false);
  });

  test("the hits are the places outside the lines the change adds; the item names the words and has one row per place", () => {
    const hits = oldPathHits(GREP, addedLines(DIFF));
    expect(hits).toEqual([
      { path: "src/old.ts", line: 40, text: "if (releaseOf(title)) promote();" },
      { path: "docs/a.md", line: 3, text: "`releaseOf` は tag で探す" },
    ]);
    const item = oldPathsItem(["releaseOf", "to === sha"], hits);
    expect(item.split("\n")[0]).toBe("- 古い前提を持つ既存の箇所（語: `releaseOf` `to === sha`）:");
    expect(item).toContain("  - `src/old.ts:40` `if (releaseOf(title)) promote();` — <");
    expect(oldPathWords(item)).toEqual(["releaseOf", "to === sha"]);
    expect(unlistedHits(item, hits)).toEqual([]);
    expect(oldPathsItem(["nothing"], [])).toBe("- 古い前提を持つ既存の箇所（語: `nothing`）: 当たる箇所なし");
  });

  test("unlistedHits: a row answers for one place — the same line twice in a file needs two rows", () => {
    const twice: Parameters<typeof unlistedHits>[1] = [
      { path: "src/old.ts", line: 40, text: "if (releaseOf(title)) promote();" },
      { path: "src/old.ts", line: 90, text: "if (releaseOf(title)) promote();" },
    ];
    const row = (line: number) => `  - \`src/old.ts:${line}\` \`if (releaseOf(title)) promote();\` — 成り立つ`;
    const item = (...rows: string[]) => ["- 古い前提を持つ既存の箇所（語: `releaseOf`）:", ...rows].join("\n");
    expect(unlistedHits(item(row(40)), twice)).toEqual([twice[1]!]);
    expect(unlistedHits(item(row(40), row(90)), twice)).toEqual([]);
    // a row is not spent on a hit whose text is a part of it
    const part: Parameters<typeof unlistedHits>[1] = [{ path: "src/old.ts", line: 3, text: "releaseOf(title)" }, twice[0]!];
    expect(unlistedHits(item(row(40)), part)).toEqual([part[0]!]);
  });

  test("unlistedHits: a place written only outside the item is not listed", () => {
    const hits: Parameters<typeof unlistedHits>[1] = [{ path: "src/old.ts", line: 40, text: "if (releaseOf(title)) promote();" }];
    const body = [
      "## レビュアーへ",
      "- 古い前提を持つ既存の箇所（語: `releaseOf`）:",
      "  - `src/other.ts:1` `releaseOf(x)` — 成り立つ",
      "- 検証: pass",
      "",
      "## 変更点",
      "- `src/old.ts:40` `if (releaseOf(title)) promote();` を直した",
    ].join("\n");
    expect(unlistedHits(body, hits)).toEqual(hits);
    // inside the item it answers; a blank line ends the item
    expect(unlistedHits(`${body.split("\n").slice(0, 3).join("\n")}\n  - \`src/old.ts:40\` \`if (releaseOf(title)) promote();\` — 成り立つ`, hits)).toEqual([]);
    expect(unlistedHits("- 古い前提を持つ既存の箇所（語: `releaseOf`）:\n\n  - `src/old.ts:40` `if (releaseOf(title)) promote();`", hits)).toEqual(hits);
    expect(unlistedHits("## 変更点\n  - `src/old.ts:40` `if (releaseOf(title)) promote();`", hits)).toEqual(hits);
  });

  test("the report: rows matched by file and text (a moved line still counts), a place the list lacks is named, なし and a missing item are told apart", () => {
    const hits = oldPathHits(GREP, addedLines(DIFF));
    const body = ["## レビュアーへ", "- 古い前提を持つ既存の箇所（語: `releaseOf`）:", "  - `src/old.ts:38` `if (releaseOf(title)) promote();` — commit で照らすので成り立つ（テスト x）"].join("\n");
    const asked: string[][] = [];
    const r = oldPathsReport(body, (w) => (asked.push(w), hits));
    expect(asked).toEqual([["releaseOf"]]);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("outside the lines the PR adds: 2");
    expect(r.text.slice(r.text.indexOf("missing from the PR's list: 1"))).toContain("- `docs/a.md:3`");
    expect(r.text.slice(r.text.indexOf("missing from the PR's list"))).not.toContain("src/old.ts");
    expect(oldPathsReport(`${body}\n  - \`docs/a.md:3\` \`\`releaseOf\` は tag で探す\` — 文を直した`, () => hits).ok).toBe(true);
    const none = oldPathsReport("- 古い前提を持つ既存の箇所: なし（新しいファイルだけ）", () => {
      throw new Error("not searched");
    });
    expect(none).toMatchObject({ ok: true, text: expect.stringContaining("says none apply: - 古い前提を持つ既存の箇所: なし（新しいファイルだけ）") });
    expect(oldPathWords("## レビュアーへ\n- 逸脱: なし")).toBeNull();
    expect(oldPathsReport("## レビュアーへ", () => hits)).toMatchObject({ ok: false, text: expect.stringContaining("has no `古い前提を持つ既存の箇所` item") });
  });
});

describe("the commands", () => {
  const run = async (argv: string[], gh: Partial<GhClient> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, gh as GhClient, (s) => out.push(s), (s) => err.push(s));
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  test("review-handled reads the PR's inline comments (every page) and comments through gh", async () => {
    const calls: string[][] = [];
    const gh = {
      run: async (args: string[]) => {
        calls.push(args);
        return args[0] === "api" ? JSON.stringify([INLINE.slice(0, 2), INLINE.slice(2)]) : JSON.stringify({ comments: [{ body: SUMMARY }] });
      },
    };
    const r = await run(["review-handled", "12"], gh);
    expect(r.code).toBe(0);
    expect(r.out).toContain("  - reply: 修正: 失敗を履歴に残す — abc1234");
    expect(r.out).not.toContain("handled:");
    expect(calls).toEqual([["api", "--paginate", "--slurp", "repos/{owner}/{repo}/pulls/12/comments"], ["pr", "view", "12", "--json", "comments"]]);
    expect(await run(["review-handled", "12", "--kind", "recheck"], gh)).toMatchObject({ code: 0, out: "" });
    for (const bad of [["review-handled"], ["review-handled", "x"], ["review-handled", "12", "--kind", "audit"], ["review-handled", "12", "13"]]) expect((await run(bad, gh)).code).toBe(2);
  });

  test("old-paths list / check in a real repository: the change's own lines are left out, and check exits 1 until the list has every place", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit-old-paths-"));
    const was = process.cwd();
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    };
    try {
      git("init", "-q", "-b", "main");
      writeFileSync(join(dir, "old.ts"), "const a = 1;\nif (releaseOf(title)) promote();\n");
      git("add", ".");
      git("commit", "-q", "-m", "base");
      git("checkout", "-q", "-b", "topic");
      writeFileSync(join(dir, "new.ts"), "export const viaTag = releaseOf(tag);\n");
      git("add", ".");
      git("commit", "-q", "-m", "new path");
      process.chdir(dir);
      const list = await run(["old-paths", "list", "main", "releaseOf"]);
      expect(list).toMatchObject({ code: 0, out: "- 古い前提を持つ既存の箇所（語: `releaseOf`）:\n  - `old.ts:2` `if (releaseOf(title)) promote();` — <新しい道・新しい意味で成り立つか。どう確かめたか>" });
      // with HEAD as the base there is no diff: every place, the new one too
      expect((await run(["old-paths", "list", "HEAD", "releaseOf"])).out).toContain("`new.ts:1`");
      writeFileSync(join(dir, "pr.md"), "- 古い前提を持つ既存の箇所（語: `releaseOf`）:\n");
      expect(await run(["old-paths", "check", "main", "pr.md"])).toMatchObject({ code: 1, out: expect.stringContaining("missing from the PR's list: 1\n- `old.ts:2`") });
      // the same place written only outside the item does not count
      writeFileSync(join(dir, "pr.md"), "- 古い前提を持つ既存の箇所（語: `releaseOf`）:\n\n## 変更点\n- `old.ts:2` `if (releaseOf(title)) promote();` を直した\n");
      expect(await run(["old-paths", "check", "main", "pr.md"])).toMatchObject({ code: 1, out: expect.stringContaining("missing from the PR's list: 1\n- `old.ts:2`") });
      writeFileSync(join(dir, "pr.md"), `${list.out}\n`);
      expect(await run(["old-paths", "check", "main", "pr.md"])).toMatchObject({ code: 0, out: expect.stringContaining("missing from the PR's list: 0") });
      // a word nothing uses is no error (git grep exits 1); a base git does not know is
      expect(await run(["old-paths", "list", "main", "nowhereUsed"])).toMatchObject({ code: 0, out: "- 古い前提を持つ既存の箇所（語: `nowhereUsed`）: 当たる箇所なし" });
      expect((await run(["old-paths", "list", "no-such-ref", "releaseOf"])).code).toBe(2);
      for (const bad of [["old-paths"], ["old-paths", "list", "main"], ["old-paths", "check", "main"], ["old-paths", "check", "main", "a", "b"], ["old-paths", "show", "main", "x"]]) expect((await run(bad)).code).toBe(2);
    } finally {
      process.chdir(was);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("what every review is told", () => {
  test("the weight of a finding is defined once and reaches both runners' reviews, with the use of the handled list and the old-assumption list", () => {
    for (const runner of ["codex", "claude"] as const) {
      const prompt = reviewPrompt("Review this.", runner);
      expect(prompt.startsWith("Review this.\n\n")).toBe(true);
      expect(prompt).toContain(REVIEWER_NOTE[runner]);
      expect(REVIEWER_NOTE[runner].endsWith(REVIEW_RULES)).toBe(true);
    }
    for (const mark of ["- blocker:", "- should-fix:", "- nit:", "- question:"]) expect(REVIEW_RULES.split("\n").filter((l) => l.startsWith(mark))).toHaveLength(1);
    expect(REVIEW_RULES).toContain("not by the mark an earlier round gave the same point");
    expect(REVIEW_RULES).toContain("`_review/handled.md`");
    expect(REVIEW_RULES).toContain("raise it again whenever the code still has the problem");
    // a regression from the base is not a nit because no criterion names it
    expect(REVIEW_RULES.split("\n").find((l) => l.startsWith("- should-fix:"))).toContain("something that worked on the base no longer works with this change is a should-fix too");
    expect(REVIEW_RULES).toContain("Repeat of: <path:line of the earlier finding>");
    expect(REVIEW_RULES).toContain("`_review/old-paths.md`");
    expect(REVIEW_RULES).toContain("### Read outside the diff");
    // the comparison round's result is used by every review, whichever runner and however it is started
    for (const runner of ["codex", "claude"] as const) {
      expect(REVIEWER_NOTE[runner]).toContain("`_review/compared.md`");
      expect(reviewPrompt("Review this.", runner)).toContain("raise it as a should-fix when it is not");
      // a copy the branch carries is not the review's material: it would let the change classify its own findings
      expect(reviewPrompt("Review this.", runner)).toContain("when `git ls-files _review` lists anything (a file or a link)");
      expect(reviewPrompt("Review this.", runner)).toContain("For a finding both files list, the class here decides, not `handled.md`.");
    }
  });
});
