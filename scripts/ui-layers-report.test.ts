// test-reads: scripts/ui-layers-report.ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastHistory, renderReport } from "./ui-layers-report.ts";

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "ui-layers-report-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const metrics = (homeComposeVisible: number) => ({ homeComposeVisible, settingsSections: 22, screens: 10, urlScreens: 10 });
const ratings = { floor: "床の評価", ceiling: "天井の評価", walls: "壁の評価" };

/** Runs the CLI as the Task does, with the history under `dir`. */
function run(m: ReturnType<typeof metrics>, out: string): { code: number; html: string } {
  const f = (name: string, v: unknown) => (writeFileSync(join(dir, name), JSON.stringify(v)), join(dir, name));
  const p = Bun.spawnSync(["bun", join(import.meta.dir, "ui-layers-report.ts"),
    "--metrics", f("m.json", m), "--placement", f("p.json", { checked: 2, missing: [{ number: 7, title: "PBI: 行なし" }] }),
    "--ratings", f("r.json", ratings), "--out", join(dir, out), "--history", join(dir, "h", "history.jsonl")]);
  return { code: p.exitCode, html: existsSync(join(dir, out)) ? readFileSync(join(dir, out), "utf8") : "" };
}

test("the second run shows the first run's values and the difference", () => {
  const first = run(metrics(9), "1.html");
  expect(first.code).toBe(0);
  expect(first.html).toContain("<td>Home の作成フォームで常に見える操作の数</td><td>9</td><td>初回</td><td>初回</td>");
  const second = run(metrics(11), "2.html");
  expect(second.html).toContain("<td>Home の作成フォームで常に見える操作の数</td><td>11</td><td>9</td><td>+2</td>");
  expect(second.html).toContain("<td>Settings の節の数</td><td>22</td><td>22</td><td>0</td>");
  expect(second.html).toContain("#7 PBI: 行なし");
  expect(readFileSync(join(dir, "h", "history.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  expect(JSON.parse(readFileSync(join(dir, "2.json"), "utf8")).previous.metrics.homeComposeVisible).toBe(9);
});

test("the first run says 初回 and an empty list says なし", () => {
  const html = renderReport({ date: "2026-11-01", metrics: metrics(9), previous: null, ratings, missing: [], checked: 0 });
  expect(html).toContain("前回: なし（初回）");
  expect(html).toContain("<p>なし</p>");
});

test("a measure the last run did not have says 初回 on its row", () => {
  const { urlScreens: _, ...older } = metrics(8);
  const html = renderReport({ date: "2026-12-01", metrics: metrics(9), previous: { date: "2026-11-01", metrics: older as ReturnType<typeof metrics> }, ratings, missing: [], checked: 0 });
  expect(html).toContain("<td>URL で直接開ける画面の数</td><td>10</td><td>初回</td><td>初回</td>");
  expect(html).toContain("<td>Home の作成フォームで常に見える操作の数</td><td>9</td><td>8</td><td>+1</td>");
});

test("the ratings and titles are escaped", () => {
  const html = renderReport({ date: "2026-11-01", metrics: metrics(9), previous: null, ratings: { ...ratings, floor: "<script>alert(1)</script>" }, missing: [{ number: 1, title: "<img src=x>" }], checked: 1 });
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("a broken last history line is skipped for the one before it", () => {
  const h = join(dir, "history.jsonl");
  appendFileSync(h, `${JSON.stringify({ date: "2026-10-01", metrics: metrics(8) })}\n{"date":"2026-11`);
  expect(lastHistory(h)?.date).toBe("2026-10-01");
  expect(lastHistory(join(dir, "none.jsonl"))).toBeNull();
});
