import { otherMachineOf } from "../machine.ts";
import { githubRepoOfRemote } from "../claude-cloud.ts";
import { capSnapshot, collectTaskDiff, mergeSnapshot, WRITE_TOOLS } from "../taskdiff.ts";
import { API, OWNER, changeRepoOf, grantHeadKey, parseMergeGrants, type GrantHeads, type MergeGrant } from "../merge-grants.ts";
import { ownReposOf, readyConsent } from "./merge-consent.ts";
import { changeSourceOf, runGh } from "../backlog-gh.ts";
import { branchTip } from "../backlog-local.ts";
import { readStoredIssue } from "../backlog-stored.ts";
import { GH_READ_TIMEOUT_MS } from "../asks.ts";
import type { ServerContext, ServerContextInit } from "./context.ts";
import { gitlabTargetOf } from "../workspace-config.ts";
import { runGlab, viewGitlabMr } from "../../../../ops-kit/src/forge-gitlab.ts";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { RunnerId, AgentEvent, EventEnvelope, Task } from "@switchboard/protocol";
import { suggestTitle } from "../suggest-title.ts";
import { loadRubric } from "../rubric.ts";
import { loadTrustedSkills } from "../rubric-judge.ts";
import { SKILL_SOURCE } from "../skillsync.ts";
import { findRepoRoot } from "../config.ts";
import { ledgerRowFor } from "../pricing.ts";
import { isAuthText } from "../login.ts";
import { TURN_DONE } from "../task-status.ts";
import { withoutWorkspaceRules } from "../tasks/manager.ts";

// A reply is copied to the task's shadow; a terminal turn on either side goes in before it.
export const catchUpWithShadow = (sc: Pick<ServerContext, "db" | "history">, taskId: string) => {
  if (sc.db.getTask(taskId)?.executionMode === "cloud") return;
  sc.history.catchUp(taskId);
  const shadow = sc.db.shadowTaskOf(taskId);
  if (shadow) sc.history.catchUp(shadow.id);
};

export const snapshotTaskDiff = async (sc: Pick<ServerContext, "snapshotting" | "snapshotAgain" | "db" | "snapshotEvents" | "staging" | "stopped" | "snapshotTaskDiff">, taskId: string) => {
  if (sc.snapshotting.has(taskId)) {
    sc.snapshotAgain.add(taskId);
    return;
  }
  sc.snapshotting.add(taskId);
  try {
    const t = sc.db.getTask(taskId);
    if (!t) return;
    const cached = sc.snapshotEvents.get(taskId) ?? { seq: 0, events: [] };
    const fresh = sc.db.listEvents(taskId, cached.seq);
    for (const e of fresh) if ((e.ev.t === "tool.call" && WRITE_TOOLS.includes(e.ev.name)) || e.ev.t === "artifact") cached.events.push(e);
    if (fresh.length) cached.seq = fresh[fresh.length - 1]!.seq;
    sc.snapshotEvents.set(taskId, cached);
    const live = await collectTaskDiff(t, cached.events, sc.staging.list(taskId));
    if (sc.stopped) return;
    sc.db.putTaskDiffSnapshot(taskId, capSnapshot(mergeSnapshot(sc.db.getTaskDiffSnapshot(taskId), live, Date.now())));
  } catch (e) {
    console.warn(`task diff snapshot: ${String((e as Error).message ?? e)}`);
  } finally {
    sc.snapshotting.delete(taskId);
    if (sc.snapshotAgain.delete(taskId) && !sc.stopped) void sc.snapshotTaskDiff(taskId);
  }
};

/** The GitHub repository (`owner/name`) a directory's origin names; null when it has none (not a clone, moved or removed, another host). */
export const originRepoOf = (_sc: unknown, dir: string): string | null => {
  try {
    const p = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: dir, stdout: "pipe", stderr: "ignore", timeout: 3000 });
    return p.exitCode === 0 ? githubRepoOfRemote(p.stdout.toString().trim()) : null;
  } catch {
    return null;
  }
};

/**
 * The head a PR has now, read when a merge / answer grant of it is recorded — for a screen answer of an Issue when the
 * answer is taken (`answerGrantHeads`), not at the later record: the grant then holds for that head only.
 * `repo` a backlog kept here (the task's workspace keeps its changes itself): the tip of the change's branch in the
 * workspace's checkout; a GitLab project's MR (the project the checkout's settings name): GitLab's (`glab api`); else
 * GitHub's (`gh pr view`). Null = not read (GitHub not reachable, no such PR or change, no
 * answer in time): the grant is recorded without a head and answers for none.
 */
export const grantHeadOf = async (sc: Pick<ServerContext, "db" | "opts">, task: { workspaceId?: string | null; cwd: string }, repo: string, target: number): Promise<string | null> => {
  const ws = task.workspaceId ? sc.db.getWorkspace(task.workspaceId) : null;
  const source = ws ? sc.db.getWorkspaceBacklogSource(ws.id) : null;
  // a local change of a GitHub workspace, kept apart from its Issues: the tip of the change's branch in the checkout
  if (ws && repo === changeRepoOf(ws.id)) {
    const kept = changeSourceOf(sc.db, ws.id);
    const change = kept ? readStoredIssue(sc.db, ws, target, { source: kept })?.issue.change : null;
    return change ? branchTip(ws.path, change.head) : null;
  }
  if (ws && source?.service === "switchboard" && source.repository.toLowerCase() === repo.toLowerCase()) {
    const change = readStoredIssue(sc.db, ws, target)?.issue.change;
    return change ? branchTip(ws.path, change.head) : null;
  }
  // an MR of the checkout's GitLab project, named as the verdict names it (the project's path, in lower case)
  const lab = gitlabTargetOf(task.cwd, task.workspaceId);
  if (lab && lab.repository.toLowerCase() === repo.toLowerCase()) {
    const mr = viewGitlabMr(sc.opts.glab ?? runGlab, lab, target).then((m) => m.head.toLowerCase(), () => "");
    const sha = await Promise.race([mr, Bun.sleep(GH_READ_TIMEOUT_MS).then(() => "")]);
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }
  const headOf = (out: string): string => {
    try {
      return String((JSON.parse(out) as { headRefOid?: unknown }).headRefOid ?? "").toLowerCase();
    } catch {
      return "";
    }
  };
  const read = (sc.opts.gh ?? runGh)(["pr", "view", String(target), "-R", repo, "--json", "headRefOid"], task.cwd).then((r) => (r.code === 0 ? headOf(r.stdout) : ""), () => "");
  const sha = await Promise.race([read, Bun.sleep(GH_READ_TIMEOUT_MS).then(() => "")]);
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
};

/**
 * The repositories a grant sentence that names none is for, in a workspace (null = none) and a directory: the one rule
 * of the record of a grant (`noteMergeGrant`) and of the heads read for a screen answer (`answerGrantHeads`), so an
 * answer's heads are kept under the names its grants are recorded with.
 */
export const ownGrantRepos = (sc: Pick<ServerContext, "db" | "originRepoOf">, ws: { id: string } | null, cwd: string): string[] => ownReposOf(sc, { workspaceId: ws?.id ?? null, cwd });

/**
 * The head of every PR a merge / answer grant in `text` names, read now: what a screen answer of an Issue keeps with its
 * operation, so the grant recorded at the start of the next stage Task is for the PR as it was when the person
 * answered. null = not read (`grantHeadOf`): that grant answers for no head. A text with no such grant reads nothing.
 * `checked` = what the answer was already checked against (the PR its question stopped at): a grant of that PR is
 * for that head and the PR is not read again — null there (the check read no head) is kept as null, and the grant
 * answers for none.
 */
export const answerGrantHeads = async (sc: Pick<ServerContext, "db" | "opts" | "originRepoOf">, ws: { id: string; path: string }, text: string, checked: GrantHeads = {}, parts?: string[]): Promise<GrantHeads> => {
  const asked = answerGrantPrs(sc, ws, text, parts);
  return Object.fromEntries(await Promise.all([...asked].map(async ([key, a]) => [key, key in checked ? (checked[key] ?? null) : await grantHeadOf(sc, { workspaceId: ws.id, cwd: ws.path }, a.repo, a.target).catch(() => null)] as const)));
};

/** The PRs the merge / answer grants in an answer's `text` name, by the key their heads are kept under (`grantHeadKey`); none when the text has no such grant. */
function answerGrantPrs(sc: Pick<ServerContext, "db" | "originRepoOf">, ws: { id: string; path: string }, text: string, parts?: string[]): Map<string, { repo: string; target: number }> {
  const asked = new Map<string, { repo: string; target: number }>();
  const grants = parts ? parts.flatMap(parseMergeGrants) : parseMergeGrants(text);
  if (!grants.length) return asked;
  const own = ownGrantRepos(sc, ws, ws.path);
  for (const g of grants) for (const repo of grantRepos(g, () => own, ws.id)) asked.set(grantHeadKey(repo, g.target), { repo, target: g.target });
  return asked;
}

/**
 * What a screen answer keeps for its grants before any PR is read: every PR `answerGrantHeads` would read, with no head
 * (null — a grant of it answers for no head) unless the answer was already checked against one (`checked`). Nothing is
 * awaited, so the answer is kept at once; what `answerGrantHeads` reads afterwards replaces it (`setAnswerHeads`).
 */
export const pendingGrantHeads = (sc: Pick<ServerContext, "db" | "originRepoOf">, ws: { id: string; path: string }, text: string, checked: GrantHeads = {}, parts?: string[]): GrantHeads =>
  Object.fromEntries([...answerGrantPrs(sc, ws, text, parts).keys()].map((key) => [key, checked[key] ?? null] as const));

/** The repositories a grant sentence is recorded for: the one it names, else the Task's own; a change's is its workspace's (none without a workspace). */
const grantRepos = (g: MergeGrant, own: () => string[], workspaceId: string | null | undefined): string[] => (g.change ? (workspaceId ? [changeRepoOf(workspaceId)] : []) : g.repo ? [g.repo] : own());

/**
 * The head of every PR a merge / answer grant in `text` names, read now for a Task: `answerGrantHeads` for an answer to
 * a Task's stop, with the Task's own repositories (`ownGrantRepos`) and the same keys `noteMergeGrant` records under.
 * Read before the grant is recorded, so nothing is waited for between the record and the reply. null = not read: that
 * grant answers for no head. A text with no such grant reads nothing.
 */
export const taskGrantHeads = async (sc: Pick<ServerContext, "db" | "opts" | "originRepoOf">, task: { workspaceId?: string | null; cwd: string }, text: string, parts?: string[]): Promise<GrantHeads> => {
  const grants = parts ? parts.flatMap(parseMergeGrants) : parseMergeGrants(text);
  if (!grants.length) return {};
  const own = ownGrantRepos(sc, task.workspaceId ? { id: task.workspaceId } : null, task.cwd);
  const asked = new Map<string, { repo: string; target: number }>();
  for (const g of grants) for (const repo of grantRepos(g, () => own, task.workspaceId)) asked.set(grantHeadKey(repo, g.target), { repo, target: g.target });
  return Object.fromEntries(await Promise.all([...asked].map(async ([key, a]) => [key, await grantHeadOf(sc, task, a.repo, a.target).catch(() => null)] as const)));
};

/**
 * How a text that may carry the person's permission came in — the one rule of every route that can record a merge
 * grant or keep an answer as the person's words (a reply, a resume note, an answer to a question, an answer to an
 * Issue's ## 判断待ち). A request that names a sending Task is that Task's and never the person's; any other counts as
 * the person's ("screen") only when it looks like the web UI's (`screenLook`), and as a bare call's ("api") otherwise.
 * Not a proof of who typed it (merge-grants.ts): a help against a relayed text and a forgotten `from`.
 */
export const grantSource = async (sc: Pick<ServerContext, "screenLook">, req: Request, srv: Parameters<ServerContext["screenLook"]>[1], sender?: string): Promise<{ sender?: string; via: "screen" | "api" }> =>
  sender ? { sender, via: "api" } : { via: (await sc.screenLook(req, srv)) ? "screen" : "api" };

type GrantFrom = { sender?: string; source?: string; via?: "screen" | "api"; taskWrote?: boolean; heads?: GrantHeads; read?: { said: string; asked: string; full?: string }; parts?: string[] };
type GrantContext = Pick<ServerContext, "db" | "originRepoOf" | "opts" | "grantHeadOf" | "adapterMap" | "settings" | "runnerChoice" | "suggestDir" | "judgeStop" | "tasks" | "pendingConsent" | "pricingTable" | "loginKindOf">;
type GrantRow = { taskId: string; repo: string; kind: MergeGrant["kind"]; target: number; by: string; source?: string };

/**
 * What a text grants, read when it comes in: null = nothing is recorded (no task here, a Task of another machine, a
 * text of no fixed sentence that is not read); `consent` = the read of the person's own words, its moment taken
 * (`readyConsent`), started when called; else the rows of its fixed sentences.
 */
const grantsOf = (sc: GrantContext, taskId: string, text: string, from: GrantFrom): { consent: () => Promise<void> } | { task: Task | null; by: string; rows: GrantRow[] } | null => {
  // `parts`: the texts of an answer read by letters one by one (a chosen option's sentence, a free text); else the text is one message
  const grants = from.parts ? from.parts.flatMap(parseMergeGrants) : parseMergeGrants(text);
  const task = sc.db.getTask(taskId);
  const by = from.sender ? `task:${from.sender}` : (from.via ?? "api") === "screen" ? OWNER : API;
  // a Task of another machine gets no grant here: this instance neither answers for it nor merges for it
  if (otherMachineOf(task)) return null;
  if (!grants.length) {
    // no fixed sentence: the person's own words are read for one, without the caller waiting (the check in front of `gh` does)
    const consent = by === OWNER && task && !from.source && !from.taskWrote ? readyConsent(sc, task, text, from.read) : null;
    return consent ? { consent } : null;
  }
  // the task's own repositories: the ones its workspace's backlog and its directory's origin name
  let own: string[] | undefined;
  const ownRepos = (): string[] => (own ??= task ? ownGrantRepos(sc, task.workspaceId ? { id: task.workspaceId } : null, task.cwd) : []);
  return { task, by, rows: grants.flatMap((g) => grantRepos(g, ownRepos, task?.workspaceId).map((repo) => ({ taskId, repo, kind: g.kind, target: g.target, by, source: from.source }))) };
};

/**
 * `noteMergeGrant` for a caller that hands the text to the Task itself, with the heads already read (`from.heads`: a
 * head not in it is none): what the text grants is taken now — the time of the grant, the reply and the heads a read of
 * the person's own words goes by — and recorded, with nothing waited for, when the returned function is called. The
 * caller calls it right after the hand-over (`send`'s `sent`), so a reply that was not handed over leaves no grant.
 */
export const grantRecorder = (sc: GrantContext, taskId: string, text: string, from: Omit<GrantFrom, "heads"> & { heads: GrantHeads }): (() => void) => {
  const g = grantsOf(sc, taskId, text, from);
  const at = Date.now();
  return () => {
    if (!g) return;
    if ("consent" in g) return void g.consent();
    sc.db.recordMergeGrants(g.rows, at, from.source);
    // only a record that can answer needs the head; a trace of another sender's text keeps none
    if (g.by !== OWNER || !g.task) return;
    for (const r of g.rows) {
      const head = from.heads[grantHeadKey(r.repo, r.target)] ?? null;
      if (head) sc.db.recordMergeGrant({ ...r, head }, at);
    }
  };
};

/**
 * A merge-grant sentence in a text sent to a task is recorded for the check in front of `gh` (merge-grants.ts): for the
 * repository the sentence names, else the task's own — its workspace's backlog repository, else its directory's origin,
 * which are what the checks ask with when the command names none (neither: not recorded — a grant for any repository
 * is not made). A merge / answer grant is recorded with the head the PR has now (`grantHeadOf`): it holds for what the
 * PR was when the grant was recorded, and commits pushed after it ask again — also the rebase GitHub makes after a merge
 * below (the gate reads a grant only for the head it was recorded with). A screen answer of an Issue is recorded at the
 * start of the next stage task, later than the answer: its heads are the ones read when the answer was taken (`heads`,
 * `answerGrantHeads`), never read again here — a grant whose head is not among them is recorded without one and answers
 * for none.
 * `sender`: the Task the send said it came from; the record then says `task:<id>`. `via`: how the text came in when no
 * sender was named (`grantSource` decides it for a request) — "screen" (a request that looked like the web UI's) is
 * recorded as the person's, "api" (a bare call, and the default: a caller that does not say is not the person) is not. Only a record marked the person's answers a check. None of this proves who
 * typed the text: see merge-grants.ts. `source`: the screen answer the text is, which gives its grants once.
 * `taskWrote`: the text is a sentence a Task wrote (the grant of its stop) that the person only pressed.
 * A fixed sentence resolves once every grant is recorded with its head: a caller that sends the text to the task
 * afterwards awaits it, so the task does not check before the record is whole. A text with none resolves at once; the
 * person's own words are then read in the background (`noteConsent`), and only the check in front of `gh` waits for
 * that read. A screen answer with a `source` and a sentence the Task wrote are not read: a read that ends after another
 * start, or that finds nothing, would not spend the answer once, and a Task's own words are no grant.
 */
export const noteMergeGrant = async (sc: GrantContext, taskId: string, text: string, from: GrantFrom = {}): Promise<void> => {
  // (every caller passes what `grantSource` said of its request; the start of a stage passes "screen" for an answer that route marked)
  const g = grantsOf(sc, taskId, text, from);
  if (!g) return;
  if ("consent" in g) return void g.consent();
  const { task, by, rows } = g;
  const at = Date.now();
  // every row is there before anything is waited for (a source is spent from here on: two starts cannot both take one
  // answer's grants — and spent for a release rolled back to as well, in the setting it reads); a merge / answer row
  // answers nothing until its head is in
  sc.db.recordMergeGrants(rows, at, from.source);
  // only a record that can answer needs the head; a trace of another sender's text keeps none
  await Promise.all(rows.filter(() => by === OWNER && task).map(async (r) => {
    // a screen answer's heads were read when it was taken: the PR is not read again, and a head not read then is none
    const head = from.heads ? (from.heads[grantHeadKey(r.repo, r.target)] ?? null) : await grantHeadOf(sc, task!, r.repo, r.target).catch(() => null);
    if (head) sc.db.recordMergeGrant({ ...r, head }, at);
  }));
};

export function setupTurnEndHooks(sc: Pick<ServerContextInit, "pendingConsent" | "trustedSkills" | "tasks" | "bedrockTasks" | "loginExpired" | "detected" | "selfDevOn" | "selfdev" | "checksOn" | "restarting" | "countRules" | "db" | "cfg" | "artifacts" | "judgeStop" | "lastJudgingAt" | "applyPolicies" | "batchAnswers" | "settings" | "judgeReply" | "titling" | "pricingTable" | "loginKindOf" | "runnerChoice" | "opts" | "adapterMap" | "suggestDir" | "broadcast" | "rubric" | "rubricSeqNext" | "rubricSeq" | "judgeEvals">): void {
  sc.pendingConsent = new Map<string, Promise<void>>();
  sc.tasks.onTurnEnd((taskId, t, turn) => {
    // A turn on Amazon Bedrock says nothing about the Claude account's login, either way
    if (sc.bedrockTasks.has(taskId)) return;
    if (turn.end.status === "ok") {
      // a turn that went through proves the login, also over a status-command answer from before the person logged in
      sc.loginExpired.delete(t.runner);
      const d = sc.detected.find((x) => x.adapter.id === t.runner);
      if (d?.info.login === "expired") d.info = { ...d.info, login: "ok" };
    }
    if (turn.end.status !== "error" || ![turn.end.summary, ...turn.errors].some((text) => isAuthText(t.runner, text))) return;
    const info = sc.detected.find((d) => d.adapter.id === t.runner)?.info;
    if (info?.login === undefined) return;
    sc.loginExpired.add(t.runner);
    sc.tasks.record(taskId, { t: "status", text: `${t.runner} のログインが切れています。Task の「ターミナル」tab で \`${info.loginHint ?? t.runner}\` を実行してから返信してください` });
  });
  sc.tasks.onTurnEnd((taskId, t) => {
    if (!sc.selfDevOn(t)) return;
    // A shadow of a meta task shares the workspace but must not invalidate the primary's checks nor start a
    // second, concurrent check run on the same tree.
    if (t.shadowOf) return;
    sc.selfdev.invalidate(); // the tree changed: earlier runs no longer vouch for it
    // a turn that left a background process (`background`) is not the end of the writing: the check waits for it to empty
    if (t.status === "done" && sc.checksOn && !sc.restarting) void sc.selfdev.run(taskId).catch(() => undefined);
  });
  // The last background process of a meta task is gone: it may have written the tree since the turn ended, so a run kept
  // from then no longer vouches for it. The check runs now, as it would have at a turn that ended `done` — not when the
  // processes went with the runner (`lost`: it exited, or the daemon is stopping and has cancelled its checks already).
  sc.tasks.onBackgroundEmpty((taskId, lost) => {
    const t = sc.db.getTask(taskId);
    if (!t || !sc.selfDevOn(t) || t.shadowOf) return;
    sc.selfdev.invalidate();
    if (!lost && t.status === "done" && sc.checksOn && !sc.restarting) void sc.selfdev.run(taskId).catch(() => undefined);
  });

  // Evals: the rule counts of every finished turn. Synchronous and cheap; a failure must not stop the turn's end.
  sc.tasks.onTurnEnd((taskId, t) => {
    if (t.executionMode === "cloud") return;
    try {
      sc.countRules(t);
    } catch (e) {
      console.warn(`evals: task ${taskId} not counted (${String((e as Error).message ?? e)})`);
    }
  });

  // insights: the schedule's Task ran `/insights` as its first turn; the report Claude Code wrote becomes the
  // Task's artifact. Only that turn is looked at (a follow-up sent to the Task later is an ordinary turn and must not
  // sweep in a report another run — a terminal's, say — made meanwhile), and only a report written since the turn
  // started (an older one is another run's too). A failure is a line on the Task.
  sc.tasks.onTurnEnd((taskId, t, turn) => {
    if (!t.scheduleId || sc.db.getSchedule(t.scheduleId)?.action !== "insights" || turn.end.status !== "ok") return;
    const events = sc.db.listEvents(taskId);
    if (events.filter((e) => e.ev.t === "session.end").length > 1) return; // the ended turn is this one, the first; later ones are follow-ups
    const file = join(sc.cfg.claudeUsageDataDir, "report.html");
    try {
      // the Task's creation, not the runner's session.start: /insights analyses and writes the report before Claude Code
      // reports its session; the listener runs for the first turn only, so this is that turn's start
      const started = t.createdAt;
      if (statSync(file).mtimeMs <= started) {
        sc.tasks.record(taskId, { t: "status", text: `report.html がこの実行の開始より古いので成果物に写しません（${file}）` });
        return;
      }
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, "0");
      const a = sc.artifacts.addCopy(t, file, `Claude Code Insights ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`);
      sc.tasks.record(taskId, { t: "status", text: `レポートを成果物に写しました: ${a.title}` });
    } catch (e) {
      const gone = (e as NodeJS.ErrnoException).code === "ENOENT";
      sc.tasks.record(taskId, { t: "status", text: gone ? `report.html が無いので成果物に写しません（${file}）` : `レポートを成果物に写せませんでした: ${String((e as Error).message ?? e)}` });
    }
  });

  /**
   * The automatic judgement: a turn that ended done, on a task the rule left unknown, is judged from its last
   * reply in the background. The judgement is always kept (judged*); the outcome takes it only while it is still
   * unknown — the person may have set it meanwhile, and theirs wins. A shadow is not judged: the primary is
   * enough, and it would spend the quota twice. `judgingAt` (a column) marks the reply being judged: a new turn
   * clears it, so a judgement of an older reply writes nothing, and a daemon restart that cut one short has it judged again.
   */
  sc.judgeStop = new AbortController(); // aborted by stopAll before the database closes
  sc.lastJudgingAt = 0; // the mark is a time, but never the same twice in this daemon (two turns in a millisecond, a clock set back)
  // a saved policy may answer what this Task's turn left open
  sc.tasks.onTurnEnd(() => void sc.applyPolicies());
  // the Task sent on to log in for an SSO batch: once it went on, the rest go on
  sc.tasks.onTurnEnd((taskId, t) => void sc.batchAnswers.turnEnded(taskId, t.status === "error" || t.status === "aborted").catch((e) => console.warn(`sso batch: ${String((e as Error).message ?? e)}`)));
  // its background processes (device-auth runs until the person has logged in) may outlast the turn: judged again when they are gone
  sc.tasks.onBackgroundEmpty((taskId, lost) => void sc.batchAnswers.turnEnded(taskId, lost).catch((e) => console.warn(`sso batch: ${String((e as Error).message ?? e)}`)));
  sc.tasks.onTurnEnd((taskId, t, turn) => {
    const lastReply = turn.end.summary?.trim() ?? "";
    if (t.executionMode === "cloud" || !sc.settings().judge.enabled || !TURN_DONE.has(t.status) || t.shadowOf || t.outcome !== "unknown" || !lastReply) return;
    sc.judgeReply(taskId, t, lastReply, (sc.lastJudgingAt = Math.max(Date.now(), sc.lastJudgingAt + 1)));
  });

  /**
   * The title after the first turn: a task whose title is still provisional is named once, in the background,
   * from its request and the turn's last reply. `titlePending` is cleared first, so it is one try per task; a title
   * the person changed meanwhile (PATCH) is kept. A turn that ended in an error or an abort is not named (the next one
   * is). A shadow shows the primary's title, and Cloud is not asked.
   */
  sc.titling = new Set<string>(); // naming in flight; a rename (PATCH) takes the task out, so its title is not overwritten
  sc.tasks.onTurnEnd((taskId, t, turn) => {
    if (!t.titlePending || t.shadowOf || t.executionMode === "cloud" || !sc.settings().titles.auto || sc.judgeStop.signal.aborted) return;
    if (turn.end.status !== "ok") return;
    sc.db.updateTask(taskId, { titlePending: false, updatedAt: t.updatedAt });
    sc.titling.add(taskId);
    const provisional = t.title;
    const onUsage = (runner: RunnerId, ev: Extract<AgentEvent, { t: "usage" }>) => {
      if (!sc.judgeStop.signal.aborted) sc.db.insertLedger(ledgerRowFor(sc.pricingTable(), { id: taskId, runner, model: ev.model ?? null }, ev, Date.now(), sc.loginKindOf(runner)));
    };
    // the titles' own runner first, then the judge's fallback; one entry when they are the same runner, model and effort
    const ti = sc.settings().titles;
    const jc = sc.settings().judgeAndChoice;
    const first = sc.runnerChoice(ti.runner, ti.model, ti.effort);
    const second = sc.runnerChoice(jc.judgeFallbackRunner, jc.judgeFallbackModel, jc.judgeFallbackEffort);
    const tries = first.runner === second.runner && first.model === second.model && first.effort === second.effort ? [first] : [first, second];
    void (sc.opts.titleSuggester ?? suggestTitle)({ prompt: withoutWorkspaceRules(sc.db.firstUserText(taskId) ?? provisional), reply: turn.end.summary?.trim() ?? "" }, { adapters: sc.adapterMap, cwd: sc.suggestDir, onUsage, log: (m) => console.warn(m), signal: sc.judgeStop.signal, tries })
      .then((r) => {
        if (sc.judgeStop.signal.aborted) return;
        const cur = sc.db.getTask(taskId);
        if (!cur || cur.title !== provisional || !sc.titling.has(taskId)) return;
        // updatedAt stays: a title is not activity and must not move the task in the list
        const next = sc.db.updateTask(taskId, { title: r.title, updatedAt: cur.updatedAt });
        if (next) sc.broadcast({ type: "task.updated", task: next });
      })
      .catch((e) => {
        if (sc.judgeStop.signal.aborted) return;
        console.warn(`title: task ${taskId} keeps its provisional title (${String((e as Error).message ?? e)})`);
      })
      .finally(() => sc.titling.delete(taskId));
  });

  /**
   * The rubric judge: a turn that ended done is scored against the rubric in the background, on the judge
   * runner (`settings.judge`); the row replaces the task's previous one and the screen is told to read it again.
   * The rubric is read once at boot — the person's edit takes effect on the next start. Not a shadow, not Cloud.
   * `rubricSeq` drops a score of an older reply, as `judgingAt` does for the two-way judge.
   */
  sc.rubric = loadRubric(sc.cfg.home, (m) => console.warn(m));
  // the skills a request can name, read now from the tree this daemon runs from: the judge is never shown the judged Task's own copy
  sc.trustedSkills = loadTrustedSkills(join(findRepoRoot(import.meta.dir), SKILL_SOURCE));
  sc.rubricSeqNext = 0;
  sc.rubricSeq = new Map<string, number>();
  sc.tasks.onTurnEnd((taskId, t, turn) => {
    // a turn that ended without a reply is not scored, as the turn judge does not judge it: there is no work reported to score
    if (t.executionMode === "cloud" || t.shadowOf || !TURN_DONE.has(t.status) || !sc.settings().evals.judge.enabled || !turn.end.summary?.trim()) return;
    sc.judgeEvals(taskId, t);
  });
}

export function setupSnapshots(sc: Pick<ServerContextInit, "stopped" | "snapshotting" | "snapshotAgain" | "snapshotEvents" | "tasks" | "snapshotTaskDiff" | "snapshotTimer" | "db">): void {
  // a copy of the task's diff, so it can still be shown after its worktree is removed: at each turn's end and every 60 s while running
  sc.stopped = false;
  sc.snapshotting = new Set<string>();
  sc.snapshotAgain = new Set<string>(); // a call that came while one was running: run once more after it, so the last turn's end is not lost
  // collectTaskDiff reads only write-class tool calls and artifacts from the transcript, so the timer keeps just those, and only the events after the last seq read
  sc.snapshotEvents = new Map<string, { seq: number; events: EventEnvelope[] }>();
  sc.tasks.onTurnEnd((taskId) => void sc.snapshotTaskDiff(taskId));
  sc.snapshotTimer = setInterval(() => {
    const active = [...sc.db.listTasksByStatus("running"), ...sc.db.listTasksByStatus("background")];
    const ids = new Set(active.map((t) => t.id));
    for (const id of sc.snapshotEvents.keys()) if (!ids.has(id)) sc.snapshotEvents.delete(id);
    for (const id of ids) void sc.snapshotTaskDiff(id);
  }, 60_000);
  sc.snapshotTimer.unref();
}
