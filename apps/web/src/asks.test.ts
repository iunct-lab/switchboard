import { expect, test } from "bun:test";
import type { Ask, AskBatch } from "@switchboard/protocol";
import { answerButtons, batchLines, hiddenByBatches, grantOf, taskAsks, withoutGrant, appliedLine, askFacts, initialPolicyForm, policyInput, policySummary, previousLines, scopeLabel, blockerLines, groupAsks, keptAnswers, KIND_LABEL, pruneAnswered, resumeLabel, UNKNOWN_WORKSPACE, unblocksLine, workspaceChips, workspaceSections, type Answered } from "./asks.ts";

const ask = (over: Partial<Ask>): Ask => ({
  id: "a", kind: "decision", needs: "person", state: "open", at: 1, changedAt: 1, workspace: null, pbi: null, issue: null, task: null, reason: null, question: null, choices: [], grants: [], grant: null, recommendation: null, next: null,
  source: { label: "記録", url: null, taskId: null }, route: "none", conditions: [], answers: [], place: null, blockers: [], resume: null, subject: null, policy: { scopes: [], note: null, defaults: null, applied: null, previous: null }, unblocks: [], priority: null, ...over,
});

test("groupAsks: the six kinds open, and answered / resolved ones, fall into the four groups in order; an empty group is left out", () => {
  const asks = [
    ask({ id: "approval", kind: "approval" }),
    ask({ id: "decision", kind: "decision" }),
    ask({ id: "check", kind: "check" }),
    ask({ id: "confirmation", kind: "confirmation" }),
    ask({ id: "stop", kind: "stop", needs: "auto" }),
    ask({ id: "wait", kind: "wait", needs: "auto" }),
    ask({ id: "answered", kind: "approval", state: "answered" }),
    ask({ id: "resolved-auto", kind: "stop", needs: "auto", state: "resolved" }),
  ];
  const groups = groupAsks(asks);
  expect(groups.map((g) => [g.key, g.label, g.asks.map((a) => a.id)])).toEqual([
    ["person", "あなたの判断待ち", ["approval", "decision", "check", "confirmation"]],
    ["auto", "自動で待っている（操作不要）", ["stop", "wait"]],
    ["answered", "回答済み", ["answered"]],
    ["resolved", "解消済み", ["resolved-auto"]],
  ]);
  expect(groupAsks([ask({})]).map((g) => g.key)).toEqual(["person"]);
  expect(Object.keys(KIND_LABEL).sort()).toEqual(["approval", "check", "confirmation", "decision", "notice", "stop", "wait"]);
});

test("unblocksLine (#1674): none waiting is null; two say 答えると 2 件が進められる", () => {
  const pbi = (n: number) => ({ number: n, title: `t${n}`, url: `https://github.com/o/r/issues/${n}` });
  expect(unblocksLine(ask({}))).toBeNull();
  expect(unblocksLine(ask({ unblocks: [pbi(20), pbi(21)] }))).toBe("答えると 2 件が進められる");
});

test("groupAsks keeps the order the API gave within a group (#1674: the person's are ranked by the API, not here)", () => {
  const asks = [ask({ id: "few", at: 3 }), ask({ id: "auto", needs: "auto" }), ask({ id: "many", at: 1, unblocks: [{ number: 2, title: "t", url: "u" }] }), ask({ id: "held", state: "held", at: 2 })];
  expect(groupAsks(asks)[0]!.asks.map((a) => a.id)).toEqual(["few", "many", "held"]);
});

test("workspaceSections: one heading per Workspace, the most questions first, then by name, the unknown (null) last; each keeps the order given", () => {
  const a = { id: "wa", name: "alpha" };
  const b = { id: "wb", name: "beta" };
  const c = { id: "wc", name: "gamma" };
  const asks = [
    ask({ id: "n1" }),
    ask({ id: "c1", workspace: c }),
    ask({ id: "b1", workspace: b }),
    ask({ id: "n2" }),
    ask({ id: "n3" }),
    ask({ id: "a1", workspace: a }),
    ask({ id: "c2", workspace: c }),
    ask({ id: "b2", workspace: b }),
    ask({ id: "a2", workspace: a }),
    ask({ id: "c3", workspace: c }),
  ];
  expect(workspaceSections(asks).map((s) => [s.key, s.name, s.asks.map((x) => x.id)])).toEqual([
    ["wc", "gamma", ["c1", "c2", "c3"]],
    ["wa", "alpha", ["a1", "a2"]],
    ["wb", "beta", ["b1", "b2"]],
    // the unknown one comes last though it has as many as the most
    ["", UNKNOWN_WORKSPACE, ["n1", "n2", "n3"]],
  ]);
  expect(UNKNOWN_WORKSPACE).toBe("Workspace 不明");
  expect(workspaceSections([])).toEqual([]);
});

test("workspaceChips: every Workspace in the headings' order, counting only the person's to answer (open for the person, or held); one with only answered questions shows 0", () => {
  const a = { id: "wa", name: "alpha" };
  const b = { id: "wb", name: "beta" };
  const asks = [
    ask({ id: "a-open", workspace: a }),
    ask({ id: "a-held", workspace: a, state: "held" }),
    ask({ id: "a-auto", workspace: a, kind: "wait", needs: "auto" }),
    ask({ id: "b-answered", workspace: b, state: "answered" }),
    ask({ id: "b-resolved", workspace: b, state: "resolved" }),
    ask({ id: "b-answered2", workspace: b, state: "answered" }),
    ask({ id: "n-open" }),
  ];
  expect(workspaceChips(asks)).toEqual([
    { key: "wa", name: "alpha", count: 2 },
    { key: "wb", name: "beta", count: 0 },
    { key: "", name: UNKNOWN_WORKSPACE, count: 1 },
  ]);
});

test("askFacts: every fact is there, a null one says 不明; the recommendation is <choice> — <why>; links go to the record", () => {
  const empty = askFacts(ask({}));
  expect(empty.map((f) => f.label)).toEqual(["対象リポジトリ", "PBI", "Task", "停止理由", "問い", "推奨と根拠", "回答後", "元の記録"]);
  expect(empty.filter((f) => f.label !== "元の記録").every((f) => f.value === "不明")).toBe(true);
  const full = askFacts(
    ask({
      workspace: { id: "ws", name: "switchboard" }, pbi: { number: 3, title: "PBI: 判断待ち", url: "https://github.com/o/r/issues/3" }, task: { id: "tk", title: "#3 実装" }, reason: "実装の判断", question: "どちらにするか",
      choices: ["A: 置き換える", "B: 新しい画面"], recommendation: { choice: "A", why: "画面を増やさない" }, next: "#3 の続きの工程 Task", source: { label: "#9 の ## 判断待ち", url: "https://github.com/o/r/issues/9", taskId: null },
    }),
  );
  const by = Object.fromEntries(full.map((f) => [f.label, f]));
  expect(by["対象リポジトリ"]!.value).toBe("switchboard");
  expect(by["PBI"]).toEqual({ label: "PBI", value: "#3 PBI: 判断待ち", href: "https://github.com/o/r/issues/3" });
  expect(by["Task"]!.value).toBe("#3 実装");
  expect(by["選択肢"]!.value).toBe("A: 置き換える\nB: 新しい画面");
  expect(by["推奨と根拠"]!.value).toBe("A — 画面を増やさない");
  expect(by["元の記録"]).toEqual({ label: "元の記録", value: "#9 の ## 判断待ち", href: "https://github.com/o/r/issues/9" });
  expect(askFacts(ask({ recommendation: { choice: "A", why: "" } })).find((f) => f.label === "推奨と根拠")!.value).toBe("A");
  // a task with no title is named by its id
  expect(askFacts(ask({ task: { id: "tk_1", title: null } })).find((f) => f.label === "Task")!.value).toBe("tk_1");
});

test("askFacts: an automatic one lists its conditions as key: value, met ones marked", () => {
  const facts = askFacts(ask({ needs: "auto", kind: "wait", conditions: [{ key: "pr#70", value: "open", met: false }, { key: "issue#71", value: "closed", met: true }] }));
  expect(facts.find((f) => f.label === "条件")!.value).toBe("pr#70: open\nissue#71: closed（済み）");
  expect(askFacts(ask({})).some((f) => f.label === "条件")).toBe(false);
});

test("answerButtons: an approval's two; a decision's recommended choice first as 推奨案で進める, the other, and 保留; a check without choices has none; no answers, no buttons", () => {
  const approval = answerButtons(ask({ kind: "approval", answers: ["allow", "deny"], reason: "ツールの実行に承認が要る: Write", task: { id: "tk", title: "書く Task" }, next: "Task「書く Task」がそのまま続く" }));
  expect(approval.map((b) => [b.label, b.answer, b.send, b.target, b.primary])).toEqual([
    ["承認して続行", { kind: "allow" }, "Write を許可", "Task「書く Task」", true],
    ["拒否", { kind: "deny" }, "拒否", "Task「書く Task」", false],
  ]);
  const decision = answerButtons(
    ask({ kind: "decision", answers: ["choice", "text", "hold"], choices: ["A: DB — 影響: 表が増える", "B: ファイル — 影響: 移行が要らない"], recommendation: { choice: "B", why: "小さい" }, issue: { number: 9, url: "u" }, next: "#3 の続きの工程 Task" }),
  );
  expect(decision.map((b) => [b.label, b.primary])).toEqual([["推奨案で進める（B）", true], ["A で進める", false], ["保留", false]]);
  expect(decision[0]).toMatchObject({ answer: { kind: "choice", choice: "B: ファイル — 影響: 移行が要らない" }, send: "B: ファイル — 影響: 移行が要らない", target: "Issue #9", next: "#3 の続きの工程 Task" });
  expect(decision[2]).toMatchObject({ answer: { kind: "hold" }, next: "続行しない" });
  // free text only: the card's text box
  expect(answerButtons(ask({ kind: "check", answers: ["text"], task: { id: "tk", title: "t" } }))).toEqual([]);
  expect(answerButtons(ask({ kind: "confirmation", answers: ["confirm"], question: "スマホで読める" })).map((b) => [b.label, b.answer])).toEqual([["確認した", { kind: "confirm", ok: true }]]);
  expect(answerButtons(ask({ kind: "stop", answers: [], blockers: [{ kind: "runner", detail: "x" }] }))).toEqual([]);
  // a full-width colon needs no space; a time is not a choice's head
  expect(answerButtons(ask({ kind: "check", answers: ["choice"], choices: ["A：置き換える"], recommendation: { choice: "A", why: "" } }))[0]!.label).toBe("推奨案で進める（A）");
  expect(answerButtons(ask({ kind: "check", answers: ["choice"], choices: ["10:00 に再実行する", "A: 今すぐ"], recommendation: { choice: "A", why: "" } })).map((b) => b.label)).toEqual(["推奨案で進める（A）", "10:00 に再実行する で進める"]);
});

test("resumeLabel: answered, waiting to resume with its reason, running, failed with its reason; nothing before an answer", () => {
  expect(resumeLabel(ask({ state: "open" }))).toBeNull();
  expect(resumeLabel(ask({ state: "answered" }))).toEqual({ text: "回答済み", tone: "ok" });
  expect(resumeLabel(ask({ state: "answered", resume: { state: "queued", reason: "PR #70 が未マージ", taskId: null, at: 1 } }))).toEqual({ text: "再開待ち: PR #70 が未マージ", tone: "wait" });
  expect(resumeLabel(ask({ state: "answered", resume: { state: "running", reason: null, taskId: "tk", at: 1 } }))).toEqual({ text: "実行中", tone: "ok" });
  expect(resumeLabel(ask({ state: "open", resume: { state: "failed", reason: "budget exceeded", taskId: "tk", at: 1 } }))).toEqual({ text: "再開失敗: budget exceeded", tone: "bad" });
});

test("blockerLines: what an answer does not take away, one line each", () => {
  expect(
    blockerLines(ask({ blockers: [{ kind: "depends", detail: "PR #70 が未マージ" }, { kind: "condition", detail: "ci: failure" }, { kind: "runner", detail: "git push origin: denied（ランナー側の拒否。回答では解除されません）" }] })),
  ).toEqual(["回答だけでは解除されません: PR #70 が未マージ", "回答だけでは解除されません: ci: failure", "git push origin: denied（ランナー側の拒否。回答では解除されません）"]);
});

test("pruneAnswered / keptAnswers: the list replaces an answer it has the question of; one that left it stays as its card; a 409's notice stays until its question changes", () => {
  const check = ask({ id: "check:t1:9", kind: "check", state: "answered", task: { id: "t1", title: "t" } });
  const approval = ask({ id: "approval:t2:p", kind: "approval", state: "answered", task: { id: "t2", title: "t" } });
  const decision = ask({ id: "decision:ws#3@a", kind: "decision", state: "answered", workspace: { id: "ws", name: "w" }, pbi: { number: 3, title: "p", url: "u" } });
  const changed = ask({ id: "check:t3:4", kind: "check", changedAt: 5 });
  const m = new Map<string, Answered>([[check.id, { ask: check }], [approval.id, { ask: approval }], [decision.id, { ask: decision }], [changed.id, { ask: changed, changes: ["PR #12 の差分が変わりました"], changed: true }]]);
  // the list: the approval answered (same id), #3 answered under its new id, the check gone, the changed one as it was
  const list = [ask({ id: approval.id, kind: "approval", state: "resolved" }), ask({ id: "decision:ws#3@b", kind: "decision", state: "answered", workspace: { id: "ws", name: "w" }, pbi: { number: 3, title: "p", url: "u" } }), ask({ id: changed.id, kind: "check", changedAt: 5 })];
  const pruned = pruneAnswered(m, list);
  expect([...pruned.keys()].sort()).toEqual([changed.id, check.id, decision.id].sort());
  expect(keptAnswers(pruned, list).map((a) => a.id)).toEqual([check.id]);
  // the changed question moved again: its notice goes
  expect([...pruneAnswered(pruned, [ask({ id: changed.id, kind: "check", changedAt: 6 })]).keys()]).not.toContain(changed.id);
  // an answer with neither PBI nor Task is not taken for another one answered
  const bare = ask({ id: "x", kind: "stop", state: "answered" });
  expect(keptAnswers(new Map([["x", { ask: bare }]]), [ask({ id: "y", kind: "stop", state: "answered" })]).map((a) => a.id)).toEqual(["x"]);
});

const subject = { kind: "approval" as const, op: "exec", target: "bun test packages/core", conditions: [], head: null };
const NOW = Date.parse("2026-10-17T12:00:00Z");

test("policy: summary — an exec approval with two conditions and a 30-day expiry gives five lines; no condition says なし", () => {
  const a = ask({ subject });
  const input = { scope: "repo" as const, target: "bun test*", when: [{ key: "area", value: "web" }, { key: "ci", value: "green" }], expiresAt: NOW + 30 * 86_400_000 };
  expect(policySummary(a, input, "bun test を許可", NOW)).toEqual(["操作: exec", "対象: bun test*", "条件: area=web ci=green", "期限: 2026-11-16（あと 30 日）", "回答: bun test を許可"]);
  expect(policySummary(a, { ...input, when: [] }, "許可", NOW)[2]).toBe("条件: なし");
});

test("policy: scope labels — the three ranges name the PBI number and the workspace", () => {
  const a = ask({ pbi: { number: 938, title: "t", url: "u" }, workspace: { id: "w", name: "switchboard" } });
  expect(["once", "pbi", "repo"].map((s) => scopeLabel(s as "once", a))).toEqual(["今回のみ", "この PBI 内（#938）", "このリポジトリ（switchboard）"]);
});

test("policy: previous — why and the changes are lined up as the server gave them; null gives none", () => {
  const policy = { scopes: [], note: null, defaults: null, applied: null, previous: { id: "pol_1", answer: { kind: "choice" as const, choice: "A: マージする" }, at: NOW, why: "期限切れ", changes: ["対象: PR #12 → PR #13"] } };
  expect(previousLines(ask({ policy }))).toEqual(["前回の回答: A: マージする（2026-10-17、方針 pol_1）", "適用しなかった理由: 期限切れ", "対象: PR #12 → PR #13"]);
  expect(previousLines(ask({}))).toEqual([]);
});

test("policy: applied — the summary as one line; null gives none; the form starts at 今回のみ and sends nothing until a range is chosen", () => {
  const policy = { scopes: ["once" as const, "repo" as const], note: null, defaults: { target: "PR #12", when: [{ key: "area", value: "web" }], expiresAt: NOW + 86_400_000 }, applied: { id: "pol_1", scope: "repo" as const, at: NOW, summary: "repo / gh pr merge PR #12 / 期限 2026-10-18" }, previous: null };
  expect(appliedLine(ask({ policy }))).toBe("方針で回答: repo / gh pr merge PR #12 / 期限 2026-10-18");
  expect(appliedLine(ask({}))).toBeNull();
  const form = initialPolicyForm(ask({ policy }))!;
  expect(policyInput(form)).toBeUndefined();
  // opened and left at 今回のみ: kept as a one-time policy; a stage Task's PBI is named too
  expect(policyInput({ ...form, opened: true })).toEqual({ scope: "once", target: "PR #12", when: [], expiresAt: null });
  expect(scopeLabel("pbi", ask({ task: { id: "t", title: null, stageIssue: 938 } }))).toBe("この PBI 内（#938）");
  const repo = policyInput({ ...form, opened: true, scope: "repo", when: [{ ...form.when[0]!, on: false }] })!;
  expect(repo).toMatchObject({ scope: "repo", target: "PR #12", when: [] });
  expect(initialPolicyForm(ask({}))).toBeNull();
});

test("policy: the expiry day is the JST date, and it ends at 23:59:59 JST whatever the browser's time zone (#2028)", () => {
  // 2026-10-18T16:00Z is 01:00 JST on 10/19
  const policy = { scopes: ["once" as const, "repo" as const], note: null, defaults: { target: "PR #12", when: [], expiresAt: Date.parse("2026-10-18T16:00:00Z") }, applied: null, previous: null };
  const form = initialPolicyForm(ask({ policy }))!;
  expect(form.expires).toBe("2026-10-19");
  expect(policyInput({ ...form, opened: true, scope: "repo" })!.expiresAt).toBe(Date.parse("2026-10-19T14:59:59Z"));
});

test("grant button: a stop with a grant gets この操作だけ許可して続ける first, sending the grant — to its Issue for a stage Task's (#2745)", () => {
  const GRANT = "定期実行 sch_x を POST /api/schedules に登録することだけ許可します";
  const stop = ask({ kind: "stop", answers: ["grant", "text"], grant: GRANT, task: { id: "tk", title: "t" }, next: "Task「t」が続く" });
  const [b] = answerButtons(stop);
  expect(b).toMatchObject({ label: "この操作だけ許可して続ける", answer: { kind: "grant" }, send: GRANT, grant: GRANT, target: "Task「t」", primary: true });
  expect(answerButtons({ ...stop, issue: { number: 306, url: "u" } })[0]!.target).toBe("Issue #306");
  // a stop without one has no such button
  expect(answerButtons(ask({ kind: "stop", answers: ["text"] }))).toEqual([]);
});

test("choice grant line: a choice's ` — 許可: ` is its grant, sent with the choice and shown on its own line (#2745)", () => {
  const B = "B: 登録する — 影響: 毎日 PR が出る — 許可: 定期実行 sch_x を登録することだけ許可します";
  expect(grantOf(B)).toBe("定期実行 sch_x を登録することだけ許可します");
  expect(withoutGrant(B)).toBe("B: 登録する — 影響: 毎日 PR が出る");
  expect(grantOf("A: 登録しない")).toBeNull();
  const [rec, a] = answerButtons(ask({ kind: "check", answers: ["choice", "text"], choices: ["A: 登録しない", B], recommendation: { choice: "B", why: "" } }));
  expect(rec).toMatchObject({ label: "推奨案で進める（B）", send: B, grant: "定期実行 sch_x を登録することだけ許可します" });
  expect(a).toMatchObject({ send: "A: 登録しない", grant: null });
});

test("taskAsks: a Task's screen takes its open checks and the stops a person answers, not another Task's or automatic ones (#2745)", () => {
  const t = { id: "tk", title: "t" };
  const list = [ask({ id: "c", kind: "check", task: t }), ask({ id: "s", kind: "stop", task: t }), ask({ id: "auto", kind: "stop", needs: "auto", task: t }), ask({ id: "done", kind: "check", state: "answered", task: t }), ask({ id: "other", kind: "check", task: { id: "tk2", title: "u" } }), ask({ id: "ap", kind: "approval", task: t })];
  expect(taskAsks(list, "tk").map((a) => a.id)).toEqual(["c", "s"]);
});

test("batch lines and hidden asks", () => {
  const now = Date.parse("2026-10-20T03:00:00Z");
  const batch: AskBatch = {
    id: "batch:sso",
    kind: "sso",
    asks: [
      { askId: "check:tk_a:", taskId: "tk_a", title: "A", workspaceId: "ws_1", op: "aws sso login", at: Date.parse("2026-10-20T02:30:00Z") },
      { askId: "stop:task:tk_b|aws sso login||auth|", taskId: "tk_b", title: "B", workspaceId: "ws_2", op: "aws sso login", at: Date.parse("2026-10-19T02:30:00Z") },
    ],
    loggingIn: null,
    deviceAuth: null,
  };
  expect(batchLines(batch, now)).toEqual([
    { taskId: "tk_a", text: "A — aws sso login — 11:30" },
    { taskId: "tk_b", text: "B — aws sso login — 10/19 11:30" },
  ]);
  const asks = [ask({ id: "check:tk_a:" }), ask({ id: "stop:task:tk_b|aws sso login||auth|" }), ask({ id: "decision:x" })];
  expect(hiddenByBatches(asks, [batch]).map((a) => a.id)).toEqual(["decision:x"]);
  expect(hiddenByBatches(asks, []).map((a) => a.id)).toHaveLength(3);
  // the Task logging in: its open stop is left out too, its other questions stay
  const mine = [ask({ id: "stop:task:tk_c|x||auth|", kind: "stop", state: "open", task: { id: "tk_c", title: "C" } }), ask({ id: "approval:tk_c:p1", kind: "approval", state: "open", task: { id: "tk_c", title: "C" } })];
  expect(hiddenByBatches(mine, [{ ...batch, asks: [], loggingIn: { taskId: "tk_c", title: "C" } }]).map((a) => a.id)).toEqual(["approval:tk_c:p1"]);
});

test("answerButtons: a scan notice (#2866) is closed by 誤検知として閉じる only", () => {
  const b = answerButtons(ask({ kind: "notice", answers: ["dismiss"], question: "認証の値の検査: 当たり 1 件 / 検査できなかった 0 リポジトリ" }));
  expect(b.map((x) => [x.label, x.answer])).toEqual([["誤検知として閉じる", { kind: "dismiss" }]]);
  expect(KIND_LABEL.notice).toBe("お知らせ");
  expect(answerButtons(ask({ kind: "notice", answers: [] }))).toEqual([]);
});

test("askFacts: a notice (#2866) shows what it is about, why, what to do and what put it there, no PBI / Task / 不明", () => {
  const facts = askFacts(ask({ kind: "notice", question: "workspace app を使えません", reason: "origin は x、登録は y です。", next: "登録のリポジトリの clone にする", source: { label: "workspace の検査", url: null, taskId: null } }));
  expect(facts).toEqual([
    { label: "お知らせ", value: "workspace app を使えません" },
    { label: "内容", value: "origin は x、登録は y です。" },
    { label: "すること", value: "登録のリポジトリの clone にする" },
    { label: "出したもの", value: "workspace の検査" },
  ]);
});
