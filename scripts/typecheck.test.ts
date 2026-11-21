// test-reads: none
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heavyConfigPath, heavyStateDir, withHeavySlot } from "../ops-kit/src/heavy";
import { runTypecheck, typecheckSlot, type TypecheckDeps } from "./typecheck";

const rig = (hostCode = 0) => {
  const st = { host: [] as string[][], slots: [] as string[], offloadStarts: 0 };
  const deps = {
    spawnHost: async (cmd: string[]) => (st.host.push(cmd), hostCode),
    slot: async (name: string, fn: () => Promise<unknown>) => (st.slots.push(name), await fn()),
    // a machine with sb-offload: any call to it is recorded and fails the run
    offload: {
      start: async () => {
        st.offloadStarts++;
        return { build: "b1" };
      },
      collect: async () => ({ code: 0, output: "" }),
    },
  } as unknown as TypecheckDeps;
  return { st, deps };
};

describe("runTypecheck", () => {
  test("a machine with sb-offload starts no build: bun run typecheck runs once on the machine and its exit code is returned", async () => {
    const ok = rig(0);
    expect(await runTypecheck(ok.deps)).toBe(0);
    expect(ok.st.offloadStarts).toBe(0);
    expect(ok.st.host).toEqual([["bun", "run", "typecheck"]]);
    expect(ok.st.slots).toEqual(["typecheck"]);
    const bad = rig(2);
    expect(await runTypecheck(bad.deps)).toBe(2);
    expect(bad.st.offloadStarts).toBe(0);
  });
});

describe("typecheckSlot", () => {
  const scratch = async (fn: (home: string) => Promise<void>) => {
    const home = mkdtempSync(join(tmpdir(), "switchboard.typecheck."));
    try {
      await fn(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  };

  test("with every heavy slot held it starts at once and takes no slot; between 512 MB and the heavy.json floor it does not wait; below 512 MB it waits for the memory", async () => {
    await scratch(async (home) => {
      mkdirSync(join(home, ".config", "ops-kit"), { recursive: true });
      writeFileSync(heavyConfigPath(home), JSON.stringify({ max: 1, minFreeMb: 1536 }));
      const held = { home, mem: () => 4000, pollMs: 10, log: () => {} };
      let release!: () => void;
      const holder = withHeavySlot("local-ci", () => new Promise<void>((r) => (release = r)), held);
      for (let i = 0; i < 250 && !readdirSync(heavyStateDir(home)).some((f) => f.startsWith("slot-")); i++) await Bun.sleep(10);
      try {
        // the only slot is held, and it runs without waiting
        const lines: string[] = [];
        let slotFiles: string[] = [];
        await typecheckSlot("typecheck", async () => {
          slotFiles = readdirSync(heavyStateDir(home)).filter((f) => f.startsWith("slot-"));
        }, { ...held, log: (l) => lines.push(l) });
        expect(lines).toEqual([]);
        expect(slotFiles).toEqual(["slot-0.json"]); // the holder's alone

        // above the typecheck floor (512 MB) but below heavy.json's (1536 MB): it starts at once
        const mid: string[] = [];
        let ran = false;
        await typecheckSlot("typecheck", async () => void (ran = true), { ...held, mem: () => 1000, log: (l) => mid.push(l) });
        expect(ran).toBe(true);
        expect(mid).toEqual([]);

        // below the typecheck floor it waits, and starts once the memory is back
        let free = 400;
        let started = false;
        const low = typecheckSlot("typecheck", async () => void (started = true), { ...held, mem: () => free });
        await Bun.sleep(60);
        expect(started).toBe(false);
        free = 4000;
        await low;
        expect(started).toBe(true);
      } finally {
        release();
        await holder;
      }
    });
  });
});
