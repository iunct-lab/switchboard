import { z } from "zod";

/**
 * A report the person registered on the Task screen: a file or folder copied into the daemon's data
 * directory (so it opens after the original is gone), or a URL (not copied). `entry` is the file name (file), the
 * page to open inside the copied folder (dir) or null (url). `removedAt` set = in the undo window, swept after a day.
 */
export const Artifact = z.object({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  kind: z.enum(["file", "dir", "url"]),
  source: z.string(),
  entry: z.string().nullable(),
  mime: z.string(),
  size: z.number(),
  removedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Throwaway apps: the local days the page read the API through the screen, and the request Task Switchboard started for it. */
  appDays: z.number(),
  appRequestTaskId: z.string().nullable(),
});
export type Artifact = z.infer<typeof Artifact>;

/** A row across Tasks (reports, and every artifact): an artifact with its Task's title and, when a schedule started that Task, the schedule's. */
export const ReportRow = Artifact.extend({ taskTitle: z.string(), scheduleTitle: z.string().nullable() });
export type ReportRow = z.infer<typeof ReportRow>;
