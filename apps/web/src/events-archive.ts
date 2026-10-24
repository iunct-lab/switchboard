import { jstDay } from "./time.ts";

/** Where a finished task's conversation went (#1431): S3 keys one per line (oldest first), when, and how many events. */
export interface EventsArchive {
  key: string;
  at: number;
  count: number;
}

/** The line above the conversation of a task whose events were moved to S3; null when nothing was moved. */
export function eventsArchiveNotice(a: EventsArchive | null | undefined): string | null {
  if (!a) return null;
  const day = jstDay(a.at);
  return `会話の記録は S3 に移しました（${day}、${a.count} 件）: ${a.key.split("\n").join(", ")}`;
}
