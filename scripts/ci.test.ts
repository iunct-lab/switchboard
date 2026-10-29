import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { ciExit, ciSteps, runCi } from "./ci";
import { checkoutSteps, localCi, type Deps } from "./local-ci";

const ROOT = mkdtempSync(join(tmpdir(), "sb-ci-test-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

/** A bin dir whose bun / git / fc-list / sudo log their arguments to `log` and exit `code` when they equal `fail`; git grep finds nothing (1), as on a clean tree. */
function fakeBin(log: string, fail: string, code: number): string {
  const bin = mkdtempSync(join(ROOT, "bin."));
  const tool = (name: string, extra = "") => {
    writeFileSync(join(bin, name), `#!/bin/bash
echo "${name} $*" >> ${JSON.stringify(log)}
${extra}
[ "${name} $*" = ${JSON.stringify(fail)} ] && exit ${code}
exit 0
`);
    chmodSync(join(bin, name), 0o755);
  };
  tool("bun");
  tool("git", `[ "$1" = grep ] && exit 1\n[ "$1" = rev-parse ] && { echo false; exit 0; }`);
  tool("fc-list", "echo Noto");
  tool("sudo");
  return bin;
}

/** The commands the steps ran, one per line of the log (the fakes' own lines). */
const commands = (log: string) => readFileSync(log, "utf8").trimEnd().split("\n");

/** Actions' entry, `bun scripts/ci.ts`, with only the fakes and bash on PATH. */
async function actions(fail: string, code: number): Promise<{ exit: number; ran: string[] }> {
  const log = join(mkdtempSync(join(ROOT, "actions.")), "log");
  writeFileSync(log, "");
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "ci.ts")], { cwd: ROOT, env: { PATH: `${fakeBin(log, fail, code)}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
  const exit = await p.exited;
  return { exit, ran: commands(log) };
}

/** local-ci's run of the same checkout: its steps go through the same fakes, one `bash -e -c` each as the real `step` does. */
async function local(fail: string, code: number): Promise<{ results: Array<{ code: number }>; ran: string[] }> {
  const log = join(mkdtempSync(join(ROOT, "local.")), "log");
  writeFileSync(log, "");
  const bin = fakeBin(log, fail, code);
  let fetched = "";
  const d: Deps = {
    sh: async (cmd) => {
      if (cmd[0] === "gh") return JSON.stringify({ headRefOid: "0123456789abcdef0123456789abcdef01234567", baseRefName: "main" });
      if (cmd.includes("fetch")) fetched = cmd.at(-1)!;
      if (cmd.includes("rev-parse")) return fetched.startsWith("refs/pull/") ? "0123456789abcdef0123456789abcdef01234567\n" : "1111111111111111111111111111111111111111\n";
      if (cmd.includes("worktree") && cmd.includes("add")) {
        const dir = cmd[cmd.indexOf("--detach") + 1]!;
        mkdirSync(join(dir, ".github/workflows"), { recursive: true });
        writeFileSync(join(dir, ".github/workflows/ci.yml"), readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml")));
        mkdirSync(join(dir, "scripts"), { recursive: true });
        writeFileSync(join(dir, "scripts/ci.ts"), readFileSync(join(import.meta.dir, "ci.ts")));
      }
      return "";
    },
    step: async (script, cwd, env) => {
      const p = Bun.spawn(["bash", "-e", "-c", script], { cwd, env: { ...env, PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
      return { code: await p.exited, output: "" };
    },
    log: () => undefined,
  };
  const r = await localCi(42, "/repo", d, "example/development", join(ROOT, "cache"));
  return { results: r.results, ran: commands(log) };
}

describe("ci", () => {
  test("runCi: in order, stops after the first failing step; ciExit is 1 then, whatever the step's code", async () => {
    const steps = [{ name: "a", run: "a" }, { name: "b", run: "b" }, { name: "c", run: "c" }];
    const ran: string[] = [];
    const results = await runCi(steps, async (s) => (ran.push(s.name), { code: s.name === "b" ? 3 : 0 }));
    expect(ran).toEqual(["a", "b"]);
    expect(results.map((r) => [r.name, r.code])).toEqual([["a", 0], ["b", 3]]);
    expect(ciExit(results)).toBe(1);
    expect(ciExit(await runCi(steps, async () => ({ code: 0 })))).toBe(0);
  });

  test("the steps: home paths, install, public tree check, licenses, typecheck, test, web build, then perf — in that order", () => {
    const first = ciSteps.map((s) => s.run.split("\n")[0]!.trim());
    const at = (cmd: string) => first.findIndex((r) => r.startsWith(cmd));
    const order = ["rc=0; git grep", "bun install --frozen-lockfile", "bun ops-kit/src/cli.ts public-sync --check", "bun run licenses:check", "bun run typecheck", "bun test", "bun run --cwd apps/web build", "bun scripts/perf-bench.ts", "bun scripts/perf-ratchet.ts"].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  test("the home-path step does not find itself in this file", async () => {
    const p = Bun.spawn(["bash", "-e", "-c", ciSteps[0]!.run], { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    expect(out).not.toContain("scripts/ci.ts");
    expect(code).toBe(0);
  });

  test("local-ci reads the PR's scripts/ci.ts in a process of its own with the steps' environment only (the PR's code never runs in local-ci's)", async () => {
    const dir = mkdtempSync(join(ROOT, "checkout."));
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/ci.yml"), readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml")));
    mkdirSync(join(dir, "scripts"));
    // a PR's scripts/ci.ts that lists what it can see
    writeFileSync(join(dir, "scripts/ci.ts"), "console.log(JSON.stringify(Object.keys(process.env).map((k) => ({ name: k, run: String(globalThis.SECRET_IN_PARENT) }))));");
    (globalThis as Record<string, unknown>).SECRET_IN_PARENT = "leaked";
    try {
      const steps = await checkoutSteps(dir, { PATH: "/usr/bin:/bin", CI: "true" });
      expect(steps.map((s) => s.name).filter((k) => !["PWD", "SHLVL", "_"].includes(k)).sort()).toEqual(["CI", "PATH"]);
      expect(steps.every((s) => s.run === "undefined")).toBe(true);
    } finally {
      delete (globalThis as Record<string, unknown>).SECRET_IN_PARENT;
    }
  });

  test("Actions' entry and local-ci run the same commands, stop at the same failing step (its code kept) and exit the same", async () => {
    for (const [fail, code] of [["bun none", 0], ["bun run typecheck", 2], ["bun test", 1], ["bun scripts/perf-bench.ts --runs 5 --json perf-result.json", 5]] as const) {
      const a = await actions(fail, code);
      const l = await local(fail, code);
      expect(l.ran).toEqual(a.ran);
      // local-ci's process exits ciExit(results), as its CLI does
      expect(ciExit(l.results)).toBe(a.exit);
      expect(a.exit).toBe(code ? 1 : 0);
      if (code) expect([a.ran.at(-1), l.results.at(-1)!.code]).toEqual([fail, code]);
    }
    // every step ran when none failed
    expect((await local("bun none", 0)).results.length).toBe(ciSteps.length);
  }, 60_000);
});
