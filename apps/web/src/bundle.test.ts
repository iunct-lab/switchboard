// test-reads: apps/web/src/i18n.ts apps/web/src/i18n/bundle.ts apps/web/src/i18n/backlog.ts apps/web/src/time.ts
import { describe, expect, test } from "bun:test";
import type { BacklogItem, BundleHold } from "@switchboard/protocol";
import { bundleClosedReason, bundleGate, bundleReasonLine, holdLine, latestRead, unreadableHold, UNREAD } from "./bundle.ts";
import { backlog } from "./i18n/backlog.ts";
import { bundle as bm } from "./i18n/bundle.ts";
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

  test("bundleGate: 止めを読めなかったときは押せず、読み直す理由を出す", () => {
    const g = bundleGate([pbi(1), pbi(2)], META, UNREAD);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain("束の作業中かどうかを読めなかった");
  });

  test("bundleGate: リポジトリの一覧を読めなかったときは押せず、読み直す理由を出す（止めが読めていても先に言う）", () => {
    const g = bundleGate([pbi(1), pbi(2)], UNREAD, UNREAD);
    expect(g.ok).toBe(false);
    if (!g.ok) expect(g.reason).toContain("リポジトリの一覧を読めなかった");
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

  test("bundleClosedReason: 止めがあるときと無いとき（null・undefined）で別の文を返し、止めを読めなかったときは閉じた理由を言わない", () => {
    const held = bundleClosedReason(hold());
    expect(held).toBe("束の作業中になったため確認を閉じました");
    for (const h of [null, undefined] as const) expect(bundleClosedReason(h)).toBe("選んだ行が変わったため確認を閉じました");
    expect(bundleClosedReason(UNREAD)).toBeNull();
    expect(bundleReasonLine(bundleClosedReason(UNREAD), bundleGate([pbi(1), pbi(2)], META, UNREAD))).not.toContain("選んだ行が変わった");
    expect(held).not.toBe(bundleClosedReason(null));
  });

  test("bundleReasonLine: 閉じた理由なし・押せる・止めで閉じた・1 件に減った", () => {
    const ok = bundleGate([pbi(1), pbi(2)], META, null);
    const held = bundleGate([pbi(1), pbi(2)], META, hold());
    const one = bundleGate([pbi(1)], META, null);
    expect(bundleReasonLine(null, ok)).toBe("");
    expect(bundleReasonLine(null, one)).toContain("1 件だけ");
    const changed = bundleClosedReason(null);
    expect(bundleReasonLine(changed, ok)).toBe("選んだ行が変わったため確認を閉じました。選び直した行で開き直してください");
    expect(bundleReasonLine(bundleClosedReason(hold()), held)).toBe("束の作業中になったため確認を閉じました");
    expect(bundleReasonLine(changed, one)).toContain("選んだ行が変わったため確認を閉じました。");
    expect(bundleReasonLine(changed, one)).toContain("1 件だけ");
    // 行が変わって閉じた後に止めが読めた: ボタンは押せないので、止めの理由も言う
    expect(bundleReasonLine(changed, held)).toBe("選んだ行が変わったため確認を閉じました。束の作業中は始められません");
  });

  test("閉じた理由とほかの文のつなぎは辞書の文で、英語に日本語の句点が入らない", () => {
    expect(bm.closedThen.en).not.toContain("。");
    expect(bm.closedThen.en.replace("{closed}", "A").replace("{next}", "B")).toBe("A. B");
  });
});

describe("reading the hold again", () => {
  test("latestRead: 古い読み取りが新しい答えの後で失敗しても、新しい答えが残る", async () => {
    const calls: Array<{ resolve: (v: BundleHold | null) => void; reject: (e: Error) => void }> = [];
    let value: BundleHold | null | typeof UNREAD | undefined;
    const read = latestRead(
      () => new Promise<BundleHold | null>((resolve, reject) => calls.push({ resolve, reject })),
      (v) => (value = v),
    );
    const older = read();
    const newer = read();
    calls[1]!.resolve(hold());
    await newer;
    calls[0]!.reject(new Error("network"));
    await older;
    expect(value).toEqual(hold());
  });

  test("latestRead: 最後の読み取りが失敗したら UNREAD", async () => {
    let value: BundleHold | null | typeof UNREAD | undefined = hold();
    await latestRead(() => Promise.reject(new Error("network")), (v) => (value = v))();
    expect(value).toBe(UNREAD);
  });

  test("読めなかった理由の英語は日本語を含まず、英語の画面のボタンの名前（Reload）を言う", () => {
    for (const msg of [bm.gateHoldUnread, bm.gateWorkspacesUnread]) {
      expect(msg.en).not.toMatch(/[぀-ヿ㐀-鿿]/);
      expect(msg.en).toContain(backlog.reload.en);
    }
  });
});
