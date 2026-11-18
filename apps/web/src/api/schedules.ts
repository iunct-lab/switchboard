import type { Schedule, ScheduleInput, Task } from "@switchboard/protocol";
import { req } from "./request.ts";

/** The calls of this group; `api` (index.ts) holds every group's. */
export const schedulesApi = {
  schedules: () => req<Schedule[]>("/api/schedules"),
  createSchedule: (input: ScheduleInput) => req<Schedule>("/api/schedules", { method: "POST", body: JSON.stringify(input) }),
  updateSchedule: (id: string, patch: Partial<ScheduleInput>) => req<Schedule>(`/api/schedules/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSchedule: (id: string) => req<{ ok: boolean }>(`/api/schedules/${id}`, { method: "DELETE" }),
  /** A Task, or `scanning` for a secret-scan schedule (it starts no Task; its lines go to the log). */
  runSchedule: (id: string) => req<Task | { scanning: true } | { promotion: string }>(`/api/schedules/${id}/run`, { method: "POST" }),
  scheduleLog: () => req<string[]>("/api/schedules/log"),
};
