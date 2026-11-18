import { personWait, PresetExpandInput, PresetInput, type Preset, type PresetExpansion, type PresetList } from "@switchboard/protocol";
import { backlogRepoOf, runGh } from "../backlog-gh.ts";
import { lastStopMark } from "../stops.ts";
import { checkPreset, expandPreset, needsTarget, parseTarget, presetUses, readPresets, recordPresetUse, writePresets } from "../presets.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** The routes under /api/presets. */
export function presetsRoutes(sc: Pick<ServerContext, "db" | "json" | "bad" | "opts">): Routes {
  return {
    /**
     * Saved instructions. Expanding builds the text to put in the request / reply box; with a `scene` it also
     * records the use (docs/design/presets.md, "Usage record"). It creates no Task and sends nothing: the Task is
     * created or the reply sent by POST /api/tasks / send as before, approval and all.
     */
    "/api/presets": {
      GET: () => {
        const presets = readPresets(sc.db).sort((a, b) => b.updatedAt - a.updatedAt);
        return sc.json({ presets, uses: presetUses(sc.db, presets, Date.now()) } satisfies PresetList);
      },
      POST: async (req) => {
        const parsed = PresetInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const list = readPresets(sc.db);
        const refused = checkPreset(parsed.data, list);
        if (refused) return sc.bad(refused.error, refused.status);
        const now = Date.now();
        const p: Preset = { ...parsed.data, id: `pre_${crypto.randomUUID().slice(0, 12)}`, createdAt: now, updatedAt: now };
        writePresets(sc.db, [...list, p]);
        return sc.json(p, 201);
      },
    },
    "/api/presets/:id": {
      PATCH: async (req) => {
        const parsed = PresetInput.partial().strict().safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const list = readPresets(sc.db);
        const p = list.find((x) => x.id === String(req.params.id));
        if (!p) return sc.bad("not found", 404);
        const next: Preset = { ...p, ...parsed.data, updatedAt: Date.now() };
        const refused = checkPreset(next, list.filter((x) => x.id !== p.id));
        if (refused) return sc.bad(refused.error, refused.status);
        writePresets(sc.db, list.map((x) => (x.id === p.id ? next : x)));
        return sc.json(next);
      },
      DELETE: (req) => {
        const list = readPresets(sc.db);
        if (!list.some((x) => x.id === String(req.params.id))) return sc.bad("not found", 404);
        writePresets(sc.db, list.filter((x) => x.id !== String(req.params.id)));
        return sc.json({ ok: true });
      },
    },
    "/api/presets/:id/expand": {
      POST: async (req) => {
        const parsed = PresetExpandInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const p = readPresets(sc.db).find((x) => x.id === String(req.params.id));
        if (!p) return sc.bad("not found", 404);
        const ws = parsed.data.workspaceId ? sc.db.getWorkspace(parsed.data.workspaceId) : null;
        if (parsed.data.workspaceId && !ws) return sc.bad("workspace not found", 404);
        const task = parsed.data.taskId ? sc.db.getTask(parsed.data.taskId) : null;
        if (parsed.data.taskId && !task) return sc.bad("task not found", 404);
        const raw = parsed.data.target?.trim() ?? "";
        const done = (x: PresetExpansion) => {
          // the kind of question this answers: the reason of the Task's last stop, only while that stop still waits on
          // the person (a reply to a Task back at work, or to a stop already resolved, answers no question)
          const last = task && personWait(task) !== "none" ? lastStopMark(sc.db.listStopRecords([task.id])) : null;
          const kind = last && last.state !== "resolved" ? last.reason : null;
          recordPresetUse(sc.db, p.id, parsed.data.scene, Date.now(), kind);
          return sc.json(x);
        };
        if (!needsTarget(p)) return raw ? sc.bad("この指示は対象を使いません。対象を空にしてください") : done(expandPreset(p, null, null));
        if (!raw) return sc.bad("対象の Issue / PR を入れてください");
        if (!ws) return sc.bad("Workspace を選んでください");
        const target = parseTarget(raw);
        if (!target) return sc.bad(`対象の書き方が分かりません: ${raw.slice(0, 100)}（#12 / owner/name#12 / URL）`);
        let repo: string;
        try {
          repo = (await backlogRepoOf(sc.opts.gh ?? runGh, ws.path)).repo;
        } catch (e) {
          return sc.bad(`Workspace ${ws.name} のリポジトリを読めません: ${String((e as Error).message ?? e).slice(0, 200)}`, 424);
        }
        if (target.repo && target.repo.toLowerCase() !== repo.toLowerCase()) return sc.bad(`対象 ${target.repo}#${target.number} は Workspace ${ws.name} のリポジトリ ${repo} ではありません`, 409);
        return done(expandPreset(p, repo, target.number));
      },
    },
  };
}
