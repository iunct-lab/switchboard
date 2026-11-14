import { expect, test } from "bun:test";
import type { Ask, AskBatch } from "@switchboard/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswerArea } from "./components/Approvals.tsx";
import { answerButtons, answerRoute, choiceParts, askCardParts, batchLines, questionHead, replyPreview, replyTarget, hiddenByBatches, grantOf, taskAsks, withoutGrant, appliedLine, askFacts, initialPolicyForm, policyInput, policySummary, broadTarget, previousLines, scopeLabel, blockerLines, groupAsks, isQuick, keptAnswers, KIND_LABEL, quickRows, answeredHere, answeredInRow, askRows, rowKey, pruneAnswered, resumeLabel, UNKNOWN_WORKSPACE, issueOpenHref, unblockLinks, unblocksLine, workspaceChips, workspaceSections, type Answered } from "./asks.ts";

const ask = (over: Partial<Ask>): Ask => ({
  id: "a", kind: "decision", needs: "person", state: "open", at: 1, changedAt: 1, workspace: null, pbi: null, issue: null, task: null, reason: null, question: null, choices: [], grants: [], grant: null, recommendation: null, next: null,
  source: { label: "記録", url: null, taskId: null }, route: "none", conditions: [], answers: [], place: null, blockers: [], resume: null, subject: null, policy: { scopes: [], note: null, defaults: null, applied: null, previous: null }, unblocks: [], priority: null, ...over,
});

test("groupAsks: the six kinds open, and answered / resolved ones, fall into the three groups in order (answered and resolved share 済んだもの); an empty group is left out", () => {
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
    ["done", "済んだもの", ["answered", "resolved-auto"]],
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
  // a question tool's check: its options carry ` (Recommended)`, so no 推奨と根拠 that would say 不明
  const q = { header: null, question: "PR #1 をマージしてよいか", options: [{ label: "マージする (Recommended)", description: null }], multiSelect: false };
  expect(askFacts(ask({ kind: "check", questions: [q] })).map((f) => f.label)).not.toContain("推奨と根拠");
  // a task with no title is named by its id
  expect(askFacts(ask({ task: { id: "tk_1", title: null } })).find((f) => f.label === "Task")!.value).toBe("tk_1");
});

test("askFacts: an automatic one lists its conditions as key: value, met ones marked", () => {
  const facts = askFacts(ask({ needs: "auto", kind: "wait", conditions: [{ key: "pr#70", value: "open", met: false }, { key: "issue#71", value: "closed", met: true }] }));
  expect(facts.find((f) => f.label === "条件")!.value).toBe("pr#70: open\nissue#71: closed（済み）");
  expect(askFacts(ask({})).some((f) => f.label === "条件")).toBe(false);
});

test("answerButtons: an approval's two; a decision's recommended choice first with （推奨）, the other, and 保留; a check without choices has none; no answers, no buttons", () => {
  const approval = answerButtons(ask({ kind: "approval", answers: ["allow", "deny"], reason: "ツールの実行に承認が要る: Write", task: { id: "tk", title: "書く Task" }, next: "Task「書く Task」がそのまま続く" }));
  expect(approval.map((b) => [b.label, b.answer, b.send, b.target, b.primary])).toEqual([
    ["承認して続行", { kind: "allow" }, "Write を許可", "Task「書く Task」", true],
    ["拒否", { kind: "deny" }, "拒否", "Task「書く Task」", false],
  ]);
  const decision = answerButtons(
    ask({ kind: "decision", answers: ["choice", "text", "hold"], choices: ["A: DB — 影響: 表が増える", "B: ファイル — 影響: 移行が要らない"], recommendation: { choice: "B", why: "小さい" }, issue: { number: 9, url: "u" }, next: "#3 の続きの工程 Task" }),
  );
  expect(decision.map((b) => [b.label, b.primary])).toEqual([["B: ファイル（推奨）", true], ["A: DB", false], ["保留", false]]);
  expect(decision[0]).toMatchObject({ answer: { kind: "choice", choice: "B: ファイル — 影響: 移行が要らない" }, send: "B: ファイル — 影響: 移行が要らない", target: "Issue #9", next: "#3 の続きの工程 Task" });
  expect(decision[2]).toMatchObject({ answer: { kind: "hold" }, next: "続行しない", sub: "続行しない" });
  expect(decision.map((b) => b.sub)).toEqual(["影響: 移行が要らない", "影響: 表が増える", "続行しない"]);
  // free text only: the card's text box
  expect(answerButtons(ask({ kind: "check", answers: ["text"], task: { id: "tk", title: "t" } }))).toEqual([]);
  expect(answerButtons(ask({ kind: "confirmation", answers: ["confirm"], question: "スマホで読める" })).map((b) => [b.label, b.answer])).toEqual([["確認した", { kind: "confirm", ok: true }]]);
  expect(answerButtons(ask({ kind: "stop", answers: [], blockers: [{ kind: "runner", detail: "x" }] }))).toEqual([]);
  // a full-width colon needs no space; a time is not a choice's head
  expect(answerButtons(ask({ kind: "check", answers: ["choice"], choices: ["A：置き換える"], recommendation: { choice: "A", why: "" } }))[0]!.label).toBe("A：置き換える（推奨）");
  expect(answerButtons(ask({ kind: "check", answers: ["choice"], choices: ["10:00 に再実行する", "A: 今すぐ"], recommendation: { choice: "A", why: "" } })).map((b) => b.label)).toEqual(["A: 今すぐ（推奨）", "10:00 に再実行する"]);
});

test("choiceParts: the head, the impact and the grant of a choice, apart", () => {
  expect(choiceParts("B: ファイル — 影響: 移行が要らない")).toEqual({ head: "B: ファイル", impact: "影響: 移行が要らない", grant: null });
  expect(choiceParts("B: 登録する — 影響: 毎日 PR が出る — 許可: 定期実行 sch_x を登録することだけ許可します")).toEqual({ head: "B: 登録する", impact: "影響: 毎日 PR が出る", grant: "定期実行 sch_x を登録することだけ許可します" });
  expect(choiceParts("A: 登録しない — 許可: 何もしない")).toEqual({ head: "A: 登録しない", impact: null, grant: "何もしない" });
  expect(choiceParts("10:00 に再実行する")).toEqual({ head: "10:00 に再実行する", impact: null, grant: null });
  expect(choiceParts("B: ファイル — 影響：移行が要らない")).toEqual({ head: "B: ファイル", impact: "影響：移行が要らない", grant: null });
});

test("answerRoute: one line per question — an Issue's answer is written there, a Task's is sent to it; no next reads as unknown", () => {
  expect(answerRoute(ask({ kind: "decision", issue: { number: 9, url: "u" }, next: "#3 の続きの工程 Task" }))).toBe("答えは Issue #9 に書かれます。続き: #3 の続きの工程 Task");
  expect(answerRoute(ask({ kind: "check", task: { id: "tk", title: "書く Task" }, next: "Task が続く" }))).toBe("答えは Task「書く Task」に送られます。続き: Task が続く");
  expect(answerRoute(ask({ kind: "check", task: { id: "tk", title: "t" }, next: null }))).toContain("続き: 不明");
  // a stage Task's stop that takes a grant: the grant is written on the stop's Issue, as its button sends it
  const stop = ask({ kind: "stop", issue: { number: 42, url: "u" }, task: { id: "tk", title: "工程" }, answers: ["grant"], grant: "PR #1 をマージすることだけ許可します", next: "Task が続く" });
  expect(answerRoute(stop)).toBe("答えは Issue #42 に書かれます。続き: Task が続く");
  expect(answerButtons(stop)[0]!.target).toBe("Issue #42");
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
  expect([...pruned.keys()].sort()).toEqual([changed.id, check.id].sort());
  expect(keptAnswers(pruned, list).map((a) => a.id)).toEqual([check.id]);
  // the changed question moved again: its notice goes
  expect([...pruneAnswered(pruned, [ask({ id: changed.id, kind: "check", changedAt: 6 })]).keys()]).not.toContain(changed.id);
  // an answer with neither PBI nor Task is not taken for another one answered
  const bare = ask({ id: "x", kind: "stop", state: "answered" });
  expect(keptAnswers(new Map([["x", { ask: bare }]]), [ask({ id: "y", kind: "stop", state: "answered" })]).map((a) => a.id)).toEqual(["x"]);
});

test("answered card gives way to the next question", () => {
  const t1 = { id: "t1", title: "t" };
  const answered = ask({ id: "check:t1:9", kind: "check", state: "answered", task: t1 });
  const m = new Map<string, Answered>([[answered.id, { ask: answered }]]);
  // the Task went on: its answered check left the list, the card stays
  expect(keptAnswers(pruneAnswered(m, []), []).map((a) => a.id)).toEqual([answered.id]);
  // only another Task's question: the card stays
  const other = [ask({ id: "check:t2:3", kind: "check", state: "open", task: { id: "t2", title: "u" } })];
  expect(keptAnswers(pruneAnswered(m, other), other).map((a) => a.id)).toEqual([answered.id]);
  // the same Task stopped again with an open question (a check or a stop): the card gives way
  for (const next of [ask({ id: "check:t1:14", kind: "check", state: "open", task: t1 }), ask({ id: "stop:t1:s", kind: "stop", state: "open", task: t1 })]) {
    const list = [...other, next];
    const pruned = pruneAnswered(m, list);
    expect(keptAnswers(pruned, list)).toEqual([]);
    // the next question answered too and gone from the list: the first card does not come back
    expect(keptAnswers(pruneAnswered(pruned, []), [])).toEqual([]);
  }
});

const subject = { kind: "approval" as const, op: "exec", target: "bun test packages/core", conditions: [], head: null };
const NOW = Date.parse("2026-10-17T12:00:00Z");

test("policy: summary — an exec approval with two conditions and a 30-day expiry gives five lines; no condition says なし", () => {
  const a = ask({ subject });
  const input = { scope: "repo" as const, target: "bun test*", when: [{ key: "area", value: "web" }, { key: "ci", value: "green" }], expiresAt: NOW + 30 * 86_400_000 };
  expect(policySummary(a, input, "bun test を許可", NOW)).toEqual(["操作: exec", "対象: bun test*", "条件: area=web ci=green", "期限: 2026-11-16（あと 30 日）", "回答: bun test を許可"]);
  expect(policySummary(a, { ...input, when: [] }, "許可", NOW)[2]).toBe("条件: なし");
});

test("policySummary warns on a target that matches every subcommand", () => {
  const a = ask({ subject });
  const input = { scope: "repo" as const, target: "bun *", when: [], expiresAt: NOW + 30 * 86_400_000 };
  const warn = (target: string, x = a) => policySummary(x, { ...input, target }, "許可", NOW).filter((l) => l.startsWith("広い指定"));
  expect(policySummary(a, input, "許可", NOW).slice(0, 3)).toEqual(["操作: exec", "対象: bun *", "広い指定: bun のどのサブコマンドにも当たります"]);
  expect(warn("cmd:git *")).toEqual(["広い指定: git のどのサブコマンドにも当たります"]);
  expect(warn("npm{,x} *")).toEqual(["広い指定: npm / npmx のどのサブコマンドにも当たります"]);
  expect(warn("bun test *")).toEqual([]);
  expect(warn("git status")).toEqual([]);
  expect(warn("src/*", ask({ subject: { ...subject, op: "write" } }))).toEqual([]);
  expect(broadTarget("exec", "bun * ?")).toEqual(["bun"]);
  expect([broadTarget("exec", "bun"), broadTarget("exec", "b* test"), broadTarget("write", "src *")]).toEqual([null, null, null]);
});

test("policySummary warns on a program prefix wildcard", () => {
  const a = ask({ subject });
  const input = { scope: "repo" as const, target: "bun*", when: [], expiresAt: NOW + 30 * 86_400_000 };
  const warn = (target: string, x = a) => policySummary(x, { ...input, target }, "許可", NOW).filter((l) => l.startsWith("広い指定"));
  const line = (name: string, stem: string) => `広い指定: ${name} は ${stem} のどのサブコマンドにも、${stem} で始まる別のプログラムにも当たります`;
  expect(warn("cmd:bun*")).toEqual([line("bun*", "bun")]);
  expect(warn("cmd:git*")).toEqual([line("git*", "git")]);
  expect(warn("cmd:npm{,x}*")).toEqual([line("npm* / npmx*", "npm / npmx")]);
  expect(warn("bun* *")).toEqual([line("bun*", "bun")]);
  // a bare `bun*` is a path pattern to core's globMatch (no command matches it); a trailing `?` is one character, not every subcommand
  for (const target of ["bun*", "npm{,x}*", "cmd:bun?", "bun test*", "bun", "b* test", "bun* test", "*"]) expect(warn(target)).toEqual([]);
  expect(warn("src*", ask({ subject: { ...subject, op: "write" } }))).toEqual([]);
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
  expect(rec).toMatchObject({ label: "B: 登録する（推奨）", sub: "影響: 毎日 PR が出る", send: B, grant: "定期実行 sch_x を登録することだけ許可します" });
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
  expect(KIND_LABEL.check).toBe("質問");
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

test("quick: isQuick (#1675) — an approval, a choice with a recommendation and a confirmation are; none without a recommendation, free text only, a grant (a stop's or a recommended choice's), a blocker, an automatic or answered one; a held one with a recommendation is", () => {
  const rec = { choices: ["A: 置き換える", "B: 残す"], recommendation: { choice: "A", why: "小さい" } };
  const yes = [
    ask({ kind: "approval", answers: ["allow", "deny"] }),
    ask({ kind: "decision", answers: ["choice", "text", "hold"], ...rec }),
    ask({ kind: "confirmation", answers: ["confirm"], question: "スマホで読める" }),
    ask({ kind: "decision", state: "held", answers: ["choice", "text"], ...rec }),
  ];
  const no = [
    ask({ kind: "decision", answers: ["choice", "text", "hold"], choices: rec.choices }),
    ask({ kind: "check", answers: ["text"] }),
    // a grant widens what the Task may do: looked at, not one of the quick ones
    ask({ kind: "stop", answers: ["grant", "text"], grant: "この操作だけ許可します" }),
    ask({ kind: "decision", answers: ["choice", "text"], choices: ["A: 押す — 許可: git push を許可します", "B: 待つ"], recommendation: { choice: "A", why: "早い" } }),
    ask({ kind: "approval", answers: ["allow", "deny"], blockers: [{ kind: "runner", detail: "ランナーが拒んだ" }] }),
    ask({ kind: "decision", answers: ["choice"], ...rec, blockers: [{ kind: "depends", detail: "#12 が未完" }] }),
    ask({ kind: "stop", needs: "auto", answers: ["grant"], grant: "g" }),
    ask({ kind: "approval", state: "answered", answers: ["allow"] }),
    ask({ kind: "approval", state: "resolved", answers: ["allow"] }),
  ];
  expect(yes.map(isQuick)).toEqual(yes.map(() => true));
  expect(no.map(isQuick)).toEqual(no.map(() => false));
});

test("askCardParts (#4068): the PBI (else the Task) as the title, the question above, known facts, the unknown ones in one list", () => {
  const empty = askCardParts(ask({}));
  expect(empty.title).toBeNull();
  expect(empty.question).toBeNull();
  expect(empty.facts.map((f) => f.label)).toEqual(["元の記録"]);
  expect(empty.unknown).toEqual(["問い", "対象リポジトリ", "PBI", "Task", "停止理由", "推奨と根拠", "回答後"]);
  const some = askCardParts(ask({ task: { id: "tk", title: "#3 実装" }, question: "どちらにするか", reason: "実装の判断" }));
  expect(some.title).toEqual({ text: "#3 実装" });
  expect(some.question).toBe("どちらにするか");
  expect(some.facts.map((f) => f.label)).toEqual(["Task", "停止理由", "元の記録"]);
  const withPbi = askCardParts(ask({ pbi: { number: 3, title: "PBI: 判断待ち", url: "https://github.com/o/r/issues/3" }, task: { id: "tk", title: "#3 実装" } }));
  expect(withPbi.title).toEqual({ text: "#3 PBI: 判断待ち", href: "https://github.com/o/r/issues/3" });
});

test("questionHead (#4068): a short question whole; a long one cut at six lines or about 300 characters, with more", () => {
  expect(questionHead("どちらにするか")).toEqual({ head: "どちらにするか", more: false });
  const many = Array.from({ length: 10 }, (_, i) => `行 ${i + 1}`).join("\n");
  expect(questionHead(many)).toEqual({ head: "行 1\n行 2\n行 3\n行 4\n行 5\n行 6 …", more: true });
  const long = "あ".repeat(500);
  const h = questionHead(long);
  expect(h.more).toBe(true);
  expect(h.head.length).toBeLessThanOrEqual(302);
  // an emoji across the cut stays whole
  const emoji = questionHead("あ".repeat(299) + "😀" + "い".repeat(10));
  expect(Array.from(emoji.head).at(-3)).toBe("😀");
});

test("unblockLinks / issueOpenHref: an Issue with no url (a workspace without GitHub sync) gets no link; one with a url keeps it", () => {
  const unblocks = [
    { number: 1, title: "local", url: "" },
    { number: 2, title: "remote", url: "https://github.com/o/r/issues/2" },
  ];
  expect(unblockLinks(unblocks)).toEqual([
    { number: 1, title: "local", href: null },
    { number: 2, title: "remote", href: "https://github.com/o/r/issues/2" },
  ]);
  expect(issueOpenHref(ask({ route: "issue", issue: { number: 1, url: "" } }))).toBeNull();
  expect(issueOpenHref(ask({ route: "issue", issue: { number: 2, url: "https://github.com/o/r/issues/2" } }))).toBe("https://github.com/o/r/issues/2");
  // a decision answered on the backlog: its Issue is the link to open
  expect(issueOpenHref(ask({ kind: "decision", route: "backlog", issue: { number: 3, url: "https://github.com/o/r/issues/3" } }))).toBe("https://github.com/o/r/issues/3");
  expect(issueOpenHref(ask({ route: "none", issue: { number: 2, url: "https://github.com/o/r/issues/2" } }))).toBeNull();
});

test("question tool card: the answer area has no 「次回も使う」 form, and the first question's text is not said again in its fieldset (the card has it once, line breaks kept)", () => {
  const q = { question: "PR #12 をマージしてよいか\n理由: 影響は小さい", options: [{ label: "マージする (Recommended)", description: "影響: 小" }, { label: "待つ", description: "" }], multiSelect: false };
  const one = ask({ kind: "check", question: q.question, answers: ["questions"], questions: [q] });
  expect(initialPolicyForm(one)).toBeNull();
  const html = renderToStaticMarkup(createElement(AnswerArea, { ask: one, busy: false, onAnswer: () => undefined }));
  expect(html).not.toContain("次回も使う");
  expect(html).not.toContain("PR #12");
  expect(html).toContain("マージする (Recommended)");
  expect(html).not.toContain("<legend");
  // a second question is named by its own legend, with its line breaks in the text
  const two = ask({ kind: "check", answers: ["questions"], questions: [q, { ...q, question: "二つ目\n補足", header: "運用" }] });
  const html2 = renderToStaticMarkup(createElement(AnswerArea, { ask: two, busy: false, onAnswer: () => undefined }));
  expect(html2).toContain("二つ目\n補足");
  expect(html2.match(/PR #12/g)).toBeNull();
});

const pbiOf = (n: number) => ({ number: n, title: `PBI ${n}`, url: `https://github.com/o/r/issues/${n}` });
const unblock = (n: number) => ({ number: n, title: `u${n}`, url: `https://github.com/o/r/issues/${n}` });

test("askRows: the questions of one PBI are one row; the same number in another Workspace, or a notice, is its own row; tool approvals are not rows", () => {
  const w1 = { id: "w1", name: "one" };
  const w2 = { id: "w2", name: "two" };
  const asks = [
    ask({ id: "c1", kind: "confirmation", workspace: w1, pbi: pbiOf(822), question: "確認 1" }),
    ask({ id: "c2", kind: "confirmation", workspace: w1, pbi: pbiOf(822), question: "確認 2" }),
    ...[1, 2, 3, 4].map((i) => ask({ id: `s${i}`, kind: "stop", workspace: w1, pbi: pbiOf(822), reason: `停止 ${i}` })),
    ask({ id: "other", kind: "decision", workspace: w2, pbi: pbiOf(822), question: "別の Workspace" }),
    ask({ id: "n1", kind: "notice", question: "お知らせ 1" }),
    ask({ id: "n2", kind: "notice", question: "お知らせ 2" }),
    ask({ id: "appr", kind: "approval", workspace: w1, pbi: pbiOf(822), answers: ["allow", "deny"] }),
  ];
  const rows = askRows(asks);
  expect(rows.map((r) => [r.key, r.asks.length])).toEqual([["w1:pbi:822", 6], ["w2:pbi:822", 1], ["ask:n1", 1], ["ask:n2", 1]]);
  expect(rows[0]!.kinds).toEqual(["confirmation", "stop"]);
  expect(rows[0]!.title).toEqual({ text: "#822 PBI 822", href: "https://github.com/o/r/issues/822" });
  expect(rows[2]!.title).toEqual({ text: "お知らせ 1" });
  // a notice whose content is unknown still names what it is
  expect(askRows([ask({ id: "n0", kind: "notice", question: null })])[0]!.title.text).toBe(KIND_LABEL.notice);
});

test("askRows: questions of a Task without a PBI are one row; the row sits where its topmost question is", () => {
  const t1 = { id: "t1", title: "Task 1" };
  const t2 = { id: "t2", title: "Task 2" };
  const rows = askRows([
    ask({ id: "a", task: t1, question: "q a" }),
    ask({ id: "b", task: t2, question: "q b" }),
    ask({ id: "c", task: t1, question: "q c" }),
  ]);
  expect(rowKey(ask({ task: t1 }))).toBe(":task:t1");
  expect(rows.map((r) => [r.key, r.asks.map((a) => a.id), r.title.text])).toEqual([[":task:t1", ["a", "c"], "Task 1"], [":task:t2", ["b"], "Task 2"]]);
  expect(rows[0]!.lead).toBe("q a");
});

test("askRows: the lead is the first question, else the first stop's reason; quick if any question is; unblocks are summed by number; open if any is open or held", () => {
  const stopOnly = askRows([ask({ id: "s1", kind: "stop", task: { id: "t", title: "T" }, reason: "許可が要る", answers: ["grant"], grant: "g" })]);
  expect(stopOnly[0]!.lead).toBe("許可が要る");
  expect(stopOnly[0]!.quick).toBe(false);
  const rows = askRows([
    ask({ id: "slow", kind: "check", pbi: pbiOf(7), answers: ["text"], question: "最初の問い", unblocks: [unblock(1), unblock(2)] }),
    ask({ id: "fast", kind: "confirmation", pbi: pbiOf(7), answers: ["confirm"], question: "二つ目", unblocks: [unblock(2), unblock(3)] }),
    ask({ id: "done", kind: "decision", pbi: pbiOf(8), state: "answered", question: "済み" }),
    ask({ id: "held", kind: "decision", pbi: pbiOf(9), state: "held", question: "保留" }),
  ]);
  expect(rows[0]!.lead).toBe("最初の問い");
  expect(rows[0]!.quick).toBe(true);
  expect(rows[0]!.unblocks.map((u) => u.number)).toEqual([1, 2, 3]);
  expect(rows.map((r) => r.open)).toEqual([true, false, true]);
});

test("answeredInRow: what was answered here stays in its row — a decision under its new id too; one answered before, or elsewhere after, does not", () => {
  const w = { id: "w", name: "alpha" };
  const yesterday = ask({ id: "decision:w#822@1", kind: "decision", workspace: w, pbi: pbiOf(822), state: "answered" });
  const asked = ask({ id: "decision:w#822@2", kind: "decision", workspace: w, pbi: pbiOf(822) });
  const confirm = ask({ id: "confirm:w#822:3", kind: "confirmation", workspace: w, pbi: pbiOf(822) });
  const list = [yesterday, asked, confirm];
  const here = [answeredHere(list, asked), answeredHere(list, confirm)];
  expect(answeredInRow(ask({ id: "decision:w#822@3", kind: "decision", workspace: w, pbi: pbiOf(822), state: "answered" }), here)).toBe(true);
  expect(answeredInRow({ ...confirm, state: "answered" }, here)).toBe(true);
  expect(answeredInRow(yesterday, here)).toBe(false);
  // the same row's other criterion, answered elsewhere after: it goes to the answered group
  expect(answeredInRow(ask({ id: "confirm:w#822:4", kind: "confirmation", workspace: w, pbi: pbiOf(822), state: "answered" }), here)).toBe(false);
  // a decision asked on a Task's Issue is named with the PBI's number once answered: it stays in its row all the same
  const onTask = ask({ id: "decision:w#321@5", kind: "decision", workspace: w, pbi: pbiOf(305) });
  const hereOnTask = [answeredHere([onTask], onTask)];
  expect(answeredInRow(ask({ id: "decision:w#305@6", kind: "decision", workspace: w, pbi: pbiOf(305), state: "answered" }), hereOnTask)).toBe(true);
  // another PBI's decision, and a tool approval, are not pulled in
  expect(answeredInRow(ask({ id: "decision:w#823@3", kind: "decision", workspace: w, pbi: pbiOf(823), state: "answered" }), here)).toBe(false);
  expect(answeredInRow(ask({ id: "decision:w#822@2", kind: "approval", workspace: w, pbi: pbiOf(822), state: "answered" }), here)).toBe(false);
});

test("quickRows: only the rows with a one-press question, the order kept", () => {
  const rows = askRows([
    ask({ id: "q1", kind: "confirmation", pbi: pbiOf(1), answers: ["confirm"] }),
    ask({ id: "s", kind: "check", pbi: pbiOf(2), answers: ["text"] }),
    ask({ id: "q2", kind: "confirmation", pbi: pbiOf(3), answers: ["confirm"] }),
  ]);
  expect(quickRows(rows).map((r) => r.key)).toEqual([":pbi:1", ":pbi:3"]);
});

test("workspaceChips: the count is rows, not questions — a PBI's questions count once, a tool approval counts each", () => {
  const w = { id: "w", name: "alpha" };
  const asks = [
    ask({ id: "a1", workspace: w, pbi: pbiOf(5) }),
    ask({ id: "a2", kind: "stop", workspace: w, pbi: pbiOf(5) }),
    ask({ id: "a3", workspace: w, pbi: pbiOf(6) }),
    ask({ id: "p1", kind: "approval", workspace: w, answers: ["allow"] }),
    ask({ id: "p2", kind: "approval", workspace: w, answers: ["allow"] }),
    ask({ id: "auto", kind: "wait", needs: "auto", workspace: w, pbi: pbiOf(9) }),
  ];
  expect(workspaceChips(asks)).toEqual([{ key: "w", name: "alpha", count: 4 }]);
});

test("replyPreview: a short reply whole; seven lines or 401 characters cut with more; counted in characters", () => {
  expect(replyPreview("終わりました")).toEqual({ head: "終わりました", more: false });
  const six = ["1", "2", "3", "4", "5", "6"].join("\n");
  expect(replyPreview(six)).toEqual({ head: six, more: false });
  expect(replyPreview(`${six}\n7`)).toEqual({ head: six, more: true });
  expect(replyPreview(`${six}\n`).more).toBe(false);
  expect(replyPreview("あ".repeat(400))).toEqual({ head: "あ".repeat(400), more: false });
  const long = replyPreview("あ".repeat(401));
  expect(long.more).toBe(true);
  expect(Array.from(long.head)).toHaveLength(400);
  expect(replyPreview("😀".repeat(401)).head).toBe("😀".repeat(400));
});

test("replyTarget: the Task's title; its id when it has none", () => {
  expect(replyTarget({ task: { id: "tk", title: "書く Task" } })).toBe("返信は Task「書く Task」に届き、その Task が続きます");
  expect(replyTarget({ task: { id: "tk_9", title: null } })).toBe("返信は Task「tk_9」に届き、その Task が続きます");
});

test("reply box: a stage Task's open stop shows its last reply, where the reply goes and 返信して続ける; a stop that takes no answer shows none of them", () => {
  const stop = ask({ kind: "stop", issue: { number: 42, url: "u" }, task: { id: "tk", title: null }, answers: ["text"], lastReply: "続けてよいですか\nA か B", next: "Task が続く" });
  const html = renderToStaticMarkup(createElement(AnswerArea, { ask: stop, busy: false, onAnswer: () => undefined }));
  expect(html).toContain("Task の最後の返答");
  expect(html).toContain("続けてよいですか");
  expect(html).toContain("返信は Task「tk」に届き、その Task が続きます");
  expect(html).toContain("返信して続ける");
  expect(html).not.toContain("次回も使う");
  // with a grant too: the route to the Issue sits under the grant's button, where the reply goes right above the box
  const both = renderToStaticMarkup(createElement(AnswerArea, { ask: { ...stop, answers: ["grant", "text"], grant: "git push だけ許可します" }, busy: false, onAnswer: () => undefined }));
  const at = (s: string) => both.indexOf(s);
  expect(at("ask-buttons")).toBeGreaterThan(-1);
  expect(at("ask-buttons") < at("ask-answer-route") && at("ask-answer-route") < at("ask-reply-target") && at("ask-reply-target") < at("<textarea")).toBe(true);
  const blocked = renderToStaticMarkup(createElement(AnswerArea, { ask: { ...stop, answers: [], blockers: [{ kind: "runner", detail: "ランナー側の拒否" }] }, busy: false, onAnswer: () => undefined }));
  expect(blocked).toContain("ランナー側の拒否");
  expect(blocked).not.toContain("返信して続ける");
  expect(blocked).not.toContain("<textarea");
});
