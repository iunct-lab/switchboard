// test-reads: none
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciScript, stepsOf } from "./local-ci-offload";
import { parseBuild, setupFailure } from "./local-ci";

describe("ciScript mount mask", () => {
  const lines = ciScript([{ run: "true" } as never], {}).split("\n");
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));

  test("the steps cannot read the build's env.sh", () => {
    const start = at(/^cat > \/tmp\/sb-run\.sh <<'SB_RUN_EOF'/);
    // the declaration line carries the write-status guard after the heredoc word, so it is matched by its head; not found would make every order check below meaningless
    expect(start).toBeGreaterThan(-1);
    const mask = at(/mount -t tmpfs .* \/codebuild\/output\/tmp/);
    const login = at(/su - switchboard/);
    const end = at(/^SB_RUN_EOF$/);
    const run = at(/^unshare --mount --propagation private bash \/tmp\/sb-run\.sh; c=\$\?$/);
    expect(mask).toBeGreaterThan(-1);
    // the mask and the steps' login are in the one script that the private mount namespace runs, the mask first
    expect(start).toBeLessThan(mask);
    expect(mask).toBeLessThan(login);
    expect(login).toBeLessThan(end);
    expect(end).toBeLessThan(run);
    expect(lines.filter((l) => /su - switchboard/.test(l)).length).toBe(1);
  });

  test("a mask that cannot be mounted stops the build before any step", () => {
    expect(lines[at(/mount -t tmpfs .* \/codebuild\/output\/tmp/)]).toContain("exit 1");
  });
});

// The generated script runs in bash with the build's privileged commands stubbed (a directory of scripts first on PATH that log what they are given).
describe("ciScript as run", () => {
  const spawn = (run: string, opt: { unshareFails?: "mount" | "all"; pidLaunchFails?: true; launchFails?: true; baseFails?: true; catFails?: true; suExit?: number; suDeletesMarker?: true } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "sb-ci-run."));
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      const log = join(dir, "log");
      const stub = (name: string, body: string) => {
        writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
        chmodSync(join(bin, name), 0o755);
      };
      stub("mkdir", ":");
      if (opt.baseFails) stub("base64", "exit 1");
      if (opt.catFails) stub("cat", "exit 1");
      stub("chown", ":");
      stub("mount", `echo "mount $*" >> ${log}`);
      // the real unshare's options are dropped and the command after them runs in this same namespace
      stub("unshare", `echo "unshare $*" >> ${log}
case "$*" in *"--mount --propagation private true") ${opt.unshareFails ? "exit 1" : "exit 0"} ;; esac
case "$*" in *"bash "*sb-run.sh) ${opt.launchFails ? "exit 1" : ":"} ;; esac
case "$*" in *"--mount-proc bash"*) ${opt.pidLaunchFails ? "exit 1" : ":"} ;; esac
while [ $# -gt 0 ]; do case "$1" in --propagation) shift 2 ;; -*) shift ;; *) break ;; esac; done
exec "$@"`);
      // the login runs the steps' script's own first line (its start marker) and exits as told: the other lines stand for steps this test does not run
      stub("su", `echo "su $*" >> ${log}; head -n 1 ${join(dir, "sb-local-ci.sh")} | sed "s#/sb/tmp#${join(dir, "sbtmp")}#" | sh; ${opt.suDeletesMarker ? `rm -f ${join(dir, "sbtmp", "sb-started")}; ` : ""}exit ${opt.suExit ?? 0}`);
      const marker = join(dir, "ran-in-the-root-shell");
      // `/sb/tmp` goes first: the test's own directory is under the build's TMPDIR, which is `/sb/tmp/...` there, and a later pass would rewrite it again
      const script = ciScript([{ name: "x", run: run.replaceAll("MARKER", marker) } as never], {})
        .replaceAll("/sb/tmp", join(dir, "sbtmp"))
        .replaceAll("/tmp/sb-local-ci.sh", join(dir, "sb-local-ci.sh"))
        .replaceAll("/tmp/sb-run.sh", join(dir, "sb-run.sh"))
        .replaceAll("/codebuild/output/tmp", join(dir, "cb"));
      mkdirSync(join(dir, "cb"));
      mkdirSync(join(dir, "sbtmp"));
      const p = Bun.spawnSync(["sh", "-c", script], { cwd: dir, env: { PATH: `${bin}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" });
      const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
      return { code: p.exitCode, out: p.stdout.toString(), log: read(log).split("\n").filter(Boolean), marker: existsSync(marker), script: read(join(dir, "sb-local-ci.sh")) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  test("a step's text cannot end a heredoc and run in the root shell before the mask", () => {
    // `quote` keeps newlines; the lines stand for what a pull request's own step could carry
    const r = spawn("true\nSB_LOCAL_CI_EOF\nSB_RUN_EOF\necho escaped > MARKER\nexit 0\n");
    expect(r.marker).toBe(false);
    // the step's text did arrive, in the file only the unprivileged login runs
    expect(r.script).toContain("SB_LOCAL_CI_EOF");
    expect(r.code).toBe(0);
  });

  test("the mount comes before the login, in the namespace the login runs in", () => {
    const r = spawn("true");
    const at = (re: RegExp) => r.log.findIndex((l) => re.test(l));
    expect(at(/^mount -t tmpfs .*\/cb$/)).toBeGreaterThan(-1);
    expect(at(/^mount -t tmpfs .*\/cb$/)).toBeLessThan(at(/^su - switchboard/));
    // the launcher is started by `unshare --mount`, and the mount is made after it
    expect(at(/^unshare --mount --propagation private bash /)).toBeLessThan(at(/^mount -t tmpfs .*\/cb$/));
  });

  test("a mount namespace that cannot be made is a setup failure, and a step's own exit code passes through", () => {
    const bad = spawn("true", { unshareFails: "mount" });
    expect(bad.out).toContain("sb-setup: mount 名前空間を作れない");
    expect(bad.code).toBe(1);
    expect(bad.log.some((l) => l.startsWith("su "))).toBe(false);
    expect(spawn("true", { suExit: 7 }).code).toBe(7);
  });

  test("the steps' script writes the start marker before anything else", () => {
    const first = stepsOf(ciScript([{ name: "x", run: "true" } as never], {})).split("\n")[0];
    expect(first).toBe(": > /sb/tmp/sb-started");
  });

  test("steps that never started are a setup failure, whatever stage failed; a step's own exit code passes through", () => {
    // the real launch of the steps (a PID namespace inside the mount namespace) fails after the probe for it passed
    const pid = spawn("true", { pidLaunchFails: true });
    expect(pid.out).toContain("sb-setup: 手順を起こせない");
    expect(pid.code).toBe(1);
    expect(pid.log.some((l) => l.startsWith("su "))).toBe(false);
    // the launcher cannot start
    const launch = spawn("true", { launchFails: true });
    expect(launch.out).toContain("sb-setup: 手順を起こせない");
    expect(launch.code).toBe(1);
    // a step that fails: its code, 1 included, with no setup line
    const failed = spawn("true", { suExit: 1 });
    expect(failed.code).toBe(1);
    expect(failed.out).not.toContain("sb-setup:");
    expect(failed.log.some((l) => l.startsWith("su "))).toBe(true);
  });

  test("a step that deleted the start marker keeps its own failure, and no setup failure is read from it", () => {
    const r = spawn("true", { suExit: 7, suDeletesMarker: true });
    expect(r.code).toBe(7);
    // what the build log of such a run reads as: the step marks (the step's own `echo`s stand in for them) and the root shell's line
    const out = `sb-step: 0 begin 1.0\nsb-step: 0 exit 7 2.0\n${r.out}`;
    expect(setupFailure(out)).toBeUndefined();
    expect(parseBuild(out, [{ name: "x", run: "true" } as never], r.code)[0]!.code).toBe(7);
    // no step ran and the launcher said success: still a setup failure
    const none = spawn("true", { suExit: 0, suDeletesMarker: true });
    expect(none.out).toContain("sb-setup: 手順を起こせない");
    expect(none.code).toBe(1);
  });

  test("a steps' script or a launcher that cannot be written is a setup failure", () => {
    const steps = spawn("true", { baseFails: true });
    expect(steps.out).toContain("sb-setup: 手順を書けない");
    expect(steps.code).toBe(1);
    expect(steps.log.some((l) => l.startsWith("unshare "))).toBe(false);
    const launcher = spawn("true", { catFails: true });
    expect(launcher.out).toContain("sb-setup: 起動の手順を書けない");
    expect(launcher.code).toBe(1);
    expect(launcher.log.some((l) => l.startsWith("su "))).toBe(false);
  });
});

describe("stepsOf", () => {
  const wrap = (body: string) => `set -u\nprintf '%s' '${body}' | base64 -d > /tmp/sb-local-ci.sh || exit 1`;
  test("a body that is not base64 throws, one that is decodes", () => {
    expect(stepsOf(wrap(Buffer.from("echo hi").toString("base64")))).toBe("echo hi");
    for (const bad of ["", "abc", "ab!d", "====", "ab=d"]) expect(() => stepsOf(wrap(bad))).toThrow("stepsOf");
    expect(() => stepsOf("no steps here")).toThrow("stepsOf");
  });
});
