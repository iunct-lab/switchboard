import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveProblem } from "./archive-status.ts";

const home = mkdtempSync(join(tmpdir(), "sb-archive-status-test-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("archiveProblem reads archive.status: failed, a running that is over 2 hours old, and an ok over 48 hours old are problems (#1201)", () => {
  const now = 1_800_000_000_000;
  const s = (hoursAgo: number) => Math.floor((now - hoursAgo * 3600_000) / 1000);
  expect(archiveProblem(home, now)).toBeNull(); // no file: a Mac or a local daemon
  const cases: Array<[string, ReturnType<typeof archiveProblem>]> = [
    [`ok ${s(1)} archive/switchboard-20261011T000000Z.tar.zst.age`, null],
    [`ok ${s(49)} archive/switchboard-20261009T000000Z.tar.zst.age`, { kind: "stale", at: s(49) * 1000 }],
    [`running ${s(1)}`, null],
    [`running ${s(3)}`, { kind: "stuck", at: s(3) * 1000 }],
    [`failed ${s(5)} 137`, { kind: "failed", at: s(5) * 1000, detail: "137" }],
    ["failed soon 1", null], // a line that does not parse never turns the screen red
    ["failed 999999999999999999999999999999999999 137", null], // nor one whose time is no date (review #1379)
    [`failed ${s(5)} nonsense`, null], // nor one whose fields do not fit its state
    [`failed ${s(5)}`, null],
    [`running ${s(3)} extra`, null],
    [`ok ${s(49)}`, null],
    ["", null],
  ];
  for (const [line, want] of cases) {
    writeFileSync(join(home, "archive.status"), `${line}\n`);
    expect([line, archiveProblem(home, now)]).toEqual([line, want]);
  }
});
