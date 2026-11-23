// test-reads: none
import { describe, expect, test } from "bun:test";
import type { MergeRecordJob } from "../ops-kit/src/merge-records";
import { attackedOf, ciAtTips, ciOf, isSha, rechecksOf, reviewedOf } from "./merge-gate-records";
import { stepsHash } from "./local-ci";

const HEAD = "a".repeat(40);
const OLD = "b".repeat(40);
const BASE = "c".repeat(40);
let seq = 0;
const job = (over: Partial<MergeRecordJob> = {}): MergeRecordJob => ({ id: ++seq, kind: "review", taskId: "t", pr: 1, runner: "claude", status: "pass", exitCode: 0, startedAt: 1, endedAt: 2, repo: "o/r", head: HEAD, base: null, as: null, kinds: [], result: { review: { findings: [], firstLine: "[claude] review" } }, ...over });
const finding = (severity: string) => ({ review: { findings: [{ severity, path: "", line: 0 }], firstLine: "x" } });
const ci = (outcome: "pass" | "fail", over: Partial<MergeRecordJob> = {}, hash?: string) => job({ kind: "local-ci", runner: null, head: HEAD, base: BASE, status: outcome, result: { ci: { outcome, ...(hash ? { stepsHash: hash } : {}) } }, ...over });
/** The PR's head is HEAD; a job at OLD counts only when the PR's commits are in it (here: only when `inOld`). */
const covers = (inOld = false) => async (h: string) => h === HEAD || (inOld && h === OLD);

describe("the main review", () => {
  test("a review job that passed and left its findings, as nothing or as the fallback for a usage limit, at the head", async () => {
    expect(await reviewedOf([job()], covers())).toBe(true);
    expect(await reviewedOf([job({ as: "fallback" })], covers())).toBe(true);
    // a finding of weight does not make it no review: whether it is answered is the threads' and the person's
    expect(await reviewedOf([job({ result: finding("blocker") })], covers())).toBe(true);
  });

  test("another kind of review, a job that did not pass, one with no findings section, or one of another head is no main review", async () => {
    for (const j of [job({ as: "attack" }), job({ as: "recheck", kinds: ["size"] }), job({ as: "audit" }), job({ status: "fail" }), job({ status: "aborted" }), job({ status: "running" }), job({ result: null }), job({ result: { ci: { outcome: "pass" } } }), job({ head: null }), job({ head: OLD }), job({ kind: "local-ci" }), job({ kind: "recheck", kinds: ["migration"] })]) {
      expect([JSON.stringify(j), await reviewedOf([j], covers())]).toEqual([JSON.stringify(j), false]);
    }
    expect(await reviewedOf([], covers())).toBe(false);
  });

  test("a job of an older head counts when the PR's commits are in it (the head is asked of `covers` only when it differs)", async () => {
    expect(await reviewedOf([job({ head: OLD })], covers(true))).toBe(true);
    const asked: string[] = [];
    await reviewedOf([job()], async (h) => (asked.push(h), true));
    expect(asked).toEqual([HEAD]);
  });
});

describe("the attacking review", () => {
  test("only a review run as attack", async () => {
    expect(await attackedOf([job({ as: "attack" })], covers())).toBe(true);
    for (const j of [job(), job({ as: "fallback" }), job({ as: "attack", status: "fail" }), job({ as: "attack", result: null }), job({ as: "attack", head: OLD })]) expect(await attackedOf([j], covers())).toBe(false);
  });
});

describe("rechecks", () => {
  const asRecheck = (kinds: string[], over: Partial<MergeRecordJob> = {}) => job({ as: "recheck", kinds, ...over });
  const command = (kind: string, over: Partial<MergeRecordJob> = {}) => job({ kind: "recheck", runner: null, kinds: [kind], result: null, ...over });
  const of = async (jobs: MergeRecordJob[], inOld = false) => (await rechecksOf(jobs, HEAD, covers(inOld))).sort();

  test("a kind a review reads: a review run as recheck for it, with no blocker and no should-fix", async () => {
    expect(await of([asRecheck(["size", "responsibility"])])).toEqual(["responsibility", "size"]);
    expect(await of([asRecheck(["size"], { result: finding("nit") }), asRecheck(["design-rules"], { result: finding("question") })])).toEqual(["design-rules", "size"]);
    // a finding of weight, a path-less finding included (a weighted line whose place could not be read)
    expect(await of([asRecheck(["size"], { result: finding("blocker") })])).toEqual([]);
    expect(await of([asRecheck(["size"], { result: finding("should-fix") })])).toEqual([]);
  });

  test("a review that named no kind satisfies none; neither does a main review, a failed one, or one of another head", async () => {
    expect(await of([asRecheck([])])).toEqual([]);
    expect(await of([job({ kinds: [] }), asRecheck(["size"], { status: "fail" }), asRecheck(["size"], { result: null }), asRecheck(["size"], { head: OLD })])).toEqual([]);
    expect(await of([asRecheck(["size"], { head: OLD })], true)).toEqual(["size"]);
  });

  test("a kind a command decides: a recheck job that passed at exactly the head, whatever `covers` says of an older one", async () => {
    expect(await of([command("migration"), command("security:lockfile")])).toEqual(["migration", "security:lockfile"]);
    expect(await of([command("migration", { head: OLD })], true)).toEqual([]);
    expect(await of([command("migration", { status: "fail" }), command("security:lockfile", { status: "aborted" })])).toEqual([]);
    // a review run as recheck for a command kind is not that kind's pass
    expect(await of([asRecheck(["migration", "security:lockfile"])])).toEqual([]);
  });

  test("rescue needs both its command and a review of it", async () => {
    expect(await of([command("rescue")])).toEqual([]);
    expect(await of([asRecheck(["rescue"])])).toEqual([]);
    expect(await of([command("rescue"), asRecheck(["rescue"])])).toEqual(["rescue"]);
    expect(await of([command("rescue"), asRecheck(["rescue"], { result: finding("should-fix") })])).toEqual([]);
    expect(await of([command("rescue", { head: OLD }), asRecheck(["rescue"], { head: OLD })], true)).toEqual([]);
  });
});

describe("CI", () => {
  const top = 3;
  const ofCi = (jobs: MergeRecordJob[], inOld = false, moved: string[] = [], held?: Parameters<typeof ciOf>[4]) => ciOf(jobs, top, covers(inOld), async () => moved, held);
  const heldWith = (ciHash: string | null) => ({ workspace: "w", version: "v", ciHash, pending: null });

  test("the newest recorded run of the top, by the job's id: a fail after a pass is no pass, a pass after a fail is", async () => {
    expect(await ofCi([ci("pass", { pr: top }), ci("fail", { pr: top })])).toEqual({ pass: false, note: "一番上の PR #3 の local-ci の最新が fail" });
    expect(await ofCi([ci("fail", { pr: top }), ci("pass", { pr: top })])).toEqual({ pass: true });
    const [a, b] = [ci("pass", { pr: top }), ci("fail", { pr: top })];
    expect(await ofCi([b, a])).toEqual({ pass: false, note: "一番上の PR #3 の local-ci の最新が fail" });
  });

  test("a run with no record (no result: from a terminal, or its head or base moved before it posted) and other PRs' runs count for nothing", async () => {
    expect(await ofCi([])).toEqual({ pass: false });
    expect(await ofCi([ci("pass", { pr: top, result: null })])).toEqual({ pass: false });
    expect(await ofCi([ci("pass", { pr: top, head: null })])).toEqual({ pass: false });
    expect(await ofCi([ci("pass", { pr: 1 })])).toEqual({ pass: false });
    // a run that has not ended reads as none, however it will end
    expect(await ofCi([ci("pass", { pr: top, status: "running", result: null })])).toEqual({ pass: false });
    // a pass the app marked aborted afterwards still has its result: the result decides, not the status
    expect(await ofCi([ci("pass", { pr: top, status: "aborted" })])).toEqual({ pass: true });
  });

  test("the run's head must be the PR's or have the PR's commits as they are, and the shared files the PR touches must not have moved on the base", async () => {
    const old = ci("pass", { pr: top, head: OLD });
    expect(await ofCi([old])).toEqual({ pass: false, note: `この PR のコミットが #3 の pass（${OLD.slice(0, 7)}）に同じ差分で入っていない（一番上で回し直す）` });
    expect(await ofCi([old], true)).toEqual({ pass: true });
    expect(await ofCi([ci("pass", { pr: top })], false, ["src/server.ts"])).toEqual({ pass: false, note: `#3 の pass（${HEAD.slice(0, 7)}）の後に、この PR の触る合流ファイルが base で進んだ: src/server.ts（最新の base に合わせて一番上で回し直す）` });
  });

  test("the steps the run ran must be the ones the person confirmed", async () => {
    const steps = [{ name: "check", run: "make check" }];
    expect(await ofCi([ci("pass", { pr: top }, stepsHash(steps))], false, [], heldWith(stepsHash(steps)))).toEqual({ pass: true });
    expect((await ofCi([ci("pass", { pr: top }, stepsHash(steps))], false, [], heldWith("ffffffffffff"))).pass).toBe(false);
    expect((await ofCi([ci("pass", { pr: top })], false, [], heldWith(stepsHash(steps)))).pass).toBe(false);
    expect((await ofCi([ci("pass", { pr: top }, stepsHash(steps))])).pass).toBe(false);
  });

  test("a change or a GitLab MR: the newest run counts only for the head and the base's tip now", () => {
    const at = (jobs: MergeRecordJob[], head = HEAD, base = BASE) => ciAtTips(jobs, 7, head, base);
    expect(at([ci("pass", { pr: 7 })])).toEqual({ pass: true });
    expect(at([ci("pass", { pr: 7 })], OLD)).toEqual({ pass: false, note: `local-ci の pass（${HEAD.slice(0, 7)}）は今の head（${OLD.slice(0, 7)}）のものでない（回し直す）` });
    expect(at([ci("pass", { pr: 7 })], HEAD, OLD)).toEqual({ pass: false, note: `local-ci の pass の base（${BASE.slice(0, 7)}）が今の base の先端（${OLD.slice(0, 7)}）でない（回し直す）` });
    expect(at([ci("pass", { pr: 7 }), ci("fail", { pr: 7 })])).toEqual({ pass: false, note: "local-ci の最新が fail" });
    expect(at([ci("pass", { pr: 3 })])).toEqual({ pass: false });
  });
});

describe("a record's commit ids", () => {
  const BAD = ["--upload-pack=touch x", "abc123", "A".repeat(40), `${HEAD} `, ""];

  test("a head or base that is not 40 hex digits makes the record none, before git is asked anything", async () => {
    expect([HEAD, BASE, "g".repeat(40), ...BAD].map(isSha)).toEqual([true, true, false, ...BAD.map(() => false)]);
    const asked: string[] = [];
    const spy = async (h: string) => (asked.push(h), true);
    for (const bad of BAD) {
      expect(await ciOf([ci("pass", { pr: 3, head: bad })], 3, spy, async () => [])).toEqual({ pass: false });
      expect(await ciOf([ci("pass", { pr: 3, base: bad })], 3, spy, async () => [])).toEqual({ pass: false });
      expect(ciAtTips([ci("pass", { pr: 7, base: bad })], 7, HEAD, bad)).toEqual({ pass: false });
      expect(await reviewedOf([job({ head: bad })], spy)).toBe(false);
      expect(await attackedOf([job({ as: "attack", head: bad })], spy)).toBe(false);
      expect(await rechecksOf([job({ as: "recheck", kinds: ["size"], head: bad })], HEAD, spy)).toEqual([]);
    }
    expect(asked).toEqual([]);
  });
});
