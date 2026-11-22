import type { BundleHold, Task } from "@switchboard/protocol";
import { req } from "./request.ts";

/** The calls of this group; `api` (index.ts) holds every group's. */
export const bundleApi = {
  /** The hold a bundle of work has put on the daemon; null when there is none. */
  bundleHold: () => req<BundleHold | null>("/api/bundle"),
  /** Starts a bundle: the Task that does it (201); 409 = a bundle is under way. */
  startBundle: (pbis: number[]) => req<Task>("/api/bundle", { method: "POST", body: JSON.stringify({ pbis }) }),
  /** Ends the hold: `restored` are the schedules turned back on. */
  releaseBundle: () => req<{ released: boolean; restored: string[] }>("/api/bundle", { method: "DELETE" }),
};
