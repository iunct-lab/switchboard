import { isMachineName } from "./machine.ts";
import type { S3Store } from "./s3.ts";

/**
 * One lease per PBI in the uplink bucket (`lease/<owner>/<repo>/<number>.json`), so that two machines sharing work —
 * the instance and a work machine — never start the same PBI at once, also while the instance is stopped and neither
 * can see the other's records. S3 decides who gets it: a lease is made with a write that only succeeds when the key is
 * not there, and taken over, renewed or given back with a write that only succeeds over the version read
 * (docs/design/work-machine.md, section 4).
 *
 * A lease that is held ends by itself at `expiresAt` unless its holder renews it, so a machine that died does not
 * keep a PBI for ever; until then no other machine takes it. Giving it back writes `released` over it (nothing is
 * deleted). The same machine may always take its own lease again (a daemon that restarted is not locked out by
 * itself). Expiry is judged by each machine's own clock: the time a lease lasts has to be much longer than the clocks
 * may differ.
 */
export interface Lease {
  pbi: number;
  machine: string;
  /** Changes with every acquire: which holding of the machine this is. */
  token: string;
  state: "held" | "released";
  expiresAt: number;
}

export type Acquired = { ok: true } | { ok: false; holder: string; until: number };

export const leaseKey = (repository: string, pbi: number) => `lease/${repository.toLowerCase()}/${pbi}.json`;
/** The proof of a machine's holding of a PBI (its current token only): written by that machine under a prefix only it can write, so a lease naming a machine is believed only with it. */
export const proofKey = (machine: string, repository: string, pbi: number) => `lease-proof/${machine}/${repository.toLowerCase()}/${pbi}.json`;
const TOKEN_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const encodeProof = (token: string, state: "held" | "released") => new TextEncoder().encode(JSON.stringify({ token, state }));
const PREFIX = "lease/";

/** The most a lease is read as: one is a few hundred bytes, and whatever else lies under a lease's key is not brought here whole. */
export const LEASE_MAX_BYTES = 4096;
/** A lease's key: `lease/<owner>/<repo>/<number>.json`, the repository in lower case as `leaseKey` writes it. */
const KEY = /^lease\/([a-z0-9][a-z0-9._-]*\/[a-z0-9._][a-z0-9._-]*)\/([1-9]\d{0,9})\.json$/;

const encode = (l: Lease) => new TextEncoder().encode(JSON.stringify(l));
/** The lease in `body`, for the PBI its key names: null for anything else (not a lease, another PBI's, a holder that is no machine's name). */
function decode(body: Uint8Array, pbi: number): Lease | null {
  try {
    const l = JSON.parse(new TextDecoder().decode(body)) as Lease;
    return l?.pbi === pbi && isMachineName(l.machine) && typeof l.token === "string" && l.token.length <= 100 && typeof l.expiresAt === "number" && Number.isFinite(l.expiresAt) && (l.state === "held" || l.state === "released") ? l : null;
  } catch {
    return null;
  }
}

/** `2026-11-17 09:30 UTC`: a time both machines read the same. */
export const leaseTime = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** Why a PBI another machine holds is not started here, as one line for the screen and the logs. */
export const heldLine = (pbi: number, holder: string, until: number) => `PBI #${pbi} は ${holder} が ${leaseTime(until)} まで持っている`;

/**
 * The leases of this machine. It remembers the ones it holds (with the etag of its last write, so renewing costs one
 * write and no read) and what it last saw other machines hold (`heldElsewhere`), which the overlap decision reads
 * without asking S3.
 */
export class PbiLeases {
  private mine = new Map<string, { repository: string; pbi: number; token: string; etag: string; expiresAt: number; recovered?: boolean; stage?: boolean }>();
  private theirs = new Map<string, { repository: string; pbi: number; holder: string; until: number }>();
  /** The etag each key had when it was last read by `refresh`: an unchanged one is not read again. */
  private seen = new Map<string, string>();

  constructor(private store: S3Store, private opts: { machine: string; ttlMs: number; now?: () => number }) {}

  /** The operations on one lease key that change it (take, give back, one renewal) run one at a time on this machine: a give-back never lands between a take's read and its write. */
  private chains = new Map<string, Promise<unknown>>();
  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(key) ?? Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** What lies under a lease's key, read within the limit: `lease` is null for what is not that PBI's lease (too big to be one included). */
  private async read(key: string, pbi: number): Promise<{ etag: string; lease: Lease | null } | null> {
    const got = await this.store.get(key, { maxBytes: LEASE_MAX_BYTES });
    return got ? { etag: got.etag, lease: got.more ? null : decode(got.body, pbi) } : null;
  }

  /** The proof of a machine's holding as stored: its token and state, or null when there is none (or it is no proof). A read that fails throws. */
  private async readProof(machine: string, repository: string, pbi: number): Promise<{ token?: unknown; state?: unknown } | null> {
    const got = await this.store.get(proofKey(machine, repository, pbi), { maxBytes: LEASE_MAX_BYTES });
    if (!got || got.more) return null;
    try {
      const p = JSON.parse(new TextDecoder().decode(got.body));
      return p && typeof p === "object" ? p : null;
    } catch {
      return null;
    }
  }

  /**
   * Whether a lease that names a machine was written by it: its token has the shape this code gives (anything else is
   * no holder's, and not looked up) and the proof under that machine's own prefix says the same token is held (a given-back
   * holding's proof says released). Without one the lease is no holder's, and the PBI may be taken (as one that ran out).
   * A proof that cannot be read throws: the caller does not take the PBI on a guess.
   */
  private async vouched(repository: string, pbi: number, lease: Lease, quiet = false): Promise<boolean> {
    let ok = false;
    if (TOKEN_SHAPE.test(lease.token)) {
      const p = await this.readProof(lease.machine, repository, pbi);
      ok = p?.token === lease.token && p.state === "held";
    }
    if (!ok && !quiet) console.error(`[lease] PBI #${pbi}: ${lease.machine} を名乗るリースに証が無い`);
    return ok;
  }

  /** Marks this machine's proof released when it is the proof of `token`: that token written back proves nothing from now on. */
  private async retire(repository: string, pbi: number, token: string): Promise<void> {
    const p = await this.readProof(this.opts.machine, repository, pbi);
    if (p?.token === token && p.state !== "released") await this.store.put(proofKey(this.opts.machine, repository, pbi), encodeProof(token, "released"));
  }

  /**
   * When a lease another machine wrote ends, as this machine reads it: never later than one lease's life from now. A
   * holder whose clock runs ahead, or an end written by hand far in the future, would otherwise keep a PBI for ever;
   * a holder that is alive renews, and is read again then.
   */
  private endOf(lease: Lease, now: number): number {
    return Math.min(lease.expiresAt, now + this.opts.ttlMs);
  }

  /** A lease whose end lies further ahead than a living holder ever writes it (two lives), by the version first seen and when. */
  private far = new Map<string, { etag: string; at: number }>();

  /**
   * Whether another machine's lease is over as this machine reads it: its end has passed — or its end lies more than
   * two lives ahead and the same version has been there for a whole life since this machine first saw it. A living
   * holder writes a new version every renewal, so only one that stopped renewing is read as over that way.
   */
  private over(key: string, lease: Lease, etag: string, now: number): boolean {
    if (lease.expiresAt <= now) return true;
    if (lease.expiresAt <= now + 2 * this.opts.ttlMs) {
      this.far.delete(key);
      return false;
    }
    const f = this.far.get(key);
    if (!f || f.etag !== etag) {
      this.far.set(key, { etag, at: now });
      return false;
    }
    return now >= f.at + this.opts.ttlMs;
  }

  /**
   * Takes the PBI's lease: made when there is none; taken over when it was given back, has run out, or is this
   * machine's own. Held by another machine and not run out = `{ ok: false, holder, until }`. Losing the write to
   * another machine that took it in the same moment is the same answer, read again. `forStage`: taken for a stage Task
   * the daemon runs (not for a session that claimed the PBI by itself): the daemon gives such a lease back once no
   * stage Task of the PBI is at it any more.
   */
  async acquire(repository: string, pbi: number, forStage = false): Promise<Acquired> {
    const key = leaseKey(repository, pbi);
    // a look at the bucket under way (`refresh`) must not take this lease for one a daemon before this one left
    this.acquiring.set(key, (this.acquiring.get(key) ?? 0) + 1);
    try {
      return await this.serial(key, () => this.take(key, repository, pbi, forStage));
    } finally {
      const left = this.acquiring.get(key)! - 1;
      if (left > 0) this.acquiring.set(key, left);
      else this.acquiring.delete(key);
    }
  }

  private acquiring = new Map<string, number>();

  private async take(key: string, repository: string, pbi: number, forStage: boolean): Promise<Acquired> {
    for (let tries = 0; tries < 5; tries++) {
      const now = this.now();
      const had = await this.read(key, pbi);
      const lease = had?.lease ?? null;
      if (had && lease && lease.state === "held" && lease.machine !== this.opts.machine && !this.over(key, lease, had.etag, now) && (await this.vouched(repository, pbi, lease))) {
        const until = this.endOf(lease, now);
        this.theirs.set(key, { repository, pbi, holder: lease.machine, until });
        return { ok: false, holder: lease.machine, until };
      }
      const expiresAt = now + this.opts.ttlMs;
      // its own held lease (even one that ran out) is written again under the token it has, with the proof it has: a failure half way leaves them agreeing
      let token = lease && lease.state === "held" && lease.machine === this.opts.machine && (await this.vouched(repository, pbi, lease, true)) ? lease.token : "";
      if (!token) {
        // anything else is a new holding: its proof first (over the last one, which is no longer the lease's), so a lease of this machine is never there without it
        token = crypto.randomUUID();
        await this.store.put(proofKey(this.opts.machine, repository, pbi), encodeProof(token, "held"));
      }
      const put = await this.store.put(key, encode({ pbi, machine: this.opts.machine, token, state: "held", expiresAt }), had ? { ifMatch: had.etag } : { ifNoneMatch: true });
      if (put === "conflict") continue;
      // the holding's proof is written again once the lease is: whatever else touched it (a give-back that ran before this machine kept the lease) does not leave the lease unproven
      await this.store.put(proofKey(this.opts.machine, repository, pbi), encodeProof(token, "held"));
      this.mine.set(key, { repository, pbi, token, etag: put.etag, expiresAt, ...(forStage ? { stage: true } : {}) });
      this.theirs.delete(key);
      return { ok: true };
    }
    throw new Error(`the lease of PBI #${pbi} kept changing while it was taken`);
  }

  /** Gives the PBI's lease back, when this machine holds it (also one a daemon before this one took); another's is left. */
  release(repository: string, pbi: number): Promise<void> {
    const key = leaseKey(repository, pbi);
    return this.serial(key, () => this.giveBack(key, repository, pbi));
  }

  private async giveBack(key: string, repository: string, pbi: number): Promise<void> {
    this.mine.delete(key);
    const had = await this.read(key, pbi);
    const lease = had?.lease ?? null;
    if (!had || !lease || lease.machine !== this.opts.machine || lease.state !== "held") return;
    // the proof says released first: the token left in the lease proves nothing from now on, so it cannot be written back
    await this.retire(repository, pbi, lease.token);
    // a write lost here means another machine took it over meanwhile (it had run out): then it is theirs
    await this.store.put(key, encode({ ...lease, state: "released", expiresAt: this.now() }), { ifMatch: had.etag });
  }

  /**
   * Renews every lease held, each with one conditional write over this machine's last one. A lease is lost — no longer
   * held here, and returned so the caller can stop the work on it — when another machine wrote over it meanwhile
   * (`taken`: the write was refused or failed, and the lease read again is missing, given back, unreadable or not this
   * machine's token; one still carrying this machine's token is kept), or when it could not be renewed (the bucket not reached, the credentials run out, the machine asleep)
   * until its own end came near (`expired`: within a fifth of its life of the end this machine last wrote): from then
   * on another machine may take it at any moment, so this one no longer acts as its holder. A failed renewal before
   * that keeps the lease and is tried again next round. The leases are renewed side by side, so the order of what
   * is returned is the order they were settled in.
   */
  async renewAll(): Promise<Array<{ repository: string; pbi: number; why: "taken" | "expired" }>> {
    const lost: Array<{ repository: string; pbi: number; why: "taken" | "expired" }> = [];
    // the keys run side by side (one slow take or give-back of a PBI does not hold up the renewal of another's), each one behind its own `serial`
    await Promise.all([...this.mine].map(([key, held]) =>
      this.serial(key, async () => {
        // a take or give-back that ran first changed this holding: what was seen at the start of the round is not renewed or dropped
        const cur = this.mine.get(key);
        if (!cur || cur.token !== held.token || cur.etag !== held.etag) return;
        const now = this.now();
        const drop = async (why: "taken" | "expired") => {
          this.mine.delete(key);
          this.seen.delete(key);
          lost.push({ repository: held.repository, pbi: held.pbi, why });
          // what this machine no longer holds cannot be written back as its holding (a failure is only logged)
          await this.retire(held.repository, held.pbi, held.token).catch((e) => console.error(`[lease] PBI #${held.pbi} (${held.repository}): the proof was not released: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
        };
        // not renewed in time (this machine slept, or every try failed): it is not written again as if nothing happened
        if (now >= held.expiresAt) return drop("expired");
        const expiresAt = now + this.opts.ttlMs;
        let put: Awaited<ReturnType<S3Store["put"]>> | undefined;
        let failure: unknown;
        try {
          put = await this.store.put(key, encode({ pbi: held.pbi, machine: this.opts.machine, token: held.token, state: "held", expiresAt }), { ifMatch: held.etag });
        } catch (e) {
          failure = e;
        }
        if (put && put !== "conflict") {
          this.mine.set(key, { ...held, etag: put.etag, expiresAt });
          return;
        }
        // a write that threw (the limit ended it) may have reached the bucket, and a refused one may be refused for a lease that is still this machine's: the key is read again before anything is dropped
        let again: Awaited<ReturnType<PbiLeases["read"]>> | undefined;
        try {
          again = await this.read(key, held.pbi);
        } catch (e) {
          failure ??= e;
        }
        if (again !== undefined) {
          const l = again?.lease;
          if (again && l && l.state === "held" && l.machine === this.opts.machine && l.token === held.token) {
            // still this holding: kept under what the bucket has now (the renewal arrived, or the next round makes it), unless it did not arrive and the end is near
            if (failure && this.now() >= l.expiresAt - this.opts.ttlMs / 5) return drop("expired");
            this.mine.set(key, { ...held, etag: again.etag, expiresAt: l.expiresAt });
            return;
          }
          return drop("taken");
        }
        // the bucket cannot be read either: kept until the end comes near, and tried again next round
        if (this.now() >= held.expiresAt - this.opts.ttlMs / 5) await drop("expired");
        else console.error(`[lease] PBI #${held.pbi} (${held.repository}) was not renewed: ${String((failure as Error)?.message ?? failure).slice(0, 200)}`);
      }),
    ));
    return lost;
  }

  /** The PBIs this machine holds; `recovered` = a lease a daemon before this one took, found in the bucket at start; `stage` = taken for a stage Task of the daemon's. */
  held(): Array<{ repository: string; pbi: number; recovered: boolean; stage: boolean }> {
    return [...this.mine.values()].map(({ repository, pbi, recovered, stage }) => ({ repository, pbi, recovered: !!recovered, stage: !!stage }));
  }

  holds(repository: string, pbi: number): boolean {
    return this.mine.has(leaseKey(repository, pbi));
  }

  /**
   * Reads what the bucket holds now: one list, and one read per lease that changed since the last look. After it,
   * `heldElsewhere` knows every PBI another machine holds, and a lease of this machine's own from before a restart is
   * held (and renewed) again.
   */
  async refresh(): Promise<void> {
    const now = this.now();
    const listed = await this.store.list(PREFIX);
    for (const { key, etag, size } of listed) {
      if (this.seen.get(key) === etag || this.mine.has(key)) continue;
      // only a key `leaseKey` writes, and only an object small enough to be a lease, is read at all
      const m = KEY.exec(key);
      if (!m || !(size <= LEASE_MAX_BYTES)) continue;
      const got = await this.read(key, Number(m[2]));
      const lease = got?.lease ?? null;
      if (!got || this.mine.has(key) || this.acquiring.has(key)) continue;
      this.seen.set(key, got.etag);
      const at = { repository: m[1]!, pbi: Number(m[2]) };
      if (lease?.state === "held" && lease.machine !== this.opts.machine && !this.over(key, lease, got.etag, now) && (await this.vouched(at.repository, at.pbi, lease).catch(() => true))) this.theirs.set(key, { ...at, holder: lease.machine, until: this.endOf(lease, now) });
      else this.theirs.delete(key);
      if (lease?.state === "held" && lease.expiresAt > now && lease.machine === this.opts.machine) this.mine.set(key, { ...at, token: lease.token, etag: got.etag, expiresAt: this.endOf(lease, now), recovered: true });
    }
  }

  /** Who else holds the PBI, as last seen (`acquire` refused, or `refresh`), until that lease's time is over; null = no one known. */
  heldElsewhere(repository: string, pbi: number): { holder: string; until: number } | null {
    const key = leaseKey(repository, pbi);
    const t = this.theirs.get(key);
    if (!t) return null;
    if (t.until <= this.now()) {
      // run out as far as this machine saw: the next look reads it again (its holder may have renewed it)
      this.theirs.delete(key);
      this.seen.delete(key);
      return null;
    }
    return { holder: t.holder, until: t.until };
  }
}
