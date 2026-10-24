import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("skills: what must not be written to an Issue is said once, in issue-workflow, and the others point there (#661)", () => {
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

test("skills: scan-issues runs through the kit's command in every repository, not an entry (#969)", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  for (const name of readdirSync(skills)) expect({ name, skips: read(name).includes("入口が無い") }).toEqual({ name, skips: false });
  const rules = read("issue-workflow");
  const owned = rules.slice(rules.indexOf("## 使う側のリポジトリが持つもの"), rules.indexOf("\n## ", rules.indexOf("## 使う側のリポジトリが持つもの") + 1));
  expect(owned).toContain("`ops-kit <command>`");
  expect(owned).not.toContain("scan_issues.sh");
  for (const name of ["issue-workflow", "pbi-complete"]) expect({ name, says: read(name).includes("検査していない（キットが PATH に無い）") }).toEqual({ name, says: true });
});

test("skills: the main worktree is pulled by the kit's command in every repository, not by CLAUDE.md's steps (#1244)", () => {
  const read = (name: string) => readFileSync(join(skills, name, "SKILL.md"), "utf8");
  const complete = read("pbi-complete");
  expect(complete).toContain("ops-kit pull-main");
  expect(complete).not.toContain("CLAUDE.md の手順で");
  expect(complete).toMatch(/\nmain: <[^\n]*up to date/);
  const rules = read("issue-workflow");
  const owned = rules.slice(rules.indexOf("## 使う側のリポジトリが持つもの"), rules.indexOf("\n## ", rules.indexOf("## 使う側のリポジトリが持つもの") + 1));
  expect(owned).toContain("pull-main");
});

test("skills: a mechanism every repository needs goes to the shared kit, said in request-to-backlog and pointed to from pbi-to-tasks (#765)", () => {
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

test("skills: a request's 出典 says whose words it is — 利用者 only with the user's own words (誰の言葉, #1818)", () => {
  const text = readFileSync(join(skills, "request-to-backlog", "SKILL.md"), "utf8");
  expect(text).toContain("- 誰の言葉: <利用者 / エージェント / 定期の検査 のどれか 1 つ");
  expect(text).not.toContain("誰から:");
  const start = text.indexOf("#### 誰の言葉");
  expect(start).toBeGreaterThanOrEqual(0);
  const rule = text.slice(start, text.indexOf("\n#### ", start + 1));
  for (const value of ["`利用者`", "`エージェント`", "`定期の検査`"]) expect(rule).toContain(value);
  for (const word of ["利用者の文そのものを引ける場所", "「利用者が認めた」「利用者の決定」は、`利用者` の根拠にしない", "引けなければ `エージェント` にする"]) expect(rule).toContain(word);
});

test("skills: a request is checked against the repository's premises before it becomes a PBI (前提と照らす, #1819)", () => {
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

/** cross-runner-review's step 1 before the clone, run as written with /tmp moved under `root` and a fake gh / df first on PATH. */
function runCloneSweep(availKb: number) {
  const text = readFileSync(join(skills, "cross-runner-review", "SKILL.md"), "utf8");
  const lines = text.split("\n");
  const from = lines.findIndex((l) => l.startsWith("NAME="));
  const to = lines.findIndex((l, i) => i > from && l.includes("du -sk /tmp/*"));
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  const root = mkdtempSync(join(tmpdir(), "skills-sweep-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const tmp = join(root, "tmp");
  mkdirSync(tmp);
  // PR 1 merged, 2 closed, 3 open, 4: gh fails
  writeFileSync(join(bin, "gh"), `#!/bin/bash\ncase $3 in 1) echo MERGED;; 2) echo CLOSED;; 3) echo OPEN;; *) echo "not found" >&2; exit 1;; esac\n`, { mode: 0o755 });
  writeFileSync(join(bin, "df"), `#!/bin/bash\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "tmpfs 1900000 0 ${availKb} 1% /tmp"\n`, { mode: 0o755 });
  const dirs = ["app.review1.Abc123", "app.recheck2.Def456", "app.review3.Ghi789", "app.review4.Jkl012", "other.review1.Abc123", "app.reviewx.Mno345"];
  for (const d of dirs) mkdirSync(join(tmp, d));
  const block = lines.slice(from, to + 1).join("\n").replaceAll("/tmp/", `${tmp}/`); // paths only: df is faked, the STOP line keeps its words
  const run = spawnSync("bash", ["-c", `REPO=acme/app\n${block}`], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const left = readdirSync(tmp).sort();
  rmSync(root, { recursive: true, force: true });
  return { status: run.status, out: run.stdout, left };
}

test("cross-runner-review: step 1 removes only this repository's clones of merged or closed PRs (#796)", () => {
  const { status, out, left } = runCloneSweep(1_000_000);
  expect(status).toBe(0);
  expect(left).toEqual(["app.review3.Ghi789", "app.review4.Jkl012", "app.reviewx.Mno345", "other.review1.Abc123"]);
  expect(out).not.toContain("STOP:");
});

test("cross-runner-review: step 1 stops before cloning when /tmp has less than MIN_KB free (#796)", () => {
  const { out } = runCloneSweep(100);
  expect(out).toContain("STOP: /tmp の空きが 100 KB");
  expect(out).toMatch(/^\d+\t.*other\.review1\.Abc123$/m); // du's top entries are reported
});

test("skills: the review clones are removed by their own path, and a cut session's leftovers only after gh says MERGED / CLOSED (#796)", () => {
  for (const name of ["cross-runner-review", "review-triage-and-merge"]) {
    const text = readFileSync(join(skills, name, "SKILL.md"), "utf8");
    expect({ name, glob: text.includes("glob で消さない"), state: text.includes("MERGED / CLOSED") }).toEqual({ name, glob: true, state: true });
  }
});

test("skills: public-release-gate runs both runners apart with the seeds, the models and the three-way triage (#1727)", () => {
  const text = readFileSync(join(skills, "public-release-gate", "SKILL.md"), "utf8");
  const seeds = text.slice(text.indexOf("## 観点の種"), text.indexOf("## 指示"));
  for (const seed of ["鍵と認証の値", "個人情報", "ライセンスと NOTICE", "各ランナーと LLM 提供者の規約", "商標と名前", "依存のライセンス", "録画 fixture とテストデータ", "内部のホスト名・URL・クラウドの ID", "secrets を使う workflow", "コンテナ像と配布物", "Issue 番号の参照", "既定の設定の安全性", "同期のコミットの本文", "検査済みでも見る", "Git で管理するファイルか", "外部への通信", "検査の一覧そのもの", "運用の記録と発言の転載", "配布経路の固定", "公開側で自動で動く投稿", "製品の表示の正確さ", "伏せ字の痕跡", "隠れた内容", "ブラウザに残るデータ", "公開側の CI が確かめる範囲", "Actions のログの公開", "ホストの安全姿勢の開示", "コードに埋め込んだプロンプト", "第三者について公に述べる値", "利用者の会話・履歴の取り込みと保管", "実行可能な成果物の通信", "通知による二次開示", "バックアップの保持と削除", "移行・バックアップの完全性", "書き出すデータの境界", "二次処理と提供者間のデータ共有", "他アプリのデータの不可逆な削除", "利用者側に残る識別子"]) expect({ seed, listed: seeds.includes(`| ${seed} |`) }).toEqual({ seed, listed: true });
  expect(seeds).toContain("### 追記の記録");
  // the two runners, their models, apart and without a fallback on usage limits
  for (const word of ["claude -p --model claude-fable-5-1", "codex exec -m gpt-6-astra", "片方の出力をもう片方の材料に入れない", "もう片方で代替せず止まる", ".message.model", "^model: ", "wait $P1; C1=$?; wait $P2; C2=$?", "grep -q '^nothing to sync'", "git log -1 --format=%B refs/public-sync/main", ".parent_tool_use_id==null", "初回の push の前"]) expect({ word, says: text.includes(word) }).toEqual({ word, says: true });
  // the report, the triage and the pass mark
  for (const word of ["[public-release-gate] <runner> <model>", "種の外は無し", "### 種の外の観点", "verdict: pass", "verdict: fail", "**直す**", "**公開側から外す**", "**受け入れる**", "**Issue（公開を止めない）**", "ランナーが付けた重さによらず", "ブロッカーが 0 件", "--resume", "順に回してよい", "## 判断待ち", "public-release-gate: pass <tree sha>", "## 観点の追記"]) expect({ word, says: text.includes(word) }).toEqual({ word, says: true });
});
