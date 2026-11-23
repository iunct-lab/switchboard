import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { BacklogAnswerInput, BacklogCommentInput, BacklogCreateInput, BacklogEditInput, BacklogQueueInput, BacklogStartInput, BacklogSyncInput, RequestEvalInput, type RequestEval, type BacklogAllocation } from "@switchboard/protocol";
import type { Db } from "../db.ts";
import { sameOrigin } from "../auth.ts";
import { githubOutage, outageRefusal } from "../forge-outage.ts";
import { landedTip } from "../landing.ts";
import { noticeTargets } from "../backlog-sync.ts";
import { heldLine } from "../lease.ts";
import { applyLocalOperations, branchTip, checkFieldChoices, checkLocalChange, checkLocalFields, checkLocalParent, localProjectFields } from "../backlog-local.ts";
import { savedConfigFile } from "../workspace-config.ts";
import { readProjectFields } from "../backlog-send.ts";
import { readQueue, saveQueue } from "../backlog-queue.ts";
import { ACTION_FOR_STAGE } from "../backlog-item.ts";
import { checkFieldTypes, answerStoredConfirmation, answerStoredDecision, setAnswerHeads, BacklogEditError, createStoredIssue, editStoredIssue, resolveStoredConflict, retryStoredOperation, cancelStoredOperation, withdrawStoredOperation, commentStoredIssue } from "../backlog-edit.ts";
import { changeSourceOf, changesApart, syncsGithub, runGh } from "../backlog-gh.ts";
import { readStoredIssue, readStoredRecords, storedIssueReader, canStartStoredBacklog } from "../backlog-stored.ts";
import { overlapLine, isOverlapped } from "../backlog-overlap.ts";
import type { Routes, ServerContext } from "../server/context.ts";

/** GitHub's `sha256=<hex>` signature of the delivery body under the Webhook's Secret; no signature or another length is false. */
export function webhookSigned(body: Uint8Array, header: string | null, secret: string): boolean {
  if (!secret || !header) return false;
  const want = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === want.length && timingSafeEqual(given, want);
}

/** `?after=<seq>` of GET /api/tasks/:id: a positive whole seq, else 0 (= every event), like ?days= falling back instead of a 400. */
/** The request a request evaluation is written for: a stored `type:request` Issue of a registered workspace; null = there is none. */
export function requestEvalTarget(db: Db, workspaceId: string | null, raw: string): { workspaceId: string; number: number } | null {
  const ws = workspaceId ? db.getWorkspace(workspaceId) : null;
  const number = Number(raw);
  if (!ws || !Number.isSafeInteger(number) || number <= 0) return null;
  return storedIssueReader(db).issue(ws.id, number)?.labels.includes("type:request") ? { workspaceId: ws.id, number } : null;
}

/** The routes under /api/backlog. */
export function backlogRoutes(sc: Pick<ServerContext, "callingTask" | "grantSource" | "answerGrantHeads" | "pendingGrantHeads" | "stopForRefusedProceed" | "json" | "readBacklog" | "bad" | "db" | "backlog" | "readCapped" | "WEBHOOK_MAX_BYTES" | "cfg" | "UPSTREAM_FAILED" | "backlogReads" | "syncEntry" | "lightBacklog" | "storedBacklog" | "storedBacklogReleased" | "prunedQueue" | "queuedIssues" | "onQueueSaved" | "readFlowLimit" | "readAllocation" | "issueRef" | "opts" | "readJson" | "leaseRepository" | "leases" | "DEVELOP_SELF_OFF" | "metaWorkspace" | "adapterMap" | "activeStageTask" | "startStage">): Routes {
  return {
    /**
     * Open requests and PBIs of every registered workspace's repository and the stage each is at, as the
     * last import stored them: no GitHub call, no wait. A workspace never imported is in `errors` (its import is
     * asked for, see `storedBacklog`); one whose import failed keeps its stored items and has the reason there. ?refresh=1 (the screen's 再読込) imports
     * every workspace first and answers what is stored then — a failed import (a limit, an outage) still answers the
     * stored copy, with the reason.
     */
    "/api/backlog": {
      GET: async (req) => sc.json(await sc.readBacklog(new URL(req.url).searchParams.get("refresh") === "1")),
      /** A new Issue in the workspace's repository: stored here (202, its `localId` and `number`) and created on GitHub later. */
      POST: async (req) => {
        const parsed = BacklogCreateInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const { workspaceId, ...input } = parsed.data;
        const source = sc.db.getWorkspaceBacklogSource(workspaceId);
        if (!sc.db.getWorkspace(workspaceId)) return sc.bad("workspace not found", 404);
        if (!source) return sc.bad("まだ GitHub から取り込んでいません", 409);
        try {
          // a local change: its branches are read in the workspace's checkout. It is kept apart from a service's
          // Issues (changeSourceOf), decided at once there and never sent
          if (input.change) {
            const kept = changeSourceOf(sc.db, workspaceId)!;
            if (input.change.pr !== undefined && !changesApart(source)) return sc.bad("PR の無い workspace です（pr は付けられません）", 422);
            if (changesApart(source)) {
              if (input.parent !== null || input.fields || input.milestone !== null) return sc.bad("変更に親・フィールド・マイルストーンは付けられません", 422);
              // a change that stands in for a pull request is made only while the daemon itself sees GitHub out of use for
              // now (its own wait, or its own call just now): never on the caller's word, and never for a login or
              // permission failure, which waiting does not mend (forge-outage.ts)
              if (source.service !== "github") return sc.bad("PR の代わりのローカルの変更は GitHub の workspace だけです", 422);
              const outage = await githubOutage({ gh: sc.opts.gh ?? runGh, waitUntil: sc.backlog.waitUntil({ id: workspaceId }) }, sc.db.getWorkspace(workspaceId)!.path);
              if (!outage.unusable) return sc.bad(outageRefusal(outage), 409);
              checkLocalChange(sc.db, kept, sc.db.getWorkspace(workspaceId)!.path, input.change);
              const made = createStoredIssue(sc.db, kept, input);
              applyLocalOperations(sc.db, kept);
              return sc.json({ ...made, number: readStoredIssue(sc.db, { id: workspaceId }, made.localId, { source: kept })?.issue.number || null }, 202);
            }
            checkLocalChange(sc.db, source, sc.db.getWorkspace(workspaceId)!.path, input.change);
          }
          // a backlog kept here only has no service to refuse a parent that is not there, and its fields take
          // the choices of the workspace's ops.config.json
          if (!syncsGithub(source)) {
            checkLocalParent(sc.db, source, input.parent);
            input.fields = checkLocalFields(sc.db.getWorkspace(workspaceId)!.path, input, savedConfigFile(workspaceId)) ?? null;
          } else if (source.service === "github") {
            // a choice is fixed to the config's spelling or refused before it is stored
            input.fields = checkFieldChoices(sc.db.getWorkspace(workspaceId)!.path, input.fields, savedConfigFile(workspaceId)) ?? null;
          }
          const made = createStoredIssue(sc.db, source, input);
          sc.backlog.send(sc.db.getWorkspace(workspaceId)!);
          // a backlog kept here only numbers it at once; GitHub's numbers it once it is sent (null until then)
          const number = readStoredIssue(sc.db, { id: workspaceId }, made.localId)?.issue.number || null;
          return sc.json({ ...made, number }, 202);
        } catch (e) {
          if (e instanceof BacklogEditError) return sc.bad(e.message, e.status);
          throw e;
        }
      },
    },
    /**
     * A GitHub Webhook delivery: open without the token (GitHub cannot carry it) once the user opened it
     * (`cfg.githubWebhook` and `cfg.githubWebhookSecret`; else the token is asked as anywhere). The delivery must carry
     * X-Hub-Signature-256, the HMAC-SHA256 of the body under the Secret; a missing or wrong one is 401 and
     * starts nothing. It is only a notice — the
     * workspaces of the repository / Project it names are imported (BacklogSync.hint: at most one per minute each,
     * ten in all), and nothing of the payload is stored or followed. The body is read up to 64 KiB. The answer is the
     * same whether it named any (nothing about what is registered is told). The cloud host's edge check still applies.
     */
    "/api/backlog/webhooks/github": {
      POST: async (req) => {
        if (!sameOrigin(req)) return sc.bad("cross-origin request refused", 403);
        const body = await sc.readCapped(req, sc.WEBHOOK_MAX_BYTES);
        if (body === null) return sc.bad("too large", 413);
        if (!webhookSigned(body, req.headers.get("x-hub-signature-256"), sc.cfg.githubWebhookSecret ?? "")) return sc.bad("signature does not match", 401);
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder().decode(body));
        } catch {
          return sc.bad("not JSON", 400);
        }
        const all = sc.db.listWorkspaces();
        const targets = new Set(noticeTargets(payload, all.map((w) => ({ id: w.id, source: sc.db.getWorkspaceBacklogSource(w.id) }))));
        for (const ws of all) if (targets.has(ws.id) && existsSync(ws.path)) sc.backlog.hint(ws);
        return sc.json({ accepted: true }, 202);
      },
    },
    /**
     * Brings one workspace's stored backlog up to date (the kit's `backlog … --fresh`): what is kept here is sent,
     * then the repository is imported (`BacklogSync.settle`). 200 once stored (read it then with GET); 424 with the reason when GitHub cannot be
     * read now (a limit, an outage) — the kit then answers what is stored, said to be not synced.
     */
    "/api/backlog/sync": {
      POST: async (req) => {
        const parsed = BacklogSyncInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const ws = sc.db.getWorkspace(parsed.data.workspaceId);
        if (!ws) return sc.bad("workspace not found", 404);
        if (!existsSync(ws.path)) return sc.bad("workspace directory does not exist", 409);
        try {
          const timings = await sc.backlog.settle(ws);
          return sc.json({ workspaceId: ws.id, timings });
        } catch (e) {
          return sc.bad((e as Error).message, sc.UPSTREAM_FAILED);
        }
      },
    },
    /**
     * Only the `syncs` of GET /api/backlog: each workspace's id, repository and sync state, with no record read
     * (the kit looks its workspace up by it before every command). Same rows, so a workspace never imported has its
     * import asked for here too (`storedBacklog`).
     */
    "/api/backlog/syncs": {
      GET: () => sc.json({ syncs: sc.db.listWorkspaces().filter((ws) => sc.backlogReads(ws) && existsSync(ws.path)).map((ws) => sc.syncEntry(ws, sc.lightBacklog(ws))) }),
    },
    /**
     * The stored records of one workspace: what the kit's lint and parallel guard read instead of asking GitHub
     * (`readStoredRecords`). 409 = never imported (nothing is read as current); bring it up to date with POST /sync first.
     */
    /**
     * Whether GitHub cannot be used for now for a workspace whose Issues are GitHub's, as the daemon observes it
     * (forge-outage.ts): what a local change may be made for, and what scripts/local-merge.ts asks before it merges one.
     * A workspace that keeps its changes itself by design is not asked about (`apart: false`).
     */
    "/api/backlog/outage": {
      GET: async (req) => {
        const ws = sc.db.getWorkspace(new URL(req.url).searchParams.get("workspaceId") ?? "");
        if (!ws) return sc.bad("workspace not found", 404);
        const source = sc.db.getWorkspaceBacklogSource(ws.id);
        if (!changesApart(source)) return sc.json({ apart: false });
        if (source!.service !== "github") return sc.json({ apart: true, unusable: false, reason: "unknown", detail: "GitHub の workspace でない" });
        return sc.json({ apart: true, ...(await githubOutage({ gh: sc.opts.gh ?? runGh, waitUntil: sc.backlog.waitUntil(ws) }, ws.path)) });
      },
    },
    "/api/backlog/records": {
      GET: async (req) => {
        const ws = sc.db.getWorkspace(new URL(req.url).searchParams.get("workspaceId") ?? "");
        if (!ws) return sc.bad("workspace not found", 404);
        const records = readStoredRecords(sc.db, ws);
        // the places the app's own overlap judgement counts: the guard in a Task yields to the same ones. Read with the
        // release's answers as the start reads them (storedBacklogReleased): without them a PBI waiting on a （リリース）
        // prerequisite holds no place, a place it kept out comes back, and the guard stops what the app just started
        // `unheld`: the PBIs whose claim the app does not count as work (a stage Task that ended left it); the guard counts the same
        const read = records ? await sc.storedBacklogReleased(ws) : null;
        return records ? sc.json({ ...records, turns: read?.turns ?? [], unheld: read?.unheld ?? [] }) : sc.bad("まだ GitHub から取り込んでいません", 409);
      },
    },
    /**
     * The backlog queue: the PBIs to implement, in the order the person chose, kept in the daemon. GET drops the
     * PBIs whose stored Issue is closed (to `ended`, stored); PUT changes the fields it names (400 when one does
     * not parse) and answers the queue as stored.
     */
    "/api/backlog/queue": {
      GET: () => sc.json(sc.prunedQueue()),
      PUT: async (req) => {
        const parsed = BacklogQueueInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        // read and written with no wait between, so two requests do not write over each other
        const before = readQueue(sc.db);
        const issueOf = sc.queuedIssues();
        const queue = saveQueue(sc.db, parsed.data, (e) => issueOf(e)?.title ?? null);
        sc.onQueueSaved(before, queue);
        return sc.json(queue);
      },
    },
    /**
     * Each workspace's share, mode, actual part of the week's spend and shortfall, and the flow-improvement part
     * against its limit, with where the window begins. A route of its own: `GET /api/workspaces` is read at every change.
     */
    "/api/backlog/allocation": {
      GET: () => {
        return sc.readFlowLimit().then((flowLimit) => sc.json({ ...sc.readAllocation(), flowLimit } satisfies BacklogAllocation));
      },
    },
    /**
     * One stored Issue: body, comments and the Project's fields as shown (with the edits not sent yet),
     * without asking GitHub. `:number` is its number, or the local id of an Issue made here. 404 = not stored.
     */
    "/api/backlog/:number": {
      GET: (req) => {
        const ws = sc.db.getWorkspace(new URL(req.url).searchParams.get("workspaceId") ?? "");
        if (!ws) return sc.bad("workspace not found", 404);
        // ?change=1: the workspace's local change of that number, not the Issue (they are numbered apart where the Issues are a service's)
        const asChange = new URL(req.url).searchParams.get("change") === "1";
        const detail = readStoredIssue(sc.db, ws, sc.issueRef(req.params.number ?? ""), { importFailed: sc.backlog.importError(ws) !== null, ...(asChange ? { source: changeSourceOf(sc.db, ws.id) } : {}) });
        if (!detail || (asChange && !detail.issue.change)) return sc.bad(asChange ? `変更 #${req.params.number} は保存されていません` : `#${req.params.number} は保存されていません`, 404);
        // a local change's tips, read now: they move with every commit and are not kept
        const change = detail.issue.change;
        const source = sc.db.getWorkspaceBacklogSource(ws.id);
        const projectFields = source && !syncsGithub(source) ? localProjectFields(ws.path, savedConfigFile(ws.id)) : detail.projectFields;
        // the base a change is judged and merged on: the branch, or where the local merges of it landed (landing.ts)
        return sc.json({ ...detail, projectFields, changeRefs: change ? { head: branchTip(ws.path, change.head), base: landedTip(ws.path, change.base)?.sha ?? null } : null });
      },
      /**
       * Edits it: stored here at once (202, the operations) and sent to GitHub later. Or, with `resolve` alone,
       * a choice on a held conflict: 202 with the operation, 409 when none is held there or it moved since read.
       * With `retry` alone, a failed operation of the Issue sent again: 202, 409 when it is not a failed one of it.
       * With `cancel` alone, a comment still inside its 60 s send window taken back: 202, 409 when it is past it or not one.
       * With `withdraw` alone, an `unknown` / `failed` operation of it taken back, nothing sent: 202, 409 likewise.
       */
      PATCH: async (req) => {
        const parsed = BacklogEditInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const { workspaceId, ...input } = parsed.data;
        if (!sc.db.getWorkspace(workspaceId)) return sc.bad("workspace not found", 404);
        const source = sc.db.getWorkspaceBacklogSource(workspaceId);
        if (!source) return sc.bad("まだ GitHub から取り込んでいません", 409);
        try {
          const { resolve, retry, cancel, withdraw, ...edit } = input;
          // ?change=1: the edit is of the workspace's local change of that number. Where the changes are kept apart
          // from a service's Issues it is decided there at once and nothing is sent
          const asChange = new URL(req.url).searchParams.get("change") === "1";
          if (asChange && changesApart(source)) {
            const kept = changeSourceOf(sc.db, workspaceId)!;
            const ref = sc.issueRef(req.params.number ?? "");
            if (resolve || retry || cancel || withdraw || edit.parent !== undefined || edit.fields || edit.project !== undefined || edit.milestone !== undefined) return sc.bad("変更に送れるのは題・本文・状態・ラベル・マージの記録だけです", 422);
            if (!readStoredIssue(sc.db, { id: workspaceId }, ref, { source: kept })?.issue.change) return sc.bad(`変更 #${req.params.number} は保存されていません`, 404);
            const edited = editStoredIssue(sc.db, kept, ref, edit);
            applyLocalOperations(sc.db, kept);
            return sc.json(edited, 202);
          }
          if (edit.change && source.service !== "switchboard") return sc.bad("変更の編集は change=1 を付けて送ります", 422);
          if (!syncsGithub(source)) {
            // the Issue's own number, whether named by it or by its local id
            checkLocalParent(sc.db, source, edit.parent, readStoredIssue(sc.db, { id: workspaceId }, sc.issueRef(req.params.number ?? ""))?.issue.number);
            edit.fields = checkLocalFields(sc.db.getWorkspace(workspaceId)!.path, edit, savedConfigFile(workspaceId));
          } else if (source.service === "github" && edit.fields && !resolve && !retry && !cancel && !withdraw) {
            edit.fields = checkFieldChoices(sc.db.getWorkspace(workspaceId)!.path, edit.fields, savedConfigFile(workspaceId));
            const fixed = edit.fields!;
            // a value that does not fit its field is refused before it is stored; GitHub out of reach (or waited
            // for: nothing is asked of it meanwhile, docs/design/github-api-budget.md) stores it, the send checks last
            const defs = sc.backlog.waitUntil({ id: workspaceId }) > Date.now() ? null : await readProjectFields(sc.opts.gh ?? runGh, sc.db, sc.db.getWorkspace(workspaceId)!.path, source).catch(() => null);
            if (defs) checkFieldTypes(defs, fixed);
          }
          const ref = sc.issueRef(req.params.number ?? "");
          const edited = resolve ? resolveStoredConflict(sc.db, source, ref, resolve) : retry ? retryStoredOperation(sc.db, source, ref, retry.operation) : cancel ? cancelStoredOperation(sc.db, source, ref, cancel.operation) : withdraw ? withdrawStoredOperation(sc.db, source, ref, withdraw) : editStoredIssue(sc.db, source, ref, edit);
          sc.backlog.send(sc.db.getWorkspace(workspaceId)!);
          return sc.json(edited, 202);
        } catch (e) {
          if (e instanceof BacklogEditError) return sc.bad(e.message, e.status);
          throw e;
        }
      },
    },
    /**
     * Answers a needs-decision item: `## 回答` on the Issue, then its label off — stored here at once (202) and
     * sent to GitHub in that order, so an answer is not lost while GitHub cannot be reached. With `confirm`,
     * answers one confirmation of an in-progress PBI instead (`answerStoredConfirmation`).
     */
    "/api/backlog/:number/answer": {
      POST: async (req, srv) => {
        const parsed = BacklogAnswerInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const ws = sc.db.getWorkspace(parsed.data.workspaceId);
        if (!ws) return sc.bad("workspace not found", 404);
        if (!existsSync(ws.path)) return sc.bad("workspace directory does not exist", 409);
        const n = Number(req.params.number);
        const stored = sc.storedBacklog(ws);
        if (stored.fetchedAt === null) return sc.bad(stored.error ?? "まだ GitHub から取り込んでいません", sc.UPSTREAM_FAILED);
        const source = sc.db.getWorkspaceBacklogSource(ws.id)!;
        const item = stored.items.find((i) => i.number === n);
        if (!item) return sc.bad(`#${req.params.number} はバックログにありません`, 404);
        const { confirm } = parsed.data;
        try {
          if (confirm) {
            // a confirmation of an in-progress PBI: that line of its body as stored, the body it is sent with
            const c = item.confirmations.find((x) => x.n === confirm.n);
            if (!c) return sc.bad(`#${n} に確認待ちの受け入れ条件 ${confirm.n} はありません`, 409);
            if (!answerStoredConfirmation(sc.db, source, n, { ...c, ok: confirm.ok, reason: parsed.data.text })) return sc.bad(`#${n} の本文が変わりました。再読込してください`, 409);
            sc.backlog.send(ws);
            return sc.json({ ok: true }, 202);
          }
          if (item.stage !== "needs-decision") return sc.bad(`#${n} は判断待ちではありません`, 409);
          // a question asked on one of an in-progress PBI's Tasks is answered on that Task, the one on screen only
          const asked = item.decision?.issue ?? n;
          if (parsed.data.issue !== undefined && parsed.data.issue !== asked) return sc.bad(`#${n} の問いは #${asked} に変わりました。読み直してから回答してください`, 409);
          // the person's words to the next stage Task (and a grant sentence in them) only when the request came in as the
          // screen's: one that names a sending Task, or a bare call, still answers the question — as that Task's / a call's
          const by = await sc.grantSource(req, srv, parsed.data.from);
          // the question answered: the one that was on screen (`at`), else the newest now (the kit's call names none).
          // Whether it can still be answered is checked where the answer is kept (`answerStoredDecision`), with nothing awaited in between
          const at = parsed.data.at ?? item.decision?.at;
          const question = at === undefined ? undefined : { at };
          const { text } = parsed.data;
          if (by.via === "screen") {
            // a grant sentence in the screen's answer is for the PR as it is when the answer is taken. The answer is kept
            // first, each such PR with no head; the heads are read after the reply and put with the answer. One not read,
            // or read after a stage Task took the answer, stays without a head: the grant then answers for none
            const operation = answerStoredDecision(sc.db, source, asked, text, Date.now(), { question, screen: true, heads: sc.pendingGrantHeads(ws, text) });
            void sc.answerGrantHeads(ws, text).then((heads) => Object.keys(heads).length && setAnswerHeads(sc.db, operation, heads)).catch((e) => console.warn(`backlog answer: heads not kept (${String((e as Error).message ?? e)})`));
          } else answerStoredDecision(sc.db, source, asked, text, Date.now(), { question, by: by.sender ? `task:${by.sender}` : "api" });
          sc.backlog.send(ws);
        } catch (e) {
          if (e instanceof BacklogEditError) return sc.bad(e.message, e.status);
          throw e;
        }
        return sc.json({ ok: true }, 202);
      },
    },
    /** A plain comment on a stored Issue: kept here at once (202) and sent to GitHub later, as an answer is. */
    "/api/backlog/:number/comment": {
      POST: async (req, srv) => {
        const parsed = BacklogCommentInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const ws = sc.db.getWorkspace(parsed.data.workspaceId);
        const source = ws && sc.db.getWorkspaceBacklogSource(ws.id);
        if (!ws) return sc.bad("workspace not found", 404);
        if (!source) return sc.bad("まだ GitHub から取り込んでいません", 409);
        try {
          // ?change=1: on the workspace's local change of that number (kept apart from a service's Issues: decided at once, not sent)
          if (new URL(req.url).searchParams.get("change") === "1" && changesApart(source)) {
            const kept = changeSourceOf(sc.db, ws.id)!;
            if (!readStoredIssue(sc.db, ws, Number(req.params.number), { source: kept })?.issue.change) return sc.bad(`変更 #${req.params.number} は保存されていません`, 404);
            const made = commentStoredIssue(sc.db, kept, Number(req.params.number), parsed.data.text);
            applyLocalOperations(sc.db, kept);
            return sc.json(made, 202);
          }
          const made = commentStoredIssue(sc.db, source, Number(req.params.number), parsed.data.text);
          sc.backlog.send(ws);
          // a question that says 推奨で進める from which the work may not go on waits for the person, and the stage Task
          // that posted it stops here (`waits` = why; the kit's command prints it). Which Task posted it is what the
          // request proves (`callingTask`), not the sender its body names: a comment of another Task, or a request
          // without the proof, stops no Task
          const waits = sc.stopForRefusedProceed(ws, Number(req.params.number), parsed.data.text, sc.callingTask(req, srv) ?? undefined);
          return sc.json(waits ? { ...made, waits } : made, 202);
        } catch (e) {
          if (e instanceof BacklogEditError) return sc.bad(e.message, e.status);
          throw e;
        }
      },
    },
    /**
     * Takes or gives back the PBI's lease for a session that starts a PBI by itself (`scripts/parallel-guard.ts`
     * claim / release). The daemon holds and renews it, so it outlives the script. `enabled: false` = this daemon runs
     * alone, or the workspace's backlog is not synced with its service: there is no lease and S3 is not asked.
     */
    "/api/backlog/:number/lease": {
      POST: async (req) => {
        const body = await sc.readJson(req, (x) => x as { workspaceId?: unknown; action?: unknown } | null);
        const ws = typeof body?.workspaceId === "string" ? sc.db.getWorkspace(body.workspaceId) : null;
        if (!ws) return sc.bad("workspace not found", 404);
        const n = Number(req.params.number);
        if (!Number.isInteger(n) || n <= 0 || (body!.action !== "acquire" && body!.action !== "release")) return sc.bad("action is acquire or release");
        const repository = sc.leaseRepository(ws);
        if (!repository) return sc.json({ enabled: false });
        try {
          if (body!.action === "release") return (await sc.leases!.release(repository, n), sc.json({ enabled: true, ok: true }));
          const got = await sc.leases!.acquire(repository, n);
          return sc.json(got.ok ? { enabled: true, ok: true } : { enabled: true, ok: false, holder: got.holder, until: got.until, error: heldLine(n, got.holder, got.until) });
        } catch (e) {
          return sc.bad(`リースを確かめられません: ${String((e as Error)?.message ?? e).slice(0, 200)}`, sc.UPSTREAM_FAILED);
        }
      },
    },
    /**
     * Starts the next stage of one backlog item as a Task with the stage skill's fixed prompt, on the workspace
     * whose repository the Issue is in; another workspace's Task reads the skills from the meta workspace.
     */
    "/api/backlog/:number/start": {
      POST: async (req) => {
        const parsed = BacklogStartInput.safeParse(await req.json().catch(() => null));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const ws = sc.db.getWorkspace(parsed.data.workspaceId);
        if (!ws) return sc.bad("workspace not found", 404);
        if (!existsSync(ws.path)) return sc.bad("workspace directory does not exist", 409);
        if (!sc.backlogReads(ws)) return sc.bad(sc.DEVELOP_SELF_OFF, 409);
        const meta = sc.metaWorkspace();
        if (ws.kind !== "meta" && !meta) return sc.bad("meta workspace がありません（工程のスキルはそこから読みます）", 409);
        const n = Number(req.params.number);
        // the stored data is what is true: GitHub is brought up to date first when it can be reached, and a
        // limit or an outage does not hold the start
        await sc.backlog.settle(ws).catch(() => undefined);
        const stored = await sc.storedBacklogReleased(ws);
        if (stored.fetchedAt === null) return sc.bad(stored.error ?? "まだ GitHub から取り込んでいません", sc.UPSTREAM_FAILED);
        const items = stored.items;
        const item = items.find((i) => i.number === n);
        if (!item) return sc.bad(`#${req.params.number} はバックログにありません`, 404);
        const can = canStartStoredBacklog(item);
        if (!can.ok) return sc.bad(`#${n} は始めません: ${can.why}`, 409);
        const { action, runner: wantRunner, model: wantModel, effort: wantEffort } = parsed.data;
        if (wantRunner && !sc.adapterMap.has(wantRunner)) return sc.bad("ランナーが検出されていません", 409);
        // 閉じる goes with progress.closableByApi (Tasks all closed, 利用者確認 may remain), not with a stage; complete on an in-progress item is backlog-next's resume
        // of a stalled one, started from a waiting row's 続きを始める
        const resume = action === "complete" && item.stage === "in-progress";
        // 直行で直す only from a request with no PBI yet, like PBI にする; it is not a stage, so backlog-next never picks it
        if (action === "direct" && item.stage !== "request") return sc.bad(`直行で始められるのは派生 PBI の無い要望だけです（#${n} は ${item.stage}）`, 409);
        // another repository's worktree and branch rules are its own (the PBI's scope: the meta workspace first)
        if (action === "direct" && ws.kind !== "meta") return sc.bad("直行で始められるのは meta workspace の要望だけです", 409);
        if (action !== "direct" && (action === "close" ? !item.progress.closableByApi : !(ACTION_FOR_STAGE[item.stage] === action || resume))) return sc.bad(`#${n} は ${item.stage}${action === "close" ? "（閉じられない）" : ""} なので ${action} は始められません`, 409);
        // the row's button does not start what backlog-next leaves for its overlap: the reason is the log's;
        // a running stage Task is the 409 with its taskId below (the row opens it), not a refusal
        if (action === "complete" && !sc.activeStageTask(ws.id, n) && isOverlapped(item)) return sc.json({ error: overlapLine([item]).join("・") }, 409);
        const r = await sc.startStage({ ws, meta: meta!, item, action, resume: resume ? { tasksDone: item.tasks?.done ?? 0 } : undefined, ...(wantRunner ? { extra: { runner: wantRunner, model: wantModel, effort: wantEffort } } : {}) });
        if ("active" in r) return sc.json({ error: `#${n} の工程 Task が実行中です`, taskId: r.active.id }, 409);
        return "task" in r ? sc.json(r.task, 201) : sc.bad(r.error, r.status);
      },
    },
    // The person's evaluation of a closed request with its PBIs as one unit: the stages that went wrong, a rating and a
    // note, one row per request (the latest). Only a stored type:request Issue of the workspace takes one.
    "/api/backlog/:number/evals/human": {
      PUT: async (req) => {
        const parsed = RequestEvalInput.safeParse(await req.json().catch(() => ({})));
        if (!parsed.success) return sc.bad(parsed.error.message);
        const at = requestEvalTarget(sc.db, parsed.data.workspaceId, String(req.params.number));
        if (!at) return sc.bad("not found", 404);
        const row: RequestEval = { stages: parsed.data.stages, rating: parsed.data.rating, comment: parsed.data.comment, by: "user", ts: Date.now() };
        sc.db.upsertRequestEval(at.workspaceId, at.number, row);
        return sc.json(row);
      },
      DELETE: (req) => {
        const at = requestEvalTarget(sc.db, new URL(req.url).searchParams.get("workspaceId"), String(req.params.number));
        if (!at) return sc.bad("not found", 404);
        sc.db.deleteRequestEval(at.workspaceId, at.number);
        return sc.json({ ok: true });
      },
    },
  };
}
