// test-reads: none
import { describe, expect, test } from "bun:test";
import { loadUplink, UPLINK_PREVIEW } from "./config.ts";
import { heldLine, LEASE_MAX_BYTES, leaseKey, PbiLeases } from "./lease.ts";
import { memoryS3 } from "./s3.ts";
import { leaseTurnEnded, stopForLostLease } from "./server/lease.ts";

const REPO = "Owner/Repo";
const TTL = 900_000;

function machines(names: string[], s3 = memoryS3()) {
  const clock = { now: 1_000_000 };
  return { s3, clock, leases: names.map((machine) => new PbiLeases(s3, { machine, ttlMs: TTL, now: () => clock.now })) };
}
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
    const held = (over: object) => ({ pbi: 7, machine: "pc1", token: "t", state: "held", expiresAt: clock.now + TTL, ...over });
    await put(leaseKey(REPO, 7), held({ pbi: 8 })); // another PBI's lease copied under this key
    await put(leaseKey(REPO, 9), held({ pbi: 9, machine: "../pc1" }));
    await put("lease/owner/repo/../other/10.json", held({ pbi: 10 }));
    await put("lease/owner/repo/011.json", held({ pbi: 11 }));
    await put(leaseKey(REPO, 12), held({ pbi: 12 }));
    const before = s3.calls;
    await ec2!.refresh();
    expect(s3.calls - before).toBe(1 + 3); // the list, and the three keys that are a lease's
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
    clock.now += TTL + 1; // the lid was closed
    const before = s3.calls;
    expect(await pc!.renewAll()).toEqual([{ repository: REPO, pbi: 7, why: "expired" }]);
    expect(s3.calls).toBe(before);
  });

  test("an end written far in the future does not keep a PBI for ever: unrenewed for one life as seen here, it is taken", async () => {
    const { leases: [ec2], clock, s3 } = machines(["instance"]);
    await s3.put(leaseKey(REPO, 7), new TextEncoder().encode(JSON.stringify({ pbi: 7, machine: "pc1", token: "t", state: "held", expiresAt: clock.now + 365 * 24 * 3600_000 })));
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
