// test-reads: .github/workflows/ci.yml scripts/ci.ts
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { ciExit, ciSteps, runCi } from "./ci";
import { checkoutSteps, runCheckout, stepEnv, type Deps } from "./local-ci";

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
  tool("codex");
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

/** local-ci's step runner (`runCheckout`, with the perf steps as the tag CI runs it) over the same checkout: its steps go through the same fakes, one `bash -e -c` each as the real `step` does. */
async function local(fail: string, code: number): Promise<{ results: Array<{ code: number }>; ran: string[] }> {
  const log = join(mkdtempSync(join(ROOT, "local.")), "log");
  writeFileSync(log, "");
  const bin = fakeBin(log, fail, code);
  const cache = mkdtempSync(join(ROOT, "cache."));
  const dir = mkdtempSync(join(ROOT, "co."));
  mkdirSync(join(dir, ".github/workflows"), { recursive: true });
  writeFileSync(join(dir, ".github/workflows/ci.yml"), readFileSync(join(import.meta.dir, "../.github/workflows/ci.yml")));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "scripts/ci.ts"), readFileSync(join(import.meta.dir, "ci.ts")));
  const d: Omit<Deps, "slot"> = {
    sh: async () => "",
    step: async (script, cwd, env) => {
      const p = Bun.spawn(["bash", "-e", "-c", script], { cwd, env: { ...env, PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
      return { code: await p.exited, output: "" };
    },
    log: () => undefined,
  };
  // the tag CI's run (every step, perf included): the same steps as Actions
  const r = await runCheckout(dir, stepEnv(dir), "ci-test", d, cache, undefined, undefined, true);
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
    // a keepGoing step's failure does not stop the run, which still fails
    const going = [{ name: "a", run: "a" }, { name: "b", run: "b", keepGoing: true }, { name: "c", run: "c" }];
    const kept = await runCi(going, async (s) => ({ code: s.name === "b" ? 3 : 0 }));
    expect(kept.map((r) => [r.name, r.code])).toEqual([["a", 0], ["b", 3], ["c", 0]]);
    expect(ciExit(kept)).toBe(1);
  });

  test("the steps: home paths, install, public tree check, licenses, Codex CLI, typecheck, public docs, web build, perf, then test — in that order; only the perf steps keep going", () => {
    const first = ciSteps.map((s) => s.run.split("\n")[0]!.trim());
    const at = (cmd: string) => first.findIndex((r) => r === cmd || r.startsWith(`${cmd} `) || (cmd.endsWith(" ") && r.startsWith(cmd)));
    const order = ["rc=0; git grep ", "bun install --frozen-lockfile", "bun ops-kit/src/cli.ts public-sync --check", "bun run licenses:check", "if command -v codex ", "bun run typecheck", "bun scripts/public-docs.ts check", "bun run --cwd apps/web build", "bun scripts/perf-ratchet.ts base ", "bun scripts/perf-bench.ts", "bun scripts/perf-ratchet.ts check ", "bun test"].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(ciSteps.filter((s) => s.keepGoing).map((s) => s.run.split(" ").slice(1, 3).join(" "))).toEqual(["scripts/perf-ratchet.ts base", "scripts/perf-bench.ts --runs", "scripts/perf-ratchet.ts check"]);
  });

  test("the Codex CLI step installs it with npm when codex is not on PATH, and does not touch npm when it is", async () => {
    const step = ciSteps.find((s) => s.name === "Codex CLI for typecheck")!;
    const run = async (withCodex: boolean) => {
      const log = join(mkdtempSync(join(ROOT, "codex.")), "log");
      writeFileSync(log, "");
      const bin = mkdtempSync(join(ROOT, "bin."));
      for (const name of withCodex ? ["npm", "codex"] : ["npm"]) {
        writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> ${JSON.stringify(log)}\n`);
        chmodSync(join(bin, name), 0o755);
      }
      // PATH holds only the fakes (bash by its absolute path; `command -v` is a builtin), so a real codex or npm on the host cannot stand in for them
      const p = Bun.spawn(["/bin/bash", "-e", "-c", step.run], { env: { PATH: bin }, stdout: "pipe", stderr: "pipe" });
      return { code: await p.exited, ran: readFileSync(log, "utf8").trimEnd().split("\n").filter(Boolean) };
    };
    expect(await run(false)).toEqual({ code: 0, ran: ["npm install -g @openai/codex"] });
    expect(await run(true)).toEqual({ code: 0, ran: [] });
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
      // a step that does not keep going is the last that ran; the failed step's code is kept
      if (code) expect(l.results.find((r) => r.code !== 0)!.code).toBe(code);
      if (code && !fail.includes("perf-")) expect(a.ran.at(-1)).toBe(fail);
    }
    // every step ran when none failed
    expect((await local("bun none", 0)).results.length).toBe(ciSteps.length);
  }, 60_000);

  test("a failing perf step does not stop bun test: both run, both are in the results, exit 1 (Actions and local-ci alike)", async () => {
    const check = "bun scripts/perf-ratchet.ts check perf-result.json --base perf-base.json";
    const a = await actions(check, 1);
    const l = await local(check, 1);
    expect(l.ran).toEqual(a.ran);
    expect(a.ran.indexOf(check)).toBeLessThan(a.ran.indexOf("bun test"));
    expect(a.ran.at(-1)).toBe("bun test");
    expect(l.results.length).toBe(ciSteps.length);
    expect(l.results.filter((r) => r.code !== 0).map((r) => r.code)).toEqual([1]);
    expect([a.exit, ciExit(l.results)]).toEqual([1, 1]);
  }, 60_000);
});
