import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countDockerClients, createDockerdIdle, DockerdIdle, readDockerdState, sigtermDockerd, type DockerdState } from "./dockerd-idle.ts";

const MIN = 60_000;
const idleState: DockerdState = { unit: "active", mainPid: 4242, containers: 0, clients: 0 };

function setup(initial: DockerdState = idleState) {
  let now = 1_000_000;
  let state = initial;
  const stopped: number[] = [];
  const d = new DockerdIdle(async () => state, (pid) => stopped.push(pid), { holdMs: 10 * MIN, now: () => now });
  return {
    d,
    stopped,
    set: (s: Partial<DockerdState>) => { state = { ...state, ...s }; },
    at: async (min: number) => { now = 1_000_000 + min * MIN; await d.tick(); },
  };
}

describe("dockerd-idle", () => {
  test("stops dockerd after the hold when nothing uses it", async () => {
    const t = setup();
    await t.at(0);
    await t.at(9);
    expect(t.stopped).toEqual([]);
    await t.at(10);
    expect(t.stopped).toEqual([4242]);
    await t.at(11); // the count restarts after a stop
    expect(t.stopped).toEqual([4242]);
  });

  test("keeps dockerd while a container runs", async () => {
    const t = setup({ ...idleState, containers: 1 });
    await t.at(0);
    await t.at(60);
    expect(t.stopped).toEqual([]);
  });

  test("keeps dockerd while a docker client runs", async () => {
    const t = setup({ ...idleState, clients: 1 });
    await t.at(0);
    await t.at(60);
    expect(t.stopped).toEqual([]);
  });

  test("starts the hold again after activity", async () => {
    const t = setup();
    await t.at(0);
    await t.at(8);
    t.set({ clients: 1 });
    await t.at(9);
    t.set({ clients: 0 });
    await t.at(10);
    await t.at(18); // 8 minutes after the activity ended
    expect(t.stopped).toEqual([]);
    await t.at(20);
    expect(t.stopped).toEqual([4242]);
  });

  test("does nothing without sb-dockerd", async () => {
    const t = setup({ unit: "none", mainPid: null, containers: 0, clients: 0 });
    await t.at(0);
    await t.at(60);
    t.set({ unit: "inactive" });
    await t.at(120);
    expect(t.stopped).toEqual([]);
  });

  test("does not stop when the socket does not answer", async () => {
    const home = mkdtempSync(join(tmpdir(), "switchboard.dockerd-idle."));
    try {
      // a systemctl that says active, with no socket under home: the read must say "in use"
      const bin = join(home, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nprintf 'MainPID=%s\\nLoadState=loaded\\nActiveState=active\\n' $$\n", { mode: 0o755 });
      const s = await readDockerdState(home, join(bin, "systemctl"));
      expect(s.unit).toBe("active");
      expect(s.containers).toBeGreaterThan(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("logs one line when it stops", () => {
    const log = spyOn(console, "log").mockImplementation(() => undefined);
    const kill = spyOn(process, "kill").mockImplementation(() => true);
    try {
      sigtermDockerd(10 * MIN)(77);
      expect(kill).toHaveBeenCalledWith(77, "SIGTERM");
      expect(log.mock.calls).toEqual([["dockerd-idle: no container and no docker client for 10 minutes; stopped sb-dockerd (pid 77)"]]);
    } finally {
      log.mockRestore();
      kill.mockRestore();
    }
  });

  test("does nothing on a candidate", () => {
    let called = 0;
    const read = async () => { called++; return idleState; };
    expect(createDockerdIdle({ candidate: true, dockerdIdleMs: MIN }, "/nonexistent", read)).toBeNull();
    expect(called).toBe(0);
    expect(createDockerdIdle({ candidate: false, dockerdIdleMs: MIN }, "/nonexistent", read)).toBeInstanceOf(DockerdIdle);
  });

  test("counts only processes whose comm is exactly docker", () => {
    const proc = mkdtempSync(join(tmpdir(), "switchboard.dockerd-idle."));
    try {
      for (const [pid, comm] of [["1", "docker"], ["2", "dockerd"], ["3", "docker-compose"], ["4", "docker"]]) {
        mkdirSync(join(proc, pid!));
        writeFileSync(join(proc, pid!, "comm"), `${comm}\n`);
      }
      mkdirSync(join(proc, "self"));
      expect(countDockerClients(proc)).toBe(2);
    } finally {
      rmSync(proc, { recursive: true, force: true });
    }
  });
});
