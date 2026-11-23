// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Backlog, BacklogIssueDetail, BacklogItem } from "@switchboard/protocol";
import { type CoreServer } from "./server.ts";
import { taskAllowRules } from "./tasks/sessions.ts";
import { answerStoredDecision, askStoredDecision, screenAnswer, holdStoredDecision } from "./backlog-edit.ts";
import { buildStartPrompt } from "./backlog-prompt.ts";
import { confirmationsOf, confirmAfterOf, confirmDecisionsOf, toItem } from "./backlog-item.ts";
import { pickNext } from "./backlog-pick.ts";
import type { GhRunner } from "./backlog-gh.ts";
import { boot, fakeGh, fixtureStage, holdingClaude, metaId, start, openTaskAndConfirmationGh, pages, queued, raw, refreshed, subTask, taskDecisionGh, useBacklogDaemon, waitsGh, waitsOfItem } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

test("decision: a needs-decision item carries its newest ## 判断待ち comment; the others carry none", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  const d = items.find((i) => i.number === 306)!.decision!;
  expect(d.body.startsWith("## 判断待ち\n**問い**: 保存先をどちらにするか")).toBe(true);
  expect(d.at).toBe("2026-09-22T03:00:00Z");
  expect(items.filter((i) => i.number !== 306).every((i) => i.decision === null)).toBe(true);
});

test("report: an in-progress item carries its newest ## 状況 comment; the other stages carry none", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  const r = items.find((i) => i.number === 305)!.report!;
  expect(r.body.startsWith("## 状況\n### 済んだこと\n- #310 をマージ")).toBe(true);
  expect(r.at).toBe("2026-09-27T05:00:00Z");
  expect(items.find((i) => i.number === 307)!.report).toBeNull();
  // a ## 状況 is read for in-progress items only, a ## 判断待ち for needs-decision items only
  expect(items.find((i) => i.number === 306)!.report).toBeNull();
  expect(items.find((i) => i.number === 305)!.decision).toBeNull();
});

test("confirmations: only unchecked 利用者確認 lines outside fences, numbered among all checkboxes", () => {
  const body = [
    "## ユーザーストーリー",
    "- [ ] 節の外（利用者確認: 数えない）",
    "## 到達点 / 受け入れ条件",
    "- [x] 1. 済み（利用者確認: 見た）",
    "- [ ] 2. 実機（検証: ホスト）（利用者確認: ホストで動く）  ",
    "- [ ] 3. エージェントが検証する（検証: テスト）",
    "~~~",
    "- [ ] 見本（利用者確認: フェンスの中）",
    "## 到達点 / 受け入れ条件",
    "~~~",
    "- [X] 4. 大文字の X も済み（利用者確認: 見た）",
    "- [ ] 5. スマホ（利用者確認: スマホで読める）",
    "## スコープ外",
    "- [ ] 後ろの節（利用者確認: 数えない）",
  ].join("\n");
  const want = [{ n: 2, text: "2. 実機（検証: ホスト）（利用者確認: ホストで動く）", after: null }, { n: 5, text: "5. スマホ（利用者確認: スマホで読める）", after: null }];
  expect(confirmationsOf(body)).toEqual(want);
  // a body edited on GitHub's web form comes back with CRLF: no \r in the text
  expect(confirmationsOf(body.replaceAll("\n", "\r\n"))).toEqual(want);
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. ふつう（検証: テスト）\n")).toEqual([]);
  // a line that names the form in inline code (a criterion about the form itself) is not one
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. 行に `（利用者確認: <何を>）` を付ける（検証: grep）\n- [ ] 2. 画面（利用者確認: `/backlog` で見る）\n"))
    .toEqual([{ n: 2, text: "2. 画面（利用者確認: `/backlog` で見る）", after: null }]);
  // a code span of two backticks holds a single one; the mark after it is outside
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. 記号 `` ` `` を出す（利用者確認: `画面` で見える）\n")).toEqual([{ n: 1, text: "1. 記号 `` ` `` を出す（利用者確認: `画面` で見える）", after: null }]);
  // only the first ## 到達点 / 受け入れ条件 section counts, as section() reads it
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. 実機（利用者確認: 見る）\n## メモ\n## 到達点 / 受け入れ条件\n- [ ] 見本（利用者確認: 数えない）\n")).toEqual([{ n: 1, text: "1. 実機（利用者確認: 見る）", after: null }]);
});

test("GET /api/backlog: an in-progress PBI carries its confirmations; closable only when every Task is done and none is left", async () => {
  const pbi308 = pages[0] as { data: { repository: { issues: { nodes: Array<{ number: number; body: string }> } } } };
  const node = pbi308.data.repository.issues.nodes.find((n) => n.number === 308)!;
  const saved = node.body;
  try {
    const base = await boot(fakeGh().gh);
    const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
    const of = (n: number) => items.find((i) => i.number === n)!;
    expect(of(308)).toMatchObject({
      stage: "in-progress", tasks: { total: 2, done: 2, doneAt: expect.any(String) }, closable: false,
      confirmations: [{ n: 2, text: "2. ホストで動く（検証: 実機）（利用者確認: クラウドホストの画面で一覧が出る）", after: null }, { n: 4, text: "4. スマホで読める（利用者確認: スマホで開いて文字が切れない）", after: null }],
    });
    expect(of(305)).toMatchObject({ tasks: { total: 3, done: 1, doneAt: expect.any(String) }, confirmations: [], closable: false });
    expect(of(307)).toMatchObject({ tasks: { total: 2, done: 2, doneAt: expect.any(String) }, confirmations: [], closable: true });
    // only in-progress PBIs are read for them, and only they can be closable
    for (const n of [306, 304, 303, 302]) expect(of(n)).toMatchObject({ confirmations: [], closable: false });

    // every confirmation checked on GitHub → closable
    node.body = saved.replaceAll("- [ ] 2.", "- [x] 2.").replaceAll("- [ ] 4.", "- [x] 4.");
    const again = (await refreshed(base)).items.find((i) => i.number === 308)!;
    expect(again).toMatchObject({ confirmations: [], closable: true });
  } finally {
    node.body = saved;
  }
});

test("toItem: an in-progress PBI's confirmations wait for every Task to close", () => {
  const body = "## 到達点 / 受け入れ条件\n- [x] 1. 実装した\n- [ ] 2. 実機（利用者確認: 見る）\n- [ ] 3. スマホ（利用者確認: 開く）\n";
  const of = (status: string, total: number, completed: number) => {
    const i = toItem({ ...raw(["type:pbi"], body, status), subIssuesSummary: { total, completed, doneAt: null } }, 11, { id: "ws_meta", name: "switchboard" })!;
    return [i.confirmations.map((c) => c.n), i.closable, i.progress];
  };
  // a Task still open: what is not built cannot be checked, so nothing is asked — In review too (a Task left open is not built)
  expect(of("In progress", 3, 1)).toEqual([[], false, { closableByApi: false, closesOnAnswer: null, checking: false }]);
  expect(of("In review", 3, 2)).toEqual([[], false, { closableByApi: false, closesOnAnswer: null, checking: false }]);
  // every Task closed: each line is asked; neither answer alone closes it
  expect(of("In progress", 3, 3)).toEqual([[2, 3], false, { closableByApi: true, closesOnAnswer: null, checking: false }]);
  expect(of("In review", 3, 3)).toEqual([[2, 3], false, { closableByApi: true, closesOnAnswer: null, checking: false }]);
  // a PBI with no Tasks at all is asked as before, and is never closable
  expect(of("In progress", 0, 0)).toEqual([[2, 3], false, { closableByApi: false, closesOnAnswer: null, checking: false }]);
  // not started: none
  expect(of("Ready", 3, 3)).toEqual([[], false, { closableByApi: false, closesOnAnswer: null, checking: false }]);
  // the last line left is the one whose answer closes it
  const last = toItem({ ...raw(["type:pbi"], body.replace("- [ ] 3.", "- [x] 3."), "In progress"), subIssuesSummary: { total: 2, completed: 2, doneAt: null } }, 11, { id: "ws_meta", name: "switchboard" })!;
  expect(last).toMatchObject({ confirmations: [{ n: 2 }], closable: false, progress: { closableByApi: true, closesOnAnswer: 2, checking: false } });
});

test("toItem: after-merge lines reach the item, and a PBI left with them is checking", () => {
  const body = "## 到達点 / 受け入れ条件\n- [x] 1. 実装した\n- [ ] 2. 画面（マージの後: 画面）\n- [ ] 3. 実機（利用者確認: 見る）\n- [ ] 4. 両方（マージの後: E2E）（利用者確認: 見る）\n";
  const of = (labels: string[], total: number, completed: number) => toItem({ ...raw(labels, body, "In review"), subIssuesSummary: { total, completed, doneAt: null } }, 11, { id: "ws_meta", name: "switchboard" })!;
  // a line with both marks is read as a user check only
  expect(of(["type:pbi"], 2, 2)).toMatchObject({ postMerge: [{ n: 2, kind: "画面", after: null }], closable: false, progress: { closableByApi: true, closesOnAnswer: null, checking: true } });
  expect(of(["type:pbi"], 2, 1)).toMatchObject({ postMerge: [{ n: 2 }], progress: { checking: false } });
  // not a PBI: nothing is read
  expect(of(["type:request"], 0, 0)).toMatchObject({ postMerge: [], progress: { checking: false } });
});

test("a PBI with a Task still open: no confirmation in the backlog or in 判断待ち, and an answer to one is refused with nothing written", async () => {
  // Issue 308: In review, two user-check lines, one of its Tasks open
  const base = await boot(openTaskAndConfirmationGh().gh, holdingClaude().adapter);
  const i308 = ((await (await fetch(`${base}/api/backlog`)).json()) as Backlog).items.find((i) => i.number === 308)!;
  expect(i308.tasks!.done).toBeLessThan(i308.tasks!.total);
  expect(i308).toMatchObject({ confirmations: [], closable: false, progress: { closableByApi: false, closesOnAnswer: null, checking: false } });
  const asks = ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Array<{ id: string }> }).asks;
  expect(asks.filter((a) => a.id.startsWith("confirm:") && a.id.includes("#308:"))).toEqual([]);
  const r = await fetch(`${base}/api/asks/answer`, { method: "POST", body: JSON.stringify({ id: `confirm:${metaId()}#308:2`, answer: { kind: "confirm", ok: true } }) });
  expect(r.ok).toBe(false);
  expect(core!.db.listPendingBacklogOperations()).toEqual([]);
});

test("confirmAfterOf: the 期日 right after 利用者確認: with a zone; none without it, with no zone, or in inline code", () => {
  expect(confirmAfterOf("1. 出ない（利用者確認: 期日 2026-11-20T00:00:00+09:00 以降 — 1 週間で出ないか）")).toBe("2026-11-20T00:00:00+09:00");
  expect(confirmAfterOf("1. 出ない（利用者確認: 期日 2026-11-20T00:00:00Z 以降 — 確認）")).toBe("2026-11-20T00:00:00Z");
  expect(confirmAfterOf("1. 見る（利用者確認: 画面を見る）")).toBeNull();
  expect(confirmAfterOf("1. 見る（利用者確認: 回答で確かめる #12 — 方針）")).toBeNull();
  // no zone, or not a time: not read
  expect(confirmAfterOf("1. 見る（利用者確認: 期日 2026-11-20T00:00:00 以降 — 確認）")).toBeNull();
  expect(confirmAfterOf("1. 見る（利用者確認: 期日 来週 以降 — 確認）")).toBeNull();
  // the form named in inline code is not one
  expect(confirmAfterOf("1. 行に `（利用者確認: 期日 2026-11-20T00:00:00Z 以降 — x）` を書く（利用者確認: 画面）")).toBeNull();
  // confirmationsOf carries it, and the line stays a confirmation
  expect(confirmationsOf("## 到達点 / 受け入れ条件\n- [ ] 1. 出ない（利用者確認: 期日 2026-11-20T00:00:00Z 以降 — 確認）\n"))
    .toEqual([{ n: 1, text: "1. 出ない（利用者確認: 期日 2026-11-20T00:00:00Z 以降 — 確認）", after: "2026-11-20T00:00:00Z" }]);
});

test("confirmDecisionsOf: the numbers right after 回答で確かめる in the 利用者確認 parentheses; none in inline code or without the form", () => {
  expect(confirmDecisionsOf("1. 要る（利用者確認: 回答で確かめる #12 — 方針）")).toEqual([12]);
  expect(confirmDecisionsOf("1. 要る（利用者確認: 回答で確かめる #12, #34 — 方針）")).toEqual([12, 34]);
  expect(confirmDecisionsOf("1. 要る（利用者確認: 回答で確かめる #12、#34、#12 — 方針）")).toEqual([12, 34]);
  expect(confirmDecisionsOf("1. 形だけ `（利用者確認: 回答で確かめる #12 — 方針）` を書く（利用者確認: 画面で見る）")).toEqual([]);
  expect(confirmDecisionsOf("1. 画面（利用者確認: 画面で見る #12）")).toEqual([]);
  expect(confirmDecisionsOf("1. 画面（利用者確認: 回答で確かめる — 番号なし）")).toEqual([]);
});

test("GET /api/backlog: confirmations naming decisions are not the user's; closable follows their needs-decision labels", async () => {
  const pbi = pages[0] as { data: { repository: { issues: { nodes: Array<{ number: number; body: string }> } } } };
  const node = pbi.data.repository.issues.nodes.find((n) => n.number === 308)!;
  const saved = node.body;
  const named = (ns: string) => saved.replace(/^- \[ \] 2\..*$/m, `- [ ] 2. 方針（利用者確認: 回答で確かめる ${ns} — 方針）`).replace(/^- \[ \] 4\..*$/m, "- [x] 4. 済み");
  try {
    const base = await boot(fakeGh().gh);
    // (a) every named decision is stored and none is needs-decision
    node.body = named("#304, #305");
    const a = (await refreshed(base)).items.find((i) => i.number === 308)!;
    expect(a).toMatchObject({ confirmations: [], closable: true });
    // (b) one is still labelled needs-decision
    node.body = named("#304, #306");
    const b = (await refreshed(base)).items.find((i) => i.number === 308)!;
    expect(b).toMatchObject({ confirmations: [], closable: false });
    // (c) a number that is not stored keeps its line
    node.body = named("#9999");
    const c = (await refreshed(base)).items.find((i) => i.number === 308)!;
    expect(c).toMatchObject({ confirmations: [{ n: 2, text: "2. 方針（利用者確認: 回答で確かめる #9999 — 方針）", after: null }], closable: false });
    // backlog-next closes (a) and starts nothing for (b)
    expect(pickNext([a], "implement")).toMatchObject({ item: { number: 308 }, action: "close" });
    expect(pickNext([b], "implement")).toBeNull();
  } finally {
    node.body = saved;
  }
});

test("task decision: an open Task's needs-decision holds its in-progress PBI with that Task's newest question", async () => {
  const fake = taskDecisionGh({
    i305: [
      subTask(320, "CLOSED", ["type:task", "needs-decision"], [["## 判断待ち\n**問い**: 閉じた Task の問い", "2026-09-28T09:00:00Z"]]),
      subTask(321, "OPEN", ["type:task", "needs-decision"], [["## 判断待ち\n**問い**: 古い問い", "2026-09-28T01:00:00Z"], ["## 回答\n\nA", "2026-09-28T02:00:00Z"], ["## 判断待ち\n**問い**: 表示をどちらにするか", "2026-09-28T03:00:00Z"]]),
      subTask(322, "OPEN", ["type:task"], [["## 判断待ち\n**問い**: ラベルの無い Task の問い", "2026-09-28T08:00:00Z"]]),
    ],
    i307: [subTask(330, "OPEN", ["type:task"], [])],
  });
  const base = await boot(fake.gh);
  const items = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items;
  const i305 = items.find((i) => i.number === 305)!;
  expect(i305.stage).toBe("needs-decision");
  expect(i305.decision).toEqual({ body: "## 判断待ち\n**問い**: 表示をどちらにするか", at: "2026-09-28T03:00:00Z", issue: 321 });
  expect(i305.report).toBeNull();
  expect(items.find((i) => i.number === 307)).toMatchObject({ stage: "in-progress", decision: null });
  // the PBI's own question names the PBI
  expect(items.find((i) => i.number === 306)!.decision!.issue).toBe(306);
});

test("task decision: a labelled Task without a ## 判断待ち still holds the PBI and says so", async () => {
  const base = await boot(taskDecisionGh({ i305: [subTask(323, "OPEN", ["needs-decision"], [["ふつうのコメント", "2026-09-28T00:00:00Z"]])], i307: [] }).gh);
  const d = (await (await fetch(`${base}/api/backlog`)).json() as Backlog).items.find((i) => i.number === 305)!.decision!;
  expect(d.issue).toBe(323);
  expect(d.body).toContain("Task #323 に「## 判断待ち」のコメントがありません");
  expect(d.at).toBe("2026-09-27T05:00:00Z"); // the PBI's updatedAt
});

test("task decision: the answer is kept for the Task that asked, and its label comes off after it", async () => {
  const fake = taskDecisionGh({ i305: [subTask(321, "OPEN", ["needs-decision"], [["## 判断待ち\n**問い**: x", "2026-09-28T03:00:00Z"]])], i307: [] });
  const base = await boot(fake.gh);
  // as the web UI sends it (its page's origin): only such an answer is kept as the screen's
  const r = await fetch(`${base}/api/backlog/305/answer`, { method: "POST", headers: { origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ workspaceId: metaId(), text: "B で" }) });
  expect(r.status).toBe(202);
  expect(queued()).toEqual([[321, "comment", null, { body: "## 回答\n\nB で", screen: true, heads: {} }], [321, "set", "label:needs-decision", false]]);
});

test("task decision: an answer sent for the question on screen is refused when the item now asks on another Issue", async () => {
  const fake = taskDecisionGh({ i305: [subTask(322, "OPEN", ["needs-decision"], [["## 判断待ち\n**問い**: 新しい問い", "2026-09-28T05:00:00Z"]])], i307: [] });
  const base = await boot(fake.gh);
  const post = (issue: number) => fetch(`${base}/api/backlog/305/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "A で", issue }) });
  // the screen showed Task 321's question; GitHub now has Issue 322's
  const r = await post(321);
  expect(r.status).toBe(409);
  expect(await r.text()).toContain("#322");
  expect(queued()).toEqual([]);
  expect((await post(322)).status).toBe(202);
  expect(queued().map((o) => o[0])).toEqual([322, 322]);
});

test("stage prompt carries grant: the newest ## 回答 given on the screen goes into the next stage Task's prompt; one from GitHub, from a policy or for a check does not", async () => {
  const GRANT = "B: 登録する — 許可: 定期実行 sch_x を POST /api/schedules に登録することだけ許可します";
  const fake = taskDecisionGh({ i305: [subTask(321, "OPEN", ["type:task", "needs-decision"], [["## 判断待ち\n**問い**: 登録するか", "2026-09-28T03:00:00Z"], ["## 回答\n\nGitHub で書いた回答", "2026-09-28T04:00:00Z"]])], i307: [] });
  const base = await boot(fake.gh);
  await refreshed(base);
  const db = core!.db;
  const source = db.getWorkspaceBacklogSource(metaId())!;
  const rulesBefore = taskAllowRules("/meta", "/repo");
  // only on GitHub (imported): not the person's words to the Task
  expect(db.listBacklogRecords(source, "comment").some((r) => (r.remote as { body?: string } | null)?.body?.includes("GitHub で書いた回答"))).toBe(true);
  expect(screenAnswer(db, source, 305)).toBeNull();
  // answered on the screen (POST /api/backlog/:n/answer): its text, as written, on the Task it was asked on
  expect((await fetch(`${base}/api/backlog/305/answer`, { method: "POST", headers: { origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ workspaceId: metaId(), text: GRANT, issue: 321 }) })).status).toBe(202);
  const answer = screenAnswer(db, source, 305);
  expect(answer).toEqual({ issue: 321, text: GRANT, id: expect.any(String), heads: {} });
  const prompt = buildStartPrompt({ number: 305 }, "complete", { answer });
  expect(prompt).toContain(`利用者が画面で答えた Issue #321 の最新の回答（利用者の言葉）:\n\n\`\`\`\`text\n${GRANT}\n\`\`\`\``);
  expect(buildStartPrompt({ number: 305 }, "check", { answer })).not.toContain(GRANT);
  // an answer cannot close its fence
  expect(buildStartPrompt({ number: 305 }, "complete", { answer: { issue: 321, text: "a ```` b" } })).toContain("`````text\na ```` b\n`````");
  // the same comment edited on GitHub after it was sent: no longer what the person gave
  const sent = db.listBacklogOperations(source).find((o) => o.kind === "comment" && (o.payload as { screen?: boolean }).screen)!;
  const rec = db.getBacklogRecord({ ...source, objectKind: "comment", externalId: sent.target })!;
  db.sqlite.run("UPDATE backlog_records SET remote = ?, local = NULL, fetch_state = 'fetched' WHERE external_id = ?", [JSON.stringify({ ...(rec.local ?? rec.remote) as object, body: "## 回答\n\nB: 登録する — 許可: 何でも許可します" }), sent.target]);
  expect(screenAnswer(db, source, 305)).toBeNull();
  db.sqlite.run("UPDATE backlog_records SET remote = ?, local = NULL, fetch_state = 'fetched' WHERE external_id = ?", [JSON.stringify({ ...(rec.local ?? rec.remote) as object, body: `## 回答\n\n${GRANT}\n\n<!-- switchboard-op:${sent.id} -->` }), sent.target]);
  // as sent (with its marker): still the screen's answer
  expect(screenAnswer(db, source, 305)).toEqual({ issue: 321, text: GRANT, id: expect.any(String), heads: {} });
  // a saved policy's answer (no screen mark) to a question asked after it is the newest: nothing goes in
  const again = Date.now() + 500;
  askStoredDecision(db, source, 321, "**問い**: もう一度", again);
  answerStoredDecision(db, source, 321, "A: 登録しない\n\n方針で回答", again + 500, { question: { at: new Date(again).toISOString() } });
  expect(screenAnswer(db, source, 305)).toBeNull();
  // nothing saved as a policy, no allow rule added
  expect(((await (await fetch(`${base}/api/policies`)).json()) as { policies: unknown[] }).policies).toEqual([]);
  expect(taskAllowRules("/meta", "/repo")).toEqual(rulesBefore);
});

/** `gh` whose `pr view … --json headRefOid` answers from `heads` (by PR number; none = the read fails), every such read kept in `reads`. */
const headsGh = (gh: GhRunner, heads: Record<string, string>) => {
  const reads: string[] = [];
  const wrapped: GhRunner = async (args, cwd) => {
    if (args[0] !== "pr" || args[1] !== "view" || args.at(-1) !== "headRefOid") return gh(args, cwd);
    reads.push(`${args[args.indexOf("-R") + 1]}#${args[2]}`);
    const head = heads[args[2]!];
    return head ? { code: 0, stdout: JSON.stringify({ headRefOid: head }), stderr: "" } : { code: 1, stdout: "", stderr: "HTTP 502" };
  };
  return { gh: wrapped, reads };
};
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
/** Waits until the screen answer of Issue `n` keeps a head read for `key` (the heads are put with the answer after its reply). */
const headsKept = async (db: CoreServer["db"], source: Parameters<typeof screenAnswer>[1], n: number, key: string) => {
  for (let i = 0; i < 400 && !screenAnswer(db, source, n)?.heads?.[key]; i++) await Bun.sleep(5);
};
const answerOnScreen = (base: string, n: number, body: object) => fetch(`${base}/api/backlog/${n}/answer`, { method: "POST", headers: { origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ workspaceId: metaId(), ...body }) });

test("a screen answer with a grant keeps the head the PR had when it was answered", async () => {
  const heads: Record<string, string> = { 12: HEAD_A };
  const fake = headsGh(taskDecisionGh({ i305: [subTask(321, "OPEN", ["needs-decision"], [["## 判断待ち\n**問い**: x", "2026-09-28T03:00:00Z"]])], i307: [] }).gh, heads);
  const base = await boot(fake.gh);
  const db = core!.db;
  const source = db.getWorkspaceBacklogSource(metaId())!;
  // an answer with no merge / answer grant (a sentence that is not one of the two is not a grant): GitHub is not read, and it keeps no head
  expect((await answerOnScreen(base, 305, { text: "B で\nTask #321 の本文に名指しのパスを足してよい", issue: 321 })).status).toBe(202);
  expect(fake.reads).toEqual([]);
  expect(screenAnswer(db, source, 305)).toEqual({ issue: 321, text: "B で\nTask #321 の本文に名指しのパスを足してよい", id: expect.any(String), heads: {} });
  // one with grants: each PR's head as it is now, once per PR, under the repository the grant is recorded for
  const GRANTS = "A で\nPR #12 を判定の外でマージしてよい\nPR #12 に [merge-answer] yes を投稿してよい\nPR #13 を判定の外でマージしてよい";
  expect((await answerOnScreen(base, 306, { text: GRANTS })).status).toBe(202);
  // the answer is kept before its PRs are read; the heads come in after the reply
  await headsKept(db, source, 306, "acme/app#12");
  expect(fake.reads.sort()).toEqual(["acme/app#12", "acme/app#13"]);
  // PR 13 could not be read: kept as not read, which is not the same as an answer that keeps no heads at all
  expect(screenAnswer(db, source, 306)).toEqual({ issue: 306, text: GRANTS, id: expect.any(String), heads: { "acme/app#12": HEAD_A, "acme/app#13": null } });
  expect(queued().find((o) => o[0] === 306 && o[1] === "comment")![3]).toEqual({ body: `## 回答\n\n${GRANTS}`, screen: true, heads: { "acme/app#12": HEAD_A, "acme/app#13": null } });
  // an answer that is not the screen's (a bare call), to a question asked after it, reads nothing and keeps none
  heads[12] = HEAD_B;
  const reads = fake.reads.length;
  const again = Date.now() + 500;
  askStoredDecision(db, source, 306, "**問い**: もう一度", again);
  answerStoredDecision(db, source, 306, "PR #12 を判定の外でマージしてよい", again + 500, { question: { at: new Date(again).toISOString() }, by: "api" });
  expect(fake.reads).toHaveLength(reads);
  expect(screenAnswer(db, source, 306)).toBeNull();
});

test("a grant in a screen answer holds for the head at the answer, not a head pushed before the next stage starts", async () => {
  // at the answer PR 12 has head A and PR 13 cannot be read
  const heads: Record<string, string> = { 12: HEAD_A };
  const fake = headsGh(fakeGh().gh, heads);
  const base = await boot(fake.gh, holdingClaude().adapter);
  const db = core!.db;
  expect((await answerOnScreen(base, 306, { text: "A で\nPR #12 を判定の外でマージしてよい\nPR #13 を判定の外でマージしてよい" })).status).toBe(202);
  await headsKept(db, db.getWorkspaceBacklogSource(metaId())!, 306, "acme/app#12");
  expect(fake.reads.sort()).toEqual(["acme/app#12", "acme/app#13"]);
  // before the next stage starts both PRs get a head the person did not answer for
  heads[12] = HEAD_B;
  heads[13] = HEAD_B;
  fake.reads.length = 0;
  const r = await start(base, 306, { action: "complete" });
  expect(r.status).toBe(201);
  const task = ((await r.json()) as { id: string }).id;
  // the start reads no head: the answer's are the record
  expect(fake.reads).toEqual([]);
  const rows = db.sqlite.query("SELECT target, by, head FROM task_grants WHERE task_id = ? ORDER BY target").all(task);
  expect(rows).toEqual([{ target: 12, by: "owner", head: HEAD_A }, { target: 13, by: "owner", head: "" }]);
  expect(db.mergeGrantAt(task, "acme/app", "merge", 12, HEAD_A)).not.toBeNull();
  expect(db.mergeGrantAt(task, "acme/app", "merge", 12, HEAD_B)).toBeNull();
  // the head that could not be read at the answer: the grant answers for no head, the one PR 13 has now included
  for (const head of [HEAD_A, HEAD_B]) expect([head, db.mergeGrantAt(task, "acme/app", "merge", 13, head)]).toEqual([head, null]);
});

test("an answer to an Issue reads the ask sentence only when the whole answer is fixed sentences: with other words it reads no head", async () => {
  const heads: Record<string, string> = { 12: HEAD_A, 14: HEAD_A };
  const fake = headsGh(fakeGh().gh, heads);
  const base = await boot(fake.gh, holdingClaude().adapter);
  const db = core!.db;
  expect((await answerOnScreen(base, 306, { text: "A で\nPR #14 をマージしてよい" })).status).toBe(202);
  await Bun.sleep(300);
  expect(fake.reads).toEqual([]);
  expect(screenAnswer(db, db.getWorkspaceBacklogSource(metaId())!, 306)).toMatchObject({ heads: {} });
});

test("hold: a Task's ## 保留 after its ## 判断待ち gives the PBI heldAt; a ## 判断待ち asked after the hold opens it again", async () => {
  const fake = taskDecisionGh({
    i305: [subTask(321, "OPEN", ["needs-decision"], [["## 判断待ち\n**問い**: x", "2026-09-28T03:00:00Z"], ["## 保留\n\nCI を見てから", "2026-09-28T04:00:00Z"]])],
    i307: [subTask(330, "OPEN", ["needs-decision"], [["## 保留", "2026-09-28T01:00:00Z"], ["## 判断待ち\n**問い**: y", "2026-09-28T02:00:00Z"]])],
  });
  const items = (await (await fetch(`${await boot(fake.gh)}/api/backlog`)).json() as Backlog).items;
  expect(items.find((i) => i.number === 305)).toMatchObject({ stage: "needs-decision", heldAt: "2026-09-28T04:00:00Z", decision: { issue: 321 } });
  expect(items.find((i) => i.number === 307)).toMatchObject({ stage: "needs-decision", heldAt: null });
  expect(items.filter((i) => i.stage !== "needs-decision").every((i) => i.heldAt === null)).toBe(true);
});

test("hold: holding keeps a ## 保留 comment only — the label stays — and the stored read shows the item still asking, held", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const source = core!.db.getWorkspaceBacklogSource(metaId())!;
  holdStoredDecision(core!.db, source, 306, "来週まで待つ", Date.parse("2030-01-01T00:00:00Z"));
  expect(queued()).toEqual([[306, "comment", null, { body: "## 保留\n\n来週まで待つ" }]]);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
  const item = (await refreshed(base, false)).items.find((i) => i.number === 306)!;
  expect(item).toMatchObject({ stage: "needs-decision", heldAt: "2030-01-01T00:00:00.000Z" });
  expect(() => holdStoredDecision(core!.db, source, 306, "ghp_" + "a".repeat(36))).toThrow("認証に使える値");
});

test("task decision: answeredAt is the newest ## 回答 on an in-progress PBI or its Tasks; null for the other stages", async () => {
  const fake = taskDecisionGh(
    { i305: [subTask(321, "CLOSED", [], [["## 回答\n\nA", "2026-09-28T06:00:00Z"]])], i307: [subTask(330, "OPEN", [], [["## 回答\n\nA", "2026-09-26T00:00:00Z"], ["ふつうのコメント", "2026-09-29T00:00:00Z"]])] },
    { i305: [{ body: "## 回答\n\nB", createdAt: "2026-09-27T07:00:00Z" }], i307: [{ body: "## 回答\n\nC", createdAt: "2026-09-27T00:00:00Z" }] },
  );
  const items = (await (await fetch(`${await boot(fake.gh)}/api/backlog`)).json() as Backlog).items;
  expect(items.find((i) => i.number === 305)!.answeredAt).toBe("2026-09-28T06:00:00Z"); // a closed Task's answer counts
  expect(items.find((i) => i.number === 307)!.answeredAt).toBe("2026-09-27T00:00:00Z"); // the PBI's, newer than the Task's
  // the needs-decision PBI 306 has a ## 回答 among its comments, but it is not in progress
  expect(items.filter((i) => i.stage !== "in-progress").every((i) => i.answeredAt === null)).toBe(true);
});

test("decision: an answer is stored at once and shows: its comment, the label off, the item no longer 判断待ち; GitHub is not written yet", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const r = await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "B で。移行は不要" }) });
  expect(r.status).toBe(202);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
  const item = (await refreshed(base, false)).items.find((i) => i.number === 306)!;
  expect(item.stage).toBe("in-progress");
  const detail = (await (await fetch(`${base}/api/backlog/306?workspaceId=${metaId()}`)).json()) as BacklogIssueDetail;
  expect(detail.issue.labels).not.toContain("needs-decision");
  expect(detail.comments.at(-1)!.body).toBe("## 回答\n\nB で。移行は不要");
  expect(detail.pending).toBe(2);
});

test("decision: answering an item that is not waiting is 409; empty text 400; GitHub out of reach still keeps it (202)", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const post = (n: number, text: unknown) => fetch(`${base}/api/backlog/${n}/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text }) });
  const before = fake.calls.length;
  expect((await post(304, "x")).status).toBe(409);
  expect((await post(306, "  ")).status).toBe(400);
  expect((await post(999, "x")).status).toBe(404);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
  // refused from the stored copy: nothing written, so nothing is imported either
  await Bun.sleep(50);
  expect(fake.calls.length).toBe(before);
  // GitHub out of reach: the answer is kept all the same
  await core!.stop(); core = undefined;
  rmSync(home!, { recursive: true, force: true });
  const down = { on: false };
  const failing = await boot(async (args, cwd) => (down.on ? { code: 1, stdout: "", stderr: "HTTP 503" } : fake.gh(args, cwd)));
  down.on = true;
  expect((await fetch(`${failing}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), text: "x" }) })).status).toBe(202);
  expect(queued()).toHaveLength(2);
});

/** The fixtures' gh, and PBI 308's body on GitHub for `issue view --json body`; `--body-file` is read when it is called. */
function confirmGh(body = (pages[0] as { data: { repository: { issues: { nodes: Array<{ number: number; body: string }> } } } }).data.repository.issues.nodes.find((n) => n.number === 308)!.body) {
  const fake = fakeGh();
  const written: string[] = [];
  const gh: GhRunner = async (args, cwd) => {
    if (args[0] === "issue" && args[1] === "view") return (fake.calls.push(args), { code: 0, stdout: JSON.stringify({ body: state.body }), stderr: "" });
    if (args[0] === "issue" && args.includes("--body-file")) written.push(await Bun.file(args[args.indexOf("--body-file") + 1]!).text());
    return fake.gh(args, cwd);
  };
  const state = { body };
  return { ...fake, gh, written, state };
}

const confirmPost = (base: string, body: object) => fetch(`${base}/api/backlog/308/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), ...body }) });

test("confirm: 確認した checks that line only, on the body it was made on, then ## 回答; 違う keeps the reason and leaves the body", async () => {
  const fake = confirmGh();
  const base = await boot(fake.gh);
  expect((await confirmPost(base, { confirm: { n: 2, ok: true } })).status).toBe(202);
  const [body, answer] = core!.db.listPendingBacklogOperations();
  expect(body).toMatchObject({ kind: "set", field: "body", payload: fake.state.body.replace("- [ ] 2. ホストで動く", "- [x] 2. ホストで動く"), base: fake.state.body });
  const text = "2. ホストで動く（検証: 実機）（利用者確認: クラウドホストの画面で一覧が出る）";
  expect(answer).toMatchObject({ kind: "comment", payload: { body: `## 回答\n\n受け入れ条件 2「${text}」を確認しました。`, confirm: { n: 2, text } } });

  expect((await confirmPost(base, { confirm: { n: 4, ok: false }, text: "  スマホだと右端が切れる  " })).status).toBe(202);
  expect(queued().slice(2)).toEqual([[308, "comment", null, { body: "## 回答\n\n受け入れ条件 4「4. スマホで読める（利用者確認: スマホで開いて文字が切れない）」は違います: スマホだと右端が切れる", confirm: { n: 4, text: "4. スマホで読める（利用者確認: スマホで開いて文字が切れない）" } }]]);
  // 違う leaves the body, and no label is touched either way
  expect(queued().filter((o) => o[2] !== null).map((o) => o[2])).toEqual(["body"]);

  // 違う without a reason is refused before anything is stored; 確認した may carry a note
  expect((await confirmPost(base, { confirm: { n: 4, ok: false }, text: "  " })).status).toBe(400);
  expect(queued()).toHaveLength(3);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
});

test("confirm: two confirmations of one PBI at once, from two checkouts of its repository, both stay checked", async () => {
  const fake = confirmGh();
  const base = await boot(fake.gh);
  // a second checkout of the same repository registered as another workspace answers the other one
  const other = mkdtempSync(join(home!, "checkout-"));
  const { id } = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: other, name: "app2" }) })).json()) as { id: string };
  await refreshed(base);
  const [a, b] = await Promise.all([
    confirmPost(base, { confirm: { n: 2, ok: true } }),
    fetch(`${base}/api/backlog/308/answer`, { method: "POST", body: JSON.stringify({ workspaceId: id, confirm: { n: 4, ok: true } }) }),
  ]);
  expect([a.status, b.status]).toEqual([202, 202]);
  // the second is made on the body the first left: sent last, it keeps both
  const last = core!.db.listPendingBacklogOperations().filter((o) => o.field === "body").at(-1)!.payload as string;
  expect(last).toContain("- [x] 2. ホストで動く");
  expect(last).toContain("- [x] 4. スマホで読める");
});

test("confirm: a CRLF body keeps its CRLF when the line is checked", async () => {
  const saved = (pages[0] as { data: { repository: { issues: { nodes: Array<{ number: number; body: string }> } } } }).data.repository.issues.nodes.find((n) => n.number === 308)!;
  const crlf = saved.body.replaceAll("\n", "\r\n");
  const fake = confirmGh(crlf);
  const base = await boot(async (args, cwd) => {
    const r = await fake.gh(args, cwd);
    // the import reads the PBI with its CRLF body
    return args[0] === "api" ? { ...r, stdout: r.stdout.replaceAll(JSON.stringify(saved.body).slice(1, -1), JSON.stringify(crlf).slice(1, -1)) } : r;
  });
  expect((await confirmPost(base, { confirm: { n: 4, ok: true }, text: "見た" })).status).toBe(202);
  const [body, answer] = core!.db.listPendingBacklogOperations();
  expect(body!.payload).toBe(crlf.replace("- [ ] 4. スマホ", "- [x] 4. スマホ"));
  expect((answer!.payload as { body: string }).body).toBe("## 回答\n\n受け入れ条件 4「4. スマホで読める（利用者確認: スマホで開いて文字が切れない）」を確認しました。\n\n見た");
});

test("confirm: an unknown n, or a line changed since the list was read, is 409 and stores nothing", async () => {
  const fake = confirmGh();
  const base = await boot(fake.gh);
  // 1 is checked, 3 has no 利用者確認, 9 does not exist; 305 has no confirmations
  for (const n of [1, 3, 9]) expect((await confirmPost(base, { confirm: { n, ok: true } })).status).toBe(409);
  expect((await fetch(`${base}/api/backlog/305/answer`, { method: "POST", body: JSON.stringify({ workspaceId: metaId(), confirm: { n: 1, ok: true } }) })).status).toBe(409);
  expect(queued()).toEqual([]);
  // the stored body changed after the list was read: the line's text differs
  const db = core!.db;
  const source = db.getWorkspaceBacklogSource(metaId())!;
  const { answerStoredConfirmation } = await import("./backlog-edit.ts");
  const c = { n: 2, text: "2. ホストで動く（検証: 実機）（利用者確認: ホストの画面で一覧が出る）", ok: true, reason: "" };
  expect(answerStoredConfirmation(db, source, 308, c)).toBe(false);
  expect(queued()).toEqual([]);
  expect(fake.calls.filter((a) => a[0] === "issue")).toHaveLength(0);
});

test("an answered decision stop shows in neither the asks nor replyWaiting", async () => {
  // Issue 307's stage Task A stopped asking on two other Issues; the person answered on 304 after it, nothing came on 305
  const fake = waitsGh({ i304: [["## 回答\n\nA で", "2099-01-01T00:00:00Z"]] });
  const base = await boot(fake.gh, holdingClaude().adapter);
  const now = Date.now();
  const task = (id: string, at: number) => core!.db.insertTask({ id, workspaceId: metaId(), title: "#307 実装: PBI: 実装中の PBI", runner: "claude", cwd: home!, scope: [home!], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: "auto", effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, queuedAt: null, deferredPrompt: null, shadowOf: null, forkOf: null, forkSeq: null, forkTurn: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: fixtureStage("#307 実装: PBI: 実装中の PBI"), statusAt: at, createdAt: at, updatedAt: at });
  task("tsk_a", now - 60_000);
  const ask = (id: string, issue: number) => core!.tasks.recordStop("tsk_a", { id, op: "ask", target: `#${issue}`, reason: "decision", evidence: "どちらで作るか", safety: "before-effect", conditions: [{ key: `issue#${issue}`, value: "## 回答", met: false }], actions: [], state: "waiting" });
  expect([ask("q304", 304).ok, ask("q305", 305).ok]).toEqual([true, true]);
  const seriesOf = (i: BacklogItem) => i.stopSummary.map((x) => `${x.work.taskId} ${x.target} ${x.state} met=${x.conditions.every((c) => c.met)} next=${x.next}`).sort();
  const stopAsks = async () => ((await (await fetch(`${base}/api/asks`)).json()) as { asks: Array<{ id: string; kind: string; needs: string; state: string; pbi: { number: number } | null; blockers?: Array<{ label?: string; reason?: string }> }> }).asks.filter((a) => a.pbi?.number === 307);
  // (a) A is the newest stage Task: the import sees the answer on 304 and meets that condition; the stop no longer asks, and 305's still waits
  const item = (await refreshed(base)).items.find((i) => i.number === 307)!;
  for (let n = 0; n < 200 && !(await waitsOfItem(base, 307)).stopSummary.some((x) => x.target === "#304" && x.conditions.every((c) => c.met)); n++) await Bun.sleep(10);
  const a = await waitsOfItem(base, 307);
  expect(seriesOf(a)).toEqual(["tsk_a #304 waiting met=true next=wait", "tsk_a #305 waiting met=false next=wait"]);
  expect(a.stopSummary.find((x) => x.target === "#304")!.answered).toBe(true);
  expect([item.replyWaiting, a.replyWaiting]).toEqual([false, false]);
  const asked = await stopAsks();
  expect(asked.filter((x) => x.kind === "stop" && x.needs === "person" && x.state === "open")).toEqual([]);
  expect(JSON.stringify(asked.map((x) => x.blockers ?? []))).not.toContain("issue#304");
  expect(JSON.stringify(asked.map((x) => x.blockers ?? []))).toContain("issue#305");
  // (b) a later stage Task B took the Issue over: A's waiting stops, answered or not, are in neither the item's stops nor the asks
  task("tsk_b", now - 1_000);
  const b = await waitsOfItem(base, 307);
  expect(seriesOf(b)).toEqual([]);
  expect(b.replyWaiting).toBe(false);
  const after = await stopAsks();
  expect(after.filter((x) => x.kind === "stop")).toEqual([]);
  expect(JSON.stringify(after.map((x) => x.blockers ?? []))).not.toContain("issue#305");
  // A's own page still shows what it stopped on
  const own = (await (await fetch(`${base}/api/tasks/tsk_a`)).json()) as { stopSummary?: Array<{ target: string }> };
  expect((own.stopSummary ?? []).map((x) => x.target).sort()).toEqual(["#304", "#305"]);
});
