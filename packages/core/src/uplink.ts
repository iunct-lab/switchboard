import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, type Stats } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { claudeProjectDirName } from "@switchboard/adapter-claude";
import type { CoreConfig } from "./config.ts";
import { type Db, schemaLevel } from "./db.ts";
import { IN_FLIGHT } from "./task-status.ts";
import { type TarEntry, writeTarZst } from "./transfer.ts";

/**
 * The uplink of a work machine (a PC): what changed since the last send, packed into one file per delta for the
 * instance to take in. A delta is a tar → zstd (the parts of transfer.ts) holding
 *  - `delta.json`: `{ machine, deltaId, schemaLevel, createdAt, repos, tables }`. `tables` maps a table name to its
 *    rows, each row as the table has it (column names as keys), so the taker needs no list of columns of its own;
 *    `schemaLevel` tells it whether it knows them all. `repos` maps this machine's workspace id to `owner/name`
 *    (null when the workspace is not a GitHub repository): the taker moves a Task to its own workspace by that;
 *  - `files/attachments/<…>`, `files/artifacts/<task>/<…>`, `files/sessions/claude/<…>` and `files/sessions/codex/<…>`:
 *    the files of the Tasks in it, by their place under this machine's folders.
 *
 * Only what is newer than the mark goes: a Task of this machine (`machine` NULL: rows taken from another machine are
 * not sent on) whose row or any child row is newer, as its whole row; its events, ledger, … rows and its files that are
 * newer. Events, ledger and routing_log rows are told new by where they were written (a Task's event seq, the row id),
 * and a runner session file by its size, not by their time: the import of terminal sessions writes them with the time the session had, which may be long
 * before the mark. The other rows and files are told by time. Taking a delta in twice changes nothing, so the time
 * of the mark is held back by `OVERLAP_MS` and a send that failed is simply built again. The mark moves only after a
 * delta was sent: `writeCursor`, called by the sender.
 *
 * The instance takes a delta in with `applyDelta` (below): into the tables it already has, so a Task of a work machine
 * reads like its own (the readers are the same), with `tasks.machine` telling where it ran.
 */

/** The mark is set back this far when a delta is built (a row written while the last one was being built is sent twice, not never). */
export const OVERLAP_MS = 60_000;

/** One delta's content (rows as JSON, plus the files), not counting zstd: what the 64 MiB of a first send are measured in. */
export const DELTA_MAX_BYTES = 64 * 1024 * 1024;

const CURSOR_KEY = "uplink.cursor";
const EVENT_PAGE = 2000;

/**
 * Where the last send stopped: the time (rows told new by time), the last ledger and routing_log ids, per Task the
 * last event seq sent, and per runner session file the size sent.
 */
export interface Cursor {
  at: number;
  ledger: number;
  routing: number;
  seqs: Record<string, number>;
  files: Record<string, number>;
}

export function readCursor(db: Db): Cursor {
  return db.getSetting<Cursor>(CURSOR_KEY, { at: 0, ledger: 0, routing: 0, seqs: {}, files: {} });
}

/** Moves the mark; called once the deltas of one build (their `cursor`) have been put where the instance reads them. */
export function writeCursor(db: Db, cursor: Cursor): void {
  db.setSetting(CURSOR_KEY, cursor);
}

export interface BuiltDelta {
  deltaId: string;
  file: string;
  /** The mark to write after this delta (and the ones built with it) was sent. */
  cursor: Cursor;
}

type Row = Record<string, unknown>;

/** Child tables of a Task, with the columns that say when a row is new (ledger and routing_log: by id, `byId`). */
const CHILD_TABLES: Array<{ table: string; when: string[]; byId?: "ledger" | "routing" }> = [
  { table: "ledger", when: [], byId: "ledger" },
  { table: "task_evals", when: ["ts"] },
  { table: "routing_log", when: [], byId: "routing" },
  { table: "check_runs", when: ["ts"] },
  { table: "staging", when: ["ts", "decided_at"] },
  { table: "artifacts", when: ["updated_at"] },
  { table: "attachments", when: ["created_at"] },
];
const TABLES = ["tasks", "events", ...CHILD_TABLES.map((c) => c.table)];

/**
 * The deltas since `since` (the mark; `readCursor` of a database that never sent = everything), written under `opts.dir` (default `<home>/uplink`), oldest Task
 * first. A delta holds up to `opts.maxBytes` of rows and files: a first send is cut into several, a Task's events by
 * seq (its row comes with the first of them), a file bigger than the limit alone. None when nothing is new. Every
 * delta of one call has the same `createdAt` and `cursor`; the mark moves to it after all of them were sent. A delta's id
 * is `<machine>-<createdAt>-<n>` with `n` padded, so the ids sort in the order the deltas must be taken in. When a
 * delta cannot be written, the ones already written by the call are removed.
 */
export async function buildDelta(db: Db, cfg: CoreConfig, since: Cursor, machine: string, opts: { maxBytes?: number; dir?: string; now?: number } = {}): Promise<BuiltDelta[]> {
  if (!/^[A-Za-z0-9._-]+$/.test(machine)) throw new Error(`machine "${machine}" is not usable in a file name`);
  const max = opts.maxBytes ?? DELTA_MAX_BYTES;
  const dir = opts.dir ?? join(cfg.home, "uplink");
  const createdAt = opts.now ?? Date.now();
  const from = Math.max(0, since.at - OVERLAP_MS);
  const sqlite = db.sqlite;
  const level = schemaLevel();
  const repos = repositories(db);
  const newer = (c: (typeof CHILD_TABLES)[number]) => (c.byId ? `id > ${Number(since[c.byId])}` : c.when.map((w) => `${w} > ${from}`).join(" OR "));
  const next: Cursor = {
    at: createdAt,
    ledger: (sqlite.query("SELECT max(id) AS n FROM ledger").get() as { n: number | null }).n ?? 0,
    routing: (sqlite.query("SELECT max(id) AS n FROM routing_log").get() as { n: number | null }).n ?? 0,
    seqs: { ...since.seqs },
    files: { ...since.files },
  };

  const lastSeq = sqlite.query("SELECT max(seq) AS s FROM events WHERE task_id = ?");
  const ids = (
    sqlite
      .query(
        `SELECT t.id, (t.updated_at > ${from}
           ${CHILD_TABLES.map((c) => `OR EXISTS (SELECT 1 FROM ${c.table} c WHERE c.task_id = t.id AND (${newer(c)}))`).join("\n           ")}
         ) AS changed FROM tasks t WHERE t.machine IS NULL ORDER BY t.created_at, t.id`,
      )
      .all() as Array<{ id: string; changed: number }>
  )
    .filter((r) => r.changed || ((lastSeq.get(r.id) as { s: number | null }).s ?? 0) > (since.seqs[r.id] ?? 0))
    .map((r) => r.id);
  if (ids.length === 0) return [];
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const built: BuiltDelta[] = [];
  let tables: Record<string, string[]> = {};
  let files: Array<{ name: string; path: string }> = [];
  let bytes = 0;
  const empty = () => ((tables = Object.fromEntries(TABLES.map((t) => [t, [] as string[]]))), (files = []), (bytes = 0));
  empty();
  const flush = async () => {
    if (bytes === 0 && files.length === 0) return;
    const deltaId = `${machine}-${createdAt}-${String(built.length).padStart(6, "0")}`;
    const head = `{"machine":${JSON.stringify(machine)},"deltaId":${JSON.stringify(deltaId)},"schemaLevel":${level},"createdAt":${createdAt},"repos":${JSON.stringify(repos)},"tables":{${TABLES.map((t) => `${JSON.stringify(t)}:[${tables[t]!.join(",")}]`).join(",")}}}\n`;
    const file = join(dir, `${deltaId}.tar.zst`);
    const entries: TarEntry[] = [{ name: "delta.json", bytes: Buffer.from(head) }, ...files.map((f): TarEntry => ({ name: `files/${f.name}`, path: f.path }))];
    await writeTarZst(file, entries);
    built.push({ deltaId, file, cursor: next });
    empty();
  };
  /** Adds `size` to the delta being filled, closing it first when it would pass the limit (a delta is never closed empty). */
  const room = async (size: number) => {
    if (bytes > 0 && bytes + size > max) await flush();
    bytes += size;
  };
  const addRow = async (table: string, row: Row) => {
    const json = JSON.stringify(row);
    await room(Buffer.byteLength(json));
    tables[table]!.push(json);
  };
  const addFile = async (name: string, path: string, size: number) => {
    await room(size);
    files.push({ name, path });
  };

  const codexRollouts = lazy(() => rolloutsOf(join(cfg.codexHome, "sessions")));
  try {
    for (const id of ids) {
      const task = sqlite.query("SELECT * FROM tasks WHERE id = ?").get(id) as Row;
      await addRow("tasks", task);
      // events after the last seq sent, in pages: a Task of 100,000 events is never read whole
      for (let after = since.seqs[id] ?? 0; ; ) {
        const page = sqlite.query("SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?").all(id, after, EVENT_PAGE) as Row[];
        for (const r of page) await addRow("events", r);
        if (page.length > 0) after = next.seqs[id] = page[page.length - 1]!.seq as number;
        if (page.length < EVENT_PAGE) break;
      }
      for (const c of CHILD_TABLES) {
        const { table } = c;
        // an attachment is made before it is tied to the Task (its time is the upload's): every one of the Task is looked
        // at, and it goes with its file when the file's size is not the one sent
        const rows = sqlite.query(`SELECT * FROM ${table} WHERE task_id = ?${table === "attachments" ? "" : ` AND (${newer(c)})`}`).all(id) as Row[];
        for (const r of rows) {
          if (table !== "attachments") {
            await addRow(table, r);
            continue;
          }
          // only a file in the attachments folder is this machine's to send (a row says where its file is, a tampered one anywhere)
          const path = resolve(String(r.path));
          const size = fileSize(path);
          if (size === null || !path.startsWith(resolve(cfg.attachmentsDir) + sep)) {
            if (Number(r.created_at) > from) await addRow(table, r);
            continue;
          }
          const name = `attachments/${relative(cfg.attachmentsDir, path)}`;
          if (size === since.files[name]) continue;
          await addRow(table, r);
          await addFile(name, path, size);
          next.files[name] = size;
        }
      }
      for (const f of filesUnder(join(cfg.artifactsDir, id), `artifacts/${id}`)) if (f.mtimeMs >= from) await addFile(f.name, f.path, f.size);
      // a session file only grows: it goes when its size is not the one sent (its time may be from before the mark, as a
      // terminal session taken in late has)
      for (const f of sessionFiles(cfg, task, codexRollouts)) {
        if (f.size === since.files[f.name]) continue;
        await addFile(f.name, f.path, f.size);
        next.files[f.name] = f.size;
      }
    }
    await flush();
  } catch (e) {
    for (const b of built) rmSync(b.file, { force: true });
    throw e;
  }
  return built;
}

/** This machine's workspace id → `owner/name` of the GitHub repository its backlog reads; null for one that has none. */
function repositories(db: Db): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const ws of db.listWorkspaces()) {
    const source = db.getWorkspaceBacklogSource(ws.id);
    out[ws.id] = source?.service === "github" ? source.repository : null;
  }
  return out;
}

interface Found {
  name: string;
  path: string;
  size: number;
  mtimeMs: number;
}

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function fileSize(path: string): number | null {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** Regular files under `dir` (links and anything else are left), named under `entry`; `.tmp-*` (a write in progress) is skipped. */
function filesUnder(dir: string, entry: string): Found[] {
  if (!existsSync(dir)) return [];
  const out: Found[] = [];
  const visit = (path: string, name: string) => {
    const st = statOrNull(path); // a file replaced while it is read is not there any more
    if (!st) return;
    if (st.isDirectory()) {
      for (const c of readdirSync(path)) if (!c.startsWith(".tmp-")) visit(join(path, c), `${name}/${c}`);
    } else if (st.isFile()) out.push({ name, path, size: st.size, mtimeMs: st.mtimeMs });
  };
  visit(dir, entry);
  return out;
}

/** The runner's session file of the Task: Claude's `<projects>/<cwd as a folder name>/<id>.jsonl`, Codex's `sessions/…/rollout-…-<id>.jsonl`. */
function sessionFiles(cfg: CoreConfig, task: Row, codexRollouts: () => string[]): Found[] {
  const sid = task.runner_session_id;
  if (typeof sid !== "string" || sid === "" || /[\\/]/.test(sid)) return [];
  if (task.runner === "claude") {
    const path = join(cfg.claudeProjectsDir, claudeProjectDirName(String(task.cwd)), `${sid}.jsonl`);
    const st = existsSync(path) ? lstatSync(path) : null;
    return st?.isFile() ? [{ name: `sessions/claude/${claudeProjectDirName(String(task.cwd))}/${sid}.jsonl`, path, size: st.size, mtimeMs: st.mtimeMs }] : [];
  }
  if (task.runner === "codex") {
    const root = join(cfg.codexHome, "sessions");
    return codexRollouts()
      .filter((f) => f.endsWith(`-${sid}.jsonl`))
      .flatMap((f) => {
        const path = join(root, f);
        const st = statOrNull(path);
        return st?.isFile() ? [{ name: `sessions/codex/${f}`, path, size: st.size, mtimeMs: st.mtimeMs }] : [];
      });
  }
  return [];
}

function rolloutsOf(root: string): string[] {
  try {
    return (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
}

function lazy<T>(make: () => T): () => T {
  let v: { value: T } | undefined;
  return () => (v ??= { value: make() }).value;
}


/** What `applyDelta` did with a delta. */
export type ApplyResult =
  | { status: "applied"; deltaId: string; machine: string; rows: Record<string, number>; files: number }
  | { status: "skipped"; deltaId: string; machine: string; reason: string };

/** A delta this instance could not take in because its database is older than the sender's. */
export interface Skipped {
  machine: string;
  deltaId: string;
  theirs: number;
  ours: number;
  at: number;
}

const APPLIED_KEY = "uplink.applied";
const SKIPPED_KEY = "uplink.skipped";
/** The deltas remembered as taken in / not taken in (the oldest are dropped; applying again is harmless, the marks are for the reader). */
const KEPT = 1000;
const EVENT_BATCH = 10_000;

/** The delta ids taken in, oldest first. */
export function listApplied(db: Db): string[] {
  return db.getSetting<string[]>(APPLIED_KEY, []);
}

/** The deltas left out for being newer than this database, oldest first (one per delta id). */
export function listSkipped(db: Db): Skipped[] {
  return db.getSetting<Skipped[]>(SKIPPED_KEY, []);
}

/**
 * The sender's workspace ids → this instance's: the workspace whose GitHub repository is the same one (the names compared
 * without case); null when the sender has no repository for it or no workspace here reads that one.
 */
export function remapWorkspaces(db: Db, repos: Record<string, string | null>): Record<string, string | null> {
  const here = new Map<string, string>();
  for (const ws of db.listWorkspaces()) {
    const source = db.getWorkspaceBacklogSource(ws.id);
    if (source?.service === "github" && !here.has(source.repository.toLowerCase())) here.set(source.repository.toLowerCase(), ws.id);
  }
  return Object.fromEntries(Object.entries(repos).map(([id, repo]) => [id, (repo !== null && here.get(repo.toLowerCase())) || null]));
}

/** How a table takes a row whose key is already there: the columns that make the key, and when the row there is older. */
const UPSERT: Record<string, { key: string; newer: string } | null> = {
  tasks: { key: "id", newer: "excluded.updated_at > tasks.updated_at" },
  task_evals: { key: "task_id, source", newer: "excluded.ts > task_evals.ts" },
  check_runs: { key: "task_id", newer: "excluded.ts > check_runs.ts" },
  staging: { key: "id", newer: "COALESCE(excluded.decided_at, excluded.ts) > COALESCE(staging.decided_at, staging.ts)" },
  artifacts: { key: "id", newer: "excluded.updated_at > artifacts.updated_at" },
  // a row that has a key is left as it is: events never change, an attachment's row is written once, and ledger /
  // routing_log are told apart by (task_id, src_id), their own ids being the instance's
  attachments: null,
  events: null,
  ledger: null,
  routing_log: null,
};
/** Statuses of a turn in flight: start-up closes them as its own. A Task of a work machine comes in as idle. */
const COMES_IN_IDLE = new Set<string>([...IN_FLIGHT, "background"]);
/** Columns this instance acts on (resume after a limit, the run queue, judging): empty on a Task of a work machine. */
const ACTED_ON = ["resume_at", "resume_reason", "resume_window", "resume_since", "resume_planned_at", "queued_at", "judging_at"];
/** Written in this order (a Task first, its children after). */
const APPLY_ORDER = ["tasks", "ledger", "routing_log", "task_evals", "check_runs", "staging", "artifacts", "attachments"];

/** Where a delta's `files/<kind>/…` go on this instance. */
function fileRoots(cfg: CoreConfig): Record<string, string> {
  return { attachments: cfg.attachmentsDir, artifacts: cfg.artifactsDir, "sessions/claude": cfg.claudeProjectsDir, "sessions/codex": join(cfg.codexHome, "sessions") };
}

/**
 * Takes a delta file (`buildDelta`'s) into this instance. Taking one in twice changes nothing: a Task, an eval, a check
 * run, a staged change and an artifact are replaced only by a newer row, an event is kept as it is, and a ledger or
 * routing_log row is told apart by its `src_id` (the id it had where it was made; here it gets an id of its own).
 * A Task goes to the workspace here that reads the same GitHub repository (none: no workspace) and gets `machine` of the
 * sender. A delta from a database with more columns than this one is left out with its reason in `uplink.skipped`
 * (there is no reader of an older shape); upgrading this instance is what takes it in later.
 *
 * A Task of a work machine is only read here: its row comes in with no state that this instance acts on (a status of
 * a turn in flight becomes idle; no resume, queue or judging mark), so no start-up, resume or queue of this instance
 * takes it as its own to run. A Task that is this instance's own (`machine` NULL here, as when the work machine's
 * database was made from an export of this one) is left as it is, with its rows and files (told by this database, not by
 * the delta). A staged change still waiting for its approval does not come in: it is the work machine's to decide.
 *
 * Deltas are taken in the order they were made (a Task's row comes only with the first delta it is in; its later deltas
 * hold what came after). The events go in batches of their own, each one transaction, so a writer is never held for
 * long; the Task rows, everything else and the mark in `uplink.applied` go in one transaction last. A delta that fails
 * half way has put only events (no Task to show them with) and files, and is taken in again whole.
 */
export async function applyDelta(db: Db, cfg: CoreConfig, file: string, opts: { now?: number; eventBatch?: number } = {}): Promise<ApplyResult> {
  const sqlite = db.sqlite;
  // what a process that is gone left unpacked (`uplink-in-<pid>-<time>`)
  for (const d of existsSync(cfg.home) ? readdirSync(cfg.home) : []) {
    const pid = /^uplink-in-(\d+)-/.exec(d)?.[1];
    if (pid && !alive(Number(pid))) rmSync(join(cfg.home, d), { recursive: true, force: true });
  }
  mkdirSync(cfg.home, { recursive: true });
  const stage = mkdtempSync(join(cfg.home, `uplink-in-${process.pid}-`));
  try {
    // Bun.Archive drops `..` and a leading `/` from entry names and makes no links (the same check as transfer.ts's import)
    await new Bun.Archive(Bun.zstdDecompressSync(readFileSync(file))).extract(stage);
    const delta = JSON.parse(readFileSync(join(stage, "delta.json"), "utf8")) as {
      machine: unknown;
      deltaId: unknown;
      schemaLevel: unknown;
      repos: Record<string, string | null>;
      tables: Record<string, Array<Record<string, unknown>>>;
    };
    const { machine, deltaId } = delta;
    if (typeof machine !== "string" || !/^[A-Za-z0-9._-]+$/.test(machine)) throw new Error(`${file}: the machine is not usable`);
    if (typeof deltaId !== "string" || deltaId === "" || typeof delta.schemaLevel !== "number") throw new Error(`${file}: not a delta`);
    const ours = schemaLevel();
    if (delta.schemaLevel > ours) {
      const reason = `delta ${deltaId} from ${machine} has a database of level ${delta.schemaLevel}, this one is ${ours}: left out until this instance is upgraded`;
      const entry: Skipped = { machine, deltaId, theirs: delta.schemaLevel, ours, at: opts.now ?? Date.now() };
      db.setSetting(SKIPPED_KEY, [...listSkipped(db).filter((s) => s.deltaId !== deltaId), entry].slice(-KEPT));
      return { status: "skipped", deltaId, machine, reason };
    }

    const tables = delta.tables ?? {};
    const mentioned = new Set<string>();
    for (const [table, list] of Object.entries(tables)) for (const r of list ?? []) mentioned.add(String(table === "tasks" ? r.id : r.task_id));
    const isOwn = sqlite.query("SELECT 1 FROM tasks WHERE id = ? AND machine IS NULL");
    const own = new Set([...mentioned].filter((id) => isOwn.get(id)));
    // a file is told this instance's own by the database, not by what the delta names: a delta of files alone does not
    // write over an own Task's files
    const ownTask = (id: string) => !!isOwn.get(id);
    const ownSessions = new Set((sqlite.query("SELECT runner_session_id AS s FROM tasks WHERE machine IS NULL AND runner_session_id IS NOT NULL").all() as Array<{ s: string }>).map((r) => r.s));
    const placed = placeFiles(cfg, join(stage, "files"), ownTask, ownSessions);
    const workspaces = remapWorkspaces(db, delta.repos ?? {});
    const columns = new Map<string, Set<string>>();
    const statements = new Map<string, ReturnType<typeof sqlite.query>>();
    /** Runs `row` into `table` by the columns this database has; returns whether a row was written. */
    const put = (table: string, row: Record<string, unknown>): number => {
      let known = columns.get(table);
      if (!known) columns.set(table, (known = new Set((sqlite.query("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>).map((c) => c.name))));
      const cols = Object.keys(row).filter((c) => known.has(c));
      const sig = `${table}:${cols.join(",")}`;
      let stmt = statements.get(sig);
      if (!stmt) {
        const up = UPSERT[table];
        const sets = cols.filter((c) => !up?.key.split(", ").includes(c)).map((c) => `${c} = excluded.${c}`);
        const tail = up ? ` ON CONFLICT (${up.key}) DO UPDATE SET ${sets.join(", ")} WHERE ${up.newer}` : "";
        statements.set(sig, (stmt = sqlite.query(`INSERT ${up ? "" : "OR IGNORE "}INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})${tail}`)));
      }
      return stmt.run(...(cols.map((c) => row[c] ?? null) as never[])).changes;
    };

    const events = (tables.events ?? []).filter((e) => !own.has(String(e.task_id)));
    const batch = opts.eventBatch ?? EVENT_BATCH;
    const rows: Record<string, number> = { events: 0 };
    for (let at = 0; at < events.length; at += batch) {
      sqlite.transaction(() => {
        for (const e of events.slice(at, at + batch)) rows.events! += put("events", e);
      })();
    }
    sqlite.transaction(() => {
      for (const table of APPLY_ORDER) {
        rows[table] = 0;
        for (const r of tables[table] ?? []) {
          if (own.has(String(table === "tasks" ? r.id : r.task_id))) continue;
          // a change still waiting for its approval is the work machine's to decide: it comes once it is decided
          if (table === "staging" && r.status === "pending") continue;
          const row = { ...r };
          if (table === "tasks") {
            row.workspace_id = typeof r.workspace_id === "string" ? (workspaces[r.workspace_id] ?? null) : null;
            row.machine = machine;
            if (COMES_IN_IDLE.has(String(r.status))) row.status = "idle";
            for (const c of ACTED_ON) row[c] = null;
          } else if (table === "routing_log" && typeof r.workspace_id === "string") {
            row.workspace_id = workspaces[r.workspace_id] ?? null;
          }
          if (table === "ledger" || table === "routing_log") {
            row.src_id = r.id;
            delete row.id;
          } else if (table === "attachments") {
            // the file went under this instance's folder, by the Task's id and the file's name
            const task = String(r.task_id);
            if (task === "" || /[\\/]/.test(task) || task === "inbox") continue;
            row.path = join(cfg.attachmentsDir, task, basename(String(r.path)));
          }
          rows[table]! += put(table, row);
        }
      }
      db.setSetting(APPLIED_KEY, [...listApplied(db).filter((d) => d !== deltaId), deltaId].slice(-KEPT));
    })();
    return { status: "applied", deltaId, machine, rows, files: placed };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Moves the unpacked `files/<kind>/<rel>` to the same place under this instance's folder of that kind: a session file
 * when it is not there or is smaller there (it only grows), an attachment or an artifact's file when it is not there or
 * differs. The files of a Task that is this instance's own (`ownTask`, by the database), its session file among them, are left. A name that leaves its folder, one of another kind,
 * or one whose way goes through a link refuses the delta before anything is placed. Returns how many were written.
 */
function placeFiles(cfg: CoreConfig, from: string, ownTask: (id: string) => boolean, ownSessions: Set<string>): number {
  if (!existsSync(from)) return 0;
  const roots = fileRoots(cfg);
  const todo: Array<{ src: string; dest: string; grows: boolean }> = [];
  for (const name of readdirSync(from, { recursive: true }) as string[]) {
    const src = join(from, name);
    if (!lstatSync(src).isFile()) continue;
    const kind = Object.keys(roots).find((k) => name.startsWith(`${k}/`));
    if (!kind) throw new Error(`files/${name} is not a place a delta writes to`);
    const root = resolve(roots[kind]!);
    const dest = resolve(root, name.slice(kind.length + 1));
    if (!dest.startsWith(root + sep)) throw new Error(`files/${name} leaves ${root}`);
    // a folder on the way that is a link to somewhere else is not written through: the nearest one that is there
    let near = dirname(dest);
    while (near !== root && !existsSync(near)) near = dirname(near);
    if (existsSync(near)) {
      const real = realpathSync(near);
      const top = realpathSync(root);
      if (real !== top && !real.startsWith(top + sep)) throw new Error(`${dest} is behind a link`);
    }
    if ((kind === "attachments" || kind === "artifacts") && ownTask(name.slice(kind.length + 1).split("/")[0]!)) continue;
    if (kind === "sessions/claude" && ownSessions.has(basename(name).replace(/\.jsonl$/, ""))) continue;
    if (kind === "sessions/codex" && ownSessions.has(/-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(basename(name))?.[1] ?? "")) continue;
    todo.push({ src, dest, grows: kind.startsWith("sessions/") });
  }
  let written = 0;
  for (const { src, dest, grows } of todo) {
    mkdirSync(dirname(dest), { recursive: true });
    const had = existsSync(dest) ? lstatSync(dest) : null;
    if (had?.isFile() && (grows ? had.size >= lstatSync(src).size : had.size === lstatSync(src).size && readFileSync(dest).equals(readFileSync(src)))) continue;
    const tmp = join(dirname(dest), `.tmp-${process.pid}-${basename(dest)}`);
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
    written++;
  }
  return written;
}

/** Whether a process of this machine is there (one we may not signal is there too). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
