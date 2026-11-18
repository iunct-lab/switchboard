import type { RunnerId, AgentEvent, Task, TaskEvals } from "@switchboard/protocol";
import { judgeTurn } from "../judge.ts";
import { personMessages, RULES_BY, rulesEvalOf, stageRequestOf } from "../evals.ts";
import { judgeRubric, trustedNamedSkills } from "../rubric-judge.ts";
import { ledgerRowFor } from "../pricing.ts";
import { storedIssueReader } from "../backlog-stored.ts";
import { IN_FLIGHT, TURN_DONE } from "../task-status.ts";
import type { ServerContext } from "./context.ts";

/**
 * Evals: the rules row is counted at each turn's end (below); a task without one — from before rule metrics were counted, or
 * read while its first turn runs — is counted now and the row kept, so the list never reads every task's
 * events. A Cloud task has no events here and is not evaluated.
 */
export const countRules = (sc: Pick<ServerContext, "db">, t: Task) => {
  const row = { taskId: t.id, source: "rules" as const, by: RULES_BY, rubric: null, json: rulesEvalOf(t, sc.db.listEvents(t.id), sc.db.taskCost(t.id)), ts: Date.now() };
  sc.db.upsertEval(row);
  return row.json;
};

export const evalsFor = (sc: Pick<ServerContext, "db" | "countRules">, t: Task): TaskEvals => {
  if (t.executionMode === "cloud") return { ...sc.db.evalsOf(t.id), rules: null }; // no events here to count; the person may still rate it
  const stored = sc.db.evalsOf(t.id);
  const rules = stored.rules ?? sc.countRules(t);
  // status, outcome and cost move after the turn's end (the judge, the person, a process that dies without a session.end): the task's own values win over the row's snapshot
  return { ...stored, rules: { ...rules, status: t.status, outcome: t.outcome, costUsd: sc.db.taskCost(t.id).costUsd } };
};

export const judgeReply = (sc: Pick<ServerContext, "settings" | "db" | "judgeStop" | "pricingTable" | "loginKindOf" | "opts" | "adapterMap" | "runnerChoice" | "suggestDir" | "broadcast" | "applyPolicies" | "queueTaskFreed">, taskId: string, t: Task, lastReply: string, at: number) => {
  const cfg = sc.settings().judge;
  const jc = sc.settings().judgeAndChoice;
  sc.db.updateTask(taskId, { judgingAt: at, updatedAt: t.updatedAt });
  const onUsage = (runner: RunnerId, ev: Extract<AgentEvent, { t: "usage" }>) => {
    if (!sc.judgeStop.signal.aborted) sc.db.insertLedger(ledgerRowFor(sc.pricingTable(), { id: taskId, runner, model: ev.model ?? null }, ev, Date.now(), sc.loginKindOf(runner)));
  };
  const said = sc.db.judgeContext(taskId);
  void (sc.opts.judge ?? judgeTurn)({ title: t.title, prompt: said.firstRequest ?? "", lastReply, ...(said.lastRequest ? { lastRequest: said.lastRequest } : {}), ...(said.previousReply ? { previousReply: said.previousReply } : {}) }, { adapters: sc.adapterMap, settings: { ...cfg, ...sc.runnerChoice(cfg.runner, cfg.model, cfg.effort) }, cwd: sc.suggestDir, onUsage, log: (m) => console.warn(m), signal: sc.judgeStop.signal, fallback: sc.runnerChoice(jc.judgeFallbackRunner, jc.judgeFallbackModel, jc.judgeFallbackEffort), timeoutMs: jc.judgeTimeoutMs })
    .then((j) => {
      if (sc.judgeStop.signal.aborted) return;
      const cur = sc.db.getTask(taskId);
      // a turn has started since: this judges a reply that is no longer the last one
      if (!cur || cur.judgingAt !== at || !TURN_DONE.has(cur.status)) return;
      // updatedAt stays: like 確認済み, a judgement is not activity and must not move the task in the list
      const next = sc.db.updateTask(taskId, { judgedResult: j.result, judgedReason: j.reason, judgedBy: `${j.runner}:${j.model}`, judgingAt: null, ...(cur.outcome === "unknown" ? { outcome: j.result } : {}), updatedAt: cur.updatedAt });
      if (next) sc.broadcast({ type: "task.updated", task: next });
      void sc.applyPolicies();
    })
    .catch((e) => {
      if (!sc.judgeStop.signal.aborted) console.warn(`judge: task ${taskId} is left unjudged (${String((e as Error).message ?? e)})`);
    })
    .finally(() => {
      // stopped with the daemon: the mark stays, so the next start judges this reply again
      if (sc.judgeStop.signal.aborted) return;
      const cur = sc.db.getTask(taskId);
      if (cur?.judgingAt === at) sc.db.updateTask(taskId, { judgingAt: null, updatedAt: cur.updatedAt });
      sc.queueTaskFreed(taskId, "judged");
    });
};

export const judgeEvals = (sc: Pick<ServerContext, "rubricSeqNext" | "rubricSeq" | "judgeStop" | "db" | "pricingTable" | "loginKindOf" | "countRules" | "settings" | "opts" | "rubric" | "trustedSkills" | "adapterMap" | "runnerChoice" | "suggestDir" | "broadcast">, taskId: string, t: Task) => {
  const seq = ++sc.rubricSeqNext;
  sc.rubricSeq.set(taskId, seq);
  const onUsage = (runner: RunnerId, ev: Extract<AgentEvent, { t: "usage" }>) => {
    if (!sc.judgeStop.signal.aborted) sc.db.insertLedger(ledgerRowFor(sc.pricingTable(), { id: taskId, runner, model: ev.model ?? null }, ev, Date.now(), sc.loginKindOf(runner)));
  };
  const metrics = (sc.db.evalsOf(taskId).rules ?? sc.countRules(t)).metrics;
  const events = sc.db.listEvents(taskId);
  const lastSeq = events[events.length - 1]?.seq ?? 0;
  const jc = sc.settings().judgeAndChoice;
  void (sc.opts.rubricJudge ?? judgeRubric)({ title: t.title, prompt: sc.db.firstUserText(taskId) ?? "", later: personMessages(events.map((e) => e.ev)).slice(1), events: events.map((e) => e.ev), metrics, rubric: sc.rubric, skills: trustedNamedSkills(sc.db.firstUserText(taskId) ?? "", sc.trustedSkills), stage: stageRequestOf(t, storedIssueReader(sc.db), sc.settings().judge) }, { adapters: sc.adapterMap, settings: { ...sc.settings().judge, ...sc.runnerChoice(sc.settings().judge.runner, sc.settings().judge.model, sc.settings().judge.effort) }, cwd: sc.suggestDir, onUsage, log: (m) => console.warn(m), signal: sc.judgeStop.signal, fallback: sc.runnerChoice(jc.judgeFallbackRunner, jc.judgeFallbackModel, jc.judgeFallbackEffort) })
    .then((j) => {
      if (sc.judgeStop.signal.aborted) return;
      const cur = sc.db.getTask(taskId);
      if (!cur || sc.rubricSeq.get(taskId) !== seq) return; // deleted, or a newer scoring took over (that one answers the screen)
      // a turn in flight, or a message the person sent since: this scored a transcript that is no longer the task's. (a status
      // event — a model or mode change, a shadow's error — is not a new transcript; the turn judge keeps its row then too)
      const stale = IN_FLIGHT.has(cur.status) || sc.db.listEvents(taskId, lastSeq).some((e) => e.ev.t === "message.delta" && e.ev.role === "user");
      if (!stale) sc.db.upsertEval({ taskId, source: "judge", by: j.by, rubric: j.rubric, json: j, ts: j.ts });
      sc.broadcast({ type: "evals.updated", taskId }); // also when dropped: the screen's 再評価 is waiting on it
    })
    .catch((e) => {
      if (sc.judgeStop.signal.aborted) return;
      console.warn(`rubric judge: task ${taskId} is left unscored (${String((e as Error).message ?? e)})`);
      // the screen's 再評価 waits on this message; the row it reads back is the previous one (or none)
      sc.broadcast({ type: "evals.updated", taskId });
    })
    .finally(() => {
      if (sc.rubricSeq.get(taskId) === seq) sc.rubricSeq.delete(taskId);
    });
};
