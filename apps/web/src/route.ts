import type { View } from "./screen.ts";

/**
 * Each screen's URL (#3355): a Task and every header tab open from their own path, so a reload, a second tab and the
 * browser's back / forward keep the place. `/approvals` is the PWA's start_url (#26). Only the screen is in the URL —
 * an open artifact and Insights' report / artifacts are not. The daemon answers an unknown path with index.html.
 */
const PATHS = {
  home: "/",
  knowledge: "/knowledge",
  ledger: "/ledger",
  evals: "/insights",
  schedules: "/schedules",
  backlog: "/backlog",
  resources: "/resources",
  approvals: "/approvals",
  settings: "/settings",
} as const satisfies Record<Exclude<View["name"], "task">, string>;

const TASK = "/task/";

export function viewPath(v: View): string {
  return v.name === "task" ? `${TASK}${encodeURIComponent(v.id)}` : PATHS[v.name];
}

/** The screen a path opens, or null for a path that is not one (the caller falls back to Home). */
export function viewFromPath(pathname: string): View | null {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path.startsWith(TASK)) {
    const raw = path.slice(TASK.length);
    if (!raw || raw.includes("/")) return null;
    try {
      return { name: "task", id: decodeURIComponent(raw) };
    } catch {
      return null; // a malformed %-escape
    }
  }
  const name = (Object.keys(PATHS) as (keyof typeof PATHS)[]).find((k) => PATHS[k] === path);
  return name ? ({ name } as View) : null;
}

/**
 * The path the address bar should get for the screen now shown, or null when it already shows that screen (#3427): the
 * Task's artifact, a trailing slash and Insights' scope are the same screen, and a screen popstate brought back is not
 * pushed again. A path that is no screen gets the shown screen's path.
 */
export function pathToWrite(v: View, pathname: string): string | null {
  const path = viewPath(v);
  const shown = viewFromPath(pathname);
  return shown && viewPath(shown) === path ? null : path;
}
