import type { AgentEvent, RunnerId, Task } from "@switchboard/protocol";
import { OWNER, changeRepoOf } from "../merge-grants.ts";
import { CONSENT_CHARS, consentCandidates, readConsent, requestedGrants, type ConsentGrant } from "../merge-consent.ts";
import { ledgerRowFor } from "../pricing.ts";
import { gitlabTargetOf } from "../workspace-config.ts";
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
 * repository, the directory's origin; a GitLab checkout's is its project's path, the key the verdict asks for an MR with
 * (`repoKeyOf`). Lower case; empty when the Task has none.
 */
export const ownReposOf = (sc: Pick<ServerContext, "db" | "originRepoOf">, task: Pick<Task, "workspaceId" | "cwd">): string[] => {
  const source = task.workspaceId ? sc.db.getWorkspaceBacklogSource(task.workspaceId) : null;
  const origin = source && source.service !== "switchboard" ? null : sc.originRepoOf(task.cwd);
  const gitlab = gitlabTargetOf(task.cwd, task.workspaceId)?.repository;
  return [...new Set([source?.repository, origin, gitlab].flatMap((r) => (r ? [r.toLowerCase()] : [])))];
};

type ConsentContext = Pick<ServerContext, "db" | "originRepoOf" | "grantHeadOf" | "adapterMap" | "settings" | "runnerChoice" | "suggestDir" | "judgeStop" | "tasks" | "pendingConsent" | "pricingTable" | "loginKindOf">;

/** How long the check waits for the read of `taskId`'s reply: twice the setting's turn time (the configured runner, then the fallback), up to `CONSENT_WAIT_CAP_MS`. */
export const consentWaitMs = (sc: Pick<ServerContext, "settings">): number => Math.min(2 * sc.settings().judgeAndChoice.judgeTimeoutMs, CONSENT_WAIT_CAP_MS);

/** Waits for the reads of `taskId`'s replies that are still going, also one queued behind the first, up to `consentWaitMs` in all. */
export async function waitForConsentRead(sc: Pick<ServerContext, "settings" | "pendingConsent">, taskId: string): Promise<void> {
  const until = Date.now() + consentWaitMs(sc);
  for (let reading = sc.pendingConsent.get(taskId); reading && Date.now() < until; reading = sc.pendingConsent.get(taskId)) await Promise.race([reading, Bun.sleep(until - Date.now())]);
}

const SAID = (g: ConsentGrant): string => (g.kind === "merge" ? `PR #${g.target} を判定の外でマージ` : g.change ? `変更 L${g.target} をマージ` : `PR #${g.target} をマージ`);

/**
 * Reads the grants in a text the person sent that holds no fixed sentence (`readConsent`) and records them as the
 * person's, for the task's own repositories only. The caller does not wait: the read is kept in `pendingConsent` for the
 * check in front of `gh` (`GET /api/merge-grants`) to wait for, and a text sent while one is running is read after it.
 * A merge / answer grant holds for the head its PR had when the text came in. What was recorded, or that nothing could
 * be read, is one line in the task's conversation; a text that grants nothing says nothing.
 */
export function noteConsent(sc: ConsentContext, task: Task, text: string, read?: { said: string; asked: string; full?: string }): Promise<void> {
  // what the person answers: the Task's last reply, and the questions of a question tool it asked (the Task's words, not the
  // person's). `read.said` pairs each chosen answer with its question by number; the Task's own ask is its reply's
  const reply = sc.db.lastReplyText(task.id) ?? "";
  const asked = [reply, read?.asked ?? ""].filter(Boolean).join("\n");
  const words = read?.said ?? text;
  // the grant is given when the reply comes in, not when the reader answers
  const said = Date.now();
  // what the task asked for, to put to the reader: the fixed sentences in the reply this text answers. Stop records are not
  // read (which of them the person is answering cannot be told from them); a stop reported outside the reply's text leaves
  // the reader with the reply's own words
  const requested = requestedGrants([reply]);
  const candidates = consentCandidates(words, [asked, read?.full ?? ""].filter(Boolean).join("\n"));
  // a change of the Task's workspace is kept under the workspace's own name (`changeRepoOf`), a PR under the Task's repositories
  const prRepos = ownReposOf(sc, task);
  const repoOf = (g: ConsentGrant): string[] => (g.change ? (task.workspaceId ? [changeRepoOf(task.workspaceId)] : []) : prRepos);
  const allRepos = [...prRepos, ...(task.workspaceId ? [changeRepoOf(task.workspaceId)] : [])];
  if (!candidates.length || !allRepos.length) return Promise.resolve();
  // the heads as of now, before the read: a commit pushed while the reader answers is not granted
  const heads = new Map<string, Promise<string | null>>();
  for (const repo of allRepos) for (const n of candidates) heads.set(`${repo}#${n}`, sc.grantHeadOf(task, repo, n).catch(() => null));
  const run = async (): Promise<void> => {
    const say = (text: string) => sc.tasks.record(task.id, { t: "status", text });
    const why = (e: unknown) => String((e as Error).message ?? e).replace(/\s+/g, " ").slice(0, 120);
    // a text past the reader's limit is not read (`readConsent`): said, so the person knows to say it shorter
    if (words.trim().length > CONSENT_CHARS.said) {
      say("文が長すぎて許可を読めませんでした。短く言い直すか、決まった文で送ってください");
      return;
    }
    let grants: Awaited<ReturnType<typeof readConsent>>;
    try {
      const cfg = sc.settings().judge;
      const jc = sc.settings().judgeAndChoice;
      const onUsage = (runner: RunnerId, ev: Extract<AgentEvent, { t: "usage" }>) => {
        if (!sc.judgeStop.signal.aborted) sc.db.insertLedger(ledgerRowFor(sc.pricingTable(), { id: task.id, runner, model: ev.model ?? null }, ev, Date.now(), sc.loginKindOf(runner)));
      };
      grants = (await readConsent({ said: words, asked, requested, numbersFrom: read?.full }, { adapters: sc.adapterMap, settings: { ...cfg, ...sc.runnerChoice(cfg.runner, cfg.model, cfg.effort) }, cwd: sc.suggestDir, onUsage, log: (m) => console.warn(m), signal: sc.judgeStop.signal, fallback: sc.runnerChoice(jc.judgeFallbackRunner, jc.judgeFallbackModel, jc.judgeFallbackEffort), timeoutMs: jc.judgeTimeoutMs }));
    } catch (e) {
      if (!sc.judgeStop.signal.aborted) say(`返信から許可を読めませんでした（${why(e)}）。決まった文でも送れます`);
      return;
    }
    if (sc.judgeStop.signal.aborted || !grants.length) return;
    try {
      const rows = await Promise.all(grants.flatMap((g) => repoOf(g).map(async (repo) => ({ taskId: task.id, repo, kind: g.kind, target: g.target, change: g.change === true, by: OWNER, head: (await heads.get(`${repo}#${g.target}`)) ?? undefined }))));
      // a merge / answer row whose head could not be read answers for no head, and written it would take the place of an
      // earlier grant of the same kind that has one: it is said in the line below and not recorded
      sc.db.recordMergeGrants(rows.filter((r) => r.head).map(({ change: _change, ...r }) => r), said);
      const lines = grants.map((g) => {
        const head = rows.find((r) => r.kind === g.kind && r.target === g.target && r.change === (g.change === true))?.head;
        return `${SAID(g)}（${head ? `head ${head.slice(0, 7)}` : "head を読めず、まだ通りません"}）`;
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
