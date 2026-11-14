export * from "./events.ts";
export * from "./model.ts";
export * from "./rpc.ts";
export * from "./adapter.ts";
export * from "./person-wait.ts";

export const PROTOCOL_VERSION = "0.1.0";

/** The start of the daemon's status line for a reply put in the run-slot queue (the screen shows that line in the conversation). */
export const REPLY_QUEUED = "実行枠待ちに返信を入れました";
