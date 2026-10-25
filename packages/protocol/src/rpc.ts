import { z } from "zod";
import { EventEnvelope, PermissionAnswers, PermissionDecision } from "./events.ts";
import { DeviceAuthView, Task, TeleportProgress } from "./model.ts";

/** Client → daemon over WebSocket. REST covers the rest (see core/server.ts). */
export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("task.send"), taskId: z.string(), text: z.string() }),
  z.object({ type: z.literal("permission.respond"), taskId: z.string(), id: z.string(), decision: PermissionDecision, answers: PermissionAnswers.optional() }),
  z.object({ type: z.literal("task.abort"), taskId: z.string() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

/** Daemon → client. */
export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), version: z.string() }),
  z.object({ type: z.literal("event"), env: EventEnvelope }),
  z.object({ type: z.literal("task.updated"), task: Task }),
  z.object({ type: z.literal("knowledge.updated"), count: z.number() }),
  /** Self-dev checks finished for a task (the Brief refetches). */
  z.object({ type: z.literal("checks.updated"), taskId: z.string(), ok: z.boolean() }),
  /** Evals (#1219): the task's judge row changed; the screen reads `GET /api/tasks/:id/evals` again. */
  z.object({ type: z.literal("evals.updated"), taskId: z.string() }),
  /** Workspaces were registered or their settings changed (#1447); the screen reads `GET /api/workspaces` again. */
  z.object({ type: z.literal("workspaces.updated") }),
  /** A Task's approval wait came or went (#662). Not an event: never stored, so the code stays out of the log. */
  z.object({ type: z.literal("task.deviceAuth"), taskId: z.string(), auth: DeviceAuthView.nullable() }),
  /** "Continue locally" moved on for a Cloud Task (#1306); null when it was cleared. Not an event: never stored. */
  z.object({ type: z.literal("task.teleport"), taskId: z.string(), progress: TeleportProgress.nullable() }),
  /** The daemon is about to re-exec itself; clients should expect the socket to drop and reconnect. */
  z.object({ type: z.literal("daemon.restarting") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;

/** What removing a workspace would do (#2600), for the confirmation: the copy's reach, what it would lose, and Tasks running there. */
export type WorkspaceRemoval = { name: string; path: string; copy: { deletable: boolean; reason?: string }; dirty: boolean; unpushed: boolean; running: number };
