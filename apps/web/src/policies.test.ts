import { expect, test } from "bun:test";
import type { AnswerPolicy } from "@switchboard/protocol";
import { policyRow, policyState, useLines } from "./policies.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const subject = { kind: "approval" as const, op: "exec", target: "bun test packages/core", conditions: [], head: null };
const policy = (over: Partial<AnswerPolicy> = {}): AnswerPolicy => ({
  id: "pol_1", scope: "repo", workspaceId: "w", pbi: null, askId: null, kind: "approval", op: "exec", target: "bun test*", when: [], answer: { kind: "allow" }, expiresAt: NOW + 30 * 86_400_000,
  revokedAt: null, createdAt: NOW, updatedAt: NOW, from: subject, uses: [], ...over,
});

test("policyState: valid, expired at the expiry itself, revoked, and a 今回のみ one that answered is used", () => {
  expect(policyState(policy(), NOW).text).toBe("有効");
  expect(policyState(policy({ expiresAt: NOW }), NOW).text).toBe("期限切れ");
  expect(policyState(policy({ expiresAt: NOW + 1 }), NOW).text).toBe("有効");
  expect(policyState(policy({ revokedAt: NOW - 1 }), NOW).text).toBe("無効");
  const use = { at: NOW, askId: "a", taskId: "t", issue: null, subject };
  expect(policyState(policy({ scope: "once", expiresAt: null, askId: "a", uses: [use] }), NOW).text).toBe("使用済み");
  expect(policyState(policy({ scope: "once", expiresAt: null, askId: "a" }), NOW).text).toBe("有効");
});

test("policyRow: the three ranges, with and without conditions, and the expiry", () => {
  const name = () => "switchboard";
  expect(policyRow(policy(), name, NOW)).toEqual({ scope: "このリポジトリ（switchboard）", subject: "exec: bun test*", when: "条件なし", expires: "2026-11-16（あと 30 日）", uses: "未使用" });
  expect(policyRow(policy({ scope: "pbi", pbi: 938, when: [{ key: "area", value: "web" }] }), name, NOW)).toMatchObject({ scope: "この PBI 内（#938）", when: "area=web" });
  expect(policyRow(policy({ scope: "once", expiresAt: null }), name, NOW)).toMatchObject({ scope: "今回のみ", expires: "期限なし（1 回きり）" });
  expect(policyRow(policy({ uses: [{ at: NOW, askId: "a", taskId: "t", issue: null, subject }, { at: NOW - 1000, askId: "b", taskId: "t", issue: null, subject }] }), name, NOW).uses).toStartWith("2 回・最後 ");
});

test("useLines: newest first, a Task by its title or id and an Issue by its number", () => {
  const p = policy({ uses: [{ at: NOW - 5000, askId: "a", taskId: "tk_1", issue: null, subject }, { at: NOW, askId: "b", taskId: null, issue: 306, subject: { ...subject, kind: "decision", op: "decide", target: "storage" } }] });
  const lines = useLines(p, (id) => (id === "tk_1" ? "approve me" : undefined));
  expect(lines).toHaveLength(2);
  expect(lines[0]).toEndWith("Issue #306 decide storage");
  expect(lines[1]).toEndWith("Task approve me exec bun test packages/core");
});
