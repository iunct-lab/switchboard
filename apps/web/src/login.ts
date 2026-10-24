/**
 * Where an unauthorized browser goes (#211). The daemon says how a person gets in (`/api/health` → `login`): on the
 * cloud host it is a passkey on `/_auth/` (the starter Lambda behind the same CloudFront origin), which sets the
 * `sb_session` cookie; elsewhere (the Mac, the LAN, the tailnet) it is the token prompt.
 *
 * Loop guard: the passkey page sends the browser back with `from=auth` in the query. If the daemon still refuses it
 * (the cookie passed the Lambda but not the daemon — a rotated key the daemon has not picked up), the UI shows that
 * instead of going to the passkey page again.
 */
export type LoginMode = "passkey" | "token";
export type LoginRoute = { kind: "passkey"; url: string } | { kind: "token" } | { kind: "stuck" } | { kind: "none" };

export function loginRoute(o: { authorized: boolean; hasToken: boolean; mode: LoginMode | undefined; path: string }): LoginRoute {
  if (o.authorized) return { kind: "none" };
  if (o.mode !== "passkey") return o.hasToken ? { kind: "none" } : { kind: "token" };
  const [pathname, query = ""] = o.path.split("?", 2);
  const params = new URLSearchParams(query);
  if (params.get("from") === "auth") return { kind: "stuck" };
  params.delete("from");
  const back = `${pathname}${params.size ? `?${params}` : ""}`;
  const safe = back.startsWith("/") && !back.startsWith("//") ? back : "/";
  return { kind: "passkey", url: `/_auth/?next=${encodeURIComponent(safe)}` };
}

/**
 * The path without the passkey page's `from=auth` mark, or null when it has none. Dropped once the daemon lets the
 * cookie in (#709): a tab left at `/?from=auth` would otherwise read a later refusal (the passkey removed, the cookie
 * expired) as "the login passed but the daemon refuses" and stay put instead of going back to the passkey page.
 */
export function withoutFromAuth(path: string): string | null {
  const [pathname, query = ""] = path.split("?", 2);
  const params = new URLSearchParams(query);
  if (params.get("from") !== "auth") return null;
  params.delete("from");
  return `${pathname}${params.size ? `?${params}` : ""}`;
}

/** The cloud host's page for the temporary extra countries (#1639): only with the passkey login (the Starter's `/_auth/`); null elsewhere. */
export function countriesUrl(mode: LoginMode | undefined): string | null {
  return mode === "passkey" ? "/_auth/#countries" : null;
}

/** Stuck happens with a passkey, so on the cloud host only: the rescue page is the same origin's /rescue/, which CloudFront hands to sb-rescue (#399). */
export const STUCK_RESCUE = "/rescue/";

export const STUCK_MESSAGE = "パスキーのログインは通りましたが、デーモンがその Cookie を受け付けません。デーモンの再起動が要ります（救援画面の「再起動」、または作り直す）。";

/**
 * CloudFront's "stopped" page (#211): while the cloud host is stopped, every path — /api/health too — answers with
 * that HTML page and 503. A daemon never answers its API with HTML, so this is the machine being off, not an error of
 * the app: go to the login page, which can start it. Needed because an installed service worker from an older build
 * cannot update while the machine is off and keeps showing the cached app.
 */
export function stoppedRoute(o: { status: number; contentType: string | null; path: string }): string | null {
  if (![502, 503, 504].includes(o.status) || !(o.contentType ?? "").includes("text/html")) return null;
  const back = o.path.startsWith("/") && !o.path.startsWith("//") && !o.path.startsWith("/_auth") ? o.path : "/";
  return `/_auth/?next=${encodeURIComponent(back)}`;
}

/**
 * Whether the cloud host is really off, asked before leaving the screen for the login page (which loses what is being
 * typed). One request answered with the stopped page is not enough: CloudFront answers any single failed connection to
 * the origin (502 / 504) with that page while the daemon is up and never saw the request, so the screen used to jump to
 * /_auth/ and back mid-typing. /api/health is asked `tries` times, `gapMs` apart; off only when every answer is the
 * stopped page. No answer at all (offline, or none within 5 s) is not "off" either: the failed request then just fails. The requests that fail together share one check.
 */
let checking: Promise<boolean> | undefined;
export function hostStopped(
  probe: () => Promise<{ status: number; headers: { get(name: string): string | null } }> = () => fetch("/api/health", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(5000) }),
  tries = 2,
  gapMs = 2000,
): Promise<boolean> {
  const ask = async () => {
    for (let i = 0; i < tries; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
      const r = await probe().catch(() => null);
      if (!r || !stoppedRoute({ status: r.status, contentType: r.headers.get("content-type"), path: "/" })) return false;
    }
    return true;
  };
  checking ??= ask().finally(() => (checking = undefined));
  return checking;
}

export const LEAVE_STOPPED = "ホストが止まっているようです。ログインページへ移ると、入力中の文は消えます。移りますか？";

/** Text typed into a field of the page (a textarea, or a text-like input) that leaving it would lose. */
export function hasTypedText(doc: { querySelectorAll(sel: string): ArrayLike<{ value: string }> }): boolean {
  return Array.from(doc.querySelectorAll('textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="email"]')).some((f) => f.value.trim() !== "");
}
