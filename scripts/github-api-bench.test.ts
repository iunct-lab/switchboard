import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callMetric, GhError, noCall, waitMessage, type GithubCallMetric } from "../ops-kit/src/gh.ts";
import { BacklogError, type GhRunner } from "../packages/core/src/backlog.ts";
import { BacklogSync } from "../packages/core/src/backlog-sync.ts";
import { Db } from "../packages/core/src/db.ts";
import { errorKind, measured, runGithubApiBench, summarize } from "./github-api-bench.ts";

test("--fixture: the same counts whatever the shell sets, and the shell's values come back (#987 recheck)", async () => {
  const keys = ["GH_REPO", "SWITCHBOARD_PROJECT_URL", "GH_HOST"] as const;
  const saved = keys.map((k) => process.env[k]);
  const counts = async () => (await runGithubApiBench()).scenarios.map((s) => [s.name, s.calls, s.error]);
  try {
    for (const k of keys) delete process.env[k];
    const bare = await counts();
    Object.assign(process.env, { GH_REPO: "x/y", SWITCHBOARD_PROJECT_URL: "https://github.com/orgs/x/projects/3", GH_HOST: "ghe.example" });
    expect(await counts()).toEqual(bare);
    expect([process.env.GH_REPO, process.env.SWITCHBOARD_PROJECT_URL, process.env.GH_HOST]).toEqual(["x/y", "https://github.com/orgs/x/projects/3", "ghe.example"]);
  } finally {
    keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
  }
});

test("--fixture: imports at once cost one import, a list costs nothing after it; nothing is asked while limited (#895, #885)", async () => {
  const r = await runGithubApiBench();
  expect(r.mode).toBe("fixture");
  const by = Object.fromEntries(r.scenarios.map((s) => [s.name, s]));
  const one = by["backlog import (once)"]!;
  expect(one.calls).toBeGreaterThan(0);
  // the list is read from what is stored: the import before it is all it costs
  expect(by["backlog list x10"]).toMatchObject({ calls: one.calls, shared: 0, single: one.calls });
  expect(by["backlog import x10 at once"]).toMatchObject({ calls: one.calls, shared: 9, single: one.calls });
  // the first import meets the limit; the ten after it ask nothing and say why
  const limited = by["backlog import x10 while limited"]!;
  expect(limited.byOp["api graphql"]).toBe(1);
  expect(limited).toMatchObject({ waited: 10, waits: ["secondary"] });
  expect(by.lint!.calls).toBe(1);
  expect(by.overlap!.calls).toBeGreaterThan(0);
  for (const s of r.scenarios) expect(s.error).toBeUndefined();
  // what the answers carry: remaining from gh's headers; the cost was not in them, so it is null, not a guess
  expect(one).toMatchObject({ remaining: expect.any(Number), resource: "graphql", cost: null });
  // no query, argument value or checkout path in the output
  const out = JSON.stringify(r);
  for (const leaked of ["query", "/work/app", "CURSOR1", "packages/core"]) expect(out).not.toContain(leaked);
});

test("callMetric keeps the operation, the repository and the limit — not the arguments", () => {
  const m = callMetric(["api", "graphql", "--include", "-f", "query=query{ secret }", "-F", "o=acme", "-F", "r=app"], 'HTTP/2.0 200 OK\nX-Ratelimit-Remaining: 4321\nX-Ratelimit-Resource: graphql\nX-Ratelimit-Reset: 1790000000\n\n{"data":{"rateLimit":{"cost":2}}}', "", 0, 5);
  expect(m).toEqual({ op: "api graphql", kind: "call", host: expect.any(String), repo: "acme/app", at: 5, ok: true, failure: null, cost: 2, remaining: 4321, resource: "graphql", resetAt: 1_790_000_000_000 });
  expect(callMetric(["issue", "comment", "7", "-R", "acme/app", "--body", "text"], "", "gh: Bad credentials (HTTP 401)", 1, 0)).toMatchObject({ op: "issue comment", repo: "acme/app", ok: false, failure: "auth", cost: null, remaining: null });
  expect(JSON.stringify(callMetric(["api", "repos/acme/app/issues/7/comments", "-f", "body=hello"], "", "", 0, 0))).not.toContain("hello");
});

test("summarize: the cost only when every call carried one", () => {
  const known = callMetric(["api", "graphql"], '{"data":{"rateLimit":{"cost":1}}}', "", 0, 0);
  const unknown = callMetric(["api", "graphql"], "{}", "", 0, 0);
  expect(summarize("a", [known, known]).cost).toBe(2);
  expect(summarize("b", [known, unknown]).cost).toBeNull();
  // the cost is GraphQL's: gh commands and REST calls around it do not make it unknown (#987 recheck)
  const rest = callMetric(["repo", "view"], "acme/app\n", "", 0, 0);
  expect(summarize("d", [rest, known, callMetric(["api", "repos/acme/app"], "{}", "", 0, 0)]).cost).toBe(1);
  expect(summarize("e", [rest]).cost).toBeNull();
  expect(summarize("c", [known, noCall("backlog", "shared", 0), noCall("backlog", "waited", 0, "primary")])).toMatchObject({ calls: 1, shared: 1, waited: 1, waits: ["primary"] });
});

test("BacklogSync's measures during a wait: a read costs nothing, an import is waited (#885; #987 review)", async () => {
  let limited = false;
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const page = { data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
  const gh: GhRunner = async (args) =>
    args[0] === "repo" ? ok("acme/app true\n") : args[0] === "variable" ? ok("https://github.com/users/acme/projects/11\n")
      : limited ? { code: 1, stdout: "", stderr: "gh: API rate limit exceeded (HTTP 429)" } : ok(JSON.stringify(page));
  let now = 0;
  const ms: GithubCallMetric[] = [];
  const db = new Db(":memory:");
  const ws = db.upsertWorkspace({ id: "w", name: "app", path: "/work/app", kind: "repo" });
  const sync = new BacklogSync(db, gh, () => now, (m) => ms.push(m));
  await sync.sync(ws);
  limited = true;
  now = 60_000;
  await expect(sync.sync(ws)).rejects.toThrow("rate limit");
  ms.length = 0;
  expect(sync.read(ws).fetchedAt).toBe(0); // what is stored, no call
  await expect(sync.sync(ws)).rejects.toThrow("まで照会しません");
  expect(ms.map((m) => [m.kind, m.failure])).toEqual([["waited", "primary"]]);
  expect(ms[0]!.repo).toBe("acme/app"); // the repository the workspace reads, once imported (#994)
});

test("measured: a fake call that throws is a failed call", async () => {
  const ms: GithubCallMetric[] = [];
  const gh = measured({ graphql: async () => { throw new GhError("gh: You have exceeded a secondary rate limit. (HTTP 403)"); }, api: async () => null, run: async () => "" }, (m) => ms.push(m));
  await expect(gh.graphql("query{ x }", { o: "acme", r: "app" })).rejects.toThrow("secondary");
  await gh.api("repos/acme/app/issues/7");
  expect(ms.map((m) => [m.op, m.ok, m.failure, m.repo])).toEqual([["api graphql", false, "secondary", "acme/app"], ["api rest", true, null, "acme/app"]]);
});

test("BacklogSync's sink: a runner that throws is measured as a failed call (#987 recheck)", async () => {
  const ms: GithubCallMetric[] = [];
  for (const runner of [async () => { throw new Error("spawn gh ENOENT"); }, () => { throw new Error("spawn gh ENOENT"); }] as GhRunner[]) {
    ms.length = 0;
    const sync = new BacklogSync(new Db(":memory:"), runner, () => 0, (m) => ms.push(m));
    await expect(sync.sync({ id: "w", path: "/work/app" })).rejects.toThrow("ENOENT");
    expect(ms.map((m) => [m.op, m.kind, m.ok])).toEqual([["repo view", "call", false]]);
  }
});

test("errorKind: a scenario's error is the kind the error carries, never its text (#987 review)", () => {
  const wait = waitMessage({ until: 0, reason: "primary" });
  expect(errorKind(new GhError(wait, "primary"))).toBe("primary");
  expect(errorKind(new BacklogError(wait))).toBe("primary"); // a backlog read refused during the wait
  expect(errorKind(new BacklogError("gh api graphql: denied", { status: 401 }))).toBe("auth");
  expect(errorKind(new Error("gh: Bad Gateway (HTTP 502)"))).toBe("transient");
  expect(errorKind(new Error("open /Users/dev/app: no such file"))).toBe("failed");
});

test("--sample: gh is started by realGh only — the bench has no spawn of its own (#994)", () => {
  expect(readFileSync(join(import.meta.dir, "github-api-bench.ts"), "utf8")).not.toContain("Bun.spawn");
});
