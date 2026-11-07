import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extraRows, frameCount, judge, parseArgs, screens, staleBuild, type Box } from "./screens-audit.ts";

const box = (over: Partial<Box>): Box => ({ left: 0, right: 100, width: 100, contentWidth: 100, height: 20, textLines: 1, fontSize: 13, text: "", inHeaderTabs: false, hidden: false, inSideScroller: false, ...over });

describe("screens-audit (#4030)", () => {
  test("judge counts what reaches past the right edge, but not the header's tabs", () => {
    expect(judge([box({ right: 392 }), box({ right: 500, inHeaderTabs: true }), box({ right: 390 }), box({ right: 450, width: 0 })], 390)).toEqual({ overflow: 1, squeezed: 0 });
  });

  test("judge leaves out what is not drawn and what sits in a box that scrolls sideways", () => {
    expect(judge([box({ right: 500, hidden: true }), box({ right: 500, inSideScroller: true }), box({ right: 500 }), box({ contentWidth: 14, textLines: 5, text: "空きメモリ", hidden: true })], 390)).toEqual({ overflow: 1, squeezed: 0 });
  });

  test("extraRows counts the rows a bar takes beyond what its items need, in their order", () => {
    const tab = (top: number, width = 50) => ({ top, bottom: top + 28, width });
    // the phone header of 2026-11-07: 9 tabs on two rows, 救援画面 alone on a third, where it fits on the second
    expect(extraRows({ width: 344, gap: 6, items: [...[0, 0, 0, 0, 0, 0].map((t) => tab(t)), ...[30, 30, 30].map((t) => tab(t)), { top: 64, bottom: 78, width: 40 }] })).toBe(1);
    // the same items on two rows, 救援画面 centred beside the tabs (a shorter item overlapping a row joins it)
    expect(extraRows({ width: 344, gap: 6, items: [...[0, 0, 0, 0, 0, 0].map((t) => tab(t)), ...[30, 30, 30].map((t) => tab(t)), { top: 22, bottom: 36, width: 40 }] })).toBe(0);
    // squeezed onto four rows where two hold them (five of 60 with their gaps fit 344)
    expect(extraRows({ width: 344, gap: 6, items: [0, 0, 0, 30, 30, 60, 60, 90, 90].map((t) => tab(t, 60)) })).toBe(2);
    // the first try at it: the tabs in a box beside 新しい版 and 救援画面, squeezed onto four rows; the two links, centred,
    // straddle the second and third rows and do not make them one; three rows hold them all
    expect(extraRows({ width: 344, gap: 6, items: [...[0, 0, 0, 30, 30, 60, 60, 90, 90].map((t) => tab(t, 60)), { top: 52, bottom: 66, width: 110 }, { top: 52, bottom: 66, width: 40 }] })).toBe(1);
    // one row, and an item wider than the bar on a row of its own
    expect(extraRows({ width: 344, gap: 6, items: [tab(0), tab(0)] })).toBe(0);
    expect(extraRows({ width: 100, gap: 6, items: [tab(0, 150), tab(30)] })).toBe(0);
  });

  test("staleBuild names what the build reads changed after it, not the tests", () => {
    const root = mkdtempSync(join(tmpdir(), "screens-audit."));
    try {
      for (const d of ["apps/web/dist", "apps/web/src/components", "packages/protocol/src"]) mkdirSync(join(root, d), { recursive: true });
      const at = (f: string, t: number) => { writeFileSync(join(root, f), ""); utimesSync(join(root, f), t, t); };
      at("apps/web/dist/index.html", 2000);
      at("apps/web/src/a.ts", 1000);
      at("apps/web/src/components/B.tsx", 3000);
      at("apps/web/src/c.test.ts", 3000);
      at("apps/web/index.html", 3000);
      at("packages/protocol/src/model.ts", 3000);
      expect(staleBuild(root).sort()).toEqual(["apps/web/index.html", "apps/web/src/components/B.tsx", "packages/protocol/src/model.ts"].map((f) => join(root, f)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("judge counts text squeezed into a column of one character, on four lines or more", () => {
    expect(judge([box({ contentWidth: 14, textLines: 5, text: "空きメモリ" }), box({ contentWidth: 14, textLines: 2, text: "空き" }), box({ contentWidth: 14, textLines: 0, text: "" }), box({ contentWidth: 40, textLines: 10, text: "長い文" }), box({ width: 34, contentWidth: 14, textLines: 4, text: "待ち時間" })], 390)).toEqual({ overflow: 0, squeezed: 2 });
    // a short number in a cell made tall by the others of its row: one line, not a column
    expect(judge([box({ contentWidth: 20, height: 120, textLines: 1, text: "3.4" })], 390)).toEqual({ overflow: 0, squeezed: 0 });
  });

  test("parseArgs: the defaults, each flag, and an unknown flag or width refused", () => {
    expect(parseArgs([])).toEqual({ home: null, out: null, screens: null, widths: ["phone", "pc"], maxFrames: 8 });
    expect(parseArgs(["--home", "/h", "--out", "/o", "--screens", "home,schedules", "--widths", "phone", "--max-frames", "20"])).toEqual({ home: "/h", out: "/o", screens: ["home", "schedules"], widths: ["phone"], maxFrames: 20 });
    expect(() => parseArgs(["--max-frames", "0"])).toThrow("whole number");
    expect(() => parseArgs(["--widths", "tablet"])).toThrow("unknown width");
    expect(() => parseArgs(["--size", "1"])).toThrow("unknown flag");
    expect(() => parseArgs(["--out"])).toThrow("needs a value");
  });

  test("screens: every header tab and the Backlog's three layouts; the Task only when there is one", () => {
    expect(screens("task_1").map((s) => s.name)).toEqual(["home", "task", "knowledge", "ledger", "insights", "backlog-list", "backlog-board", "backlog-queue", "resources", "schedules", "approvals", "settings"]);
    expect(screens(null).map((s) => s.name)).not.toContain("task");
    expect(screens(null).find((s) => s.name === "backlog-queue")).toEqual({ name: "backlog-queue", path: "/backlog", layout: "queue" });
  });

  test("frameCount pages through with 60 px shown twice, at least one, at most the cap", () => {
    expect(frameCount(844, 844)).toBe(2);
    expect(frameCount(300, 844)).toBe(1);
    expect(frameCount(100000, 844)).toBe(8);
    expect(frameCount(2000, 844, 3)).toBe(3);
  });
});
