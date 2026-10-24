import { SESSION_COOKIE } from "./auth";

/**
 * The cloud host's request log (#1490): one JSON line per request and per strong operation, written to stdout (sb-rescue
 * puts that in daemon.log; the CloudWatch agent ships it). Metadata only — never a body, a query, a cookie or a token.
 */

export type AuthKind = "cookie" | "token" | "none";

/** Which kind of credential the request presented (not whether it was good — the status says that). Values are never read. */
export function authKind(req: Request): AuthKind {
  const cookie = req.headers.get("cookie") ?? "";
  if (cookie.split(";").some((p) => p.trim().startsWith(`${SESSION_COOKIE}=`))) return "cookie";
  if (req.headers.get("authorization")?.toLowerCase().startsWith("bearer ")) return "token";
  if (URL.canParse(req.url) && new URL(req.url).searchParams.has("token")) return "token";
  return "none";
}

/** `ms` = until the handler returned its Response (#2101; the transfer is not in it), to 0.1 ms. */
export function accessLine(e: { t: number; from: string | undefined; method: string; path: string; status: number; auth: AuthKind; ms: number }): string {
  return JSON.stringify({ log: "access", t: new Date(e.t).toISOString(), from: e.from ?? null, method: e.method, path: e.path, status: e.status, auth: e.auth, ms: Math.round(e.ms * 10) / 10 });
}

export function opLine(e: { t: number; from: string | undefined; op: string; task?: string; detail?: unknown }): string {
  return JSON.stringify({ log: "op", t: new Date(e.t).toISOString(), from: e.from ?? null, op: e.op, ...(e.task !== undefined ? { task: e.task } : {}), ...(e.detail !== undefined ? { detail: e.detail } : {}) });
}
