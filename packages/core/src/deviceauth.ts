import type { DeviceAuthView } from "@switchboard/protocol";

/**
 * A Task's wait for an approval elsewhere (#662, docs/design/device-auth.md): a command the agent ran through the
 * kit's `device-auth` printed a URL and a one-time code (an SSO device login), and the person approves it in their own
 * browser. The daemon holds it in memory only — never the DB, never an event — and hands it to the screen over a
 * WebSocket message that is not stored. A restart forgets it; the code expires on its own within minutes anyway.
 * Shaped like `RunnerLogins` (runnerlogin.ts): a Map and a timer.
 */
export interface DeviceAuthInput {
  url: string;
  code?: string;
  command: string;
  expiresInSec: number;
}

/** The longest wait a command may ask for: device codes last 10–15 minutes. */
export const MAX_EXPIRES_SEC = 900;
const MAX_CODE = 64;
const MAX_TEXT = 2000;

export class DeviceAuths {
  private entries = new Map<string, { view: DeviceAuthView; timer: ReturnType<typeof setTimeout> }>();
  constructor(private onChange: (taskId: string, auth: DeviceAuthView | null) => void) {}

  /** Throws on a URL that is not https, an over-long code or a wait outside 1–900 s (the message never carries the value). */
  put(taskId: string, input: DeviceAuthInput, now = Date.now()): DeviceAuthView {
    let url: URL;
    try {
      if (typeof input.url !== "string") throw new Error();
      url = new URL(input.url);
    } catch {
      throw new Error("url must be an https URL");
    }
    if (url.protocol !== "https:" || input.url.length > MAX_TEXT) throw new Error("url must be an https URL");
    if (input.code !== undefined && (typeof input.code !== "string" || !input.code || input.code.length > MAX_CODE)) throw new Error(`code must be 1–${MAX_CODE} characters`);
    if (typeof input.command !== "string" || !input.command.trim() || input.command.length > MAX_TEXT) throw new Error("command must be a non-empty string");
    if (!Number.isInteger(input.expiresInSec) || input.expiresInSec < 1 || input.expiresInSec > MAX_EXPIRES_SEC) throw new Error(`expiresInSec must be 1–${MAX_EXPIRES_SEC}`);
    const prev = this.entries.get(taskId);
    if (prev) clearTimeout(prev.timer);
    const view: DeviceAuthView = { url: input.url, ...(input.code !== undefined && { code: input.code }), command: input.command, expiresAt: now + input.expiresInSec * 1000 };
    const timer = setTimeout(() => this.clear(taskId), input.expiresInSec * 1000);
    this.entries.set(taskId, { view, timer });
    this.onChange(taskId, view);
    return { ...view };
  }

  get(taskId: string): DeviceAuthView | null {
    const e = this.entries.get(taskId);
    return e ? { ...e.view } : null;
  }

  /** Forgets the wait (approved, given up, expired, or the Task ended). Quiet when there is none. */
  clear(taskId: string): void {
    const e = this.entries.get(taskId);
    if (!e) return;
    clearTimeout(e.timer);
    this.entries.delete(taskId);
    this.onChange(taskId, null);
  }

  stop(): void {
    for (const e of this.entries.values()) clearTimeout(e.timer);
    this.entries.clear();
  }
}
