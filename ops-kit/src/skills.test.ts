// test-reads: ops-kit/bin/ ops-kit/skills/ ops-kit/template/ ops-kit/src/cli.ts ops-kit/src/idle-run.ts
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { type Dirent, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

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
  expect(names.length).toBe(10);
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
  expect(text).toContain("CLAUDE.md が名指しし、有効の条件を満たしていれば");
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

test("cross-runner-review: OPS_KIT_REVIEW_RUNNER=same picks the same runner with its own mark; no value keeps the other runner", () => {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const chosen = "（同じランナーの別セッション。設定による選択）";
  const substitute = "（同じランナーの別セッション。<上限のランナー> が利用上限のため代替）";
  expect(text).toContain('[ "${OPS_KIT_REVIEW_RUNNER:-other}" = same ]');
  expect(text).toContain(`\`[<runner>] review${chosen}\``);
  expect(text).toContain(`\`[<runner>] review${substitute}\``);
  expect(chosen).not.toBe(substitute);
  expect(text).toContain("値が無い・`other`・それ以外の値なら、**既定の別のランナー**");
  // the 4th argument of post_review is how either mark reaches the summary's first line
  expect(text).toContain("note=${4:-}");
  expect(text).toContain("printf '[%s] review%s\\n\\n' \"$who\" \"$note\"");
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
  expect(lines[at + 1]).toStartWith('R="${REVIEW_ROOT:?}/${NAME:?}.$KIND$N";');
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
    const unset = spawnSync("bash", ["-c", once], { encoding: "utf8" }); // a new shell without REVIEW_ROOT / NAME stops instead of using /
    expect(unset.status).not.toBe(0);
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
  // a repository without a Phase leaves the argument out; an empty one is refused
  for (const name of ["request-to-backlog", "pbi-to-tasks"]) expect(read(name)).toContain("`ops-kit backlog triage <num> <area> <kind> <P0-P3>");
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

function triageStep3(): string {
  const skill = readFileSync(join(skills, "review-triage-and-merge", "SKILL.md"), "utf8");
  return skill.slice(skill.indexOf("## 3. 直す"), skill.indexOf("## 4. 返信する"));
}

test("review-triage-and-merge: each fixed finding's Scenario is reproduced before asking for the follow-up review (#3792)", () => {
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

test("review-triage-and-merge: a fix reply names the commit and how it was checked (#3792)", () => {
  const skill = readFileSync(join(skills, "review-triage-and-merge", "SKILL.md"), "utf8");
  const line = skill.split("\n").find((l) => l.startsWith("修正: <")) ?? "";
  expect(line).toContain("<commit sha 短縮>");
  expect(line).toContain("確かめた方法: <回帰テスト名");
  expect(line).toContain("Scenario を再現したコマンドと結果");
});

test("review-triage-and-merge: a deviation in a fix is written in the PR body's 逸脱 and the PBI's decision log before the follow-up review (#3588)", () => {
  const step3 = triageStep3();
  const at = step3.indexOf("修正が Task の手順・受け入れ条件から外れたら");
  expect(at).toBeGreaterThan(-1);
  const paragraph = step3.slice(at, step3.indexOf("\n", at));
  expect(paragraph).toContain("見直しの前に PR 本文の「逸脱」の項");
  expect(paragraph).toContain("ops-kit backlog comment <Task>");
  expect(paragraph).toContain("ops-kit backlog edit <PBI>");
  expect(paragraph).toContain("日付つきで 1 行");
});

test("cross-runner-review: the follow-up review re-reads the PR body, which the fix wrote first (#3792)", () => {
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
