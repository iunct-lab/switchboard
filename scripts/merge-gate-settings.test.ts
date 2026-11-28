// The merge gate and the settings Switchboard keeps for a workspace: only what the person confirmed counts.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepsHash } from "./local-ci";
import { heldNote, judge, type PrFacts } from "./merge-gate";
import { ciAtTips, ciOf } from "./merge-gate-records";
import type { MergeRecordJob } from "../ops-kit/src/merge-records";
import { heldSettingsOf, stepsNotConfirmed, type HeldSettings } from "./workspace-settings.ts";

const W = mkdtempSync(join(tmpdir(), "switchboard.merge-gate-settings."));
afterAll(() => rmSync(W, { recursive: true, force: true }));

const SHA = "a".repeat(40);
const BASE = "b".repeat(40);
const CONFIRMED = [{ name: "check", run: "make check" }];
const base = (over: Partial<PrFacts> = {}): PrFacts => ({
  files: [{ path: "src/a.ts", additions: 20, deletions: 5 }],
  checks: [{ name: "test", conclusion: "SUCCESS" }],
  unresolvedThreads: 0,
  mergeState: "CLEAN",
  reviewed: true,
  ...over,
});
/** A local CI pass as the app records it, with the hash of the steps it ran when they came from the settings Switchboard keeps (`JobCi.stepsHash`). */
const pass = (steps: Array<{ name: string; run: string }> | null): MergeRecordJob => ({
  id: 1, kind: "local-ci", taskId: "t", pr: 1, runner: null, status: "pass", exitCode: 0, startedAt: 1, endedAt: 2, repo: "o/r", head: SHA, base: BASE, as: null, kinds: [],
  result: { ci: { outcome: "pass", ...(steps ? { stepsHash: stepsHash(steps) } : {}) } },
});
const hashOf = (j: MergeRecordJob) => (j.result as { ci: { stepsHash?: string } }).ci.stepsHash ?? null;
const held = (over: Partial<HeldSettings> = {}): HeldSettings => ({ workspace: "lib", version: "0123456789ab", ciHash: stepsHash(CONFIRMED), pending: null, ...over });

test("what the person confirmed for a clone: read from the daemon's index by the clone's folder, never from OPS_KIT_CONFIG; a change that waits is named without its value; a clone with its own ops.config.json has none", async () => {
  const core = await import("../packages/core/src/workspace-config.ts");
  const home = join(W, "home");
  const repo = join(W, "lib");
  mkdirSync(repo);
  const text = `${JSON.stringify({ ci: { steps: CONFIRMED } }, null, 2)}\n`;
  const ws = { id: "ws_1", name: "lib", path: repo, kind: "repo" as const, createdAt: 0, backlog: "github" as const, sweep: { implement: 1, plan: 1 }, allocation: { share: null, mode: "continuing" as const }, issueArtifacts: false, config: text };
  core.writeWorkspaceConfigs(home, [ws], [{ workspaceId: "ws_1", id: 7, at: 5, keys: ["ci", "mergeGate"] }]);
  // a Task's own file with the steps it would like
  const mine = join(W, "mine.json");
  writeFileSync(mine, JSON.stringify({ ci: { steps: [{ run: "true" }] } }));
  const env = { SWITCHBOARD_HOME: home, OPS_KIT_CONFIG: mine };
  expect(heldSettingsOf(repo, env)).toEqual({ workspace: "lib", version: core.configVersion(text), ciHash: stepsHash(CONFIRMED), pending: { keys: ["ci", "mergeGate"], at: 5 } });
  expect(core.configCiHash(text)).toBe(stepsHash(CONFIRMED));
  // the first save of a workspace waits: nothing is in force, and the gate still hears of it
  const fresh = join(W, "fresh");
  mkdirSync(fresh);
  core.writeWorkspaceConfigs(home, [ws, { ...ws, id: "ws_2", name: "fresh", path: fresh, config: undefined }], [{ workspaceId: "ws_2", id: 8, at: 6, keys: ["ci"] }]);
  expect(heldSettingsOf(fresh, env)).toEqual({ workspace: "fresh", version: null, ciHash: null, pending: { keys: ["ci"], at: 6 } });
  expect(heldSettingsOf(repo, env)).toMatchObject({ pending: null });
  // nothing kept, nothing waiting: none. The clone's own file: the kept settings are not read at all
  expect(heldSettingsOf(W, env)).toBeUndefined();
  writeFileSync(join(repo, "ops.config.json"), "{}");
  expect(heldSettingsOf(repo, env)).toBeUndefined();
});

test("a local CI pass counts only when its steps are the confirmed ones: a pass run with steps `true` from another file, or with the checkout's steps while steps are confirmed, is not the CI's success", async () => {
  const forged = pass([{ name: "true", run: "true" }]);
  expect(stepsNotConfirmed(hashOf(forged), held())).toContain("利用者の確かめた設定の手順");
  expect(stepsNotConfirmed(hashOf(forged), held({ ciHash: null }))).toContain("確かめた手順は無い");
  // no settings kept at all (or the clone has its own file) and the pass names kept steps: not counted either
  expect(stepsNotConfirmed(hashOf(forged), undefined)).toContain("確かめた手順は無い");
  expect(stepsNotConfirmed(hashOf(pass(null)), held())).toContain("で回したものでない");
  expect(stepsNotConfirmed(hashOf(pass(CONFIRMED)), held())).toBeUndefined();
  expect(stepsNotConfirmed(hashOf(pass(null)), undefined)).toBeUndefined();
  expect(stepsNotConfirmed(hashOf(pass(null)), held({ ciHash: null }))).toBeUndefined();

  const of = (j: MergeRecordJob, h?: HeldSettings) => ciOf([j], 1, async () => true, async () => [], h);
  expect(await of(forged, held())).toEqual({ pass: false, note: expect.stringContaining("利用者の確かめた設定の手順") });
  expect(await of(pass(CONFIRMED), held())).toEqual({ pass: true });
  expect(ciAtTips([forged], 1, SHA, BASE, held())).toEqual({ pass: false, note: expect.stringContaining("利用者の確かめた設定の手順") });
  expect(ciAtTips([pass(CONFIRMED)], 1, SHA, BASE, held())).toEqual({ pass: true });
});

test("a PR judged while a change of the kept settings waits for the person stops with [聞く], --allow-large or not; with none waiting the judgement names the confirmed version it used", () => {
  const waiting = base({ held: held({ pending: { keys: ["ci", "mergeGate"], at: 1 } }) });
  for (const allowLarge of [false, true]) {
    const j = judge(waiting, { allowLarge });
    expect(j.verdict).toBe("stop");
    expect(j.reasons).toEqual([expect.stringMatching(/^\[聞く\] Switchboard の側の設定（workspace lib）に、利用者が確かめていない変更がある（キー: ci, mergeGate）/)]);
  }
  const j = judge(base({ held: held() }), { allowLarge: false });
  expect(j).toMatchObject({ verdict: "merge", reasons: [], notes: [heldNote(held())] });
  expect(j.notes![0]).toContain("利用者が確かめた版 0123456789ab");
  expect(judge(base(), { allowLarge: false }).notes).toBeUndefined();
});
