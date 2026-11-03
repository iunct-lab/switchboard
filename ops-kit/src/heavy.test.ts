// test-reads: ops-kit/bin/ ops-kit/src/cli.ts
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { heavyConfig, heavyConfigPath, heavyStateDir, withHeavySlot } from "./heavy.ts";

const OPS_KIT = join(import.meta.dir, "..", "bin", "ops-kit");

const scratch = async (fn: (home: string) => Promise<void>) => {
  const home = mkdtempSync(join(tmpdir(), "ops-kit-heavy-"));
  try {
    await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

const configure = (home: string, cfg: object) => {
  mkdirSync(dirname(heavyConfigPath(home)), { recursive: true });
  writeFileSync(heavyConfigPath(home), JSON.stringify(cfg));
};

type Span = { start: number; end: number };
const job = (spans: Span[], ms: number) => async () => {
  const span = { start: performance.now(), end: 0 };
  await Bun.sleep(ms);
  span.end = performance.now();
  spans.push(span);
};
const overlap = ([a, b]: Span[]) => a!.start < b!.end && b!.start < a!.end;

const slotHeld = async (home: string) => {
  for (let i = 0; i < 250; i++) {
    if (existsSync(heavyStateDir(home)) && readdirSync(heavyStateDir(home)).some((f) => f.startsWith("slot-"))) return;
    await Bun.sleep(20);
  }
  throw new Error("no slot taken");
};

test("heavy: with no config one runs at a time, with max 2 two run together", async () => {
  await scratch(async (home) => {
    const o = { home, mem: () => undefined, pollMs: 10, log: () => {} };
    const one: Span[] = [];
    await Promise.all([withHeavySlot("a", job(one, 80), o), withHeavySlot("b", job(one, 80), o)]);
    expect(overlap(one)).toBe(false);

    configure(home, { max: 2 });
    const two: Span[] = [];
    await Promise.all([withHeavySlot("a", job(two, 80), o), withHeavySlot("b", job(two, 80), o)]);
    expect(overlap(two)).toBe(true);
    expect(readdirSync(heavyStateDir(home))).toEqual([]);
  });
});

test("heavy: the second waits, says who holds the slot, and starts when the first ends", async () => {
  await scratch(async (home) => {
    const lines: string[] = [];
    const o = { home, mem: () => undefined, pollMs: 10, log: (l: string) => lines.push(l) };
    const spans: Span[] = [];
    let firstEnd = 0;
    const first = withHeavySlot("local-ci first", async () => {
      await job(spans, 100)();
      firstEnd = performance.now();
    }, o);
    await slotHeld(home);
    let secondStart = 0;
    await Promise.all([first, withHeavySlot("second", async () => {
      secondStart = performance.now();
    }, o)]);
    expect(secondStart).toBeGreaterThanOrEqual(firstEnd);
    const waiting = lines.filter((l) => l.startsWith("heavy: 待っています"));
    expect(waiting).toHaveLength(1); // once per reason, not once per poll
    expect(waiting[0]).toContain("枠 1/1: local-ci first");
    expect(waiting[0]).toContain(process.cwd());
    expect(lines).toContain("heavy: 始めます（second）");
  });
});

test("heavy: a holder killed with SIGKILL does not keep its slot", async () => {
  await scratch(async (home) => {
    configure(home, { minFreeMb: 0 });
    const holder = Bun.spawn([OPS_KIT, "heavy", "--", "sleep", "30"], { env: { ...process.env, HOME: home }, detached: true, stdio: ["ignore", "ignore", "ignore"] });
    await slotHeld(home);
    process.kill(-holder.pid, "SIGKILL"); // the wrapper and its sleep
    await holder.exited;
    let ran = false;
    const lines: string[] = [];
    await withHeavySlot("next", async () => {
      ran = true;
    }, { home, mem: () => undefined, pollMs: 10, log: (l) => lines.push(l) });
    expect(ran).toBe(true);
    expect(lines).toEqual([]); // the dead holder's slot was taken at once
  });
});

test("heavy: below the free-memory floor it waits and says so, above it starts", async () => {
  await scratch(async (home) => {
    const lines: string[] = [];
    let free = 1000;
    const falling = setInterval(() => (free -= 1), 5); // the number moves on every read, the reason does not
    setTimeout(() => {
      clearInterval(falling);
      free = 2000;
    }, 80);
    const t0 = performance.now();
    let started = 0;
    await withHeavySlot("low", async () => {
      started = performance.now() - t0;
    }, { home, mem: () => free, pollMs: 10, log: (l) => lines.push(l) });
    expect(started).toBeGreaterThanOrEqual(70);
    expect(lines[0]).toBe("heavy: 待っています（空きメモリ 1000 MB < 下限 1536 MB）");
    expect(lines.filter((l) => l.startsWith("heavy: 待っています"))).toHaveLength(1);

    // where MemAvailable cannot be read, the number of slots alone decides
    const none: string[] = [];
    await withHeavySlot("unknown", async () => {}, { home, mem: () => undefined, pollMs: 10, log: (l) => none.push(l) });
    expect(none).toEqual([]);
  });
});

test("heavy: two different working directories share the machine's slots", async () => {
  await scratch(async (home) => {
    configure(home, { minFreeMb: 0 });
    const env = { ...process.env, HOME: home };
    const cwdA = join(home, "repo-a");
    const cwdB = join(home, "repo-b");
    mkdirSync(cwdA);
    mkdirSync(cwdB);
    const a = Bun.spawn([OPS_KIT, "heavy", "--name", "one", "--", "sleep", "1"], { cwd: cwdA, env, stdio: ["ignore", "pipe", "pipe"] });
    await slotHeld(home);
    const b = Bun.spawn([OPS_KIT, "heavy", "--", "echo", "ok"], { cwd: cwdB, env, stdio: ["ignore", "pipe", "pipe"] });
    let aEnd = 0;
    let bEnd = 0;
    await Promise.all([a.exited.then(() => (aEnd = performance.now())), b.exited.then(() => (bEnd = performance.now()))]);
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(0);
    expect(bEnd).toBeGreaterThanOrEqual(aEnd);
    expect(await new Response(b.stdout).text()).toBe("ok\n");
    const err = await new Response(b.stderr).text();
    expect(err).toContain(`枠 1/1: one ${cwdA}`);
    expect(err).toContain("heavy: 始めます（echo ok）");
  });
});

test("heavy: an invalid config stops with an error", async () => {
  await scratch(async (home) => {
    expect(heavyConfig(home)).toEqual({ max: 1, minFreeMb: 1536 });
    for (const bad of [{ max: 0 }, { max: 1.5 }, { max: "2" }, { minFreeMb: -1 }, [2]]) {
      configure(home, bad);
      expect(() => heavyConfig(home)).toThrow(heavyConfigPath(home));
    }
    writeFileSync(heavyConfigPath(home), "{ max: 2");
    expect(() => heavyConfig(home)).toThrow("JSON として読めません");
    let ran = false;
    await expect(withHeavySlot("x", async () => (ran = true), { home })).rejects.toThrow("JSON");
    expect(ran).toBe(false);

    const cli = Bun.spawnSync([OPS_KIT, "heavy", "--", "echo", "ok"], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    expect(cli.exitCode).toBe(2);
    expect(cli.stdout.toString()).toBe("");
    expect(cli.stderr.toString()).toContain("JSON として読めません");
  });
});

test("heavy: where the slots' directory cannot be written it says so and runs without a slot", async () => {
  await scratch(async (home) => {
    mkdirSync(join(home, ".local", "state", "ops-kit"), { recursive: true });
    writeFileSync(heavyStateDir(home), "not a directory");
    const lines: string[] = [];
    let ran = false;
    await withHeavySlot("x", async () => (ran = true), { home, mem: () => undefined, log: (l) => lines.push(l) });
    expect(ran).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("枠を取らずに動かします");
  });
});

test("heavy: a slot file that cannot be read as a holder does not keep its slot", async () => {
  await scratch(async (home) => {
    mkdirSync(heavyStateDir(home), { recursive: true });
    writeFileSync(join(heavyStateDir(home), "slot-0.json"), ""); // left empty by a host stop, or edited by hand
    const lines: string[] = [];
    let ran = false;
    await withHeavySlot("next", async () => {
      ran = true;
    }, { home, mem: () => undefined, pollMs: 10, log: (l) => lines.push(l) });
    expect(ran).toBe(true);
    expect(lines).toEqual([]);
  });
});

test("heavy: a stopped wrapper stops its command, gives the slot back and ends by the same signal", async () => {
  await scratch(async (home) => {
    configure(home, { minFreeMb: 0 });
    const holder = Bun.spawn([OPS_KIT, "heavy", "--", "sleep", "30"], { env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "ignore"] });
    await slotHeld(home);
    // the command has started (the wrapper passes signals on from then; one before it ends the wrapper with the slot left
    // to the next waiter, as a SIGKILL does)
    for (let i = 0; i < 250 && !Bun.spawnSync(["pgrep", "-P", String(holder.pid), "-x", "sleep"]).success; i++) await Bun.sleep(20);
    const t0 = performance.now();
    holder.kill("SIGTERM");
    await holder.exited;
    expect(holder.signalCode).toBe("SIGTERM");
    expect(performance.now() - t0).toBeLessThan(5000); // the sleep was stopped, not waited for
    expect(readdirSync(heavyStateDir(home))).toEqual([]);
  });
});
