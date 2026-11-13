// test-reads: ops-kit/bin/ ops-kit/src/cli.ts
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { heavyConfig, heavyConfigPath, heavyHistoryPath, heavyStateDir, readHeavyHistory, readHeavyState, withHeavySlot } from "./heavy.ts";

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
    expect(readdirSync(heavyStateDir(home))).toEqual(["history.jsonl"]); // the finished runs leave their lines, no slot
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

test("heavy: --memory-only starts beside a held slot, waits only for memory, takes no slot and is in the history", async () => {
  await scratch(async (home) => {
    const held = { home, mem: () => undefined, pollMs: 10, log: () => {} };
    let release!: () => void;
    const holder = withHeavySlot("local-ci 1", () => new Promise<void>((r) => (release = r)), held);
    await slotHeld(home);

    // the only slot is held: a memory-only job still starts, and leaves no slot file of its own
    let slotsWhileRunning: string[] = [];
    let stateWhileRunning: ReturnType<typeof readHeavyState> | undefined;
    const lines: string[] = [];
    await withHeavySlot("review codex", async () => {
      slotsWhileRunning = readdirSync(heavyStateDir(home)).filter((f) => f.startsWith("slot-"));
      stateWhileRunning = readHeavyState(home);
    }, { ...held, memoryOnly: true, log: (l) => lines.push(l) });
    expect(slotsWhileRunning).toEqual(["slot-0.json"]); // the holder's alone
    expect(lines).toEqual([]);
    // while it runs it is listed beside the slots, not among the holders; when it ends, the list is empty again
    expect(stateWhileRunning!.beside.map((r) => r.name)).toEqual(["review codex"]);
    expect(stateWhileRunning!.running.map((r) => r.name)).toEqual(["local-ci 1"]);
    expect(readHeavyState(home).beside).toEqual([]);
    expect(readdirSync(heavyStateDir(home)).filter((f) => f.startsWith("free-"))).toEqual([]);

    // a job waiting for a slot is not memory-only
    const slotWaiter = withHeavySlot("local-ci 2", async () => {}, held);
    for (let i = 0; i < 250 && !readHeavyState(home).waiting.length; i++) await Bun.sleep(10);
    expect(readHeavyState(home).waiting.map((w) => [w.name, w.reason, w.memoryOnly ?? false])).toEqual([["local-ci 2", "slot", false]]);

    // below the floor it waits, listed as memory, and starts once the memory is back
    let free = 1000;
    const t0 = performance.now();
    let started = 0;
    const low = withHeavySlot("review claude", async () => {
      started = performance.now() - t0;
    }, { ...held, mem: () => free, memoryOnly: true });
    for (let i = 0; i < 250 && readHeavyState(home).waiting.length < 2; i++) await Bun.sleep(10);
    expect(readHeavyState(home).waiting.map((w) => [w.name, w.reason, w.memoryOnly ?? false]).sort()).toEqual([["local-ci 2", "slot", false], ["review claude", "memory", true]]);
    expect(started).toBe(0);
    free = 2000;
    await low;
    expect(started).toBeGreaterThan(0);
    expect(readHeavyState(home).waiting.map((w) => w.name)).toEqual(["local-ci 2"]);
    expect(readHeavyState(home).running.map((r) => r.name)).toEqual(["local-ci 1"]);

    release();
    await holder;
    await slotWaiter;
    expect(readHeavyHistory(home).map((e) => e.name)).toEqual(["review codex", "review claude", "local-ci 1", "local-ci 2"]);
    expect(readdirSync(heavyStateDir(home)).filter((f) => f.startsWith("slot-"))).toEqual([]);
  });
});

test("heavy: the CLI reads --memory-only and --name in either order", async () => {
  await scratch(async (home) => {
    configure(home, { minFreeMb: 0 });
    const env = { ...process.env, HOME: home };
    const holder = Bun.spawn([OPS_KIT, "heavy", "--", "sleep", "30"], { env, stdio: ["ignore", "ignore", "ignore"] });
    try {
      await slotHeld(home);
      for (const args of [["--memory-only", "--name", "review a"], ["--name", "review b", "--memory-only"]]) {
        const run = Bun.spawn([OPS_KIT, "heavy", ...args, "--", "true"], { env, stdout: "ignore", stderr: "pipe" });
        expect(await run.exited).toBe(0);
        expect(await new Response(run.stderr).text()).toBe("");
      }
      expect(readHeavyHistory(home).map((e) => e.name)).toEqual(["review a", "review b"]);
    } finally {
      holder.kill();
      await holder.exited;
    }
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
    expect(readdirSync(heavyStateDir(home))).toEqual(["history.jsonl"]);
  });
});

const until = async (what: string, ok: () => boolean) => {
  for (let i = 0; i < 250; i++) {
    if (ok()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out: ${what}`);
};
const heavyCli = (home: string, taskId: string, name: string) =>
  Bun.spawn([OPS_KIT, "heavy", "--name", name, "--", "sleep", "30"], { env: { ...process.env, HOME: home, OPS_KIT_TASK_ID: taskId }, detached: true, stdio: ["ignore", "ignore", "ignore"] });

test("heavy: a waiter is readable with its task and reason", async () => {
  await scratch(async (home) => {
    configure(home, { minFreeMb: 0 });
    expect(readHeavyState(home)).toEqual({ config: { max: 1, minFreeMb: 0 }, running: [], beside: [], waiting: [] }); // no directory yet
    const holder = heavyCli(home, "task_a", "local-ci 1");
    await slotHeld(home);
    const waiter = heavyCli(home, "task_b", "bun test");
    try {
      await until("one running, one waiting", () => readHeavyState(home).waiting.length === 1 && readHeavyState(home).running.length === 1);
      const { running, waiting } = readHeavyState(home);
      expect(running[0]).toMatchObject({ name: "local-ci 1", taskId: "task_a" });
      expect(running[0]!.queuedAt).toBe(running[0]!.startedAt); // it did not wait
      expect(waiting[0]).toMatchObject({ name: "bun test", taskId: "task_b", reason: "slot" });

      // in this process, outside a Task: waits for memory first, then for the slot the CLI holds — the reason is rewritten.
      // The floor is raised now: the two CLIs read theirs (0, so the host's memory does not hold them) when they started
      configure(home, { minFreeMb: 1536 });
      let free = 100;
      const third = withHeavySlot("e2e", async () => {}, { home, mem: () => free, pollMs: 10, log: () => {}, taskId: null });
      await until("third waits for memory", () => readHeavyState(home).waiting.some((w) => w.name === "e2e" && w.reason === "memory"));
      const mine = readHeavyState(home).waiting.find((w) => w.name === "e2e")!;
      expect(mine.taskId).toBeNull();
      expect(readHeavyState(home).waiting.map((w) => w.name)).toEqual(["bun test", "e2e"]); // oldest first
      free = 100_000;
      await until("third waits for the slot", () => readHeavyState(home).waiting.some((w) => w.name === "e2e" && w.reason === "slot"));
      expect(readHeavyState(home).waiting.find((w) => w.name === "e2e")!.queuedAt).toBe(mine.queuedAt);
      process.kill(-holder.pid, "SIGKILL");
      process.kill(-waiter.pid, "SIGKILL");
      await third;
      expect(readdirSync(heavyStateDir(home)).filter((f) => f.startsWith(`wait-${process.pid}-`))).toEqual([]); // removed once it took the slot
    } finally {
      for (const p of [holder, waiter]) {
        try {
          process.kill(-p.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  });
});

test("heavy: a killed waiter is not listed", async () => {
  await scratch(async (home) => {
    configure(home, { minFreeMb: 0 });
    const holder = heavyCli(home, "task_a", "holder");
    await slotHeld(home);
    const waiter = heavyCli(home, "task_b", "waiter");
    try {
      await until("the waiter is listed", () => readHeavyState(home).waiting.length === 1);
      process.kill(-waiter.pid, "SIGKILL");
      await waiter.exited;
      expect(readHeavyState(home).waiting).toEqual([]);
      expect(readHeavyState(home).running.map((r) => r.name)).toEqual(["holder"]);
      expect(readdirSync(heavyStateDir(home)).some((f) => f.startsWith("wait-"))).toBe(true); // a reader removes nothing
      process.kill(-holder.pid, "SIGKILL");
      await holder.exited;
      await withHeavySlot("next", async () => {}, { home, mem: () => undefined, pollMs: 10, log: () => {} });
      expect(readdirSync(heavyStateDir(home))).toEqual(["history.jsonl"]); // the next waiter cleans the dead waiter's file up
    } finally {
      for (const p of [holder, waiter]) {
        try {
          process.kill(-p.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  });
});

// root ignores the mode bits: the place cannot be made unwritable there
test.skipIf(process.getuid?.() === 0)("heavy: where a waiter's file cannot be written it still waits, only unlisted", async () => {
  await scratch(async (home) => {
    mkdirSync(heavyStateDir(home), { recursive: true });
    chmodSync(heavyStateDir(home), 0o555); // there, but not writable (a sandboxed Task)
    try {
      const lines: string[] = [];
      let free = 1000;
      setTimeout(() => (free = 2000), 80);
      const t0 = performance.now();
      let started = 0;
      await withHeavySlot("low", async () => {
        started = performance.now() - t0;
      }, { home, mem: () => free, pollMs: 10, log: (l) => lines.push(l) });
      expect(started).toBeGreaterThanOrEqual(70); // the memory wait was kept
      expect(lines[0]).toBe("heavy: 待っています（空きメモリ 1000 MB < 下限 1536 MB）");
      expect(lines.at(-1)).toContain("枠を取らずに動かします"); // the slot itself cannot be taken there, as before
    } finally {
      chmodSync(heavyStateDir(home), 0o755);
    }
  });
});

test("heavy: a finished run is in the history", async () => {
  await scratch(async (home) => {
    const o = { home, mem: () => undefined, pollMs: 10, log: () => {}, taskId: "task_1" };
    await withHeavySlot("local-ci 3314", async () => 0, o);
    await withHeavySlot("local-ci 3320", async () => 1, o);
    await withHeavySlot("local-ci 3321", async () => ({ ok: false }), o); // local-ci's result
    await withHeavySlot("x", async () => ({ exitCode: 2 }), o);
    await withHeavySlot("void", async () => {}, o); // nothing to say: it ended well
    await withHeavySlot("tag-ci o/r", async () => [{ tag: "v1", result: "fail" }], o); // a result that says nothing of success
    await expect(withHeavySlot("thrown", async () => {
      throw new Error("x");
    }, o)).rejects.toThrow("x");
    const h = readHeavyHistory(home);
    expect(h.map((e) => [e.name, e.taskId, e.exitCode])).toEqual([
      ["local-ci 3314", "task_1", 0],
      ["local-ci 3320", "task_1", 1],
      ["local-ci 3321", "task_1", 1],
      ["x", "task_1", 2],
      ["void", "task_1", 0],
      ["tag-ci o/r", "task_1", null],
      ["thrown", "task_1", null],
    ]);
    for (const e of h) {
      expect(e.queuedAt <= e.startedAt && e.startedAt <= e.endedAt).toBe(true);
      expect(Number.isNaN(Date.parse(e.endedAt))).toBe(false);
    }
  });
});

test("heavy: the history keeps the newest 500", async () => {
  await scratch(async (home) => {
    mkdirSync(heavyStateDir(home), { recursive: true });
    const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
    const lines = Array.from({ length: 1000 }, (_, i) => JSON.stringify({ name: `old ${i}`, taskId: null, queuedAt: at(i), startedAt: at(i), endedAt: at(i), exitCode: 0 }));
    writeFileSync(heavyHistoryPath(home), `${lines.join("\n")}\nnot json\n`);
    expect(readHeavyHistory(home)).toHaveLength(500); // the broken line is skipped, the newest 500 read
    await withHeavySlot("new", async () => 0, { home, mem: () => undefined, pollMs: 10, log: () => {} }); // the 1001st entry (1002 lines)
    const kept = readFileSync(heavyHistoryPath(home), "utf8").trimEnd().split("\n");
    expect(kept).toHaveLength(500);
    expect(JSON.parse(kept.at(-1)!).name).toBe("new");
    expect(JSON.parse(kept[0]!).name).toBe("old 501");
    expect(readdirSync(heavyStateDir(home))).toEqual(["history.jsonl"]); // no draft left behind
  });
});

// a child of `ops-kit heavy` that calls withHeavySlot itself (local-ci under a wrapping `ops-kit heavy`): with one slot it
// would wait for its own parent's slot for good
const NESTED = `const { withHeavySlot } = await import(${JSON.stringify(join(import.meta.dir, "heavy.ts"))});
await withHeavySlot("inner", async () => { console.log("inner ran"); return 0; }, { pollMs: 10 });`;

test("heavy: a descendant of the holder runs in the outer slot without waiting or taking another", async () => {
  await scratch(async (home) => {
    configure(home, { minFreeMb: 0 }); // max 1
    const slots: string[][] = [];
    const watch = setInterval(() => {
      try {
        slots.push(readdirSync(heavyStateDir(home)).filter((f) => f.startsWith("slot-") || f.startsWith("wait-")));
      } catch {
        /* not there yet */
      }
    }, 5);
    try {
      for (const cmd of [
        [process.execPath, "-e", NESTED],
        // local-ci runs its steps under `env -i`: the environment is gone, the parent is not
        ["env", "-i", `HOME=${home}`, `PATH=${process.env.PATH}`, process.execPath, "-e", NESTED],
      ]) {
        const run = Bun.spawn([OPS_KIT, "heavy", "--name", "outer", "--", ...cmd], { env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
        const t0 = performance.now();
        const timer = setTimeout(() => run.kill("SIGKILL"), 15_000) // without the nesting it waits for good;
        expect(await run.exited).toBe(0);
        clearTimeout(timer);
        expect(performance.now() - t0).toBeLessThan(15_000);
        expect(await new Response(run.stdout).text()).toBe("inner ran\n");
        const err = (await new Response(run.stderr).text()).split("\n").filter(Boolean);
        expect(err).toEqual(["heavy: 枠を持つ処理の中なので、外側の枠の中で動きます（inner。外側: outer）"]);
      }
    } finally {
      clearInterval(watch);
    }
    expect(slots.every((s) => s.length <= 1 && s.every((f) => f === "slot-0.json"))).toBe(true); // one slot, no waiter
    expect(readHeavyHistory(home).map((e) => [e.name, e.exitCode])).toEqual([
      ["inner (入れ子)", 0],
      ["outer", 0],
      ["inner (入れ子)", 0],
      ["outer", 0],
    ]);
  });
}, 40_000);

test("heavy: a process that is not the holder's descendant still waits", async () => {
  await scratch(async (home) => {
    configure(home, { minFreeMb: 0 });
    const holder = heavyCli(home, "task_a", "holder");
    try {
      await slotHeld(home);
      const lines: string[] = [];
      let ran = false;
      const next = withHeavySlot("other", async () => {
        ran = true;
      }, { home, mem: () => undefined, pollMs: 10, log: (l) => lines.push(l) });
      await until("the other waits", () => lines.length > 0);
      expect(ran).toBe(false);
      expect(lines[0]).toContain("heavy: 待っています（枠 1/1: holder");
      process.kill(-holder.pid, "SIGKILL");
      await next;
      expect(ran).toBe(true);
      expect(readHeavyHistory(home).map((e) => e.name)).toEqual(["other"]);
    } finally {
      try {
        process.kill(-holder.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });
});
