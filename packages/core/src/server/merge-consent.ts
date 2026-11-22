import type { AgentEvent, RunnerId, Task } from "@switchboard/protocol";
import { OWNER, type MergeGrantKind } from "../merge-grants.ts";
import { consentCandidates, grantsFor, readConsent, requestedGrants } from "../merge-consent.ts";
import { ledgerRowFor } from "../pricing.ts";
import type { ServerContext } from "./context.ts";

/**
 * The longest a check waits for a read, whatever the setting says: under the 120 s after which the server drops a
 * response that sends nothing (`IDLE_TIMEOUT_SECONDS`), so the check gets an answer rather than a cut connection, and
 * under the 150 s the kit waits.
 */
export const CONSENT_WAIT_CAP_MS = 110_000;

/**
 * The repositories a Task's own grants are for: the name its workspace's backlog goes by (what the kit's backlog
 * commands and the merge gate ask with; a backlog kept here only has a name of its own), and, where that is not a GitHub
 * repository, the directory's origin. Lower case; empty when the Task has neither.
 */
export const ownReposOf = (sc: Pick<ServerContext, "db" | "originRepoOf">, task: Pick<Task, "workspaceId" | "cwd">): string[] => {
  const source = task.workspaceId ? sc.db.getWorkspaceBacklogSource(task.workspaceId) : null;
  const origin = source && source.service !== "switchboard" ? null : sc.originRepoOf(task.cwd);
  return [...new Set([source?.repository, origin].flatMap((r) => (r ? [r.toLowerCase()] : [])))];
};

type ConsentContext = Pick<ServerContext, "db" | "originRepoOf" | "grantHeadOf" | "adapterMap" | "settings" | "runnerChoice" | "suggestDir" | "judgeStop" | "tasks" | "pendingConsent" | "pricingTable" | "loginKindOf">;

/** How long the check waits for the read of `taskId`'s reply: twice the setting's turn time (the configured runner, then the fallback), up to `CONSENT_WAIT_CAP_MS`. */
export const consentWaitMs = (sc: Pick<ServerContext, "settings">): number => Math.min(2 * sc.settings().judgeAndChoice.judgeTimeoutMs, CONSENT_WAIT_CAP_MS);

const SAID: Record<MergeGrantKind, (n: number) => string> = {
  merge: (n) => `PR #${n} を判定の外でマージ`,
  answer: (n) => `PR #${n} に [merge-answer] yes を投稿`,
};

/**
 * Reads the grants in a text the person sent that holds no fixed sentence (`readConsent`) and records them as the
 * person's, for the task's own repositories only. The caller does not wait: the read is kept in `pendingConsent` for the
 * check in front of `gh` (`GET /api/merge-grants`) to wait for, and a text sent while one is running is read after it.
 * A merge / answer grant holds for the head its PR had when the text came in. What was recorded, or that nothing could
 * be read, is one line in the task's conversation; a text that grants nothing says nothing.
 */
export function noteConsent(sc: ConsentContext, task: Task, text: string): Promise<void> {
  const asked = sc.db.lastReplyText(task.id) ?? "";
  // the grant is given when the reply comes in, not when the reader answers
  const said = Date.now();
  // what the task asked for, to put to the reader: the fixed sentences in the reply this text answers. Stop records are not
  // read (which of them the person is answering cannot be told from them); a stop reported outside the reply's text leaves
  // the reader with the reply's own words
  const requested = requestedGrants([asked]);
  const candidates = consentCandidates(text, asked);
  const repos = ownReposOf(sc, task);
  if (!candidates.length || !repos.length) return Promise.resolve();
  // the heads as of now, before the read: a commit pushed while the reader answers is not granted
  const heads = new Map<string, Promise<string | null>>();
  for (const repo of repos) for (const n of candidates) heads.set(`${repo}#${n}`, sc.grantHeadOf(task, repo, n).catch(() => null));
  const run = async (): Promise<void> => {
    const say = (text: string) => sc.tasks.record(task.id, { t: "status", text });
    const why = (e: unknown) => String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 120);
    let grants: Awaited<ReturnType<typeof readConsent>>;
    try {
      const cfg = sc.settings().judge;
      const jc = sc.settings().judgeAndChoice;
      const onUsage = (runner: RunnerId, ev: Extract<AgentEvent, { t: "usage" }>) => {
        if (!sc.judgeStop.signal.aborted) sc.db.insertLedger(ledgerRowFor(sc.pricingTable(), { id: task.id, runner, model: ev.model ?? null }, ev, Date.now(), sc.loginKindOf(runner)));
      };
      grants = grantsFor(await readConsent({ said: text, asked, requested }, { adapters: sc.adapterMap, settings: { ...cfg, ...sc.runnerChoice(cfg.runner, cfg.model, cfg.effort) }, cwd: sc.suggestDir, onUsage, log: (m) => console.warn(m), signal: sc.judgeStop.signal, fallback: sc.runnerChoice(jc.judgeFallbackRunner, jc.judgeFallbackModel, jc.judgeFallbackEffort), timeoutMs: jc.judgeTimeoutMs }));
    } catch (e) {
      if (!sc.judgeStop.signal.aborted) say(`返信から許可を読めませんでした（${why(e)}）。決まった文でも送れます`);
      return;
    }
    if (sc.judgeStop.signal.aborted || !grants.length) return;
    try {
      const rows = await Promise.all(repos.flatMap((repo) => grants.map(async (g) => ({ taskId: task.id, repo, kind: g.kind, target: g.target, by: OWNER, head: (await heads.get(`${repo}#${g.target}`)) ?? undefined }))));
      // a merge / answer row whose head could not be read answers for no head, and written it would take the place of an
      // earlier grant of the same kind that has one: it is said in the line below and not recorded
      sc.db.recordMergeGrants(rows.filter((r) => r.head), said);
      const lines = grants.map((g) => {
        const head = rows.find((r) => r.kind === g.kind && r.target === g.target)?.head;
        return `${SAID[g.kind](g.target)}（${head ? `head ${head.slice(0, 7)}` : "head を読めず、まだ通りません"}）`;
      });
      say(`返信を許可として記録しました: ${lines.join("、")}`);
    } catch (e) {
      // read, but the record failed: said as such, not as a read that failed
      if (!sc.judgeStop.signal.aborted) say(`返信から読んだ許可を記録できませんでした（${why(e)}）。決まった文でも送れます`);
    }
  };
  const after = sc.pendingConsent.get(task.id) ?? Promise.resolve();
  const mine: Promise<void> = after.then(run, run).finally(() => {
    if (sc.pendingConsent.get(task.id) === mine) sc.pendingConsent.delete(task.id);
  });
  sc.pendingConsent.set(task.id, mine);
  return mine;
}
