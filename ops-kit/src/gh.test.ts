import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGh, GhError, GithubRetryState, parseIncluded, realGh, repoOf, responseOf, retryAtFromResponse, type GithubCallMetric } from "./gh.ts";

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
// The machine's global and system git config (url.<base>.insteadOf) would rewrite what `git remote get-url` answers.
const isolate = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
beforeEach(() => {
  for (const [k, v] of Object.entries(isolate)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const k of Object.keys(isolate)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
function repoWithOrigin(url: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "ops-kit-gh-"));
  dirs.push(dir);
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: { ...process.env } });
  if (url) Bun.spawnSync(["git", "remote", "add", "origin", url], { cwd: dir, env: { ...process.env } });
  return dir;
}

describe("repoOf", () => {
  test("GH_REPO in each form gh accepts", async () => {
    for (const v of ["example/repo", "github.com/example/repo", "https://github.com/example/repo"]) {
      expect(await repoOf(fakeGh([]), { GH_REPO: v }, tmpdir())).toEqual({ owner: "example", name: "repo" });
    }
  });

  test("without GH_REPO, the origin remote (ssh or https, with or without .git)", async () => {
    for (const url of ["git@github.com:example/repo.git", "https://github.com/example/repo", "https://github.com/example/repo.git"]) {
      expect(await repoOf(fakeGh([]), {}, repoWithOrigin(url))).toEqual({ owner: "example", name: "repo" });
    }
  });

  test("without either, gh repo view", async () => {
    const gh = fakeGh([() => "example/repo\n"]);
    expect(await repoOf(gh, {}, repoWithOrigin(null))).toEqual({ owner: "example", name: "repo" });
    expect(gh.calls[0]).toEqual({ kind: "run", args: ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"] });
  });
});

describe("GitHub limits (#894)", () => {
  const now = 1_000_000;
  const kindOf = (stdout: string, stderr: string) => retryAtFromResponse(responseOf(stdout, stderr), now);

  test("parseIncluded: status, headers (lower case) and body; output without a status line is all body", () => {
    expect(parseIncluded("HTTP/2.0 404 Not Found\r\nX-Ratelimit-Remaining: 4756\r\n\r\n{\"message\":\"Not Found\"}")).toEqual({ status: 404, headers: { "x-ratelimit-remaining": "4756" }, body: '{"message":"Not Found"}' });
    expect(parseIncluded('{"data":{}}')).toEqual({ headers: {}, body: '{"data":{}}' });
  });

  test("retryAtFromResponse: Retry-After, then X-RateLimit-Reset; null when GitHub gives no time", () => {
    expect(kindOf("HTTP/2.0 429 Too Many Requests\nRetry-After: 30\n\n{}", "gh: (HTTP 429)")).toEqual({ kind: "primary", at: now + 30_000 });
    expect(kindOf("HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\nX-Ratelimit-Reset: 2000\n\n{\"message\":\"API rate limit exceeded\"}", "gh: API rate limit exceeded (HTTP 403)")).toEqual({ kind: "primary", at: 2_000_000 });
    expect(kindOf('HTTP/2.0 200 OK\n\n{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}', "gh: API rate limit exceeded")).toEqual({ kind: "primary", at: null });
    expect(kindOf("HTTP/2.0 403 Forbidden\nRetry-After: 60\n\n{\"message\":\"You have exceeded a secondary rate limit.\"}", "")).toEqual({ kind: "secondary", at: now + 60_000 });
    expect(kindOf("", "gh: You have exceeded a secondary rate limit. (HTTP 403)")).toEqual({ kind: "secondary", at: null });
    expect(kindOf("", "gh: Bad Gateway (HTTP 502)")).toEqual({ kind: "transient", at: null });
    expect(kindOf("", "Post \"https://api.github.com/graphql\": read tcp: connection reset by peer")).toEqual({ kind: "transient", at: null });
    expect(kindOf('HTTP/2.0 200 OK\n\n{"errors":[{"message":"Something went wrong while executing your query. Please include `AE90:1` when reporting this issue."}]}', "gh: Something went wrong while executing your query. Please include `AE90:1` when reporting this issue.")).toEqual({ kind: "transient", at: null });
  });

  test("retryAtFromResponse: 401 and a 403 without a limit are auth; other failures are not classified", () => {
    expect(kindOf("", "gh: Bad credentials (HTTP 401)")).toEqual({ kind: "auth", at: null });
    expect(kindOf("HTTP/2.0 403 Forbidden\n\n{\"message\":\"Resource not accessible by integration\"}", "")).toEqual({ kind: "auth", at: null });
    expect(kindOf("", "To get started with GitHub CLI, please run:  gh auth login")).toEqual({ kind: "auth", at: null });
    expect(kindOf("", "gh: Not Found (HTTP 404)")).toBeNull();
    expect(kindOf("", "gh: Field 'nope' doesn't exist on type 'User'")).toBeNull();
  });

  test("GithubRetryState: GitHub's time, else 60 s doubling to 15 min; auth not waited for; a success clears; keys apart", () => {
    let t = now;
    const s = new GithubRetryState(() => t);
    expect(s.failed("github.com", { status: 429, headers: { "Retry-After": "90" } })).toEqual({ kind: "primary", until: now + 90_000 });
    expect(s.waiting("github.com")).toEqual({ until: now + 90_000, reason: "primary" });
    expect(s.waiting("ghe.example")).toBeNull();
    t = now + 90_000;
    expect(s.waiting("github.com")).toBeNull();
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) waits.push(s.failed("github.com", { status: 502 })!.until! - t);
    expect(waits).toEqual([120_000, 240_000, 480_000, 900_000, 900_000, 900_000, 900_000]); // the 429 was the first
    expect(s.failed("github.com", { status: 401, message: "Bad credentials" })).toEqual({ kind: "auth", until: null });
    expect(s.failed("github.com", { status: 404 })).toBeNull();
    s.succeeded("github.com", t); // a call begun before the failure was recorded (or in its millisecond) leaves the wait (#984 review)
    expect(s.waiting("github.com")).not.toBeNull();
    s.succeeded("github.com", t + 1);
    expect(s.waiting("github.com")).toBeNull();
    expect(s.failed("github.com", { status: 503 })!.until).toBe(t + 60_000);
    // a reset already past is no time: the fallback
    s.succeeded("github.com", t + 1);
    expect(s.failed("github.com", { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" } })).toEqual({ kind: "primary", until: t + 60_000 });
  });
});

describe("realGh's measures (#895)", () => {
  test("a call refused during a wait is one `waited` measure, and gh is not started", async () => {
    const state = new GithubRetryState();
    state.failed("github.com", { status: 429, headers: { "retry-after": "600" } });
    const ms: GithubCallMetric[] = [];
    const saved = process.env.GH_HOST;
    delete process.env.GH_HOST;
    try {
      await expect(realGh(state, (m) => ms.push(m)).run(["issue", "view", "7", "-R", "acme/app"])).rejects.toBeInstanceOf(GhError);
    } finally {
      if (saved !== undefined) process.env.GH_HOST = saved;
    }
    expect(ms).toEqual([expect.objectContaining({ op: "issue view", kind: "waited", failure: "primary", ok: false })]);
  });

  test("a call that reached gh is one `call` measure with its limit headers (a fake gh on PATH, in a child process)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit-gh-"));
    dirs.push(dir);
    writeFileSync(join(dir, "gh"), '#!/bin/sh\nprintf "HTTP/2.0 200 OK\\nX-Ratelimit-Remaining: 42\\nX-Ratelimit-Resource: core\\n\\n{}"\n', { mode: 0o755 });
    const script = `import { realGh } from ${JSON.stringify(join(import.meta.dir, "gh.ts"))}; const ms = []; await realGh(undefined, (m) => ms.push(m)).api("repos/acme/app/issues/7"); console.log(JSON.stringify(ms));`;
    const r = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).toBe("");
    expect(JSON.parse(r.stdout.toString())).toEqual([expect.objectContaining({ op: "api rest", kind: "call", repo: "acme/app", ok: true, remaining: 42, resource: "core", cost: null })]);
  });
});
