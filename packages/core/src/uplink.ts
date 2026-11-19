import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, type Stats } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { CoreConfig } from "./config.ts";
import { type Db, schemaLevel } from "./db.ts";
import { isMachineName } from "./machine.ts";
import { IN_FLIGHT } from "./task-status.ts";
import { type TarEntry, tarHeaderBytes, tarPad, writeTarZst } from "./transfer.ts";
import { RunnerId } from "@switchboard/protocol";
import { deltaFileRefusal, isRowId, placeOf, unpackDelta, UPLINK_LIMITS, type UplinkLimits } from "./uplink-in.ts";

/**
 * The uplink of a work machine (a PC): what changed since the last send, packed into one file per delta for the
 * instance to take in. A delta is a tar → zstd (the parts of transfer.ts) holding
 *  - `delta.json`: `{ machine, deltaId, schemaLevel, createdAt, repos, tables }`. `tables` maps a table name to its
 *    rows, each row as the table has it (column names as keys), so the taker needs no list of columns of its own;
 *    `schemaLevel` tells it whether it knows them all. `repos` maps this machine's workspace id to `owner/name`
 *    (null when the workspace is not a GitHub repository): the taker moves a Task to its own workspace by that;
 *  - `files/attachments/<task>/<file>` and `files/artifacts/<task>/<artifact>/<…>`: the files of the Tasks in it. A
 *    runner's session file is not among them: it is that runner's own state on the machine it ran on, and nothing a
 *    delta carries is ever written to a runner's folder on the instance (uplink-in.ts).
 *
 * Only what is newer than the mark goes: a Task of this machine (`machine` NULL: rows taken from another machine are
 * not sent on) whose row or any child row is newer, as its whole row; its events, ledger, … rows and its files that are
 * newer. Events, ledger and routing_log rows are told new by where they were written (a Task's event seq, the row id),
 * not by their time: the import of terminal sessions writes them with the time the session had, which may be long
 * before the mark. The other rows and files are told by time. Taking a delta in twice changes nothing, so the time
 * of the mark is held back by `OVERLAP_MS` and a send that failed is simply built again. The mark moves only after a
 * delta was sent: `writeCursor`, called by the sender.
 *
 * The instance takes a delta in with `applyDelta` (below): into the tables it already has, so a Task of a work machine
 * reads like its own (the readers are the same), with `tasks.machine` telling where it ran. To the instance a delta is
 * input from a machine it trusts less than itself: what it checks before any of it is believed is said there.
 */

/** The mark is set back this far when a delta is built (a row written while the last one was being built is sent twice, not never). */
export const OVERLAP_MS = 60_000;

/** One delta's size unpacked (the tar: delta.json with its rows, the files, their headers and padding), not counting zstd: what the 64 MiB of a first send are measured in. */
export const DELTA_MAX_BYTES = 64 * 1024 * 1024;

const CURSOR_KEY = "uplink.cursor";
const EVENT_PAGE = 2000;

/**
 * Where the last send stopped: the time (rows told new by time), the last ledger and routing_log ids, per Task the
 * last event seq sent, and per attachment the size sent.
 */
export interface Cursor {
  at: number;
  ledger: number;
  routing: number;
  seqs: Record<string, number>;
  files: Record<string, number>;
  /** The time in the name of the last delta built: the next one's is later, also when the clock went back, so the instance (which takes keys in their order) never passes one over. Absent = `at`. */
  named?: number;
  /** Per artifact used as an app, its days counted and the request made from it as sent (`<days>:<task>`): those change without the artifact's time moving. Absent = none sent. */
  apps?: Record<string, string>;
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
/** The usage limits per runner and account: not a Task's rows, so they ride in the call's first delta (a few dozen rows, all of them). */
const QUOTA_TABLE = "quota_by_account";
const TABLES = ["tasks", "events", ...CHILD_TABLES.map((c) => c.table), QUOTA_TABLE];

/**
 * The deltas since `since` (the mark; `readCursor` of a database that never sent = everything), written under `opts.dir` (default `<home>/uplink`), oldest Task
 * first. A delta unpacks to at most `opts.maxBytes` (its tar, headers and padding counted): a first send is cut into several, a Task's events by
 * seq (its row comes with the first of them), a file bigger than the limit alone. None when nothing is new. Every
 * delta of one call has the same `createdAt` and `cursor`; the mark moves to it after all of them were sent. A delta's id
 * is `<machine>-<createdAt>-<n>` with `n` padded, so the ids sort in the order the deltas must be taken in. When a
 * delta cannot be written, the ones already written by the call are removed.
 */
export async function buildDelta(db: Db, cfg: CoreConfig, since: Cursor, machine: string, opts: { maxBytes?: number; dir?: string; now?: number } = {}): Promise<BuiltDelta[]> {
  if (!isMachineName(machine)) throw new Error(`machine "${machine}" is not usable in a file name`);
  const max = opts.maxBytes ?? DELTA_MAX_BYTES;
  const dir = opts.dir ?? join(cfg.home, "uplink");
  const createdAt = opts.now ?? Date.now();
  const from = Math.max(0, since.at - OVERLAP_MS);
  const sqlite = db.sqlite;
  const level = schemaLevel();
  const repos = repositories(db);
  const newer = (c: (typeof CHILD_TABLES)[number]) => (c.byId ? `id > ${Number(since[c.byId])}` : c.when.map((w) => `${w} > ${from}`).join(" OR "));
  const stamp = Math.max(createdAt, (since.named ?? since.at) + 1);
  const next: Cursor = {
    at: createdAt,
    named: stamp,
    ledger: (sqlite.query("SELECT max(id) AS n FROM ledger").get() as { n: number | null }).n ?? 0,
    routing: (sqlite.query("SELECT max(id) AS n FROM routing_log").get() as { n: number | null }).n ?? 0,
    seqs: { ...since.seqs },
    files: { ...since.files },
  };

  // artifacts whose use as an app changed since it was sent: their Tasks go, with those rows
  const apps = new Map<string, { task: string; sig: string }>();
  for (const a of sqlite.query("SELECT id, task_id, app_days, app_request_task_id FROM artifacts WHERE app_days > 0 OR app_request_task_id IS NOT NULL").all() as Array<{ id: string; task_id: string; app_days: number; app_request_task_id: string | null }>) {
    const sig = `${a.app_days}:${a.app_request_task_id ?? ""}`;
    if (since.apps?.[a.id] !== sig) apps.set(a.id, { task: a.task_id, sig });
  }
  const appTasks = new Set([...apps.values()].map((a) => a.task));
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
    .filter((r) => r.changed || appTasks.has(r.id) || ((lastSeq.get(r.id) as { s: number | null }).s ?? 0) > (since.seqs[r.id] ?? 0))
    .map((r) => r.id);
  if (ids.length === 0) return [];
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const built: BuiltDelta[] = [];
  let tables: Record<string, string[]> = {};
  let files: Array<{ name: string; path: string }> = [];
  let bytes = 0;
  let items = 0;
  const headOf = (deltaId: string, rows: Record<string, string[]>) => `{"machine":${JSON.stringify(machine)},"deltaId":${JSON.stringify(deltaId)},"schemaLevel":${level},"createdAt":${createdAt},"repos":${JSON.stringify(repos)},"tables":{${TABLES.map((t) => `${JSON.stringify(t)}:[${rows[t]!.join(",")}]`).join(",")}}}\n`;
  // what a delta weighs once unpacked before any row or file: delta.json (its tables empty) with its tar header and the
  // most its padding can be, and the two empty blocks that end the tar. A row adds its JSON and a comma; a file adds its
  // headers (a pax record too when its name needs one), its bytes and the padding after them.
  const fixed = 512 + Buffer.byteLength(headOf(`${machine}-${stamp}-${"0".repeat(6)}`, Object.fromEntries(TABLES.map((t) => [t, []])))) + 511 + 1024;
  const empty = () => ((tables = Object.fromEntries(TABLES.map((t) => [t, [] as string[]]))), (files = []), (bytes = fixed), (items = 0));
  empty();
  const flush = async () => {
    if (items === 0) return;
    const deltaId = `${machine}-${stamp}-${String(built.length).padStart(6, "0")}`;
    const head = headOf(deltaId, tables);
    const file = join(dir, `${deltaId}.tar.zst`);
    const entries: TarEntry[] = [{ name: "delta.json", bytes: Buffer.from(head) }, ...files.map((f): TarEntry => ({ name: `files/${f.name}`, path: f.path }))];
    // an attachment that was gone (or a link) when the tar was written did not go: its size is not what the mark says was
    // sent, so the next call sees it as changed. `next` is the one the deltas of this call share.
    for (const gone of await writeTarZst(file, entries)) {
      const name = gone.slice("files/".length);
      if (!name.startsWith("attachments/")) continue;
      if (since.files[name] === undefined) delete next.files[name];
      else next.files[name] = since.files[name]!;
    }
    built.push({ deltaId, file, cursor: next });
    empty();
  };
  /** Adds `size` (what it weighs unpacked) to the delta being filled, closing it first when it would pass the limit (a delta is never closed empty). */
  const room = async (size: number) => {
    if (items > 0 && bytes + size > max) await flush();
    bytes += size;
    items++;
  };
  const addRow = async (table: string, row: Row) => {
    const json = JSON.stringify(row);
    await room(Buffer.byteLength(json) + 1);
    tables[table]!.push(json);
  };
  /** Whether the file went in: one the instance would refuse (its name, its size) is left out and said, so it never holds the deltas after it. */
  const addFile = async (name: string, path: string, size: number): Promise<boolean> => {
    const why = deltaFileRefusal(cfg, name, size);
    if (why) {
      console.warn(`[uplink] not sent: ${why}`);
      return false;
    }
    await room(tarHeaderBytes(`files/${name}`, size) + size + tarPad(size));
    files.push({ name, path });
    return true;
  };

  // the attachments folder as it really is, a link to it followed (read once: the check below compares every file with it)
  const root = realPath(cfg.attachmentsDir);
  try {
    // A usage report comes from a Task's turn, so whenever a limit moved there is a Task to send it with. The rows
    // carry the account's stored name (a hash), never the provider's id.
    for (const r of sqlite.query(`SELECT * FROM ${QUOTA_TABLE} ORDER BY runner, account, window`).all() as Row[]) await addRow(QUOTA_TABLE, r);
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
        if (table === "artifacts") {
          for (const [aid, a] of apps) {
            if (a.task !== id) continue;
            if (!rows.some((r) => r.id === aid)) rows.push(sqlite.query("SELECT * FROM artifacts WHERE id = ?").get(aid) as Row);
            (next.apps ??= { ...since.apps })[aid] = a.sig;
          }
        }
        for (const r of rows) {
          if (table !== "attachments") {
            await addRow(table, r);
            continue;
          }
          // only a file in the attachments folder is this machine's to send (a row says where its file is, a tampered one
          // anywhere), and where the file really is, a link on the way followed: a folder of the Task that is a link out leads out
          const path = resolve(String(r.path));
          const real = realPath(path);
          const size = real === null ? null : fileSize(real);
          if (real === null || size === null || root === null || !path.startsWith(resolve(cfg.attachmentsDir) + sep) || !real.startsWith(root + sep)) {
            if (Number(r.created_at) > from) await addRow(table, r);
            continue;
          }
          const name = `attachments/${relative(cfg.attachmentsDir, path)}`;
          if (size === since.files[name]) continue;
          await addRow(table, r);
          await addFile(name, real, size);
          next.files[name] = size;
        }
      }
      for (const f of filesUnder(join(cfg.artifactsDir, id), `artifacts/${id}`)) if (f.mtimeMs >= from) await addFile(f.name, f.path, f.size);
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

/** Whether something is at `path`, a link that leads nowhere included. */
const lexists = (path: string) => statOrNull(path) !== null;

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function realPath(path: string): string | null {
  try {
    return realpathSync(path);
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
  // its use as an app is counted without moving its time (the list is ordered by it): more days counted, or a request made from it, is newer too
  artifacts: { key: "id", newer: "excluded.updated_at > artifacts.updated_at OR excluded.app_days > artifacts.app_days OR (excluded.app_request_task_id IS NOT NULL AND artifacts.app_request_task_id IS NULL)" },
  // an account's usage is what its provider last reported, whichever machine heard it: the newer report stays (never added up)
  [QUOTA_TABLE]: { key: "runner, account, window", newer: "excluded.ts > quota_by_account.ts" },
  // a row that has a key is left as it is: events never change, an attachment's row is written once, and ledger /
  // routing_log are told apart by (task_id, src_id), their own ids being the instance's
  attachments: null,
  events: null,
  ledger: null,
  routing_log: null,
};
/** Statuses of a turn in flight: start-up closes them as its own. A Task of a work machine comes in as idle. */
const COMES_IN_IDLE = new Set<string>([...IN_FLIGHT, "background"]);
/**
 * Columns this instance acts on (resume after a limit, the run queue, judging, a prompt held for a later start, the
 * schedule a Task came from): empty on a Task of a work machine, whatever the delta says.
 */
const ACTED_ON = ["resume_at", "resume_reason", "resume_window", "resume_since", "resume_planned_at", "queued_at", "judging_at", "deferred_prompt", "schedule_id"];
/** Written in this order (a Task first, its children after). */
const APPLY_ORDER = ["tasks", "ledger", "routing_log", "task_evals", "check_runs", "staging", "artifacts", "attachments"];
/** How far ahead of this instance's clock a usage report may be dated, and how far ahead a limit may say it resets (the longest window is a week). */
const QUOTA_AHEAD_MS = 5 * 60_000;
const QUOTA_RESET_AHEAD_MS = 8 * 24 * 3600_000;
/** The end of a delta's id after the machine's name: when it was made and its place in that build. */
const DELTA_ID_TAIL = /-\d{1,16}-\d{6}$/;

/** Where a delta came from, as this instance knows it — never as the delta says it. */
export interface DeltaOrigin {
  /** The registered machine under whose prefix the object lay. */
  machine: string;
  /** The repositories (`owner/name`) that machine is registered for: only a Task of one of them is put on a workspace here. */
  repositories: string[];
}

interface Delta {
  machine: string;
  deltaId: string;
  schemaLevel: number;
  /** When the sender built it (every delta of one call has the same); 0 when it says none. */
  createdAt: number;
  repos: Record<string, string | null>;
  tables: Record<string, Row[]>;
}

/** The tables whose rows have an id of their own that this instance uses as a name (a folder, a file, a key). */
const ROWS_WITH_ID = ["staging", "artifacts", "attachments"];
/** The columns of a row that this instance reads as a time. */
const ROW_TIMES: Record<string, string[]> = { artifacts: ["removed_at", "updated_at", "created_at"], staging: ["ts", "decided_at"], attachments: ["created_at"] };
/**
 * A usage report a work machine may bring: a runner this code knows, a window's name, a share between 0 and 1.5, and an
 * account under the name an adapter gives one (16 hex characters). A row without an account's name is not taken: the
 * unnamed rows are this instance's own reports waiting for its account, and a work machine does not write those.
 */
function quotaRowOk(r: Row): boolean {
  const u = r.utilization;
  return RunnerId.safeParse(r.runner).success && typeof r.window === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(r.window) && typeof u === "number" && u >= 0 && u <= 1.5 && typeof r.account === "string" && /^[0-9a-f]{16}$/.test(r.account);
}

/** `delta.json` as an object of the shape a delta has, or the reason it is not one. Only the shape: who it is from is the caller's to compare. */
function readDelta(raw: unknown): Delta {
  const bad = (why: string) => new Error(`not a delta: ${why}`);
  const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!plain(raw)) throw bad("delta.json is not an object");
  const { machine, deltaId, schemaLevel: level } = raw;
  if (!isMachineName(machine)) throw bad("the machine is not usable");
  if (typeof deltaId !== "string" || deltaId.length > 100 || !DELTA_ID_TAIL.test(deltaId) || typeof level !== "number" || !Number.isInteger(level)) throw bad("it has no id or level");
  const repos: Record<string, string | null> = {};
  if (raw.repos !== undefined && !plain(raw.repos)) throw bad("repos is not a map");
  for (const [id, repo] of Object.entries((raw.repos as Record<string, unknown> | undefined) ?? {})) {
    if (repo !== null && typeof repo !== "string") throw bad("repos names something that is not a repository");
    repos[id] = repo;
  }
  if (raw.tables !== undefined && !plain(raw.tables)) throw bad("tables is not a map");
  const tables: Record<string, Row[]> = {};
  for (const [table, rows] of Object.entries((raw.tables as Record<string, unknown> | undefined) ?? {})) {
    if (!TABLES.includes(table)) throw bad(`${table.slice(0, 60)} is not a table a delta carries`);
    if (!Array.isArray(rows) || !rows.every(plain)) throw bad(`the rows of ${table} are not rows`);
    for (const r of rows as Row[]) {
      // a row's values are bound as they are: only what a column holds
      for (const v of Object.values(r)) if (v !== null && typeof v !== "string" && typeof v !== "number") throw bad(`a value in ${table} is not a text or a number`);
      if (table === QUOTA_TABLE) continue;
      // a Task's id and the id of a row with a folder or a file of its own are folder names on this instance: only a
      // plain name comes in (one that is not would stop the artifacts' sweep at the next start, or name another place)
      if (!isRowId(table === "tasks" ? r.id : r.task_id)) throw bad(`a row of ${table} names no Task`);
      if (ROWS_WITH_ID.includes(table) && !isRowId(r.id)) throw bad(`a row of ${table} has an id that is not a plain name`);
      // the times the instance acts on (what to delete at a start, which row is newer) are numbers or nothing
      for (const c of ROW_TIMES[table] ?? []) if (r[c] !== undefined && r[c] !== null && !(typeof r[c] === "number" && Number.isFinite(r[c]))) throw bad(`${c} of a row of ${table} is not a time`);
    }
    tables[table] = rows as Row[];
  }
  const createdAt = typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : 0;
  return { machine, deltaId, schemaLevel: level, createdAt, repos, tables };
}

/**
 * Takes a delta file (`buildDelta`'s) into this instance. Taking one in twice changes nothing: a Task, an eval, a check
 * run, a staged change and an artifact are replaced only by a newer row, an event is kept as it is, and a ledger or
 * routing_log row is told apart by its `src_id` (the id it had where it was made; here it gets an id of its own).
 * A Task goes to the workspace here that reads the same GitHub repository (none: no workspace) and gets `machine` of the
 * sender. A delta from a database with more columns than this one is left out with its reason in `uplink.skipped`
 * (there is no reader of an older shape); upgrading this instance is what takes it in later.
 *
 * The delta is input from a machine this instance trusts less than itself (`from`: the registered machine whose prefix
 * it lay under). Before anything of it is written to the database:
 *  - it is unpacked within limits, and every file's name has the shape of a Task's attachment or artifact file
 *    (uplink-in.ts) — anything else, a link, or a name that leaves the Task's folder refuses the whole delta;
 *  - the machine it names is `from.machine`, and so is the machine in its id;
 *  - every Task it names is new here or already that machine's. One that is another machine's refuses the delta (a
 *    machine cannot write over another's record); one that is this instance's own is passed over, with its rows and files;
 *  - a file is written only where it is the delta's turn to write it: not into a Task that is this instance's own, not
 *    through a link (a folder on the way, or one left at the temp name: that one is removed, and the copy is made
 *    exclusively), and not into an artifact whose row here is newer than the delta's row, or, when the delta brings no
 *    row for it (a send cut into several deltas puts a row and its files in different ones), newer than the delta's
 *    `createdAt` (an older delta taken in again leaves the row and its files at the newer version);
 *  - a Task is put on a workspace only when its repository is one the machine is registered for;
 *  - the id it names itself by is the one the caller knows it by (`expectId`: its key in the bucket);
 *  - every row's Task id, and the id of a staged change, an artifact and an attachment, is a plain name, and their
 *    times are numbers;
 *  - a usage report dated ahead of this clock, a limit said to reset further ahead than any window lasts, and a report
 *    that is not one a runner here could make (`quotaRowOk`) is dropped.
 * A delta that fails one of these throws.
 *
 * A Task of a work machine is only read here: its row comes in with no state that this instance acts on (a status of
 * a turn in flight becomes idle; no resume, queue or judging mark, no held prompt, no schedule), and TaskManager
 * refuses to run, resume, answer or stop it (machine.ts). A staged change still waiting for its approval does not come
 * in: it is the work machine's to decide.
 *
 * Deltas are taken in the order they were made (a Task's row comes only with the first delta it is in; its later deltas
 * hold what came after). The events go in batches of their own, each one transaction, so a writer is never held for
 * long; the Task rows, everything else and the mark in `uplink.applied` go in one transaction last. A delta that fails
 * half way has put only events (no Task to show them with) and files, and is taken in again whole.
 */
export async function applyDelta(db: Db, cfg: CoreConfig, file: string, from: DeltaOrigin, opts: { now?: number; eventBatch?: number; limits?: UplinkLimits; /** The id the caller knows the delta by (its key in the bucket): one that holds another id is refused before anything of it is written. */ expectId?: string } = {}): Promise<ApplyResult> {
  const sqlite = db.sqlite;
  const now = opts.now ?? Date.now();
  // what a process that is gone left unpacked (`uplink-in-<pid>-<time>`)
  for (const d of existsSync(cfg.home) ? readdirSync(cfg.home) : []) {
    const pid = /^uplink-in-(\d+)-/.exec(d)?.[1];
    if (pid && !alive(Number(pid))) rmSync(join(cfg.home, d), { recursive: true, force: true });
  }
  mkdirSync(cfg.home, { recursive: true });
  const stage = mkdtempSync(join(cfg.home, `uplink-in-${process.pid}-`));
  try {
    const unpacked = await unpackDelta(file, stage, (name) => {
      const at = placeOf(cfg, name);
      if ("refusal" in at) throw new Error(at.refusal);
    }, opts.limits ?? UPLINK_LIMITS);
    const delta = readDelta(unpacked.delta);
    const { machine, deltaId } = delta;
    if (machine !== from.machine) throw new Error(`delta ${deltaId} says it is from ${machine}, and lay under ${from.machine}`);
    if (deltaId.replace(DELTA_ID_TAIL, "") !== machine) throw new Error(`delta ${deltaId} does not carry the name of ${machine}`);
    if (opts.expectId !== undefined && deltaId !== opts.expectId) throw new Error(`it holds delta ${deltaId}, not the one its name says`);
    const ours = schemaLevel();
    if (delta.schemaLevel > ours) {
      const reason = `delta ${deltaId} from ${machine} has a database of level ${delta.schemaLevel}, this one is ${ours}: left out until this instance is upgraded`;
      const entry: Skipped = { machine, deltaId, theirs: delta.schemaLevel, ours, at: now };
      db.setSetting(SKIPPED_KEY, [...listSkipped(db).filter((s) => s.deltaId !== deltaId), entry].slice(-KEPT));
      return { status: "skipped", deltaId, machine, reason };
    }

    const tables = delta.tables;
    // whose each Task is, by this database: this instance's own (passed over), this machine's or new (taken), another's (refused)
    const ownerOf = sqlite.query("SELECT machine FROM tasks WHERE id = ?");
    const arriving = new Set((tables.tasks ?? []).map((r) => String(r.id)));
    const own = new Set<string>();
    const judge = (id: string, what: string) => {
      const row = ownerOf.get(id) as { machine: string | null } | null;
      if (row && row.machine === null) return void own.add(id);
      if (row && row.machine !== machine) throw new Error(`delta ${deltaId} from ${machine} names Task ${id.slice(0, 80)} of ${row.machine}`);
      if (!row && !arriving.has(id)) throw new Error(`delta ${deltaId} from ${machine} has ${what} of a Task it does not bring and this instance does not have (${id.slice(0, 80)})`);
    };
    for (const [table, list] of Object.entries(tables)) if (table !== QUOTA_TABLE) for (const r of list) judge(String(table === "tasks" ? r.id : r.task_id), `a row of ${table}`);
    for (const f of unpacked.files) judge(f.name.split("/")[1]!, "a file");
    // a delta continues each Task's events right after the last one its machine sent: events that start past what is
    // here mean a delta before this one did not go in (it was refused and passed over) — this one is not put on the hole
    const lastHere = sqlite.query("SELECT max(seq) AS s FROM events WHERE task_id = ?");
    const firstIn = new Map<string, number>();
    for (const e of tables.events ?? []) {
      const id = String(e.task_id);
      const seq = Number(e.seq);
      if (!own.has(id) && Number.isFinite(seq) && seq < (firstIn.get(id) ?? Infinity)) firstIn.set(id, seq);
    }
    for (const [id, first] of firstIn) {
      const have = (lastHere.get(id) as { s: number | null } | null)?.s ?? 0;
      if (first > have + 1) throw new Error(`delta ${deltaId} from ${machine} continues Task ${id.slice(0, 80)} from event ${first}, and this instance has it up to ${have}: it depends on a delta that was not taken in`);
    }
    // a row told apart by an id of its own stays with the Task it has here: a delta cannot move another Task's row to one of its own
    for (const table of ["staging", "artifacts", "attachments"]) {
      const taskOf = sqlite.query(`SELECT task_id FROM ${table} WHERE id = ?`);
      for (const r of tables[table] ?? []) {
        const had = taskOf.get((r.id ?? null) as string | null) as { task_id: string | null } | null;
        if (had && had.task_id !== r.task_id) throw new Error(`delta ${deltaId} from ${machine} names a row of ${table} that belongs to another Task here`);
      }
    }
    // an artifact whose row here is newer than the delta's keeps its files: the row and the files stay one version. A
    // file whose row the delta does not bring is compared with when the delta was built (its row came in an earlier part)
    const arrivingAt = new Map((tables.artifacts ?? []).map((r) => [String(r.id), Number(r.updated_at)]));
    const rowAt = sqlite.query("SELECT updated_at FROM artifacts WHERE id = ?");
    const stale = new Set<string>();
    for (const f of unpacked.files) {
      const [kind, , id] = f.name.split("/");
      if (kind !== "artifacts" || !id) continue;
      const here = (rowAt.get(id) as { updated_at: number } | null)?.updated_at;
      const theirs = arrivingAt.get(id) ?? delta.createdAt;
      if (here !== undefined && !(theirs >= here)) stale.add(f.name);
    }
    const placed = placeFiles(cfg, unpacked.files, (id) => own.has(id), stale);
    // only a repository the machine is registered for puts a Task on a workspace here
    const registered = new Set(from.repositories.map((r) => r.toLowerCase()));
    const workspaces = remapWorkspaces(db, Object.fromEntries(Object.entries(delta.repos).map(([id, repo]) => [id, repo !== null && registered.has(repo.toLowerCase()) ? repo : null])));
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
            // the file went under this instance's folder, by the Task's id and the file's name: the row's own path is the sender's
            const at = placeOf(cfg, `attachments/${String(r.task_id)}/${basename(String(r.path))}`);
            if ("refusal" in at) continue;
            row.path = at.dest;
          }
          rows[table]! += put(table, row);
        }
      }
      rows[QUOTA_TABLE] = 0;
      for (const r of tables[QUOTA_TABLE] ?? []) {
        const ts = Number(r.ts);
        const resets = Number(r.resets_at);
        const resetsMs = resets < 1e11 ? resets * 1000 : resets; // kept in seconds
        if (!Number.isFinite(ts) || !Number.isFinite(resets) || ts > now + QUOTA_AHEAD_MS || resetsMs > now + QUOTA_RESET_AHEAD_MS || !quotaRowOk(r)) continue;
        rows[QUOTA_TABLE]! += put(QUOTA_TABLE, r);
      }
      db.setSetting(APPLIED_KEY, [...listApplied(db).filter((d) => d !== deltaId), deltaId].slice(-KEPT));
      // one left out before (this instance was older then) is no longer one that could not be taken in
      if (listSkipped(db).some((s) => s.deltaId === deltaId)) db.setSetting(SKIPPED_KEY, listSkipped(db).filter((s) => s.deltaId !== deltaId));
    })();
    return { status: "applied", deltaId, machine, rows, files: placed };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Moves the unpacked files to their places (`placeOf`: inside the Task's own folder of attachments or artifacts, never
 * anywhere else): a file that is not there or differs is written. The files of a Task that is this instance's own
 * (`ownTask`, by the database) are left, and so are the files named in `stale` (an artifact's whose row here is newer
 * than the delta's). A place whose way goes through a link out of that Task's folder refuses the
 * delta before anything is placed. Returns how many were written.
 */
function placeFiles(cfg: CoreConfig, files: Array<{ name: string; path: string; size: number }>, ownTask: (id: string) => boolean, stale: ReadonlySet<string>): number {
  const todo: Array<{ src: string; dest: string }> = [];
  for (const f of files) {
    const at = placeOf(cfg, f.name);
    if ("refusal" in at) throw new Error(at.refusal);
    if (ownTask(at.task)) continue;
    if (stale.has(f.name)) continue;
    const root = resolve(at.kind === "attachments" ? cfg.attachmentsDir : cfg.artifactsDir);
    // a folder on the way that is a link to somewhere else is not written through: the nearest one that is there
    // resolves to a place inside this Task's own folder (not merely inside the store: another Task's folder is
    // somewhere else too). Above the Task's folder nothing is there yet, and the store itself is the place.
    let near = dirname(at.dest);
    while (near !== root && near !== dirname(near) && !lexists(near)) near = dirname(near);
    if (lexists(near) && existsSync(root)) {
      const top = realpathSync(root);
      const own = join(top, at.task);
      let real: string;
      try {
        real = realpathSync(near);
      } catch {
        throw new Error(`${at.dest} is behind a link`);
      }
      if (near === root ? real !== top : real !== own && !real.startsWith(own + sep)) throw new Error(`${at.dest} is behind a link`);
    }
    const there = statOrNull(at.dest);
    if (there && !there.isFile()) throw new Error(`${at.dest} is not a file here`);
    todo.push({ src: f.path, dest: at.dest });
  }
  let written = 0;
  for (const { src, dest } of todo) {
    mkdirSync(dirname(dest), { recursive: true });
    const had = statOrNull(dest);
    if (had?.isFile() && had.size === lstatSync(src).size && readFileSync(dest).equals(readFileSync(src))) continue;
    const tmp = join(dirname(dest), `.tmp-${process.pid}-${basename(dest)}`);
    // a link left at the temp name is removed itself, and the copy never opens what it points to
    rmSync(tmp, { force: true });
    copyFileSync(src, tmp, constants.COPYFILE_EXCL);
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
