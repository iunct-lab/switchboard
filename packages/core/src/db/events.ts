/** A Task's events. */

import { AskQuestion } from "@switchboard/protocol";
import type { AgentEvent, EventEnvelope, StopRecord } from "@switchboard/protocol";
import { TaskQueries } from "./tasks.ts";

/** The prefixes listEventsByPrefix reads, with the length each events_* index compares: keep them equal to SCHEMA's WHERE. */
const EVENT_PREFIX_INDEX: Record<string, number> = {
  '{"t":"permission.ask",': 22,
  '{"t":"permission.resolved",': 27,
  '{"t":"message.delta","role":"user"': 34,
  '{"t":"stop.record",': 19,
};

/** listEventsByPrefix's query (exported for the test's EXPLAIN QUERY PLAN): one SELECT per prefix, each WHERE the events_* index's word for word. */
export function eventsByPrefixSql(prefixes: string[]): string {
  return prefixes
    .map((p) => {
      const len = EVENT_PREFIX_INDEX[p];
      if (len === undefined) throw new Error(`listEventsByPrefix: no index for the prefix ${p}`);
      // the literal has no quote, so it is safe inline
      return `SELECT task_id, ts, seq, json FROM events WHERE substr(json, 1, ${len}) = '${p}'`;
    })
    .join(" UNION ALL ");
}

const PERMISSION_PREFIXES = ['{"t":"permission.ask",', '{"t":"permission.resolved",'];
const PERMISSION_EVENTS_CHUNK = 500;

/** The query `listPermissionEvents` runs for one prefix and `n` task ids (bound as `?`): the WHERE of the prefix's partial index. */
export function permissionEventsSql(prefix: string, n: number): string {
  const len = EVENT_PREFIX_INDEX[prefix];
  if (len === undefined) throw new Error(`listPermissionEvents: no index for the prefix ${prefix}`);
  // the literal has no quote, so it is safe inline (as in eventsByPrefixSql)
  return `SELECT task_id, ts, seq, json FROM events WHERE task_id IN (${Array(n).fill("?").join(", ")}) AND substr(json, 1, ${len}) = '${prefix}'`;
}

/** The most events one page of a Task's conversation returns: `limit` is clamped to it, and a page that reaches back to a message's start stops there. */
export const EVENTS_PAGE_MAX = 5000;

/** A Task's events. One link of the chain of classes that ends in `Db` (db.ts): the methods are reached as `db.<method>()`. */
export class EventQueries extends TaskQueries {
  /** The `stop.record` events of these tasks, oldest first. */
  listStopRecords(taskIds: string[]): StopRecord[] {
    // a prefix compare, not json_extract over every event of the task: `t` is always written first (appendEvent's JSON.stringify of `{ t, … }`)
    // the events_stop index has this WHERE word for word: change both together, or the index is not used
    const q = this.sqlite.query(`SELECT ts, seq, json FROM events WHERE task_id = ? AND substr(json, 1, 19) = '{"t":"stop.record",'`);
    const rows = taskIds.flatMap((id) => q.all(id) as Array<{ ts: number; seq: number; json: string }>);
    return rows.sort((a, b) => a.ts - b.ts || a.seq - b.seq).map((r) => (JSON.parse(r.json) as { stop: StopRecord }).stop);
  }

  /**
   * The `stop.record` events of every stopped Task (waiting / done / error / aborted) that is not reviewed (確認済み) nor archived, by Task id,
   * oldest first, in one query (not one per Task). The same prefix compare as listStopRecords.
   */
  listStopRecordsOfStopped(): Map<string, StopRecord[]> {
    const rows = this.sqlite
      .query(
        `SELECT e.task_id, e.ts, e.seq, e.json FROM events e JOIN tasks t ON t.id = e.task_id
         WHERE substr(e.json, 1, 19) = '{"t":"stop.record",' AND t.reviewed_at IS NULL AND t.archived_at IS NULL AND t.status IN ('waiting', 'done', 'error', 'aborted')`,
      )
      .all() as Array<{ task_id: string; ts: number; seq: number; json: string }>;
    rows.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    const out = new Map<string, StopRecord[]>();
    for (const r of rows) {
      const list = out.get(r.task_id) ?? [];
      list.push((JSON.parse(r.json) as { stop: StopRecord }).stop);
      out.set(r.task_id, list);
    }
    return out;
  }

  /**
   * The permission.ask / permission.resolved events of these tasks, oldest first (ties in the order of `taskIds`). Each kind
   * is read with the WHERE of its partial index (events_ask / events_resolved), word for word (`permissionEventsSql`), so
   * the rows come from the index and not from every event of the task.
   */
  listPermissionEvents(taskIds: string[]): EventEnvelope[] {
    const rows: Array<{ task_id: string; ts: number; seq: number; json: string }> = [];
    for (let i = 0; i < taskIds.length; i += PERMISSION_EVENTS_CHUNK) {
      const chunk = taskIds.slice(i, i + PERMISSION_EVENTS_CHUNK);
      for (const p of PERMISSION_PREFIXES) rows.push(...(this.sqlite.query(permissionEventsSql(p, chunk.length)).all(...chunk) as typeof rows));
    }
    const order = new Map(taskIds.map((id, i) => [id, i]));
    return rows
      .sort((a, b) => a.ts - b.ts || a.seq - b.seq || order.get(a.task_id)! - order.get(b.task_id)!)
      .map((r) => ({ taskId: r.task_id, ts: r.ts, seq: r.seq, ev: JSON.parse(r.json) as AgentEvent }));
  }

  /**
   * The events of every task whose JSON begins with one of these, oldest first — one UNION ALL of the per-prefix
   * partial indexes, with the prefix compare of listStopRecords (`t` is always written first). A prefix not in
   * EVENT_PREFIX_INDEX throws: add its index to SCHEMA and the table together.
   */
  listEventsByPrefix(prefixes: string[]): EventEnvelope[] {
    if (prefixes.length === 0) return [];
    const rows = this.sqlite.query(eventsByPrefixSql(prefixes)).all() as Array<{ task_id: string; ts: number; seq: number; json: string }>;
    return rows.sort((a, b) => a.ts - b.ts || a.seq - b.seq).map((r) => ({ taskId: r.task_id, ts: r.ts, seq: r.seq, ev: JSON.parse(r.json) as AgentEvent }));
  }

  /** A task's last reply: the newest session.end's summary and its seq; null when it never ended a turn. */
  lastReply(taskId: string): { text: string; seq: number } | null {
    const prefix = '{"t":"session.end",';
    const r = this.sqlite.query("SELECT seq, json_extract(json, '$.summary') AS text FROM events WHERE task_id = ? AND substr(json, 1, length(?)) = ? ORDER BY seq DESC LIMIT 1").get(taskId, prefix, prefix) as { seq: number; text: string | null } | null;
    return r ? { text: r.text ?? "", seq: r.seq } : null;
  }

  /**
   * The question tool's questions of the Task's last turn: those of the `question.ask` events between the last
   * `session.end` and the one before it, in order, with the seq of the last `session.end`; null when it never ended a
   * turn. Read from the events, so they outlive a restart of the daemon.
   */
  lastTurnQuestions(taskId: string): { questions: AskQuestion[]; seq: number; askedAt: number | null } | null {
    const end = '{"t":"session.end",';
    const ask = '{"t":"question.ask",';
    const ends = this.sqlite.query("SELECT seq FROM events WHERE task_id = ? AND substr(json, 1, length(?)) = ? ORDER BY seq DESC LIMIT 2").all(taskId, end, end) as Array<{ seq: number }>;
    if (!ends.length) return null;
    const rows = this.sqlite
      .query("SELECT json, ts FROM events WHERE task_id = ? AND seq < ? AND seq > ? AND substr(json, 1, length(?)) = ? ORDER BY seq")
      .all(taskId, ends[0]!.seq, ends[1]?.seq ?? -1, ask, ask) as Array<{ json: string; ts: number }>;
    const questions = rows.flatMap((r) => {
      const qs = AskQuestion.array().safeParse((JSON.parse(r.json) as { questions?: unknown }).questions);
      return qs.success ? qs.data : [];
    });
    return { questions, seq: ends[0]!.seq, askedAt: rows.length ? rows[rows.length - 1]!.ts : null };
  }

  /* ---------- events ---------- */

  nextSeq(taskId: string): number {
    const r = this.sqlite.query("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE task_id = ?").get(taskId) as { m: number };
    return (r?.m ?? 0) + 1;
  }

  appendEvent(taskId: string, ev: AgentEvent): EventEnvelope {
    return this.appendEventAt(taskId, ev, Date.now());
  }

  /** Append with an explicit timestamp — an imported record keeps the time it happened, not the time it was read. */
  appendEventAt(taskId: string, ev: AgentEvent, ts: number): EventEnvelope {
    const env: EventEnvelope = { taskId, seq: this.nextSeq(taskId), ts, ev };
    this.sqlite.query("INSERT INTO events (task_id, seq, ts, json) VALUES (?, ?, ?, ?)").run(taskId, env.seq, env.ts, JSON.stringify(ev));
    return env;
  }

  listEvents(taskId: string, afterSeq = 0): EventEnvelope[] {
    return (this.sqlite.query("SELECT seq, ts, json FROM events WHERE task_id = ? AND seq > ? ORDER BY seq").all(taskId, afterSeq) as Array<{ seq: number; ts: number; json: string }>).map(
      (r) => ({ taskId, seq: r.seq, ts: r.ts, ev: JSON.parse(r.json) as AgentEvent }),
    );
  }

  /** One event of a task by its seq; null = none. */
  getEvent(taskId: string, seq: number): EventEnvelope | null {
    const r = this.sqlite.query("SELECT seq, ts, json FROM events WHERE task_id = ? AND seq = ?").get(taskId, seq) as { seq: number; ts: number; json: string } | null;
    return r ? { taskId, seq: r.seq, ts: r.ts, ev: JSON.parse(r.json) as AgentEvent } : null;
  }

  /** The runner session a task's turn ran in: the session id of its last `session.start` before `seq`; null = none recorded. */
  sessionAt(taskId: string, seq: number): string | null {
    const r = this.sqlite
      .query("SELECT json_extract(json, '$.runnerSessionId') AS sid FROM events WHERE task_id = ? AND seq < ? AND json_extract(json, '$.t') = 'session.start' AND json_extract(json, '$.runnerSessionId') IS NOT NULL ORDER BY seq DESC LIMIT 1")
      .get(taskId, seq) as { sid: string } | null;
    return r?.sid ?? null;
  }

  /** The last `limit` events of a task, in seq order: what the Task screen draws first. */
  listEventsTail(taskId: string, limit: number): EventEnvelope[] {
    return this.listEventsBefore(taskId, Number.MAX_SAFE_INTEGER, limit);
  }

  /**
   * The `limit` events just before `beforeSeq`, in seq order: the page above what the Task screen holds. A reply
   * streams as many deltas of one message (hundreds for a long one), so a page that starts inside a message reaches back
   * to the message's first delta: the screen never opens on a reply cut in half. A page stays within `EVENTS_PAGE_MAX`
   * (a longer message is cut there).
   */
  listEventsBefore(taskId: string, beforeSeq: number, limit: number): EventEnvelope[] {
    type Row = { seq: number; ts: number; json: string };
    let rows = (this.sqlite.query("SELECT seq, ts, json FROM events WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(taskId, beforeSeq, limit) as Row[]).reverse();
    const first = rows[0] ? (JSON.parse(rows[0].json) as AgentEvent) : null;
    const room = EVENTS_PAGE_MAX - rows.length;
    if (first?.t === "message.delta" && first.messageId && room > 0) {
      // only the rows the page may still grow by (seqs have holes once events moved to S3): a message starting earlier is cut at the cap anyway
      const start = this.sqlite
        .query("SELECT MIN(seq) AS seq FROM (SELECT seq, json FROM events WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?) WHERE json_extract(json, '$.t') = 'message.delta' AND json_extract(json, '$.messageId') = ?")
        .get(taskId, rows[0]!.seq, room, first.messageId) as { seq: number | null };
      if (start.seq !== null) rows = [...(this.sqlite.query("SELECT seq, ts, json FROM events WHERE task_id = ? AND seq >= ? AND seq < ? ORDER BY seq DESC LIMIT ?").all(taskId, start.seq, rows[0]!.seq, room) as Row[]).reverse(), ...rows];
    }
    return rows.map((r) => ({ taskId, seq: r.seq, ts: r.ts, ev: JSON.parse(r.json) as AgentEvent }));
  }

  /** The first thing the person asked in a task (its first user message), or null. One row, not the transcript: a long task has thousands of events. */
  firstUserText(taskId: string): string | null {
    const r = this.sqlite.query("SELECT json_extract(json, '$.text') AS text FROM events WHERE task_id = ? AND json_extract(json, '$.t') = 'message.delta' AND json_extract(json, '$.role') = 'user' ORDER BY seq LIMIT 1").get(taskId) as { text: string | null } | null;
    return r?.text ?? null;
  }

  /**
   * What the automatic judgement of a task's last reply is given besides the reply: the first request, and — when a turn
   * ended before the last one — what the person sent to start the last turn (the last user message between the two newest
   * `session.end`) and the reply that ended the turn before it. A few indexed rows, not the transcript.
   */
  judgeContext(taskId: string): { firstRequest: string | null; lastRequest: string | null; previousReply: string | null } {
    const firstRequest = this.firstUserText(taskId);
    const end = '{"t":"session.end",';
    const ends = this.sqlite.query("SELECT seq, json_extract(json, '$.summary') AS summary FROM events WHERE task_id = ? AND substr(json, 1, length(?)) = ? ORDER BY seq DESC LIMIT 2").all(taskId, end, end) as Array<{ seq: number; summary: string | null }>;
    if (ends.length < 2) return { firstRequest, lastRequest: null, previousReply: null };
    const said = this.sqlite
      .query("SELECT json_extract(json, '$.text') AS text FROM events WHERE task_id = ? AND seq > ? AND seq < ? AND json_extract(json, '$.t') = 'message.delta' AND json_extract(json, '$.role') = 'user' ORDER BY seq DESC LIMIT 1")
      .get(taskId, ends[1]!.seq, ends[0]!.seq) as { text: string | null } | null;
    return { firstRequest, lastRequest: said?.text ?? null, previousReply: ends[1]!.summary };
  }

  /** The summary of the task's last `session.end` (the reply a person's next text answers), or null when it has none. */
  lastReplyText(taskId: string): string | null {
    const end = '{"t":"session.end",';
    const row = this.sqlite.query("SELECT json_extract(json, '$.summary') AS summary FROM events WHERE task_id = ? AND substr(json, 1, length(?)) = ? ORDER BY seq DESC LIMIT 1").get(taskId, end, end) as { summary: string | null } | null;
    return row?.summary ?? null;
  }
}
