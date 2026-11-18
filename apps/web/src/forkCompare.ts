import { archiveRefusal, type EventEnvelope, type Task, type TaskStatus } from "@switchboard/protocol";
import { foldTranscript, type Item } from "./transcript.ts";
import { t } from "./i18n.ts";
import { brief as m } from "./i18n/brief.ts";

/**
 * One column of 並べて見る: what a Task did after the fork. The fork's parent and child share a working tree, so
 * there is no diff to compare — only the replies and how each side ended.
 */
export interface ForkSide {
  taskId: string;
  role: "parent" | "child";
  /** The runner's reply in the last turn after the fork; "" when there is none yet. */
  lastReply: string;
  /** How the last turn after the fork ended; null while none has. */
  end: { status: "ok" | "error" | "aborted"; at: number } | null;
  /** Turns after the fork: user messages sent since. */
  turns: number;
}

function side(taskId: string, role: ForkSide["role"], events: EventEnvelope[]): ForkSide {
  const { items } = foldTranscript(events);
  const users = items.filter((i) => i.kind === "user" && i.text !== "");
  const lastUser = users.at(-1);
  // how the last turn ended: an end row after the last user message. A turn still running has none, whatever ended before it
  const tail = lastUser ? items.slice(items.indexOf(lastUser) + 1) : items;
  const lastEnd = tail.filter((i): i is Extract<Item, { kind: "end" }> => i.kind === "end").at(-1);
  return {
    taskId,
    role,
    lastReply: tail.flatMap((i) => (i.kind === "assistant" && i.text ? [i.text] : [])).join("\n\n"),
    end: lastEnd ? { status: lastEnd.status, at: lastEnd.at ?? 0 } : null,
    turns: users.length,
  };
}

/**
 * The two columns: the parent's events after the fork point only (what it did before is the same conversation the
 * child continues), and all of the child's. `child.forkSeq` is the parent's `session.end` the fork was taken at.
 */
export function forkSides(parent: { task: Pick<Task, "id">; events: EventEnvelope[] }, child: { task: Pick<Task, "id" | "forkSeq">; events: EventEnvelope[] }): [ForkSide, ForkSide] {
  const from = child.task.forkSeq ?? 0;
  return [side(parent.task.id, "parent", parent.events.filter((e) => e.seq > from)), side(child.task.id, "child", child.events)];
}

/** Whether a column's 採らない（アーカイブ） can be pressed, by the daemon's own rule, and the reason shown when not. */
export function canArchive(task: { status: TaskStatus }): { ok: boolean; reason?: string } {
  const why = archiveRefusal(task.status);
  return why === null ? { ok: true } : { ok: false, reason: why === "idle" ? t(m.archiveIdle) : t(m.archiveInFlight) };
}
