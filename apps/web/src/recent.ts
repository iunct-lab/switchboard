/** The cloud host's "passkey checked in the last 5 minutes" (#1491): what the Web UI does when a strong operation answers 401 `recent`. */
export const RECENT_MESSAGE = "操作の前にパスキーで確かめてください";

export function isRecentRefusal(status: number, body: unknown): boolean {
  return status === 401 && typeof body === "object" && body !== null && (body as { reason?: unknown }).reason === "recent";
}

const b64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** The passkey check on this origin's login (the same flow as sb-rescue's page, #497); throws why it failed. Call it from a click. */
export async function confirmPasskey(): Promise<void> {
  const post = async (path: string, body: unknown) => {
    const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = (await r.json().catch(() => ({}))) as { error?: string; challenge?: string; rpId?: string };
    if (!r.ok) throw new Error(data.error || `パスキーを確かめられませんでした (${r.status})`);
    return data;
  };
  const { challenge, rpId } = await post("/_auth/challenge", {});
  // closing the passkey sheet is NotAllowedError, not null
  const cred = (await navigator.credentials
    .get({ publicKey: { challenge: unb64(challenge!), rpId, userVerification: "required" } })
    .catch((e) => { if (e?.name === "NotAllowedError") return null; throw e; })) as PublicKeyCredential | null;
  if (!cred) throw new Error("キャンセルしました");
  const c = cred.response as AuthenticatorAssertionResponse;
  await post("/_auth/login", { challenge, id: cred.id, clientDataJSON: b64(c.clientDataJSON), authenticatorData: b64(c.authenticatorData), signature: b64(c.signature) });
}

type Listener = (resolve: (ok: boolean) => void) => void;
const listeners = new Set<Listener>();
let pending: Promise<boolean> | null = null;

/** The screen takes the question here; returns how to stop listening. */
export function onRecentCheck(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** true once the person checked, false if they declined (or nothing can ask). Requests that arrive together share one question. */
export function askRecentCheck(): Promise<boolean> {
  if (pending) return pending;
  const p = new Promise<boolean>((resolve) => {
    if (listeners.size === 0) return resolve(false);
    for (const l of listeners) l(resolve);
  }).finally(() => { if (pending === p) pending = null; });
  return (pending = p);
}
