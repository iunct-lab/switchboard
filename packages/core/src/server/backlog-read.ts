import { existsSync } from "node:fs";
import type { Backlog, BacklogItem, Task, Workspace } from "@switchboard/protocol";
import { type StoredBacklog, BacklogSync } from "../backlog-sync.ts";
import { type FlowWorkspace, FlowCache, flowScope, flowView } from "../flow.ts";
import { enablingOf } from "../backlog-enable.ts";
import { BacklogError, GithubBudgetCache, runGh } from "../backlog-gh.ts";
import { isReplyWaiting } from "../backlog-pick.ts";
import { workspaceSyncOf, withStageTask } from "../backlog-stored.ts";
import type { ReleaseState } from "../promotion.ts";
import { IN_FLIGHT, workPhase } from "../task-status.ts";
import type { ServerContext, ServerContextInit } from "./context.ts";
import { uplinkStores } from "../s3.ts";
import { Workbench } from "../backlog-replica.ts";
import { PbiLeases } from "../lease.ts";
import { originOf, remoteOf } from "../../../../ops-kit/src/forge.ts";
import { SourceCache, sourceView } from "../sources.ts";
import { WorkspaceClones } from "../workspace-clone.ts";

/** Whether the backlog reads the workspace: the meta workspace only on an instance that develops Switchboard itself. The one judgement; BacklogSync.sync and the lists use it, and so do the request Task's entry and the stage start. */
export function backlogReads(sc: Pick<ServerContext, "settings">, ws: Pick<Workspace, "kind">): boolean {
  return readsWorkspace(() => sc.settings().developSelf, ws);
}

/** The judgement of `backlogReads`, with the setting given as a function so one read of many workspaces can parse the settings once. */
const readsWorkspace = (developSelf: () => boolean, ws: Pick<Workspace, "kind">): boolean => ws.kind !== "meta" || developSelf();

// the flow of the closed PBIs: the stored backlog, and GitHub for the merged PRs, so an hour is held; the repository is the import's, as for the backlog
export const flowWorkspaces = (sc: Pick<ServerContext, "db">): FlowWorkspace[] => sc.db.listWorkspaces().map((w) => ({ id: w.id, name: w.name, path: w.path, repository: sc.db.getWorkspaceBacklogSource(w.id)?.repository ?? null }));

/** When this daemon started: a version that was promoted into is the running one from then (stage-start-gate.ts `release:`). */
const STARTED_AT = Date.now();

/**
 * A workspace's stored backlog, without waiting for GitHub. One never imported and not tried yet gets its import asked
 * for, once: a failed one is asked again by 再読込, the daemon's boot or the scheduled sweep, not by every look.
 */
export const storedBacklog = (sc: Pick<ServerContext, "db" | "leasedElsewhere" | "backlog">, ws: Workspace, released?: (oid: string) => boolean | null): StoredBacklog => {
  // a PBI whose stage Task runs now counts as other work in the overlap judgement, before its Tasks are In progress (a planned resume alone does not)
  // and so does a PBI another machine holds the lease of: its Tasks' files are at work there
  const working = sc.db.workingStageIssues(ws.id);
  const active = (n: number) => working.has(n) || !!sc.leasedElsewhere(ws, n);
  // one whose stage Task only has a resume planned cannot move before that time: its place after an overlap is passed over until then
  const stage = sc.db.activeStageIssues(ws.id);
  const parked = (n: number) => !active(n) && stage.has(n);
  const stored = sc.backlog.read(ws, { released, active, parked, runningSince: STARTED_AT });
  if (stored.fetchedAt !== null || stored.error || stored.syncing) return stored;
  sc.backlog.request(ws);
  return sc.backlog.read(ws, { released, active, parked, runningSince: STARTED_AT });
};

/** What `storedBacklog` answers apart from the items (no record read); a workspace never imported and not tried yet gets its import asked for, as there. */
export const lightBacklog = (sc: Pick<ServerContext, "db" | "backlog">, ws: Workspace): Pick<StoredBacklog, "fetchedAt" | "syncing" | "error"> => {
  const source = sc.db.getWorkspaceBacklogSource(ws.id);
  const fetchedAt = source ? sc.db.getBacklogRepository(source)?.lastSuccessfulSync ?? null : null;
  const before = sc.backlog.state(ws);
  if (fetchedAt !== null || before.error || before.syncing) return { fetchedAt, ...before };
  sc.backlog.request(ws);
  return { fetchedAt, ...sc.backlog.state(ws) };
};

export const metaWorkspace = (sc: Pick<ServerContext, "db">) => sc.db.listWorkspaces().find((w) => w.kind === "meta");

/** Why `backlog.settle` failed, for a line in backlog-next's log. */
export const notSettled = (_sc: unknown, e: unknown) => (e instanceof BacklogError ? e.message : String((e as Error)?.message ?? e).slice(0, 200));

/** What an active stage Task (Db's activeStage) is at, for a line in backlog-next's log: its status, else what its ended turn still waits on. */
export const activeAs = (_sc: unknown, t: Task): string =>
  t.queuedAt !== null ? "実行枠待ち" : IN_FLIGHT.has(t.status) ? t.status : t.status === "background" ? "裏の処理を待っている" : workPhase(t) === "resume" ? "再開を待っている" : t.judgingAt !== null ? "最後の返答の判定を待っている" : "デーモンのジョブを待っている";

/** A Task's screen mockups: its HTML artifacts, not removed; none for a Task that does not exist. */
export const mockupsOf = (sc: Pick<ServerContext, "artifacts">, id: string) => sc.artifacts.list(id).filter((a) => a.removedAt === null && a.kind !== "url" && (a.mime === "text/html" || a.mime === "application/xhtml+xml"));

export const withActive = (sc: Pick<ServerContext, "db" | "activeStageTask" | "mockupsOf">, b: Backlog): Backlog => ({
  ...b,
  items: b.items.map((i) => {
    const stage = withStageTask(sc.db, i);
    const item: BacklogItem = {
      ...stage,
      activeTaskId: sc.activeStageTask(i.workspaceId, i.number)?.id ?? null,
      mockups: i.mockupTask ? sc.mockupsOf(i.mockupTask) : [],
    };
    return { ...item, replyWaiting: isReplyWaiting(item) };
  }),
});

/** Every workspace's stored backlog with its stage Tasks (withActive); `refresh` imports each first (GET /api/backlog). */
export const readBacklog = async (sc: Pick<ServerContext, "db" | "settings" | "backlog" | "storedBacklogReleased" | "withActive" | "syncEntry">, refresh: boolean): Promise<Backlog> => {
  // the settings are parsed once for this read, and only when a meta workspace asks (a setting saved before the read is in it)
  let developSelf: boolean | undefined;
  const reads = (ws: Workspace) => readsWorkspace(() => (developSelf ??= sc.settings().developSelf), ws);
  const read = await Promise.all(sc.db.listWorkspaces().filter(reads).map(async (ws) => {
    if (!existsSync(ws.path)) return { ws, stored: null };
    if (refresh) await sc.backlog.sync(ws, undefined, { full: true }).catch(() => undefined);
    // the prerequisites judged as backlog-next judges them
    return { ws, stored: await sc.storedBacklogReleased(ws) };
  }));
  const errors = read.flatMap(({ ws, stored }) => {
    const message = !stored ? "workspace directory does not exist" : (stored.error ?? (stored.fetchedAt === null ? "まだ GitHub から取り込んでいません" : null));
    return message ? [{ workspaceId: ws.id, workspaceName: ws.name, message, kind: stored?.errorKind ?? ("other" as const) }] : [];
  });
  // a workspace kept only here was never read from GitHub: its time is not "imported from GitHub"
  const imported = read.flatMap(({ ws, stored }) => (ws.backlog === "github" && stored?.fetchedAt != null ? [stored.fetchedAt] : []));
  return sc.withActive({
    fetchedAt: imported.length ? Math.min(...imported) : Date.now(),
    items: read.flatMap(({ stored }) => stored?.items ?? []),
    changes: read.flatMap(({ stored }) => stored?.changes ?? []),
    errors,
    syncs: read.flatMap(({ ws, stored }) => (stored ? [sc.syncEntry(ws, stored)] : [])),
    proceeding: read.flatMap(({ stored }) => stored?.proceeding ?? []),
  });
};

/** One workspace's row of `syncs`: what GET /api/backlog and GET /api/backlog/syncs both answer. */
export const syncEntry = (sc: Pick<ServerContext, "db">, ws: Workspace, stored: Pick<StoredBacklog, "fetchedAt" | "syncing" | "error">) => ({ workspaceId: ws.id, backlog: ws.backlog, enabling: enablingOf(sc.db, sc.db.getWorkspaceBacklogSource(ws.id)), repository: sc.db.getWorkspaceBacklogSource(ws.id)?.repository ?? null, syncing: stored.syncing, syncedAt: stored.fetchedAt, ...workspaceSyncOf(sc.db, ws, { importFailed: stored.error !== null }) });

/**
 * The stored backlog with the `（リリース）` answers: read once with what is known; only when that read asked about a commit
 * with no answer yet, the answers are got and it is read again (a full read of the stored records is the cost, so a
 * request whose commits are all known reads once).
 */
export const storedBacklogReleased = async (sc: Pick<ServerContext, "storedBacklog" | "releaseStatus" | "releaseKnown" | "git">, ws: Workspace): Promise<StoredBacklog> => {
  if (ws.kind !== "meta") return sc.storedBacklog(ws);
  const status = await sc.releaseStatus();
  const current = status.managed ? (status as ReleaseState).current : null;
  if (!current) return sc.storedBacklog(ws);
  if (sc.releaseKnown?.current !== current) sc.releaseKnown = { current, of: new Map() };
  const known = sc.releaseKnown;
  const asked = new Set<string>();
  const stored = sc.storedBacklog(ws, (oid) => known.of.get(oid) ?? (asked.add(oid), null));
  if (!asked.size) return stored;
  for (const oid of asked) {
    // exit 1 = not an ancestor; any other failure (a commit this checkout does not have, a time out) cannot tell, and is not kept
    const r = await sc.git(["merge-base", "--is-ancestor", oid, current]).then(() => true, (e: { exitCode?: number }) => (e.exitCode === 1 ? false : null));
    if (r !== null) known.of.set(oid, r);
  }
  return sc.storedBacklog(ws, (oid) => known.of.get(oid) ?? null);
};

export const isMeta = (sc: Pick<ServerContext, "db">, t: { workspaceId: string | null }) => !!t.workspaceId && sc.db.getWorkspace(t.workspaceId)?.kind === "meta";

/** A Task on the meta row of an install that develops Switchboard: only that one is checked after a turn. A release-only install runs the tree it was given and has no checks to run on it. */
export const selfDevOn = (sc: Pick<ServerContext, "db" | "cfg">, t: { workspaceId: string | null }) => !sc.cfg.releaseOnly && isMeta(sc, t);

export function setupBacklog(sc: Pick<ServerContextInit, "backlog" | "db" | "opts" | "cfg" | "backlogReads" | "uplink" | "s3" | "leases" | "clones" | "broadcast" | "githubBudget" | "sources" | "flowWorkspaces" | "flow" | "DEVELOP_SELF_OFF">): void {
  // the backlog is read from what was imported; GitHub is asked by the sync only, and for its budget (below)
  // the candidate runs on a copy of the database: it sends nothing, or what it sent would be sent again
  sc.backlog = new BacklogSync(sc.db, sc.opts.gh ?? runGh, undefined, undefined, !sc.cfg.candidate, (ws) => { const w = sc.db.getWorkspace(ws.id); return !w || sc.backlogReads(w); });
  sc.backlog.artifactsDir = sc.cfg.artifactsDir;
  // Two machines sharing work (cfg.uplink): none of this exists on a daemon that runs alone, and S3 is never asked.
  // sb-rescue's candidate runs on a copy of the database and neither sends, takes in nor holds a lease.
  sc.uplink = sc.cfg.uplink;
  const stores = !sc.uplink.mode || sc.cfg.candidate ? null : uplinkStores(sc.uplink);
  sc.s3 = stores && (sc.opts.s3 ?? stores.s3);
  const leaseStore = sc.s3 && (sc.opts.s3 ?? stores!.leases);
  sc.leases = leaseStore ? new PbiLeases(leaseStore, { machine: sc.uplink.machine, ttlMs: sc.uplink.leaseTtlMs }) : null;
  // a work machine reads the instance's copy and never asks the backlog's service
  if (sc.s3 && sc.uplink.mode === "send")
    sc.backlog.workbench = new Workbench(sc.db, {
      intervalMs: sc.uplink.backlogCopyIntervalMs,
      maxBytes: sc.uplink.backlogExportMaxBytes,
      machine: sc.uplink.machine,
      store: sc.s3,
      repositoryOf: (ws) => {
        const origin = (sc.opts.gitOrigin ?? originOf)(ws.path);
        return (origin && remoteOf(origin)?.path) || null;
      },
    });
  sc.clones = new WorkspaceClones(sc.db, sc.opts.gh ?? runGh, sc.cfg.reposDir, () => sc.broadcast({ type: "workspaces.updated" }));
  // GitHub's GraphQL budget: read at most once a minute, for backlog-next, the stage buttons and the ledger
  sc.githubBudget = new GithubBudgetCache(sc.opts.gh ?? runGh, undefined, undefined, undefined, () => sc.backlog.hostWait());
  sc.sources = new SourceCache((days, now) => sourceView(sc.db, sc.flowWorkspaces(), days, now), () => flowScope(sc.flowWorkspaces()));
  sc.flow = new FlowCache((now) => flowView(sc.opts.gh ?? runGh, sc.flowWorkspaces(), sc.db, 30, now), () => flowScope(sc.flowWorkspaces()));
  // a request that was out when the daemon stopped is looked for before it is sent again
  sc.db.recoverBacklogOperations();
  sc.DEVELOP_SELF_OFF = "Switchboard 自体を開発しない設定です（設定画面で切り替え）";
}
