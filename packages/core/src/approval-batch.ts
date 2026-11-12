import type { Ask, AskAnswer, AskBatch, AskBatchResult, DeviceAuthView, StopRecord, Task } from "@switchboard/protocol";
import { IN_FLIGHT, TURN_DONE } from "./task-status.ts";
import { stopKey } from "./stops.ts";

/**
 * SSO logins and refused deploys across Tasks (#2046, docs/design/asks.md): each Task stopped on one of them shows once in
 * a batch of its kind, so one login or one approval moves them all. A batch only bundles the questions — each stop stays
 * its own question, answered or folded as before (dedupeAsks).
 */

/** A permission stop is a deploy when its op or target (lower-cased) has one of these. A fixed list, not a setting. */
export const DEPLOY_WORDS = ["promote", "昇格", "sam deploy", "cloudformation", "changeset", "変更セット", "iam", "deploy", "配置"];

export type BatchKind = AskBatch["kind"];

/** An open merge check whose stop reasons (the `[聞く]` lines under `**止めた場所**:`) include a security one: the person alone settles it. */
export function isSecurityMergeCheck(a: Ask): boolean {
  return a.kind === "check" && a.state === "open" && !!a.place?.pr && !!a.task && a.place.reasons.some((r) => r.startsWith("[聞く] セキュリティ"));
}

/**
 * The choice of a merge check that says to merge: the first whose text after its mark (`A: マージする — …`) starts with
 * 「マージする」, as the choice line is (what a click on it sends, so answerAsk takes it). 「マージしない」 and 「待つ」 do
 * not match. null = it has none, so the batch cannot answer it.
 */
export function mergeChoiceOf(a: Ask): string | null {
  return a.choices.find((c) => /^[A-Za-z0-9]+\s*[:：.．)）]\s*マージする/.test(c)) ?? null;
}

/** sso = an SSO login wait, deploy = a deploy the runner refused; null = neither, or resolved. */
export function batchKindOf(s: Pick<StopRecord, "reason" | "op" | "target" | "state">): BatchKind | null {
  if (s.state === "resolved") return null;
  if (s.reason === "auth") return "sso";
  if (s.reason !== "permission") return null;
  const text = `${s.op} ${s.target}`.toLowerCase();
  return DEPLOY_WORDS.some((w) => text.includes(w)) ? "deploy" : null;
}

/** A Task that runs a turn, waits on a tool approval (a turn sent now would end it as denied), or was stopped, waits on no batch. */
const NOT_WAITING = new Set<Task["status"]>([...IN_FLIGHT, "aborted"]);

/**
 * The Task's newest stop (by when it stopped) when it waits on the person: open (waiting / exhausted — not one retrying
 * by itself) and not answered since it stopped. Only an answer the daemon saw counts (`seq:`, as `reduceStops`: a reply of
 * the person's answers every open stop of its Task, tasks.ts `send`); a runner's pointer to a comment does not, and a stop
 * again at the same place carries the earlier answer (`recordStop`), older than the stop. A newer stop of any kind, even
 * resolved, means the Task went on past it.
 */
function waitingStop(records: StopRecord[]): { stop: StopRecord; at: number } | null {
  const newest = eachStop(records).at(-1);
  if (!newest) return null;
  const { stop: r, stoppedAt } = newest;
  const answered = !!r.answer && r.answer.ref.startsWith("seq:") && r.answer.at >= stoppedAt;
  return (r.state === "waiting" || r.state === "exhausted") && !answered ? newest : null;
}

/**
 * Each stop's newest record, when it first stopped (`at`) and when it last did (`stoppedAt`: its newest record that did not
 * only add an answer — the runner reporting it again), oldest stop first.
 */
function eachStop(records: StopRecord[]): { stop: StopRecord; at: number; stoppedAt: number }[] {
  const out = new Map<string, { stop: StopRecord; at: number; stoppedAt: number }>();
  for (const r of [...records].sort((a, b) => a.at - b.at)) {
    const had = out.get(r.id);
    const answerOnly = !!had && r.answer?.ref !== had.stop.answer?.ref;
    out.set(r.id, { stop: r, at: had?.at ?? r.at, stoppedAt: answerOnly ? had.stoppedAt : r.at });
  }
  return [...out.values()].sort((a, b) => a.at - b.at);
}

/**
 * The batches of these Tasks' stop records (each Task's own): per Task its newest stop, when it waits on the person and is
 * sso / deploy; per kind one batch, oldest Task first, none for a kind with no Task. A shadow waits on nothing either.
 * `asks` = the questions as listed, for the one each Task shows as (its stop, or the check it folded into).
 */
export function approvalBatches(entries: { task: Task; records: StopRecord[] }[], asks: Ask[]): AskBatch[] {
  const lists: Record<BatchKind, AskBatch["asks"]> = { sso: [], deploy: [], "security-merge": [] };
  for (const { task, records } of [...entries].sort((a, b) => a.task.createdAt - b.task.createdAt)) {
    if (NOT_WAITING.has(task.status) || task.shadowOf) continue;
    const newest = waitingStop(records);
    const kind = newest ? batchKindOf(newest.stop) : null;
    if (!newest || !kind) continue;
    const id = `stop:${stopKey(newest.stop).replaceAll("\u0000", "|")}`;
    const shown = asks.find((a) => a.id === id) ?? asks.find((a) => a.task?.id === task.id && a.state === "open" && (a.kind === "stop" || a.kind === "check"));
    lists[kind].push({ askId: shown?.id ?? id, taskId: task.id, title: task.title, workspaceId: task.workspaceId, op: newest.stop.op, at: newest.at });
  }
  // the merge checks that stopped on a security `[聞く]`, across workspaces, oldest stop first
  for (const a of [...asks].sort((x, y) => x.at - y.at))
    if (isSecurityMergeCheck(a)) lists["security-merge"].push({ askId: a.id, taskId: a.task!.id, title: a.task!.title ?? a.task!.id, workspaceId: a.workspace?.id ?? null, op: `PR #${a.place!.pr}`, at: a.at, pr: a.place!.pr, reasons: a.place!.reasons, diff: a.place!.diff });
  return (["sso", "deploy", "security-merge"] as const).filter((k) => lists[k].length > 0).map((k) => ({ id: `batch:${k}` as const, kind: k, asks: lists[k], loggingIn: null, deviceAuth: null }));
}

/** What the SSO batch's one Task is sent: it logs in for all of them (the runners share the host's SSO cache, docs/design/device-auth.md). */
export const SSO_RESUME_TEXT = "利用者がまとめてログインを始めました。device-auth で SSO にログインしてから続けてください。";
/** What the others are sent once that Task went on. */
export const SSO_REST_TEXT = "ほかの Task で SSO のログインが済みました。続けてください。";
/** What a Task the person chose in the deploy batch is sent: the person's approval of its own operation, nothing more. */
export const deployApprovedText = (op: string) => `利用者が ${op} を承認しました。続けてください。`;

export interface BatchDeps {
  send: (taskId: string, text: string) => Promise<unknown>;
  task: (taskId: string) => Task | null;
  stopRecords: (taskId: string) => StopRecord[];
  /** The batches as GET /api/asks lists them now (decorated). */
  batches: () => Promise<AskBatch[]>;
  deviceAuth: (taskId: string) => DeviceAuthView | null;
  /** The question as listed now (null = gone). */
  ask: (askId: string) => Promise<Ask | null>;
  /** One answer to one question, the same as the screen's (its head check and its once-only included). */
  answerAsk: (askId: string, answer: AskAnswer) => Promise<{ status: number; body: object }>;
}

/** What became of one Task's merge check in the security-merge batch: sent = its "merge" went; changed = the question or its PR changed (409), nothing sent; already = answered before; failed = anything else. */
export type MergeResult = { taskId: string; result: "sent" | "changed" | "already" | "failed"; detail?: string };
type Answered = { status: number; body: AskBatchResult | { results: MergeResult[]; batch: AskBatch | null } | { error: string } };

/**
 * The answers to a batch (#2046). sso: one click sends the batch's oldest Task on to log in, and once its turn ends
 * without a new login stop the rest are sent on — the wait for that is `pendingSso`, memory only (a restart forgets it;
 * the rest stay in the batch, and one more click starts again). deploy: each Task the person chose is sent its approval
 * once; the others wait. Nothing is saved as a policy, and nothing is sent that the person did not press.
 */
export class BatchAnswers {
  /** `at` = when `first` was sent on: a login stop reported from then on (not the answer the send itself wrote) is a new one. */
  pendingSso: { first: string; rest: string[]; at: number } | null = null;
  /** One answer at a time: each reads the batch after the one before sent its turns, so a Task is sent once. */
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private deps: BatchDeps) {}

  answer(id: string, taskIds: string[] | undefined, askIds?: string[]): Promise<Answered> {
    const run = this.queue.then(() => this.answerNow(id, taskIds, askIds));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async answerNow(id: string, taskIds: string[] | undefined, askIds: string[] | undefined): Promise<Answered> {
    const batch = (await this.deps.batches()).find((b) => b.id === id);
    if (id === "batch:sso") {
      if (this.pendingSso) return { status: 200, body: { sent: [], already: true, batch: batch ?? null } };
      if (!batch || batch.asks.length === 0) return { status: 409, body: { error: "SSO のログイン待ちの Task はもうありません" } };
      const [first, ...rest] = batch.asks.map((a) => a.taskId);
      const p = (this.pendingSso = { first: first!, rest, at: Date.now() });
      try {
        await this.deps.send(first!, SSO_RESUME_TEXT);
      } catch (e) {
        if (this.pendingSso === p) this.pendingSso = null;
        return { status: 500, body: { error: `続きを送れませんでした: ${String((e as Error).message ?? e)}` } };
      }
      return { status: 200, body: { sent: [first!], already: false, batch: (await this.deps.batches()).find((b) => b.id === id) ?? null } };
    }
    if (id === "batch:security-merge") return this.securityMerge(batch, taskIds, askIds);
    if (id !== "batch:deploy") return { status: 400, body: { error: `unknown batch: ${id}` } };
    if (!taskIds?.length) return { status: 400, body: { error: "承認する Task を選んでください" } };
    if (!batch) return { status: 409, body: { error: "配備の承認待ちの Task はもうありません" } };
    const chosen = taskIds.map((t) => batch.asks.find((a) => a.taskId === t));
    if (chosen.some((a) => !a)) return { status: 400, body: { error: "まとまりに無い Task があります" } };
    const sent: string[] = [];
    for (const a of new Set(chosen)) {
      await this.deps.send(a!.taskId, deployApprovedText(a!.op));
      sent.push(a!.taskId);
    }
    return { status: 200, body: { sent, already: false, batch: (await this.deps.batches()).find((b) => b.id === id) ?? null } };
  }

  /**
   * security-merge: only the Tasks the person chose are sent "merge", each through the one-question answer (a PR that moved
   * since the question is its 409, and the others still go). `askIds` (same order as `taskIds`) = the question the screen
   * showed for each (required): a Task whose question is not that one by now is `changed` and nothing is sent to it, the
   * other rows still go. Nothing is chosen by
   * default, and nothing is saved as a policy.
   */
  private async securityMerge(batch: AskBatch | undefined, taskIds: string[] | undefined, askIds: string[] | undefined): Promise<Answered> {
    if (!taskIds?.length) return { status: 400, body: { error: "マージする Task を選んでください" } };
    if (!askIds || askIds.length !== taskIds.length) return { status: 400, body: { error: "askIds は taskIds と同じ数・同じ並びで送ってください" } };
    if (new Set(taskIds).size !== taskIds.length) return { status: 400, body: { error: "同じ Task が 2 回あります" } };
    const chosen: { taskId: string; askId: string; choice: string; stale: boolean }[] = [];
    for (const [i, t] of taskIds.entries()) {
      // no batch any more (the last one answered elsewhere) is the same: each row is changed
      const entry = batch?.asks.find((a) => a.taskId === t);
      // the question the screen showed is gone (answered, asked again, left the batch): that row only is changed
      if (!entry || entry.askId !== askIds[i]) {
        chosen.push({ taskId: t, askId: askIds[i]!, choice: "", stale: true });
        continue;
      }
      const choice = await this.deps.ask(entry.askId).then((a) => (a ? mergeChoiceOf(a) : null));
      if (!choice) return { status: 400, body: { error: `「マージする」を選べない Task があります: ${t}` } };
      chosen.push({ taskId: t, askId: entry.askId, choice, stale: false });
    }
    const results: MergeResult[] = [];
    for (const c of chosen) {
      if (c.stale) {
        results.push({ taskId: c.taskId, result: "changed", detail: "問いが変わったか、もう答えられています（画面が見ていた問いと違います）" });
        continue;
      }
      const r = await this.deps.answerAsk(c.askId, { kind: "choice", choice: c.choice });
      const body = r.body as { already?: boolean; error?: string; ask?: { resume?: { state?: string; reason?: string } | null } };
      // a reply the Task refuses (its budget) is still 200: the question stays open, its resume failed — nothing was sent
      if (r.status === 200 && body.ask?.resume?.state === "failed") results.push({ taskId: c.taskId, result: "failed", detail: body.ask.resume.reason });
      else if (r.status === 200) results.push({ taskId: c.taskId, result: body.already ? "already" : "sent" });
      else results.push({ taskId: c.taskId, result: r.status === 409 ? "changed" : "failed", detail: body.error });
    }
    return { status: 200, body: { results, batch: (await this.deps.batches()).find((b) => b.id === "batch:security-merge") ?? null } };
  }

  /**
   * A Task's turn ended: when it is the one sent to log in, the wait is over. It went on (done, no login stop since it
   * was sent) → the rest still in the batch are sent on; still stopped on the login, or failed → nothing (they stay).
   */
  async turnEnded(taskId: string): Promise<string[]> {
    const p = this.pendingSso;
    if (!p || p.first !== taskId) return [];
    // the batch says who logs in until the rest are sent: the screen reads it again only while it does
    try {
      const status = this.deps.task(taskId)?.status;
      if (!status || !TURN_DONE.has(status) || loginStopSince(this.deps.stopRecords(taskId), p.at)) return [];
      const waiting = new Set((await this.deps.batches()).find((b) => b.id === "batch:sso")?.asks.map((a) => a.taskId) ?? []);
      const sent: string[] = [];
      for (const t of p.rest.filter((x) => waiting.has(x))) {
        // one that fails to send stays in the batch; the others still go on
        await this.deps.send(t, SSO_REST_TEXT).then(() => sent.push(t), () => {});
      }
      return sent;
    } finally {
      if (this.pendingSso === p) this.pendingSso = null;
    }
  }

  /** The batches with the SSO login going on: who logs in and its device code (kept while that Task's turn runs). */
  decorate(batches: AskBatch[]): AskBatch[] {
    const p = this.pendingSso;
    if (!p) return batches;
    const loggingIn = { taskId: p.first, title: this.deps.task(p.first)?.title ?? p.first };
    const sso = batches.find((b) => b.id === "batch:sso") ?? { id: "batch:sso" as const, kind: "sso" as const, asks: [], loggingIn: null, deviceAuth: null };
    const asks = sso.asks.filter((a) => a.taskId !== p.first);
    return [{ ...sso, asks, loggingIn, deviceAuth: this.deps.deviceAuth(p.first) }, ...batches.filter((b) => b.id !== "batch:sso")];
  }
}

/**
 * A login stop reported from `since` on (a new one, or the same one again — a record that only adds an answer, as the send
 * writes, is not a report) that is not resolved.
 */
const loginStopSince = (records: StopRecord[], since: number) => eachStop(records).some(({ stop: r, stoppedAt }) => r.reason === "auth" && stoppedAt >= since && r.state !== "resolved");

const KIND_TITLE: Record<BatchKind, string> = { sso: "SSO のログイン待ち", deploy: "配備の承認待ち", "security-merge": "セキュリティの確認待ちのマージ" };

/**
 * The once-a-day note of the batches still waiting (approval-window, #2046): its title has the count, its body a line per
 * Task under its batch. null = nothing waits (no note).
 */
export function approvalWindowNote(batches: AskBatch[]): { title: string; body: string } | null {
  // the note counts logins and deploys; the merge checks have their own card
  const shown = batches.filter((b) => b.asks.length > 0 && b.kind !== "security-merge");
  const n = shown.reduce((k, b) => k + b.asks.length, 0);
  if (n === 0) return null;
  const body = shown.map((b) => [`${KIND_TITLE[b.kind]}（${b.asks.length} 件）`, ...b.asks.map((a) => `- ${a.title} — ${a.op}`)].join("\n")).join("\n\n");
  return { title: `SSO・配備の承認待ち: ${n}`, body };
}

/**
 * The once-a-day note of the security merge checks still waiting (approval-window, #2792): only the checks that were waiting
 * when the schedule last fired count (a check that stops later waits for the next firing), and the note is that firing's
 * (`at` = the firing: one notice per firing, so one a day). Its title has the count and the longest wait (now minus the
 * oldest stop, rounded up to hours), its body a line per PR with its Task. null = not fired yet, or none of them waits.
 */
export function securityMergeNote(batches: AskBatch[], firedAt: number | null, now: number): { title: string; body: string; at: number } | null {
  if (firedAt === null) return null;
  const asks = batches.find((x) => x.kind === "security-merge")?.asks.filter((a) => a.at <= firedAt) ?? [];
  if (asks.length === 0) return null;
  const hours = Math.max(1, Math.ceil((now - Math.min(...asks.map((a) => a.at))) / 3_600_000));
  return { title: `セキュリティのマージ確認 ${asks.length} 件（最長 ${hours} 時間）— 判断待ちから答えられる`, body: asks.map((a) => `- ${a.op} — ${a.title}`).join("\n"), at: firedAt };
}
