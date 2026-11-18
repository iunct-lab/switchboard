import { ScheduleInput } from "@switchboard/protocol";
import { SCHEDULE_LOG_MAX_LIMIT } from "../scheduler.ts";
import { stuckSchedule } from "../stops.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/schedules. */
export function schedulesRoutes(sc: Pick<ServerContext, "json" | "scheduler" | "db" | "bad">): Routes {
  return {
    "/api/schedules": {
      GET: () =>
        sc.json(
          sc.scheduler.list().map((s) => {
            const st = stuckSchedule(sc.db, s);
            return { ...s, stuck: st && { count: st.count, reason: st.reason, evidence: st.evidence, firstAt: st.firstAt, taskId: st.work.taskId } };
          }),
        ),
      POST: async (req) => {
        const parsed = ScheduleInput.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) return sc.bad(parsed.error.message);
        try {
          return sc.json(sc.scheduler.create(parsed.data), 201);
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e));
        }
      },
    },
    "/api/schedules/:id": {
      GET: (req) => {
        const s = sc.db.getSchedule(String(req.params.id));
        return s ? sc.json(s) : sc.bad("not found", 404);
      },
      PATCH: async (req) => {
        const parsed = ScheduleInput.partial().safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) return sc.bad(parsed.error.message);
        try {
          return sc.json(sc.scheduler.update(String(req.params.id), parsed.data));
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e), 404);
        }
      },
      DELETE: (req) => {
        if (!sc.db.getSchedule(String(req.params.id))) return sc.bad("not found", 404);
        sc.scheduler.remove(String(req.params.id));
        return sc.json({ ok: true });
      },
    },
    "/api/schedules/:id/run": {
      POST: async (req) => {
        const id = String(req.params.id);
        // secret-scan reads every repository (minutes, past the request's idle timeout) and starts no Task: answered at
        // once, its lines go to the schedules log
        // approval-window starts no Task either: answered the same way
        const kind = sc.db.getSchedule(id)?.action;
        if (kind === "secret-scan" || kind === "approval-window") {
          void sc.scheduler.runNow(id, "manual").catch((e) => sc.scheduler.note(`${kind}: 始められない (manual): ${String((e as Error).message ?? e)}`, id));
          return sc.json({ scanning: true }, 202);
        }
        try {
          const task = await sc.scheduler.runNow(id, "manual");
          if (task && "promotion" in task) return sc.json({ promotion: task.promotion }, 202);
          return task ? sc.json(task, 201) : sc.bad("the previous run is still active, or backlog-next started nothing (see the schedules log)", 409);
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e), 404);
        }
      },
    },
    // ?since=<epoch ms>: the lines from that time on (an investigation reads hours back); ?limit=<n>: at most that many
    "/api/schedules/log": (req) => {
      const q = new URL(req.url).searchParams;
      const num = (name: string) => (q.get(name) === null || q.get(name) === "" ? undefined : Number(q.get(name)));
      const [since, limit] = [num("since"), num("limit")];
      if (since !== undefined && !(Number.isFinite(since) && since >= 0)) return sc.bad("since は epoch ミリ秒（0 以上の数）で渡す");
      if (limit !== undefined && !Number.isFinite(limit)) return sc.bad("limit は数で渡す");
      return sc.json(sc.scheduler.recentLog({ since, ...(limit === undefined ? {} : { limit: Math.min(SCHEDULE_LOG_MAX_LIMIT, Math.max(1, Math.floor(limit))) }) }));
    },
  };
}
