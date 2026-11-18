import { type EvalsSummary, RunnerId } from "@switchboard/protocol";
import { tasksOfIssues } from "../db.ts";
import { EVAL_STAGE_WEEKS, evalContext, judgeHumanGap, requestSampleRows, stageCounts, weekStartUtc, weeklyHumanSample, withRequestOutputs } from "../evals.ts";
import { storedIssueReader } from "../backlog-stored.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/evals. */
export function evalsRoutes(sc: Pick<ServerContext, "bad" | "db" | "countRules" | "json">): Routes {
  return {
    // The Evals list: newest first, up to `limit` (100, at most 500), filtered by workspace / runner.
    "/api/evals": (req) => {
      const url = new URL(req.url);
      const limit = Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get("limit")) || 100)));
      const runner = url.searchParams.get("runner");
      if (runner && !RunnerId.safeParse(runner).success) return sc.bad("unknown runner");
      const rows = sc.db.evalsList({ workspaceId: url.searchParams.get("workspaceId") || undefined, runner: (runner as RunnerId | null) || undefined, limit });
      // a local task without a readable rules row (from before rule metrics were counted, still in its first turn, or a row this version cannot read) is
      // counted here and the row kept, as the Brief does, so the two agree. Paid once per task; one task that cannot be counted
      // stays at null rather than failing the list.
      for (const row of rows) {
        if (row.rules) continue;
        const t = sc.db.getTask(row.taskId);
        if (!t || t.executionMode === "cloud") continue;
        try {
          const m = sc.countRules(t).metrics;
          row.rules = { toolCalls: m.toolCalls, toolFailures: m.toolFailures, errors: m.errors, userInstructions: m.userInstructions, stops: m.stops, decisionStops: m.stopReasons.decision ?? 0, lastEnd: m.lastEnd, daemonStops: m.daemonStops, lastCutByDaemon: m.lastCutByDaemon };
        } catch (e) {
          console.warn(`evals: task ${row.taskId} not counted for the list (${String((e as Error).message ?? e)})`);
        }
      }
      return sc.json(rows);
    },
    // The Insights summary: this week's ask-to-rate sample (from the tasks judged the week before) and the
    // human − judge gap over every rated task. Counted on each read; the week turns over by itself.
    "/api/evals/summary": (req) => {
      const workspaceId = new URL(req.url).searchParams.get("workspaceId") || undefined;
      const weekStart = weekStartUtc(Date.now());
      const readIssue = storedIssueReader(sc.db); // the workspace's Issue records are read once for all rows
      const from = weekStart - 7 * 86_400_000;
      // the requests closed that week with their PBIs, in the named workspace or in every one that has a backlog
      const requests = (workspaceId ? [workspaceId] : sc.db.listWorkspaces().map((w) => w.id)).flatMap((id) => requestSampleRows(sc.db, id, from, weekStart, readIssue, (numbers) => tasksOfIssues(sc.db.sqlite, numbers, [id]).map((t) => t.id)));
      const sample = weeklyHumanSample(sc.db.evalsList({ workspaceId, judgedFrom: from, judgedTo: weekStart, limit: 500 }), requests);
      // every rated task, not the list's 500: ratings are given by hand, so they stay few, and a cut would drop the oldest
      const gap = judgeHumanGap(sc.db.evalsList({ workspaceId, rated: true, limit: Number.MAX_SAFE_INTEGER }));
      const stagesFrom = Date.now() - EVAL_STAGE_WEEKS * 7 * 86_400_000;
      return sc.json({
        weekStart,
        sample: sample.map((r) => ("kind" in r ? { ...withRequestOutputs(sc.db, r, readIssue), human: sc.db.getRequestEval(r.workspaceId, r.number) } : { ...r, kind: "task" as const, context: evalContext(sc.db, sc.db.getTask(r.taskId)!, readIssue) })),
        stages: stageCounts(sc.db.requestEvalsSince(stagesFrom, workspaceId), stagesFrom),
        gap,
      } satisfies EvalsSummary);
    },
  };
}
