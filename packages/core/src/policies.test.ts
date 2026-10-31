import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnswerPolicy, PolicyInput, PolicySubject } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { checkPolicy, matchPolicies, readPolicies, recordUse, subjectChanges, writePolicies, type PolicyContext } from "./policies.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const exec: PolicySubject = { kind: "approval", op: "exec", target: "bun test packages", conditions: [], head: null };
const decision: PolicySubject = { kind: "decision", op: "merge", target: "pr:10", conditions: [{ key: "area", value: "web" }], head: "aaaaaaa1" };

const ctx = (over: Partial<PolicyContext> = {}): PolicyContext => ({
  subject: exec,
  workspaceId: "w1",
  pbi: 938,
  askId: "a1",
  answer: { kind: "allow" },
  confirmHit: null,
  runnerRefusal: false,
  now: NOW,
  ...over,
});
const input = (over: Partial<PolicyInput> = {}): PolicyInput => ({ scope: "repo", target: "bun test*", when: [], expiresAt: NOW + 30 * DAY, ...over });
const refused = (i: PolicyInput, c: PolicyContext) => {
  const r = checkPolicy(i, c);
  expect(r.ok).toBe(false);
  return r.ok ? "" : r.error;
};
const make = (over: Partial<AnswerPolicy> = {}): AnswerPolicy => {
  const r = checkPolicy(input(), ctx());
  if (!r.ok) throw new Error(r.error);
  return { ...r.policy, id: "p1", uses: [], ...over };
};
const ask = (over: Partial<Parameters<typeof matchPolicies>[1]> = {}) => ({ id: "a2", subject: exec, workspaceId: "w1", pbi: 938, pbiOpen: true, choices: [], ...over });

describe("answer policies", () => {
  test("store", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.policies."));
    try {
      const db = new Db(join(dir, "x.db"));
      expect(readPolicies(db)).toEqual([]);
      const list = [make({ id: "a", scope: "once", askId: "a1", expiresAt: null }), make({ id: "b", scope: "pbi", pbi: 938 }), make({ id: "c" })];
      writePolicies(db, list);
      expect(readPolicies(db)).toEqual(list);
      db.setSetting("answerPolicies", { broken: true });
      expect(readPolicies(db)).toEqual([]);
      db.setSetting("answerPolicies", [null, "x", { id: 3 }, { id: "broken" }, list[0]]);
      expect(readPolicies(db)).toEqual([list[0]!]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("check", () => {
    for (const target of ["*", "**", "**/*", "cmd:*", "cmd:{*,x}", "{a,{*,b}}"]) refused(input({ target }), ctx());
    // a broad target is warned about on screen, not refused (#1765)
    expect(checkPolicy(input({ target: "bun *" }), ctx()).ok).toBe(true);
    refused(input({ target: "git push*" }), ctx());
    refused(input({ expiresAt: null }), ctx());
    refused(input({ expiresAt: NOW + 91 * DAY }), ctx());
    refused(input({ expiresAt: NOW - 1 }), ctx());
    refused(input(), ctx({ answer: { kind: "text", text: "key AKIA" + "ABCDEFGHIJKLMNOP" } }));
    refused(input({ when: [{ key: "k", value: "AKIA" + "ABCDEFGHIJKLMNOP" }] }), ctx());
    expect(refused(input(), ctx({ confirmHit: { source: "rules/a.md", pattern: "bun*", mode: "confirm", subject: "bun test" } }))).toContain("rules/a.md");
    expect(refused(input(), ctx({ runnerRefusal: true }))).toContain("ランナー");
    refused(input({ target: "pr:10" }), ctx({ subject: { ...decision, conditions: [{ key: "merge-ask", value: "security,large" }] }, answer: { kind: "choice", choice: "yes" } }));
    refused(input({ target: "bun test*" }), ctx({ subject: { ...exec, target: "bun test --token ghp_" + "a".repeat(36) } }));
    refused(input({ scope: "pbi" }), ctx({ subject: null }));
    refused(input({ scope: "pbi" }), ctx({ pbi: null }));
    refused(input(), ctx({ answer: { kind: "deny" } }));
    refused(input({ target: "x" }), ctx({ subject: { ...exec, op: "network" } }));
    refused(input({ target: "pr:10" }), ctx({ subject: decision, answer: { kind: "allow" } }));
    const ok = checkPolicy(input(), ctx());
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.policy).toMatchObject({ scope: "repo", workspaceId: "w1", pbi: null, askId: null, expiresAt: NOW + 30 * DAY, from: exec });
    const once = checkPolicy(input({ scope: "once", expiresAt: NOW + DAY }), ctx());
    expect(once.ok && once.policy).toMatchObject({ scope: "once", askId: "a1", expiresAt: null });
  });

  test("match boundaries", () => {
    const p = make({ expiresAt: NOW + 1000 });
    expect(matchPolicies([p], ask(), NOW + 999).hit?.id).toBe("p1");
    expect(matchPolicies([p], ask(), NOW + 1000)).toMatchObject({ hit: null, misses: [{ why: "期限切れ" }] });
    const miss = (policy: AnswerPolicy, a = ask()) => matchPolicies([policy], a, NOW).misses[0]?.why;
    expect(miss(make({ revokedAt: NOW - 1 }))).toBe("失効済み");
    expect(miss(make(), ask({ workspaceId: "w2" }))).toBe("別のリポジトリ");
    expect(miss(make({ scope: "pbi", pbi: 938 }), ask({ pbi: 1 }))).toBe("別の PBI");
    expect(miss(make({ scope: "pbi", pbi: 938 }), ask({ pbiOpen: false }))).toBe("PBI が閉じている");
    expect(miss(make({ scope: "once", askId: "a1", expiresAt: null }))).toBe("別の問い");
    expect(miss(make({ target: "git*" }))).toBe("対象が違う");
    const d = (when: Array<{ key: string; value: string }>) => make({ kind: "decision", op: "merge", target: "pr:*", when, answer: { kind: "choice", choice: "yes" }, from: decision });
    const dask = ask({ subject: decision, choices: ["yes", "no"] });
    expect(miss(d([{ key: "area", value: "web" }]), dask)).toBeUndefined();
    expect(miss(d([{ key: "area", value: "core" }]), dask)).toContain("area");
    expect(miss(d([{ key: "other", value: "x" }]), dask)).toContain("other");
    expect(miss(d([]), ask({ subject: decision, choices: ["A: no", "B: maybe"] }))).toBe("回答が今回の選択肢に無い");
    expect(miss(d([]), ask({ subject: decision, choices: ["A: yes"] }))).toBeUndefined();
    expect(miss(d([]), ask({ subject: { ...decision, head: "bbbbbbb2" }, choices: ["A: yes"] }))).toBe("PR の差分が変わった");
    const both = matchPolicies([make({ id: "repo" }), make({ id: "once", scope: "once", askId: "a2", expiresAt: null })], ask(), NOW);
    expect(both.hit?.id).toBe("once");
    const newer = matchPolicies([make({ id: "old", updatedAt: 1 }), make({ id: "new", updatedAt: 2 })], ask(), NOW);
    expect(newer.hit?.id).toBe("new");
  });

  test("a decision's target with a space matches as one string", () => {
    const spaced: PolicySubject = { ...decision, target: "PR #12" };
    const r = checkPolicy(input({ target: "PR #*" }), ctx({ subject: spaced, answer: { kind: "choice", choice: "yes" } }));
    expect(r.ok).toBe(true);
    expect(matchPolicies([make({ kind: "decision", op: "merge", target: "PR #*", from: spaced })], ask({ subject: { ...spaced, kind: "decision", op: "merge", target: "PR #13" }, choices: [] }), NOW).hit?.id).toBe("p1");
  });

  test("changes", () => {
    expect(subjectChanges(decision, { ...decision })).toEqual([]);
    const cur = { ...decision, target: "pr:11", conditions: [{ key: "area", value: "core" }], head: "bbbbbbb2" };
    expect(subjectChanges(decision, cur)).toEqual(["対象: pr:10 → pr:11", "条件 area: web → core", "PR の差分が変わりました（aaaaaaa → bbbbbbb）"]);
    expect(subjectChanges(decision, { ...decision, conditions: [] })).toEqual(["条件 area: web → なし"]);
  });

  test("uses keep the newest 20", () => {
    let list = [make()];
    for (let i = 0; i < 25; i++) list = recordUse(list, "p1", { at: i, askId: `a${i}`, taskId: null, issue: null, subject: exec });
    expect(list[0]!.uses).toHaveLength(20);
    expect(list[0]!.uses[0]!.at).toBe(24);
  });
});
