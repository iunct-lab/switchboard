import { expect, test } from "bun:test";
import { freshSide, readSide } from "./components/Brief.tsx";

// The side panel's reads on opening a task are put in state together (one commit), not one commit per response.

const reads = (delays: Record<string, number>, fail: string[] = []) => {
  const later = <T>(k: string, v: T) => () =>
    new Promise<T>((ok, no) => setTimeout(() => (fail.includes(k) ? no(new Error(k)) : ok(v)), delays[k] ?? 0));
  return {
    fp: later("fp", { bytes: 1 } as never),
    load: later("load", { available: true, groups: [] } as never),
    evals: later("evals", { rows: [] } as never),
    checks: later("checks", { run: null, running: false, meta: false, current: true }),
    staged: later("staged", []),
  };
};

test("the same result whatever order the answers come in", async () => {
  const a = await readSide(reads({ fp: 5, load: 1, evals: 3, checks: 0, staged: 2 }));
  const b = await readSide(reads({ fp: 0, load: 4, evals: 1, checks: 5, staged: 2 }));
  expect(Object.keys(a).sort()).toEqual(["checks", "evals", "fp", "load", "staged"]);
  expect(a).toEqual(b);
});

test("a read that fails is left out and the others still show", async () => {
  const r = await readSide(reads({}, ["evals", "staged"]));
  expect(Object.keys(r).sort()).toEqual(["checks", "fp", "load"]);
  expect(await readSide(reads({}, ["fp", "load", "evals", "checks", "staged"]))).toEqual({});
});

test("an answer that a newer read of the same kind overtook is dropped; the footprint and the load always stay", () => {
  const r = { fp: { bytes: 1 } as never, load: { available: true, groups: [] } as never, evals: { rows: [] } as never, checks: { run: null, running: true, meta: false, current: true }, staged: [] };
  // checks.updated read the checks again while the batch was still waiting on the footprint: the batch's running checks are stale
  expect(Object.keys(freshSide(r, { evals: 1, checks: 1, staged: 1 }, { evals: 1, checks: 2, staged: 1 })).sort()).toEqual(["evals", "fp", "load", "staged"]);
  expect(Object.keys(freshSide(r, { evals: 1, checks: 1, staged: 1 }, { evals: 2, checks: 1, staged: 2 })).sort()).toEqual(["checks", "fp", "load"]);
  expect(freshSide(r, { evals: 1, checks: 1, staged: 1 }, { evals: 1, checks: 1, staged: 1 })).toEqual(r);
});
