/**
 * bun scripts/ui-layers-metrics.ts [--root <dir>] — the floor / ceiling / walls measures (docs/design/ui-layers.md), counted
 * from the web sources the same way every time: a static read of four files (no rendering, no DB, no Git history), so one
 * commit always gives the same numbers. Prints one JSON line with the keys in a fixed order.
 *
 * - homeComposeVisible: the `<select` / `<input` / `<textarea` / `<button` opening tags written in Home's compose card
 *   (`<section className="card compose">` to its `</section>`) outside any `<details>`. A tag drawn only on a condition
 *   counts once, as written: this counts what the form can show without opening anything, not what one render shows.
 * - settingsSections: the `<section className="card` opening tags in Settings.
 * - screens: the kinds of `name:` in screen.ts' `View` union.
 * - urlScreens: the screens (View names) route.ts names, as a key (`home:`) or a string (`"task"`); 0 without route.ts.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface UiMetrics {
  homeComposeVisible: number;
  settingsSections: number;
  screens: number;
  urlScreens: number;
}

/** The text of the element opened at `start` (a `<tag` index) up to its matching close, nested ones counted. */
function element(src: string, start: number, tag: string): string {
  const re = new RegExp(`<${tag}\\b|</${tag}>`, "g");
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return src.slice(start, m.index + m[0].length);
  }
  return src.slice(start);
}

/** `src` without every `<details>…</details>` (nested ones included). */
function withoutDetails(src: string): string {
  let out = src;
  for (let i = out.search(/<details\b/); i >= 0; i = out.search(/<details\b/)) {
    const d = element(out, i, "details");
    out = out.slice(0, i) + out.slice(i + d.length);
  }
  return out;
}

const count = (src: string, re: RegExp): number => src.match(re)?.length ?? 0;

/** The View names of screen.ts' `View` union, in the order written: the union runs to the first `;` outside its braces. */
function viewNames(screen: string): string[] {
  const at = screen.search(/export type View\s*=/);
  let union = "";
  if (at >= 0) {
    let depth = 0;
    for (let i = screen.indexOf("=", at) + 1; i < screen.length; i++) {
      const c = screen[i]!;
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ";" && depth === 0) break;
      union += c;
    }
  }
  return [...new Set([...union.matchAll(/name:\s*"([^"]+)"/g)].map((m) => m[1]!))];
}

export function countUiMetrics(files: { home: string; settings: string; screen: string; route: string | null }): UiMetrics {
  const at = files.home.indexOf('<section className="card compose">');
  const compose = at < 0 ? "" : withoutDetails(element(files.home, at, "section"));
  const names = viewNames(files.screen);
  const route = files.route;
  const named = (n: string) => route !== null && (new RegExp(`(^|[\\s{,])${n}\\s*:`, "m").test(route) || route.includes(`"${n}"`));
  return {
    homeComposeVisible: count(compose, /<(select|input|textarea|button)\b/g),
    settingsSections: count(files.settings, /<section className="card\b/g),
    screens: names.length,
    urlScreens: names.filter(named).length,
  };
}

export function readUiMetrics(root: string): UiMetrics {
  const web = join(root, "apps/web/src");
  const route = join(web, "route.ts");
  return countUiMetrics({
    home: readFileSync(join(web, "components/Home.tsx"), "utf8"),
    settings: readFileSync(join(web, "components/Settings.tsx"), "utf8"),
    screen: readFileSync(join(web, "screen.ts"), "utf8"),
    route: existsSync(route) ? readFileSync(route, "utf8") : null,
  });
}

if (import.meta.main) {
  const i = process.argv.indexOf("--root");
  const root = i < 0 ? join(import.meta.dir, "..") : process.argv[i + 1];
  if (!root) {
    console.error("usage: bun scripts/ui-layers-metrics.ts [--root <dir>]");
    process.exit(2);
  }
  const m = readUiMetrics(root);
  // a fixed key order: the line is compared as text between runs
  console.log(JSON.stringify({ homeComposeVisible: m.homeComposeVisible, settingsSections: m.settingsSections, screens: m.screens, urlScreens: m.urlScreens }));
}
