// test-reads: none
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingTestFiles, sh } from "./local-ci";
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

test("a test that reads recordings is found before it is added (untracked), so it stays on the host", async () => {
  const dir = mkdtempSync(join(tmpdir(), "switchboard.test-changed."));
  try {
    const git = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, ...a]);
    git("init", "-q");
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts/old.test.ts"), 'import { x } from "../scripts/recordings.ts";\n');
    git("add", "scripts/old.test.ts");
    writeFileSync(join(dir, "scripts/new.test.ts"), 'import { x } from "../scripts/recordings";\n');
    writeFileSync(join(dir, "scripts/plain.test.ts"), "export {};\n");
    expect((await recordingTestFiles(dir, sh)).sort()).toEqual(["scripts/new.test.ts", "scripts/old.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runTests", () => {
  const A = "packages/core/src/a.test.ts";
  const R = "packages/core/src/rec.test.ts";
  const B = "scripts/gate.test.ts";
  const rig = (o: { code?: number; output?: string; offload?: boolean; hostCode?: number; during?: () => void } = {}) => {
    const st = { inSlot: false, inSlotAtOffload: undefined as boolean | undefined, slotLeftBeforeOffloadEnd: false, host: [] as string[][], scripts: [] as string[], logs: [] as string[], names: [] as string[] };
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
      recordings: [R],
      log: (l) => st.logs.push(l),
      ...(o.offload === false
        ? {}
        : {
            offload: {
              bun: "1.2.3",
              run: async (script, _cwd, _size) => {
                st.scripts.push(script);
                st.inSlotAtOffload = st.inSlot;
                await new Promise((r) => setTimeout(r, 5)); // 枠を取るならその間にホストの手順が回って出る
                st.slotLeftBeforeOffloadEnd = !st.inSlot;
                return { code: o.code ?? 0, output: o.output ?? "sb-step: 0 begin 1\nsb-step: 0 exit 0 2\n" };
              },
            },
          }),
    };
    return { st, deps };
  };

  test("files that read no recording go off the host, a failure shows its (fail) line and exits non-zero", async () => {
    const { st, deps } = rig({ code: 1, output: "sb-step: 0 begin 1\n(fail) a > works\nsb-step: 0 exit 1 2\n" });
    expect(await runTests({ tests: [A, R, B] }, deps)).toBe(1);
    const off = st.scripts.join("\n");
    expect(off).toContain("./packages/core/src/a.test.ts");
    expect(off).toContain("./scripts/gate.test.ts");
    expect(off).not.toContain("rec.test.ts");
    // the host gets only the recording file
    const host = st.host.map((c) => c.join(" ")).join("\n");
    expect(host).toContain("rec.test.ts");
    expect(host).not.toContain("a.test.ts");
    expect(host).not.toContain("gate.test.ts");
    expect(st.logs.join("\n")).toContain("(fail) a > works");
  });

  test("a passing offload logs one line with the file count and the pass count; a failure or a missing count line is handled", async () => {
    const ok = rig({ output: "sb-step: 0 begin 1\n 12 pass\n 0 fail\nsb-step: 0 exit 0 2\n" });
    expect(await runTests({ tests: [A, R, B] }, ok.deps)).toBe(0);
    expect(ok.st.logs).toEqual(["test-changed: 外で通った（2 ファイル、12 pass）"]);
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

  test("the host's files stay here, and the offload's script carries no token or recordings' place", async () => {
    const { st, deps } = rig();
    expect(await runTests({ tests: [A, R] }, deps)).toBe(0);
    expect(st.host.at(-1)!.join(" ")).toContain("./packages/core/src/rec.test.ts");
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "SWITCHBOARD_FIXTURES"]) expect(st.scripts.join("\n")).not.toContain(name);
    // the real offload's environment: hostOffload leaves those three out (local-ci.test.ts holds the same check on it)
  });

  test("the slot is not held while the offload runs, and not taken when nothing runs on the host", async () => {
    const withHost = rig();
    await runTests({ tests: [A, R] }, withHost.deps);
    expect(withHost.st.inSlotAtOffload).toBe(false);
    expect(withHost.st.slotLeftBeforeOffloadEnd).toBe(true);
    expect(withHost.st.names).toEqual(["test-changed"]);
    const noHost = rig();
    await new Promise<void>((resolve) => {
      noHost.deps.slot = async () => {
        throw new Error("no slot expected");
      };
      noHost.deps.offload!.run = async () => (resolve(), { code: 0, output: "sb-step: 0 begin 1\nsb-step: 0 exit 0 2\n" });
      void runTests({ tests: [A] }, noHost.deps);
    });
    expect(noHost.st.host).toEqual([]);
  });

  test("a timed-out offload fails with its reason and the host does not rerun it", async () => {
    const { st, deps } = rig({ code: 124, output: "sb-step: 0 begin 1\n" });
    expect(await runTests({ tests: [A] }, deps)).toBe(124);
    expect(st.logs.join("\n")).toContain("sb-offload: exit 124（時間切れ）");
    expect(st.host).toEqual([]);
  });

  test("a full run sends everything but the recording files; the host runs those", async () => {
    const { st, deps } = rig();
    expect(await runTests({ full: "x" }, deps)).toBe(0);
    expect(st.scripts.join("\n")).toContain("--path-ignore-patterns=");
    expect(st.scripts.join("\n")).toContain("packages/core/src/rec.test.ts");
    expect(st.host.at(-1)!.join(" ")).toContain("rec.test.ts");
  });

  test("a failing host file fails the run; when every selected file reads recordings no build starts", async () => {
    const { st, deps } = rig({ hostCode: 1 });
    expect(await runTests({ tests: [R] }, deps)).toBe(1);
    expect(st.scripts).toHaveLength(0);
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
