import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { ageBinary } from "./transfer.ts";

/**
 * Moving the bodies of a finished task's events out of the database (#1431).
 *
 * Two steps with the upload between them, which is the shell's (`aws/host/archive.sh`, like `export`): `prepare` writes
 * one encrypted file per old finished task and a manifest; `commit` replaces the rows of the tasks the shell reports as
 * uploaded with skeletons and records where they went. A task that was not uploaded is not touched, so a failed
 * upload loses nothing.
 */
export const EVENTS_ARCHIVE_DAYS = 30;

const DAY_MS = 86_400_000;
/** Task ids become file names and S3 keys; anything else is not archived. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export interface ManifestEntry {
  taskId: string;
  file: string;
  count: number;
  maxSeq: number;
  sha256: string;
}

interface Row {
  seq: number;
  ts: number;
  json: string;
}

/**
 * What stays of a task's events once the bodies are gone. Light events (status, usage, quota, session.*, stop.record,
 * permission.*, error, …) stay as they are. A tool call keeps `id` and `name`, a result `id` and `ok`, the person's
 * words stay, and an assistant message is its first row with an empty text: a run of consecutive assistant rows of the
 * same message becomes that one row. The run's last row also stays when it is the task's last event, so the task's
 * last `ts` (its duration, `TASK_DURATION_SQL` and `ruleMetrics`) does not move. Everything that reads the rows
 * (metrics, stops, permissions, the last reply) keeps its value: they use `t`, `ok`, `status`, `ts` and the order only.
 */
export function skeletonize(rows: Row[]): { update: Map<number, string>; remove: number[] } {
  const update = new Map<number, string>();
  const remove: number[] = [];
  const last = rows.length ? rows[rows.length - 1]!.seq : -1;
  let run: { messageId: string | undefined } | null = null;
  for (const r of rows) {
    const ev = JSON.parse(r.json) as { t: string; [k: string]: unknown };
    if (ev.t === "message.delta" && ev.role === "assistant") {
      const messageId = typeof ev.messageId === "string" ? ev.messageId : undefined;
      if (run && run.messageId === messageId) {
        if (r.seq !== last) remove.push(r.seq);
        else update.set(r.seq, JSON.stringify({ t: "message.delta", role: "assistant", text: "", ...(messageId ? { messageId } : {}) }));
      } else {
        run = { messageId };
        update.set(r.seq, JSON.stringify({ t: "message.delta", role: "assistant", text: "", ...(messageId ? { messageId } : {}) }));
      }
      continue;
    }
    run = null;
    if (ev.t === "tool.call") update.set(r.seq, JSON.stringify({ t: "tool.call", id: ev.id, name: ev.name, summary: "" }));
    else if (ev.t === "tool.result") update.set(r.seq, JSON.stringify({ t: "tool.result", id: ev.id, ok: ev.ok, summary: "" }));
  }
  return { update, remove };
}

const encode = (rows: Row[]) => Buffer.from(rows.map((r) => JSON.stringify({ seq: r.seq, ts: r.ts, json: r.json })).join("\n") + "\n");

async function encrypt(bytes: Uint8Array, recipient: string): Promise<Uint8Array> {
  const p = Bun.spawn([ageBinary(), "-r", recipient], { stdin: bytes, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`age failed (${code}): ${err.trim()}`);
  return new Uint8Array(out);
}

/**
 * Write `<taskId>.<last seq>.jsonl.zst[.age]` for every task that finished more than 30 days ago, has events and was not
 * archived yet (or has events after the last archive's last seq: resumed and finished again), and `manifest.json` listing them. Without `encryptTo` the files are not encrypted (tests; the CLI requires it).
 */
export async function prepareEventsArchive(db: Database, outDir: string, opts: { encryptTo?: string; now?: number } = {}): Promise<ManifestEntry[]> {
  const cutoff = (opts.now ?? Date.now()) - EVENTS_ARCHIVE_DAYS * DAY_MS;
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const tasks = db
    .query(
      `SELECT t.id FROM tasks t WHERE t.status IN ('done', 'error', 'aborted') AND t.updated_at < ? AND (t.events_archived_at IS NULL OR EXISTS (SELECT 1 FROM events n WHERE n.task_id = t.id AND n.seq > t.events_archived_max_seq))
         AND EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id) ORDER BY t.updated_at`,
    )
    .all(cutoff) as Array<{ id: string }>;
  const entries: ManifestEntry[] = [];
  for (const { id } of tasks) {
    if (!SAFE_ID.test(id)) continue;
    const rows = db.query("SELECT seq, ts, json FROM events WHERE task_id = ? ORDER BY seq").all(id) as Row[];
    let bytes: Uint8Array = Bun.zstdCompressSync(encode(rows));
    if (opts.encryptTo) bytes = await encrypt(bytes, opts.encryptTo);
    const maxSeq = rows[rows.length - 1]!.seq;
    // The last seq is in the name: a task that was resumed and finished again is written again without replacing the first file.
    const file = `${id}.${maxSeq}.jsonl.zst${opts.encryptTo ? ".age" : ""}`;
    writeFileSync(join(outDir, file), bytes, { mode: 0o600 });
    entries.push({ taskId: id, file, count: rows.length, maxSeq, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(entries, null, 2), { mode: 0o600 });
  return entries;
}

/**
 * For each task in the manifest that `uploaded` names (taskId → S3 key): in one transaction, check the rows are still
 * what was written (same count and last seq, the task still finished and not archived), replace them with the skeleton
 * and record key, time and count. A task whose rows changed meanwhile is skipped (the next run writes it again).
 * Then give the freed pages back. Returns the task ids that were moved.
 */
export function commitEventsArchive(db: Database, outDir: string, uploaded: Map<string, string>, opts: { now?: number } = {}): string[] {
  const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")) as ManifestEntry[];
  const done: string[] = [];
  const now = opts.now ?? Date.now();
  for (const m of manifest) {
    const key = uploaded.get(m.taskId);
    if (!key) continue;
    // IMMEDIATE: a deferred one reads first and then cannot write once the daemon committed in between — SQLITE_BUSY_SNAPSHOT,
    // which busy_timeout does not wait out ("database is locked" failed the 2026-10-20 archive after the upload; #1597 is the same)
    const moved = db.transaction(() => {
      const t = db.query("SELECT status, events_archive_key AS key, events_archived_max_seq AS maxSeq FROM tasks WHERE id = ?").get(m.taskId) as { status: string; key: string | null; maxSeq: number | null } | null;
      // Already archived up to this seq: the same manifest twice. (A seq, not a ts: an import keeps the time a record happened.)
      if (!t || (t.maxSeq !== null && m.maxSeq <= t.maxSeq) || !["done", "error", "aborted"].includes(t.status)) return false;
      const cur = db.query("SELECT count(*) AS n, COALESCE(max(seq), 0) AS m FROM events WHERE task_id = ?").get(m.taskId) as { n: number; m: number };
      if (cur.n !== m.count || cur.m !== m.maxSeq) return false;
      const { update, remove } = skeletonize(db.query("SELECT seq, ts, json FROM events WHERE task_id = ? ORDER BY seq").all(m.taskId) as Row[]);
      const set = db.query("UPDATE events SET json = ? WHERE task_id = ? AND seq = ?");
      for (const [seq, json] of update) set.run(json, m.taskId, seq);
      const del = db.query("DELETE FROM events WHERE task_id = ? AND seq = ?");
      for (const seq of remove) del.run(m.taskId, seq);
      // Keys of earlier files stay (one per line, oldest first): the newest file holds the earlier conversation only as skeletons.
      db.query("UPDATE tasks SET events_archive_key = ?, events_archived_at = ?, events_archived_count = ?, events_archived_max_seq = ? WHERE id = ?").run(t.key ? `${t.key}\n${key}` : key, now, m.count, m.maxSeq, m.taskId);
      return true;
    }).immediate();
    if (moved) done.push(m.taskId);
  }
  if (done.length) db.exec("PRAGMA incremental_vacuum");
  return done;
}

/** `taskId<TAB>key` lines of `<dir>/uploaded.tsv` — what `archive.sh` managed to upload. */
export function readUploaded(outDir: string): Map<string, string> {
  const file = join(outDir, "uploaded.tsv");
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [id, key] = line.split("\t");
    if (id && key) out.set(id, key);
  }
  return out;
}
