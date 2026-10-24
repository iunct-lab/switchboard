import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * scripts/host/claude-wrapper.sh (#180) with a fake `aws` and a fake `claude`: the token read from Parameter Store
 * reaches the real `claude` only, through its environment, and a failed read stops before `claude` starts.
 */
const WRAPPER = join(import.meta.dir, "claude-wrapper.sh");
let dir: string;

function script(path: string, body: string) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-test-wrapper-"));
  mkdirSync(join(dir, "wrap"));
  mkdirSync(join(dir, "fake"));
  // installed the way the docs say: the wrapper as `claude`, ahead of the real one on PATH
  symlinkSync(WRAPPER, join(dir, "wrap", "claude"));
  script(join(dir, "fake", "aws"), `echo "$@" > "${dir}/aws.args"\n[ -f "${dir}/aws.fail" ] && { echo "AccessDenied" >&2; exit 255; }\n[ -f "${dir}/aws.empty" ] && { echo None; exit 0; }\necho tok-123`);
  script(join(dir, "fake", "claude"), `printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > "${dir}/claude.token"\necho "$@" > "${dir}/claude.args"`);
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(env: Record<string, string>, path = `${join(dir, "wrap")}:${join(dir, "fake")}:/usr/bin:/bin`) {
  for (const f of ["aws.args", "claude.token", "claude.args"]) rmSync(join(dir, f), { force: true });
  const p = Bun.spawnSync([join(dir, "wrap", "claude"), "-p", "--verbose"], { env: { PATH: path, ...env }, stderr: "pipe" });
  return { code: p.exitCode, stderr: p.stderr.toString() };
}

describe("claude-wrapper.sh (#180)", () => {
  test("reads the parameter with decryption and execs the next claude on PATH with the token in its environment only", () => {
    const r = run({ SWITCHBOARD_CLAUDE_TOKEN_PARAM: "/switchboard/claude-oauth-token" });
    expect(r).toEqual({ code: 0, stderr: "" });
    expect(readFileSync(join(dir, "aws.args"), "utf8").trim()).toBe("ssm get-parameter --name /switchboard/claude-oauth-token --with-decryption --query Parameter.Value --output text");
    expect(readFileSync(join(dir, "claude.token"), "utf8")).toBe("tok-123");
    expect(readFileSync(join(dir, "claude.args"), "utf8").trim()).toBe("-p --verbose");
    // the caller (here the test; on the machine the daemon) never had it
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).not.toBe("tok-123");
  });

  test("a failed read stops with an error before claude starts; so does a missing parameter name", () => {
    writeFileSync(join(dir, "aws.fail"), "");
    try {
      const r = run({ SWITCHBOARD_CLAUDE_TOKEN_PARAM: "/switchboard/claude-oauth-token" });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("could not read /switchboard/claude-oauth-token");
      expect(existsSync(join(dir, "claude.args"))).toBe(false);
    } finally {
      rmSync(join(dir, "aws.fail"));
    }
    // a parameter that holds nothing (the CLI prints "None")
    writeFileSync(join(dir, "aws.empty"), "");
    try {
      const r = run({ SWITCHBOARD_CLAUDE_TOKEN_PARAM: "/switchboard/claude-oauth-token" });
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("is empty");
      expect(existsSync(join(dir, "claude.args"))).toBe(false);
    } finally {
      rmSync(join(dir, "aws.empty"));
    }
    const unset = run({});
    expect(unset.code).not.toBe(0);
    expect(unset.stderr).toContain("SWITCHBOARD_CLAUDE_TOKEN_PARAM");
    expect(existsSync(join(dir, "aws.args"))).toBe(false);
  });

  test("no other claude on PATH: stops before asking Parameter Store", () => {
    const r = run({ SWITCHBOARD_CLAUDE_TOKEN_PARAM: "/switchboard/claude-oauth-token" }, `${join(dir, "wrap")}:/usr/bin:/bin`);
    expect(r.code).toBe(127);
    expect(r.stderr).toContain("no other claude on PATH");
    expect(existsSync(join(dir, "aws.args"))).toBe(false);
  });
});
