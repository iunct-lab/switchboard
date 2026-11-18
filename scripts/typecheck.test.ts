// test-reads: none
import { describe, expect, test } from "bun:test";
import { runTypecheck, type TypecheckDeps } from "./typecheck";
import { reusedLine, type OffloadRecord } from "./offload-record";

const rig = (o: { code?: number; output?: string; offload?: boolean; hostCode?: number } = {}) => {
  const st = { host: [] as string[][], scripts: [] as string[], logs: [] as string[], slots: [] as string[] };
  const deps: TypecheckDeps = {
    spawnHost: async (cmd) => (st.host.push(cmd), o.hostCode ?? 0),
    slot: async (name, fn) => (st.slots.push(name), await fn()),
    log: (l) => st.logs.push(l),
    ...(o.offload === false
      ? {}
      : {
          offload: {
            start: async (script) => (st.scripts.push(script), { build: "b1" }),
            collect: async () => ({ code: o.code ?? 0, output: o.output ?? "sb-step: 0 begin 1\nsb-step: 0 exit 0 2\n" }),
          },
        }),
  };
  return { st, deps };
};

describe("runTypecheck", () => {
  test("a passing build exits 0, runs bun run typecheck in one build, and takes no slot and runs nothing on the host", async () => {
    const { st, deps } = rig();
    expect(await runTypecheck(deps)).toBe(0);
    expect(st.scripts).toHaveLength(1);
    expect(st.scripts[0]).toContain("bash -e -c 'bun run typecheck'; c=$?");
    expect(st.slots).toEqual([]);
    expect(st.host).toEqual([]);
    expect(st.logs.join("\n")).toContain("外で通った");
  });

  test("the recordings are not sent: the type check does not read them", async () => {
    const { st, deps } = rig();
    const opts: unknown[] = [];
    deps.offload = { ...deps.offload!, fixtures: { dir: "/fixtures", required: true }, start: async (script, _cwd, o) => (st.scripts.push(script), opts.push(o), { build: "b1" }) };
    expect(await runTypecheck(deps)).toBe(0);
    expect(opts[0]).not.toHaveProperty("fixtures");
    expect(st.scripts[0]).not.toContain("SWITCHBOARD_FIXTURES");
  });

  test("a failing build exits with its code and keeps tsc's lines in the output", async () => {
    const { st, deps } = rig({ code: 2, output: "sb-step: 0 begin 1\npackages/core/src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsb-step: 0 exit 2 2\n" });
    expect(await runTypecheck(deps)).toBe(2);
    expect(st.logs.join("\n")).toContain("error TS2322");
    expect(st.logs.join("\n")).not.toContain("外で通った");
    expect(st.host).toEqual([]);
  });

  test("a timed-out build fails with its reason and the host does not rerun it", async () => {
    const { st, deps } = rig({ code: 124, output: "sb-step: 0 begin 1\n" });
    expect(await runTypecheck(deps)).toBe(124);
    expect(st.logs.join("\n")).toContain("sb-offload: exit 124（時間切れ）");
    expect(st.host).toEqual([]);
    expect(st.slots).toEqual([]);
  });

  test("a build that cannot be started fails with its message and the host does not rerun it", async () => {
    const { st, deps } = rig();
    deps.offload!.start = async () => {
      throw new Error("no build");
    };
    expect(await runTypecheck(deps)).toBe(1);
    expect(st.logs.join("\n")).toContain("sb-offload: no build");
    expect(st.host).toEqual([]);
  });

  test("reuse: the same work tree starts no build and hands back the earlier build's result and code with one line; --force and a build that did not reach its end start a new one", async () => {
    const rows: OffloadRecord[] = [];
    const log = { append: (r: OffloadRecord) => void rows.push(r), read: (since: number) => rows.filter((r) => Date.parse(r.at) >= since) };
    const DONE = "sb-step: 0 begin 1\na.ts(3,5): error TS2322: no\nsb-step: 0 exit 2 2\nsb-offload: exit 2\n";
    const collected: string[] = [];
    const logged = (o: { reuseHours?: number; output?: string; code?: number }) => {
      const { st, deps } = rig();
      deps.offload = { ...deps.offload!, log, collect: async (b) => (collected.push(b), { code: o.code ?? 2, output: o.output ?? DONE }) };
      return { st, deps: { ...deps, ...(o.reuseHours === undefined ? {} : { reuseHours: o.reuseHours }) } };
    };
    const first = logged({ reuseHours: 24 });
    expect(await runTypecheck(first.deps)).toBe(2);
    expect(first.st.scripts).toHaveLength(1);
    expect(rows.map((r) => [r.caller, r.kind, r.build])).toEqual([["typecheck", "ci", "b1"]]);
    const again = logged({ reuseHours: 24 });
    expect(await runTypecheck(again.deps)).toBe(2);
    expect(again.st.scripts).toEqual([]);
    expect(collected.at(-1)).toBe("b1");
    expect(again.st.logs).toContain(reusedLine({ build: "b1", at: rows[0]!.at }));
    expect(again.st.logs.join("\n")).toContain("error TS2322");
    // --force: main passes no width
    const forced = logged({});
    expect(await runTypecheck(forced.deps)).toBe(2);
    expect(forced.st.scripts).toHaveLength(1);
    // every earlier build of this input timed out (no exit line): a new build
    const cut = logged({ reuseHours: 24, code: 124, output: "sb-step: 0 begin 1\n" });
    expect(await runTypecheck(cut.deps)).toBe(124);
    expect(cut.st.scripts).toHaveLength(1);
  });

  test("without a build (or with --local) the host's bun run typecheck runs inside the slot and its code is returned", async () => {
    const { st, deps } = rig({ offload: false, hostCode: 3 });
    expect(await runTypecheck(deps)).toBe(3);
    expect(st.host).toEqual([["bun", "run", "typecheck"]]);
    expect(st.slots).toEqual(["typecheck"]);
  });
});
