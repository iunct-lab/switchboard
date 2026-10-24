import type { DeviceAuthView } from "@switchboard/protocol";

/**
 * A Task's wait for an approval elsewhere (#662, docs/design/device-auth.md): the card's time left and whether it is
 * still shown. The screen hides it at `expiresAt` itself, without waiting for the daemon's message.
 */

/** `m:ss` until `expiresAt`; empty once it has passed. */
export function remaining(expiresAt: number, now: number): string {
  const s = Math.ceil((expiresAt - now) / 1000);
  if (s <= 0) return "";
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function visible(auth: DeviceAuthView | null | undefined, now: number): boolean {
  return !!auth && auth.expiresAt > now;
}

/** The host the person is sent to, so a URL the agent printed is judged by where it leads. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
