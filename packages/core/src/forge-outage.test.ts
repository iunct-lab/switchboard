// test-reads: packages/core/src/forge-outage.ts ops-kit/src/gh.ts
import { expect, test } from "bun:test";
import type { GhRunner } from "./backlog-gh.ts";
import { githubOutage, outageRefusal } from "./forge-outage.ts";

const NOW = 1_000_000_000_000;
const ask = (gh: GhRunner, waitUntil = 0, timeoutMs = 50) => githubOutage({ gh, waitUntil, now: () => NOW, timeoutMs }, "/repo");
const answers = (code: number, stdout: string, stderr = ""): GhRunner => async () => ({ code, stdout, stderr });
const budget = (graphql: number, core = 4000) => `HTTP/2.0 200 OK\n\n${JSON.stringify({ resources: { core: { remaining: core, reset: NOW / 1000 + 600 }, graphql: { remaining: graphql, reset: NOW / 1000 + 900 } } })}`;

test("GitHub answers and has budget: usable — whatever the caller believes", async () => {
  const calls: string[][] = [];
  const a = await ask(async (args) => (calls.push(args), { code: 0, stdout: budget(4000), stderr: "" }));
  expect(a).toMatchObject({ unusable: false, reason: "usable" });
  // one call, the one that costs no budget
  expect(calls).toEqual([["api", "--include", "rate_limit"]]);
  expect(outageRefusal(a as never)).toContain("GitHub は使えます");
});

test("the observed classes that count: no answer in time, a network error, a 5xx, a budget at 0 with its reset, the daemon's own standing wait", async () => {
  expect(await ask(() => new Promise(() => {}))).toMatchObject({ unusable: true, kind: "network" });
  expect(await ask(async () => { throw new Error("error connecting to api.github.com"); })).toMatchObject({ unusable: true, kind: "network" });
  expect(await ask(answers(1, "", "HTTP 502: Bad Gateway (https://api.github.com/rate_limit)"))).toMatchObject({ unusable: true, kind: "transient", evidence: expect.stringContaining("HTTP 502") });
  expect(await ask(answers(0, budget(0)))).toMatchObject({ unusable: true, kind: "primary", until: NOW + 900_000 });
  expect(await ask(answers(0, budget(4000, 0)))).toMatchObject({ unusable: true, kind: "primary", until: NOW + 600_000 });
  // while the daemon's own sync waits, GitHub is not asked at all
  let asked = 0;
  expect(await ask(async () => (asked++, { code: 0, stdout: budget(4000), stderr: "" }), NOW + 60_000)).toMatchObject({ unusable: true, kind: "wait", until: NOW + 60_000 });
  expect(asked).toBe(0);
  // a wait that is over is no wait
  expect(await ask(answers(0, budget(4000)), NOW - 1)).toMatchObject({ unusable: false, reason: "usable" });
});

test("a login or permission failure is permanent, and a failure of no class is not an outage: both refuse", async () => {
  for (const stderr of ["HTTP 401: Bad credentials (https://api.github.com/rate_limit)", "HTTP 403: Resource not accessible by personal access token", "HTTP 404: Not Found (https://api.github.com/rate_limit)", "To get started with GitHub CLI, please run:  gh auth login"]) {
    const a = await ask(answers(1, "", stderr));
    expect([stderr, a]).toEqual([stderr, expect.objectContaining({ unusable: false, reason: "permanent" })]);
    expect(outageRefusal(a as never)).toContain("止まって利用者に報告");
  }
  for (const stderr of ["gh を起動できません: ENOENT", "HTTP 422: Validation Failed", ""]) expect([stderr, await ask(answers(1, "", stderr))]).toEqual([stderr, expect.objectContaining({ unusable: false, reason: "unknown" })]);
  // a limit the answer names without an end, with the budget's own call failing: nothing to wait for
  expect(await ask(answers(1, "", "GraphQL: API rate limit exceeded for user ID 1."))).toMatchObject({ unusable: false });
});
