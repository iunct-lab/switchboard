import { BacklogRepositoryKey, type BacklogIssueData, type BacklogSource } from "@switchboard/protocol";
import { z } from "zod";
import { findSecrets, hostAws } from "../../../ops-kit/src/secrets.ts";
import { ANSWER_HEADING, HOLD_HEADING, PROCEED_CONFIRMED, PROCEED_OVERTURNED } from "./backlog-comments.ts";
import { confirmationsOf, criteria } from "./backlog-item.ts";
import type { BacklogLocalEntry, BacklogOperation, Db } from "./db.ts";
import { isMachineName } from "./machine.ts";
import type { S3Store } from "./s3.ts";

/**
 * The way of a backlog edit made on a work machine to the service: the work machine never writes to GitHub. Its edit
 * waits in its own `backlog_operations` (so it shows on top of the copy it reads), is put in the uplink bucket as one
 * key per version of the operation, and the instance takes it into its own queue and sends it as it sends its own.
 * What came of it returns with the work machine's next copy of the instance's records (backlog-replica.ts), and only
 * then is the operation done there. An envelope the instance refuses makes no record there, so its refusal is written
 * back beside it — `backlog-refused/<machine>/<n>.json`, a prefix only the instance writes — and the work machine ends
 * that operation as failed with the instance's reason (`takeRefusals`): it never stays waiting for an answer that
 * cannot come.
 *
 * Keys are `backlog/<machine>/<n>.json`, `n` a count that only grows on that machine, so the instance takes them in
 * the order they were put (a comment on an Issue after the create that makes it). A key is written only when it is
 * not there. No status is added to an operation for "put": what was put is kept beside the count (`upbox.sent`).
 *
 * To the instance an envelope is input from a machine it trusts less than itself (`checkEnvelope`): a closed set of
 * operations, each rebuilt from the few values it may carry, never taken as it came. An envelope cannot carry or make
 * the person's answer, a hold, a confirmation, a merge mark or any mark of where an edit came from; it cannot name an
 * operation or a draft of the instance's own; and what it made is kept under an id that says which machine it is from
 * (`importedId`). The work machine runs the same check before it puts an envelope, so what would be refused there is
 * said here, on the operation, and never put.
 */
const PREFIX = "backlog/";
/** Where the instance says which envelopes it refused: the same machine folder and count as the envelope's key. */
const REFUSED_PREFIX = "backlog-refused/";
/** The last refusal a work machine read. */
const REFUSALS_READ_KEY = "upbox.refusalsRead";
const SENT_KEY = "upbox.sent";
const TAKEN_KEY = "upbox.taken";
const REFUSED_KEY = "upbox.refused";

/** The most one envelope may be, and how many of one machine go in per round. */
export const ENVELOPE_MAX_BYTES = 512 * 1024;
export const ENVELOPES_PER_ROUND = 500;
const TEXT_MAX = 256 * 1024;

export interface Envelope {
  kind: "backlog-operation";
  machine: string;
  /** Whether this is the first version of the operation put (a later one: it was changed while it waited). */
  first: boolean;
  op: BacklogOperation;
  /** The record the operation made on the work machine (a new Issue's or comment's draft). The instance does not read it: it makes its own from the operation. */
  record: BacklogLocalEntry | null;
}

/** What a work machine has put: the count of keys, and per operation still waiting the version (`updatedAt`) put last and the first one. */
export interface Sent {
  n: number;
  /** `n`: the count of the key the version was put under (what a refusal names). */
  ops: Record<string, { v: number; first: number; n?: number }>;
  /** The name the envelopes were put under: what the instance keeps their operations by. */
  machine?: string;
}

export const readSent = (db: Db): Sent => db.getSetting<Sent>(SENT_KEY, { n: 0, ops: {} });

/** The id the instance keeps a work machine's operation under: no id of the instance's own has this shape, so an envelope can name only its own machine's operations. */
export const importedId = (machine: string, id: string) => `m:${machine}:${id}`;
/** The machine an operation came from, by its id; null = made on this instance. */
export const machineOfOperation = (id: string): string | null => /^m:([A-Za-z0-9][A-Za-z0-9_-]{0,62}):/.exec(id)?.[1] ?? null;

/** The id the instance keeps a put operation under (`Db.takeBacklogOperation`): what the work machine looks for in its copy. */
export function sentId(sent: Sent, op: Pick<BacklogOperation, "id">): string | null {
  const s = sent.ops[op.id];
  if (!s || !sent.machine) return null;
  return importedId(sent.machine, s.v === s.first ? op.id : `${op.id}@${s.v}`);
}

const key = (machine: string, n: number) => `${PREFIX}${machine}/${String(n).padStart(12, "0")}.json`;
const bytes = (e: Envelope) => new TextEncoder().encode(JSON.stringify(e));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL = /^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Text = z.string().max(TEXT_MAX);
const Scalar = z.union([z.string().max(TEXT_MAX), z.number(), z.null()]);
const Ref = z.string().min(1).max(200).regex(/^[^\s\x00-\x1f]+$/);

const CreatePayload = z.strictObject({
  title: z.string().min(1).max(1000),
  body: Text,
  state: z.literal("OPEN"),
  labels: z.array(z.string().min(1).max(100)).max(50),
  milestone: z.string().max(200).nullable(),
  parent: z.number().int().positive().nullable(),
  // only whether it goes in the Project and with which fields: which Project is the instance's to say
  project: z.object({ fields: z.record(z.string().max(200), Scalar) }).nullable(),
});
type CreateValues = z.infer<typeof CreatePayload>;
const CommentPayload = z.strictObject({ body: z.string().min(1).max(TEXT_MAX) });
const Operation = z.object({
  id: z.string().regex(UUID),
  // one of the services a backlog is read from: any other name is not an operation
  service: BacklogRepositoryKey.shape.service,
  host: z.string().max(200),
  repository: z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/),
  issue: Ref,
  targetKind: z.enum(["issue", "comment", "project-item"]),
  target: Ref,
  kind: z.enum(["create", "set", "comment"]),
  field: z.string().max(300).nullable().optional(),
  payload: z.unknown(),
  base: z.unknown().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const EnvelopeShape = z.object({ kind: z.literal("backlog-operation"), machine: z.string(), first: z.boolean(), op: Operation });

/** Lines only the person's own answer on the instance, or the merge gate's marks, begin with: an edit from a work machine never carries one. */
const OWNER_LINES = [ANSWER_HEADING, HOLD_HEADING, PROCEED_CONFIRMED, PROCEED_OVERTURNED, "[merge-answer]", "[recheck]", "[local-ci]", "[tag-ci]"];
const ownerLine = (text: string) => OWNER_LINES.find((h) => text.split("\n").some((l) => l.trimStart().startsWith(h))) ?? null;

type CheckedOperation = Pick<BacklogOperation, "id" | "service" | "host" | "repository" | "issue" | "targetKind" | "target" | "kind" | "field" | "payload" | "base" | "createdAt" | "updatedAt">;
/** What an envelope may be, checked; `reason` = why it is not taken (or not put). */
export type Checked = { ok: true; first: boolean; op: CheckedOperation } | { ok: false; reason: string };

/**
 * The one judgement of an envelope, run by the work machine before it puts one and by the instance on what it reads.
 * It answers a new operation holding only what was checked — a field this does not name is not carried over:
 *  - `create`: a new Issue (title, body, labels, milestone, parent, Project fields); never a local change's branches;
 *  - `comment`: `{ body }` and nothing else — no mark that it was given on the screen, no confirmation;
 *  - `set`: a field of an Issue (title, body, state, a label, milestone, parent) or of its Project item, with a value of
 *    that field's kind. Not `change` (a merge), and not taking `needs-decision` off (that is what an answer does).
 * No comment may hold a line that begins as the person's answer, a hold, a confirmation of a recommendation or a merge
 * mark does, and no text a value that signs in (`secrets`: the checking machine's own host values, so the instance
 * checks again with its own).
 */
export function checkEnvelope(raw: unknown, secrets: (text: string) => string | null = secretIn): Checked {
  const no = (reason: string): Checked => ({ ok: false, reason });
  const e = EnvelopeShape.safeParse(raw);
  if (!e.success) return no(`not a backlog operation (${e.error.issues[0]?.path.join(".") ?? ""}: ${e.error.issues[0]?.message ?? ""})`.slice(0, 200));
  const { op, first } = e.data;
  if (!isMachineName(e.data.machine)) return no("the machine is not usable");
  if (!Number.isFinite(op.createdAt) || !Number.isFinite(op.updatedAt)) return no("its times cannot be read");
  const texts: string[] = [];
  let payload: unknown;
  let field: string | null = null;
  let base: unknown = null;
  const is = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => schema.safeParse(v).success;
  if (op.kind === "create") {
    const p = CreatePayload.safeParse(op.payload);
    if (!p.success) return no(`a new Issue carries only its title, body, labels, milestone, parent and Project fields (${p.error.issues[0]?.path.join(".") ?? ""})`);
    if (op.targetKind !== "issue" || op.target !== `local:${op.id}` || op.issue !== op.target) return no("a new Issue is named by its own id");
    payload = p.data;
    texts.push(p.data.title, p.data.body, p.data.milestone ?? "", ...p.data.labels, ...Object.entries(p.data.project?.fields ?? {}).flatMap(([k, v]) => [k, typeof v === "string" ? v : ""]));
  } else if (op.kind === "comment") {
    const p = CommentPayload.safeParse(op.payload);
    if (!p.success) return no("a comment carries its body and nothing else");
    if (op.targetKind !== "comment" || !LOCAL.test(op.target)) return no("a new comment is named by an id of its own");
    payload = p.data;
    texts.push(p.data.body);
    const owner = ownerLine(p.data.body);
    if (owner) return no(`「${owner}」で始まる行は Switchboard 本体の画面からだけ書けます（作業場からは送りません）`);
  } else {
    field = op.field ?? "";
    const v = op.payload;
    const b = z.union([z.string().max(TEXT_MAX), z.number(), z.boolean(), z.null()]).safeParse(op.base ?? null);
    if (!b.success) return no("the value it was made on cannot be read");
    base = b.data;
    if (op.targetKind === "issue") {
      if (field === "title") {
        if (!is(z.string().min(1).max(1000), v)) return no("a title is a text");
      } else if (field === "body") {
        if (!is(Text, v)) return no("a body is a text");
      } else if (field === "state") {
        if (!is(z.enum(["OPEN", "CLOSED"]), v)) return no("a state is OPEN or CLOSED");
      } else if (field === "stateReason") {
        if (!is(z.enum(["COMPLETED", "NOT_PLANNED", "REOPENED", "DUPLICATE"]).nullable(), v)) return no("not a reason an Issue closes with");
      } else if (field === "milestone") {
        if (!is(z.string().max(200).nullable(), v)) return no("a milestone is a name");
      } else if (field === "parent") {
        if (!is(z.number().int().positive().nullable(), v)) return no("a parent is an Issue number");
      } else if (/^label:.{1,100}$/.test(field)) {
        if (!is(z.boolean(), v)) return no("a label is on or off");
        if (field === "label:needs-decision" && v === false) return no("needs-decision を外すのは回答で、Switchboard 本体の画面から行います（作業場からは送りません）");
        texts.push(field.slice("label:".length));
      } else return no(`an Issue's ${field.slice(0, 40) || "(no field)"} is not set from a work machine`);
    } else if (op.targetKind === "project-item") {
      if (field === "member") {
        if (!is(z.boolean(), v)) return no("in the Project or not");
      } else if (/^field:.{1,200}$/.test(field)) {
        if (!is(Scalar, v)) return no("a Project field is a text or a number");
        texts.push(field.slice("field:".length));
      } else return no("not a field of a Project item");
    } else return no("a comment is not edited");
    payload = v;
    if (typeof v === "string") texts.push(v);
  }
  for (const t of texts) {
    const hit = t ? secrets(t) : null;
    if (hit) return no(`認証に使える値（${hit}）が入っています`);
  }
  return { ok: true, first, op: { id: op.id, service: op.service, host: op.host, repository: op.repository, issue: op.issue, targetKind: op.targetKind, target: op.target, kind: op.kind, field, payload, base, createdAt: op.createdAt, updatedAt: op.updatedAt } };
}

/** The kind of the first value in `text` that signs in, by this machine's own host values; null = none. */
function secretIn(text: string): string | null {
  return findSecrets(text, hostAws())[0]?.kind ?? null;
}

/**
 * Puts the repository's edits still waiting (`pending`, past a comment's send window) that were not put in this version
 * yet, oldest first; the operations stay `pending`. One the instance would refuse (`checkEnvelope`) is not put: it
 * ends here as failed with the reason. Stops at the first that cannot be put (the order is kept) and throws its
 * reason. Returns how many were put.
 */
export async function uploadBacklogOperations(db: Db, store: S3Store, source: BacklogSource, machine: string, now = Date.now()): Promise<number> {
  const waiting = db.listPendingBacklogOperations(source);
  let sent = readSent(db);
  // what is done here is no longer looked for
  const open = new Set(db.listPendingBacklogOperations().map((o) => o.id));
  const kept = Object.fromEntries(Object.entries(sent.ops).filter(([id]) => open.has(id)));
  if (Object.keys(kept).length !== Object.keys(sent.ops).length || sent.machine !== machine) db.setSetting(SENT_KEY, (sent = { ...sent, ops: kept, machine }));
  let put = 0;
  for (const op of waiting) {
    if (op.status !== "pending" || (op.retryAt !== null && op.retryAt > now)) continue;
    const before = sent.ops[op.id];
    if (before?.v === op.updatedAt) continue;
    const record = op.target.startsWith("local:") ? db.getBacklogRecord({ ...source, objectKind: op.targetKind, externalId: op.target }) : null;
    const envelope: Envelope = { kind: "backlog-operation", machine, first: !before, op, record: record ? { objectKind: record.objectKind, externalId: record.externalId, local: record.local } : null };
    const body = bytes(envelope);
    const checked = checkEnvelope(JSON.parse(new TextDecoder().decode(body)));
    const refusal = !checked.ok ? checked.reason : body.length > ENVELOPE_MAX_BYTES ? `${body.length} バイトあり、上限 ${ENVELOPE_MAX_BYTES} を超えています` : null;
    if (refusal) {
      db.setBacklogOperationResult(op.id, { status: "failed", error: `作業場からは送れません: ${refusal}`, retryAt: null }, now);
      continue;
    }
    for (let n = sent.n + 1; ; n++) {
      const r = await store.put(key(machine, n), body, { ifNoneMatch: true });
      // a key that is there: this very envelope from a try that ended before the count was kept, or another's (a
      // database made anew under the same machine name) — then the next free key
      const same = r === "conflict" && Buffer.from((await store.get(key(machine, n)))?.body ?? []).equals(Buffer.from(body));
      if (r !== "conflict" || same) {
        db.setSetting(SENT_KEY, (sent = { n, machine, ops: { ...sent.ops, [op.id]: { v: op.updatedAt, first: before?.first ?? op.updatedAt, n } } }));
        break;
      }
    }
    put++;
  }
  return put;
}

/** What the instance writes back for an envelope it refused. */
const RefusalNote = z.object({ key: z.string().max(200), reason: z.string().max(400), at: z.number() });

/**
 * The work machine's side of a refusal: reads what the instance wrote back for this machine's envelopes since the last
 * read and ends each operation it names as failed with the instance's reason — the version that was put, still waiting
 * (one changed since was put again under a new key and has its own answer). The person sees it on the Issue as any
 * edit that could not be sent, and edits or retries it. Returns how many operations were ended.
 */
export async function takeRefusals(db: Db, store: S3Store, machine: string, now = Date.now()): Promise<number> {
  const prefix = `${REFUSED_PREFIX}${machine}/`;
  const sent = readSent(db);
  let ended = 0;
  for (const o of await store.list(prefix, db.getSetting<string | null>(REFUSALS_READ_KEY, null) ?? undefined)) {
    const n = Number(/^(\d{12})\.json$/.exec(o.key.slice(prefix.length))?.[1] ?? NaN);
    const got = o.size <= 4096 && Number.isFinite(n) ? await store.get(o.key) : null;
    let note: z.infer<typeof RefusalNote> | null = null;
    try {
      note = got ? RefusalNote.parse(JSON.parse(new TextDecoder().decode(got.body))) : null;
    } catch {
      note = null; // not a note of the instance's: passed over
    }
    const id = note ? Object.entries(sent.ops).find(([, s]) => s.n === n)?.[0] : undefined;
    const op = id ? db.getBacklogOperation(id) : null;
    if (note && op && op.status === "pending" && sent.ops[id!]!.v === op.updatedAt) {
      db.setBacklogOperationResult(op.id, { status: "failed", error: `Switchboard 本体が受け取りませんでした: ${note.reason}`, retryAt: null }, now);
      ended++;
    }
    db.setSetting(REFUSALS_READ_KEY, o.key);
  }
  return ended;
}

/** An envelope the instance could not take, with its reason and the machine it lay under (kept for the log and the health answer; it is not tried again). */
export interface Refused {
  key: string;
  machine?: string;
  reason: string;
  at: number;
}

export const listRefused = (db: Db): Refused[] => db.getSetting<Refused[]>(REFUSED_KEY, []);

/**
 * The instance's side: takes every envelope not taken yet into its own queue, each registered machine's in key order.
 * Only the machines in `machines` (the instance's registry: a name → the repositories it is registered for) are read;
 * with none the bucket is not asked.
 *
 * An envelope is taken only when all of this holds, and is refused with its reason and passed over otherwise (one bad
 * envelope does not hold the ones after it; nothing of it is stored, and the refusal is written back for the work
 * machine to read — `takeRefusals` — before the key is passed; a write-back the bucket did not take is tried again
 * with the envelope next round):
 *  - its key is `backlog/<machine>/<12 digits>.json`, it is no bigger than the limit, and the machine it names is the
 *    one it lay under;
 *  - it is an operation a work machine may make (`checkEnvelope`, with this instance's own secret check);
 *  - its repository is one that machine is registered for and a workspace here reads;
 *  - the Issue it edits is stored here; a draft it names (`local:…`) was made by an envelope of the same machine;
 *  - a body it sets keeps every line that waits for the person's own confirmation as it is, unchecked (not checked
 *    off, taken out or reworded).
 * What is stored is made here from the checked values: the operation under `importedId(machine, …)`, the draft of a new
 * Issue or comment from the operation (not the draft the envelope brought). A later version replaces only that
 * machine's earlier one. Returns the workspaces that got something to send (the caller asks their send).
 */
export async function importBacklogOperations(db: Db, store: S3Store, machines: Record<string, string[]>, opts: { now?: number; log?: (line: string) => void; secrets?: (text: string) => string | null } = {}): Promise<string[]> {
  const now = opts.now ?? Date.now();
  const log = opts.log ?? ((line: string) => console.warn(line));
  const touched = new Set<string>();
  const sources = db.listWorkspaces().flatMap((ws) => {
    const s = db.getWorkspaceBacklogSource(ws.id);
    return s && s.service !== "switchboard" && !s.disabled ? [{ ws: ws.id, source: s }] : [];
  });
  type Kind = "issue" | "comment" | "project-item";
  for (const [machine, repositories] of Object.entries(machines)) {
    if (!isMachineName(machine)) continue;
    const prefix = `${PREFIX}${machine}/`;
    const registered = new Set(repositories.map((r) => r.toLowerCase()));
    const mine = importedId(machine, "");
    /** Whether a draft (`local:…`) was made by an operation of this machine. */
    const madeHere = (externalId: string) => !!db.sqlite.query("SELECT 1 FROM backlog_operations WHERE substr(id, 1, ?) = ? AND target = ? AND kind IN ('create', 'comment')").get(mine.length, mine, externalId);
    const after = db.getSetting<Record<string, string>>(TAKEN_KEY, {})[machine];
    const listed = await store.list(prefix, after);
    const isEnvelope = (k: string) => /^\d{12}\.json$/.test(k.slice(prefix.length));
    // a key that is not an envelope's is said once and stepped over each round: the mark never moves to it (its name is
    // free to sort after every envelope still to come, which would then never be read)
    for (const o of listed.filter((x) => !isEnvelope(x.key)).slice(0, 50)) {
      if (listRefused(db).some((r) => r.key === o.key)) continue;
      log(`[upbox] ${o.key} was not taken in: its name is not an envelope of this machine`);
      db.setSetting(REFUSED_KEY, [...listRefused(db), { key: o.key, machine, reason: "its name is not an envelope of this machine", at: now }].slice(-200));
    }
    for (const o of listed.filter((x) => isEnvelope(x.key)).slice(0, ENVELOPES_PER_ROUND)) {
      const k = o.key;
      let refused: string | null = null;
      const refuse = (reason: string) => {
        if (!listRefused(db).some((r) => r.key === k && r.reason === reason)) log(`[upbox] ${k} was not taken in: ${reason}`);
        db.setSetting(REFUSED_KEY, [...listRefused(db).filter((r) => r.key !== k), { key: k, machine, reason, at: now }].slice(-200));
        refused = reason;
      };
      /** The refusal goes back to the work machine under the envelope's own count; false = the bucket did not take it. */
      const told = async (): Promise<boolean> => {
        const n = /^(\d{12})\.json$/.exec(k.slice(prefix.length))?.[1];
        if (refused === null || !n) return true; // nothing refused, or a key no work machine of ours names: nobody to tell
        try {
          await store.put(`${REFUSED_PREFIX}${machine}/${n}.json`, new TextEncoder().encode(JSON.stringify({ key: k, reason: (refused as string).slice(0, 400), at: now })), { ifNoneMatch: true });
          return true;
        } catch (e) {
          log(`[upbox] the refusal of ${k} could not be written back: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
          return false;
        }
      };
      const done = () => db.setSetting(TAKEN_KEY, { ...db.getSetting<Record<string, string>>(TAKEN_KEY, {}), [machine]: k });
      if (!(o.size <= ENVELOPE_MAX_BYTES)) {
        refuse(`it is ${o.size} bytes: over the limit of ${ENVELOPE_MAX_BYTES}`);
        if (!(await told())) break;
        done();
        continue;
      }
      // the bucket not answering is not the envelope's fault: this machine's waits for the next round
      const got = await store.get(k);
      if (!got) break;
      try {
        if (got.body.length > ENVELOPE_MAX_BYTES) throw new Error(`it is ${got.body.length} bytes: over the limit of ${ENVELOPE_MAX_BYTES}`);
        const raw = JSON.parse(new TextDecoder().decode(got.body)) as { machine?: unknown } | null;
        if (raw?.machine !== machine) throw new Error(`it says it is from ${String(raw?.machine).slice(0, 80)}, and lay under ${machine}`);
        const checked = checkEnvelope(raw, opts.secrets);
        if (!checked.ok) throw new Error(checked.reason);
        const { op } = checked;
        if (!registered.has(op.repository.toLowerCase())) throw new Error(`${machine} is not registered for ${op.repository}`);
        const at = sources.find((s) => s.source.service === op.service && s.source.host === op.host && s.source.repository.toLowerCase() === op.repository.toLowerCase());
        if (!at) throw new Error(`no workspace here reads ${op.repository}`);
        const repo = { service: at.source.service, host: at.source.host, repository: at.source.repository };
        const stored = (objectKind: Kind, externalId: string) => db.getBacklogRecord({ ...repo, objectKind, externalId });
        /** A record an envelope may name: one the service has, or a draft this machine's own envelope made. */
        const usable = (objectKind: Kind, externalId: string) => {
          const rec = stored(objectKind, externalId);
          return externalId.startsWith("local:") && !madeHere(externalId) ? null : rec;
        };
        let record: BacklogLocalEntry | null = null;
        let payload = op.payload;
        const time = new Date(Math.min(op.createdAt, now)).toISOString();
        if (op.kind === "create") {
          if (stored("issue", op.target) && !madeHere(op.target)) throw new Error("its id is taken by a draft that is not this machine's");
          const p = op.payload as CreateValues;
          payload = { title: p.title, body: p.body, state: "OPEN", labels: p.labels, milestone: p.milestone, parent: p.parent, project: p.project && Object.keys(p.project.fields).length ? { ...at.source.project, fields: p.project.fields } : null };
          const draft: BacklogIssueData = { number: 0, title: p.title, url: "", state: "OPEN", stateReason: null, body: p.body, labels: p.labels, milestone: p.milestone, parent: p.parent, subIssues: [], createdAt: time, updatedAt: time, closedAt: null };
          record = { objectKind: "issue", externalId: op.target, local: draft };
        } else {
          const issue = usable("issue", op.issue);
          if (!issue) throw new Error(`issue ${op.issue.slice(0, 80)} is not stored here`);
          const shown = (issue.remote ?? issue.local) as BacklogIssueData | null;
          if (op.kind === "comment") {
            if (stored("comment", op.target) && !madeHere(op.target)) throw new Error("its id is taken by a draft that is not this machine's");
            record = { objectKind: "comment", externalId: op.target, local: { issue: shown?.number ?? 0, body: (op.payload as { body: string }).body, createdAt: time } };
          } else {
            if (op.targetKind === "issue" && op.target !== op.issue) throw new Error("an Issue's field is set on that Issue");
            if (op.targetKind !== "issue" && !usable(op.targetKind as Kind, op.target) && op.field !== "member") throw new Error(`${op.targetKind} ${op.target.slice(0, 80)} is not stored here`);
            if (op.targetKind === "issue" && op.field === "body") {
              const waiting = new Set(confirmationsOf(shown?.body ?? "").map((c) => c.text));
              if (criteria(String(op.payload)).some((c) => c.checked && waiting.has(c.text))) throw new Error("利用者確認の行にチェックを付けるのは Switchboard 本体の画面から行います（作業場からは送りません）");
              // every line that waits stays as it is, unchecked: taking one out or rewording it would end the wait as surely as checking it
              const kept = new Set(confirmationsOf(String(op.payload)).map((c) => c.text));
              if ([...waiting].some((text) => !kept.has(text))) throw new Error("利用者確認の行を消す・書き換えるのは Switchboard 本体の画面から行います（作業場からは送りません）");
            }
          }
        }
        const here: BacklogOperation = { ...op, ...repo, targetKind: op.targetKind, id: importedId(machine, op.id), payload, seq: 0, status: "pending", attempt: 0, retryAt: null, remoteId: null, error: null, overwritten: null };
        const r = db.takeBacklogOperation(here, record, checked.first, now);
        if (r === "sent") refuse(`the Issue of create ${op.id} is already made; its later edit goes by its number`);
        if (r === "taken") touched.add(at.ws);
      } catch (err) {
        refuse(String((err as Error)?.message ?? err).slice(0, 300));
      }
      if (!(await told())) break;
      done();
    }
  }
  return [...touched];
}
