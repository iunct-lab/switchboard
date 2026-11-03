// test-reads: scripts/check-host-security.ts scripts/host-updates.ts scripts/host-pins.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Deps, isoWeek, main, urgentRequest } from "./check-host-security";
import { alreadyFiled, type Filed } from "./file-request";
import type { Outdated } from "./host-pins";
import { type Advisory, HostUpdatesUnreadable } from "./host-updates";

const CLEAN_KERNEL = { pending: false, why: "動いている 1 が最新" };
const REBOOT = { pending: true, why: "動いている 1 < インストール済み 2" };
const important: Advisory = { id: "ALAS2023-2026-3350", severity: "Important", pkg: "openssl-3.2.2-1.amzn2023.aarch64" };
const medium: Advisory = { id: "ALAS2023-2026-3400", severity: "Medium", pkg: "curl-8.1-1.amzn2023.aarch64" };
const nodeSecurity: Outdated = { name: "NODE_VERSION", pinned: "24.22.1", latest: "24.23.0", security: true };
const uvBehind: Outdated = { name: "UV_VERSION", pinned: "0.12.19", latest: "0.13.6" };

function deps(s: { advisories?: Advisory[]; kernel?: typeof CLEAN_KERNEL; pins?: Outdated[]; now?: string } = {}) {
  const lines: string[] = [];
  const filed: { title: string; body: string }[] = [];
  const d: Deps = {
    readHostUpdates: async () => ({ advisories: s.advisories ?? [], kernel: s.kernel ?? CLEAN_KERNEL }),
    readPins: async () => s.pins ?? [],
    // a stand-in with fileRequest's rule: an open request with the same title is not filed again
    fileRequest: async (req): Promise<Filed> => {
      const open = alreadyFiled(req.title, filed.map((f, i) => ({ ref: `#${i + 1}`, title: f.title })));
      if (open) return { open };
      filed.push(req);
      return { filed: filed.length };
    },
    now: () => new Date(s.now ?? "2026-11-02T01:00:00Z"),
    log: (l) => lines.push(l),
  };
  return { d, lines, filed };
}

describe("main", () => {
  test("nothing pending: one line with the counts, nothing filed, exit 0", async () => {
    const { d, lines, filed } = deps();
    expect(await main(["--file-request"], d)).toBe(0);
    expect(lines).toEqual(["異常なし（更新 0 / 再起動待ち なし / 固定版の遅れ 0）"]);
    expect(filed).toEqual([]);
  });

  test("an Important update: one urgent request naming the advisory, the package and the severity, exit 1", async () => {
    const { d, lines, filed } = deps({ advisories: [important] });
    expect(await main(["--file-request"], d)).toBe(1);
    expect(lines[0]).toBe("updates: Critical 0 / Important 1 / Medium 0 / Low 0");
    expect(lines[1]).toBe("kernel: 最新");
    expect(filed.map((f) => f.title)).toEqual(["ホストの更新待ち: ALAS2023-2026-3350"]);
    expect(filed[0]!.body).toContain("- ALAS2023-2026-3350 Important openssl-3.2.2-1.amzn2023.aarch64");
    expect(filed[0]!.body).toContain("## 要望");
    expect(filed[0]!.body).toContain("## 出典\n- 誰の言葉: 定期の検査");
    expect(lines.at(-1)).toContain("要望: 起票 #1");
  });

  test("only a pending reboot", async () => {
    const { d, lines, filed } = deps({ kernel: REBOOT });
    expect(await main(["--file-request"], d)).toBe(1);
    expect(lines[1]).toBe(`kernel: 再起動待ち（${REBOOT.why}）`);
    expect(filed.map((f) => f.title)).toEqual(["ホストの更新待ち: 再起動待ち"]);
    expect(filed[0]!.body).toContain(REBOOT.why);
  });

  test("an update Amazon's severity could not be read for is urgent", async () => {
    const { d, lines, filed } = deps({ advisories: [{ id: "a line dnf changed", severity: "unknown", pkg: "" }] });
    expect(await main(["--file-request"], d)).toBe(1);
    expect(lines[0]).toEndWith("/ unknown 1");
    expect(filed.map((f) => f.title)).toEqual(["ホストの更新待ち: a line dnf changed"]);
  });

  test("Medium only: the week's title; the same week files once, the next week again", async () => {
    const { d, lines, filed } = deps({ advisories: [medium] });
    expect(await main(["--file-request"], d)).toBe(1);
    expect(await main(["--file-request"], d)).toBe(1);
    expect(filed.map((f) => f.title)).toEqual(["ホストの Medium 以下の更新（2026-W45）"]);
    expect(lines.at(-1)).toContain("要望: 既存 #1（起票しない）");
    d.now = () => new Date("2026-11-09T01:00:00Z");
    await main(["--file-request"], d);
    expect(filed.map((f) => f.title)).toEqual(["ホストの Medium 以下の更新（2026-W45）", "ホストの Medium 以下の更新（2026-W46）"]);
  });

  test("the same urgent state files once", async () => {
    const { d, filed } = deps({ advisories: [important], kernel: REBOOT });
    await main(["--file-request"], d);
    await main(["--file-request"], d);
    expect(filed.length).toBe(1);
  });

  test.each(["readHostUpdates", "readPins"] as const)("%s failing: exit 2, nothing filed, never 異常なし", async (key) => {
    const { d, lines, filed } = deps({ advisories: [important] });
    d[key] = async () => {
      throw new HostUpdatesUnreadable("dnf updateinfo exit 1");
    };
    expect(await main(["--file-request"], d)).toBe(2);
    expect(lines).toEqual(["判定できない（dnf updateinfo exit 1）"]);
    expect(lines.join()).not.toContain("異常なし");
    expect(filed).toEqual([]);
  });

  test("both reads failing: both reasons on the one line", async () => {
    const { d, lines } = deps();
    d.readHostUpdates = async () => {
      throw new Error("dnf updateinfo exit 1");
    };
    d.readPins = async () => {
      throw new Error("UV_VERSION: 403");
    };
    expect(await main([], d)).toBe(2);
    expect(lines).toEqual(["判定できない（dnf updateinfo exit 1 / UV_VERSION: 403）"]);
  });

  test("filed with no number points at the output above", async () => {
    const { d, lines } = deps({ advisories: [important] });
    d.fileRequest = async () => ({ filed: null });
    await main(["--file-request"], d);
    expect(lines.at(-1)).toContain("要望: 起票 （番号は上の出力）");
  });

  test("a security pin goes to the urgent request, another pin to the week's", async () => {
    const { d, lines, filed } = deps({ pins: [nodeSecurity, uvBehind] });
    expect(await main(["--file-request"], d)).toBe(1);
    expect(lines).toContain("pins: NODE_VERSION 24.22.1 → 24.23.0（security）");
    expect(lines).toContain("pins: UV_VERSION 0.12.19 → 0.13.6");
    expect(filed.map((f) => f.title)).toEqual(["ホストの更新待ち: NODE_VERSION", "ホストの Medium 以下の更新（2026-W45）"]);
    expect(filed[1]!.body).toContain("- UV_VERSION 0.12.19 → 0.13.6");
    expect(filed[1]!.body).not.toContain("NODE_VERSION");
  });

  test("without --file-request: the same exit code and nothing filed", async () => {
    const { d, filed } = deps({ advisories: [important] });
    expect(await main([], d)).toBe(1);
    expect(filed).toEqual([]);
  });

  test("filing failing keeps the exit code and says so", async () => {
    const { d, lines } = deps({ advisories: [important] });
    d.fileRequest = async () => {
      throw new Error("boom");
    };
    expect(await main(["--file-request"], d)).toBe(1);
    expect(lines.at(-1)).toBe("要望: 起票できなかった（boom）");
  });
});

describe("urgentRequest", () => {
  test("the title lists the ids in order, each once", () => {
    const a = [{ ...important, id: "ALAS2023-2026-9" }, { ...important, id: "ALAS2023-2026-1" }, { ...important, id: "ALAS2023-2026-1", pkg: "other" }];
    expect(urgentRequest({ advisories: a, kernel: REBOOT, pins: [nodeSecurity] }, "2026-11-02")!.title).toBe("ホストの更新待ち: ALAS2023-2026-1,ALAS2023-2026-9 / 再起動待ち / NODE_VERSION");
  });
  test("a very long title fits GitHub's limit and stays the same", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...important, id: `ALAS2023-2026-${1000 + i}` }));
    const state = { advisories: many, kernel: CLEAN_KERNEL, pins: [] };
    const t = urgentRequest(state, "2026-11-02")!.title;
    expect(t.length).toBeLessThanOrEqual(256);
    expect(urgentRequest(state, "2026-11-03")!.title).toBe(t);
  });
});

describe("isoWeek", () => {
  test.each([
    ["2026-11-02T00:00:00Z", "2026-W45"],
    ["2026-11-08T23:59:59Z", "2026-W45"],
    ["2026-11-09T00:00:00Z", "2026-W46"],
    ["2026-12-31T12:00:00Z", "2026-W53"],
    ["2027-01-03T12:00:00Z", "2026-W53"],
    ["2025-12-29T12:00:00Z", "2026-W01"],
  ])("%s", (at, want) => expect(isoWeek(new Date(at))).toBe(want));
});

test("the entry only reads: no root, no reboot, no package change", () => {
  const sources = ["check-host-security.ts", "host-updates.ts", "host-pins.ts"].map((f) => readFileSync(join(import.meta.dir, f), "utf8")).join("\n");
  for (const word of [/\bsudo\b/, /"reboot"/, /"shutdown"/, /"upgrade"/, /"install"/, /"remove"/, /\/api\/promote/, /writeFile/]) expect(sources).not.toMatch(word);
});
