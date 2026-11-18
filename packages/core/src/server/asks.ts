import { isWorkMachine } from "../machine.ts";
import { existsSync } from "node:fs";
import { configAsks } from "./workspace-config.ts";
import { personWait, type Workspace, type AnswerPolicy, type Ask, type AskAnswer, type AskAnswerResult, type AskChanged, type AskBatch, type Backlog, type BacklogItem, type PolicyInput, type PolicySubject, choiceKey, isRecommendedChoice } from "@switchboard/protocol";
import { subjectsOf } from "../approval.ts";
import { unusableWorkspaces } from "../workspace-clone.ts";
import { DECISION_HEADING, proceedAnswerLine } from "../backlog-comments.ts";
import { storedEnds, storedProceedRefusal } from "../backlog-stored.ts";
import { ACTION_FOR_STAGE } from "../backlog-item.ts";
import { answerStoredConfirmation, answerStoredDecision, BacklogEditError, holdStoredDecision } from "../backlog-edit.ts";
import { overlapLine, isOverlapped } from "../backlog-overlap.ts";
import { drainNote, promotionNote, tagCiNote } from "../promotion.ts";
import { runGh } from "../backlog-gh.ts";
import { reduceStops } from "../stops.ts";
import { approvalBatches, approvalWindowNote, BatchAnswers } from "../approval-batch.ts";
import { ASK_HISTORY_MS, ON_HOLD_RESUME, asksFromBacklog, asksFromTasks, blockersOf, dedupeAsks, policyPbi, proceedingAsks, rankAsks, prFacts, questionsReply, resumeOfTask, withGone, type GoneFacts, type PolicyEnv, type PrFacts } from "../asks.ts";
import { closedHits, noticeAsks, type NoticeRecord } from "../asks-notices.ts";
import { checkPolicy, matchPolicies, readPolicies, recordUse, subjectChanges, writePolicies } from "../policies.ts";
import { listRefusedDeltas } from "../uplink-s3.ts";
import { listRefused } from "../backlog-upbox.ts";
import type { ServerContext, ServerContextInit } from "./context.ts";

/** A start that failed after an answer, by the question's id: kept in `ask_answers` for a day. */
export const failed = (sc: Pick<ServerContext, "db">, id: string) => sc.db.askAnswer(id)?.failure ?? null;

/** What the saved policies need from the daemon: the subject of a tool approval and the Knowledge confirm rules. */
export const policyEnv = (sc: Pick<ServerContext, "db" | "approval">, b: Backlog): PolicyEnv => ({
  policies: readPolicies(sc.db),
  pbiOpen: (n) => b.items.some((i) => i.number === n),
  approval: (a) => {
    const t = sc.db.getTask(a.taskId);
    if (!t || (a.kind !== "exec" && a.kind !== "write")) return { subject: null, confirmHit: null };
    const ev = { t: "permission.ask" as const, id: a.id, kind: a.kind, tool: a.tool, input: a.input, detail: a.detail };
    const s = subjectsOf(ev, t);
    const confirmHit = sc.approval.confirmHit(t, ev);
    return { subject: s.blocked || s.values.length !== 1 ? null : { kind: "approval", op: a.kind, target: s.values[0]!, conditions: [], head: null }, confirmHit };
  },
  confirm: (workspaceId, command) => {
    const sp = command.indexOf(" ");
    return sc.approval.confirmOf(workspaceId, "decision", command.slice(0, sp), command.slice(sp + 1));
  },
});

/**
 * The questions now: the open ones and those answered / resolved within the day, one per
 * question, from the stored backlog (no GitHub call) and the Tasks.
 */
/**
 * A policy that did not apply because the PR's head changed, by the question's id: the list does not read PRs, so
 * the difference is kept when applying read it, and shown as the question's `previous` until it is answered or gone.
 */
/**
 * A decision's id names its answer's time, so the question a policy answered shows under another id once the answer is
 * read back: each use of a decision is tied to the answered question of its Issue, in order, and kept.
 */
export const tieAnswers = (sc: Pick<ServerContext, "db">, all: Ask[]) => {
  const list = readPolicies(sc.db);
  const base = (id: string) => id.split("@")[0]!;
  const claimed = new Set(list.flatMap((p) => p.uses.flatMap((u) => (u.answered ? [u.answered] : []))));
  const open = list.flatMap((p) => p.uses.filter((u) => !u.answered && u.askId.startsWith("decision:")).map((u) => ({ p, u }))).sort((x, y) => x.u.at - y.u.at);
  if (!open.length) return;
  let changed = false;
  for (const { p, u } of open) {
    const found = all.filter((a) => a.state === "answered" && a.kind === "decision" && base(a.id) === base(u.askId) && !claimed.has(a.id) && a.changedAt >= u.at - 60_000).sort((x, y) => x.changedAt - y.changedAt)[0];
    if (!found) continue;
    claimed.add(found.id);
    u.answered = found.id;
    void p;
    changed = true;
  }
  if (changed) writePolicies(sc.db, list);
};

/**
 * The daemon's notices from the current state: a workspace a Task cannot use (a rebuild that cloned it
 * from elsewhere, or could not). Their first sight and resolution are kept in one setting, written only when they move.
 */
export const currentNotices = (sc: Pick<ServerContext, "db" | "opts" | "NOTICES_KEY" | "promotionHold" | "busyTasks" | "drainHold" | "promotionDrain" | "metaWorkspace">, now: number, batches: AskBatch[], asks: Ask[]): Ask[] => {
  let unusable: ReturnType<typeof unusableWorkspaces> = [];
  try {
    unusable = unusableWorkspaces(sc.db, sc.opts.gitOrigin);
  } catch (e) {
    console.warn(`workspaces: could not check the checkouts: ${String((e as Error).message ?? e)}`);
  }
  const had = sc.db.getSetting<NoticeRecord>(sc.NOTICES_KEY, {});
  const where = (id: string) => {
    const w = sc.db.getWorkspace(id);
    return w ? { id: w.id, name: w.name } : null;
  };
  // a disabled scan's last findings are still there: only a clean result resolves them
  const scans = sc.db.listSchedules().filter((s) => s.action === "secret-scan").map((s) => ({ schedule: { id: s.id, title: s.title }, workspace: where(s.workspaceId), result: s.lastResult }));
  // approval-window: once a firing ran, the batches still waiting, as of now
  const windows = sc.db.listSchedules().filter((s) => s.action === "approval-window" && s.enabled && s.lastResult).map((s) => ({ schedule: { id: s.id, title: s.title }, workspace: where(s.workspaceId), note: approvalWindowNote(batches, asks) }));
  // the same firing: the newest tag held for running Tasks since before it fired
  const promotions = sc.db.listSchedules().filter((s) => s.action === "approval-window" && s.enabled && s.lastRunAt).map((s) => ({ schedule: { id: s.id, title: s.title }, workspace: where(s.workspaceId), note: promotionNote(sc.promotionHold, sc.busyTasks(), s.lastRunAt, now) }));
  // a promotion that waited past its limit for the Tasks: told at once, by itself (no Task is cut for it)
  sc.drainHold();
  const meta = sc.metaWorkspace();
  const drain = { note: drainNote(sc.promotionDrain, sc.db.listWorkingTasks("gate"), now), workspace: meta ? { id: meta.id, name: meta.name } : null };
  // a tag the tag CI holds back: told at once too (no Task ending brings it in)
  const tagCi = { note: tagCiNote(sc.promotionHold), workspace: drain.workspace };
  // what a work machine put and this instance passed over (none without registered machines)
  const refused = [...listRefusedDeltas(sc.db), ...listRefused(sc.db).flatMap((r) => (r.machine ? [{ machine: r.machine, key: r.key, reason: r.reason }] : []))];
  const noticed = noticeAsks({ unusable, scans, windows, promotions, drain, tagCi, refused, now }, had);
  if (noticed.record !== had) sc.db.setSetting(sc.NOTICES_KEY, noticed.record);
  return noticed.asks;
};

export const currentAsks = async (sc: Pick<ServerContext, "readBacklog" | "db" | "policyEnv" | "tasks" | "failed" | "mockupsOf" | "approvalPendingOf" | "tieAnswers" | "headMisses" | "batchAnswers" | "currentNotices">): Promise<{ backlog: Backlog; asks: Ask[]; batches: AskBatch[] }> => {
  const now = Date.now();
  const b = await sc.readBacklog(false);
  const live = new Map([...sc.db.listTasksUpdatedSince(now - ASK_HISTORY_MS), ...sc.db.listTasksWithResume(), ...sc.db.listTasksByStatus("waiting"), ...sc.db.listTasksByStatus("running"), ...sc.db.listTasksWithWaits()].map((t) => [t.id, t]));
  const policy = sc.policyEnv(b);
  const fromTasks = asksFromTasks({
    approvals: sc.tasks.pendingApprovals(),
    tasks: [...live.values()],
    lastTurnQuestions: (id) => sc.db.lastTurnQuestions(id),
    permissionEvents: (ids) => sc.db.listPermissionEvents(ids),
    stops: (t) => reduceStops(sc.db.listStopRecords([t.id])),
    workspaceName: (id) => sc.db.getWorkspace(id)?.name ?? null,
    now,
    resumeFailures: sc.failed,
    policy,
    mockups: sc.mockupsOf,
    lastReply: (id) => sc.db.lastReply(id)?.text ?? null,
  });
  // a question whose target is gone (its Issue closed, its PR ended, a newer stage Task of the Issue done) is over; each workspace's records are read when one is asked about
  const ends = new Map<string, ReturnType<typeof storedEnds>>();
  const gone: GoneFacts = {
    endOf: (w, n) => (ends.get(w) ?? ends.set(w, storedEnds(sc.db, { id: w })).get(w)!)(n),
    newerStageDone: (w, n, taskId) => {
      const last = sc.db.lastStageTask(w, n);
      const mine = sc.db.getTask(taskId);
      return last && mine && last.id !== taskId && last.createdAt > mine.createdAt && last.status === "done" && personWait(last) !== "needs" ? last.updatedAt : null;
    },
  };
  const all = rankAsks(dedupeAsks([...proceedingAsks(b.proceeding ?? [], now, { mockups: sc.mockupsOf }), ...withGone([...asksFromBacklog(b.items, now, { approvalPending: sc.approvalPendingOf(), resumeFailures: sc.failed, policy, mockups: sc.mockupsOf, startedBy: (w, n) => sc.db.askAnswer(`started:${w}#${n}`)?.result?.ask?.resume?.taskId ?? null, lastReply: (id) => sc.db.lastReply(id)?.text ?? null, taskOf: (id) => sc.db.getTask(id) }), ...fromTasks], gone, now)]), b.items);
  sc.tieAnswers(all);
  for (const id of sc.headMisses.keys()) if (!all.some((a) => a.id === id && (a.state === "open" || a.state === "held"))) sc.headMisses.delete(id);
  const asks = all.map((a) => (sc.headMisses.has(a.id) ? { ...a, policy: { ...a.policy, previous: sc.headMisses.get(a.id)! } } : a));
  // the same stop records as above, each Task's own
  const batches = sc.batchAnswers.decorate(approvalBatches([...live.values()].map((t) => ({ task: t, records: sc.db.listStopRecords([t.id]) })), asks));
  // the daemon's notices last: one of them reads the batches
  return { backlog: b, asks: rankAsks(dedupeAsks([...asks, ...sc.currentNotices(now, batches, asks), ...configAsks(sc, now)]), b.items), batches };
};

/** A stage Task's permission stop with a tool approval waiting is answered by that approval, not refused. */
export const approvalPendingOf = (sc: Pick<ServerContext, "tasks" | "db">) => {
  const approving = sc.tasks.pendingApprovals().map((a) => sc.db.getTask(a.taskId)).filter((t) => t !== null);
  return (i: BacklogItem) => approving.some((t) => t.workspaceId === i.workspaceId && t.stage?.issue === i.number);
};

/** A Task's answer as it goes on now: its resume read again from the Task (running, the usage limit, failed). */
export const nowOf = (sc: Pick<ServerContext, "db" | "failed">, r: AskAnswerResult): AskAnswerResult => {
  const a = r.ask;
  // a stage Task's stop answered in words goes on as that Task; one answered by its grant goes on as the next stage Task (its stored resume)
  const t = a && a.task && a.state === "answered" && (!a.issue || (a.kind === "stop" && a.resume?.taskId === a.task.id)) ? sc.db.getTask(a.task.id) : null;
  return t && a ? { ...r, ask: { ...a, resume: resumeOfTask({ task: t, repliedAt: a.changedAt, failure: sc.failed(a.id) }) } } : r;
};

// What an answer answered, by the question's id, is `ask_answers` for a day: a resend whose reply was lost gets it again, nothing written twice.

/**
 * Answers one question of the backlog: checked against the question now (changed → 409 and nothing written),
 * written where it was asked (kept here and sent to GitHub), then — only after that, and unless a hold or something
 * an answer does not take away stands in the way — the work goes on through startStage.
 */
export const answerAsk = async (sc: Pick<ServerContext, "currentAsks" | "db" | "NOTICES_KEY" | "answerTask" | "metaWorkspace" | "opts" | "UPSTREAM_FAILED" | "policyGone" | "storedBacklog" | "basisLine" | "backlog" | "withActive" | "approvalPendingOf" | "startStage">, id: string, answer: AskAnswer, pre: { pr: number; facts: PrFacts } | null = null, by: AnswerPolicy | null = null, batch = false, via: "screen" | "api" = "api"): Promise<{ status: number; body: object }> => {
  const changed = (error: string, changes: string[], current: Ask | null) => ({ status: 409, body: { error, changes, current } satisfies AskChanged });
  const { asks } = await sc.currentAsks();
  const ask = asks.find((a) => a.id === id);
  const prefix = (x: string) => x.split("@")[0];
  if (!ask || (ask.state !== "open" && ask.state !== "held")) {
    const current = asks.find((a) => a.id !== id && prefix(a.id) === prefix(id) && (a.state === "open" || a.state === "held")) ?? null;
    const why = ask ? "回答済みです" : current ? "問いが新しくなりました" : "問いがもうありません（対象の Issue が閉じたか、別の所で答えられました）";
    return changed(why, [why], current);
  }
  if (!ask.answers.length) {
    const why = ask.blockers.length ? ask.blockers.map((b) => b.detail) : ["この問いには画面から答えられません"];
    return changed("回答だけでは進められない問いです", why, ask);
  }
  // a daemon's notice: only a scan's is answered, by closing it as a false positive — the same findings stay closed
  if (ask.kind === "notice") {
    if (answer.kind !== "dismiss" || !ask.answers.includes("dismiss")) return { status: 422, body: { error: "このお知らせは閉じるだけです" } };
    const record = sc.db.getSetting<NoticeRecord>(sc.NOTICES_KEY, {});
    const key = Object.keys(record).find((k) => record[k]!.id === id);
    if (!key) return changed("お知らせが新しくなりました", ["お知らせが新しくなりました"], ask);
    sc.db.setSetting(sc.NOTICES_KEY, { ...record, [key]: { ...record[key]!, dismissed: closedHits(record[key]!), closed: true, resolvedAt: Date.now() } });
    // the question as it is after the answer: closed, so the screen keeps no button on it
    return { status: 200, body: { ask: { ...ask, state: "resolved", changedAt: Date.now(), answers: [] }, already: false, changes: [] } satisfies AskAnswerResult };
  }
  // a stage Task's stop answered in words is a reply to that Task, as a Task's own stop is
  if (ask.task && ((!ask.issue && (ask.kind === "approval" || ask.kind === "check" || ask.kind === "stop")) || (ask.kind === "stop" && answer.kind !== "grant"))) return sc.answerTask(id, ask, answer, by, via);
  // what a stage Task's stop writes on its Issue is its grant only: the ## 回答 the next stage Task gets as the person's words
  const granted = ask.kind === "stop" && answer.kind === "grant";
  if (ask.kind !== "decision" && ask.kind !== "confirmation" && !granted) return { status: 422, body: { error: `${ask.kind} の問いにはここから答えられません` } };
  if (granted && !ask.grant) return { status: 409, body: { error: "許可文がありません" } };
  if (!ask.answers.includes(answer.kind) || (answer.kind === "choice" && !ask.choices.includes(answer.choice))) return changed("選択肢が変わりました", ["選択肢が変わりました"], ask);
  if (answer.kind === "confirm" && !answer.ok && !answer.text) return { status: 400, body: { error: "違うときは理由を書いてください" } };
  // one the work went on from: `confirm` (or the recommended choice) leaves the work as it is; any other answer overturns it
  const same = !!ask.proceeding && ((answer.kind === "confirm" && answer.ok) || (answer.kind === "choice" && isRecommendedChoice(answer.choice, ask.recommendation)));
  if (same && !ask.recommendation) return { status: 409, body: { error: "この問いには推奨が書かれていません。選択肢か自由文で答えてください" } };
  const ws = ask.workspace ? sc.db.getWorkspace(ask.workspace.id) : null;
  const source = ws ? sc.db.getWorkspaceBacklogSource(ws.id) : null;
  if (!ws || !source || !existsSync(ws.path)) return { status: 409, body: { error: "workspace がありません" } };
  const meta = sc.metaWorkspace();
  if (ws.kind !== "meta" && !meta) return { status: 409, body: { error: "meta workspace がありません（工程のスキルはそこから読みます）" } };
  // a held question held again (a resend whose reply was lost): nothing more to write
  if (ask.state === "held" && answer.kind === "hold") return { status: 200, body: { ask, already: true, changes: [] } satisfies AskAnswerResult };
  // a choice may be the PR's approval: not given to a PR that moved since. A text still goes (asking to check again),
  // written with what moved, so the work that reads it knows the answer was to the PR before
  let moved: string[] = [];
  if (ask.place?.pr && !ask.proceeding && (answer.kind === "choice" || answer.kind === "text")) {
    try {
      moved = (pre?.pr === ask.place.pr ? pre.facts : await prFacts(sc.opts.gh ?? runGh, ws.path, source.repository, ask.place.pr, ask.at)).changes;
      if (moved.length && answer.kind === "choice") return changed("問いの後で対象の PR が変わりました。選択肢では答えられません。自由文で確かめ直しを頼むか、新しい問いを待ってください", moved, ask);
    } catch (e) {
      return { status: sc.UPSTREAM_FAILED, body: { error: `PR #${ask.place.pr} を確かめられない: ${String((e as Error).message ?? e)}` } };
    }
  }
  const pbi = ask.pbi!.number;
  const gone = sc.policyGone(by);
  if (gone) return changed(gone, [gone], ask);
  try {
    if (answer.kind === "hold") holdStoredDecision(sc.db, source, ask.issue!.number, answer.text ?? "");
    else if (ask.proceeding) {
      // the first line says which question and whether the recommendation stood: the record of a confirmation or an overturn
      const said = answer.kind === "choice" ? `${answer.choice}${answer.note ? `\n\n${answer.note}` : ""}` : answer.kind === "text" || answer.kind === "confirm" ? (answer.text ?? "") : "";
      const line = proceedAnswerLine({ at: new Date(ask.at).toISOString(), recommended: ask.recommendation ? choiceKey(ask.recommendation.choice) : "（記載なし）" }, same ? { same, batch } : { same, choice: answer.kind === "choice" ? choiceKey(answer.choice) : null });
      // a confirmation is not the person's words to the next stage Task (`screen`): nothing goes on from it; nor is an answer that did not come in as the screen's (`via`)
      answerStoredDecision(sc.db, source, ask.issue!.number, same ? line : `${line}\n\n${said}`, Date.now(), { screen: !same && via === "screen" });
    } else if (answer.kind === "confirm") {
      const n = Number(/:(\d+)$/.exec(id)?.[1]);
      const item = sc.storedBacklog(ws).items.find((i) => i.number === pbi);
      const c = item?.confirmations.find((x) => x.n === n);
      if (!c || !answerStoredConfirmation(sc.db, source, pbi, { ...c, ok: answer.ok, reason: answer.text ?? "" })) return changed("本文が変わりました", ["受け入れ条件の本文が変わりました"], null);
    } else {
      const said = answer.kind === "choice" ? `${answer.choice}${answer.note ? `\n\n${answer.note}` : ""}` : answer.kind === "text" ? answer.text : answer.kind === "grant" ? ask.grant! : "";
      const text = moved.length ? `${said}\n\n（この回答は問いの時点の PR へのものです。回答の時点で: ${moved.join(" / ")}）` : said;
      answerStoredDecision(sc.db, source, ask.issue!.number, by ? `${text}\n\n${sc.basisLine(by, ask.subject)}` : text, Date.now(), { screen: !by && via === "screen" });
    }
  } catch (e) {
    if (e instanceof BacklogEditError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
  sc.backlog.send(ws);
  const at = Date.now();
  // the recommendation stood: the work already went on with it, so nothing starts
  if (same) return { status: 200, body: { ask: { ...ask, state: "answered", changedAt: at, answers: [], resume: null }, already: false, changes: [] } satisfies AskAnswerResult };
  // an earlier answer's started Task is not this answer's resume
  if (sc.db.askAnswer(`started:${ws.id}#${pbi}`)) sc.db.rememberAskAnswer(`started:${ws.id}#${pbi}`, { at, result: null });
  const done = (resume: Ask["resume"]): { status: number; body: AskAnswerResult } => ({ status: 200, body: { ask: { ...ask, state: answer.kind === "hold" ? "held" : "answered", changedAt: at, answers: [], resume }, already: false, changes: moved } });
  if (answer.kind === "hold") return done(null);
  // the work goes on from the item as stored now (the answer is in it): a hold or what an answer does not take away stops it here
  const item = sc.withActive({ fetchedAt: 0, items: sc.storedBacklog(ws).items, errors: [], changes: [], syncs: [] }).items.find((i) => i.number === pbi);
  if (!item) return done(null);
  const blockers = blockersOf({ waits: item.waits, stops: item.stopSummary, approvalPending: sc.approvalPendingOf()(item) });
  if (blockers.length) return done({ state: "queued", reason: blockers.map((b) => b.detail).join("・"), taskId: null, at });
  // a saved policy's answer is backlog-next's, not the person's: an item on hold does not go on from it
  if (by && item.onHold) return done({ state: "queued", reason: ON_HOLD_RESUME, taskId: null, at });
  const action = ask.kind === "confirmation" ? (item.closable ? "close" : null) : item.stage === "in-progress" ? "complete" : (ACTION_FOR_STAGE[item.stage] ?? null);
  if (!action) return done(null);
  // an 実装 whose files other work touches is not started by an answer either, as backlog-next's pickNext leaves it;
  // one already running is the running answer below, not a refusal
  if (action === "complete" && !item.activeTaskId && isOverlapped(item)) return done({ state: "queued", reason: overlapLine([item]).join("・"), taskId: null, at });
  const r = await sc.startStage({ ws, meta: meta ?? ws, item, action });
  // the Task the answer started is its resume even when GitHub's comment time (answeredAt after the next sync) is later than its start
  const started = (taskId: string) => {
    const d = done({ state: "running", reason: null, taskId, at });
    sc.db.rememberAskAnswer(`started:${ws.id}#${pbi}`, { at, result: d.body });
    return d;
  };
  if ("task" in r) return started(r.task.id);
  // an active one is from before the answer (even an idle one awaiting judging), not started by it: the card stays 再開待ち
  if ("active" in r) return done({ state: "running", reason: null, taskId: r.active.id, at });
  // kept for the question and for the answered one it became (its id names the answer's time)
  const failure = { at, reason: r.error };
  sc.db.rememberAskAnswer(id, { at, failure });
  const now = (await sc.currentAsks()).asks.find((a) => a.kind === ask.kind && a.state === "answered" && a.pbi?.number === pbi && a.workspace?.id === ws.id);
  if (now) sc.db.rememberAskAnswer(now.id, { at, failure });
  return done({ state: "failed", reason: r.error, taskId: null, at });
};

/** Why a policy picked to answer cannot be used now (revoked or expired while the answer was prepared), or null. */
export const policyGone = (sc: Pick<ServerContext, "db">, by: AnswerPolicy | null): string | null => {
  if (!by) return null;
  const cur = readPolicies(sc.db).find((p) => p.id === by.id);
  return !cur || cur.revokedAt !== null || (cur.expiresAt !== null && Date.now() >= cur.expiresAt) ? "方針が無効になったか期限が切れたため、答えませんでした" : null;
};

/** The one line that says a saved policy answered: written with the answer, where the person reads it. */
export const basisLine = (_sc: unknown, p: AnswerPolicy, subject: PolicySubject | null) => {
  const scope = { once: "今回のみ", pbi: "この PBI 内", repo: "このリポジトリ" }[p.scope];
  const when = [...p.when, ...(subject?.conditions.filter((c) => c.key === "merge-ask") ?? [])].map((c) => `${c.key}=${c.value}`).join(" ");
  return `（方針 ${p.id} を適用: ${scope} / ${p.op} ${p.target} / 条件 ${when || "なし"} / 期限 ${p.expiresAt === null ? "なし" : new Date(p.expiresAt).toISOString().slice(0, 10)}）`;
};

/**
 * One answer, once: a resend gets the first one's result, a second at the same time waits for the first. The
 * screen's POST and a saved policy's application both come through here.
 */
export const submitAnswer = async (sc: Pick<ServerContext, "db" | "nowOf" | "answering" | "answerWithPolicy" | "answerAsk">, id: string, answer: AskAnswer, policy?: PolicyInput, by: AnswerPolicy | null = null, pre: { pr: number; facts: PrFacts } | null = null, batch = false, via: "screen" | "api" = "api"): Promise<{ status: number; body: object }> => {
  // no await from here until the answer is in `answering`: a second one for the same question waits for it
  sc.db.pruneAskAnswers(Date.now() - ASK_HISTORY_MS);
  const had = sc.db.askAnswer(id)?.result;
  if (had) return { status: 200, body: { ...sc.nowOf(had), already: true } satisfies AskAnswerResult };
  const first = sc.answering.get(id);
  if (first) {
    const r = await first;
    return r.status === 200 ? { status: 200, body: { ...sc.nowOf(r.body as AskAnswerResult), already: true } satisfies AskAnswerResult } : r;
  }
  const p = policy ? sc.answerWithPolicy(id, answer, policy) : sc.answerAsk(id, answer, pre, by, batch, via);
  sc.answering.set(id, p);
  try {
    const r = await p;
    // only an answer closes the question: a hold leaves it open to the person, who answers it later by the same id
    // a notice closed by dismiss is remembered the same way: it comes back resolved
    const closed = (r.body as AskAnswerResult).ask;
    if (r.status === 200 && (closed?.state === "answered" || (closed?.kind === "notice" && closed.state === "resolved"))) sc.db.rememberAskAnswer(id, { at: Date.now(), result: r.body as AskAnswerResult });
    return r;
  } finally {
    sc.answering.delete(id);
  }
};

/**
 * 「全部推奨のままで確定」 of one Workspace: each of its open questions the work went on from gets its confirmation
 * (`## 回答` on its own Issue), through the same answer as one pressed alone. Nothing new is let through — the work
 * already went on with these — so one press may confirm them all; a question that waits, an approval or a stop is never
 * among them. One without a recommendation, or whose write is refused, stays open. A resend finds none left.
 * `shown`: the ids of the questions the person's screen listed when they pressed. Only those are confirmed: a question
 * that came up after the screen was drawn (a new id — the id carries the question's time) was not seen, and stays open.
 */
export const confirmProceeding = async (sc: Pick<ServerContext, "currentAsks" | "submitAnswer">, workspaceId: string, shown: readonly string[]): Promise<{ confirmed: string[] }> => {
  const confirmed: string[] = [];
  const seen = new Set(shown);
  for (const a of (await sc.currentAsks()).asks) {
    if (!seen.has(a.id) || !a.proceeding || a.state !== "open" || a.workspace?.id !== workspaceId || !a.recommendation) continue;
    const r = await sc.submitAnswer(a.id, { kind: "confirm", ok: true }, undefined, null, null, true);
    if (r.status === 200 && !(r.body as AskAnswerResult).already) confirmed.push(a.id);
  }
  return { confirmed };
};

export const applyPolicies = (sc: Pick<ServerContext, "cfg" | "applying" | "judgeStop" | "db" | "currentAsks" | "opts" | "approval" | "headMisses" | "submitAnswer">): Promise<void> => {
  // a work machine answers nothing by itself: a saved policy is applied by the instance only (machine.ts)
  if (isWorkMachine(sc.cfg)) return sc.applying;
  sc.applying = sc.applying.then(async () => {
    if (sc.judgeStop.signal.aborted || !readPolicies(sc.db).some((p) => p.revokedAt === null)) return;
    const { asks, backlog: b } = await sc.currentAsks();
    for (const ask of asks) {
      if (sc.judgeStop.signal.aborted) return;
      if (ask.state !== "open" || ask.needs !== "person" || ask.kind !== "decision" || !ask.subject || !ask.answers.length || ask.blockers.some((b) => b.kind === "runner")) continue;
      let subject = ask.subject;
      const ws = ask.workspace ? sc.db.getWorkspace(ask.workspace.id) : null;
      const source = ws ? sc.db.getWorkspaceBacklogSource(ws.id) : null;
      let pre: { pr: number; facts: PrFacts } | null = null;
      // a PR's head and merge check can only be read with its repository: without it nothing is answered
      if (ask.place?.pr && (!ws || !source)) continue;
      if (ask.place?.pr && ws && source) {
        try {
          const facts = await prFacts(sc.opts.gh ?? runGh, ws.path, source.repository, ask.place.pr, ask.at);
          pre = { pr: ask.place.pr, facts };
          subject = { ...subject, head: facts.head, conditions: facts.mergeAsk ? [...subject.conditions, { key: "merge-ask", value: facts.mergeAsk }] : subject.conditions };
        } catch {
          continue;
        }
      }
      // what always asks: a security merge check, and a Knowledge confirm rule
      if (subject.conditions.some((c) => c.key === "merge-ask" && c.value.includes("security")) || sc.approval.confirmOf(ask.workspace?.id ?? null, subject.kind, subject.op, subject.target)) continue;
      const matched = matchPolicies(readPolicies(sc.db), { id: ask.id, subject, workspaceId: ask.workspace?.id ?? null, pbi: policyPbi(ask), pbiOpen: policyPbi(ask) !== null && b.items.some((i) => i.number === policyPbi(ask)), choices: ask.choices }, Date.now());
      const hit = matched.hit;
      // the policy was saved on another head of this PR: nothing is answered, and the card says what differs
      const moved = hit ? undefined : matched.misses.find((x) => x.why === "PR の差分が変わった");
      if (moved) sc.headMisses.set(ask.id, { id: moved.policy.id, answer: moved.policy.answer, at: moved.policy.updatedAt, why: moved.why, changes: subjectChanges(moved.policy.uses[0]?.subject ?? moved.policy.from, subject) });
      else sc.headMisses.delete(ask.id);
      if (!hit) continue;
      const bare = (c: string) => c.replace(/^[^:]*: /, "");
      if (!ask.answers.includes(hit.answer.kind)) continue;
      const answer: AskAnswer = hit.answer.kind === "choice" ? { kind: "choice", choice: ask.choices.find((c) => bare(c) === bare((hit.answer as { choice: string }).choice)) ?? hit.answer.choice, ...(hit.answer.note ? { note: hit.answer.note } : {}) } : hit.answer;
      const r = await sc.submitAnswer(ask.id, answer, undefined, hit, pre);
      if (r.status === 200 && !(r.body as AskAnswerResult).already) {
        writePolicies(sc.db, recordUse(readPolicies(sc.db), hit.id, { at: Date.now(), askId: ask.id, taskId: ask.task?.id ?? null, issue: ask.issue?.number ?? null, subject }));
      }
    }
  }).catch((e) => console.warn(`policies: not applied (${String((e as Error).message ?? e)})`));
  return sc.applying;
};

/**
 * An answer that is saved as a policy too: the policy is checked first (a refusal is 409 and nothing is written or
 * sent), the answer goes the usual way, and only an answer that was written saves it.
 */
export const answerWithPolicy = async (sc: Pick<ServerContext, "currentAsks" | "answerAsk" | "db" | "opts" | "UPSTREAM_FAILED" | "approval">, id: string, answer: AskAnswer, input: PolicyInput): Promise<{ status: number; body: object }> => {
  const { asks } = await sc.currentAsks();
  const ask = asks.find((a) => a.id === id);
  // a question that is gone or not open is answerAsk's 409
  if (!ask || (ask.state !== "open" && ask.state !== "held")) return sc.answerAsk(id, answer);
  const refuse = (error: string) => ({ status: 409, body: { error, changes: [error], current: ask } satisfies AskChanged });
  if (!ask.policy.scopes.length) return refuse(ask.policy.note ?? "この問いは方針にできません");
  if (!ask.policy.scopes.includes(input.scope)) return refuse(ask.policy.note ?? "この範囲では保存できません");
  let pre: { pr: number; facts: PrFacts } | null = null;
  let subject = ask.subject;
  if (subject && ask.place?.pr) {
    const ws = ask.workspace ? sc.db.getWorkspace(ask.workspace.id) : null;
    const source = ws ? sc.db.getWorkspaceBacklogSource(ws.id) : null;
    if (ws && source) {
      try {
        const facts = await prFacts(sc.opts.gh ?? runGh, ws.path, source.repository, ask.place.pr, ask.at);
        pre = { pr: ask.place.pr, facts };
        subject = { ...subject, head: facts.head, conditions: facts.mergeAsk ? [...subject.conditions, { key: "merge-ask", value: facts.mergeAsk }] : subject.conditions };
      } catch (e) {
        return { status: sc.UPSTREAM_FAILED, body: { error: `PR #${ask.place.pr} を確かめられない: ${String((e as Error).message ?? e)}` } };
      }
    }
  }
  const confirmHit = subject ? sc.approval.confirmOf(ask.workspace?.id ?? null, subject.kind, subject.op, subject.target) : null;
  const checked = checkPolicy(input, { subject, workspaceId: ask.workspace?.id ?? null, pbi: policyPbi(ask), askId: id, answer, confirmHit, runnerRefusal: ask.blockers.some((b) => b.kind === "runner"), now: Date.now() });
  if (!checked.ok) return refuse(checked.error);
  const r = await sc.answerAsk(id, answer, pre);
  const body = r.body as AskAnswerResult;
  if (r.status !== 200 || body.already || body.ask?.state !== "answered") return r;
  const saved: AnswerPolicy = { ...checked.policy, id: `pol_${crypto.randomUUID().slice(0, 12)}`, uses: [], useCount: 0, firstUsedAt: null };
  writePolicies(sc.db, [...readPolicies(sc.db), saved]);
  return { status: 200, body: { ...body, policy: saved } satisfies AskAnswerResult };
};

/**
 * A `## 判断待ち` just stored on Issue `n` that says 推奨で進める although the work may not go on from it
 * (`storedProceedRefusal`: the table, the stop words, the kind against the question's place): the question waits for
 * the person as one labelled `needs-decision` does, and the stage Task at work on its PBI stops here when it is the
 * one that posted the question — its turn is ended and what it had planned by itself is dropped, with a line in its
 * log that says why. The person's answer on the Issue starts the next stage Task, as after any question that waits.
 * Returns the reason, or null when nothing is held.
 * `from`: the Task the comment's request was proved to come from (`callingTask`: `ops-kit backlog comment` sends its
 * Task's proof), never the sender a request's body names. The stage Task is stopped only when it is that Task: a
 * question another Task, the person or a bare call wrote on the Issue waits for the person all the same, but it is not
 * this Task's question, and a comment is no way to end another Task's turn. A request without the proof stops none
 * (the Task is then told by the command's output only).
 */
export const stopForRefusedProceed = (sc: Pick<ServerContext, "db" | "tasks">, ws: Workspace, n: number, text: string, from?: string): string | null => {
  if (!text.trimStart().startsWith(DECISION_HEADING)) return null;
  const refused = storedProceedRefusal(sc.db, ws, n, text);
  if (!refused) return null;
  const t = sc.db.activeStageTask(ws.id, refused.pbi);
  if (t && t.id === from) {
    sc.tasks.record(t.id, { t: "status", text: `#${n} の問いは「推奨で進める」では進められません（${refused.why}）。止めて待つ問いとして判断待ちに出したので、この Task はここで止めます。回答が来たら次の工程 Task が続けます。` });
    // after the answer to this request is on its way: the caller may be this Task's own command
    setTimeout(() => void sc.tasks.abort(t.id).catch((e) => console.error(`[asks] task ${t.id} was not stopped at its question: ${String((e as Error)?.message ?? e)}`)), 0);
  }
  return refused.why;
};

/**
 * Answers one question of a Task: a tool approval through the Task's pending permission, a check or a stop of a
 * Task with no Issue as the person's reply — the reply is its record and its resume. A Task's question reads no PR: the
 * Task checks what it stopped at again when it goes on (a merge goes through merge-gate again). A reply the Task refuses
 * (its budget) is not sent: the question stays open, its resume failed.
 */
export const answerTask = async (sc: Pick<ServerContext, "tasks" | "noteMergeGrant" | "db" | "policyGone" | "basisLine">, id: string, ask: Ask, answer: AskAnswer, by: AnswerPolicy | null = null, via: "screen" | "api" = "api"): Promise<{ status: number; body: object }> => {
  const taskId = ask.task!.id;
  const changed = (error: string, changes: string[]) => ({ status: 409, body: { error, changes, current: ask } satisfies AskChanged });
  if (!ask.answers.includes(answer.kind) || (answer.kind === "choice" && !ask.choices.includes(answer.choice))) return changed("選択肢が変わりました", ["選択肢が変わりました"]);
  // a question tool's questions are answered all at once, each with what it offers now
  const toQuestions = answer.kind === "questions" ? questionsReply(ask.questions, answer.answers) : null;
  if (answer.kind === "questions" && toQuestions === null) return changed("選択肢が変わりました", ["選択肢が変わりました"]);
  const at = Date.now();
  const result = (state: Ask["state"], resume: Ask["resume"]): { status: number; body: AskAnswerResult } => ({ status: 200, body: { ask: { ...ask, state, changedAt: at, answers: state === "answered" ? [] : ask.answers, resume }, already: false, changes: [] } });
  if (ask.kind === "approval") {
    try {
      const t = sc.tasks.respondPermission(taskId, id.slice(`approval:${taskId}:`.length), answer.kind === "allow" ? "allow" : "deny");
      return result("answered", resumeOfTask({ task: t, repliedAt: at, failure: null }));
    } catch {
      return changed("承認は既に答えられたか、Task が終わりました", ["承認は既に答えられたか、Task が終わりました"]);
    }
  }
  // a grant goes as it is, once: the person's say on the refused operation, no policy basis
  if (answer.kind === "grant") {
    if (!ask.grant) return { status: 409, body: { error: "許可文がありません" } };
    try {
      // `via`: whether the request looked like the screen's (routes/asks.ts); the sentence itself is the one the Task wrote in its stop
      await sc.noteMergeGrant(taskId, ask.grant, { via });
      const t = await sc.tasks.send(taskId, ask.grant);
      return result("answered", resumeOfTask({ task: t, repliedAt: at, failure: null }));
    } catch (e) {
      const failure = { at, reason: String((e as Error).message ?? e) };
      sc.db.rememberAskAnswer(id, { at, failure });
      return result(ask.state, { state: "failed", reason: failure.reason, taskId, at });
    }
  }
  const text = answer.kind === "choice" ? `${answer.choice}${answer.note ? `\n\n${answer.note}` : ""}` : answer.kind === "text" ? answer.text : (toQuestions ?? "");
  const gone = sc.policyGone(by);
  if (gone) return changed(gone, [gone]);
  try {
    if (!by) await sc.noteMergeGrant(taskId, text, { via }); // chosen on the answer route; an answer a saved policy made is not the person's grant
    const t = await sc.tasks.send(taskId, by ? `${sc.basisLine(by, ask.subject)}\n\n${text}` : text);
    return result("answered", resumeOfTask({ task: t, repliedAt: at, failure: null }));
  } catch (e) {
    const failure = { at, reason: String((e as Error).message ?? e) };
    sc.db.rememberAskAnswer(id, { at, failure });
    return result(ask.state, { state: "failed", reason: failure.reason, taskId, at });
  }
};

export function setupAsks(sc: Pick<ServerContextInit, "headMisses" | "batchAnswers" | "tasks" | "db" | "currentAsks" | "deviceAuths" | "answering" | "applying">): void {
  sc.headMisses = new Map<string, NonNullable<Ask["policy"]["previous"]>>();
  /** One login / one approval for the Tasks of a batch. */
  sc.batchAnswers = new BatchAnswers({
    // the person approved this Task's own operation: not copied to a shadow running alongside it
    send: (taskId, text) => sc.tasks.send(taskId, text, { mirror: false }),
    task: (id) => sc.db.getTask(id),
    stopRecords: (id) => sc.db.listStopRecords([id]),
    batches: async () => (await sc.currentAsks()).batches,
    deviceAuth: (id) => sc.deviceAuths.get(id),
  });
  /** An answer being written, by the question's id: a second answer to the same question waits for it. */
  sc.answering = new Map<string, Promise<{ status: number; body: object }>>();

  /**
   * Answers the open questions a saved policy matches, through the same answer as the screen's, with the policy and
   * its basis written with it. Run when a Task's turn ends and when backlog-next fires; never on a timer of its own. A
   * question the policy does not match, or whose answer is refused (changed, GitHub down), stays the person's.
   */
  sc.applying = Promise.resolve();
}
