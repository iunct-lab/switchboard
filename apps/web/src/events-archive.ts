import { jstDay } from "./time.ts";
import { t } from "./i18n.ts";
import { task as m } from "./i18n/task.ts";

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
  return t(m.eventsArchived, { day, count: a.count, keys: a.key.split("\n").join(", ") });
}
