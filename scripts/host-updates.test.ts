// test-reads: scripts/fixtures/host-updates/updateinfo.txt scripts/fixtures/host-updates/check-update.txt
// Fixtures: real output of this host (2026-11-02). It had no pending security update that day, so updateinfo.txt is rows of `updateinfo list --security --all` without that listing's `i ` column.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { availableVersions, compareRpm, HostUpdatesUnreadable, hostRun, kernelState, parseUpdateinfo, readHostUpdates, type Run } from "./host-updates";

const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", "host-updates", name), "utf8");
const RUNNING = "6.18.56-125.164.amzn2023.aarch64";
const NEWER = "6.18.60-130.170.amzn2023";

/** A host: what each command prints, by its name in the command line. */
function host(over: Partial<Record<"updateinfo" | "check-update" | "uname" | "rpm", { out: string; code: number }>> = {}): { run: Run; cmds: string[][] } {
  const cmds: string[][] = [];
  const run: Run = async (cmd) => {
    cmds.push(cmd);
    const key = cmd.includes("updateinfo") ? "updateinfo" : cmd.includes("check-update") ? "check-update" : cmd[0] === "uname" ? "uname" : "rpm";
    return over[key] ?? { updateinfo: { out: "", code: 0 }, "check-update": { out: "", code: 0 }, uname: { out: `${RUNNING}\n`, code: 0 }, rpm: { out: `${RUNNING}\n`, code: 0 } }[key];
  };
  return { run, cmds };
}

describe("parseUpdateinfo", () => {
  test("lists a recorded output with Amazon's severities, /Sec. removed", () => {
    const rows = parseUpdateinfo(fixture("updateinfo.txt"));
    expect(rows.length).toBe(fixture("updateinfo.txt").trim().split("\n").length);
    expect(new Set(rows.map((r) => r.severity))).toEqual(new Set(["Critical", "Important", "Medium", "Low"]));
    for (const r of rows) {
      expect(r.id).toMatch(/^ALAS2023-\d{4}-\d+$/);
      expect(r.pkg).toMatch(/\.(aarch64|noarch)$/);
    }
  });

  test("no updates: nothing", () => {
    expect(parseUpdateinfo("")).toEqual([]);
    expect(parseUpdateinfo("\n\n")).toEqual([]);
  });

  test("what it cannot read is unknown, not dropped", () => {
    expect(parseUpdateinfo("something new from dnf here\nALAS2023-2026-1 Moderate/Sec. a-1-1.aarch64\n")).toEqual([
      { id: "something new from dnf here", severity: "unknown", pkg: "" },
      { id: "ALAS2023-2026-1", severity: "unknown", pkg: "a-1-1.aarch64" },
    ]);
  });
});

describe("compareRpm", () => {
  test.each([
    ["6.18.56-125.164.amzn2023", "6.18.60-130.170.amzn2023", -1],
    ["6.18.9-1.amzn2023", "6.18.10-1.amzn2023", -1],
    ["6.18.56-125.164.amzn2023", "6.18.56-125.164.amzn2023", 0],
    ["6.18.56-125.170.amzn2023", "6.18.56-125.164.amzn2023", 1],
    ["1.2.3", "1.2", 1],
    ["1.2a", "1.2.1", -1],
    ["1.2-3", "1.2.1-1", -1],
  ])("%s vs %s", (a, b, want) => {
    expect(compareRpm(a, b)).toBe(want);
    expect(compareRpm(b, a)).toBe(want === 0 ? 0 : -want);
  });
});

describe("kernelState", () => {
  test("older than the installed one", () => {
    const k = kernelState({ running: RUNNING, installed: `${NEWER}.aarch64` });
    expect(k.pending).toBe(true);
    expect(k.why).toContain("インストール済み");
  });
  test("older than the repository's, before it is installed", () => {
    const k = kernelState({ running: RUNNING, installed: RUNNING, available: NEWER });
    expect(k.pending).toBe(true);
    expect(k.why).toContain("リポジトリの最新");
  });
  test("the same version is not pending", () => {
    expect(kernelState({ running: RUNNING, installed: RUNNING, available: null }).pending).toBe(false);
    expect(kernelState({ running: RUNNING, installed: RUNNING, available: "0:6.18.56-125.164.amzn2023" }).pending).toBe(false);
  });
});

describe("availableVersions", () => {
  test("only the named package, from a recorded output's shape", () => {
    expect(availableVersions(`${fixture("check-update.txt")}kernel6.18.aarch64   ${NEWER}   amazonlinux\n`, "kernel6.18")).toEqual([NEWER]);
    expect(availableVersions(fixture("check-update.txt"), "kernel6.18")).toEqual([]);
    expect(availableVersions(`kernel6.18-tools.aarch64   ${NEWER}   amazonlinux\n`, "kernel6.18")).toEqual([]);
  });
});

describe("readHostUpdates", () => {
  test("lists the updates and reads the kernel", async () => {
    const { run } = host({ updateinfo: { out: fixture("updateinfo.txt"), code: 0 }, "check-update": { out: `\nkernel6.18.aarch64   ${NEWER}   amazonlinux\n`, code: 100 } });
    const r = await readHostUpdates(run);
    expect(r.advisories.length).toBeGreaterThan(0);
    expect(r.kernel.pending).toBe(true);
  });

  test("nothing pending", async () => {
    expect(await readHostUpdates(host().run)).toEqual({ advisories: [], kernel: { pending: false, why: `動いている 6.18.56-125.164.amzn2023 が最新` } });
  });

  test("the newest of several installed kernels counts", async () => {
    const { run } = host({ rpm: { out: `${RUNNING}\n${NEWER}.aarch64\n`, code: 0 } });
    expect((await readHostUpdates(run)).kernel.pending).toBe(true);
  });

  test("dnf refreshes, keeps the AL2023 repository required, and only reads", async () => {
    const { run, cmds } = host();
    await readHostUpdates(run);
    const info = cmds.find((c) => c.includes("updateinfo"))!;
    expect(info).toContain("--refresh");
    expect(info).toContain("--releasever=latest");
    expect(info).toContain("--setopt=amazonlinux.skip_if_unavailable=False");
    expect(info).toContain("--security");
    expect(info.slice(0, 4)).toEqual(["timeout", "300", "dnf", "-q"]);
    for (const word of cmds.flat()) expect(["sudo", "upgrade", "update", "install", "remove", "reboot", "-y"]).not.toContain(word);
  });

  test.each([
    ["updateinfo", 1],
    ["updateinfo", 124],
    ["check-update", 1],
    ["check-update", 124],
    ["uname", 1],
    ["rpm", 1],
  ] as const)("%s exiting %i is unreadable", async (key, code) => {
    await expect(readHostUpdates(host({ [key]: { out: "", code } }).run)).rejects.toBeInstanceOf(HostUpdatesUnreadable);
  });

  test("updateinfo exiting 100 is not a pass (only check-update means updates by it)", async () => {
    await expect(readHostUpdates(host({ updateinfo: { out: "", code: 100 } }).run)).rejects.toBeInstanceOf(HostUpdatesUnreadable);
  });

  test("check-update saying updates exist with no row it can read is unreadable, not 最新", async () => {
    await expect(readHostUpdates(host({ "check-update": { out: "kernel6.18.aarch64\n    6.18.60-130.170.amzn2023 amazonlinux\n", code: 100 } }).run)).rejects.toBeInstanceOf(HostUpdatesUnreadable);
  });

  test("output that is not a kernel version is unreadable", async () => {
    await expect(readHostUpdates(host({ uname: { out: "\n", code: 0 } }).run)).rejects.toBeInstanceOf(HostUpdatesUnreadable);
    await expect(readHostUpdates(host({ rpm: { out: "package kernel6.18 is not installed\n", code: 0 } }).run)).rejects.toBeInstanceOf(HostUpdatesUnreadable);
  });

  test("a command that cannot start is unreadable", async () => {
    await expect(
      readHostUpdates(async () => {
        throw new Error("spawn dnf ENOENT");
      }),
    ).rejects.toThrow(/ENOENT/);
    await expect(readHostUpdates(() => hostRun(["/nonexistent/dnf"]))).rejects.toBeInstanceOf(HostUpdatesUnreadable);
  });
});
