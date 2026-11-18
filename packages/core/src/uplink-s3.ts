import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CoreConfig } from "./config.ts";
import type { Db } from "./db.ts";
import type { S3Store } from "./s3.ts";
import { isMachineName } from "./machine.ts";
import { applyDelta, type ApplyResult, buildDelta, readCursor, writeCursor } from "./uplink.ts";
import { UPLINK_LIMITS, type UplinkLimits } from "./uplink-in.ts";

/**
 * The way of a delta (uplink.ts) from a work machine to the instance: a key of its own in the uplink bucket,
 * `uplink/<machine>/<deltaId>.tar.zst`. The work machine only ever writes a new key (the write is refused when the key
 * is there, and its credentials can neither overwrite nor delete); the instance reads and never deletes — the bucket's
 * lifecycle ends a key. Nothing wakes the instance: what was put while it was stopped is all there at its next start,
 * and it takes the keys in their order.
 */
const PREFIX = "uplink/";
const RECEIVED_KEY = "uplink.received";
const REFUSED_KEY = "uplink.refused";

/**
 * Builds what is new since the last send and puts each delta under its key; the mark moves once all of them are there.
 * A key that is already there was put by an earlier try of the same build and counts as sent. The files built are removed
 * either way (a send that failed is built again). Returns the ids put; none when nothing is new.
 */
export async function sendUplink(db: Db, cfg: CoreConfig, store: S3Store, opts: { machine?: string; now?: number } = {}): Promise<string[]> {
  const machine = opts.machine ?? cfg.uplink.machine;
  const built = await buildDelta(db, cfg, readCursor(db), machine, { now: opts.now, maxBytes: cfg.uplink.maxBytes });
  try {
    for (const d of built) await store.put(`${PREFIX}${machine}/${d.deltaId}.tar.zst`, new Uint8Array(readFileSync(d.file)), { ifNoneMatch: true });
    if (built.length) writeCursor(db, built[0]!.cursor);
  } finally {
    for (const d of built) rmSync(d.file, { force: true });
  }
  return built.map((d) => d.deltaId);
}

/** Per machine, the last key taken in: the list is asked from there on. */
function received(db: Db): Record<string, string> {
  return db.getSetting<Record<string, string>>(RECEIVED_KEY, {});
}

/**
 * An object the instance did not take in: its key and version, the machine whose prefix it lay under, and why. Kept by
 * its key (the newest 200): a record of what was passed over, shown to the person once (asks-notices.ts) and in the
 * health answer. The object itself is never read again — the mark has moved past it.
 */
export interface RefusedDelta {
  machine: string;
  key: string;
  etag: string;
  reason: string;
  at: number;
  /** The mark has moved past it (it had a delta's name: refused for its size or for what it holds); absent = refused for its name, and still stepped over each round. */
  content?: true;
}

const REFUSED_KEPT = 200;
/** How many objects refused for their name are recorded per machine (they stay in the bucket's list; see `receiveUplink`). */
const NAMED_KEPT = 50;
export const listRefusedDeltas = (db: Db): RefusedDelta[] => Object.values(db.getSetting<Record<string, RefusedDelta>>(REFUSED_KEY, {})).filter((r) => typeof r?.key === "string").sort((x, y) => x.at - y.at);

/** How far ahead of this clock a delta's name may say it was made (the work machine's clock may run a little fast). */
const NAME_AHEAD_MS = 24 * 3600_000;

/**
 * Takes in every delta in the bucket that was not taken in yet, each machine's in the order they were made. Only the
 * machines registered on this instance (`cfg.uplink.machines`) are read: with none registered the bucket is not asked
 * at all, and a prefix of a name nobody registered is never listed.
 *
 * An object is input from a machine trusted less than this one. Its key has to be exactly
 * `uplink/<machine>/<machine>-<time>-<n>.tar.zst` with a time not ahead of this clock; its size is read from the list
 * and one over the limit is not fetched; what it says inside is compared with the machine it lay under (`applyDelta`).
 *
 * A delta that is refused — by its name, its size, or what it holds — is recorded (`listRefusedDeltas`), told to the
 * person once and passed over, and the machine's later deltas go on (one with a delta's name by moving the mark past
 * it; one with another name, or a name dated ahead, by stepping over it unread each round). One bad object therefore
 * cannot hold everything after it, whoever put it. A later delta that depends on a refused one does not go in on top of
 * the hole: a delta continues each Task's events right after the last one sent, so one whose events start past what
 * this instance has of a Task, or that has rows of a Task whose own row never arrived, is refused too (`applyDelta`),
 * with that reason. Two things still hold a machine's later deltas, because waiting mends them: a delta from a newer
 * database (kept in `listSkipped` until this instance is upgraded) and a bucket that does not answer. Nothing is decided
 * for a refused object: what it held is not on this instance until the work machine sends it again (its
 * mark `uplink.cursor` taken back by the person: docs/design/work-machine.md). Another machine's deltas are not touched by it.
 */
export async function receiveUplink(db: Db, cfg: CoreConfig, store: S3Store, opts: { now?: number; log?: (line: string) => void; limits?: UplinkLimits } = {}): Promise<ApplyResult[]> {
  const log = opts.log ?? ((line: string) => console.warn(line));
  const limits = opts.limits ?? UPLINK_LIMITS;
  const now = opts.now ?? Date.now();
  const results: ApplyResult[] = [];
  const registered = Object.entries(cfg.uplink.machines);
  if (registered.length === 0) return results;
  mkdirSync(cfg.home, { recursive: true });
  let dir: string | null = null;
  try {
    for (const [machine, repositories] of registered) {
      if (!isMachineName(machine)) continue;
      const prefix = `${PREFIX}${machine}/`;
      const mark = received(db)[machine];
      const passed = (key: string) => db.setSetting(RECEIVED_KEY, { ...received(db), [machine]: key });
      const refusedNow = () => db.getSetting<Record<string, RefusedDelta>>(REFUSED_KEY, {});
      const record = (r: RefusedDelta) => {
        log(`[uplink] ${r.key} was not taken in: ${r.reason}`);
        const all = Object.values({ ...refusedNow(), [r.key]: r }).filter((x) => typeof x?.key === "string");
        // the ones the mark has passed are a log (the newest are kept); the ones still listed each round all stay, so none is said twice
        const kept = [...all.filter((x) => !x.content), ...all.filter((x) => x.content).sort((x, y) => y.at - x.at).slice(0, REFUSED_KEPT)];
        db.setSetting(REFUSED_KEY, Object.fromEntries(kept.map((x) => [x.key, x])));
      };
      // refused for what it is (it has a delta's name of this machine, so the keys after it are later ones): recorded,
      // said once, and passed over — the mark moves, and the same object is never listed again
      const refuse = (key: string, etag: string, reason: string) => {
        record({ machine, key, etag, reason, at: now, content: true });
        passed(key);
      };
      // refused for its name (not a delta's, or dated ahead): the mark cannot move to it — a name is free to sort after
      // every delta still to come — so it stays in the list and is stepped over each round, unread; recorded and said
      // once per object, the first NAMED_KEPT of a machine (more than that is stepped over without a record)
      const named = (key: string, etag: string, reason: string) => {
        const had = refusedNow();
        if (had[key]?.etag === etag) return;
        if (Object.values(had).filter((x) => x?.machine === machine && !x.content).length < NAMED_KEPT) record({ machine, key, etag, reason, at: now });
      };
      const listed = (await store.list(prefix, mark)).filter((o) => o.key.endsWith(".tar.zst"));
      const waiting: typeof listed = [];
      for (const o of listed) {
        const m = new RegExp(`^${machine}-(\\d{1,16})-\\d{6}\\.tar\\.zst$`).exec(o.key.slice(prefix.length));
        if (!m) named(o.key, o.etag, "its name is not a delta of this machine");
        else if (Number(m[1]) > now + NAME_AHEAD_MS) named(o.key, o.etag, "its name is dated ahead of this instance's clock");
        else if (waiting.length < limits.perRound) waiting.push(o);
      }
      for (const o of waiting) {
        const name = o.key.slice(prefix.length);
        if (!(o.size <= limits.objectBytes)) { refuse(o.key, o.etag, `it is ${o.size} bytes: over the limit of ${limits.objectBytes}`); continue; }
        try {
          const got = await store.get(o.key);
          if (!got) break;
          if (got.body.length > limits.objectBytes) { refuse(o.key, got.etag, `it is ${got.body.length} bytes: over the limit of ${limits.objectBytes}`); continue; }
          dir ??= mkdtempSync(join(cfg.home, "uplink-get-"));
          const file = join(dir, "delta.tar.zst");
          writeFileSync(file, got.body, { mode: 0o600 });
          let r: ApplyResult;
          try {
            // the id inside is the key's: compared before anything of the delta is written (what is refused is not taken in)
            r = await applyDelta(db, cfg, file, { machine, repositories }, { now: opts.now, limits, expectId: name.slice(0, -".tar.zst".length) });
          } catch (e) {
            // what the object holds was refused (also: it depends on a delta that did not go in)
            refuse(o.key, got.etag, String((e as Error)?.message ?? e).slice(0, 300));
            continue;
          }
          results.push(r);
          if (r.status === "skipped") {
            log(`[uplink] ${r.reason}`);
            break;
          }
          passed(o.key);
        } catch (e) {
          // the bucket could not be read: tried again next round
          log(`[uplink] ${o.key} was not taken in: ${String((e as Error)?.message ?? e).slice(0, 300)}`);
          break;
        }
      }
    }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  return results;
}
