import { BacklogCommentData, BacklogFetchState, BacklogIssueData, BacklogProjectItemData, BacklogPullRequestData, BacklogRepositoryKey } from "@switchboard/protocol";
import { z } from "zod";
import type { UplinkConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { importedId } from "./backlog-upbox.ts";
import { isMachineName } from "./machine.ts";
import type { S3Store } from "./s3.ts";

/**
 * What a work machine reads of the instance's backlog: one small object per registered machine and repository in the
 * uplink bucket, `backlog-export/<machine>/<owner>/<repo>.json.zst` (the owner and the name in lower case, as the
 * registry has them). The instance writes it after each intake of the uplink (`writeBacklogExports`); the work machine
 * reads only the keys under its own name (`readBacklogExport`) and takes it in as a copy of the backlog
 * (backlog-replica.ts). The object holds only what a work machine shows: the repository's records as the service has
 * them (not the instance's own waiting drafts), which repository the instance's workspace reads, when the instance last
 * imported it, and what came of the operations that machine put. Nothing else of the instance's database is in it, and
 * a machine's credentials reach no other prefix, so a leaked work-machine credential reads its own repositories only.
 */
const PREFIX = "backlog-export/";
/** The shape's version: a reader that finds a later one says the work machine is the older side. */
export const EXPORT_VERSION = 1;
/** The most a work machine reads of one object (compressed); a bigger one is refused, not held. */
export const EXPORT_MAX_BYTES = 64 * 1024 * 1024;

/** What replaces an export that must no longer be read (the instance cannot delete): read as no export at all. */
const Tombstone = z.object({ kind: z.literal("backlog-export"), v: z.number().int(), machine: z.string(), removed: z.literal(true), at: z.number() });
/**
 * The tombstones written, by key, with the etag the put answered: a key is skipped only while the listed object still has
 * that etag, so a database restored from before a later real export (or any other write over the tombstone) gets the
 * tombstone written again.
 */
const WITHDRAWN_KEY = "backlogExport.withdrawn";

/** A record as the work machine stores it: the same shapes as the backlog tables (`BacklogRecord`), so a reader of the copy finds what it expects. */
const exportedRecord = <K extends string, D extends z.ZodTypeAny>(kind: K, data: D) => z.object({ objectKind: z.literal(kind), externalId: z.string(), remote: data, fetchState: BacklogFetchState });
const ExportedRecord = z.discriminatedUnion("objectKind", [exportedRecord("issue", BacklogIssueData), exportedRecord("comment", BacklogCommentData), exportedRecord("project-item", BacklogProjectItemData), exportedRecord("pull-request", BacklogPullRequestData)]);

const Exported = z.object({
  kind: z.literal("backlog-export"),
  v: z.number().int(),
  machine: z.string(),
  /** Which repository the instance's workspace reads (the Project with it): the work machine's workspace reads the same. */
  source: BacklogRepositoryKey.extend({ project: z.object({ owner: z.string(), number: z.number() }) }),
  /** When the instance last imported the repository (ms). */
  importedAt: z.number(),
  /** The records as the service has them; one the service stopped answering for keeps its last value and its mark (`fetchState`). */
  records: z.array(ExportedRecord),
  /** What came of the operations the machine put: the row under the id the instance keeps it by, as the instance has it now. */
  operations: z.array(z.object({ id: z.string(), status: z.string(), remoteId: z.string().nullable(), error: z.string().nullable(), updatedAt: z.number() })),
});
export type BacklogExport = Omit<z.infer<typeof Exported>, "v" | "kind"> & { kind: "backlog-export"; v: number };

export class ExportError extends Error {
  /** `removed`: the instance wrote a tombstone over it (the machine is no longer registered for the repository); the copy here is dropped. */
  constructor(readonly kind: "newer" | "missing" | "fetch", message: string, readonly removed = false) {
    super(message);
  }
}

const notThere = (repository: string) => `写しを取り込めません: EC2 に ${repository} の写しがありません（このマシンの登録に無いか、EC2 がまだ取り込んでいません）`;

/** The key a repository's export for a machine is under; `repository` is `owner/name`, compared without case. */
export const exportKey = (machine: string, repository: string) => `${PREFIX}${machine}/${repository.toLowerCase()}.json.zst`;

/**
 * The export of one repository for one machine, from the instance's stored backlog: null when no workspace of the
 * instance reads the repository, or it has not imported it yet (there is nothing to copy).
 */
export function buildBacklogExport(db: Db, machine: string, repository: string): BacklogExport | null {
  const ws = db.listWorkspaces().map((w) => db.getWorkspaceBacklogSource(w.id));
  // disabled ones too: the registry names a repository by its path only, and when two services or hosts have it (in use
  // or not), which one is meant is not known and neither is sent
  const found = ws.filter((s) => s && s.service !== "switchboard" && s.repository.toLowerCase() === repository.toLowerCase());
  const source = found.find((s) => !s!.disabled);
  if (!source || found.some((s) => s!.service !== source.service || s!.host !== source.host)) return null;
  const key = [source.service, source.host, source.repository] as const;
  const sync = db.getBacklogRepository(source);
  if (sync?.lastSuccessfulSync == null) return null;
  // what the service has, not what the instance still has to send (`local`)
  const rows = db.sqlite.query("SELECT object_kind, external_id, remote, fetch_state FROM backlog_records WHERE service = ? AND host = ? AND repository = ? AND remote IS NOT NULL ORDER BY object_kind, external_id").all(...key) as Array<{ object_kind: BacklogExport["records"][number]["objectKind"]; external_id: string; remote: string; fetch_state: BacklogExport["records"][number]["fetchState"] }>;
  const mine = importedId(machine, "");
  const ops = db.sqlite.query("SELECT id, status, remote_id, error, updated_at FROM backlog_operations WHERE substr(id, 1, ?) = ? AND service = ? AND host = ? AND lower(repository) = lower(?) ORDER BY id").all(mine.length, mine, source.service, source.host, source.repository) as Array<{ id: string; status: string; remote_id: string | null; error: string | null; updated_at: number }>;
  return {
    kind: "backlog-export",
    v: EXPORT_VERSION,
    machine,
    source: { service: source.service, host: source.host, repository: source.repository, project: source.project },
    importedAt: sync.lastSuccessfulSync,
    records: rows.map((r) => ({ objectKind: r.object_kind, externalId: r.external_id, remote: JSON.parse(r.remote), fetchState: r.fetch_state }) as BacklogExport["records"][number]),
    operations: ops.map((o) => ({ id: o.id, status: o.status, remoteId: o.remote_id, error: o.error, updatedAt: o.updated_at })),
  };
}

/**
 * The instance's side, after an intake: for each registered machine (`cfg.uplink.machines`) one object per repository
 * it is registered for, written over the one before. A repository no workspace reads, or one not imported yet, has no
 * object (the work machine is told so). The instance cannot delete, so an object whose machine or repository is no
 * longer registered, or whose workspace is gone or disabled, is written over with a tombstone (once: the keys already
 * done are kept in `backlogExport.withdrawn` with the tombstone's etag, and written again when the object there has
 * another etag), which a work machine reads as no export. Everything under the prefix is
 * looked at, a machine that left the registry included, before the live exports are put. One object that cannot be written does not stop the others;
 * the first failure is thrown after all were tried. Returns the keys written (tombstones not counted).
 */
export async function writeBacklogExports(db: Db, cfg: { uplink: Pick<UplinkConfig, "machines"> }, store: S3Store, now = Date.now()): Promise<string[]> {
  const written: string[] = [];
  const live = new Map<string, BacklogExport>();
  let failure: unknown = null;
  const withdrawn = new Map(Object.entries(db.getSetting<Record<string, string>>(WITHDRAWN_KEY, {})));
  const keep = () => db.setSetting(WITHDRAWN_KEY, Object.fromEntries([...withdrawn].sort(([a], [b]) => (a < b ? -1 : 1))));
  for (const [machine, repositories] of Object.entries(cfg.uplink.machines)) {
    if (!isMachineName(machine)) continue;
    for (const repository of repositories) {
      const exported = buildBacklogExport(db, machine, repository);
      // still registered: never a tombstone, also when this round's put fails (the last good export stays)
      if (exported) live.set(exportKey(machine, repository), exported);
    }
  }
  // withdrawals first, so that a put of a live export that is slow or fails does not keep one back
  try {
    for (const o of await store.list(PREFIX)) {
      const m = /^backlog-export\/([^/]+)\/([^/]+\/[^/]+)\.json\.zst$/.exec(o.key);
      if (!m || live.has(o.key) || withdrawn.get(o.key) === o.etag || !isMachineName(m[1])) continue;
      const tombstone: z.infer<typeof Tombstone> = { kind: "backlog-export", v: EXPORT_VERSION, machine: m[1], removed: true, at: now };
      try {
        const put = await store.put(o.key, Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify(tombstone))));
        if (put === "conflict") continue;
        withdrawn.set(o.key, put.etag);
        keep();
      } catch (e) {
        failure ??= e;
      }
    }
  } catch (e) {
    failure ??= e;
  }
  for (const [key, exported] of live) {
    try {
      await store.put(key, Bun.zstdCompressSync(new TextEncoder().encode(JSON.stringify(exported))));
      written.push(key);
      if (withdrawn.delete(key)) keep();
    } catch (e) {
      failure ??= e;
    }
  }
  if (failure) throw failure;
  return written;
}

/**
 * The work machine's side: the export of `repository` (`owner/name`) written for `machine`, read from the machine's own
 * prefix only. The key is listed first (the role may list its own prefix), so a key that is not there is told from a
 * read that is refused: S3 answers a GET of a missing key with "access denied" to a role whose list permission has a
 * prefix condition. Throws ExportError when there is none (`missing`: the instance does not register this machine for
 * the repository, reads no such repository, has not imported it yet, or wrote a tombstone), when it cannot be read or
 * is not this machine's export of this repository (`fetch`) or when it is of a newer shape (`newer`).
 */
export async function readBacklogExport(store: S3Store, machine: string, repository: string, maxBytes = EXPORT_MAX_BYTES): Promise<BacklogExport> {
  const key = exportKey(machine, repository);
  const failed = (e: unknown) => {
    throw new ExportError("fetch", `写しを取れません: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  };
  const listed = (await store.list(key).catch(failed)).find((o) => o.key === key);
  if (!listed) throw new ExportError("missing", notThere(repository));
  const tooBig = () => new ExportError("fetch", `写しを取れません: ${repository} の写しが上限 ${maxBytes} バイトを超えています`);
  if (listed.size > maxBytes) throw tooBig();
  const got = await store.get(key, { maxBytes }).catch(failed);
  if (!got) throw new ExportError("missing", notThere(repository));
  if (got.more) throw tooBig();
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(got.body)));
  } catch (e) {
    throw new ExportError("fetch", `写しを取れません: ${repository} の写しを読めません（${String((e as Error)?.message ?? e).slice(0, 200)}）`);
  }
  const v = (raw as { v?: unknown } | null)?.v;
  if (typeof v === "number" && v > EXPORT_VERSION) throw new ExportError("newer", `写しを取り込めません: EC2 の写しのほうが新しい形です（${v}）。この作業場を更新してください`);
  const notMine = (to: string) => new ExportError("fetch", `写しを取れません: ${repository} の写しは ${to} 宛てです`);
  const tombstone = Tombstone.safeParse(raw);
  if (tombstone.success) {
    if (tombstone.data.machine !== machine) throw notMine(tombstone.data.machine);
    throw new ExportError("missing", notThere(repository), true);
  }
  const parsed = Exported.safeParse(raw);
  if (!parsed.success) throw new ExportError("fetch", `写しを取れません: ${repository} の写しの形が違います（${parsed.error.issues[0]?.path.join(".") ?? ""}）`);
  if (parsed.data.machine !== machine) throw notMine(parsed.data.machine);
  if (parsed.data.source.repository.toLowerCase() !== repository.toLowerCase()) throw notMine(`${parsed.data.machine} の ${parsed.data.source.repository}`);
  return parsed.data;
}
