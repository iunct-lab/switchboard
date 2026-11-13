// test-reads: none
import { describe, expect, test } from "bun:test";
import { changedFiles, pickTests, runTests, type RunDeps } from "./test-changed";

const tree: Record<string, string> = {
  "packages/protocol/src/index.ts": "",
  "packages/protocol/src/index.test.ts": `import "./index";`,
  "packages/core/src/a.ts": `import "@switchboard/protocol"; import "../../../scripts/gate";`,
  "packages/core/src/a.test.ts": `import "./a";`,
  "packages/core/package.json": `{"name":"@switchboard/core"}`,
  "packages/protocol/package.json": `{"name":"@switchboard/protocol","main":"src/index.ts"}`,
  "scripts/gate.ts": "",
  "scripts/gate.test.ts": `import "./gate";`,
  "apps/web/src/x.ts": "",
  "apps/web/src/x.test.ts": `import "./x";`,
  "docs/design/x.md": "",
};
const pick = (...changed: string[]) => pickTests(changed, Object.keys(tree), (p) => tree[p]!);

describe("test-changed", () => {
  test("pick tests by changed paths", () => {
    // the changed package's tests and those of what imports it
    expect(pick("scripts/gate.ts")).toEqual({ tests: ["packages/core/src/a.test.ts", "scripts/gate.test.ts"] });
    expect(pick("apps/web/src/x.ts")).toEqual({ tests: ["apps/web/src/x.test.ts"] });
    // a shared type widens, and so does what the selection cannot judge
    expect(pick("packages/protocol/src/index.ts")).toEqual({ full: "packages/protocol/src/index.ts: 共有の型" });
    expect(pick(".github/workflows/ci.yml")).toEqual({ full: ".github/workflows/ci.yml: CI の手順" });
    expect(pick("scripts/gone.ts")).toEqual({ full: "scripts/gone.ts: 今のツリーに無い（消したファイルの依存は辿れない）" });
    // nothing to run: a doc no test reads, and no change (the selection alone would run everything)
    expect(pick("docs/design/x.md")).toEqual({ tests: [] });
    expect(pick()).toEqual({ tests: [] });
  });

  test("changed files: since the fork, uncommitted and untracked, once each", () => {
    const seen: string[][] = [];
    const out: Record<string, string> = { "merge-base": "fork\n", diff: "b.ts\0a.ts\0", "ls-files": "c.ts\0a.ts\0" };
    expect(changedFiles((args) => (seen.push(args), out[args[0]!]!))).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(seen[0]).toEqual(["merge-base", "HEAD", "origin/main"]);
    expect(seen[1]).toEqual(["diff", "--name-only", "--no-renames", "-z", "fork"]);
    expect(seen[2]).toEqual(["ls-files", "--others", "--exclude-standard", "-z"]);
  });
});

describe("runTests", () => {
  const A = "packages/core/src/a.test.ts";
  const R = "packages/core/src/rec.test.ts";
  const B = "scripts/gate.test.ts";
  const rig = (o: { code?: number; output?: string; offload?: boolean; hostCode?: number } = {}) => {
    const st = { inSlot: false, host: [] as string[][], scripts: [] as string[], runs: [] as Array<{ size: string; fixtures?: string; names?: string }>, logs: [] as string[], names: [] as string[] };
    const deps: RunDeps = {
      spawnHost: async (cmd) => (st.host.push(cmd), o.hostCode ?? 0),
      slot: async (name, fn) => {
        st.names.push(name);
        st.inSlot = true;
        try {
          return await fn();
        } finally {
          st.inSlot = false;
        }
      },
      log: (l) => st.logs.push(l),
      ...(o.offload === false
        ? {}
        : {
            offload: {
              fixtures: { dir: "/fixtures-dir", required: true },
              start: async (script, _cwd, run) => {
                st.scripts.push(script);
                st.runs.push(run);
                return { build: "build-1" };
              },
              collect: async () => ({ code: o.code ?? 0, output: o.output ?? "sb-step: 0 begin 1\nsb-step: 0 exit 0 2\n" }),
            },
          }),
    };
    return { st, deps };
  };

  test("every selected file, the ones that read recordings too, goes to one build; the host runs nothing and takes no slot; a failure shows its (fail) line and exits non-zero", async () => {
    const { st, deps } = rig({ code: 1, output: "sb-step: 0 begin 1\n(fail) a > works\nsb-step: 0 exit 1 2\n" });
    expect(await runTests({ tests: [A, R, B] }, deps)).toBe(1);
    expect(st.scripts).toHaveLength(1);
    const off = st.scripts[0]!;
    for (const f of [A, R, B]) expect(off).toContain(`./${f}`);
    expect(st.host).toEqual([]);
    expect(st.names).toEqual([]);
    // the build runs only bun test, no public-tree check: the host's AWS names are not sent
    expect(st.runs.map((r) => r.names)).toEqual([undefined]);
    expect(st.logs.join("\n")).toContain("(fail) a > works");
  });

  test("a passing offload logs one line with the file count and the pass count; a failure or a missing count line is handled", async () => {
    const ok = rig({ output: "sb-step: 0 begin 1\n 12 pass\n 0 fail\nsb-step: 0 exit 0 2\n" });
    expect(await runTests({ tests: [A, R, B] }, ok.deps)).toBe(0);
    expect(ok.st.logs).toEqual(["test-changed: 外で通った（3 ファイル、12 pass）"]);
    const noCount = rig();
    await runTests({ tests: [A] }, noCount.deps);
    expect(noCount.st.logs).toEqual(["test-changed: 外で通った（1 ファイル）"]);
    const bad = rig({ code: 1, output: "sb-step: 0 begin 1\n(fail) a > works\n 3 pass\nsb-step: 0 exit 1 2\n" });
    await runTests({ tests: [A] }, bad.deps);
    expect(bad.st.logs.join("\n")).not.toContain("外で");
    // a full run has no selection: the count is bun test's own `across M files`
    const full = rig({ output: "sb-step: 0 begin 1\n 40 pass\n 0 fail\nRan 40 tests across 3 files. [1.00s]\nsb-step: 0 exit 0 2\n" });
    expect(await runTests({ full: "shared" }, full.deps)).toBe(0);
    expect(full.st.logs).toEqual(["test-changed: 外で通った（3 ファイル、40 pass）"]);
    const fullNoCount = rig();
    await runTests({ full: "shared" }, fullNoCount.deps);
    expect(fullNoCount.st.logs).toEqual(["test-changed: 外で通った"]);
  });

  test("the offload's work tree gets the repository as its origin, as local-ci's does (tests that read origin)", async () => {
    const { st, deps } = rig();
    expect(await runTests({ tests: [A] }, { ...deps, repo: "o/r" })).toBe(0);
    expect(st.scripts.join("\n")).toContain("git remote add origin 'https://github.com/o/r.git'");
  });

  test("the recordings go by the call and are required, not by the script: it carries no token or recordings' place", async () => {
    const { st, deps } = rig();
    expect(await runTests({ tests: [A, R] }, deps)).toBe(0);
    expect(st.runs[0]!.fixtures).toBe("/fixtures-dir");
    expect(st.scripts[0]).toContain("export SWITCHBOARD_FIXTURES=$HOME/.switchboard/fixtures");
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "/fixtures-dir"]) expect(st.scripts.join("\n")).not.toContain(name);
    // the real offload's environment: hostOffload leaves those out (local-ci.test.ts holds the same check on it)
  });

  test("a timed-out offload fails with its reason and the host does not rerun it", async () => {
    const { st, deps } = rig({ code: 124, output: "sb-step: 0 begin 1\n" });
    expect(await runTests({ tests: [A] }, deps)).toBe(124);
    expect(st.logs.join("\n")).toContain("sb-offload: exit 124（時間切れ）");
    expect(st.host).toEqual([]);
  });

  test("a build that cannot be started fails the run with its message, and the host does not rerun it", async () => {
    const { st, deps } = rig();
    deps.offload!.start = async () => {
      throw new Error("no build");
    };
    expect(await runTests({ tests: [A] }, deps)).toBe(1);
    expect(st.logs.join("\n")).toContain("sb-offload: no build");
    expect(st.host).toEqual([]);
  });

  test("a full run is one plain bun test in the build", async () => {
    const { st, deps } = rig();
    expect(await runTests({ full: "x" }, deps)).toBe(0);
    expect(st.scripts[0]).toContain("bash -e -c 'bun test'; c=$?");
    expect(st.host).toEqual([]);
  });

  test("without sb-offload everything goes to the host's bun test, inside the slot", async () => {
    const { st, deps } = rig({ offload: false, hostCode: 3 });
    expect(await runTests({ tests: [A, R] }, deps)).toBe(3);
    expect(st.host).toEqual([["bun", "test", `./${A}`, `./${R}`]]);
    expect(st.names).toEqual(["test-changed"]);
    const full = rig({ offload: false });
    await runTests({ full: "x" }, full.deps);
    expect(full.st.host).toEqual([["bun", "test"]]);
  });
});
