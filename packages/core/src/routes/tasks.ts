import { readCloudPreparation, cloudTransferNotice } from "../claude-cloud.ts";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CreateTaskInput, ForkTaskInput, HumanEvalInput, PatchTaskInput, taskSummary, SendTaskInput, SetArchivedInput, SetOutcomeInput, SuggestInput, type Task } from "@switchboard/protocol";
import { createdIssuesOf, deferredOf } from "../db.ts";
import { measureFootprint } from "../footprint.ts";
import { skillCommandTitle } from "../suggest-title.ts";
import { evalRequestDraft } from "../evals.ts";
import { ledgerRowFor } from "../pricing.ts";
import { loadProcess } from "../process-defs.ts";
import { otherMachineOf } from "../machine.ts";
import { collectTaskDiff, withSnapshot } from "../taskdiff.ts";
import { runGh } from "../backlog-gh.ts";
import { reduceStops, stopMarks, stopRecordsFor, tasksWithStops } from "../stops.ts";
import { IN_FLIGHT, InvalidTaskOutcomeError, OutcomeNotSettableError } from "../task-status.ts";
import type { DeviceAuthInput } from "../deviceauth.ts";
import type { Routes, ServerContext } from "../server/context.ts";
import { clampLimit } from "./shared.ts";

export function afterSeq(raw: string | null): number {
  const n = raw === null || raw.trim() === "" ? 0 : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** The routes under /api/tasks. */
export function tasksRoutes(sc: Pick<ServerContext, "grantSource" | "db" | "bad" | "json" | "mcp" | "deviceAuths" | "tasks" | "staging" | "adapterMap" | "dangerMode" | "recentCheck" | "attachments" | "metaWorkspace" | "chooseWorkspace" | "opts" | "pricingTable" | "loginKindOf" | "recordProvenance" | "createRouted" | "logOp" | "suggestFor" | "routing" | "taskMcpServers" | "history" | "teleports" | "titling" | "ranElsewhere" | "startTeleport" | "catchUpWithShadow" | "noteMergeGrant" | "screenLook" | "artifacts" | "readJson" | "artifactResult" | "resumer" | "selfdev" | "isMeta" | "evalsFor" | "judgeEvals" | "broadcast" | "applyPolicies">): Routes {
  return {
    "/api/tasks/:id/mcp": {
      GET: (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        if (t.status === "done" || t.status === "error" || t.status === "aborted") return sc.bad("task has ended; its MCP endpoint is revoked", 409);
        return sc.json(sc.mcp.issue(t.id));
      },
    },
    // A Task's approval wait: the kit's `device-auth` puts and deletes it, the screen reads it. The values stay
    // out of every error and log; only a Task whose runner is attached may put one.
    "/api/tasks/:id/device-auth": {
      GET: (req) => (sc.db.getTask(String(req.params.id)) ? sc.json(sc.deviceAuths.get(String(req.params.id))) : sc.bad("not found", 404)),
      POST: async (req) => {
        const id = String(req.params.id);
        if (!sc.db.getTask(id)) return sc.bad("not found", 404);
        const body = ((await req.json().catch(() => ({}))) ?? {}) as DeviceAuthInput;
        // after the body: a runner that ended while it was read has already had its wait cleared
        if (!sc.tasks.isLive(id)) return sc.bad("the task has no running runner", 409);
        try {
          return sc.json(sc.deviceAuths.put(id, body));
        } catch (e) {
          return sc.bad((e as Error).message);
        }
      },
      DELETE: (req) => {
        const id = String(req.params.id);
        if (!sc.db.getTask(id)) return sc.bad("not found", 404);
        sc.deviceAuths.clear(id);
        return sc.json(null);
      },
    },
    "/api/tasks/:id/mcp/rotate": {
      POST: async (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        if (t.status === "done" || t.status === "error" || t.status === "aborted") return sc.bad("task has ended", 409);
        return sc.json(await sc.mcp.rotate(t.id));
      },
    },
    // Staged writes: list, apply (re-checks scope and that the file did not move on), reject.
    // Ownership is checked before anything is touched: a staged id must belong to the task in the URL.
    "/api/tasks/:id/staging": (req) => {
      const t = sc.db.getTask(String(req.params.id));
      if (!t) return sc.bad("not found", 404);
      const status = new URL(req.url).searchParams.get("status");
      // before/after are large; the list carries the diff and stat, the full texts are in the diff already.
  return sc.json(sc.staging.list(t.id).filter((c) => !status || c.status === status).map(({ before: _b, after: _a, ...rest }) => rest));
    },
    "/api/tasks/:id/staging/:sid/apply": {
      POST: (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        const c = sc.db.getStaged(String(req.params.sid));
        if (!c) return sc.bad("staged change not found", 404);
        if (c.taskId !== t.id) return sc.bad("staged change belongs to another task", 403);
        try {
          const applied = sc.staging.apply(c.id, sc.mcp.scopeOf(t));
          return sc.json(applied);
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e), (e as { code?: string }).code === "ECONFLICT" ? 409 : 400);
        }
      },
    },
    "/api/tasks/:id/staging/:sid/reject": {
      POST: (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        const c = sc.db.getStaged(String(req.params.sid));
        if (!c) return sc.bad("staged change not found", 404);
        if (c.taskId !== t.id) return sc.bad("staged change belongs to another task", 403);
        try {
          return sc.json(sc.staging.reject(c.id));
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e));
        }
      },
    },
    "/api/tasks": {
      GET: (req) => {
        const archived = new URL(req.url).searchParams.get("archived") === "1";
        return sc.json(archived ? sc.db.listTasks(true).map(taskSummary) : tasksWithStops(sc.db, sc.db.listTasks(false)));
      },
      POST: async (req, srv) => {
        const parsed = CreateTaskInput.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const cloudWhy = sc.tasks.checkCloudInput(parsed.data);
        if (cloudWhy) return sc.bad(cloudWhy);
        if (parsed.data.executionMode === "cloud" && parsed.data.workspaceId && !sc.db.getWorkspace(parsed.data.workspaceId)) return sc.bad("workspace not found", 404);
        if (parsed.data.cwd !== undefined && !existsSync(parsed.data.cwd)) return sc.bad("cwd must exist");
        const named = parsed.data.workspaceId ? sc.db.getWorkspace(parsed.data.workspaceId) : null;
        if (parsed.data.cwd === undefined && parsed.data.workspaceId && !named) return sc.bad("workspace not found", 404);
        if (parsed.data.cwd === undefined && named && !existsSync(named.path)) return sc.bad("workspace directory does not exist", 409);
        if (parsed.data.executionMode === "cloud" && named) {
          if (!existsSync(named.path)) return sc.bad("workspace directory does not exist", 409);
          if (parsed.data.cwd !== undefined && resolve(parsed.data.cwd) !== resolve(named.path)) return sc.bad("Cloud cwd must match the selected Workspace");
        }
        // scheduleId is meant to be set only by Scheduler.runNow() (it's what makes GET /api/queue's "scheduled"
        // section mean "what ran unattended overnight"); this route is otherwise open, so reject an arbitrary or
        // stale id here rather than silently accepting it and surfacing a misleading schedule title in the queue.
        if (parsed.data.scheduleId !== undefined && !sc.db.getSchedule(parsed.data.scheduleId)) return sc.bad("schedule not found");
        if (parsed.data.permissionMode !== undefined && sc.adapterMap.has(parsed.data.runner)) {
          const why = sc.tasks.checkPermissionMode(parsed.data.runner, parsed.data.permissionMode);
          if (why) return sc.bad(why);
          if (sc.dangerMode(parsed.data.runner, parsed.data.permissionMode)) {
            const refused = await sc.recentCheck(req, srv);
            if (refused) return refused;
          }
        }
        if (parsed.data.effort && sc.adapterMap.has(parsed.data.runner)) {
          const why = sc.tasks.checkEffort(parsed.data.runner, parsed.data.effort);
          if (why) return sc.bad(why);
        }
        // An explicit shadow runner is checked here so the caller learns at once; a saved default that is
        // not detected is skipped with a note on the task instead (the task itself must still start).
        if (parsed.data.shadowRunner) {
          if (parsed.data.shadowRunner === parsed.data.runner) return sc.bad("shadowRunner must differ from runner");
          if (!sc.adapterMap.has(parsed.data.shadowRunner)) return sc.bad(`runner "${parsed.data.shadowRunner}" is not installed`);
        }
        if (parsed.data.attachmentIds?.length) {
          const why = sc.attachments.check(parsed.data.attachmentIds);
          if (why) return sc.bad(why.message, why.status);
        }
        if (parsed.data.process !== undefined) {
          try {
            loadProcess(parsed.data.process, sc.metaWorkspace()?.path);
          } catch (e) {
            return sc.bad(`process not found: ${(e as Error).message ?? e}`);
          }
        }
        try {
          // cwd omitted: the named Workspace's path, or — with no Workspace named either — "自動". The LLM
          // turn comes after every check above and after the runner check, so a request that cannot become a task
          // does not spend a turn first.
          if (!sc.adapterMap.has(parsed.data.runner)) throw new Error(`runner "${parsed.data.runner}" is not installed`);
          const chosen = parsed.data.cwd === undefined && !named ? await sc.chooseWorkspace(parsed.data) : null;
          const settled = chosen ? { ...parsed.data, workspaceId: chosen.workspace.id, cwd: chosen.workspace.path, workspaceReason: chosen.reason } : { ...parsed.data, cwd: parsed.data.cwd ?? named!.path };
          // A skill command on an Issue (`/pbi-complete 123`) is named by the Issue's title at once; a local backlog's numbers are not GitHub's
          const issueTitle = settled.title === undefined && (chosen?.workspace ?? named)?.backlog !== "switchboard" ? await skillCommandTitle(settled.prompt, settled.cwd, sc.opts.gh ?? runGh) : null;
          const input = issueTitle ? { ...settled, title: issueTitle } : settled;
          // What the Workspace choice spent belongs to the task it was asked about, under the runner that answered (not
          // the task's own runner): asking costs quota, and the Ledger is where that has to show up — also when the
          // task's own runner then fails to start, so it is billed as soon as the row exists.
          const bill = (t: Task) => {
            if (chosen) for (const u of chosen.usage) sc.db.insertLedger(ledgerRowFor(sc.pricingTable(), { id: t.id, runner: chosen.runner, model: u.model ?? null }, u, Date.now(), sc.loginKindOf(chosen.runner)));
          };
          const task = input.executionMode === "cloud" ? sc.tasks.create(input, undefined, (t) => { sc.recordProvenance(t, input); bill(t); }) : sc.createRouted(input, bill);
          if (task.permissionMode && sc.adapterMap.get(task.runner)?.permissionModes?.find((m) => m.value === task.permissionMode)?.danger) {
            sc.logOp(req, srv, "task.create.danger", { task: task.id, detail: { runner: task.runner, mode: task.permissionMode } });
          }
          return sc.json(task, 201);
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e), 409);
        }
      },
    },
    // The last stop of each Task that may need the person. Before `/api/tasks/:id`, which would read "stops" as an id.
    "/api/tasks/stops": { GET: () => sc.json(stopMarks(sc.db, sc.db.listTasks(), Date.now())) },
    "/api/tasks/suggest": {
      POST: async (req) => {
        const parsed = SuggestInput.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const input = parsed.data;
        if (input.workspaceId && !sc.db.getWorkspace(input.workspaceId)) return sc.bad("workspace not found", 404);
        const cloudPreparation = input.executionMode === "cloud"
          ? input.cwd || input.workspaceId
            ? readCloudPreparation(input.cwd ?? sc.db.getWorkspace(input.workspaceId!)!.path)
            : { repository: null, branch: null, dirty: null, unpushed: null, warnings: [cloudTransferNotice, "Cloud の開始には Workspace を明示選択してください。"] }
          : undefined;
        return sc.json({ ...sc.suggestFor(input), source: sc.routing.source, problems: sc.routing.problems, ...(cloudPreparation ? { cloudPreparation } : {}) });
      },
    },
    // The events: the last `limit` (200 by default; 0 = none, the rest only), or with ?before=<seq> the `limit` just
    // before that seq. ?after=<seq>: every event past that seq (the web's catch-up after a dropped WebSocket), never cut.
    // The rest is always whole.
    "/api/tasks/:id": {
      GET: (req) => {
      const t = sc.db.getTask(String(req.params.id));
      if (!t) return sc.bad("not found", 404);
      const q = new URL(req.url).searchParams;
      const before = q.has("after") ? null : q.get("before");
      if (before !== null && !(Number.isSafeInteger(Number(before)) && Number(before) > 0)) return sc.bad("before must be a positive integer");
      const limit = q.get("limit") === "0" ? 0 : clampLimit(q.get("limit"));
      const events = q.has("after") ? sc.db.listEvents(t.id, afterSeq(q.get("after"))) : limit === 0 ? [] : before !== null ? sc.db.listEventsBefore(t.id, Number(before), limit) : sc.db.listEventsTail(t.id, limit);
      return sc.json({ task: t, mcpServers: t.runner === "claude" && t.executionMode !== "cloud" ? Object.keys(sc.taskMcpServers(t)) : [], events, cost: sc.db.taskCost(t.id), history: t.executionMode === "cloud" ? null : sc.history.forTask(t.id), localContinuations: sc.db.listLocalTasksForCloud(t.id), sourceCloudTask: t.sourceCloudTaskId ? sc.db.getTask(t.sourceCloudTaskId) : null, attachments: sc.attachments.listForTask(t.id), teleport: sc.teleports.get(t.id) ?? null, stopSummary: reduceStops(stopRecordsFor(sc.db, t)), eventsArchive: sc.db.eventsArchiveOf(t.id), createdIssues: createdIssuesOf(sc.db.sqlite, t.id), deferred: deferredOf(sc.db.sqlite, t.id) });
      },
      // The person renames the task: it is not set again automatically.
      PATCH: async (req) => {
        const parsed = PatchTaskInput.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) return sc.bad(parsed.error.message);
        if (!sc.db.getTask(String(req.params.id))) return sc.bad("not found", 404);
        try {
          const renamed = sc.tasks.rename(String(req.params.id), parsed.data.title);
          sc.titling.delete(renamed.id);
          return sc.json(renamed);
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e), 409);
        }
      },
    },
    // "Continue locally": starts the official Teleport without a terminal socket; progress comes as task.teleport.
    "/api/tasks/:id/teleport": {
      POST: (req) => {
        const id = String(req.params.id);
        if (!sc.db.getTask(id)) return sc.bad("not found", 404);
        const away = sc.ranElsewhere(id);
        if (away) return away;
        const why = sc.startTeleport(id);
        return why ? sc.bad(why, 409) : sc.json({ started: true }, 202);
      },
    },
    "/api/tasks/:id/send": {
      POST: async (req, srv) => {
        const away = sc.ranElsewhere(String(req.params.id));
        if (away) return away;
        const parsed = SendTaskInput.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const { attachmentIds, from } = parsed.data;
        if (!parsed.data.text.trim() && !attachmentIds?.length) return sc.bad("text or attachmentIds required");
        if (attachmentIds?.length) {
          const why = sc.attachments.check(attachmentIds);
          if (why) return sc.bad(why.message, why.status);
        }
        // another Task's words (`from`) reach the runner under a line that says so, and a grant sentence in them is not the person's.
        // Without `from` the daemon cannot tell who sent the text (on loopback a Task reaches this route as the person does):
        // a grant sentence is recorded as the person's only when the request looks like the web UI's, as a bare call's
        // otherwise — a help against a forgotten `from` and a relayed text, not a boundary (merge-grants.ts)
        const text = from ? `（Task ${from} からの返信）\n\n${parsed.data.text}` : parsed.data.text;
        try {
          sc.catchUpWithShadow(String(req.params.id)); // a terminal turn that just finished goes in before this one
          await sc.noteMergeGrant(String(req.params.id), parsed.data.text, await sc.grantSource(req, srv, from));
          return sc.json(await sc.tasks.send(String(req.params.id), text, { attachmentIds }));
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e), 409);
        }
      },
    },
    // Artifacts: reports registered from the Task screen. Register copies the file; the original may go.
    "/api/tasks/:id/artifacts": {
      GET: (req) => (sc.db.getTask(String(req.params.id)) ? sc.json(sc.artifacts.list(String(req.params.id))) : sc.bad("not found", 404)),
      POST: async (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        const body = await sc.readJson(req, (x) => x as { source?: unknown; title?: unknown });
        if (typeof body.source !== "string" || !body.source.trim()) return sc.bad("source (a path or an http(s) URL) required");
        return sc.artifactResult(() => sc.json(sc.artifacts.add(t, { source: body.source as string, title: typeof body.title === "string" ? body.title : undefined }), 201));
      },
    },
    "/api/tasks/:id/permission": {
      POST: async (req) => {
        const away = sc.ranElsewhere(String(req.params.id));
        if (away) return away;
        const body = await sc.readJson(req, (x) => x as { id?: string; decision?: "allow" | "deny" });
        if (!body.id || (body.decision !== "allow" && body.decision !== "deny")) return sc.bad("id and decision required");
        try {
          return sc.json(sc.tasks.respondPermission(String(req.params.id), body.id, body.decision));
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e), 409);
        }
      },
    },
    "/api/tasks/:id/abort": {
      POST: async (req) => sc.ranElsewhere(String(req.params.id)) ?? sc.json(await sc.tasks.abort(String(req.params.id))),
    },
    // Provenance (docs/design/process-kernel.md, K1): what the task was started with; null for a task from before it was recorded.
    "/api/tasks/:id/provenance": {
      GET: (req) => {
        const id = String(req.params.id);
        if (!sc.db.getTask(id)) return sc.bad("not found", 404);
        return sc.json(sc.db.getTaskProvenance(id));
      },
    },
    // Usage-limit resume: continue now instead of waiting, or forget the planned resume.
    "/api/tasks/:id/resume": {
      POST: async (req, srv) => {
        if (!sc.db.getTask(String(req.params.id))) return sc.bad("not found", 404);
        const away = sc.ranElsewhere(String(req.params.id));
        if (away) return away;
        const parsed = SendTaskInput.pick({ text: true }).safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) return sc.bad(parsed.error.message);
        try {
          const resumed = await sc.resumer.resumeNow(String(req.params.id), parsed.data.text);
          // a note is words to the task as a reply is: a grant in it is recorded the same way (the screen's, or a bare call's)
          await sc.noteMergeGrant(resumed.id, parsed.data.text, await sc.grantSource(req, srv));
          return sc.json(resumed);
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e), 409);
        }
      },
      DELETE: (req) => {
        if (!sc.db.getTask(String(req.params.id))) return sc.bad("not found", 404);
        return sc.json(sc.resumer.cancel(String(req.params.id)));
      },
    },
    // Change the mode of an existing task: live for Claude, next turn for Codex, resume otherwise.
    "/api/tasks/:id/permission-mode": {
      POST: async (req, srv) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        const away = sc.ranElsewhere(t.id);
        if (away) return away;
        const body = await sc.readJson(req, (x) => x as { mode?: unknown });
        if (typeof body.mode !== "string" || !body.mode) return sc.bad("mode required");
        const why = sc.tasks.checkPermissionMode(t.runner, body.mode);
        if (why) return sc.bad(why);
        if (sc.dangerMode(t.runner, body.mode)) {
          const refused = await sc.recentCheck(req, srv);
          if (refused) return refused;
        }
        try {
          return sc.json(await sc.tasks.setPermissionMode(t.id, body.mode));
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e), 409);
        }
      },
    },
    // Change the model of an existing task: the next turn resumes the session with it. null / "" = CLI default.
    "/api/tasks/:id/model": {
      POST: async (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        const away = sc.ranElsewhere(t.id);
        if (away) return away;
        const model = (await sc.readJson(req, (x) => x as { model?: unknown } | null))?.model;
        if (model !== null && typeof model !== "string") return sc.bad("model must be a string or null");
        try {
          return sc.json(await sc.tasks.setModel(t.id, model?.trim() || null));
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e), 409);
        }
      },
    },
    "/api/tasks/:id/effort": {
      POST: async (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        const away = sc.ranElsewhere(t.id);
        if (away) return away;
        const effort = (await sc.readJson(req, (x) => x as { effort?: unknown } | null))?.effort;
        if (effort !== null && typeof effort !== "string") return sc.bad("effort must be a string or null");
        const wanted = effort?.trim() || null;
        if (wanted) {
          const why = sc.tasks.checkEffort(t.runner, wanted);
          if (why) return sc.bad(why);
        }
        try {
          return sc.json(await sc.tasks.setEffort(t.id, wanted));
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e), 409);
        }
      },
    },
    "/api/tasks/:id/checks": {
      GET: (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        const run = sc.selfdev.last(t.id);
        return sc.json({ run, running: sc.selfdev.isRunning(t.id), meta: sc.isMeta(t), current: sc.selfdev.isCurrent(run) });
      },
      // Starts (or queues) a run and returns at once; checks.updated announces the result.
      POST: (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        // a Task of another machine is only read here: this machine's checkout says nothing about its work, and a
        // run here would write over the result that came in with it
        const away = sc.ranElsewhere(t.id);
        if (away) return away;
        if (!sc.isMeta(t)) return sc.bad("checks run only for tasks on the meta workspace (this repository)", 400);
        void sc.selfdev.run(t.id).catch(() => undefined);
        return sc.json({ run: sc.selfdev.last(t.id), running: true, meta: true, current: false }, 202);
      },
    },
    "/api/tasks/:id/diff": async (req) => {
      const t = sc.db.getTask(String(req.params.id));
      if (!t) return sc.bad("not found", 404);
      // a Task of another machine names paths of that machine: the same paths here are this machine's own files, and
      // are not read as the Task's changes. Only what came in with the Task (its snapshot) is shown.
      if (otherMachineOf(t)) return sc.json(withSnapshot([], sc.db.getTaskDiffSnapshot(t.id)));
      try {
        return sc.json(withSnapshot(await collectTaskDiff(t, sc.db.listEvents(t.id), sc.staging.list(t.id)), sc.db.getTaskDiffSnapshot(t.id)));
      } catch (e) {
        return sc.bad(String((e as Error).message ?? e), 500);
      }
    },
    "/api/tasks/:id/footprint": async (req) => {
      const t = sc.db.getTask(String(req.params.id));
      if (!t) return sc.bad("not found", 404);
      // the scope of a Task of another machine is that machine's folders: nothing here is measured as it
      return sc.json(await measureFootprint(otherMachineOf(t) ? [] : t.scope));
    },
    "/api/tasks/:id/budget": {
      POST: async (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        const body = await sc.readJson(req, (x) => x as { budgetUsd?: unknown });
        const b = body.budgetUsd;
        if (b !== null && (typeof b !== "number" || !Number.isFinite(b) || b <= 0)) return sc.bad("budgetUsd must be a positive number or null");
        return sc.json({ task: sc.tasks.setBudget(t.id, b), overBudget: sc.tasks.isOverBudget(t.id) });
      },
    },
    "/api/tasks/:id/evals": (req) => {
      const t = sc.db.getTask(String(req.params.id));
      if (!t) return sc.bad("not found", 404);
      return sc.json(sc.evalsFor(t));
    },
    // 改善要望にする: the draft the feedback dialog opens with; the person edits and sends it through /api/feedback.
    "/api/tasks/:id/evals/draft": (req) => {
      const t = sc.db.getTask(String(req.params.id));
      if (!t) return sc.bad("not found", 404);
      return sc.json({ text: evalRequestDraft(t, sc.evalsFor(t)) });
    },
    // 再評価: scores the task as it stands now, in the background; the result arrives as evals.updated. Works even with the automatic judge off.
    "/api/tasks/:id/evals/judge": {
      POST: (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        if (t.executionMode === "cloud") return sc.bad("Cloud の Task は評価しません", 409);
        if (IN_FLIGHT.has(t.status)) return sc.bad("ターン中は判定しません", 409);
        if (t.status === "idle" || sc.db.firstUserText(t.id) === null) return sc.bad("まだ会話がありません", 409);
        sc.judgeEvals(t.id, t);
        return sc.json({ queued: true }, 202);
      },
    },
    // The person's own rating: optional, one per task, replaced on every PUT; never touches the task row itself.
    "/api/tasks/:id/evals/human": {
      PUT: async (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        const parsed = HumanEvalInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const ts = Date.now();
        sc.db.upsertEval({ taskId: t.id, source: "human", by: "user", rubric: null, json: { ...parsed.data, by: "user", ts }, ts });
        sc.broadcast({ type: "evals.updated", taskId: t.id });
        return sc.json(sc.evalsFor(t));
      },
      DELETE: (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        sc.db.deleteEval(t.id, "human");
        sc.broadcast({ type: "evals.updated", taskId: t.id });
        return sc.json(sc.evalsFor(t));
      },
    },
    "/api/tasks/:id/outcome": {
      POST: async (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        const parsed = SetOutcomeInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        try {
          const task = sc.tasks.setOutcome(t.id, parsed.data);
          // an outcome of 要対応 is what makes a Task's check a question
          void sc.applyPolicies();
          return sc.json({ task });
        } catch (e) {
          // only a refusal of the outcome is a conflict; anything else (the database, a bug) stays a server error
          if (e instanceof OutcomeNotSettableError || e instanceof InvalidTaskOutcomeError) return sc.bad(e.message, 409);
          throw e;
        }
      },
    },
    "/api/tasks/:id/archive": {
      POST: async (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        const parsed = SetArchivedInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        try {
          return sc.json(sc.tasks.setArchived(t.id, parsed.data.archived));
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e), 409);
        }
      },
    },
    // Fork: a new Task that continues this one's conversation up to a finished turn. Nothing starts until its first reply.
    "/api/tasks/:id/fork": {
      POST: async (req) => {
        const t = sc.db.getTask(String(req.params.id));
        if (!t) return sc.bad("not found", 404);
        const away = sc.ranElsewhere(t.id);
        if (away) return away;
        const parsed = ForkTaskInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        try {
          return sc.json(sc.tasks.forkTask(t.id, parsed.data.seq), 201);
        } catch (e) {
          return sc.bad(String((e as Error).message ?? e));
        }
      },
    },
  };
}
