import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { composeTarget, markArgs } from "./docker-mark.ts";

const FRONT = join(dirname(import.meta.dir), "bin", "docker");

describe("markArgs", () => {
  test("run / create get the label right after the subcommand", () => {
    expect(markArgs(["run", "-d", "img"], "task=t1")).toEqual(["run", "--label", "task=t1", "-d", "img"]);
    expect(markArgs(["container", "create", "img"], "task=t1")).toEqual(["container", "create", "--label", "task=t1", "img"]);
  });
  test("the value of docker's own option is not taken for the subcommand", () => {
    expect(markArgs(["--context", "dev", "run", "-d", "img"], "task=t1")).toEqual(["--context", "dev", "run", "--label", "task=t1", "-d", "img"]);
    expect(markArgs(["--context", "run", "ps"], "task=t1")).toEqual(["--context", "run", "ps"]);
    expect(composeTarget(["--context", "dev", "compose", "-p", "x", "up"])).toEqual({ globals: ["-p", "x"], sub: "up" });
  });
  test("other commands are unchanged", () => {
    expect(markArgs(["ps", "-a"], "task=t1")).toEqual(["ps", "-a"]);
    expect(markArgs(["compose", "run", "web"], "task=t1")).toEqual(["compose", "run", "web"]);
  });
});

describe("composeTarget", () => {
  test("splits compose's own options from the subcommand", () => {
    expect(composeTarget(["compose", "-f", "a.yml", "-p", "x", "up", "-d"])).toEqual({ globals: ["-f", "a.yml", "-p", "x"], sub: "up" });
  });
  test("is null for what is not compose", () => {
    expect(composeTarget(["run", "compose"])).toBeNull();
    expect(composeTarget(["compose"])).toBeNull();
  });
});

describe("ops-kit/bin/docker", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kit.docker-mark."));
    const fake = join(dir, "docker");
    writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${dir}/calls"\ncase "$*" in *"config --format json"*) echo '{"name":"demo"}' ;; esac\n`);
    chmodSync(fake, 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (args: string[], env: Record<string, string>) =>
    Bun.spawnSync([FRONT, ...args], { env: { PATH: `${dirname(FRONT)}:${dir}:${process.env.PATH}`, HOME: process.env.HOME ?? "", ...env }, stdout: "pipe", stderr: "pipe" });

  test("with a label: labels run, and records the compose project", () => {
    const log = join(dir, "log");
    expect(run(["run", "-d", "busybox"], { DOCKER_MARK_LABEL: "task=t1", DOCKER_MARK_LOG: log }).exitCode).toBe(0);
    expect(run(["compose", "up", "-d"], { DOCKER_MARK_LABEL: "task=t1", DOCKER_MARK_LOG: log }).exitCode).toBe(0);
    const calls = readFileSync(join(dir, "calls"), "utf8");
    expect(calls).toContain("run --label task=t1 -d busybox");
    expect(readFileSync(log, "utf8")).toContain('"project":"demo"');
    expect(run(["compose", "-f", "x.yml", "up", "-d"], { DOCKER_MARK_LABEL: "task=t1", DOCKER_MARK_LOG: log }).exitCode).toBe(0);
    expect(readFileSync(log, "utf8")).toContain('"globals":["-f","x.yml"]');
  });
  test("without a label: arguments as they are, nothing logged", () => {
    const log = join(dir, "log2");
    writeFileSync(join(dir, "calls"), "");
    expect(run(["run", "-d", "busybox"], { DOCKER_MARK_LOG: log }).exitCode).toBe(0);
    expect(run(["compose", "up", "-d"], { DOCKER_MARK_LOG: log }).exitCode).toBe(0);
    expect(readFileSync(join(dir, "calls"), "utf8")).toBe("run -d busybox\ncompose up -d\n");
    expect(existsSync(log)).toBe(false);
  });
});
