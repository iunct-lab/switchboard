// test-reads: apps/web/src/i18n.ts apps/web/src/i18n/bundle.ts apps/web/src/time.ts
import { describe, expect, test } from "bun:test";
import type { BacklogItem, BundleHold } from "@switchboard/protocol";
import { bundleGate, holdLine, unreadableHold } from "./bundle.ts";
import { jstClock } from "./time.ts";

const hold = (over: Partial<BundleHold> = {}): BundleHold => ({ taskId: "task_x", since: Date.UTC(2026, 10, 18, 11, 40), schedules: ["a", "b", "c"], base: "v1.529.4", ...over });

const META = "ws_meta";
const pbi = (number: number, workspaceId = META, workspaceName = "Switchboard"): BacklogItem => ({ workspaceId, workspaceName, number, title: `t${number}`, type: "pbi", stage: "ready" }) as BacklogItem;

describe("bundle gate and line", () => {
  test("bundleGate: Switchboard の PBI が 2 件で止めが無ければ押せて、選んだ順の番号を返す", () => {
    expect(bundleGate([pbi(9), pbi(4)], META, null)).toEqual({ ok: true, pbis: [9, 4] });
  });

  test("bundleGate: ほかのリポジトリの PBI が入っていると押せず、その workspace の名前と番号を理由に出す", () => {
    const g = bundleGate([pbi(1), pbi(2, "ws_other", "Other")], META, null);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.reason).toContain("Other");
      expect(g.reason).toContain("#2");
    }
  });

  test("bundleGate: 1 件だけでは押せない", () => {
    const g = bundleGate([pbi(1)], META, null);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain("1 件だけ");
    expect(bundleGate([], META, null).ok).toBe(false);
  });

  test("bundleGate: 束の作業中は押せない", () => {
    const g = bundleGate([pbi(1), pbi(2)], META, hold());
    expect(g).toEqual({ ok: false, reason: "束の作業中は始められません" });
  });

  test("bundleGate: ほかのリポジトリの PBI は、Switchboard に同じ番号の PBI があっても押せない", () => {
    expect(bundleGate([pbi(1), pbi(2, "ws_other", "Other")], META, null).ok).toBe(false);
    expect(bundleGate([pbi(1, "ws_other", "Other"), pbi(2, "ws_other", "Other")], META, null).ok).toBe(false);
    expect(bundleGate([pbi(1), pbi(1, "ws_other", "Other")], META, null).ok).toBe(false);
  });

  test("bundleGate: workspace の一覧を読めていない間は押せず、理由も出さない", () => {
    expect(bundleGate([pbi(1), pbi(2)], null, null)).toEqual({ ok: false, reason: "" });
  });

  test("bundleGate: 止めをまだ読めていない間は押せず、理由も出さない", () => {
    expect(bundleGate([pbi(1), pbi(2)], META, undefined)).toEqual({ ok: false, reason: "" });
  });

  test("holdLine names the schedules, the time and the version", () => {
    const h = hold();
    const line = holdLine(h, h.since);
    expect(line).toBe(`束の作業中: 定期実行 3 件と昇格を止めています（${jstClock(h.since, h.since)} から、戻す先 v1.529.4）`);
    expect(holdLine(hold({ schedules: [], base: null }), h.since)).toContain("定期実行 0 件");
    expect(holdLine(hold({ base: null }), h.since)).toContain("戻す先 なし");
  });

  test("an unreadable hold shows no 1970 time and no Task", () => {
    const h = hold({ taskId: "不明", since: 0, schedules: [], base: null });
    expect(unreadableHold(h)).toBe(true);
    expect(unreadableHold(hold())).toBe(false);
    expect(holdLine(h, Date.UTC(2026, 10, 21))).toBe("束の作業中: 止めの記録が読めないため、定期実行と昇格を止めたものとして扱っています");
  });
});
