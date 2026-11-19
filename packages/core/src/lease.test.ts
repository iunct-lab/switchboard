// test-reads: none
import { describe, expect, test } from "bun:test";
import { loadUplink, UPLINK_PREVIEW } from "./config.ts";
import { heldLine, LEASE_MAX_BYTES, leaseKey, PbiLeases, proofKey } from "./lease.ts";
import { memoryS3, type S3Store } from "./s3.ts";
import { leaseTurnEnded, stopForLostLease } from "./server/lease.ts";

const REPO = "Owner/Repo";
const TTL = 900_000;

function machines(names: string[], s3 = memoryS3()) {
  const clock = { now: 1_000_000 };
  return { s3, clock, leases: names.map((machine) => new PbiLeases(s3, { machine, ttlMs: TTL, now: () => clock.now })) };
}
const json = (v: object) => new TextEncoder().encode(JSON.stringify(v));
/** The proof a machine leaves when it takes a lease: its token, under its own prefix. */
const prove = (s3: ReturnType<typeof memoryS3>, machine: string, pbi: number, token: string, state = "held") => s3.put(proofKey(machine, REPO, pbi), json({ token, state }));
/** A token of the shape the code gives (a UUID), for leases written by hand. */
const TOK = "11111111-1111-4111-8111-111111111111";
const proofOf = async (s3: ReturnType<typeof memoryS3>, machine: string, pbi: number) => JSON.parse(new TextDecoder().decode((await s3.get(proofKey(machine, REPO, pbi)))!.body));
const stored = async (s3: ReturnType<typeof memoryS3>, pbi: number) => JSON.parse(new TextDecoder().decode((await s3.get(leaseKey(REPO, pbi)))!.body));

describe("PbiLeases", () => {
  test("a PBI no one holds is taken; another machine is refused with the holder and the time, and says so in one line", async () => {
    const { leases: [ec2, pc], clock } = machines(["instance", "pc1"]);
    expect(await ec2!.acquire(REPO, 7)).toEqual({ ok: true });
    const r = await pc!.acquire(REPO, 7);
    expect(r).toEqual({ ok: false, holder: "instance", until: clock.now + TTL });
    expect(heldLine(7, "instance", Date.UTC(2026, 10, 17, 9, 30))).toBe("PBI #7 は instance が 2026-11-17 09:30 UTC まで持っている");
    expect(pc!.heldElsewhere(REPO, 7)).toEqual({ holder: "instance", until: clock.now + TTL });
    expect(ec2!.held()).toEqual([{ repository: REPO, pbi: 7, recovered: false, stage: false }]);
    expect(pc!.held()).toEqual([]);
    // another PBI is another lease
    expect(await pc!.acquire(REPO, 8)).toEqual({ ok: true });
  });

  test("of twenty machines taking the same PBI at once exactly one gets it, twenty times over", async () => {
    for (let round = 0; round < 20; round++) {
      const { leases } = machines(Array.from({ length: 20 }, (_, i) => `m${i}`));
      const got = await Promise.all(leases.map((l) => l.acquire(REPO, round)));
      expect(got.filter((r) => r.ok).length).toBe(1);
      const winner = leases[got.findIndex((r) => r.ok)]!;
      for (const r of got) if (!r.ok) expect(r.holder).toBe(winner.held().length ? `m${got.findIndex((x) => x.ok)}` : "");
    }
  });

  test("a lease is not taken over before it runs out, and is after", async () => {
    const { leases: [ec2, pc], clock, s3 } = machines(["instance", "pc1"]);
    await pc!.acquire(REPO, 7);
    clock.now += TTL - 1;
    expect((await ec2!.acquire(REPO, 7)).ok).toBe(false);
    clock.now += 2;
    expect(await ec2!.acquire(REPO, 7)).toEqual({ ok: true });
    expect((await stored(s3, 7)).machine).toBe("instance");
    // the machine that was away finds out when it renews: the lease is no longer its own
    expect(await pc!.renewAll()).toEqual([{ repository: REPO, pbi: 7, why: "expired" }]);
    expect(pc!.held()).toEqual([]);
    expect((await stored(s3, 7)).machine).toBe("instance");
  });

  test("renewing moves the end on with one write and no read, so a holder that keeps renewing is never taken over", async () => {
    const { leases: [ec2, pc], clock, s3 } = machines(["instance", "pc1"]);
    await pc!.acquire(REPO, 7);
    for (let i = 0; i < 30; i++) {
      clock.now += 60_000;
      const before = s3.calls;
      expect(await pc!.renewAll()).toEqual([]);
      expect(s3.calls - before).toBe(1);
    }
    expect((await ec2!.acquire(REPO, 7)).ok).toBe(false);
    expect((await stored(s3, 7)).expiresAt).toBe(clock.now + TTL);
  });

  test("a lease given back is written as released (nothing is deleted) and another machine takes it at once", async () => {
    const { leases: [ec2, pc], s3 } = machines(["instance", "pc1"]);
    await ec2!.acquire(REPO, 7);
    await ec2!.release(REPO, 7);
    expect((await stored(s3, 7)).state).toBe("released");
    expect(ec2!.held()).toEqual([]);
    expect(await pc!.acquire(REPO, 7)).toEqual({ ok: true });
    // giving back what another machine holds changes nothing
    await ec2!.release(REPO, 7);
    expect(await stored(s3, 7)).toMatchObject({ machine: "pc1", state: "held" });
  });

  test("the same machine takes its own lease again (a daemon that restarted), and gives back one a daemon before it took", async () => {
    const s3 = memoryS3();
    const { leases: [before] } = machines(["pc1"], s3);
    await before!.acquire(REPO, 7);
    const { leases: [after, ec2] } = machines(["pc1", "instance"], s3);
    expect(await after!.acquire(REPO, 7)).toEqual({ ok: true });
    await before!.acquire(REPO, 8);
    await after!.release(REPO, 8);
    expect((await stored(s3, 8)).state).toBe("released");
    expect(await ec2!.acquire(REPO, 8)).toEqual({ ok: true });
  });

  test("whatever lies under a lease's key is read within a small limit: a big object is never brought here, and is not a lease", async () => {
    const { s3, leases: [ec2, pc], clock } = machines(["instance", "pc1"]);
    await s3.put(leaseKey(REPO, 7), new Uint8Array(1024 * 1024).fill(0x20));
    await s3.put(leaseKey(REPO, 8), new Uint8Array(1024 * 1024).fill(0x20));
    // a look at the bucket does not read it at all (its size is in the list)
    const before = s3.calls;
    await ec2!.refresh();
    expect(s3.calls - before).toBe(1);
    expect(ec2!.heldElsewhere(REPO, 7)).toBeNull();
    // taking the PBI reads no more than the limit, finds no lease there, and writes its own over that version
    expect(await ec2!.acquire(REPO, 7)).toEqual({ ok: true });
    expect(s3.largestRead).toBeLessThanOrEqual(LEASE_MAX_BYTES);
    expect((await stored(s3, 7)).machine).toBe("instance");
    expect(await pc!.acquire(REPO, 7)).toEqual({ ok: false, holder: "instance", until: clock.now + TTL });
    await pc!.release(REPO, 8);
    expect(s3.largestRead).toBeLessThanOrEqual(LEASE_MAX_BYTES);
  });

  test("a lease is one only for the PBI its key names, with a machine's name as its holder; a key that is not a lease's is not read", async () => {
    const { s3, leases: [ec2], clock } = machines(["instance"]);
    const put = (key: string, lease: object) => s3.put(key, new TextEncoder().encode(JSON.stringify(lease)));
    const held = (over: object) => ({ pbi: 7, machine: "pc1", token: TOK, state: "held", expiresAt: clock.now + TTL, ...over });
    await put(leaseKey(REPO, 7), held({ pbi: 8 })); // another PBI's lease copied under this key
    await put(leaseKey(REPO, 9), held({ pbi: 9, machine: "../pc1" }));
    await put("lease/owner/repo/../other/10.json", held({ pbi: 10 }));
    await put("lease/owner/repo/011.json", held({ pbi: 11 }));
    await put(leaseKey(REPO, 12), held({ pbi: 12 }));
    await prove(s3, "pc1", 12, TOK);
    const before = s3.calls;
    await ec2!.refresh();
    expect(s3.calls - before).toBe(1 + 3 + 1); // the list, the three keys that are a lease's, and the proof of the one that is held
    expect([7, 9, 10, 11, 12].map((n) => ec2!.heldElsewhere(REPO, n)?.holder ?? null)).toEqual([null, null, null, null, "pc1"]);
  });

  test("refresh learns what other machines hold with one list and a read per changed lease, and picks its own up again", async () => {
    const s3 = memoryS3();
    const { leases: [pc, old], clock } = machines(["pc1", "instance"], s3);
    await pc!.acquire(REPO, 7);
    await old!.acquire(REPO, 9);
    const { leases: [ec2] } = machines(["instance"], s3);
    expect(ec2!.heldElsewhere(REPO, 7)).toBeNull();
    await ec2!.refresh();
    expect(ec2!.heldElsewhere(REPO, 7)).toEqual({ holder: "pc1", until: clock.now + TTL });
    expect(ec2!.held()).toEqual([{ repository: "owner/repo", pbi: 9, recovered: true, stage: false }]);
    const calls = s3.calls;
    await ec2!.refresh();
    expect(s3.calls - calls).toBe(1); // nothing changed: the list alone
    await pc!.release(REPO, 7);
    await ec2!.refresh();
    expect(ec2!.heldElsewhere(REPO, 7)).toBeNull();
  });

  /** The bucket with the write of `put` number `at` (from 1) answered as a failure after it was applied (the limit ended the call, its answer never came). */
  const lateAnswer = (mem: ReturnType<typeof memoryS3>, at: number, asked: unknown[] = []): S3Store => {
    let puts = 0;
    return { ...mem, put: async (key, body, cond) => {
      if (key.startsWith("lease/")) asked.push(cond);
      const r = await mem.put(key, body, cond);
      if (key.startsWith("lease/") && ++puts === at) throw new Error("aws s3api put-object did not answer within 20 s");
      return r;
    } };
  };

  test("a renewal S3 applied but whose answer never came keeps the lease: it is read again, and the next round renews on the etag read", async () => {
    const mem = memoryS3();
    const clock = { now: 1_000_000 };
    const asked: unknown[] = [];
    const pc = new PbiLeases(lateAnswer(mem, 2, asked), { machine: "pc1", ttlMs: TTL, now: () => clock.now });
    await pc.acquire(REPO, 7); // lease put 1
    clock.now += 60_000;
    expect(await pc.renewAll()).toEqual([]); // lease put 2: applied, answer lost
    expect(pc.holds(REPO, 7)).toBe(true);
    expect((await stored(mem, 7)).expiresAt).toBe(clock.now + TTL);
    const applied = (await mem.get(leaseKey(REPO, 7)))!.etag;
    clock.now += 60_000;
    expect(await pc.renewAll()).toEqual([]);
    expect((await stored(mem, 7)).expiresAt).toBe(clock.now + TTL);
    // the third write asked for the etag the late-answered one made, not the stale one (no refusal, no second read)
    expect(asked).toEqual([{ ifNoneMatch: true }, expect.anything(), { ifMatch: applied }]);
    expect(await proofOf(mem, "pc1", 7)).toMatchObject({ state: "held" });
  });

  test("a renewal refused while the lease is still this machine's (same token, another etag) is kept, not dropped as taken", async () => {
    const { leases: [pc], clock, s3 } = machines(["pc1"]);
    await pc!.acquire(REPO, 7);
    const lease = await stored(s3, 7);
    // the same holding written again behind this machine's back: its etag is no longer the one the renewal asks for
    await s3.put(leaseKey(REPO, 7), json(lease));
    clock.now += 60_000;
    expect(await pc!.renewAll()).toEqual([]);
    expect(pc!.holds(REPO, 7)).toBe(true);
    clock.now += 60_000;
    expect(await pc!.renewAll()).toEqual([]);
    expect((await stored(s3, 7)).expiresAt).toBe(clock.now + TTL);
  });

  test("a renewal that failed with the lease now another machine's is lost as taken, and the proof is released", async () => {
    const mem = memoryS3();
    const clock = { now: 1_000_000 };
    let fail = false;
    const flaky: S3Store = { ...mem, put: async (k, b, c) => { if (fail && k.startsWith("lease/")) throw new Error("did not answer"); return mem.put(k, b, c); } };
    const pc = new PbiLeases(flaky, { machine: "pc1", ttlMs: TTL, now: () => clock.now });
    await pc.acquire(REPO, 7);
    await mem.put(leaseKey(REPO, 7), json({ pbi: 7, machine: "instance", token: TOK, state: "held", expiresAt: clock.now + TTL }));
    fail = true;
    clock.now += 60_000;
    expect(await pc.renewAll()).toEqual([{ repository: REPO, pbi: 7, why: "taken" }]);
    expect(pc.holds(REPO, 7)).toBe(false);
    expect(await proofOf(mem, "pc1", 7)).toMatchObject({ state: "released" });
  });

  test("a lease another machine wrote over while this one still renewed in time is lost as taken", async () => {
    const { leases: [ec2, pc], clock, s3 } = machines(["instance", "pc1"]);
    await pc!.acquire(REPO, 7);
    // written over by hand (the lease protects against Switchboards, not against the bucket's other writers)
    await s3.put(leaseKey(REPO, 7), new TextEncoder().encode(JSON.stringify({ pbi: 7, machine: "instance", token: "t", state: "held", expiresAt: clock.now + TTL })));
    clock.now += 60_000;
    expect(await pc!.renewAll()).toEqual([{ repository: REPO, pbi: 7, why: "taken" }]);
    expect(pc!.holds(REPO, 7)).toBe(false);
    expect(ec2!.holds(REPO, 7)).toBe(false);
  });

  test("a lease that cannot be renewed is kept while its end is far, and is lost once the end is near: the holder no longer acts as one", async () => {
    const s3 = memoryS3();
    const clock = { now: 1_000_000 };
    let down = false;
    const flaky = { ...s3, get: s3.get, list: s3.list, put: (...a: Parameters<typeof s3.put>) => (down ? Promise.reject(new Error("aws put-object failed (255): ExpiredToken")) : s3.put(...a)) };
    const pc = new PbiLeases(flaky, { machine: "pc1", ttlMs: TTL, now: () => clock.now });
    await pc.acquire(REPO, 7);
    down = true; // the credentials ran out
    clock.now += 60_000;
    expect(await pc.renewAll()).toEqual([]);
    expect(pc.holds(REPO, 7)).toBe(true);
    clock.now += TTL - 60_000 - TTL / 5; // a fifth of its life before the end it last wrote
    expect(await pc.renewAll()).toEqual([{ repository: REPO, pbi: 7, why: "expired" }]);
    expect(pc.holds(REPO, 7)).toBe(false);
    // and it is not written again when the bucket answers once more
    down = false;
    const before = s3.calls;
    expect(await pc.renewAll()).toEqual([]);
    expect(s3.calls).toBe(before);
  });

  test("a machine that slept past its lease's end does not renew it as if nothing happened", async () => {
    const { leases: [pc], clock, s3 } = machines(["pc1"]);
    await pc!.acquire(REPO, 7);
    const written = await stored(s3, 7);
    clock.now += TTL + 1; // the lid was closed
    expect(await pc!.renewAll()).toEqual([{ repository: REPO, pbi: 7, why: "expired" }]);
    expect(await stored(s3, 7)).toEqual(written); // the lease is not written again (only its proof is given back)
  });

  test("an end written far in the future does not keep a PBI for ever: unrenewed for one life as seen here, it is taken", async () => {
    const { leases: [ec2], clock, s3 } = machines(["instance"]);
    await prove(s3, "pc1", 7, TOK);
    await s3.put(leaseKey(REPO, 7), new TextEncoder().encode(JSON.stringify({ pbi: 7, machine: "pc1", token: TOK, state: "held", expiresAt: clock.now + 365 * 24 * 3600_000 })));
    // read as held, but for no longer than one life
    expect(await ec2!.acquire(REPO, 7)).toEqual({ ok: false, holder: "pc1", until: clock.now + TTL });
    clock.now += TTL - 1;
    expect((await ec2!.acquire(REPO, 7)).ok).toBe(false);
    clock.now += 1;
    expect(await ec2!.acquire(REPO, 7)).toEqual({ ok: true });
  });

  test("alone (no SWITCHBOARD_UPLINK) there is no mode, so no leases are made and S3 is never asked", () => {
    expect(loadUplink({}).mode).toBeNull();
    expect(loadUplink({ ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "receive" })).toMatchObject({ mode: "receive", machine: "instance", leaseTtlMs: 900_000, leaseRenewMs: 60_000, intervalMs: 600_000 });
    expect(loadUplink({ ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "send", SWITCHBOARD_MACHINE: "pc1", SWITCHBOARD_UPLINK_BUCKET: "b", SWITCHBOARD_LEASE_TTL_S: "120" })).toMatchObject({ mode: "send", machine: "pc1", leaseTtlMs: 120_000, intervalMs: 300_000 });
    expect(() => loadUplink({ ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "send", SWITCHBOARD_UPLINK_BUCKET: "b" })).toThrow("SWITCHBOARD_MACHINE");
    expect(() => loadUplink({ ...UPLINK_PREVIEW, SWITCHBOARD_UPLINK: "send", SWITCHBOARD_MACHINE: "pc1" })).toThrow("SWITCHBOARD_UPLINK_BUCKET");
    expect(() => loadUplink({ SWITCHBOARD_UPLINK: "both" })).toThrow("send");
  });
});

describe("the proof of a lease", () => {
  test("a lease written by its machine carries a proof with the same token, also after renewals", async () => {
    const { leases: [pc], s3, clock } = machines(["pc1"]);
    await pc!.acquire(REPO, 7);
    const token = (await stored(s3, 7)).token;
    const proof = async () => JSON.parse(new TextDecoder().decode((await s3.get(proofKey("pc1", REPO, 7)))!.body));
    expect(await proof()).toEqual({ token, state: "held" });
    const before = s3.calls;
    clock.now += 60_000;
    await pc!.renewAll();
    expect(s3.calls - before).toBe(1); // the renewal writes the lease only
    expect(await proof()).toEqual({ token, state: "held" });
    expect((await stored(s3, 7)).token).toBe(token);
  });

  test("a lease that names another machine without that machine's proof is not taken as held, and the PBI can be taken", async () => {
    const { s3, clock } = machines([]);
    const now = () => clock.now;
    const ec2 = new PbiLeases(s3, { machine: "instance", ttlMs: TTL, now });
    const pc = new PbiLeases(s3, { machine: "pc1", ttlMs: TTL, now });
    // a writer that is not the instance names it: the lease is put by hand, no proof under instance/
    await s3.put(leaseKey(REPO, 7), json({ pbi: 7, machine: "instance", token: "forged", state: "held", expiresAt: clock.now + TTL }));
    await pc.refresh();
    expect(pc.heldElsewhere(REPO, 7)).toBeNull();
    expect(await pc.acquire(REPO, 7)).toEqual({ ok: true });
    // the same, with a proof of another token under the named machine's prefix
    await ec2.acquire(REPO, 8);
    await s3.put(leaseKey(REPO, 8), json({ pbi: 8, machine: "instance", token: TOK, state: "held", expiresAt: clock.now + TTL }));
    const other = new PbiLeases(s3, { machine: "pc2", ttlMs: TTL, now });
    expect(await other.acquire(REPO, 8)).toEqual({ ok: true });
    // a lease with its machine's proof is held, as before
    await ec2.acquire(REPO, 9);
    expect(await pc.acquire(REPO, 9)).toEqual({ ok: false, holder: "instance", until: clock.now + TTL });
    await pc.refresh();
    expect(pc.heldElsewhere(REPO, 9)).toEqual({ holder: "instance", until: clock.now + TTL });
  });

  /** A store that counts the proof reads and writes. */
  const counting = (s3: ReturnType<typeof memoryS3>) => {
    const n = { proofGets: 0, proofPuts: 0 };
    const store = {
      ...s3,
      get: (key: string, o?: Parameters<typeof s3.get>[1]) => (key.startsWith("lease-proof/") && n.proofGets++, s3.get(key, o)),
      put: (key: string, ...a: any[]) => (key.startsWith("lease-proof/") && n.proofPuts++, (s3.put as any)(key, ...a)),
    } as typeof s3;
    return { n, store };
  };
  const writeBack = async (s3: ReturnType<typeof memoryS3>, old: object, expiresAt: number) => {
    const had = (await s3.get(leaseKey(REPO, 7)))!;
    await s3.put(leaseKey(REPO, 7), json({ ...old, expiresAt }), { ifMatch: had.etag });
  };

  test("taking after a give-back is a new token, and the token before it written back is not a holder's", async () => {
    const { leases: [ec2, pc1, pc2], s3, clock } = machines(["instance", "pc1", "pc2"]);
    await ec2!.acquire(REPO, 7);
    const first = await stored(s3, 7);
    await ec2!.release(REPO, 7);
    await ec2!.acquire(REPO, 7);
    expect((await stored(s3, 7)).token).not.toBe(first.token);
    await ec2!.release(REPO, 7);
    await writeBack(s3, first, clock.now + TTL);
    await pc2!.refresh();
    expect(pc2!.heldElsewhere(REPO, 7)).toBeNull();
    expect(await pc1!.acquire(REPO, 7)).toEqual({ ok: true });
  });

  test("a lease lost on renewal gives its proof back: the token written back by the machine that took it is not a holder's", async () => {
    const { leases: [ec2, pc], s3, clock } = machines(["instance", "pc1"]);
    await pc!.acquire(REPO, 7);
    const old = await stored(s3, 7);
    await s3.put(leaseKey(REPO, 7), json({ pbi: 7, machine: "instance", token: TOK, state: "held", expiresAt: clock.now + TTL })); // written over by hand
    clock.now += 60_000;
    expect(await pc!.renewAll()).toEqual([{ repository: REPO, pbi: 7, why: "taken" }]);
    expect(JSON.parse(new TextDecoder().decode((await s3.get(proofKey("pc1", REPO, 7)))!.body))).toEqual({ token: old.token, state: "released" });
    await writeBack(s3, old, clock.now + TTL);
    expect(await ec2!.acquire(REPO, 7)).toEqual({ ok: true });
  });

  test("a token that is not the shape this code gives is no holder's, and no proof is read for it", async () => {
    const s3 = memoryS3();
    const { n, store } = counting(s3);
    const clock = { now: 1_000_000 };
    const pc = new PbiLeases(store, { machine: "pc1", ttlMs: TTL, now: () => clock.now });
    await s3.put(leaseKey(REPO, 7), json({ pbi: 7, machine: "instance", token: "../../x", state: "held", expiresAt: clock.now + TTL }));
    expect(await pc.acquire(REPO, 7)).toEqual({ ok: true });
    expect(n.proofGets).toBe(0);
  });

  test("taking its own held lease again (also one that ran out) keeps the token and writes its proof again as held", async () => {
    const s3 = memoryS3();
    const { n, store } = counting(s3);
    const clock = { now: 1_000_000 };
    const ec2 = new PbiLeases(store, { machine: "instance", ttlMs: TTL, now: () => clock.now });
    await ec2.acquire(REPO, 7);
    const token = (await stored(s3, 7)).token;
    n.proofPuts = 0;
    expect(await ec2.acquire(REPO, 7)).toEqual({ ok: true });
    clock.now += TTL + 1;
    expect(await ec2.acquire(REPO, 7)).toEqual({ ok: true });
    expect(n.proofPuts).toBe(2);
    expect((await stored(s3, 7)).token).toBe(token);
    expect(await proofOf(s3, "instance", 7)).toEqual({ token, state: "held" });
  });

  /** A store whose get and put each yield a few times first (a count that varies with the call and the `seed`), so calls of one machine that start together interleave in many different orders. */
  const yielding = (s3: ReturnType<typeof memoryS3>, seed: number) => {
    let call = 0;
    const tick = async () => {
      for (let i = (seed * 7 + call++ * 5) % 12; i >= 0; i--) await Promise.resolve();
    };
    return {
      ...s3,
      get: async (key: string, o?: Parameters<typeof s3.get>[1]) => (await tick(), s3.get(key, o)),
      put: async (key: string, ...a: any[]) => (await tick(), (s3.put as any)(key, ...a)),
    } as typeof s3;
  };

  test("a give-back and a take of the same PBI on one machine at the same time leave the lease and its proof agreeing, and no other machine takes it", async () => {
    for (let seed = 0; seed < 40; seed++) {
      const s3 = memoryS3();
      const clock = { now: 1_000_000 };
      const ec2 = new PbiLeases(yielding(s3, seed), { machine: "instance", ttlMs: TTL, now: () => clock.now });
      const pc = new PbiLeases(s3, { machine: "pc1", ttlMs: TTL, now: () => clock.now });
      await ec2.acquire(REPO, 7);
      for (let i = 0; i < 4; i++) {
        await Promise.all([ec2.release(REPO, 7), ec2.acquire(REPO, 7)]);
        const lease = await stored(s3, 7);
        expect(lease).toMatchObject({ machine: "instance", state: "held" });
        expect(await proofOf(s3, "instance", 7)).toEqual({ token: lease.token, state: "held" });
        expect(ec2.holds(REPO, 7)).toBe(true);
        expect(await pc.acquire(REPO, 7)).toMatchObject({ ok: false, holder: "instance" });
      }
    }
  });

  test("a renewal round and a take of the same PBI at the same time keep the new holding in `mine`, and its proof held", async () => {
    const s3 = memoryS3();
    const clock = { now: 1_000_000 };
    // the lease write that arrives first waits (up to a bound) for a second one to land: the renewal's write, which a take overtakes when nothing orders them
    let arrived = 0;
    let landed = 0;
    const gated = {
      ...s3,
      put: async (key: string, ...a: any[]) => {
        if (key.startsWith("lease/") && ++arrived === 1) for (let i = 0; i < 300 && landed < 1; i++) await Promise.resolve();
        const r = await (s3.put as any)(key, ...a);
        if (key.startsWith("lease/") && arrived > 1) landed++;
        return r;
      },
    } as typeof s3;
    const ec2 = new PbiLeases(s3, { machine: "instance", ttlMs: TTL, now: () => clock.now });
    await ec2.acquire(REPO, 7);
    const pc = new PbiLeases(s3, { machine: "pc1", ttlMs: TTL, now: () => clock.now });
    const gatedEc2 = new PbiLeases(gated, { machine: "instance", ttlMs: TTL, now: () => clock.now });
    await gatedEc2.refresh(); // picks up its own lease from before, as a daemon that restarted does
    arrived = 0;
    clock.now += 60_000;
    const taking = gatedEc2.acquire(REPO, 7);
    const [lost] = await Promise.all([gatedEc2.renewAll(), taking]);
    expect(lost).toEqual([]);
    const lease = await stored(s3, 7);
    expect(gatedEc2.holds(REPO, 7)).toBe(true);
    expect(await proofOf(s3, "instance", 7)).toEqual({ token: lease.token, state: "held" });
    expect(await pc.acquire(REPO, 7)).toMatchObject({ ok: false, holder: "instance" });
  });

  test("a renewal of one PBI's lease is not held up by a slow take of another's", async () => {
    const s3 = memoryS3();
    const clock = { now: 1_000_000 };
    const ec2 = new PbiLeases(s3, { machine: "instance", ttlMs: TTL, now: () => clock.now });
    await ec2.acquire(REPO, 7);
    await ec2.acquire(REPO, 8);
    // the lease reads of PBI 7 never come back: a take of it waits in its `serial`, and the renewal of 7 queues behind that
    const stuck = new Promise<never>(() => {});
    let stick = false;
    const slow: S3Store = { ...s3, get: (key, opts) => (stick && key === leaseKey(REPO, 7) ? stuck : s3.get(key, opts)) };
    const slowEc2 = new PbiLeases(slow, { machine: "instance", ttlMs: TTL, now: () => clock.now });
    await slowEc2.refresh();
    stick = true;
    void slowEc2.acquire(REPO, 7);
    clock.now += 60_000;
    const before = (await stored(s3, 8)).expiresAt;
    const renewing = slowEc2.renewAll();
    // PBI 8 is renewed while 7's operation is still stuck (renewAll itself waits for 7, so it is not awaited)
    for (let i = 0; i < 200 && (await stored(s3, 8)).expiresAt === before; i++) await new Promise((r) => setTimeout(r, 1));
    expect((await stored(s3, 8)).expiresAt).toBe(clock.now + TTL);
    expect(await Promise.race([renewing.then(() => "done"), new Promise((r) => setTimeout(() => r("waiting"), 20))])).toBe("waiting");
  });

  /** A store whose lease writes of one machine and whose proof reads can be made to fail. */
  const faulty = (s3: ReturnType<typeof memoryS3>) => {
    const f = { failLeasePut: false, failProofGet: false };
    const store = {
      ...s3,
      get: (key: string, o?: Parameters<typeof s3.get>[1]) => (f.failProofGet && key.startsWith("lease-proof/") ? Promise.reject(new Error("aws get-object failed (255): 503")) : s3.get(key, o)),
      put: (key: string, ...a: any[]) => (f.failLeasePut && key.startsWith("lease/") ? Promise.reject(new Error("aws put-object failed (255): 503")) : (s3.put as any)(key, ...a)),
    } as typeof s3;
    return { f, store };
  };

  test("taking its own held lease again and failing on the lease write leaves the lease proven: another machine still cannot take it", async () => {
    const s3 = memoryS3();
    const clock = { now: 1_000_000 };
    const { f, store } = faulty(s3);
    const ec2 = new PbiLeases(store, { machine: "instance", ttlMs: TTL, now: () => clock.now });
    const pc = new PbiLeases(s3, { machine: "pc1", ttlMs: TTL, now: () => clock.now });
    await ec2.acquire(REPO, 7);
    f.failLeasePut = true;
    await expect(ec2.acquire(REPO, 7)).rejects.toThrow("put-object");
    expect(await pc.acquire(REPO, 7)).toEqual({ ok: false, holder: "instance", until: clock.now + TTL });
    // the proof of the token the lease still carries is there, and renewing keeps it
    f.failLeasePut = false;
    expect(await ec2.renewAll()).toEqual([]);
    expect((await pc.acquire(REPO, 7)).ok).toBe(false);
  });

  test("the token of a lease given back, written back by another machine, is not a holder's: the PBI can be taken", async () => {
    const { leases: [ec2, pc1, pc2], s3, clock } = machines(["instance", "pc1", "pc2"]);
    await ec2!.acquire(REPO, 7);
    const old = await stored(s3, 7);
    await ec2!.release(REPO, 7);
    // pc2 writes the old lease back in the instance's name
    const had = (await s3.get(leaseKey(REPO, 7)))!;
    await s3.put(leaseKey(REPO, 7), json({ ...old, expiresAt: clock.now + TTL }), { ifMatch: had.etag });
    await pc2!.refresh();
    expect(pc2!.heldElsewhere(REPO, 7)).toBeNull();
    expect(await pc1!.acquire(REPO, 7)).toEqual({ ok: true });
  });

  test("a proof that cannot be read is not read as missing: acquire throws and takes nothing, and a look keeps the lease as a holder's", async () => {
    const s3 = memoryS3();
    const clock = { now: 1_000_000 };
    const { f, store } = faulty(s3);
    const ec2 = new PbiLeases(s3, { machine: "instance", ttlMs: TTL, now: () => clock.now });
    const pc = new PbiLeases(store, { machine: "pc1", ttlMs: TTL, now: () => clock.now });
    await ec2.acquire(REPO, 7);
    f.failProofGet = true;
    await expect(pc.acquire(REPO, 7)).rejects.toThrow("get-object");
    expect(pc.holds(REPO, 7)).toBe(false);
    expect((await stored(s3, 7)).machine).toBe("instance");
    await pc.refresh();
    expect(pc.heldElsewhere(REPO, 7)).toEqual({ holder: "instance", until: clock.now + TTL });
  });

  test("a lease with no proof is logged with the machine it names", async () => {
    const { leases: [pc], s3, clock } = machines(["pc1"]);
    await s3.put(leaseKey(REPO, 7), json({ pbi: 7, machine: "instance", token: "forged", state: "held", expiresAt: clock.now + TTL }));
    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.join(" "));
    try {
      await pc!.acquire(REPO, 7);
    } finally {
      console.error = orig;
    }
    expect(logged).toContain("[lease] PBI #7: instance を名乗るリースに証が無い");
  });
});

describe("a lease that is lost", () => {
  /** A TaskManager's three calls, noted; and a Task in the given status. */
  const watched = (status: string) => {
    const did: string[] = [];
    const task = { id: "t1", status };
    const tasks = {
      record: (_id: string, ev: { t: string; text?: string }) => void did.push(`note ${ev.text}`),
      recordStop: (_id: string, r: { reason: string; state: string; op: string; target: string; evidence?: string }) => (did.push(`stop ${r.op} ${r.target} ${r.reason} ${r.state}`), { ok: true as const, stop: r as never }),
      abort: async () => (did.push("abort"), task as never),
    };
    return { did, task, tasks: tasks as never, db: { getTask: () => task as never } };
  };

  test("a Task between turns stops now: what it planned is dropped and a stop that waits for the person is recorded — nothing else is decided", async () => {
    const w = watched("done");
    await stopForLostLease(w, "t1", { pbi: 7, why: "taken" });
    expect(w.did).toEqual(["stop pbi-lease #7 decision waiting", "abort"]);
  });

  test("a Task whose turn runs is told, and stops when that turn ends — once", async () => {
    const w = watched("running");
    await stopForLostLease(w, "t1", { pbi: 7, why: "expired" });
    await stopForLostLease(w, "t1", { pbi: 7, why: "expired" }); // the next round finds it lost still
    expect(w.did).toHaveLength(1);
    expect(w.did[0]).toContain("このターンが終わったら止めます");
    await leaseTurnEnded(w, "t-other");
    expect(w.did).toHaveLength(1);
    await leaseTurnEnded(w, "t1");
    expect(w.did.slice(1)).toEqual(["stop pbi-lease #7 decision waiting", "abort"]);
    await leaseTurnEnded(w, "t1");
    expect(w.did).toHaveLength(3);
  });
});
