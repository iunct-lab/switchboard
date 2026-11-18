import type { View } from "./screen.ts";

/**
 * Each screen's URL: a Task, a Workspace's terminal and every header tab open from their own path, so a reload, a second tab and the
 * browser's back / forward keep the place. `/approvals` is the PWA's start_url. Only the screen is in the URL —
 * an open artifact and Insights' report / artifacts are not. The daemon answers an unknown path with index.html.
 */
const PATHS = {
  home: "/",
  ledger: "/ledger",
  evals: "/insights",
  schedules: "/schedules",
  backlog: "/backlog",
  resources: "/resources",
  approvals: "/approvals",
  settings: "/settings",
} as const satisfies Record<Exclude<View["name"], "task" | "terminal">, string>;

const TASK = "/task/";
const TERMINAL = "/terminal/";

/** The one path segment after a prefix, decoded; null when it is empty, has more segments or a malformed %-escape. */
function idAfter(path: string, prefix: string): string | null {
  const raw = path.slice(prefix.length);
  if (!raw || raw.includes("/")) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

export function viewPath(v: View): string {
  if (v.name === "task") return `${TASK}${encodeURIComponent(v.id)}`;
  if (v.name === "terminal") return `${TERMINAL}${encodeURIComponent(v.workspaceId)}`;
  return PATHS[v.name];
}

/** The screen a path opens, or null for a path that is not one (the caller falls back to Home). */
export function viewFromPath(pathname: string): View | null {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  if (path.startsWith(TASK)) {
    const id = idAfter(path, TASK);
    return id === null ? null : { name: "task", id };
  }
  if (path.startsWith(TERMINAL)) {
    const workspaceId = idAfter(path, TERMINAL);
    return workspaceId === null ? null : { name: "terminal", workspaceId };
  }
  const name = (Object.keys(PATHS) as (keyof typeof PATHS)[]).find((k) => PATHS[k] === path);
  return name ? ({ name } as View) : null;
}

/**
 * The path the address bar should get for the screen now shown, or null when it already shows that screen: the
 * Task's artifact, a trailing slash and Insights' scope are the same screen, and a screen popstate brought back is not
 * pushed again. A path that is no screen gets the shown screen's path.
 */
export function pathToWrite(v: View, pathname: string): string | null {
  const path = viewPath(v);
  const shown = viewFromPath(pathname);
  return shown && viewPath(shown) === path ? null : path;
}
