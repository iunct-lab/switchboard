// test-reads: ops-kit/bin/ ops-kit/skills/ ops-kit/processes/ ops-kit/template/ ops-kit/src/cli.ts ops-kit/src/idle-run.ts docs/design/skill-sync.md CLAUDE.md
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { type Dirent, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { checkConditions, CONDITION_KEYS, parseConditions, renderConditions, unmarkedConditions } from "./conditions.ts";
import { REVIEW_RULES, REVIEWER_ISOLATION, REVIEWER_NOTE, reviewPrompt } from "./review-note.ts";
import { OLD_PATHS_ITEM, TRIAGE_HEADING } from "./review-material.ts";
import { DOC_RULES, docViolations } from "./runner-docs.ts";

/**
 * The shared skills name no command, path or tool of one repository: those come from the working repository's
 * CLAUDE.md / AGENTS.md and ops.config.json (issue-workflow, 「使う側のリポジトリが持つもの」). Repository names and
 * accounts are covered by the owner's private/private-words.test.ts. A public copy or fork has no such check
 * unless it adds its own list.
 */
const skills = join(import.meta.dir, "../skills");
const REPOSITORY_SPECIFIC = /bun test|bun run|packages\/|apps\/|\bsb\/|feedback-assets|projects\/\d+/; // repository names: owner's private/private-words.test.ts (requires its own list in a public copy or fork)

test("skills: the shared skills carry no command or path of one repository", () => {
  const names = readdirSync(skills);
  expect(names.length).toBe(11);
  const hits: string[] = [];
  for (const name of names) {
    readFileSync(join(skills, name, "SKILL.md"), "utf8")
      .split("\n")
      .forEach((line, i) => {
        // the one command a reviewer may run is the kit's own (`HOW_IT_RUNS` in review-note.ts, the app's review job), not this repository's
        if (REPOSITORY_SPECIFIC.test(line.replaceAll("ops-kit heavy -- bun test", ""))) hits.push(`${name}/SKILL.md:${i + 1}: ${line.trim().slice(0, 80)}`);
      });
  }
  expect(hits).toEqual([]);
});

test("skills: what must not be written to an Issue is said once, in issue-workflow, and the others point there", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  const section = "Issue・PR・コメントに書かない値";
  const rules = read("issue-workflow");
  expect(rules).toContain(`## ${section}`);
  for (const word of ["device code", "失効済みでも", "非公開リポジトリでも", "無人の実行で承認が要るとき", "ops-kit scan-issues", "`device-auth -- <command>`", "DEVICE_AUTH_URL"]) expect(rules).toContain(word);
  // asking for a decision: no option that writes a value to the Issue
  const asking = rules.slice(rules.indexOf("### 判断待ちの出し方"));
  expect(asking).toContain("選択肢に「値を Issue に出す」案を書かない");
  for (const name of ["task-to-pr", "request-to-backlog", "pbi-complete"]) expect({ name, points: read(name).includes(`「${section}」`) }).toEqual({ name, points: true });
  expect(read("pbi-complete")).toContain("ops-kit scan-issues");
});

test("skills: scan-issues runs through the kit's command in every repository, not an entry", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  for (const name of readdirSync(skills)) expect({ name, skips: read(name).includes("入口が無い") }).toEqual({ name, skips: false });
  const rules = read("issue-workflow");
  const owned = rules.slice(rules.indexOf("## 使う側のリポジトリが持つもの"), rules.indexOf("\n## ", rules.indexOf("## 使う側のリポジトリが持つもの") + 1));
  expect(owned).toContain("`ops-kit <command>`");
  expect(owned).not.toContain("scan_issues.sh");
  // the daily scheduled scan reads the difference: closing a PBI runs no full scan
  for (const name of ["issue-workflow", "pbi-complete"]) expect({ name, says: read(name).includes("PBI を閉じるたびには走らせない") }).toEqual({ name, says: true });
});

test("skills: the main worktree is pulled by the kit's command in every repository, not by CLAUDE.md's steps", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  const complete = read("pbi-complete");
  expect(complete).toContain("ops-kit pull-main");
  expect(complete).not.toContain("CLAUDE.md の手順で");
  expect(complete).toMatch(/\nmain: <[^\n]*up to date/);
  const rules = read("issue-workflow");
  const owned = rules.slice(rules.indexOf("## 使う側のリポジトリが持つもの"), rules.indexOf("\n## ", rules.indexOf("## 使う側のリポジトリが持つもの") + 1));
  expect(owned).toContain("pull-main");
});

test("skills: a mechanism every repository needs goes to the shared kit, said in request-to-backlog and pointed to from pbi-to-tasks", () => {
  const section = (name: string, heading: string) => {
    const text = readFileSync(join(skills, name, "SKILL.md"), "utf8");
    const start = text.indexOf(heading);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf("\n### ", start + 1);
    return text.slice(start, end < 0 ? undefined : end);
  };
  const rule = section("request-to-backlog", "### 2. 価値ごとに切る");
  for (const word of ["**どのリポジトリにも要る仕組み**", "そのリポジトリの移行・片づけ", "ほかのリポジトリでも同じ事故が起きうる"]) expect(rule).toContain(word);
  const check = section("pbi-to-tasks", "### 3. 設計チェック");
  for (const word of ["`request-to-backlog` の「どのリポジトリにも要る仕組み」", "`## 判断待ち`"]) expect(check).toContain(word);
  expect(readFileSync(join(skills, "issue-workflow", "SKILL.md"), "utf8")).toContain("共通キットを持つリポジトリの `owner/name`");
});

test("skills: a request's 出典 says whose words it is — 利用者 only with the user's own words (誰の言葉)", () => {
  const text = readFileSync(join(skills, "request-to-backlog", "SKILL.md"), "utf8");
  expect(text).toContain("- 誰の言葉: <利用者 / エージェント / 定期の検査 のどれか 1 つ");
  expect(text).not.toContain("誰から:");
  const start = text.indexOf("#### 誰の言葉");
  expect(start).toBeGreaterThanOrEqual(0);
  const rule = text.slice(start, text.indexOf("\n#### ", start + 1));
  for (const value of ["`利用者`", "`エージェント`", "`定期の検査`"]) expect(rule).toContain(value);
  for (const word of ["利用者の文そのものを引ける場所", "「利用者が認めた」「利用者の決定」は、`利用者` の根拠にしない", "引けなければ `エージェント` にする"]) expect(rule).toContain(word);
});

test("skills: a request is checked against the repository's premises before it becomes a PBI (前提と照らす)", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  const request = read("request-to-backlog");
  const start = request.indexOf("### 2.5 前提と照らす");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(start).toBeLessThan(request.indexOf("### 3. PBI を書く"));
  const step = request.slice(start, request.indexOf("\n### 3. ", start));
  for (const word of ["CLAUDE.md", "**PBI を作らない**", "## 判断待ち", "needs-decision", "例外にしない", "誰の言葉", "**仮説**", "決定として扱わない", "前提の節が無いので照らしていない"]) expect(step).toContain(word);
  expect(request).toContain("前提と矛盾する価値（下の 2.5）があれば除く — その要望は（ほかの価値も）PBI を作らずに止める");
  const scope = request.slice(request.indexOf("### 3. PBI を書く"), request.indexOf("\n### 4. "));
  for (const word of ["`## 守れる範囲`", "守れないものを受け入れ条件にしない"]) expect(scope).toContain(word);
  const tasks = read("pbi-to-tasks");
  // the body is read from .issue.body (.body is null: writing it back emptied PBIs), fresh, before Ready writes Tasks and the log
  const ready = tasks.slice(tasks.indexOf("### 5. PBI を Ready にする"), tasks.indexOf("\n## 報告"));
  expect(ready).toContain("`ops-kit backlog view <PBI> --fresh --json > \"$W/v.json\"`");
  expect(ready).toContain("`jq -r .issue.body \"$W/v.json\"`");
  expect(ready).toContain("--rev <版>");
  expect(tasks).toMatch(/前提.*矛盾していたら.*Task にしない。PBI に `## 判断待ち`.*Ready にしない。.*`request-to-backlog` の「2\.5 前提と照らす」/);
  const own = read("issue-workflow");
  const list = own.slice(own.indexOf("使う側のリポジトリが持つもの"), own.indexOf("\n## 階層"));
  expect(list).toContain("`request-to-backlog` の「前提と照らす」");
  // the stop rule's exception for request-to-backlog leaves out a value that contradicts a premise
  const exception = own.slice(own.indexOf("（例外: 要望を PBI にする作業は"), own.indexOf("\n", own.indexOf("（例外: 要望を PBI にする作業は")));
  expect(exception).toContain("前提と矛盾する価値（`request-to-backlog` の「2.5 前提と照らす」）があれば、その要望は（ほかの価値も）PBI にしないで止める");
  // a request split into values waits whole: a PBI number in 派生 PBI hides it from the scheduled run after the answer
  expect(step).toContain("同じ要望のほかの価値も、回答まで PBI にしない");
});

test("cross-runner-review: an extra reviewer that can be off says its switch in CLAUDE.md and is skipped, not tried, while off (2026-10-29)", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  expect(text).toContain("有効の条件も CLAUDE.md に書く");
  expect(text).toContain("条件が満たされないときは呼ばず");
  expect(text).toContain("<extra>: 無効（<条件>）");
  expect(text).toContain("`ops.config.json` の `extraReviewer` が名指しし、有効の条件を満たしていれば");
});

test("cross-runner-review: the material step lists the files outside the Task's named paths for a repository with a merge gate, and the prompt has the reviewer sort them", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const block = text.slice(text.indexOf("<!-- when mergeGate=on -->"), text.indexOf("<!-- end when -->", text.indexOf("<!-- when mergeGate=on -->")));
  expect(block).toContain('<マージ判定> $N --scope > "$M/scope.md"; grep -q . "$M/scope.md" || rm -f "$M/scope.md"');
  expect(block).toContain("--change <変更> --scope");
  expect(text).toContain("`handled.md`, `old-paths.md` and `scope.md` when they exist");
  const intent = text.slice(text.indexOf("1. Intent:"), text.indexOf("2. Design consistency"));
  const line = intent.split("\n").find((l) => l.includes("`_review/scope.md`")) ?? "";
  expect(line).toContain("mix-in from another Task");
  expect(line).toContain("`[should-fix]`");
});

test("cross-runner-review: viewpoints — a repository with a merge gate hands the main review the PR's viewpoints and the original request, and asks one line per viewpoint covered; one without it does not", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const render = (mergeGate: "on" | "off") => renderConditions(text, { runner: "claude", review: "same", recheck: "same", reviewer: "claude", task: "in", backlog: "github", mergeGate, extra: "off" }, "cross-runner-review");
  const on = render("on");
  const prompt = on.slice(on.indexOf('cat > "$M/prompt.md"'), on.indexOf("\nPROMPT\n"));
  // only the main review gets the viewpoints: a recheck reuses step 1 and reads its own kind's instructions
  expect(on).toContain('[ "$KIND" = review ] && <マージ判定> $N --viewpoints > "$M/viewpoints.md"');
  expect(on).toContain('ops-kit backlog view "$REQ" --fresh > "$M/request.md"');
  expect(prompt).toContain("When `_review/viewpoints.md` exists, also read it and, when it exists, `request.md`");
  // the reviewer's output names each viewpoint it read, after the sections every review writes
  expect(prompt.indexOf("\n### Viewpoints covered\n")).toBeGreaterThan(prompt.indexOf("### Read outside the diff"));
  expect(prompt.indexOf("\n### Viewpoints covered\n")).toBeLessThan(prompt.indexOf("### Verdict"));
  const off = render("off");
  // a blocking finding carries its evidence on its line, in every repository
  for (const copy of [on, off]) expect(copy).toContain("Evidence: a test that shows the break, or the written rule relied on (`path:line` or section) — on blocker and should-fix lines only.");
  for (const word of ["--viewpoints", "viewpoints.md", "### Viewpoints covered", '"$M/request.md"']) expect({ word, has: off.includes(word) }).toEqual({ word, has: false });
});

test("cross-runner-review: the review clone gets the repository's dependencies, a finding names its reviewer test, and the implementer runs that test first", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  for (const task of ["in", "out"] as const) {
    const copy = renderConditions(text, { runner: "claude", review: "other", recheck: "other", reviewer: "codex", task, backlog: "github", mergeGate: "on", extra: "off" }, "cross-runner-review");
    const lines = copy.split("\n");
    // the dependencies go in right after the clone, before any material, with the command the repository names
    const clone = lines.findIndex((l) => l.startsWith('gh repo clone "$REPO" "$R"'));
    expect(clone).toBeGreaterThan(-1);
    expect(lines[clone + 1]).toStartWith('( cd "$R" && <依存の準備> )');
    const prompt = copy.slice(copy.indexOf('cat > "$M/prompt.md"'), copy.indexOf("\nPROMPT\n"));
    expect(prompt).not.toContain("Do not install dependencies");
    const finding = prompt.split("\n").find((l) => l.startsWith("- [blocker|should-fix|nit|question]")) ?? "";
    // the test is named after the evidence and before `Repeat of:`, which stays last on the line
    expect(finding).toContain("Test: _review/tests/<file>");
    expect(finding.indexOf("Test: _review/tests/<file>")).toBeGreaterThan(finding.indexOf("Evidence:"));
  }
  // this repository names the command the skills call `<依存の準備>`
  expect(readFileSync(join(import.meta.dir, "../../CLAUDE.md"), "utf8")).toContain("（スキルの `<依存の準備>`。clone の中で流す。lockfile のとおりに入れ、依存の install scripts は走らせない）: `bun install --frozen-lockfile --ignore-scripts`");
  // the implementer copies the reviewer's test into its worktree's test place (not under `_review/`) and sees it fail before fixing
  const triage = readFileSync(join(skills, "review-triage-and-merge", "SKILL.md"), "utf8");
  const fix = triage.split("\n").find((l) => l.startsWith("| **修正** |")) ?? "";
  expect(fix).toContain("指摘の行に `Test: _review/tests/<file>` があれば先にそれを");
  expect(fix).toContain("worktree のテストの置き場へ写して（相対 import は直す）走らせ、修正前に落ちるのを見る");
  expect(fix).toContain("`_review/` の下に写さない");
  // the follow-up round installs the dependencies again on the fixed head
  const review = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  expect(review.slice(review.indexOf('git -C "$R" checkout -q "$NEW"'))).toMatch(/^git -C "\$R" checkout -q "\$NEW"\n\( cd "\$R" && <依存の準備> \)/);
});

test("review-triage-and-merge: viewpoints — a non-blocking finding is the implementer's to take, and one left is a line in the summary table", () => {
  const text = readFileSync(join(skills, "review-triage-and-merge", "SKILL.md"), "utf8");
  const table = text.slice(text.indexOf("| 振り分け | いつ | やること |"), text.indexOf("question は事実で答える"));
  expect(table).toContain("non-blocking（nit・question）は採るかを実装者が決める");
  expect(table).toContain("non-blocking の見送りは要約の「見送った nit・question」の表に 1 行（指摘と理由）で足りる");
  // the reply rules and the summary template agree with the table: a question left is not answered one by one
  expect(text).toContain("**見送る nit・question**（対処不要・記録）は 1 件ずつ返信せず");
  expect(text).not.toContain("見送る nit（");
});

test("pbi-complete: a Task's body is not asked to be extended with named paths by a grant sentence", () => {
  const text = readFileSync(join(skills, "pbi-complete", "SKILL.md"), "utf8");
  expect(text).not.toContain(["名指しのパス", "を足してよい"].join(""));
  expect(text).toContain("Task の結果コメントに逸脱として 1 行書く");
  // the gate no longer stops for these files, so the step must stand where every gate result passes, not under "exit 1"
  const gate = text.indexOf("**各 PR のマージ直前にマージ判定**");
  const stop = text.indexOf("exit 1（stop）なら:", gate);
  expect({ before: text.indexOf("Task の結果コメントに逸脱として 1 行書く", gate) < stop }).toEqual({ before: true });
});

test("pbi-complete: a stack's grants are asked in one question, and the stack merges once from its top PR", () => {
  const text = readFileSync(join(skills, "pbi-complete", "SKILL.md"), "utf8");
  const step = text.slice(text.indexOf("## 5. "), text.indexOf("## 6. "));
  // every PR is judged first; the PRs that need the person are asked together, each with its number, size and reasons, one grant sentence a line
  const ask = step.split("\n").find((l) => l.includes("**1 つの問いにまとめ**")) ?? "";
  for (const word of ["`[聞く]` の PR", "`+add/-del`", "`reasons`", "1 行 1 文で全部並べる", "認める行だけを返信に書けばよい"]) expect({ word, has: ask.includes(word) }).toEqual({ word, has: true });
  // after the answer the top PR is named: the gate judges every PR below at its head and merges them together
  expect(step).toContain("<マージ判定> <一番上の PR> --merge-stack");
  expect(step).not.toContain("<一番下の PR> --merge-stack");
  expect(step).not.toContain("一度に `gh stack merge <top>` しない");
  for (const name of ["review-triage-and-merge", "stacked-pr-delivery"]) expect({ name, bottomOnly: readFileSync(join(skills, name, "SKILL.md"), "utf8").includes("最下段だけ") }).toEqual({ name, bottomOnly: false });
});

test("cross-runner-review: step 4 appends the fix commits' diff to fix.range-diff after the range-diff (a fix commit added on top shows only as one line in range-diff)", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const step = text.slice(text.indexOf("## 4. 修正後の見直し"));
  const rangeDiff = step.indexOf('> "$M/fix.range-diff"');
  const diff = step.indexOf('git -C "$R" diff "$OLD" "$NEW"; } >> "$M/fix.range-diff"');
  // a heading separates the appended diff from the range-diff: after a rebase the diff also carries base changes
  expect(step).toContain("printf '\\n# git diff %s %s");
  expect(rangeDiff).toBeGreaterThan(-1);
  expect(diff).toBeGreaterThan(rangeDiff);
  expect(diff).toBeLessThan(step.indexOf('> "$M/prompt-fix.md"'));
});

test("cross-runner-review: the Intent check also asks whether design document changes are in scope", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  expect(text).toContain("design documents");
  expect(text).toContain("out-of-scope edits");
});

test("cross-runner-review: the main reviewer is split by the review setting, each side with its own mark on the summary", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const chosen = "（同じランナーの別セッション。設定による選択）";
  const substitute = "（同じランナーの別セッション。<上限のランナー> が利用上限のため代替）";
  // the setting reaches a Task as the side of the text it reads, not as a variable the text tells it to look at
  expect(text).not.toContain("OPS_KIT_REVIEW_RUNNER");
  for (const mark of ["<!-- when review=same -->", "<!-- when review=other -->", "<!-- when review=other reviewer=codex -->", "<!-- when review=same reviewer=claude -->"]) expect({ mark, has: text.includes(mark) }).toEqual({ mark, has: true });
  const lines = parseConditions(text, "cross-runner-review");
  const sideOf = (phrase: string) => [...new Set(lines.filter((l) => !l.mark && l.text.includes(phrase)).map((l) => l.when?.review ?? "any"))];
  expect(sideOf(`\`[<runner>] review${chosen}\``)).toEqual(["same"]);
  expect(sideOf(`\`[<runner>] review${substitute}\``)).toEqual(["other"]);
  expect(sideOf("--as fallback")).toEqual(["other", "same"]);
  // a usage limit on the same-runner side hands the review to the other runner, with its own mark and the same stop when that one is at its limit too
  const swapped = "（別のランナー。<上限のランナー> が利用上限のため代替）";
  expect(sideOf(`\`[<runner>] review${swapped}\``)).toEqual(["same"]);
  expect(sideOf("代替も利用上限なら、未レビューのままマージせず")).toEqual(["other", "same"]);
  expect(sideOf("上限の代替は無い")).toEqual([]);
  // the 4th argument of post_review is how either mark reaches the summary's first line
  expect(text).toContain("note=${4:-}");
  expect(text).toContain("printf '[%s] review%s\\n\\n' \"$who\" \"$note\"");
});

test("cross-runner-review: the arbiter's runner is split by the recheck setting, and the arbiter is asked without --runner", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const same = "監督者は主レビューと同じランナーの新しいセッションが読む";
  const other = "監督者は主レビュアーでないランナーの新しいセッションが読む";
  for (const review of ["same", "other"] as const) {
    for (const recheck of ["same", "other"] as const) {
      const conds = { runner: "claude", review, recheck, reviewer: review === "same" ? "claude" : "codex", task: "in", backlog: "github", mergeGate: "on", extra: "off" } as const;
      const copy = renderConditions(text, conds, "cross-runner-review");
      expect({ review, recheck, same: copy.includes(same), other: copy.includes(other) }).toEqual({ review, recheck, same: recheck === "same", other: recheck === "other" });
      // the app picks the recheck's runner from the setting and refuses another: no request names one
      const asks = copy.split("\n").filter((l) => l.includes("ops-kit job request review") && l.includes("--as arbiter"));
      expect({ review, recheck, asks: asks.length > 0, named: asks.filter((l) => l.includes("--runner") || l.includes("--kinds")) }).toEqual({ review, recheck, asks: true, named: [] });
      // a recheck runner at its limit is waited for, not swapped for the one that is not (the app refuses a runner the setting does not name)
      expect({ review, recheck, swap: copy.includes("上限でない側") }).toEqual({ review, recheck, swap: false });
    }
  }
});

test("arbiter: the skills hand a split finding and the model-read rechecks to the supervisor, and the gate reads only the job's record", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  for (const [review, recheck, task] of [["same", "same", "in"], ["other", "other", "in"], ["other", "same", "out"]] as const) {
    const copy = renderConditions(read("cross-runner-review"), { runner: "claude", review, recheck, reviewer: review === "same" ? "claude" : "codex", task, backlog: "github", mergeGate: "on", extra: "off" }, "cross-runner-review");
    // section 6 exists, the comparison round (5) and its command are gone, and the instruction and the check are the kit's commands
    expect(copy).toContain("## 6. 監督者");
    expect(copy).not.toContain("## 5. main との比較");
    for (const word of ["ops-kit review-arbiter prompt >", "ops-kit review-arbiter prompt --follow-up", "ops-kit review-arbiter check", "`[<runner>] arbiter`"]) expect({ word, has: copy.includes(word) }).toEqual({ word, has: true });
    for (const word of ["review-compare", "[<runner>] compare"]) expect({ word, has: copy.includes(word) }).toEqual({ word, has: false });
    // a review run as recheck lifts nothing now: no request line asks for one
    expect(copy.split("\n").filter((l) => l.includes("ops-kit job request review") && l.includes("--as recheck"))).toEqual([]);
    // the PR comment is for display; the gate's key is the job's record
    expect(copy).toContain("`[<runner>] arbiter` のコメントを書いても判定は通らない");
    if (task === "in") expect(copy).toContain('ops-kit job request review $N --as arbiter --cwd "$R"');
  }
  const triage = read("review-triage-and-merge");
  const again = triage.slice(triage.indexOf("### 同じ論点が続いたら（直す前に）"), triage.indexOf("### 修正する"));
  const converge = triage.slice(triage.indexOf("### 収束しないとき"), triage.indexOf("## 3. 直す"));
  // a point raised again goes to the supervisor and not to the user: no 判断待ち, no question in the conversation
  expect(again).toContain("監督者に裁定を頼む（`cross-runner-review` の 6）");
  expect(again).not.toContain("判断待ち` を出して止める");
  expect(converge).toContain("`cross-runner-review` の 6 の監督者を頼む");
  expect(converge).not.toContain("review-compare");
  // the merge checklist asks for an answer to every finding and the supervisor's ruling where a kind needs one
  const checklist = triage.slice(triage.indexOf("## 5. マージ可否"), triage.indexOf("## 6. マージと記録"));
  expect(checklist).toContain("全部の指摘に答えがある");
  expect(checklist).toContain("要る種類に監督者の裁定がある");
  expect(checklist).not.toContain("main と比べて");
  const complete = read("pbi-complete");
  expect(complete).toContain("`ops-kit job request review <PR> --as arbiter --cwd … --prompt … --out …`");
  expect(complete).not.toContain("--as recheck --kinds");
  expect(complete).toContain("`ops-kit job request recheck <PR> --kind <種類>");
});

test("cross-runner-review: post_review prints the model the job ran with under the summary's first line", () => {
  const lines = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8").split("\n");
  const from = lines.findIndex((l) => l.startsWith("post_review() {"));
  const to = lines.findIndex((l, i) => i > from && l === "}");
  expect(from).toBeGreaterThan(-1);
  const dir = mkdtempSync(join(tmpdir(), "post-review-model-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // gh: the PR's head, no inline comment taken, and the summary's body kept
    writeFileSync(join(bin, "gh"), `#!/bin/bash\ncase "$1 $2" in\n  "pr view") echo abc123;;\n  "pr comment") cat > "${dir}/body.md";;\n  *) exit 1;;\nesac\n`, { mode: 0o755 });
    writeFileSync(join(bin, "ops-kit"), `#!/bin/bash\n[ "$*" = "job list --json" ] || exit 1\necho '[{"id":7,"kind":"review","runner":"codex","model":"m1","effort":"high","as":null},{"id":8,"kind":"review","runner":"codex","model":null,"effort":null,"as":"recheck"}]'\n`, { mode: 0o755 });
    writeFileSync(join(dir, "codex.md"), "### Findings\n- none\n### Intent and design\nfine\n### Verdict\nmergeable as is\n");
    const post = (args: string, before = "") => {
      rmSync(join(dir, "body.md"), { force: true });
      const run = spawnSync("bash", ["-c", `unset JOB\n${lines.slice(from, to + 1).join("\n")}\n${before}post_review 5 codex "${join(dir, "codex.md")}" ${args}`], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      expect(run.status).toBe(0);
      return readFileSync(join(dir, "body.md"), "utf8").split("\n");
    };
    const body = post("'' 7");
    expect(body[0]).toBe("[codex] review");
    const model = body.indexOf("model: m1 / effort high");
    expect(model).toBeGreaterThan(0);
    expect(model).toBeLessThan(body.indexOf("### Intent and design"));
    // the job ran with the CLI's own model and effort
    expect(post("'' 8")).toContain("model: CLI の既定 / effort 既定");
    // the main review's calls give the id as JOB in front, in the form `ops-kit job request` prints it
    expect(post("", "JOB='job#7' ")).toContain("model: m1 / effort high");
    expect(post("", "JOB=7 ")).toContain("model: m1 / effort high");
    // run outside the app's jobs (no job id): the model is not known, and nothing is guessed
    expect(post("")).toContain("model: 不明（仕事の口の外）");
    // a mark on the first line stays there, with the model under it
    expect(post("'（同じランナーの別セッション。設定による選択）' 7").slice(0, 3)).toEqual(["[codex] review（同じランナーの別セッション。設定による選択）", "", "model: m1 / effort high"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skills: condition markers in every skill and process definition render for every combination", () => {
  const processes = join(import.meta.dir, "../processes");
  const kit = join(import.meta.dir, "..");
  // a skill's frontmatter keeps one name and one description on every side of a block
  const ofSkills = readdirSync(skills).flatMap((n) => checkConditions(readFileSync(join(skills, n, "SKILL.md"), "utf8"), relative(kit, join(skills, n, "SKILL.md")), ["name", "description"]));
  const ofProcesses = readdirSync(processes).filter((n) => n.endsWith(".md")).flatMap((n) => checkConditions(readFileSync(join(processes, n), "utf8"), relative(kit, join(processes, n))));
  expect([...ofSkills, ...ofProcesses]).toEqual([]);
});

test("cross-runner-review: the commands that run a reviewer directly carry the same isolation as the app's review job", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const commands = text.split("\n").filter((l) => /^(# )?\( .*(exec --sandbox|claude -p)/.test(l));
  expect(commands.length).toBe(4);
  for (const line of commands) {
    const runner = line.includes("claude -p") ? "claude" : "codex";
    const { env, args } = REVIEWER_ISOLATION[runner];
    // as the shell reads the line: quotes around a value are the shell's, not the argument's
    const words = line.replaceAll("'", "");
    if (env.length) expect(words).toContain(`env ${env.join(" ")} claude -p`);
    expect(words).toContain(args.join(" "));
    expect(line).toContain(`ops-kit review-note ${runner}`);
    // only inside the block a session outside the app reads
    expect(parseConditions(text, "cross-runner-review").find((l) => l.text === line)?.when?.task).toBe("out");
  }
});

test("cross-runner-review: the instructions do not say whether to run anything; the reviewer's own note does", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const prompt = text.slice(text.indexOf("cat > \"$M/prompt.md\" <<'PROMPT'"), text.indexOf("\nPROMPT\n"));
  expect(prompt).toContain("Reproduce claims by reading the code.");
  for (const word of ["read-only sandbox", "blocked by the sandbox", "plan mode", "run the tests", "test run"]) expect({ word, says: prompt.includes(word) }).toEqual({ word, says: false });
  expect(REVIEWER_NOTE.codex).toContain("workspace-write sandbox");
  expect(REVIEWER_NOTE.claude).toContain("dontAsk mode");
  for (const note of Object.values(REVIEWER_NOTE)) expect(note).toContain("say so in a finding");
});

/** cross-runner-review's step 1 before the clone, run as written with REVIEW_ROOT moved under `root` and a fake gh / df first on PATH. */
function runCloneSweep(availKb: number) {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const lines = text.split("\n");
  const from = lines.findIndex((l) => l.startsWith("NAME="));
  const to = lines.findIndex((l, i) => i > from && l.includes("du -sk"));
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const root = mkdtempSync(join(tmpdir(), "skills-sweep-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const reviewRoot = join(root, "cache", "ops-kit", "review");
  mkdirSync(reviewRoot, { recursive: true });
  // PR 1 merged, 2 closed, 3 open, 4: gh fails
  writeFileSync(join(bin, "gh"), `#!/bin/bash\ncase $3 in 1) echo MERGED;; 2) echo CLOSED;; 3) echo OPEN;; *) echo "not found" >&2; exit 1;; esac\n`, { mode: 0o755 });
  // only the review root has the given free space: a check of another place (e.g. /tmp) sees 0 and stops
  writeFileSync(join(bin, "df"), `#!/bin/bash\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\n[ "$2" = "${reviewRoot}" ] && echo "disk 1900000 0 ${availKb} 1% ${reviewRoot}" || echo "tmpfs 1900000 0 0 100% $2"\n`, { mode: 0o755 });
  const dirs = ["app.review1", "app.recheck2", "app.review3", "app.review4", "other.review1", "app.reviewx"];
  for (const d of dirs) mkdirSync(join(reviewRoot, d));
  const run = spawnSync("bash", ["-c", `REPO=acme/app\n${lines.slice(from, to + 1).join("\n")}`], { encoding: "utf8", env: { ...process.env, XDG_CACHE_HOME: join(root, "cache"), PATH: `${bin}:${process.env.PATH}` } });
  const left = readdirSync(reviewRoot).sort();
  rmSync(root, { recursive: true, force: true });
  return { status: run.status, out: run.stdout, left, reviewRoot };
}

test("cross-runner-review: step 1 removes only this repository's clones of merged or closed PRs", () => {
  const { status, out, left } = runCloneSweep(1_000_000);
  expect(status).toBe(0);
  expect(left).toEqual(["app.review3", "app.review4", "app.reviewx", "other.review1"]);
  expect(out).not.toContain("STOP:");
});

test("cross-runner-review: step 1 stops before cloning when the review root has less than MIN_KB free", () => {
  const { out, reviewRoot } = runCloneSweep(100);
  expect(out).toContain(`STOP: ${reviewRoot} の空きが 100 KB`);
  expect(out).toMatch(/^\d+\t.*other\.review1$/m); // du's top entries are reported
});

test("cross-runner-review: running the clone lines twice for one PR leaves one directory; a recheck keeps the review's clone", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("N=<PR番号>; KIND=review"));
  expect(at).toBeGreaterThan(-1);
  expect(lines[at + 1]).toStartWith('R="${REVIEW_ROOT:?}/${NAME:?}.${KIND:?}${N:?}";');
  expect(lines[at + 1]).not.toContain("rm -rf"); // rebuilding R on resume only assigns
  expect(lines[at + 2]).toStartWith('rm -rf "$R"');
  const block = lines.slice(at, at + 3).map((l) => l.split("#")[0]).join("\n");
  expect(block).not.toContain("/tmp");
  const root = mkdtempSync(join(tmpdir(), "skills-same-pr-"));
  try {
    const reviewRoot = join(root, "review");
    mkdirSync(reviewRoot);
    // the clone itself is `gh repo clone`, which makes $R; stand in with mkdir and a file the first run left
    const once = block.replace("N=<PR番号>;", "N=7;");
    const recheck = once.replace("KIND=review", "KIND=recheck");
    const script = `REVIEW_ROOT=${reviewRoot}; NAME=app\n${once}\nmkdir "$R" && touch "$R/old"\n${once}\nmkdir "$R"\nls "$R" | wc -l\n${recheck}\nmkdir "$R"`;
    const run = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(readdirSync(reviewRoot).sort()).toEqual(["app.recheck7", "app.review7"]);
    expect(run.stdout.trim().split("\n")).toContain("0"); // the previous run's file is gone
    const unset = spawnSync("bash", ["-c", `unset REVIEW_ROOT NAME\n${once}`], { encoding: "utf8" }); // a new shell without REVIEW_ROOT / NAME stops instead of using /
    expect(unset.status).not.toBe(0);
    for (const missing of ["KIND", "N"]) {
      // a new shell that lost KIND or N stops instead of making `<name>.` / `<name>.review` (unset: the runner's environment may export them)
      const lost = spawnSync("bash", ["-c", `unset KIND N; REVIEW_ROOT=${reviewRoot}; NAME=app; ${missing === "KIND" ? "N=7" : "KIND=review"}\n${lines[at + 1]!.split("#")[0]}`], { encoding: "utf8" });
      expect(lost.status).not.toBe(0);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The code span of the local-change paragraph that starts with `prefix`. */
function localChangeSpan(prefix: string): string {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const para = text.split("\n").find((l) => l.startsWith("**ローカルの変更では**"))!;
  const span = para.split("`").find((p) => p.startsWith(prefix));
  expect(span).toBeDefined();
  return span!;
}

test("cross-runner-review: the local-change NAME is the main work tree's directory from any worktree", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-name-"));
  try {
    const main = join(root, "mainapp");
    const other = join(root, "elsewhere-wt");
    const git = (cwd: string, ...args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    expect(git(main, "worktree", "add", "-q", "--detach", other).status).toBe(0);
    const line = localChangeSpan("NAME=");
    const nameFrom = (cwd: string) => spawnSync("bash", ["-c", `${line}; echo "$NAME"`], { cwd, encoding: "utf8" }).stdout.trim();
    expect(nameFrom(main)).toBe("mainapp");
    expect(nameFrom(other)).toBe("mainapp");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-runner-review: the local-change remove line clears a leftover directory git does not know, then worktree add works", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-leftover-"));
  try {
    const main = join(root, "app");
    const R = join(root, "review", "app.review7");
    const git = (cwd: string, ...args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    mkdirSync(R, { recursive: true });
    writeFileSync(join(R, "left"), "not registered with git\n");
    expect(git(main, "worktree", "add", "--detach", R).status).not.toBe(0); // without the cleanup it stops
    const remove = localChangeSpan("git worktree remove --force");
    const run = spawnSync("bash", ["-c", `R=${R}; ${remove}\ngit worktree add --detach "$R" main`], { cwd: main, encoding: "utf8" });
    expect(run.status).toBe(0);
    expect(readdirSync(R)).not.toContain("left");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-runner-review: the local-change remove line keeps a live worktree another repository with the same name registered", () => {
  const root = mkdtempSync(join(tmpdir(), "skills-other-wt-"));
  try {
    const main = join(root, "a", "app");
    const other = join(root, "b", "app");
    const R = join(root, "review", "app.review7");
    const git = (cwd: string, ...args: string[]) =>
      spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
    for (const d of [main, other]) {
      mkdirSync(d, { recursive: true });
      git(d, "init", "-q", "-b", "main");
      git(d, "commit", "-q", "--allow-empty", "-m", "init");
    }
    mkdirSync(join(root, "real-review"));
    symlinkSync(join(root, "real-review"), join(root, "review")); // R is reached through a symlink: git answers with the real path
    expect(git(other, "worktree", "add", "-q", "--detach", R).status).toBe(0); // the other session's review, still in use
    writeFileSync(join(R, "work"), "the other session's\n");
    const remove = localChangeSpan("git worktree remove --force");
    spawnSync("bash", ["-c", `R=${R}; ${remove}`], { cwd: main, encoding: "utf8" });
    expect(readdirSync(R)).toContain("work");
    expect(git(other, "worktree", "list", "--porcelain").stdout).toContain(`worktree ${join(root, "real-review", "app.review7")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A home whose `ops-kit heavy` has its own state and no memory floor. */
function noFloor(home: string) {
  mkdirSync(join(home, ".config", "ops-kit"), { recursive: true });
  writeFileSync(join(home, ".config", "ops-kit", "heavy.json"), '{ "minFreeMb": 0 }\n');
}

/** Runs the skill's own review command, with the threshold down to 1 second and fake reviewers in place of the real ones. */
function runReviewCommand(marker: RegExp, fake: string) {
  const dir = mkdtempSync(join(tmpdir(), "review-idle-"));
  try {
    const bin = join(dir, "bin");
    const R = join(dir, "clone");
    const M = join(R, "_review");
    mkdirSync(bin);
    mkdirSync(M, { recursive: true });
    writeFileSync(join(M, "prompt.md"), "review this\n");
    for (const name of ["claude", "codex"]) writeFileSync(join(bin, name), `#!/bin/bash\n${fake}\n`, { mode: 0o755 });
    const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
    const line = text.split("\n").find((l) => l.startsWith("( ") && marker.test(l))!.replace("--idle 900", "--idle 1");
    const script = `R=${R} M=${M} CODEX=${join(bin, "codex")}\n${line}\necho "exit=$?"\n`;
    // HOME is the test's own: `ops-kit heavy --memory-only` takes no slot, but writes its history there, not into the machine's,
    // and its heavy.json has no memory floor (the host's free memory must not decide a test)
    noFloor(dir);
    const env = { ...process.env, HOME: dir, PATH: `${bin}:${join(import.meta.dir, "../bin")}:${process.env.PATH}` };
    const out = spawnSync("bash", ["-c", script], { encoding: "utf8", env });
    const files: Record<string, string> = Object.fromEntries(readdirSync(M).map((name) => [name, readFileSync(join(M, name), "utf8")]));
    return { exit: /exit=(\d+)/.exec(out.stdout)?.[1], files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CODEX_LINE = /"\$M\/codex\.md"/;
const CLAUDE_LINE = /"\$M\/claude\.md"/;
const CODEX_TALKS = 'while [ $# -gt 0 ]; do [ "$1" = -o ] && o=$2; shift; done; for i in 1 2 3 4 5 6 7 8; do echo step $i; sleep 0.2; done; echo "### Findings" > "$o"';
const CLAUDE_TALKS = `for i in 1 2 3 4 5 6 7 8; do echo '{"type":"assistant"}'; sleep 0.2; done; echo '{"type":"result","result":"### Findings"}'`;

test("cross-runner-review: a stuck reviewer is cut by the skill's own command, with the reason in the log", () => {
  const stuck = 'echo \'{"type":"system"}\'; sleep 600';
  const codex = runReviewCommand(CODEX_LINE, stuck);
  expect(codex.exit).toBe("124");
  expect(codex.files["codex.log"]).toContain("無進捗で打ち切り");
  const claude = runReviewCommand(CLAUDE_LINE, stuck);
  expect(claude.exit).toBe("124");
  expect(claude.files["claude.log"]).toContain("無進捗で打ち切り");
  expect(claude.files["claude.md"]?.trim()).toBe("");
}, 15_000);

test("cross-runner-review: a reviewer that keeps talking past the threshold finishes, and its result is the file", () => {
  const codex = runReviewCommand(CODEX_LINE, CODEX_TALKS);
  expect(codex.exit).toBe("0");
  expect(codex.files["codex.md"]).toContain("### Findings");
  const claude = runReviewCommand(CLAUDE_LINE, CLAUDE_TALKS);
  expect(claude.exit).toBe("0");
  expect(claude.files["claude.md"]?.trim()).toBe("### Findings");
}, 15_000);

test("cross-runner-review: a cut follow-up review posts nothing, not even the previous output", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8").split("\n");
  const from = text.findIndex((l) => l.startsWith('rm -f "$M/fix-review.md"'));
  const check = text.findIndex((l) => l.startsWith('[ "$RC" = 0 ]'));
  const block = [text[from], text.find((l, i) => i > from && l.startsWith("( cd")), text[check], text[check + 1]].join("\n").replace("--idle 900", "--idle 1");
  const run = (fake: string) => {
    const dir = mkdtempSync(join(tmpdir(), "review-fix-idle-"));
    try {
      const M = join(dir, "_review");
      mkdirSync(M);
      writeFileSync(join(M, "prompt-fix.md"), "review this\n");
      writeFileSync(join(M, "fix-review.md"), "### Findings\n- none\n");
      writeFileSync(join(dir, "codex"), `#!/bin/bash\n${fake}\n`, { mode: 0o755 });
      noFloor(dir);
      const script = `post_review() { echo POSTED; }\nN=1 R=${dir} M=${M} CODEX=${join(dir, "codex")}\n${block}\n`;
      return spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, HOME: dir, PATH: `${join(import.meta.dir, "../bin")}:${process.env.PATH}` } }).stdout;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const cut = run("sleep 600");
  expect(cut).not.toContain("POSTED");
  expect(cut).toContain("exit 124");
  expect(run(CODEX_TALKS)).toContain("POSTED");
}, 15_000);

test("cross-runner-review: every review command goes through idle-run, and the skill says what to do with 124", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const commands = text.split("\n").filter((l) => /^(# )?\( .*(exec --sandbox|claude -p)/.test(l));
  expect(commands.length).toBe(4);
  for (const line of commands) expect(line).toContain("ops-kit idle-run --idle 900 --");
  // no slot, only the memory floor (PBI 4017: a review runs about a minute, the slot's wait ran minutes to hours), and outside idle-run: waiting is not 'no progress'
  for (const line of commands) expect(line).toMatch(/ops-kit heavy --memory-only --name "review (codex|claude)" -- ops-kit idle-run --idle 900 -- /);
  expect(text).not.toContain("枠が空くまで順に待つ");
  expect(text).not.toContain("--output-format text");
  for (const word of ["exit 124", "無進捗で打ち切り（<秒> 秒出力なし）", "ops-kit job request review", "一度だけやり直す", "止まって報告する"]) expect({ word, says: text.includes(word) }).toEqual({ word, says: true });
});

test("skills: the review clones are removed by their own path, and a cut session's leftovers only after gh says MERGED / CLOSED", () => {
  for (const name of ["cross-runner-review", "review-triage-and-merge"]) {
    const text = readFileSync(join(skills, name, "SKILL.md"), "utf8");
    expect({ name, glob: text.includes("glob で消さない"), state: text.includes("MERGED / CLOSED") }).toEqual({ name, glob: true, state: true });
  }
});

test("skills: public-release-gate runs both runners apart with the seeds, the models and the three-way triage", () => {
  const text = readFileSync(join(skills, "public-release-gate", "SKILL.md"), "utf8");
  const seeds = text.slice(text.indexOf("## 観点の種"), text.indexOf("## 指示"));
  for (const seed of ["鍵と認証の値", "個人情報", "ライセンスと NOTICE", "各ランナーと LLM 提供者の規約", "商標と名前", "依存のライセンス", "録画 fixture とテストデータ", "内部のホスト名・URL・クラウドの ID", "secrets を使う workflow", "コンテナ像と配布物", "Issue 番号の参照", "既定の設定の安全性", "同期のコミットの本文", "検査済みでも見る", "Git で管理するファイルか", "外部への通信", "検査の一覧そのもの", "運用の記録と発言の転載", "配布経路の固定", "公開側で自動で動く投稿", "製品の表示の正確さ", "伏せ字の痕跡", "隠れた内容", "ブラウザに残るデータ", "公開側の CI が確かめる範囲", "Actions のログの公開", "ホストの安全姿勢の開示", "コードに埋め込んだプロンプト", "第三者について公に述べる値", "利用者の会話・履歴の取り込みと保管", "実行可能な成果物の通信", "通知による二次開示", "バックアップの保持と削除", "移行・バックアップの完全性", "書き出すデータの境界", "二次処理と提供者間のデータ共有", "他アプリのデータの不可逆な削除", "利用者側に残る識別子", "ブラウザへの HTML 注入", "サーバーログのデータ保持", "利用者間の記憶の分離", "決済・認証の検証の完全性", "破壊的な後片付け", "公開時に読者のマシンで実行される設定", "依存取得先の乗っ取り・認証情報の混入"]) expect({ seed, listed: seeds.includes(`| ${seed} |`) }).toEqual({ seed, listed: true });
  expect(seeds).toContain("### 追記の記録");
  // the two runners, their models, apart and without a fallback on usage limits
  for (const word of ["claude -p --model claude-fable-5-1", "codex exec -m gpt-6-astra", "片方の出力をもう片方の材料に入れない", "もう片方で代替せず止まる", ".message.model", "^model: ", "wait $P1; C1=$?; wait $P2; C2=$?", "grep -q '^nothing to sync'", "git log -1 --format=%B refs/public-sync/main", ".parent_tool_use_id==null", "初回の push の前"]) expect({ word, says: text.includes(word) }).toEqual({ word, says: true });
  // the report, the triage and the pass mark
  for (const word of ["[public-release-gate] <runner> <model>", "種の外は無し", "### 種の外の観点", "verdict: pass", "verdict: fail", "**直す**", "**公開側から外す**", "**受け入れる**", "**Issue（公開を止めない）**", "ランナーが付けた重さによらず", "ブロッカーが 0 件", "--resume", "`ops-kit heavy` が順に回す", "## 判断待ち", "public-release-gate: pass <tree sha>", "## 観点の追記"]) expect({ word, says: text.includes(word) }).toEqual({ word, says: true });
});

const BACKLOG_BY_GH = /gh issue (create|edit|comment|close|reopen|view|list|delete|transfer)|gh api [^\n]*\/issues|addSubIssue|removeSubIssue|updateProjectV2|gh project (item-|field-)|scripts\/setup\/(triage_issue|set_project_field|lint_backlog)/;

test("skills: the backlog is read and written only through ops-kit backlog", () => {
  /** The lines that stay: not the backlog of a repository the app syncs, or a read before going public. */
  const ALLOWED: { file: string; has: string }[] = [
    { file: "skills/issue-workflow/SKILL.md", has: "Project 全件を読み" }, // the warning itself
    { file: "skills/issue-workflow/SKILL.md", has: "gh api user --silent" }, // telling a network limit from an expired login
    { file: "skills/public-release-gate/SKILL.md", has: "gh issue list --state all --limit 1000" }, // the check before going public
    { file: "skills/pbi-complete/SKILL.md", has: "gh issue close <URL>" }, // an Issue on the public copy, which the app does not sync
  ];
  const kit = join(import.meta.dir, "..");
  const files = [
    ...readdirSync(skills).map((name) => `skills/${name}/SKILL.md`),
    ...(readdirSync(join(kit, "template"), { recursive: true, withFileTypes: true }) as Dirent[])
      .filter((entry) => entry.isFile())
      .map((entry) => relative(kit, join(entry.parentPath, entry.name))),
  ];
  expect(files.some((file) => file.startsWith("template/.github/"))).toBe(true);
  const hits = files.flatMap((file) =>
    readFileSync(join(kit, file), "utf8")
      .split("\n")
      .flatMap((line, i) => (BACKLOG_BY_GH.test(line) && !ALLOWED.some((allowed) => allowed.file === file && line.includes(allowed.has)) ? [`${file}:${i + 1}: ${line.trim().slice(0, 100)}`] : [])),
  );
  expect(hits).toEqual([]);

  // an instruction to comment, close or record names the command, so the runner does not reach for gh
  const lines = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8").split("\n");
  const INSTRUCTIONS: [string, string][] = [
    ["task-to-pr", "着手コメント（3 行"],
    ["task-to-pr", 'Status "In review"'],
    ["task-to-pr", "PR: #<n>"],
    ["pbi-complete", "1 で在りかの無い行（満たせなかった行を含む）が残っておらず、Task も全部閉じていれば"],
    ["pbi-complete", "PBI の Status が Ready でなければ"],
    ["cross-runner-review", "転記したら Task の Issue に 1 行"],
    ["pbi-complete", "後回し: <PR #n / Task #n> と <path> が重なる」とコメント"],
    ["pbi-complete", "`## 派生 PBI` の行に Done"],
    ["review-triage-and-merge", "Issue を作り"],
    ["review-triage-and-merge", "Task に結果コメント"],
    ["review-with-subagent", "Issue の結果コメント"],
    ["stacked-pr-delivery", "Issue にも結果を記録"],
  ];
  for (const [name, words] of INSTRUCTIONS) {
    const found = lines(name).filter((line) => line.includes(words));
    expect({ name, words, found: found.length > 0 }).toEqual({ name, words, found: true });
    expect({ name, words, commands: found.every((line) => line.includes("ops-kit backlog")) }).toEqual({ name, words, commands: true });
  }

  const review = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  expect(review).toContain('ops-kit backlog view "$TASK" --fresh');
  expect(review).toContain('ops-kit backlog view "$PBI" --fresh');
  expect(review).not.toContain("BACKLOG_WORKSPACE");
});

test("skills: the five delivery skills say what a workspace without a remote does instead of PRs", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  for (const name of ["task-to-pr", "cross-runner-review", "review-triage-and-merge", "pbi-complete", "stacked-pr-delivery"]) {
    expect(`${name}: ${read(name).includes("**ローカルの変更では**")}`).toBe(`${name}: true`);
  }
  // made with the kit's backlog, judged and run by the change's number, merged by the merge script
  expect(read("task-to-pr")).toContain("ops-kit backlog create --title \"<題>\" --body-file \"$W/pr.md\" --head <枝> --base main");
  for (const name of ["review-triage-and-merge", "pbi-complete"]) {
    expect(read(name)).toContain("<マージ判定> --change <変更>");
    expect(read(name)).toContain("local-merge.ts <変更>");
  }
  expect(read("pbi-complete")).toContain("<ローカル CI> --change <変更>");
  expect(read("pbi-complete")).toContain("を回し直してから判定する（前の合格は新しい base では数えられない）");
  // the examples carry no Phase or Milestone; a repository that uses Phase is pointed to the kit fixture once, in issue-workflow
  for (const name of ["request-to-backlog", "pbi-to-tasks"]) expect(read(name)).toContain("ops-kit backlog triage <num> <P0-P3>");
  for (const name of ["issue-workflow", "request-to-backlog", "pbi-to-tasks"]) expect(read(name)).not.toContain("<area> <kind>");
  expect(read("issue-workflow")).toContain("例: ops-kit backlog triage 56 P1 \"\" \"In review\"");
  for (const name of ["issue-workflow", "request-to-backlog", "pbi-to-tasks", "pbi-complete"]) expect(read(name)).not.toMatch(/Phase N|--milestone/);
  expect(read("issue-workflow")).toContain("（形はキットの `ops-kit/fixtures/config-with-phase.json`）");
  for (const name of ["request-to-backlog", "pbi-to-tasks", "pbi-complete"]) expect(read(name)).not.toMatch(/Phase|Milestone/);
  expect(read("cross-runner-review")).toContain("ops-kit backlog comment <変更> --body-file");
  expect(read("cross-runner-review")).toContain("`gh repo clone`・`gh pr view` の行は飛ばす（`gh` を呼ばない");
  expect(read("review-triage-and-merge")).toContain("CI 緑は `<ローカル CI> --change <変更>` の合格");
  expect(read("review-triage-and-merge")).toContain("`ops-kit backlog view <変更> --fresh` の末尾のコメント");
  expect(read("stacked-pr-delivery")).toContain("積まない");
});

test("skills: a PBI closes only when every acceptance criterion links its evidence, said in issue-workflow and pointed to from pbi-complete", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  const rules = read("issue-workflow");
  const duty = rules.slice(rules.indexOf("4. **完了時（PBI）**"), rules.indexOf("5. **Milestone**"));
  for (const word of ["証跡の在りか", "結果コメントか PR の URL", "コマンドと出力", "`## 回答` のコメントの URL", "在りかを書けない行は `- [ ]` のまま理由を書き", "その PBI は閉じない", "「利用者確認の項目」"]) expect({ word, said: duty.includes(word) }).toEqual({ word, said: true });
  const steps = read("pbi-complete");
  const close = steps.slice(steps.indexOf("## 6. PBI を閉じる"), steps.indexOf("## 報告"));
  const one = close.slice(close.indexOf("\n1. "), close.indexOf("\n2. "));
  expect(one).toContain("`issue-workflow` の記録の義務 4");
  expect(one).not.toContain("テスト名 / コマンドと出力 / 画面で見た事実");
  const four = close.slice(close.indexOf("\n4. "), close.indexOf("\n5. "));
  expect(four).toContain("1 で在りかの無い行（満たせなかった行を含む）が残っておらず");
});

test("skills: a 利用者確認 line checked by answering decisions names them and is checked once they are all answered, not asked again", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  const rules = read("issue-workflow");
  const start = rules.indexOf("### 利用者確認の項目");
  const section = rules.slice(start, rules.indexOf("\n### ", start + 1));
  for (const word of ["回答で確かめる #", "needs-decision", "聞き直さず", "## 保留", "判断待ちへの回答で確かめる行"]) expect({ word, said: section.includes(word) }).toEqual({ word, said: true });
  const steps = read("pbi-complete");
  const close = steps.slice(steps.indexOf("## 6. PBI を閉じる"), steps.indexOf("## 報告"));
  const four = close.slice(close.indexOf("\n4. "), close.indexOf("\n5. "));
  expect(four).toContain("判断待ちへの回答で確かめる行");
  const report = steps.slice(steps.indexOf("## 報告"));
  const toUser = report.split("\n").find((line) => line.startsWith("利用者へ:")) ?? "";
  expect(toUser).toContain("判断待ちへの回答で確かめる行");
});

test("skills: task-to-pr: a change greps the other places that say the same fact and fixes them in the same PR", () => {
  const skill = readFileSync(join(skills, "task-to-pr", "SKILL.md"), "utf8");
  const rules = skill.slice(skill.indexOf("### 3. 実装の規律"), skill.indexOf("### 4. テスト"));
  expect(rules).toContain("同じ事実を書いているほかの文書・スキル・コード内コメントを `grep -rn` し、食い違うものは同じ PR で直す");
  expect(rules).toContain("直さず残すものは「変えなかったこと」に書く");
});

test("skills: task-to-pr: an added test is seen red by breaking the implementation once, and the PR names the break", () => {
  const skill = readFileSync(join(skills, "task-to-pr", "SKILL.md"), "utf8");
  expect(skill.indexOf("**足す前に**")).toBeGreaterThan(-1);
  expect(skill.indexOf("**テストを消す・統合するとき**")).toBeGreaterThan(skill.indexOf("**足す前に**"));
  const before = skill.slice(skill.indexOf("**足す前に**"), skill.indexOf("**テストを消す・統合するとき**"));
  expect(before).toContain("実装を 1 か所壊して");
  expect(before).toContain("赤になるのを実行して見る");
  expect(before).toContain("壊し方と赤になったテスト名を PR 本文の「テスト観点」に書く");
});

test("skills: task-to-pr: a change outside the Task is a deviation, commented on the Task before the PR and named next to 変えなかったこと", () => {
  const skill = readFileSync(join(skills, "task-to-pr", "SKILL.md"), "utf8");
  expect(skill).toContain("Task に無い方針・拒否・機構の追加と、別 Task の修正も同じ");
  expect(skill).toContain("PR に入れる前に Task へ逸脱としてコメントし");
  const template = skill.slice(skill.indexOf("## レビュアーへ"));
  expect(template.indexOf("- 逸脱:")).toBe(template.indexOf("- 変えなかったこと:") + template.slice(template.indexOf("- 変えなかったこと:")).indexOf("\n") + 1);
  // the review prompt has the reviewer check that a deviation is written in the PR body and on the Task
  const review = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const intent = review.slice(review.indexOf("1. Intent:"), review.indexOf("2. Design consistency:"));
  expect(intent).toContain("PR body's 逸脱 item and in a comment on the Task");
  expect(intent).toContain("report one that is not written as a finding");
});

test("skills: task-to-pr: an added test asserts the behaviour of what is built and cleans up the environment it changes", () => {
  const whole = readFileSync(join(skills, "task-to-pr", "SKILL.md"), "utf8");
  expect(whole.indexOf("**足す前に**")).toBeGreaterThan(-1);
  expect(whole.indexOf("**テストを消す・統合するとき**")).toBeGreaterThan(whole.indexOf("**足す前に**"));
  const skill = whole.slice(whole.indexOf("**足す前に**"), whole.indexOf("**テストを消す・統合するとき**"));
  expect(skill).toContain("断言は出来上がるもの（戻り値・出力・画面・保存された値）の振る舞いを確かめる");
  expect(skill).toContain("文書・スキルの文そのものを変える PR の、文の在りかのテストは除く");
  expect(skill).toContain("テストが変える環境変数・グローバル状態・ポート・日付は後始末する");
});

test("skills: task-to-pr: a new rule in a design doc, CLAUDE.md or a skill is outside the Task and goes to the PBI's decision log or a new Task", () => {
  const skill = readFileSync(join(skills, "task-to-pr", "SKILL.md"), "utf8");
  expect(skill).toContain("設計文書・CLAUDE.md（`AGENTS.md`）・スキルへの規則の追記も同じ扱い");
  expect(skill).toContain("Task に無い新しい規則は PR に入れず、PBI の決定ログ（`ops-kit backlog edit <PBI>`）か新しい Task");
  expect(skill).toContain("規則の文の追記はこの節の「Task の手順に書いたファイルと名前で作る」の項のとおり PR に入れない");
});

test("skills: task-to-pr: a PR that changes rule text checks it against the scripts and the other lines, says 未検証 for what it did not see, and writes owner/repo#N", () => {
  const skill = readFileSync(join(skills, "task-to-pr", "SKILL.md"), "utf8");
  expect(skill).toContain("関係するスクリプトを実行して実際の動きと、同じファイルのほかの行とに照らす");
  expect(skill).toContain("同じ規則を 2 か所に書かず既にある行を指す");
  expect(skill).toContain("観測していないことは「未検証」と書く");
  expect(skill).toContain("`path:line` は書く前にその行を開いて中身を確かめる");
  expect(skill).toContain("他リポジトリの Issue・PR は `owner/repo#N` で書く");
});

test("task-to-pr: the PR body has a correspondence table of the Task's steps, acceptance criteria and DoD", () => {
  const skill = readFileSync(join(skills, "task-to-pr", "SKILL.md"), "utf8");
  const template = skill.slice(skill.indexOf("## レビュアーへ"), skill.indexOf("## 概要 / Summary"));
  const row = template.split("\n").find((l) => l.startsWith("- 対応表:")) ?? "";
  expect(row).toContain("`## 手順` の各番号");
  expect(row).toContain("受け入れ条件");
  expect(row).toContain("`## 完了条件 (DoD)` の各行");
  expect(row).toContain("`## 検証` の各項目");
  expect(row).toContain("「実施した / していない（理由）」と証跡の在りか");
});

test("skills: a PR with a step left undone says Refs, not Closes, and no skill closes its Task", () => {
  const skill = readFileSync(join(skills, "task-to-pr", "SKILL.md"), "utf8");
  const rule = skill.slice(skill.indexOf("## 概要 / Summary"));
  expect(rule).toContain("「していない」の行（後回しの検証を含む");
  expect(skill).toContain("後回し・改変した検証の書き方は「レビュアーへ」の「検証」と「対応表」");
  expect(rule).toContain("マージの後に書く結果コメントの行は「マージ後」と書き、数えない");
  expect(rule).toContain("`Closes` ではなく `Refs #<Task>` にし、残りの手順を Task にコメントする");
  expect(rule).toContain("利用者の判断を待つ Task（`**進め方**: 止めて待つ` の `## 判断待ち` に回答が無い、`（利用者確認: …）` の行が残る）の PR は");
  expect(rule).toContain("`**進め方**: 推奨で進める` の問いだけなら、推奨の案で終えたものとして `Closes` にする");
  expect(skill).toContain("未実施の手順が残る PR は `Refs #N`");
  const close: [string, string][] = [
    ["review-triage-and-merge", "PR が `Refs #<Task>` なら、Task に途中経過のコメント（マージした PR と残りの手順）を書き、Status を `In review` から `In progress` に戻して閉じない"],
    ["pbi-complete", "PR が `Refs #<Task>` の Task は閉じず、Status を `In progress` に戻して"],
    ["issue-workflow", "手順が残る PR は `Refs #N` で、マージしても Task は閉じず"],
    ["issue-workflow", "`Refs` の PR なら（マージ + 途中経過のコメント）In progress に戻り"],
    ["issue-workflow", "`Refs #N` の PR では結果コメントは途中経過（マージした PR と残りの手順）にし、Status は In review から In progress に戻す（Done にしない）"],
    ["stacked-pr-delivery", "手順が残る PR は `Refs #N`"],
  ];
  for (const [name, text] of close) expect(readFileSync(join(skills, name, "SKILL.md"), "utf8")).toContain(text);
  for (const file of [".github/PULL_REQUEST_TEMPLATE.md", "ops-kit/template/.github/PULL_REQUEST_TEMPLATE.md"]) {
    expect(readFileSync(join(import.meta.dir, "../..", file), "utf8")).toContain("Task の手順が残るなら `Refs #<Task番号>`");
  }
});

/** cross-runner-review's step 1 TASK lines, run as written on a PR body. */
function readTask(body: string) {
  const lines = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8").split("\n");
  const from = lines.findIndex((l) => l.startsWith("TASK=$(tr"));
  const to = lines.findIndex((l, i) => i > from && l.startsWith("TASK=$(echo"));
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const dir = mkdtempSync(join(tmpdir(), "skills-task-"));
  try {
    mkdirSync(join(dir, "_review"));
    writeFileSync(join(dir, "_review", "pr.md"), body);
    const run = spawnSync("bash", ["-c", `M=${dir}/_review\n${lines.slice(from, to + 1).join("\n")}\necho "$TASK"`], { encoding: "utf8" });
    return run.stdout.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("cross-runner-review: step 1 reads the Task from a PR that says only Refs #N", () => {
  expect(readTask("# PR #1 t\n\nRefs #12。残りは次の PR\n")).toBe("12");
  expect(readTask("Refs #12\nCloses #7\n")).toBe("7");
  expect(readTask("Backlog-Task: 5\n")).toBe("5");
});

test("task-to-pr: the PR body's verification checks only what has a result, names where a deferred one goes, and does not count a pass of an altered check", () => {
  const skill = readFileSync(join(skills, "task-to-pr", "SKILL.md"), "utf8");
  const template = skill.slice(skill.indexOf("## レビュアーへ"), skill.indexOf("## 概要 / Summary"));
  const check = template.split("\n").find((l) => l.startsWith("- 検証:")) ?? "";
  expect(check).toContain("結果の無い検証にはチェックを付けない");
  expect(check).toContain("手で変えて（コマンド・場面・データを改めて）走らせた pass は Task の検証の pass と数えず、変えた点を書く");
  const table = template.split("\n").find((l) => l.startsWith("- 対応表:")) ?? "";
  expect(table).toContain("後回しにした検証は後回し先（例: 「PBI の最後」）を書く");
  expect(table).toContain("対応するテストの場面（テスト名かコマンド）");
  expect(skill).toContain("「していない」の行（後回しの検証を含む");
});

test("task-to-pr: raising a performance ceiling named in CLAUDE.md gives the reason and the increase, and is the user's call", () => {
  const skill = readFileSync(join(skills, "task-to-pr", "SKILL.md"), "utf8");
  const heading = skill.split("\n").find((l) => l.startsWith("## チェックリスト / Checklist")) ?? "";
  expect(heading).toContain("性能の上限を上げた PR は、上げた項目ごとに理由と増分（前 → 後、%）を本文に書く");
  expect(heading).toContain("上げるのは利用者の判断なので、マージの前に聞く");
  expect(heading).toContain("理由をコミットにだけ書かない");
  const workflow = readFileSync(join(skills, "issue-workflow", "SKILL.md"), "utf8");
  expect(workflow).toContain("- [ ] 性能の上限のファイルと、上げるときの規則の文書（あれば）");
});

function triageStep3(): string {
  const skill = readFileSync(join(skills, "review-triage-and-merge", "SKILL.md"), "utf8");
  return skill.slice(skill.indexOf("## 3. 直す"), skill.indexOf("## 4. 返信する"));
}

test("review-triage-and-merge: each fixed finding's Scenario is reproduced before asking for the follow-up review", () => {
  const step3 = triageStep3();
  const at = step3.indexOf("指摘の `Scenario:`（入力・状態）を再現して直ったことを確かめる");
  expect(at).toBeGreaterThan(-1);
  const paragraph = step3.slice(at, step3.indexOf("\n", at));
  expect(paragraph).toContain("修正前に fail を見たもの");
  expect(paragraph).toContain("Scenario の入力・状態を再現したコマンドと出力");
  expect(paragraph).toContain("`path:line` を読み直した結果");
  expect(paragraph).toContain("見直しを頼まずに直し続ける");
  expect(step3.indexOf("見直しを頼む前に、修正した指摘ごとに")).toBeLessThan(step3.indexOf("`cross-runner-review` の 4"));
});

test("review-triage-and-merge: a fix reply names the commit and how it was checked", () => {
  const skill = readFileSync(join(skills, "review-triage-and-merge", "SKILL.md"), "utf8");
  const line = skill.split("\n").find((l) => l.startsWith("修正: <")) ?? "";
  expect(line).toContain("<commit sha 短縮>");
  expect(line).toContain("確かめた方法: <回帰テスト名");
  expect(line).toContain("Scenario を再現したコマンドと結果");
});

test("review-triage-and-merge: a deviation in a fix is written in the PR body's 逸脱 and the PBI's decision log before the follow-up review", () => {
  const step3 = triageStep3();
  const at = step3.indexOf("修正が Task の手順・受け入れ条件から外れたら");
  expect(at).toBeGreaterThan(-1);
  const paragraph = step3.slice(at, step3.indexOf("\n", at));
  expect(paragraph).toContain("見直しの前に PR 本文の「逸脱」の項");
  expect(paragraph).toContain("ops-kit backlog comment <Task>");
  expect(paragraph).toContain("ops-kit backlog edit <PBI>");
  expect(paragraph).toContain("日付つきで 1 行");
});

test("cross-runner-review: the follow-up review re-reads the PR body, which the fix wrote first", () => {
  expect(triageStep3()).toContain("gh pr edit");
  const review = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const step4 = review.slice(review.indexOf("## 4. 修正後の見直し"), review.indexOf("## 報告"));
  expect(step4).toContain('> "$M/pr.md"');
  expect(step4).toContain("gh pr view $N --json number,title,body,url");
  // ローカルの変更（PR の無い workspace）でも、見直しの前に本文を直して取り直す
  expect(triageStep3()).toContain("ops-kit backlog edit <変更> --body-file");
  expect(triageStep3()).toContain("ops-kit backlog view <変更> --json` の `.issue.body`");
  const local = review.slice(review.indexOf("**ローカルの変更では**"), review.indexOf("レビュー指示（"));
  expect(local).toContain('`ops-kit backlog view <変更> > "$M/pr.md"`（4 の見直しの前にも同じ行で取り直す）');
});

test("cross-runner-review: a follow-up round's request (4 and 2b's attack) says it is one, in the word the rules' Follow-up rounds section answers to", () => {
  // the section takes effect only when the instructions say so: a rewording that drops the word leaves it silent
  const section = REVIEW_RULES.split("\n").find((l) => l.startsWith("Follow-up rounds."));
  expect(section).toContain("When the instructions say this round is a follow-up");
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  for (const task of ["in", "out"] as const) {
    for (const reviewer of ["codex", "claude"] as const) {
      const conds = { runner: reviewer, review: "same", recheck: "same", reviewer, task, backlog: "github", mergeGate: "on", extra: "off" } as const;
      const copy = renderConditions(text, conds, "cross-runner-review").split("\n");
      const from = copy.findIndex((l) => l.startsWith('{ cat "$M/prompt.md"'));
      const to = copy.findIndex((l, i) => i >= from && l.endsWith('> "$M/prompt-fix.md"'));
      expect({ task, reviewer, from: from > -1, to: to >= from }).toEqual({ task, reviewer, from: true, to: true });
      const block = copy.slice(from, to + 1).join("\n");
      // 2b asks its attack follow-up with 4's block and the names it swaps
      const attackLine = copy.find((l) => l.startsWith("- 4 の修正後の見直しと同じく"));
      expect(attackLine).toBeDefined();
      expect(attackLine).toContain("follow-up");
      expect(attackLine).toContain("Follow-up rounds");
      const swaps = [...attackLine!.matchAll(/`([\w.-]+\.md)`→`([\w.-]+\.md)`/g)].map((m) => [m[1]!, m[2]!] as const);
      expect(swaps.map(([a]) => a)).toEqual(["prompt.md", "prompt-fix.md"]);
      const attackBlock = swaps.reduce((b, [a, z]) => b.replaceAll(`$M/${a}`, `$M/${z}`), block);
      const dir = mkdtempSync(join(tmpdir(), "follow-up-round-"));
      try {
        writeFileSync(join(dir, "prompt.md"), "Review this PR.\n");
        writeFileSync(join(dir, "attack-prompt.md"), "Attack this PR.\n");
        for (const [script, out, first] of [[block, "prompt-fix.md", "Review this PR."], [attackBlock, "attack-prompt-fix.md", "Attack this PR."]] as const) {
          const run = spawnSync("bash", ["-c", `M=${dir} OLD=abc123 PREV=_review/previous.md\n${script}`], { encoding: "utf8" });
          expect(run.status).toBe(0);
          const instructions = readFileSync(join(dir, out), "utf8");
          expect(instructions.startsWith(first)).toBe(true);
          const asked = instructions.slice(first.length);
          // the round says it is a follow-up, points at the section, and says the round's job
          expect({ task, reviewer, out, says: /this is a follow-up round/i.test(asked) }).toEqual({ task, reviewer, out, says: true });
          expect(asked).toContain("Follow-up rounds");
          expect(asked).toContain("abc123");
          expect(asked).toContain("_review/previous.md");
          expect(asked).toContain("earlier findings closed");
          expect(asked).toContain("new problems");
          expect(asked).toContain("_review/fix.range-diff");
          // what the reviewer gets: the request, then the rules with the section it names
          expect(reviewPrompt(instructions, reviewer)).toContain(section!);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test("task-to-pr / pbi-complete: a failure that also fails on the base goes to a request, a P1 PBI and a registry PR without asking for a merge approval", () => {
  const toPr = readFileSync(join(skills, "task-to-pr", "SKILL.md"), "utf8");
  const at = toPr.indexOf("**ローカル CI が登録に無い失敗で落ち、base でも落ちると確かめたら**");
  expect(at).toBeGreaterThan(-1);
  const paragraph = toPr.slice(at, toPr.indexOf("\n", at));
  for (const word of ["要望", "P1 以上の PBI", "登録に期限つきで足す PR", "承認を利用者に求めない", "base に登録を届かせてから", "ローカル CI を頼み直す"]) expect(paragraph).toContain(word);
  const complete = readFileSync(join(skills, "pbi-complete", "SKILL.md"), "utf8");
  expect(complete).toContain("`task-to-pr` の「ローカル CI が登録に無い失敗で落ち、base でも落ちると確かめたら」の項に従う（承認は求めない）");
});

test("skills: doc-to-slides keeps the user's rules and its template keeps the phone reading mode, notes and print", () => {
  const text = readFileSync(join(skills, "doc-to-slides", "SKILL.md"), "utf8");
  for (const word of ["**構成**", "**余計なことを書かない**", "**文章量**", "**決めていないことを決めない**", "**スマホで見られる**", "**資料側の決まりを当てる**", "template.html", "?read=1", "1280x720"]) expect({ word, says: text.includes(word) }).toEqual({ word, says: true });
  const html = readFileSync(join(skills, "doc-to-slides", "template.html"), "utf8");
  for (const part of ["#deck{width:1280px;height:720px;position:relative;transform-origin:center center;flex:none}", "body.read .slide{", "q.has('read')", "data-notes=", "requestFullscreen", "touchend", "@media print", "break-after:page", "beforeprint"]) expect({ part, has: html.includes(part) }).toEqual({ part, has: true });
  expect(html).toContain("#hud,#bar,#notes,#help,#mode{display:none!important}"); // the mode button does not print
  expect(html).not.toContain("localStorage"); // the mode follows the screen or ?read=, not a value saved by an earlier deck
  expect(html).not.toMatch(/base64,[A-Za-z0-9+/=]{100,}/); // no image of the talk the template was taken from
});

test("pbi-complete: resuming recreates the PBI worktree with step 3's worktree add when the cleanup removed it", () => {
  const text = readFileSync(join(skills, "pbi-complete", "SKILL.md"), "utf8");
  const heading = "## 途中で止まったとき（再開）";
  const start = text.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = text.indexOf("\n## ", start + heading.length);
  const section = text.slice(start, next < 0 ? undefined : next);
  expect(section).toContain("git worktree add --detach <PBI の worktree> origin/main");
});

/** The rows of the inventory table in docs/design/skill-sync.md (`## Conditional text inventory`): where the skills' text depends on a condition. */
function inventory(): Array<{ keys: string[]; file: string; phrase: string; side: string[]; decision: string }> {
  const repo = join(import.meta.dir, "../..");
  const doc = readFileSync(join(repo, "docs/design/skill-sync.md"), "utf8");
  const section = doc.slice(doc.indexOf("## Conditional text inventory"));
  const table = section.slice(0, section.indexOf("\n## ", 3)).split("\n").filter((l) => l.startsWith("| `"));
  return table.map((row) => {
    const cells = row.split(" | ").map((c) => c.replace(/^\| /, "").replace(/ \|$/, "").trim());
    const code = (c: string) => c.replace(/^`/, "").replace(/`$/, "");
    return { keys: code(cells[0]!).split("+"), file: code(cells[1]!), phrase: code(cells[2]!), side: code(cells[3]!).split("+"), decision: cells[4]! };
  });
}
const skillFile = (name: string) => `ops-kit/skills/${name}/SKILL.md`;

test("skills: every row of the conditional text inventory opens with grep", () => {
  const repo = join(import.meta.dir, "../..");
  const rows = inventory();
  expect(rows.length).toBeGreaterThan(50);
  // every skill with a mark has rows, and every decision is one of the two
  for (const name of readdirSync(skills)) {
    const marked = readFileSync(join(skills, name, "SKILL.md"), "utf8").includes("<!-- when ");
    expect({ name, listed: !marked || rows.some((r) => r.file === skillFile(name) && r.decision === "split") }).toEqual({ name, listed: true });
  }
  for (const r of rows) {
    expect(["split", "keep"]).toContain(r.decision);
    expect({ file: r.file, phrase: r.phrase, found: readFileSync(join(repo, r.file), "utf8").includes(r.phrase) }).toEqual({ file: r.file, phrase: r.phrase, found: true });
  }
});

test("skills: a conditional phrase outside a when block is in the inventory", () => {
  const keep = inventory().filter((r) => r.decision === "keep");
  const missing: string[] = [];
  for (const name of readdirSync(skills)) {
    for (const hit of unmarkedConditions(readFileSync(join(skills, name, "SKILL.md"), "utf8"), skillFile(name))) {
      if (!keep.some((r) => r.file === skillFile(name) && hit.text.includes(r.phrase))) missing.push(`${skillFile(name)}:${hit.line} [${hit.key}] ${hit.text.trim().slice(0, 60)}`);
    }
  }
  // a line here is conditional text added without a mark: split it with `<!-- when … -->`, or list it as keep with the reason
  expect(missing).toEqual([]);
  // the check sees a line added outside a block
  expect(unmarkedConditions("アプリの Task の外では直接走らせる\n", "x.md").length).toBe(1);
});

test("skills: every split row of the inventory sits inside a when block", () => {
  const outside: string[] = [];
  for (const r of inventory().filter((x) => x.decision === "split")) {
    for (const k of r.keys) expect(Object.keys(CONDITION_KEYS)).toContain(k);
    const lines = parseConditions(readFileSync(join(import.meta.dir, "../..", r.file), "utf8"), r.file).filter((l) => !l.mark && l.text.includes(r.phrase));
    for (const l of lines) {
      const when = (l.when ?? {}) as Record<string, string>;
      if (!r.keys.every((k, i) => when[k] === r.side[i])) outside.push(`${r.file}:${l.line} ${r.phrase}`);
    }
  }
  expect(outside).toEqual([]);
});

// ---- one way to say an operation (runner-docs.ts): the kit's half; a repository checks its own CLAUDE.md with the same rules

const skillTexts = () => readdirSync(skills).map((name) => ({ name, path: `${name}/SKILL.md`, text: readFileSync(join(skills, name, "SKILL.md"), "utf8") }));

test("skills: no skill says the other side of an operation that is decided (working directory, who posts a review, attribution, asking, waiting, telling a Task)", () => {
  expect(skillTexts().flatMap((s) => docViolations(s.text, s.path))).toEqual([]);
});

test("skills: each rule of runner-docs catches the line it was written for and passes the decided one", () => {
  const caught = (line: string) => docViolations(line, "x").map((v) => v.split(": ")[1]!.split(" — ")[0]);
  // the lines the documents once had
  expect(caught("W=$(mktemp -d /tmp/<リポジトリ名>.pr<Task>.XXXXXX)")).toEqual(["working directory"]);
  expect(caught("description: サブエージェントへレビューをさせ、PR にインラインコメントを投稿させ、")).toEqual(["who posts a review"]);
  expect(caught("4. レビュー: PR ごとにサブエージェントを起動しコメントさせる。")).toEqual(["who posts a review"]);
  expect(caught("🤖 Generated with [Claude Code](https://claude.com/claude-code)")).toEqual(["attribution line"]);
  expect(caught("解釈メモに前提を書いて進む（`AskUserQuestion` は届かない）")).toEqual(["asking"]);
  expect(caught("このブロックは 1 回の Bash の呼び出しで、バックグラウンド（`run_in_background`）で回す")).toEqual(["waiting"]);
  expect(caught("`BACKLOG_URL` があれば（エージェント管理アプリの Task の中）アプリの保存値を読み書きし")).toEqual(["telling a Task"]);
  // the decided ones
  for (const line of [
    'W=$(mktemp -d "${TMPDIR:-/tmp}/<リポジトリ名>.pr<Task>.XXXXXX")',
    "W=$(mktemp -d)",
    "レビュアーは PR に書かず、自分が接頭辞つきで転記する",
    "末尾の帰属の行は、そのときランナーが受けている指示に従う",
    "質問ツール（`AskUserQuestion`）を 1 回呼び、",
    "背景の `sleep` や `run_in_background` の待ちのループで待たない",
    "直接走らせるとき（アプリの Task の外）はバックグラウンドで始めてよい（Bash の `run_in_background`）",
    "エージェント管理アプリの Task として起動されたなら（見分け方は CLAUDE.md）、main の作業ツリーには触らない",
    "`BACKLOG_URL`（アプリが Task に渡す）があればアプリの保存値を読み書きし",
  ]) expect({ line, caught: caught(line) }).toEqual({ line, caught: [] });
  expect(DOC_RULES.map((r) => r.name)).toEqual(["working directory", "who posts a review", "attribution line", "asking", "waiting", "telling a Task"]);
});

test("skills: a working directory is made by one form both runners can run (no mktemp -d /tmp/)", () => {
  const all = skillTexts();
  expect(all.length).toBe(11);
  expect(all.filter((s) => s.text.includes("mktemp -d /tmp/")).map((s) => s.name)).toEqual([]);
  // the form itself, wherever a skill names a directory under the shared temp
  const made = all.flatMap((s) => [...s.text.matchAll(/mktemp -d ("[^"]*"|\S+)/g)].map((m) => m[1]!)).filter((arg) => !/^[…)`]/.test(arg));
  expect(made.length).toBeGreaterThan(8);
  for (const arg of made) expect(arg.startsWith('"${TMPDIR:-/tmp}/')).toBe(true);
});

test("skills: a reviewer writes only its file and the implementer posts it with a prefix (no skill has the reviewer post)", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  for (const name of ["stacked-pr-delivery", "review-with-subagent"]) for (const word of ["投稿させ", "コメントさせ"]) expect({ name, word, has: read(name).includes(word) }).toEqual({ name, word, has: false });
  const sub = read("review-with-subagent");
  const prompt = sub.slice(sub.indexOf("プロンプトの骨子:"), sub.indexOf("## 転記"));
  expect(prompt).toContain("do not post to the PR");
  for (const word of ["gh pr comment", "pulls/N/comments"]) expect(prompt).not.toContain(word);
  expect(sub).toContain("post_review <PR> subagent <出力のパス>");
  expect(sub.split("\n")[2]).toContain("自分が `[subagent]` の接頭辞つきで PR に転記し");
  // the function it points at is where it says
  expect(read("cross-runner-review")).toContain("post_review() { # <pr> <who> <file>");
  expect(read("stacked-pr-delivery")).toContain("どちらもレビュアーは PR に書かず、自分が接頭辞つきで転記する");
});

test("skills: no skill fixes one runner's attribution line", () => {
  for (const s of skillTexts()) for (const word of ["Generated with", "Claude-Session", "Co-Authored-By"]) expect({ name: s.name, word, has: s.text.includes(word) }).toEqual({ name: s.name, word, has: false });
  for (const name of ["task-to-pr", "stacked-pr-delivery"]) expect(readFileSync(join(skills, name, "SKILL.md"), "utf8")).toContain("末尾の帰属の行は、そのときランナーが受けている指示（帰属の行の指定）に従う。無ければ書かない");
});

test("skills: asking — no skill says the question tool does not reach a Task, and the 運用の確認 section calls it", () => {
  for (const s of skillTexts()) expect(docViolations(s.text, s.path).filter((v) => v.includes(": asking — "))).toEqual([]);
  const rules = readFileSync(join(skills, "issue-workflow", "SKILL.md"), "utf8");
  const section = rules.slice(rules.indexOf("#### 運用の確認（Task の会話で聞く）"));
  expect(section.slice(0, 400)).toContain("質問ツール");
  expect(readFileSync(join(skills, "request-to-backlog", "SKILL.md"), "utf8")).toContain("質問ツールは運用の確認だけ: `issue-workflow` の「運用の確認」");
});

test("skills: waiting — a line that waits with run_in_background or a sleep loop says it is outside the app's Task or names why it runs directly", () => {
  for (const s of skillTexts()) expect(docViolations(s.text, s.path).filter((v) => v.includes(": waiting — "))).toEqual([]);
  const gate = readFileSync(join(skills, "public-release-gate", "SKILL.md"), "utf8").split("\n").find((l) => l.includes("`run_in_background`"))!;
  expect(gate).toContain("ゲートは `ops-kit job` の仕事の種類に無いので");
  expect(gate).toContain("直接回す");
});

test("skills: the other contradictions stay on one side (reviewer at its limit, when to switch to local CI, auto-close, the Project)", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  // a reviewer at its limit is replaced at once (cross-runner-review, 0), not planned around
  expect(read("pbi-complete")).not.toContain("計画に入れる");
  expect(read("pbi-complete")).toContain("レビューは `cross-runner-review` の 0 のとおり待たずに代替する");
  // local CI: also when there is no run at all (Actions turned off by a variable), not only a run that never starts
  expect(read("pbi-complete")).toContain("run が無い・全部 skip（Actions を変数で止めたリポジトリ）なら待たずローカル CI");
  for (const name of ["pbi-complete", "review-triage-and-merge"]) expect(read(name)).not.toContain("請求の問題");
  // a Task closes when its PR lands on the default branch; nobody says it always does or that it is fine to leave
  expect(read("issue-workflow")).not.toContain("自動 close される（それで良い）");
  expect(read("issue-workflow")).toContain("PR が既定の枝に入ったマージで `Closes #N` の Task が閉じる");
  expect(read("review-triage-and-merge")).toContain("Task は PR が既定の枝に入ったマージで閉じる");
  // who adds a new Issue to the Project depends on where the command runs: each side says its own
  const lines = parseConditions(read("issue-workflow"), "issue-workflow").filter((l) => l.text.includes("--field が無いと Project に入らない"));
  expect(lines.map((l) => l.when)).toEqual([{ task: "out" }]);
});

test("skills: the three flow skills say what to do while GitHub cannot be used and when it is back, and never a forced push", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  for (const name of ["task-to-pr", "review-triage-and-merge", "pbi-complete"]) {
    const text = read(name);
    expect(text).toContain("**GitHub が使えないときは**");
    expect(text).toContain("<GitHub 不在の切り替え>");
    // neither spelling of a push that drops commits
    expect(text).not.toContain("--force");
    expect(text).not.toMatch(/git push[^\n`]* \+/);
  }
  // the change is numbered apart from the Issues: the kit's commands need the mark
  expect(read("task-to-pr")).toContain("`--change` を付け");
  // a change that stands in for a PR is not merged locally; a change with an ask reason waits for GitHub and goes on as a PR
  expect(read("review-triage-and-merge")).toContain("ローカルではマージされない");
  expect(read("task-to-pr")).toContain("聞く理由（`[聞く]`）のある変更はローカルではマージしない（GitHub が戻ってから PR で進める）");
  const complete = read("pbi-complete");
  for (const word of ["<GitHub への復帰> --pbi <PBI>", "<GitHub への復帰> --report", "リリースタグを打たない", "exit 4", "exit 5"]) expect(complete).toContain(word);
  // the sync PR is the only way into GitHub's main: reviewed, then merged through the gate
  expect(complete).toContain("`cross-runner-review` に通してから `<GitHub への復帰> --merge-sync <PR>`");
  expect(complete).not.toContain("直接の push を受けず");
  // a sync PR the person said yes to still goes in as a Merge commit, never by the gate's rebase merge
  expect(complete).toContain("yes の後は `--allow-large` を足して同じく `--merge-sync`");
});

test("skills: what keeps a review from going round — the conditions decided when Tasks are cut, the lists a command makes, and going back to the policy", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  // conditions across Tasks are decided before the Tasks are cut: four numbered items, one place that says which PBI it is for, one line when it is not
  const toTasks = read("pbi-to-tasks");
  const cross = toTasks.slice(toTasks.indexOf("### 3.5 またぐ条件の確認"), toTasks.indexOf("### 4. Task を切る"));
  for (const item of ["1. **守る条件**", "2. 条件ごとに、それを通る**入口の一覧**", "3. **失敗したときの扱い**", "4. 部品の間で渡す**値の意味**"]) expect(cross).toContain(item);
  expect(cross).toContain("`またぐ条件: なし（理由）` の 1 行");
  expect(toTasks.split("当たる PBI").length - 1).toBe(1);
  expect(toTasks).toContain("守る条件 1 → Task B → 証明するテスト");
  expect(toTasks).toContain("両側が偽のテストは、つないだときの条件を証明しない");
  expect(toTasks).toContain("守る条件に、担う Task と証明するテストの割り当てが無いまま Ready にする");
  expect(read("request-to-backlog")).toContain("**信頼の境界を変える PBI**");
  // the Task's line reaches the implementer, the template and the reviewer
  for (const text of [toTasks, read("issue-workflow"), readFileSync(join(skills, "../template/.github/ISSUE_TEMPLATE/task.yml"), "utf8")]) expect(text).toContain("守る条件: なし");
  const review = read("cross-runner-review");
  expect(review).toContain("Conditions to keep: when the PBI's 決定ログ lists 守る条件");
  // the lists are made by the kit's commands, and how a reviewer uses them is not written in the skill a second time
  for (const cmd of ['ops-kit review-handled $N --kind "$KIND" > "$M/handled.md"', 'ops-kit review-handled $N --kind review > "$M/handled.md"', 'ops-kit old-paths check "origin/$BASE_REF" "$M/pr.md"']) expect(review).toContain(cmd);
  expect(review).toContain("### Read outside the diff");
  for (const rule of ["- blocker:", "the arbiter rules on it by the written rules", "Repeat of:"]) {
    expect(REVIEW_RULES).toContain(rule);
    expect({ rule, inSkill: review.includes(rule) }).toEqual({ rule, inSkill: rule === "Repeat of:" });
  }
  for (const name of ["task-to-pr", "pbi-to-tasks", "review-triage-and-merge"]) expect(read(name)).toContain("ops-kit old-paths list");
  expect(read("task-to-pr")).toContain(`- ${OLD_PATHS_ITEM}（語: `);
  expect(read("task-to-pr")).toContain("受け取る Task の本文に書く");
  expect(read("task-to-pr")).toContain("その環境・道に入っていることをテストの中で断言する");
  // a point raised again after its fix: back to the policy before the next fix, reachable from the unattended flow
  const triage = read("review-triage-and-merge");
  const again = triage.slice(triage.indexOf("### 同じ論点が続いたら（直す前に）"), triage.indexOf("### 修正する"));
  for (const word of ["同じ形にできるならそうする", "PBI の決定ログに書く", "Task の手順を方針（裁定が `[reviewer]` ならその裁定）に合わせて直す", "回数では止めない", "`Repeat of:`"]) expect(again).toContain(word);
  expect(read("pbi-complete").split("「同じ論点が続いたら」").length - 1).toBe(2);
  expect(again).not.toContain("`## 判断待ち` を出して止める");
  // nits left as they are: one table in the summary the handled list picks up by its heading
  expect(triage).toContain("| 見送った nit・question（[レビュアー] `path:line` と 1 文の引用） | 根拠 |");
  expect(triage).toContain(`1 行目は必ず \`${TRIAGE_HEADING}\``);
  expect(triage).toContain("読み手: <変わらない / n か所と結果>");
  expect(read("review-with-subagent")).toContain("ops-kit review-note rules");
  // waiting goes through the kit's command
  expect(read("issue-workflow")).toContain("**待つのは `ops-kit wait` で、素のループで待たない**");
});

test("skills: a PBI that raises or lowers a review rule carries the rounds table row, and no number means no Ready (往復の表)", () => {
  const section = (name: string, heading: string) => {
    const text = readFileSync(join(skills, name, "SKILL.md"), "utf8");
    const start = text.indexOf(heading);
    expect(start).toBeGreaterThanOrEqual(0);
    const end = text.indexOf("\n### ", start + 1);
    return text.slice(start, end < 0 ? undefined : end);
  };
  for (const [name, heading] of [["request-to-backlog", "### 3. PBI を書く"], ["pbi-to-tasks", "### 3. 設計チェック"]] as const) {
    const s = section(name, heading);
    for (const word of ["往復の表", "安全の側なので", "念のため"]) expect({ name, word, has: s.includes(word) }).toEqual({ name, word, has: true });
  }
  const rules = readFileSync(join(skills, "issue-workflow", "SKILL.md"), "utf8");
  const owned = rules.slice(rules.indexOf("## 使う側のリポジトリが持つもの"), rules.indexOf("\n## ", rules.indexOf("## 使う側のリポジトリが持つもの") + 1));
  expect(owned).toContain("往復の表");
});

test("skills: the user's mark and the split of instruction-file Tasks are written down (利用者の決まりの印・指示のファイルの Task)", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  const rules = read("issue-workflow");
  expect(rules).toContain("括弧の中に `YYYY-MM-DD の利用者の指摘|決定|指示`（この形だけ）");
  expect(rules).toContain("利用者の文を引けない行（エージェントが足した決まり）には付けない");
  expect(rules).toContain("`instructions` の理由");
  const split = read("pbi-to-tasks");
  expect(split).toContain("それだけの Task に分ける");
  expect(split).toContain("`[分ける]`");
  expect(split).toContain("`instructions`");
  expect(read("task-to-pr")).toContain("「ついでの整合」をしない");
});

test("skills: gate keys — pbi-to-tasks bars a display record or a gated side's value as a key and asks for the 鍵 section, request-to-backlog puts removing the mechanism among the options", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  const pbi = read("pbi-to-tasks");
  const row = pbi.indexOf("ゲートされる側が書ける値（環境変数・枝の名前・本文の印）をゲートの鍵にする");
  expect(row).toBeGreaterThanOrEqual(0);
  expect(row).toBeLessThan(pbi.indexOf("| 新しいテーブル・エンドポイント・画面 |"));
  for (const word of ["`## ゲートの鍵`", "`**鍵の変更**: あり|なし`", "`**進め方**: 止めて待つ`", "決定ログに 1 行"]) expect(pbi).toContain(word);
  expect(pbi.indexOf("### 4.5 ゲートの鍵")).toBeLessThan(pbi.indexOf("### 5. PBI を Ready にする"));
  expect(read("request-to-backlog")).toContain("「仕組みを無くす（無くすと何が起きるか）」を必ず入れる");
});

test("skills: every body save in the skills and processes passes the version it read (--rev)", () => {
  const files = [...readdirSync(skills).map((n) => join(skills, n, "SKILL.md")), join(skills, "../processes/p1-direct.md")];
  const bare: string[] = [];
  for (const f of files)
    for (const m of readFileSync(f, "utf8").matchAll(/backlog edit [^|\n`]*--body-file[^|\n`]*/g)) if (!m[0].includes("--rev")) bare.push(`${relative(skills, f)}: ${m[0].slice(0, 60)}`);
  expect(bare).toEqual([]);
  expect(files.filter((f) => readFileSync(f, "utf8").includes("二重の組")).map((f) => relative(skills, f))).toEqual([]);
});

test("issue-workflow: re-running the chained edit block keeps the original body", () => {
  const text = readFileSync(join(skills, "issue-workflow", "SKILL.md"), "utf8");
  const block = / *```bash\n( *set -euo pipefail\n[\s\S]*?) *```/.exec(text)?.[1];
  expect(block).toBeDefined();
  const script = (block as string).replaceAll("<番号か localId>", "7").replaceAll("<直す>", "sed s/A/B/");
  for (const second of ["newer", "fails"]) {
    const dir = mkdtempSync(join(tmpdir(), "skills-rerun."));
    try {
      const W = join(dir, "w");
      mkdirSync(W);
      const bin = join(dir, "bin");
      mkdirSync(bin);
      // a fake ops-kit: the first fresh view gives "## A" at r1; later fresh views give "## B" at r2 or fail; edit records its arguments
      writeFileSync(
        join(bin, "ops-kit"),
        `#!/bin/bash
if [ "$2" = edit ] || [ "$1 $2" = "backlog edit" ]; then echo "$*" >> "${dir}/edits"; exit 0; fi
if [[ " $* " == *" --fresh "* ]]; then
  n=$(cat "${dir}/fresh" 2>/dev/null || echo 0); echo $((n+1)) > "${dir}/fresh"
  if [ "$n" -ge 1 ]; then ${second === "fails" ? "exit 1" : `echo '{"issue":{"number":7,"body":"## B"},"bodyRevision":"r2"}'; exit 0`}; fi
  echo '{"issue":{"number":7,"body":"## A"},"bodyRevision":"r1"}'; exit 0
fi
echo '{"issue":{"number":7,"body":"## A"},"bodyRevision":"r1"}'
`,
        { mode: 0o755 },
      );
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, W };
      const run = () => spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
      expect(run().status).toBe(0);
      expect(readFileSync(join(W, "orig.md"), "utf8").trim()).toBe("## A");
      run();
      expect(readFileSync(join(W, "orig.md"), "utf8").trim()).toBe("## A");
      const edits = readFileSync(join(dir, "edits"), "utf8").trim().split("\n");
      expect({ second, edits: edits.map((e) => e.includes("--rev r1")) }).toEqual({ second, edits: [true, true] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
