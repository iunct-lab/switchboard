/**
 * The artifact bridge: an HTML artifact runs in a sandboxed frame with an opaque origin, so it cannot call `/api`
 * itself (`Origin: null` is refused). The screen that shows it reads `GET /api/…` on its behalf and posts the answer
 * back to that frame only (`docs/design/scratch-apps.md`). Reading only: what the Task's agent can already read.
 */

/** What the frame posts to its parent. */
export type BridgeRequest = { type: "switchboard-api"; id: string; method: string; path: string; body?: unknown };
/** What the screen posts back to the frame that asked. */
export type BridgeResult = { type: "switchboard-api-result"; id: string; ok: boolean; status: number; body: unknown };

export const BRIDGE_MAX = 20;
export const BRIDGE_WINDOW_MS = 10_000;
const MAX_PATH = 2_000;

export type ParsedRequest = { ok: true; req: BridgeRequest } | { ok: false; status: number; why: string };

/** Checks a posted message: GET only, a path under `/api/` that does not climb out of it. */
export function parseBridgeRequest(data: unknown): ParsedRequest {
  const bad = (why: string): ParsedRequest => ({ ok: false, status: 400, why });
  if (!data || typeof data !== "object") return bad("要求の形が違います");
  const d = data as Record<string, unknown>;
  if (d.type !== "switchboard-api" || typeof d.id !== "string" || typeof d.method !== "string" || typeof d.path !== "string") return bad("要求の形が違います");
  if (d.method.toUpperCase() !== "GET") return { ok: false, status: 405, why: "この取り次ぎは読むだけです" };
  const path = d.path;
  if (path.length > MAX_PATH) return bad("パスが長すぎます");
  if (!path.startsWith("/api/")) return bad("/api/ の下だけを読めます");
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
  if (q >= 0 && new URLSearchParams(path.slice(q + 1)).has("refresh")) return bad("取り次ぎでは refresh（GitHub からの取り込み）を使えません");
  return { ok: true, req: { type: "switchboard-api", id: d.id, method: "GET", path } };
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
  read: (path: string) => Promise<{ status: number; body: unknown }>;
  reply: (to: unknown, result: BridgeResult) => void;
  limiter?: BridgeLimiter;
  now?: () => number;
};

/** Answers one `message` event; resolves once the reply is posted (or at once when the message is not for it). */
export function createBridge(deps: BridgeDeps): (ev: { source: unknown; data: unknown }) => Promise<void> {
  const limiter = deps.limiter ?? new BridgeLimiter();
  const now = deps.now ?? Date.now;
  return async (ev) => {
    if (!ev.source || !deps.frames().includes(ev.source)) return;
    const d = ev.data as { type?: unknown; id?: unknown } | null;
    if (!d || typeof d !== "object" || d.type !== "switchboard-api") return;
    const id = typeof d.id === "string" ? d.id : "";
    const send = (status: number, body: unknown) => deps.reply(ev.source, { type: "switchboard-api-result", id, ok: status >= 200 && status < 300, status, body });
    if (!limiter.take(now())) return send(429, { error: `取り次ぎは ${BRIDGE_WINDOW_MS / 1000} 秒に ${BRIDGE_MAX} 件までです` });
    const p = parseBridgeRequest(d);
    if (!p.ok) return send(p.status, { error: p.why });
    try {
      const r = await deps.read(p.req.path);
      send(r.status, r.body);
    } catch (e) {
      send(0, { error: String((e as Error).message ?? e) });
    }
  };
}
