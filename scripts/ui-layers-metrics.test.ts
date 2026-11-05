// test-reads: apps/web/src/components/Home.tsx apps/web/src/components/Settings.tsx apps/web/src/screen.ts apps/web/src/route.ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { countUiMetrics, readUiMetrics } from "./ui-layers-metrics.ts";

const home = `
<div>
  <button>outside the card</button>
  <section className="card compose">
    <select value={a} />
    <textarea />
    <section className="inner"><input /></section>
    {cond && <button>開始</button>}
    <details className="compose-details">
      <input placeholder="title" />
      <details><select /></details>
      <button>既定</button>
    </details>
    <inputGroup />
  </section>
  <section className="card"><input /></section>
</div>`;

const settings = `<section className="card a"></section><section className="card"></section><section className="other"></section>`;
const screen = `export type View = { name: "home" } | { name: "task"; id: string } | { name: "settings" } | { name: "home" };\nconst x = { name: "notaview" };`;
const route = `const PATHS = {\n  home: "/",\n} as const;\nconst f = (v) => v.name === "task";`;

describe("countUiMetrics", () => {
  test("counts the compose card's inputs outside <details>, the Settings cards, the screens and the routed screens", () => {
    expect(countUiMetrics({ home, settings, screen, route })).toEqual({ homeComposeVisible: 4, settingsSections: 2, screens: 3, urlScreens: 2 });
  });

  test("a View union written over several lines is read to its end", () => {
    const multi = `export type View =\n  | { name: "home" }\n  | {\n      name: "task";\n      id: string;\n    }\n  | { name: "settings" };\nexport type Other = { name: "x" };`;
    expect(countUiMetrics({ home, settings, screen: multi, route: null }).screens).toBe(3);
  });

  test("no route.ts: urlScreens is 0", () => {
    expect(countUiMetrics({ home, settings, screen, route: null }).urlScreens).toBe(0);
  });
});

describe("readUiMetrics", () => {
  test("the repository's sources give the same integers on every read", () => {
    const root = join(import.meta.dir, "..");
    const a = readUiMetrics(root);
    expect(readUiMetrics(root)).toEqual(a);
    for (const v of Object.values(a)) expect(Number.isInteger(v)).toBe(true);
    expect(a.homeComposeVisible).toBeGreaterThanOrEqual(1);
    expect(a.settingsSections).toBeGreaterThanOrEqual(1);
  });
});
