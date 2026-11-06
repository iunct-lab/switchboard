/**
 * The artifact bridge: an HTML artifact runs in a sandboxed frame with an opaque origin, so it cannot call `/api`
 * itself (`Origin: null` is refused). The screen that shows it reads `GET /api/…` on its behalf and posts the answer
 * back to that frame only (`docs/design/scratch-apps.md`). A read is what the Task's agent can already read. A write
 * (POST / PUT / PATCH / DELETE) waits for the person to see it and press 実行する, once per request (no "don't ask
 * again"): a throwaway page is not tested, so its mistake must not become an operation unseen (`ui-layers.md`).
 */

import { viewFromPath, viewPath } from "./route.ts";

/** What the frame posts to its parent. */
export type BridgeRequest = { type: "switchboard-api"; id: string; method: string; path: string; body?: unknown };
/** What the screen posts back to the frame that asked. */
export type BridgeResult = { type: "switchboard-api-result"; id: string; ok: boolean; status: number; body: unknown };
/** Posted at once for a write that waits for the person: the client stops its 3-second "no screen around me" timer. */
export type BridgePending = { type: "switchboard-api-pending"; id: string };
/** What the frame posts to move the screen to one of Switchboard's own screens (a Task, a header tab). No answer. */
export type NavigateRequest = { type: "switchboard-navigate"; path: string };

export const BRIDGE_MAX = 20;
export const BRIDGE_WINDOW_MS = 10_000;
const MAX_PATH = 2_000;
const WRITES = ["POST", "PUT", "PATCH", "DELETE"];
/** The answer a write gets when the person presses やめる (or Esc, or outside the dialog). */
// ui-strings: value "利用者が断った" — sent to the artifact frame (docs/design/scratch-apps.md); compared by the artifact's code
export const DECLINED = "利用者が断った";

/**
 * Writes refused without asking: a sign-in or an approval is the person's own step on the screen, and a key or a
 * setting outlives the one operation the dialog shows. Reads of the same paths are unchanged.
 */
export const BRIDGE_REFUSED: RegExp[] = [
  /^\/api\/runners\/[^/]+\/(login|logout)(\/|$)/, // a runner's sign-in, its code, and its sign-out
  /^\/api\/tasks\/[^/]+\/device-auth$/, // a Task's device sign-in wait
  /^\/api\/tasks\/[^/]+\/permission(-mode)?$/, // the answer to a Task's approval, and how it asks for them
  /^\/api\/asks\/answer$/, // the same from the asks list, and a saved policy with it
  /^\/api\/policies(\/|$)/, // saved answer policies (a person's, `humanCheck`)
  /^\/api\/settings$/, // the settings
  /^\/api\/custom-runners$/, // the commands a runner starts
  /^\/api\/workspaces\/[^/]+\/runner-config$/, // a workspace's runner files
  /^\/api\/artifacts\/[^/]+\/view$/, // a view key (a credential in a URL)
  /^\/api\/tasks\/[^/]+\/mcp\/rotate$/, // a Task's new MCP token
];

/**
 * The path a `switchboard-navigate` message may move the screen to, or null: only a screen's own path as `route.ts`
 * writes it (`/task/<id>` or a header tab's path). Another site, `/api/…`, a query, a fragment, a %-escape, a `.` or
 * `..` segment or a trailing slash is dropped, so an untrusted artifact cannot take the screen anywhere else.
 */
export function parseNavigateRequest(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.type !== "switchboard-navigate" || typeof d.path !== "string") return null;
  const path = d.path;
  if (path.length > MAX_PATH || !path.startsWith("/") || path.startsWith("//")) return null;
  if (/[\u0000-\u0020\u007f\\?#%]/.test(path)) return null;
  // pushState resolves `.` and `..` segments: `/task/..` would land on Home, so the path must be the one the browser keeps
  if (new URL(path, "http://switchboard.invalid").pathname !== path) return null;
  const view = viewFromPath(path);
  return view && viewPath(view) === path ? path : null;
}

export type ParsedRequest = { ok: true; req: BridgeRequest; confirm: boolean } | { ok: false; status: number; why: string };

/** Checks a posted message: a path under `/api/` that does not climb out of it; a GET is read, a write is confirmed first. */
// ui-strings: value "要求の形が違います" "パスが長すぎます" "/api/ の下だけを読めます" "パスに空白・制御文字・# は使えません" "パスを読めません" "パスに使えない文字があります" "パスの形が違います" "取り次ぎでは refresh（GitHub からの取り込み）を使えません" "本文を JSON にできません" — API errors handed to the artifact's code, not switched (docs/design/ui-language.md)
export function parseBridgeRequest(data: unknown): ParsedRequest {
  // every `why` here, and the limiter's error below, is sent to the artifact frame as an API error, like the daemon's own errors
  const bad = (why: string): ParsedRequest => ({ ok: false, status: 400, why });
  if (!data || typeof data !== "object") return bad("要求の形が違います");
  const d = data as Record<string, unknown>;
  if (d.type !== "switchboard-api" || typeof d.id !== "string" || typeof d.method !== "string" || typeof d.path !== "string") return bad("要求の形が違います");
  const method = d.method.toUpperCase();
  if (method !== "GET" && !WRITES.includes(method)) return { ok: false, status: 405, why: "取り次げるのは GET・POST・PUT・PATCH・DELETE です" };
  const path = d.path;
  if (path.length > MAX_PATH) return bad("パスが長すぎます");
  if (!path.startsWith("/api/")) return bad("/api/ の下だけを読めます");
  // The checks below must see the path fetch will call. The URL parser drops a fragment, tabs and newlines and trims
  // trailing spaces and controls (#3880): refuse those characters, and anything else it would rewrite (the check after decoding).
  if (/[\u0000-\u0020\u007f#]/.test(path)) return bad("パスに空白・制御文字・# は使えません");
  // the checks are on the path part; the query only has to keep off `refresh`, which makes a read import from GitHub
  const q = path.indexOf("?");
  const pathname = q < 0 ? path : path.slice(0, q);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return bad("パスを読めません");
  }
  for (const p of [pathname, decoded]) if (p.includes("..") || p.includes("\\") || p.includes("\0") || p.includes("//")) return bad("パスに使えない文字があります");
  let called: string;
  try {
    called = decodeURIComponent(new URL(pathname, "http://switchboard.invalid").pathname);
  } catch {
    return bad("パスを読めません");
  }
  if (called !== decoded) return bad("パスの形が違います");
  if (q >= 0 && new URLSearchParams(path.slice(q + 1)).has("refresh")) return bad("取り次ぎでは refresh（GitHub からの取り込み）を使えません");
  if (method === "GET") return { ok: true, req: { type: "switchboard-api", id: d.id, method, path }, confirm: false };
  if (BRIDGE_REFUSED.some((r) => r.test(decoded))) return { ok: false, status: 403, why: "この操作は使い捨ての画面からはできません" };
  // postMessage carries what JSON cannot (a cycle, a BigInt): refuse it here, before the confirm shows it (#3880)
  try {
    JSON.stringify(d.body);
  } catch {
    return bad("本文を JSON にできません");
  }
  return { ok: true, req: { type: "switchboard-api", id: d.id, method, path, ...(d.body !== undefined ? { body: d.body } : {}) }, confirm: true };
}

/** At most `max` requests per `windowMs` (a sliding window); one per shown artifact. */
export class BridgeLimiter {
  private at: number[] = [];
  constructor(
    private readonly max = BRIDGE_MAX,
    private readonly windowMs = BRIDGE_WINDOW_MS,
  ) {}
  take(now: number): boolean {
    this.at = this.at.filter((t) => now - t < this.windowMs);
    if (this.at.length >= this.max) return false;
    this.at.push(now);
    return true;
  }
}

export type BridgeDeps = {
  /** The windows of the frames this bridge answers; anything else posting is ignored. */
  frames: () => readonly unknown[];
  /** Calls the API (a GET, or a write the person has let through). */
  call: (req: BridgeRequest) => Promise<{ status: number; body: unknown }>;
  /** Shows the write to the person; true = 実行する. Called one at a time: the next waits until this one is closed. */
  confirm: (req: BridgeRequest) => Promise<boolean>;
  reply: (to: unknown, result: BridgeResult | BridgePending) => void;
  /** Moves the screen to a path `parseNavigateRequest` let through (a screen of Switchboard's own). */
  navigate: (path: string) => void;
  limiter?: BridgeLimiter;
  now?: () => number;
};

/** Answers one `message` event; resolves once the reply is posted (or at once when the message is not for it). */
export function createBridge(deps: BridgeDeps): (ev: { source: unknown; data: unknown }) => Promise<void> {
  const limiter = deps.limiter ?? new BridgeLimiter();
  const now = deps.now ?? Date.now;
  // one dialog at a time: a write that comes while one is open waits for it to close
  let open: Promise<unknown> = Promise.resolve();
  const confirmInTurn = (req: BridgeRequest): Promise<boolean> => {
    const asked = open.then(() => deps.confirm(req));
    open = asked.catch(() => false);
    return asked;
  };
  return async (ev) => {
    if (!ev.source || !deps.frames().includes(ev.source)) return;
    const d = ev.data as { type?: unknown; id?: unknown } | null;
    if (!d || typeof d !== "object") return;
    if (d.type === "switchboard-navigate") {
      // no answer either way: a refused path, or one over the limit, is dropped
      const path = parseNavigateRequest(d);
      if (path !== null && limiter.take(now())) deps.navigate(path);
      return;
    }
    if (d.type !== "switchboard-api") return;
    const id = typeof d.id === "string" ? d.id : "";
    const send = (status: number, body: unknown) => deps.reply(ev.source, { type: "switchboard-api-result", id, ok: status >= 200 && status < 300, status, body });
    if (!limiter.take(now())) return send(429, { error: `取り次ぎは ${BRIDGE_WINDOW_MS / 1000} 秒に ${BRIDGE_MAX} 件までです` });
    const p = parseBridgeRequest(d);
    if (!p.ok) return send(p.status, { error: p.why });
    if (p.confirm) {
      deps.reply(ev.source, { type: "switchboard-api-pending", id });
      const yes = await confirmInTurn(p.req).catch(() => false);
      if (!yes) return send(0, { error: DECLINED });
    }
    try {
      const r = await deps.call(p.req);
      send(r.status, r.body);
    } catch (e) {
      send(0, { error: String((e as Error).message ?? e) });
    }
  };
}
