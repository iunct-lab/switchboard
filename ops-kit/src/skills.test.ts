// test-reads: ops-kit/bin/ ops-kit/skills/ ops-kit/processes/ ops-kit/template/ ops-kit/src/cli.ts ops-kit/src/idle-run.ts docs/design/skill-sync.md CLAUDE.md
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { type Dirent, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { checkConditions, CONDITION_KEYS, parseConditions, unmarkedConditions } from "./conditions.ts";
import { REVIEW_RULES, REVIEWER_ISOLATION, REVIEWER_NOTE } from "./review-note.ts";
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
        if (REPOSITORY_SPECIFIC.test(line)) hits.push(`${name}/SKILL.md:${i + 1}: ${line.trim().slice(0, 80)}`);
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
  expect(ready).toContain("`ops-kit backlog view <PBI> --fresh --json | jq -r .issue.body");
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
  expect(sideOf("--as fallback")).toEqual(["other"]);
  // the 4th argument of post_review is how either mark reaches the summary's first line
  expect(text).toContain("note=${4:-}");
  expect(text).toContain("printf '[%s] review%s\\n\\n' \"$who\" \"$note\"");
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
  expect(REVIEWER_NOTE.codex).toContain("read-only sandbox");
  expect(REVIEWER_NOTE.claude).toContain("plan mode");
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
  expect(triageStep3()).toContain("ops-kit backlog view <変更> --json | jq -r .issue.body");
  const local = review.slice(review.indexOf("**ローカルの変更では**"), review.indexOf("レビュー指示（"));
  expect(local).toContain('`ops-kit backlog view <変更> > "$M/pr.md"`（4 の見直しの前にも同じ行で取り直す）');
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
  // a change that stands in for a PR is not merged locally, and the person's yes is not written on a change
  expect(read("review-triage-and-merge")).toContain("ローカルではマージされない");
  expect(read("task-to-pr")).toContain("`[merge-answer] yes` は変更に投稿できない");
  const complete = read("pbi-complete");
  for (const word of ["<GitHub への復帰> --pbi <PBI>", "<GitHub への復帰> --report", "リリースタグを打たない", "exit 4", "exit 5"]) expect(complete).toContain(word);
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
  for (const rule of ["- blocker:", "a reply never settles a finding by itself", "Repeat of:"]) {
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
  for (const word of ["同じ形にできるならそうする", "PBI の決定ログに書く", "`## 判断待ち` を出して止める", "Task の手順を方針に合わせて直す", "回数では止めない", "`Repeat of:`"]) expect(again).toContain(word);
  expect(read("pbi-complete").split("「同じ論点が続いたら」").length - 1).toBe(2);
  // nits left as they are: one table in the summary the handled list picks up by its heading
  expect(triage).toContain("| 見送った nit（[レビュアー] `path:line` と 1 文の引用） | 根拠 |");
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
