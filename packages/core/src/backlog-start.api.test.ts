// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { importing } from "../fixtures/github-import.ts";
import type { Backlog, BacklogItem, RunnerAdapter, Task } from "@switchboard/protocol";
import { type CoreServer } from "./server.ts";
import { RESUME_MARGIN_MS } from "./ratelimit.ts";
import { delegatedNote } from "./evals.ts";
import { buildDirectPrompt, buildStartPrompt, subagentModelAlias, otherRepoRules } from "./backlog-prompt.ts";
import { otherRepo } from "./server/helpers.ts";
import { canStartStoredBacklog } from "./backlog-stored.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { DECOMPOSED_READY, FAKE_ORIGIN, backlogNextSchedule, boot, closeTried, decomposedGh, fakeGh, holdingClaude, importedAs, limitedGh, metaId, openTaskAndConfirmationGh, patch, queued, refreshed, runSchedule, scheduleLogAll, start, startedTasks, threeWorkspaces, startServer, useBacklogDaemon, waitsGh } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

test("defers an automatic start at the limit: a stage button at the limit with no fallback answers with the Task made without starting, held to the reset", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const resetSec = Math.floor(Date.now() / 1000) + 3600;
  core!.db.upsertQuota("claude", "seven_day", 0.99, resetSec);
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(201);
  const task = await r.json() as Task;
  expect(task).toMatchObject({ runner: "claude", status: "idle", resumeReason: "start", resumeAt: resetSec * 1000 + RESUME_MARGIN_MS, stage: { issue: 304, action: "complete" } });
  expect(core!.db.listEvents(task.id).some((e) => e.ev.t === "status" && e.ev.text.startsWith("claude が上限（0.99、") && e.ev.text.endsWith("のため戻る時刻に開始"))).toBe(true);
  await Bun.sleep(50);
  expect(claude.starts).toHaveLength(0);
  // the held Task holds the Issue: a second start (a button, or backlog-next at its next firing) makes no second Task beside it
  const again = await start(base, 304, { action: "complete" });
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ taskId: task.id });
  expect(core!.db.stageTaskIds(metaId(), 304)).toEqual([task.id]);
});

test("start: complete on a Ready PBI creates a meta Task with the fixed /pbi-complete prompt", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(201);
  const task = await r.json() as Task;
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  expect(task.workspaceId).toBe(meta.id);
  expect(task.title.startsWith("#304 実装: ")).toBe(true);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.prompt).toContain("/pbi-complete 304");
  // the stage Task records the pipeline candidate and the stage as its reason (docs/design/process-kernel.md, K1)
  expect(await fetch(`${base}/api/tasks/${task.id}/provenance`).then((r) => r.json())).toMatchObject({ process: { id: "p0-pipeline", version: 1 }, processReason: "backlog stage complete" });
  expect(claude.starts[0]!.prompt).toContain("#304");
  expect(claude.starts[0]!.cwd).toBe(meta.path);
});

test("start: another workspace's Issue runs there, uses the skills synced into it, and names its Project variable", async () => {
  const claude = holdingClaude();
  const fake = fakeGh();
  const base = await boot(fake.gh, claude.adapter);
  const dir = mkdtempSync(join(home!, "lib-"));
  const lib = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dir, name: "lib" }) })).json()) as { id: string };
  await fetch(`${base}/api/workspaces/${lib.id}`, { method: "PATCH", body: JSON.stringify({ projectVar: "LIB_PROJECT_URL" }) });
  await refreshed(base);
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const r = await start(base, 303, { workspaceId: lib.id, action: "to-tasks" });
  expect(r.status).toBe(201);
  const task = await r.json() as Task;
  expect(task.workspaceId).toBe(lib.id);
  expect(task.title.startsWith("#303 Task に分解: ")).toBe(true);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  const s = claude.starts[0]!;
  expect(s.cwd).toBe(dir);
  expect(s.prompt).toContain(".claude/skills/pbi-to-tasks/SKILL.md に従い、PBI #303");
  expect(s.prompt).toContain("スキル（`.claude/skills/…`）は Switchboard がこのリポジトリに置いたもの");
  // the skills are no longer read from the meta workspace's path; only the scripts are
  expect(s.prompt).not.toContain("スキルとスクリプト");
  expect(s.prompt).not.toContain(`${meta.path}/.claude/skills`);
  expect(s.prompt).toContain(`スクリプト（\`scripts/…\`）はこのリポジトリには無く、Switchboard のリポジトリ ${meta.path} からの相対パス`);
  expect(s.prompt).toContain("gh variable get LIB_PROJECT_URL");
  expect(s.prompt).toContain("スキル中の「このリポジトリ」「開発リポジトリ」はこのリポジトリ"); // no repository name: the skills name none
  // a decomposition merges nothing: the merge gate, local CI and the release tag are not in its prompt
  for (const w of ["merge-gate", "local-ci", "release-tag", "rollback-pr"]) expect(s.prompt).not.toContain(w);
  // the running Task marks lib's Issue 303, not the meta's; the meta's Issue 303 can still start
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items.filter((i) => i.number === 303);
  expect(items.find((i) => i.workspaceId === lib.id)!.activeTaskId).toBe(task.id);
  expect(items.find((i) => i.workspaceId === meta.id)!.activeTaskId).toBeNull();
  expect((await start(base, 303, { workspaceId: lib.id, action: "to-tasks" })).status).toBe(409);
  expect((await start(base, 303, { action: "to-tasks" })).status).toBe(201);
  // complete on another repository is the skill file, not the slash command (which only this repository has)
  await start(base, 304, { workspaceId: lib.id, action: "complete" });
  for (let i = 0; claude.starts.length < 3 && i < 100; i++) await Bun.sleep(10);
  const complete = claude.starts.map((x) => x.prompt).find((p) => p.includes("PBI #304"))!;
  expect(complete).toContain(".claude/skills/pbi-complete/SKILL.md に従い、PBI #304");
  // without --repo the scripts' target depends on where they run (local-ci: the clone it is in, Switchboard's)
  expect(complete).toContain("`scripts/merge-gate.ts`・`scripts/parallel-guard.ts`・`scripts/local-ci.ts` の既定の対象は実行する場所");
  expect(complete).toContain("必ず `--repo <このリポジトリの owner/name>` を付けて実行し、その判定に従う");
  expect(complete).toContain(`このリポジトリの作業ツリーから \`bun ${meta.path}/scripts/local-ci.ts <PR> --repo <このリポジトリの owner/name>\` で CI を回す`);
});

describe("stage prompts by what the stage does and by runner", () => {
  const other = { meta: "/work/switchboard", projectVar: "APP_PROJECT_URL", setup: { config: true, kit: ["triage_issue.sh"], copies: [] } };
  const wheres = [{}, { other }, { other, local: true }, { other, local: true, localForge: true }, { local: true }, { local: true, localForge: true }];

  test("merge paragraphs: a stage that merges nothing is told nothing about the merge gate, local CI, release tags or rolling back", () => {
    const items = [{ number: 1 }, { number: 1, tasks: { total: 2, closed: 0 } }] as Parameters<typeof buildStartPrompt>[0][];
    for (const where of wheres) {
      for (const action of ["to-pbi", "to-tasks", "check"] as const) {
        for (const item of items) {
          const p = buildStartPrompt(item, action, where);
          for (const w of ["merge-gate", "local-ci", "release-tag", "rollback-pr", "リポジトリの PR で行う", "ローカルの「変更」"]) expect({ action, where: Object.keys(where), w, has: p.includes(w) }).toEqual({ action, where: Object.keys(where), w, has: false });
          // where the Issue is and how to write it stays
          if ("local" in where) expect(p).toContain("`ops-kit backlog`");
        }
      }
    }
    // the stages that merge keep them
    expect(buildStartPrompt({ number: 1 }, "complete", { other })).toContain("scripts/release-tag.ts");
    expect(buildStartPrompt({ number: 1 }, "complete", { other })).toContain("scripts/merge-gate.ts");
    expect(buildStartPrompt({ number: 1 }, "close", { other })).toContain("scripts/release-tag.ts");
    expect(buildStartPrompt({ number: 1 }, "complete", { local: true })).toContain("リポジトリの PR で行う");
    expect(buildStartPrompt({ number: 1 }, "complete", { local: true, localForge: true })).toContain("ローカルの「変更」");
  });

  test("runner codex: a complete names the skill's file in its own place, with no slash command and none of Claude Code's tools", () => {
    const claude = buildStartPrompt({ number: 9 }, "complete", { taskModel: "claude-sonnet-4-5", runner: "claude" });
    expect(claude.startsWith("/pbi-complete 9")).toBe(true);
    expect(claude).toContain("Agent ツールの model に `sonnet`");
    expect(claude).toContain("`run_in_background`");
    expect(buildStartPrompt({ number: 9 }, "complete", { taskModel: "claude-sonnet-4-5" })).toBe(claude); // the default is Claude Code

    for (const where of wheres) {
      for (const resume of [undefined, true as const]) {
        const codex = buildStartPrompt({ number: 9 }, "complete", { ...where, resume, taskModel: "claude-sonnet-4-5", runner: "codex" });
        for (const w of ["/pbi-complete 9", "Agent ツール", "run_in_background", ".claude/skills"]) expect({ where: Object.keys(where), w, has: codex.includes(w) }).toEqual({ where: Object.keys(where), w, has: false });
        expect(codex).toContain(".agents/skills/pbi-complete/SKILL.md に従い、PBI #9 を完了させてください。");
        expect(codex).toContain(".agents/skills/cross-runner-review/SKILL.md が渡すレビューの材料");
      }
    }
    // the person's answer is theirs: a path in it is not rewritten
    const said = buildStartPrompt({ number: 9 }, "to-tasks", { runner: "codex", answer: { issue: 9, text: ".claude/skills/pbi-to-tasks/SKILL.md を見て" } });
    expect(said).toContain(".agents/skills/pbi-to-tasks/SKILL.md に従い");
    expect(said).toContain("\n.claude/skills/pbi-to-tasks/SKILL.md を見て\n");
  });
});

test("start: check on an in-progress PBI creates a Task titled #N 状況確認 whose prompt asks for a ## 状況 comment and ## 判断待ち", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const r = await start(base, 307, { action: "check" });
  expect(r.status).toBe(201);
  expect(((await r.json()) as Task).title).toBe("#307 状況確認: PBI: Task が全部閉じた実装中の PBI");
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  const p = claude.starts[0]!.prompt;
  expect(p).toContain("PBI #307 の今の状況を確認してください");
  expect(p).toContain("Issue #307 に `## 状況` で始まるコメントを 1 件");
  for (const h of ["### 済んだこと", "### 残り", "### 止まっている理由", "### 次にやること", "## 判断待ち", "## 回答"]) expect(p).toContain(h);
  expect(p).toContain("Issue のクローズ・Project の Status の変更はしないでください");
  // the shared ending says to follow the newest ## 回答; for a check that answer is material, not work to resume
  expect(p).toContain("これまでの `## 回答` は状況の材料として読むだけにし、その続きの作業はしないでください");
  // the running check marks the row like any stage Task
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  expect(items.find((i) => i.number === 307)!.activeTaskId).toBeString();
});

test("start: a local backlog's stage prompt says ops-kit backlog only, no gh issue / scripts/setup", () => {
  const other = { meta: "/work/switchboard", projectVar: "APP_PROJECT_URL", setup: { config: true, kit: ["triage_issue.sh"], copies: ["lint_backlog.sh"] } };
  for (const action of ["to-pbi", "to-tasks", "complete", "check", "close"] as const) {
    for (const p of [buildStartPrompt({ number: 1 }, action, { other, local: true }), buildStartPrompt({ number: 1 }, action, { local: true })]) {
      expect(p).toContain("#1 はこの workspace の Switchboard のバックログの Issue です（GitHub には無い）");
      expect(p).toContain("`ops-kit backlog`");
      expect(p).toContain("`ops-kit lint --fresh`");
      expect(p).toContain("`--repo` を付けずに実行する");
      // the PR names the Task without a closing keyword or #N (it is no GitHub Issue), and the Task is closed by hand after the merge: for the stages that make one
      expect(p.includes("Backlog-Task: <番号>")).toBe(action === "complete" || action === "close");
      expect(p.includes("`ops-kit backlog edit <Task> --state closed`")).toBe(action === "complete" || action === "close");
      // nothing that sends it to GitHub's Issues or Project
      expect(p).not.toContain("gh repo view");
      expect(p).not.toContain("gh variable get");
      expect(p).not.toContain("APP_PROJECT_URL");
      expect(p).not.toMatch(/(?<!`)scripts\/setup\/(?!\*)/);
    }
  }
  // the PR side stays: merge gate, local CI, the release tag and the rollback, with the repository named
  const complete = buildStartPrompt({ number: 1 }, "complete", { other, local: true });
  for (const kept of ["scripts/merge-gate.ts", "scripts/local-ci.ts", "scripts/release-tag.ts", "scripts/rollback-pr.ts", "docs/merge-gate.md"]) expect(complete).toContain(kept);
  // a GitHub one is as before
  expect(buildStartPrompt({ number: 1 }, "complete", { other })).toContain("`gh repo view` が答えるもの");
  expect(buildStartPrompt({ number: 1 }, "complete", { other })).toContain("APP_PROJECT_URL");
});

test("start: a local workspace without a remote (localForge) gets local changes, not PRs", () => {
  const other = { meta: "/work/switchboard", projectVar: "APP_PROJECT_URL", setup: { config: true, kit: ["triage_issue.sh"], copies: ["lint_backlog.sh"] } };
  for (const [p, scripts] of [[buildStartPrompt({ number: 1 }, "complete", { other, local: true, localForge: true }), "/work/switchboard/"], [buildStartPrompt({ number: 1 }, "complete", { local: true, localForge: true }), ""]] as const) {
    // the backlog half stays
    expect(p).toContain("`ops-kit lint --fresh`");
    expect(p).toContain("`--repo` を付けずに実行する");
    // changes, not PRs
    expect(p).toContain("この workspace の変更はアプリに置く（リモートは使わない）");
    // a recheck is asked of the app as a job on the change; the gate reads the job's record, not a comment
    expect(p).toContain(`${scripts}docs/merge-gate.md` + "\` の「Recheck」");
    expect(p).toContain("\`ops-kit job request review <変更> --change --as arbiter --prompt <指示> --out <出力>\`");
    expect(p).toContain("--head <枝> --base main");
    expect(p).toContain("Backlog-Task: <Task>");
    // local CI is asked of the app as a job: the gate counts only the job's record, not a run from the shell
    expect(p).toContain("\`ops-kit job request local-ci <変更> --change\`");
    expect(p).not.toContain("scripts/local-ci.ts --change");
    for (const cmd of [`bun ${scripts}scripts/merge-gate.ts --change <変更>`, `bun ${scripts}scripts/local-merge.ts <変更>`]) expect(p).toContain(cmd);
    expect(p).not.toContain("PR・レビュー・CI・マージはリポジトリの PR で行う");
    expect(p).not.toContain("release-tag.ts");
    expect(p).not.toContain("rollback-pr.ts");
    expect(p).not.toContain("--repo <このリポジトリの owner/name>");
    expect(p).not.toMatch(/gh pr (?:create|merge|comment)/);
  }
  // without it, as before
  expect(buildStartPrompt({ number: 1 }, "complete", { local: true })).toContain("PR・レビュー・CI・マージはリポジトリの PR で行う");
});

test("start: check on a stage other than in-progress is 409", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  for (const n of [306, 304, 303, 302]) expect((await start(base, n, { action: "check" })).status).toBe(409);
  expect(core!.db.listTasks()).toHaveLength(0);
});

test("start: complete on an in-progress item resumes it", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const r = await start(base, 305, { action: "complete" });
  expect(r.status).toBe(201);
  expect(((await r.json()) as Task).title.startsWith("#305 実装: ")).toBe(true);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  // the same Task backlog-next starts for a stalled in-progress PBI: the closed Tasks when it was chosen
  expect(claude.starts[0]!.prompt).toBe(buildStartPrompt({ number: 305 }, "complete", { resume: true }));
  expect(claude.starts[0]!.prompt).toContain("PBI #305 は実装中のまま止まっています");
});

test("complete task model: with a model chosen the 実装 Task's prompt hands each Task to a sonnet subagent and the transcript says so; another kind gets neither (同じ: the existing complete tests' prompts)", async () => {
  const c2 = holdingClaude();
  const base2 = await boot(fakeGh().gh, { ...c2.adapter, models: [{ value: "claude-sonnet-5-5", label: "Sonnet 5.5" }] });
  const notes = (id: string) => core!.db.listEvents(id).flatMap((e) => (e.ev.t === "status" ? [e.ev.text] : []));
  expect((await fetch(`${base2}/api/settings`, { method: "PATCH", body: JSON.stringify({ autoStart: { completeTaskModel: "claude-sonnet-5-5" } }) })).status).toBe(200);
  const r = await start(base2, 305, { action: "complete" });
  expect(r.status).toBe(201);
  const t = (await r.json()) as Task;
  for (let i = 0; !c2.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(c2.starts[0]!.prompt).toBe(buildStartPrompt({ number: 305 }, "complete", { resume: true, taskModel: "claude-sonnet-5-5" }));
  expect(c2.starts[0]!.prompt).toContain("Agent ツールの model に `sonnet` を指定したサブエージェントに前景で任せてください");
  expect(c2.starts[0]!.prompt).toContain("並べる順・レビューの処理・マージ判定・PBI を閉じるのはこの会話で行ってください");
  expect(c2.starts[0]!.prompt).not.toContain("試験");
  expect(notes(t.id)).toEqual([delegatedNote("claude-sonnet-5-5")]);
  // the mark reads back through the Task's evals
  expect(((await (await fetch(`${base2}/api/tasks/${t.id}/evals`)).json()) as { rules: { metrics: { delegatedModel: string | null } } }).rules.metrics.delegatedModel).toBe("claude-sonnet-5-5");
  // another kind: no paragraph, no note
  const check = await start(base2, 303, { action: "to-tasks" });
  expect(check.status).toBe(201);
  const ct = (await check.json()) as Task;
  for (let i = 0; c2.starts.length < 2 && i < 100; i++) await Bun.sleep(10);
  expect(c2.starts[1]!.prompt).not.toContain("Agent ツールの model");
  expect(notes(ct.id)).toEqual([]);
});

test("complete task model: an 実装 Task that starts on codex (its kind's runner changed after the model was saved) gets neither the paragraph nor the note", async () => {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [{ ...claude.adapter, models: [{ value: "claude-sonnet-5-5", label: "Sonnet 5.5" }] }, { ...codex.adapter, id: "codex" }]);
  const patch = (body: unknown) => fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify(body) });
  expect((await patch({ autoStart: { completeTaskModel: "claude-sonnet-5-5" } })).status).toBe(200);
  expect((await patch({ autoStart: { byKind: { complete: { runner: "codex" } } } })).status).toBe(200); // the saved model stays
  const r = await start(base, 305, { action: "complete" });
  expect(r.status).toBe(201);
  const t = (await r.json()) as Task;
  for (let i = 0; !codex.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(t.runner).toBe("codex");
  expect(codex.starts[0]!.prompt).toBe(buildStartPrompt({ number: 305 }, "complete", { resume: true, runner: "codex" }));
  expect(core!.db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text === delegatedNote("claude-sonnet-5-5"))).toBe(false);
});

test("buildStartPrompt task model: every complete entry carries the alias's paragraph; another action, an unaliased model or none leaves the prompt as before", () => {
  const para = (a: string) => `Agent ツールの model に \`${a}\` を指定したサブエージェントに前景で任せてください`;
  expect(buildStartPrompt({ number: 1 }, "complete", { taskModel: "claude-sonnet-5-5" })).toContain(para("sonnet"));
  expect(buildStartPrompt({ number: 1 }, "complete", { taskModel: "claude-opus-5-5", resume: true })).toContain(para("opus"));
  expect(buildStartPrompt({ number: 1 }, "complete", { taskModel: "claude-haiku-4-5", other: { meta: "/work/switchboard", projectVar: "APP_PROJECT_URL", setup: { config: true, kit: [], copies: [] } } })).toContain(para("haiku"));
  expect(buildStartPrompt({ number: 1 }, "complete", { taskModel: "claude-fable-5-1" })).toContain(para("fable"));
  expect(buildStartPrompt({ number: 1 }, "complete", { taskModel: "gpt-6" })).toBe(buildStartPrompt({ number: 1 }, "complete"));
  expect(buildStartPrompt({ number: 1 }, "complete", { taskModel: "" })).toBe(buildStartPrompt({ number: 1 }, "complete"));
  expect(buildStartPrompt({ number: 1 }, "to-tasks", { taskModel: "claude-sonnet-5-5" })).toBe(buildStartPrompt({ number: 1 }, "to-tasks"));
  expect(subagentModelAlias("claude-sonnet-5-5")).toBe("sonnet");
  expect(subagentModelAlias("us.anthropic.claude-sonnet-5-5")).toBeNull();
});

test("start: complete while the in-progress item's check is running is 409 with its id", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const first = await (await start(base, 305, { action: "check" })).json() as Task;
  for (let i = 0; core!.db.getTask(first.id)?.status !== "running" && i < 100; i++) await Bun.sleep(10);
  const again = await start(base, 305, { action: "complete" });
  expect(again.status).toBe(409);
  expect((await again.json() as { taskId: string }).taskId).toBe(first.id);
  expect(core!.db.listTasks()).toHaveLength(1);
});

test("start: a second check while the first is running is 409 with its id", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const first = await (await start(base, 305, { action: "check" })).json() as Task;
  for (let i = 0; core!.db.getTask(first.id)?.status !== "running" && i < 100; i++) await Bun.sleep(10);
  const again = await start(base, 305, { action: "check" });
  expect(again.status).toBe(409);
  expect((await again.json() as { taskId: string }).taskId).toBe(first.id);
  expect(core!.db.listTasks()).toHaveLength(1);
});

test("start / answer: an unknown workspace is 404; a missing one 400", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh, holdingClaude().adapter);
  expect((await start(base, 304, { workspaceId: "ws_nope", action: "complete" })).status).toBe(404);
  expect((await fetch(`${base}/api/backlog/304/start`, { method: "POST", body: JSON.stringify({ action: "complete" }) })).status).toBe(400);
  expect((await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: "ws_nope", text: "x" }) })).status).toBe(404);
  expect(core!.db.listTasks()).toHaveLength(0);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
});

test("decision: answering another workspace's Issue is kept for that repository", async () => {
  const fake = fakeGh();
  const dir = { lib: "" };
  const gh: GhRunner = async (args, cwd) => (cwd === dir.lib && args[0] === "repo" ? { code: 0, stdout: "acme/lib true\n", stderr: "" } : fake.gh(args, cwd));
  const base = await boot(gh);
  dir.lib = mkdtempSync(join(home!, "lib-"));
  const lib = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dir.lib, name: "lib" }) })).json()) as { id: string };
  await refreshed(base);
  // as the web UI sends it (its page's origin): such an answer is kept as the screen's
  const r = await fetch(`${base}/api/backlog/306/answer`, { method: "POST", headers: { origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ workspaceId: lib.id, text: "A で" }) });
  expect(r.status).toBe(202);
  expect(core!.db.listPendingBacklogOperations().map((o) => o.repository)).toEqual(["acme/lib", "acme/lib"]);
  expect(queued()).toEqual([[306, "comment", null, { body: "## 回答\n\nA で", screen: true, heads: {} }], [306, "set", "label:needs-decision", false]]);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
});

test("start: to-tasks on a decomposed PBI asks to make it Ready", async () => {
  const claude = holdingClaude();
  const base = await boot(decomposedGh().gh, claude.adapter);
  const item = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items.find((i) => i.number === 303)!;
  expect(item).toMatchObject({ stage: "needs-tasks", tasks: { total: 2, done: 0 } });
  const task = await (await start(base, 303, { action: "to-tasks" })).json() as Task;
  // the action and the title stay to-tasks' (no new action)
  expect(task.title.startsWith("#303 Task に分解: ")).toBe(true);
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.prompt).toBe(buildStartPrompt(item, "to-tasks"));
  expect(claude.starts[0]!.prompt).toContain(DECOMPOSED_READY(303, 2));
});

test("start: the title and the skill follow the action", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  expect(((await (await start(base, 303, { action: "to-tasks" })).json()) as Task).title.startsWith("#303 Task に分解: ")).toBe(true);
  expect(((await (await start(base, 302, { action: "to-pbi" })).json()) as Task).title.startsWith("#302 PBI にする: ")).toBe(true);
  for (let i = 0; claude.starts.length < 2 && i < 100; i++) await Bun.sleep(10);
  const prompts = claude.starts.map((s) => s.prompt).join("\n----\n");
  expect(prompts).toContain(".claude/skills/pbi-to-tasks/SKILL.md に従い、PBI #303");
  expect(prompts).toContain(".claude/skills/request-to-backlog/SKILL.md に従い、既存の要望 Issue #302");
});

test("start: direct on a request starts a p1-direct Task recorded as the direct button; p0 and p1 never run together on it", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const r = await start(base, 302, { action: "direct" });
  expect(r.status).toBe(201);
  const task = await r.json() as Task;
  expect(task.title.startsWith("#302 直行で直す: ")).toBe(true);
  expect(task.stage).toEqual({ issue: 302, action: "direct" });
  expect(await fetch(`${base}/api/tasks/${task.id}/provenance`).then((r) => r.json())).toMatchObject({ process: { id: "p1-direct" }, processReason: "direct button" });
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.prompt).toBe(buildDirectPrompt({ number: 302 }, { local: false, localForge: false, answer: null }));
  expect(claude.starts[0]!.prompt).toContain("次の信号を読み、それが求める最小の変更を 1 本の PR にしてください: #302");
  // while it runs, neither PBI にする nor a second 直行 starts on the same request
  expect((await start(base, 302, { action: "to-pbi" })).status).toBe(409);
  expect((await start(base, 302, { action: "direct" })).status).toBe(409);
});

test("buildDirectPrompt: carries the screen answer as the person's words, and a local backlog's rules", () => {
  const answer = { issue: 302, text: "B: 直す — 許可: X だけ許可します" };
  const said = buildDirectPrompt({ number: 302 }, { answer });
  expect(said).toContain("利用者が画面で答えた Issue #302 の最新の回答（利用者の言葉）:\n\n````text\nB: 直す — 許可: X だけ許可します\n````");
  expect(buildDirectPrompt({ number: 302 }, { answer: { issue: 302, text: "a ```` b" } })).toContain("`````text\na ```` b\n`````");
  expect(buildDirectPrompt({ number: 302 })).not.toContain("利用者が画面で答えた");
  // a meta workspace whose backlog is kept in Switchboard: the same rules as a stage Task there (no #<n> or closing keywords in the PR)
  const local = buildDirectPrompt({ number: 302 }, { local: true });
  expect(local).toContain("#302 はこの workspace の Switchboard のバックログの Issue です（GitHub には無い）。");
  expect(local).toContain(buildStartPrompt({ number: 302 }, "to-pbi", { local: true }).split("（GitHub には無い）。")[1]!);
  expect(buildDirectPrompt({ number: 302 }, { local: true, localForge: true })).toContain(buildStartPrompt({ number: 302 }, "to-pbi", { local: true, localForge: true }).split("（GitHub には無い）。")[1]!);
  expect(buildDirectPrompt({ number: 302 })).not.toContain("GitHub には無い");
});

test("start: direct on another workspace's request starts there, with the other repository's rules", async () => {
  const claude = holdingClaude();
  const { base, ids } = await threeWorkspaces(claude.adapter);
  await refreshed(base);
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const lib = core!.db.getWorkspace(ids.lib!)!;
  const r = await start(base, 302, { workspaceId: lib.id, action: "direct" });
  expect(r.status).toBe(201);
  const task = await r.json() as Task;
  expect(task.workspaceId).toBe(lib.id);
  expect(task.stage).toEqual({ issue: 302, action: "direct" });
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  const s = claude.starts[0]!;
  expect(s.cwd).toBe(lib.path);
  const other = otherRepo(meta, lib)!;
  expect(other.meta).toBe(meta.path); // the rules below are the other repository's, not the meta workspace's own
  expect(s.prompt).toBe(buildDirectPrompt({ number: 302 }, { other, local: false, localForge: false, answer: null }));
  expect(s.prompt).toContain("#302 はこのディレクトリのリポジトリ（`gh repo view` が答えるもの）の Issue です。");
  expect(s.prompt).toContain("必ず `--repo <このリポジトリの owner/name>` を付けて実行し、その判定に従う");
  // the running Task marks lib's Issue 302 only: the meta workspace's can still start
  expect((await start(base, 302, { workspaceId: lib.id, action: "direct" })).status).toBe(409);
  expect((await start(base, 302, { action: "direct" })).status).toBe(201);
});

test("start: direct with developSelf off is 409 on the meta workspace and 201 on another", async () => {
  const claude = holdingClaude();
  const { base, ids } = await threeWorkspaces(claude.adapter);
  await refreshed(base);
  expect((await fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify({ developSelf: false }) })).status).toBe(200);
  const refused = await start(base, 302, { action: "direct" });
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain("Switchboard 自体を開発しない設定です");
  expect(core!.db.listTasks()).toHaveLength(0);
  expect((await start(base, 302, { workspaceId: ids.lib!, action: "direct" })).status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.workspaceId)).toEqual([ids.lib!]);
});

// a Release install closes only Switchboard's own folder: another repository's request still goes direct
test("start: direct on a Release install is 409 on the meta workspace and 201 on another", async () => {
  const h = mkdtempSync(join(tmpdir(), "sb-direct-release-"));
  const libDir = join(h, "lib");
  mkdirSync(libDir);
  const inner = fakeGh().gh;
  const cfg = { ...loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", SWITCHBOARD_KNOWLEDGE: join(h, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(h, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), releaseOnly: true };
  const c = await startServer(cfg, [holdingClaude().adapter], {
    port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, backlogAutoImport: true, tagCi: async () => "pass" as const,
    gh: importing(async (args, cwd) => (cwd === libDir && args[0] === "repo" ? { code: 0, stdout: "acme/lib true\n", stderr: "" } : inner(args, cwd)), () => []),
  });
  try {
    const base = `http://127.0.0.1:${c.server.port}`;
    const lib = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: libDir, name: "lib" }) })).json()) as { id: string };
    await refreshed(base);
    const meta = c.db.listWorkspaces().find((w) => w.kind === "meta")!;
    const direct = (workspaceId: string) => fetch(`${base}/api/backlog/302/start`, { method: "POST", body: JSON.stringify({ workspaceId, action: "direct" }) });
    const refused = await direct(meta.id);
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("Switchboard 自身のフォルダに Task を始められません");
    expect((await direct(lib.id)).status).toBe(201);
  } finally {
    await c.stop();
    rmSync(h, { recursive: true, force: true });
  }
});

test("buildDirectPrompt: for another repository the invariants are read from Switchboard's checkout and the repository's own rules come first", () => {
  const other = { meta: "/work/switchboard", setup: { config: false, kit: [], copies: [] } };
  const p = buildDirectPrompt({ number: 7 }, { other });
  expect(p).toContain("上の入口が指す不変条件のファイルは /work/switchboard/ops-kit/invariants.md です。");
  expect(p).toContain("このリポジトリの CLAUDE.md / AGENTS.md に書かれていればそれに従ってください。");
  expect(p).toContain("`Backlog-Task:` の行は書かず（閉じる Task が無い。ほかの番号を書くとその Issue を閉じる）、Task を閉じる手順は飛ばし、枝の `<Task>` は `sb/direct-<topic>` と読む。");
  expect(p).toContain(otherRepoRules(other, { merges: true }));
  expect(buildDirectPrompt({ number: 7 }, { other, local: true })).toContain("#7 はこの workspace の Switchboard のバックログの Issue です（GitHub には無い）。" + otherRepoRules(other, { local: true, localForge: false, merges: true }));
  // Switchboard's own workspace says none of it
  expect(buildDirectPrompt({ number: 7 })).not.toContain("/work/switchboard");
  expect(buildDirectPrompt({ number: 7 })).not.toContain("不変条件のファイルは");
});

test("buildDirectPrompt: for another repository no Switchboard-only path stands bare", () => {
  const other = { meta: "/work/switchboard", setup: { config: false, kit: [], copies: [] } };
  const p = buildDirectPrompt({ number: 7 }, { other });
  // what the entry itself says is the shared definition; the paragraphs after it are what is written for this repository
  const added = p.slice(p.indexOf("対象: #7"));
  // the absolute-path mentions go; the sentences that say what `scripts/…` means and the one that reads the scripts with `--repo` name them on purpose
  const bare = added.replace(/\/work\/switchboard\/\S*/g, "").split("。").filter((sentence) => !sentence.includes("scripts/…") && !sentence.includes("--repo")).join("。");
  expect(bare).not.toMatch(/ops-kit\/invariants\.md|docs\/merge-gate\.md|scripts\/[a-z]/);
  expect(added).toContain("/work/switchboard/ops-kit/invariants.md");
  expect(added).toContain("/work/switchboard/docs/merge-gate.md");
  expect(added).toContain("必ず `--repo <このリポジトリの owner/name>` を付けて実行し");
});

test("start: direct while PBI にする runs is 409; direct on anything but a request is 409", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  expect((await start(base, 302, { action: "to-pbi" })).status).toBe(201);
  expect((await start(base, 302, { action: "direct" })).status).toBe(409);
  for (const n of [303, 304, 306]) expect((await start(base, n, { action: "direct" })).status).toBe(409); // needs-tasks, ready, needs-decision
});

test("start: an action that does not match the stage is 409; unknown Issue 404; bad action 400", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  expect((await start(base, 303, { action: "complete" })).status).toBe(409);
  expect((await start(base, 306, { action: "to-tasks" })).status).toBe(409); // needs-decision
  expect((await start(base, 306, { action: "complete" })).status).toBe(409); // needs-decision: not a resume
  expect((await start(base, 999, { action: "complete" })).status).toBe(404);
  expect((await start(base, 304, { action: "merge" })).status).toBe(400);
  expect(core!.db.listTasks()).toHaveLength(0);
});

test("start: gh failing is 424 with the reason (not 502, which CloudFront swaps for its stopped page) and starts nothing", async () => {
  const base = await boot(fakeGh({ code: 1, stderr: "gh auth login" }).gh, holdingClaude().adapter);
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(424);
  expect((await r.json() as { error: string }).error).toContain("gh auth login");
  expect(core!.db.listTasks()).toHaveLength(0);
});

test("start: an imported workspace starts on its stored data while GitHub is at its limit with an edit not sent — 201", async () => {
  const fake = limitedGh();
  const base = await boot(fake.gh, holdingClaude().adapter);
  fake.limited.on = true;
  expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(201);
  expect(core!.db.listTasks().map((t) => t.title.split(":")[0])).toContain("#304 実装");
  expect(core!.db.listPendingBacklogOperations().filter((o) => o.status !== "done")).toHaveLength(1);
});

test("start: a conflict held in the stored data is 409 even while GitHub is at its limit", async () => {
  const fake = limitedGh();
  const base = await boot(fake.gh, holdingClaude().adapter);
  fake.limited.on = true;
  expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
  importedAs(304, { title: "GitHub の題" });
  // the conflict a send found against GitHub's newer title, held in the stored data
  const op = core!.db.listPendingBacklogOperations()[0]!;
  core!.db.setBacklogOperationResult(op.id, { status: "conflict" });
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(409);
  expect(await r.text()).toContain("競合");
  expect(core!.db.listTasks().filter((t) => t.title.startsWith("#304 "))).toHaveLength(0);
});

test("autoStart: a stage button starts on the saved runner and model; routing.llm.runner is not consulted", async () => {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [claude.adapter, { ...codex.adapter, id: "codex" }]);
  core!.db.setSetting("settings", { autoStart: { runner: "codex", model: "m-auto" }, routing: { llm: { runner: "claude" } } });
  const task = await (await start(base, 304, { action: "complete" })).json() as Task;
  expect(task).toMatchObject({ runner: "codex", model: "m-auto" });
  for (let i = 0; !codex.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(codex.starts[0]!.model).toBe("m-auto");
  expect(claude.starts).toHaveLength(0);
});

test("autoStart effort: a stage button starts with the saved effort", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", effort: "high" } });
  const task = await (await start(base, 304, { action: "complete" })).json() as Task;
  expect(task).toMatchObject({ runner: "claude", effort: "high" });
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.effort).toBe("high");
});

test("autoStart by kind: to-tasks on codex starts Task に分解 on codex and 実装する on the common claude", async () => {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [claude.adapter, { ...codex.adapter, id: "codex", efforts: [{ value: "medium", label: "medium" }] }]);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-common", effort: "high", byKind: { "to-tasks": { runner: "codex", model: "m-plan", effort: "medium" } } } });
  const plan = await (await start(base, 303, { action: "to-tasks" })).json() as Task;
  const impl = await (await start(base, 304, { action: "complete" })).json() as Task;
  expect(plan).toMatchObject({ runner: "codex", model: "m-plan", effort: "medium" });
  expect(impl).toMatchObject({ runner: "claude", model: "m-common", effort: "high" });
  for (let i = 0; (!codex.starts.length || !claude.starts.length) && i < 100; i++) await Bun.sleep(10);
  expect(codex.starts.map((x) => [x.model, x.effort])).toEqual([["m-plan", "medium"]]);
  expect(claude.starts.map((x) => [x.model, x.effort])).toEqual([["m-common", "high"]]);
});

test("start runner: a runner in the body starts that one Task on it over the kind's default, and the saved autoStart does not change; an undetected one is 409", async () => {
  const claude = holdingClaude();
  const codex = holdingClaude();
  const base = await boot(fakeGh().gh, [claude.adapter, { ...codex.adapter, id: "codex" }]);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-common", byKind: { complete: { runner: "claude", model: "m-impl" } } } });
  const settings = async () => (await (await fetch(`${base}/api/settings`)).json() as { autoStart: unknown }).autoStart;
  const before = await settings();
  const task = await (await start(base, 304, { action: "complete", runner: "codex", model: "gpt-x" })).json() as Task;
  expect(task).toMatchObject({ runner: "codex", model: "gpt-x" });
  expect(await settings()).toEqual(before);
  expect((await start(base, 303, { action: "to-tasks", runner: "dak" })).status).toBe(409);
});

test("autoStart by kind: a kind whose runner is not detected starts on the common values", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", model: "m-common", byKind: { complete: { runner: "codex", model: "m-gone" } } } });
  const task = await (await start(base, 304, { action: "complete" })).json() as Task;
  expect(task).toMatchObject({ runner: "claude", model: "m-common" });
});

test("autoStart permission by kind: 状況確認 starts with its own mode and 実装 with the runner's default; a stale mode starts on the default", async () => {
  const claude = holdingClaude();
  const adapter = { ...claude.adapter, permissionModes: [{ value: "default", label: "default", description: "d" }, { value: "plan", label: "plan", description: "p" }, { value: "yolo", label: "yolo", description: "y", danger: true }], defaultPermissionMode: "default" };
  const base = await boot(fakeGh().gh, adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", byKind: { check: { permissionMode: "plan" } } } });
  const check = await (await start(base, 307, { action: "check" })).json() as Task;
  const impl = await (await start(base, 304, { action: "complete" })).json() as Task;
  expect(check).toMatchObject({ runner: "claude", permissionMode: "plan" });
  expect(impl).toMatchObject({ runner: "claude", permissionMode: "default" });
  for (let i = 0; claude.starts.length < 2 && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts.map((x) => x.permissionMode).sort()).toEqual(["default", "plan"]);
  // a saved mode the runner no longer lists: the Task starts on the default, no error
  core!.db.setSetting("settings", { autoStart: { runner: "claude", byKind: { close: { permissionMode: "gone" } } } });
  const stale = await start(base, 308, { action: "close" });
  expect(stale.status).toBe(201);
  expect(await stale.json()).toMatchObject({ permissionMode: "default" });
  // a saved mode that skips approvals on the runner it starts on (never saved by PATCH, but the runner it follows can change): the default
  core!.db.setSetting("settings", { autoStart: { runner: "claude", byKind: { check: { permissionMode: "yolo" } } } });
  const skipping = await start(base, 305, { action: "check" });
  expect(skipping.status).toBe(201);
  expect(await skipping.json()).toMatchObject({ permissionMode: "default" });
});

test("autoStart budget by kind: a button Task and a backlog-next Task get the kind's budget, else the schedule's", async () => {
  const base = await boot(fakeGh().gh, holdingClaude().adapter);
  core!.db.setSetting("settings", { autoStart: { runner: "claude", byKind: { complete: { budgetUsd: 7 }, check: { budgetUsd: 2 } } } });
  // backlog-next: 実装 takes its kind's budget over the schedule's; Task に分解 has none, so the schedule's
  closeTried();
  expect((await runSchedule(base, await backlogNextSchedule(base, 5))).status).toBe(201);
  const byTitle = (p: string) => core!.db.listTasks().find((t) => t.title.startsWith(p))!;
  expect(byTitle("#304 実装").budgetUsd).toBe(7);
  expect(byTitle("#303 Task に分解").budgetUsd).toBe(5);
  // a stage button: the kind's budget; a kind without one has none (the settings' default is unset)
  expect(await (await start(base, 307, { action: "check" })).json()).toMatchObject({ budgetUsd: 2 });
  expect((await (await start(base, 308, { action: "close" })).json() as Task).budgetUsd).toBeNull();
});

test("autoStart shadow by kind: a button Task is mirrored to the kind's shadow, off is not mirrored, backlog-next is never mirrored", async () => {
  const dak: RunnerAdapter = { id: "dak", detect: async () => ({ available: true }), start() { return { send() {}, respondPermission() {}, async abort() {}, async close() {}, exited: new Promise(() => {}) }; } };
  const base = await boot(fakeGh().gh, [holdingClaude().adapter, dak]);
  core!.db.setSetting("settings", { shadowRunner: "dak", autoStart: { runner: "claude", byKind: { close: { shadow: "off" }, complete: { shadow: "dak" }, "to-tasks": { shadow: "dak" } } } });
  const mirrored = () => core!.db.listTasks().filter((t) => t.shadowOf !== null).map((t) => t.shadowOf);
  // backlog-next never mirrors, whatever the kinds and the common 並走 say
  closeTried();
  expect((await runSchedule(base, await backlogNextSchedule(base))).status).toBe(201);
  expect(startedTasks()).toHaveLength(2);
  expect(mirrored()).toEqual([]);
  const close = await (await start(base, 308, { action: "close" })).json() as Task; // the common 並走 is dak, the kind says off
  expect(mirrored()).toEqual([]);
  const check = await (await start(base, 307, { action: "check" })).json() as Task; // no value of its own: the common one
  expect(mirrored()).toEqual([check.id]);
  expect(close.id).not.toBe(check.id);
  // no common 並走: a button Task follows the kind's own
  core!.db.setSetting("settings", { autoStart: { runner: "claude", byKind: { check: { shadow: "dak" } } } });
  const own = await (await start(base, 305, { action: "check" })).json() as Task;
  expect(mirrored().sort()).toEqual([check.id, own.id].sort());
  expect(core!.db.listTasks().filter((t) => t.shadowOf === own.id).map((t) => t.runner)).toEqual(["dak"]);
});

test("start: a second start while the first is running is 409 with its id; GET /api/backlog shows it as active", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const first = await (await start(base, 304, { action: "complete" })).json() as Task;
  for (let i = 0; core!.db.getTask(first.id)?.status !== "running" && i < 100; i++) await Bun.sleep(10);
  const again = await start(base, 304, { action: "complete" });
  expect(again.status).toBe(409);
  expect((await again.json() as { taskId: string }).taskId).toBe(first.id);
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  expect(items.find((i) => i.number === 304)!.activeTaskId).toBe(first.id);
  expect(items.find((i) => i.number === 303)!.activeTaskId).toBeNull();
  expect(core!.db.listTasks()).toHaveLength(1);
});

test("start: two starts of the same Issue in one tick make one Task; the other is 409 with it", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  // nothing awaits between the running/waiting check and the Task's creation, so the second start finds the first one's Task
  const [a, b] = await Promise.all([start(base, 304, { action: "complete" }), start(base, 304, { action: "complete" })]);
  expect([a.status, b.status].sort()).toEqual([201, 409]);
  const task = (await (a.status === 201 ? a : b).json()) as { id: string };
  const refused = (await (a.status === 409 ? a : b).json()) as { taskId: string };
  expect(refused.taskId).toBe(task.id);
  expect(core!.db.listTasks()).toHaveLength(1);
});

test("start: close on a closable PBI makes #N 閉じる: with the pbi-complete step 6 prompt; not closable is 409", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  // Issue 305 has open Tasks, Issue 304 is Ready: neither can be closed
  for (const n of [305, 304]) expect((await start(base, n, { action: "close" })).status).toBe(409);
  const r = await start(base, 307, { action: "close" });
  expect(r.status).toBe(201);
  expect(((await r.json()) as Task).title).toBe("#307 閉じる: PBI: Task が全部閉じた実装中の PBI");
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  const p = claude.starts[0]!.prompt;
  expect(p).toContain(".claude/skills/pbi-complete/SKILL.md の「6. PBI を閉じる」に従い、PBI #307 の受け入れ条件を検証結果つきで埋め、## 結果 を書いて閉じてください");
  expect(p).not.toContain("merge-gate");
  // the in-progress row's button is still 状況確認; a close Task is a stage Task like the others
  expect(buildStartPrompt({ number: 307 }, "check")).toContain("PBI #307 の今の状況を確認してください");
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  expect(items.find((i) => i.number === 307)!.activeTaskId).toBeString();
  expect((await start(base, 307, { action: "close" })).status).toBe(409);
});

test("start: close through the API also takes an in-progress PBI whose Tasks are all closed with 利用者確認 left; open Tasks and 利用者確認 together stay 409", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  // the screen's button still needs none left
  const i308 = items.find((i) => i.number === 308)!;
  expect(i308.closable).toBe(false);
  expect(i308.tasks!.done).toBe(i308.tasks!.total);
  const r = await start(base, 308, { action: "close" });
  expect(r.status).toBe(201);
  expect(((await r.json()) as Task).title.startsWith("#308 閉じる: ")).toBe(true);
  const mixed = await boot(openTaskAndConfirmationGh().gh, holdingClaude().adapter);
  expect((await start(mixed, 308, { action: "close" })).status).toBe(409);
});

test("start: the resume of a stalled PBI writes a ## 状況 in the 状況確認's form, asks with ## 判断待ち, else goes on with pbi-complete", () => {
  const p = buildStartPrompt({ number: 305 }, "complete", { resume: true });
  expect(p).toContain("PBI #305 は実装中のまま止まっています");
  expect(p).toContain("Issue #305 に `## 状況` で始まるコメントを 1 件書いてください。中身は `### 済んだこと` / `### 残り` / `### 止まっている理由`");
  expect(p).not.toContain("<!--");
  expect(p).toContain("`## 判断待ち` を出して止めてください");
  // a slash command is expanded only at the start of a prompt: the resume names the skill's file
  expect(p).toContain("無ければ続けて .claude/skills/pbi-complete/SKILL.md に従い、PBI #305 を完了させてください");
  expect(p).not.toContain("/pbi-complete 305");
  expect(p).toContain("（sub-issue の Task のものも）を読み");
  // the 状況確認's form is the same text
  const report = /`## 状況` で始まるコメントを 1 件書いてください。[^。]*。/.exec(p)![0];
  expect(buildStartPrompt({ number: 305 }, "check")).toContain(report);
  // another repository: the skill file, not the slash command; without resume, the plain 実装
  const other = { meta: "/work/switchboard", setup: { config: false, kit: [], copies: [] } };
  expect(buildStartPrompt({ number: 7 }, "complete", { other, resume: true })).not.toContain("<!--");
  expect(buildStartPrompt({ number: 7 }, "complete", { other, resume: true })).toContain(".claude/skills/pbi-complete/SKILL.md に従い、PBI #7 を完了させてください。");
  expect(buildStartPrompt({ number: 7 }, "complete")).not.toContain("<!--");
});

test("start: a complete prompt says the request covers merges the merge gate passes and closing the PBI", () => {
  const other = { meta: "/work/switchboard", setup: { config: false, kit: [], copies: [] } };
  const scope = "この依頼は、マージ判定（`scripts/merge-gate.ts`）が merge を返した PR のマージ、リリースタグ、PBI を閉じるところまでを含みます。";
  for (const opts of [{}, { resume: true as const }, { other }, { other, resume: true as const }]) {
    const p = buildStartPrompt({ number: 305 }, "complete", opts);
    expect(p).toContain(scope);
    expect(p).toContain("マージ判定が `[聞く]` で止めたとき、デーモンを再起動する pull、認証は、これまでどおり Task の会話で聞いてください（.claude/skills/pbi-complete/SKILL.md の「この依頼が含む範囲」）。昇格は");
    expect(p).toContain("昇格はリポジトリの CLAUDE.md の決まりに従い、CLAUDE.md が聞かずに昇格してよいと書いていなければ Task の会話で聞いてください");
    expect(p).not.toContain("昇格・デーモンの再起動");
    expect(p).toContain("「この依頼が含む範囲」");
    expect(p).toContain("レビューの材料");
    expect(p).toContain("要望 Issue と PBI");
    expect(p.startsWith(opts.resume ? "PBI #305 は実装中のまま" : opts.other ? ".claude/skills/pbi-complete/SKILL.md" : "/pbi-complete 305\n")).toBe(true);
  }
  // the first line stays: a slash command is expanded only at the start of a prompt
  expect(buildStartPrompt({ number: 305 }, "complete").startsWith("/pbi-complete 305\n")).toBe(true);
  // the stages that do not merge do not carry it
  for (const action of ["check", "close", "to-pbi", "to-tasks"] as const) expect(buildStartPrompt({ number: 305 }, action)).not.toContain("この依頼は、マージ判定");
});

test("start: the prompt says to read the newest ## 回答 first", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  await start(base, 304, { action: "complete" });
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[0]!.prompt).toContain("Issue #304 の最新の `## 回答` コメント（sub-issue の Task のものも）を読み");
});

test("start: complete delegates merge procedure to the skill", () => {
  const other = { meta: "/work/switchboard", setup: { config: false, kit: [], copies: [] } };
  for (const opts of [{}, { other }]) {
    const p = buildStartPrompt({ number: 7 }, "complete", opts);
    for (const text of ["定期実行が始めた無人の実装", "exit 0 ならマージ", "自動マージ: PR #n"]) expect(p).not.toContain(text);
  }
});

test("start: another repository gets its recheck location and merge-gate repository from either start path", () => {
  const other = { meta: "/work/switchboard", setup: { config: false, kit: [], copies: [] } };
  for (const p of [otherRepoRules(other, { merges: true }), buildStartPrompt({ number: 7 }, "complete", { other })]) {
    expect(p).toContain("`scripts/merge-gate.ts`");
    expect(p).toContain("`--repo <このリポジトリの owner/name>`");
    expect(p).toContain("`/work/switchboard/docs/merge-gate.md` の「Recheck」");
    expect(p).toContain("その中の `-R <owner/name>` と `origin` はこのリポジトリ。印は必ずこのリポジトリの PR に付ける");
  }
});

test("start: stage endings read answers once and delegate decision procedure to the skills", () => {
  for (const action of ["to-pbi", "to-tasks", "complete", "close"] as const) {
    const p = buildStartPrompt({ number: 7 }, action);
    expect(p).toContain("始める前に Issue #7 の最新の `## 回答`");
    expect(p).toContain("`ops-kit backlog view 7 --fresh`"); // the latest answer from the app, imported first
    expect(p.match(/続きから進めてください/g)).toHaveLength(1);
    expect(p).not.toContain("`## 判断待ち` を出して止め");
    expect(p).not.toContain("Task に付いた `## 回答` も読み");
    expect(p.match(/sub-issue の Task のものも/g)?.length ?? 0).toBe(action === "complete" ? 1 : 0);
  }
});

test("start: check reads answers only as status material without resuming", () => {
  const p = buildStartPrompt({ number: 7 }, "check");
  expect(p).not.toContain("続きから進めて");
  expect(p).toContain("その続きの作業はしないでください");
  expect(p).toEndWith("対象: #7。");
});

/* ---------- a start goes on the stored data; only a conflict holds it ---------- */

describe("start gate: only a conflict in the stored data holds a start", () => {
  const tasksOf304 = () => core!.db.listTasks().filter((t) => t.title.startsWith("#304 "));
  /** GitHub unreachable while `down.on`; the same fake answers once it is up. */
  const bootDown = async (claude = holdingClaude()) => {
    const fake = fakeGh();
    const down = { on: false };
    const base = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)), claude.adapter);
    return { base, down };
  };

  test("an edit kept while GitHub is out of reach: the start makes the Task on the stored data", async () => {
    const { base, down } = await bootDown();
    down.on = true;
    expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect(tasksOf304()).toHaveLength(1);
  });

  test("a held conflict: the manual start is 409 naming the field, and backlog-next leaves it and logs why", async () => {
    const { base, down } = await bootDown();
    down.on = true;
    expect((await patch(base, 304, { title: "手元の題" })).status).toBe(202);
    importedAs(304, { title: "GitHub の題" });
    down.on = false;
    const refused = await start(base, 304, { action: "complete" });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("競合");
    const id = await backlogNextSchedule(base);
    await runSchedule(base, id);
    expect(tasksOf304()).toHaveLength(0);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringMatching(/競合があるので自動では始めない.*#304（競合/));
  });

  test("a refused edit (failed) is shown, not a reason: the start by hand makes the Task", async () => {
    const { base, down } = await bootDown();
    down.on = true;
    const r = await patch(base, 304, { title: "手元の題" });
    expect(r.status).toBe(202);
    const op = core!.db.listPendingBacklogOperations()[0]!;
    core!.db.setBacklogOperationResult(op.id, { status: "failed", error: "permission" });
    down.on = false;
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect(tasksOf304()).toHaveLength(1);
  });

  /** Runs backlog-next once with Issue 307 (picked to 閉じる) changed by `change` on GitHub between the sweep's read and the read right before its start. */
  const sweepWith307Changed = async (change: (i: Record<string, any>) => Record<string, unknown>) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    const fake = fakeGh();
    const changed = { from: Infinity };
    let reads = 0;
    const gh: GhRunner = async (args, cwd) => {
      const r = await fake.gh(args, cwd);
      if (!args.includes("query=issues(states:OPEN)")) return r;
      // each read of the Issues starts on the first page; Issue 307 is on the second
      if (!args.includes("after=CURSOR1")) reads++;
      if (reads < changed.from) return r;
      const body = JSON.parse(r.stdout);
      body.data.repository.issues.nodes = body.data.repository.issues.nodes.map((i: { number: number }) => (i.number === 307 ? change(i) : i));
      return { ...r, stdout: JSON.stringify(body) };
    };
    const base = await boot(gh, holdingClaude().adapter);
    await refreshed(base);
    // the sweep's first read still sees Issue 307 as it was and picks it to close; the read right before its start sees the change (a read asks the three lists at once, so the change starts at the next read's first ask, not in the middle of the first read's pages)
    changed.from = reads + 3;
    await runSchedule(base, await backlogNextSchedule(base));
    expect(reads).toBeGreaterThanOrEqual(changed.from);
    expect(core!.db.listTasks().filter((t) => t.title.startsWith("#307 "))).toHaveLength(0);
    expect(await scheduleLogAll(base)).toContainEqual(expect.stringContaining("#307 を始めない"));
  };

  test("backlog-next asks again right before each start: a PBI GitHub closed after the sweep picked it to 閉じる is not started on the older copy", async () => {
    await sweepWith307Changed((i) => ({ ...i, state: "CLOSED", updatedAt: new Date().toISOString() }));
  });

  test("backlog-next picks the action again on the fresh copy: a Task reopened meanwhile (the PBI itself unchanged) is no 閉じる", async () => {
    await sweepWith307Changed((i) => ({ ...i, subIssuesSummary: { ...i.subIssuesSummary, completed: i.subIssuesSummary.completed - 1 } }));
  });

  test("a start is not judged on the stored copy: GitHub is imported again first", async () => {
    const asked: string[][] = [];
    const fake = fakeGh();
    const base = await boot(async (args, cwd) => (asked.push(args), fake.gh(args, cwd)), holdingClaude().adapter);
    await fetch(`${base}/api/backlog`);
    const n = asked.length;
    expect((await start(base, 304, { action: "complete" })).status).toBe(201);
    expect(asked.length).toBeGreaterThan(n);
  });
});

describe("canStartStoredBacklog", () => {
  const NOW = 1_000_000;
  const sync = (over: Partial<BacklogItem["sync"]>): Pick<BacklogItem, "sync"> => ({ sync: { state: "synced", reason: null, lastSuccessfulSync: NOW - 1000, retryAt: null, pendingCount: 0, conflicts: [], guarantee: "A", ...over } });
  test("only a conflict held in the stored data is refused, with the field", () => {
    expect(canStartStoredBacklog(sync({ state: "conflict", pendingCount: 1, conflicts: [{ field: "body", base: "a", local: "b", remote: "c", remoteRead: true, revision: "r" }] }))).toMatchObject({ ok: false, why: expect.stringContaining("body") });
  });
  test("edits waiting, a failed or old import, a refused edit or an unread Issue are GitHub's side: they pass", () => {
    for (const over of [{}, { lastSuccessfulSync: NOW - 3_600_000 }, { lastSuccessfulSync: null }, { state: "pending", pendingCount: 2 }, { state: "pending", reason: "unknown", pendingCount: 1 }, { state: "error", reason: "import" }, { state: "error", reason: "failed", pendingCount: 1 }, { state: "error", reason: "unfetched" }, { state: "error", reason: "forbidden" }] as Partial<BacklogItem["sync"]>[])
      expect(canStartStoredBacklog(sync(over))).toEqual({ ok: true });
  });
});

test("developSelf off: a stage on the meta workspace is refused", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  expect((await fetch(`${base}/api/settings`, { method: "PATCH", body: JSON.stringify({ developSelf: false }) })).status).toBe(200);
  const r = await start(base, 304, { action: "complete" });
  expect(r.status).toBe(409);
  expect(await r.text()).toContain("Switchboard 自体を開発しない設定です");
  expect(core!.db.listTasks()).toHaveLength(0);
});

test("complete and direct prompts name the reviewer by the review setting", () => {
  for (const [review, has, lacks] of [["same", "同じランナーの新しいセッション", "別のランナー"], ["other", "別のランナー", "同じランナーの新しいセッション"]] as const) {
    for (const prompt of [buildStartPrompt({ number: 1 }, "complete", { review }), buildDirectPrompt({ number: 1 }, { review })]) {
      expect({ review, has: prompt.includes(has), lacks: prompt.includes(lacks) }).toEqual({ review, has: true, lacks: false });
    }
  }
  // without the setting the reviewer is the other runner, and only a complete carries the scope
  expect(buildStartPrompt({ number: 1 }, "complete")).toBe(buildStartPrompt({ number: 1 }, "complete", { review: "other" }));
  expect(buildStartPrompt({ number: 1 }, "to-tasks", { review: "same" })).toBe(buildStartPrompt({ number: 1 }, "to-tasks"));
});

/** A done Task of the meta workspace that opened Issues 302, 301 and 304 of the fake gh's acme/app, and said a line of its own. */
function openerTask(): string {
  const now = Date.now();
  core!.db.insertTask({ id: "tsk_opener", workspaceId: metaId(), title: "気になったこと", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: now, createdAt: now, updatedAt: now });
  core!.db.appendEvent("tsk_opener", { t: "message.delta", role: "assistant", text: "元の会話だけにある文" });
  core!.db.appendEvent("tsk_opener", { t: "tool.call", id: "c1", name: "Bash", input: { command: "gh issue create --title x" }, summary: "create" });
  core!.db.appendEvent("tsk_opener", { t: "tool.result", id: "c1", ok: true, summary: "https://github.com/acme/app/issues/302\nhttps://github.com/acme/app/issues/301\nhttps://github.com/acme/app/issues/304" });
  return "tsk_opener";
}

type CreatedRowsDetail = { createdRows?: Array<{ number: number; workspaceId: string; kind: string; item: BacklogItem | null }> };

test("created rows: a Task's detail lists the requests and PBIs it opened; a row's stage starts as the Backlog's button starts it and leaves the opening Task as it was; a running stage Task answers 409 with its id", async () => {
  const claude = holdingClaude();
  const base = await boot(fakeGh().gh, claude.adapter);
  const opener = openerTask();
  const detail = async (q = "") => (await (await fetch(`${base}/api/tasks/${opener}${q}`)).json()) as CreatedRowsDetail & { task: Task; events: unknown[] };
  const first = await detail();
  // the request with a derived PBI (301) has no item: no stage to start
  expect(first.createdRows!.map((r) => [r.number, r.workspaceId, r.kind, r.item?.stage ?? null])).toEqual([[302, metaId(), "request", "request"], [301, metaId(), "request", null], [304, metaId(), "pbi", "ready"]]);
  // the turn's end reads them (limit=0); a page back and the catch-up do not
  expect((await detail("?limit=0")).createdRows!.map((r) => r.number)).toEqual([302, 301, 304]);
  expect((await detail("?before=2")).createdRows).toBeUndefined();
  expect((await detail("?after=0")).createdRows).toBeUndefined();
  const events = core!.db.listEvents(opener).length;

  const row = first.createdRows!.find((r) => r.number === 304)!;
  const r = await start(base, row.number, { workspaceId: row.workspaceId, action: "complete" });
  expect(r.status).toBe(201);
  const task = await r.json() as Task;
  for (let i = 0; !claude.starts.length && i < 100; i++) await Bun.sleep(10);
  const fromRow = claude.starts[0]!.prompt;
  expect(fromRow).not.toContain("元の会話だけにある文");
  // the row shows the stage Task it started; another start opens that one
  expect((await detail()).createdRows!.find((x) => x.number === 304)!.item!.activeTaskId).toBe(task.id);
  const again = await start(base, row.number, { workspaceId: row.workspaceId, action: "complete" });
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ taskId: task.id });

  // the same stage from the Backlog's row, once that Task ended, is started with the same prompt
  core!.db.updateTask(task.id, { status: "done" });
  const item = (await refreshed(base, false)).items.find((i) => i.number === 304 && i.workspaceId === metaId())!;
  expect((await start(base, item.number, { workspaceId: item.workspaceId, action: "complete" })).status).toBe(201);
  for (let i = 0; claude.starts.length < 2 && i < 100; i++) await Bun.sleep(10);
  expect(claude.starts[1]!.prompt).toBe(fromRow);
  // the opening Task got no event and kept its status
  expect(core!.db.listEvents(opener)).toHaveLength(events);
  expect(core!.db.getTask(opener)!.status).toBe("done");
});

test("created rows: a row's 実装 that overlaps an open PR is refused with the Backlog's reason", async () => {
  const fake = waitsGh({}, {});
  const gh: GhRunner = async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    if (!args.find((a) => a.startsWith("query="))?.includes("comments(last:")) return r;
    const body = JSON.parse(r.stdout);
    body.data.repository.i304 = { ...body.data.repository.i304, subIssues: { nodes: [3041, 3042].map((number) => ({ number, state: "OPEN", labels: { nodes: [{ name: "type:task" }] }, body: "触る場所: `src/a.ts`", comments: { nodes: [] } })) } };
    return { ...r, stdout: JSON.stringify(body) };
  };
  openPulls = [{ number: 900, files: ["src/a.ts"], headRefName: "sb/999-x" }];
  const base = await boot(gh, holdingClaude().adapter);
  const opener = openerTask();
  const row = ((await (await fetch(`${base}/api/tasks/${opener}`)).json()) as CreatedRowsDetail).createdRows!.find((r) => r.number === 304)!;
  expect(row.item!.overlap?.hits).toEqual([{ ref: "PR #900", path: "src/a.ts", working: true, pbi: null }]);
  const r = await start(base, row.number, { workspaceId: row.workspaceId, action: "complete" });
  expect(r.status).toBe(409);
  const { error } = (await r.json()) as { error: string };
  expect(error.startsWith("重なり: #304（")).toBe(true);
  expect(error).toContain("PR #900: src/a.ts");
  expect(core!.db.listTasks().map((t) => t.id)).toEqual([opener]);
});
