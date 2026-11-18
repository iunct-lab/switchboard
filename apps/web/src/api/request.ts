/** The request every call of the screen goes through: the token, the cloud login's renewal, and what a refusal does. */
import { hasTypedText, hostStopped, LEAVE_STOPPED, loginRoute, stoppedRoute, type LoginMode } from "../login.ts";
import { RECENT_MESSAGE, askRecentCheck, isRecentRefusal } from "../recent.ts";

const TOKEN_KEY = "switchboard.token";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** What `/api/health` said about the login; set by health() so a later 401 knows where to send the browser. */
let loginMode: LoginMode | undefined;
/** health() keeps what it read here. */
export const setLoginMode = (mode: LoginMode | undefined): void => { loginMode = mode; };

/** When the user said 移らない, the failing requests of the next minute do not ask again. */
let declinedAt = 0;

function mayLeave(): boolean {
  if (!hasTypedText(document)) return true;
  if (Date.now() - declinedAt < 60_000) return false;
  if (confirm(LEAVE_STOPPED)) return true;
  declinedAt = Date.now();
  return false;
}

/** After an action that changed something, the cloud login's idle time is moved on: the Starter alone can sign the cookie again, so this asks it; at most once every RENEW_EVERY_MS, and a failure is not an error of the action. */
export const RENEW_EVERY_MS = 10 * 60_000;

let renewedAt = 0;

export function renewLogin(mode: LoginMode | undefined, method: string | undefined, now = Date.now(), send: () => Promise<unknown> = () => fetch("/_auth/renew", { method: "POST", credentials: "same-origin" })): boolean {
  if (mode !== "passkey" || !method || method === "GET" || method === "HEAD" || now - renewedAt < RENEW_EVERY_MS) return false;
  renewedAt = now;
  void send().catch(() => {});
  return true;
}

/** Test hook: forget the last renewal. */
export const resetRenewal = () => { renewedAt = 0; };

export async function req<T>(url: string, init?: RequestInit, retried = false, seen?: { status: number }): Promise<T> {
  const token = getToken();
  // A FormData body sets its own multipart content-type (with the boundary); forcing JSON here would break it.
  const headers: Record<string, string> = init?.body instanceof FormData ? {} : { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });
  if (seen) seen.status = r.status;
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    // a strong operation wants a passkey check from the last 5 minutes: ask once, then send it again once
    if (isRecentRefusal(r.status, body)) {
      if (!retried && (await askRecentCheck())) return req<T>(url, init, true, seen);
      throw Object.assign(new Error(RECENT_MESSAGE), { status: r.status, body });
    }
    // the cloud host is stopped (CloudFront's HTML page instead of JSON): to the login page, which starts it —
    // once /api/health says so too; one dropped connection gets the same page and must not throw away the screen.
    // A longer outage of a running daemon looks the same, so with text typed on the page the user decides.
    const stopped = stoppedRoute({ status: r.status, contentType: r.headers.get("content-type"), path: location.pathname + location.search });
    if (stopped && (await hostStopped()) && mayLeave()) location.replace(stopped);
    // the cloud login cookie expired mid-session: back to the passkey page, then here again
    if (r.status === 401 && loginMode === "passkey") {
      const to = loginRoute({ authorized: false, hasToken: !!token, mode: loginMode, path: location.pathname + location.search });
      if (to.kind === "passkey") location.assign(to.url);
    }
    // `status` and `body` ride along so a caller can tell a refusal it can act on (409, e.g. with a taskId) from a failure it cannot
    throw Object.assign(new Error((body as { error?: string }).error ?? `${r.status} ${r.statusText}`), { status: r.status, body });
  }
  renewLogin(loginMode, init?.method?.toUpperCase());
  return (await r.json()) as T;
}

/**
 * A read for the artifact bridge (`scratchBridge.ts`): the same login and retry path as every call here, but a failure
 * comes back as its status and body instead of a throw, for the artifact to tell. A dropped connection, or a 2xx that is
 * not JSON, is status 0.
 */
export async function apiRaw(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const seen = { status: 0 };
  try {
    const body = await req<unknown>(path, init, false, seen);
    return { status: seen.status, body };
  } catch (e) {
    const x = e as { status?: number; body?: unknown; message?: string };
    // a 2xx whose body is not JSON threw after `seen` was set: not a success for the caller (status 0 like a dropped connection)
    return { status: x.status ?? (seen.status >= 200 && seen.status < 300 ? 0 : seen.status), body: x.body ?? { error: String(x.message ?? e) } };
  }
}
