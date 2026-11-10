// test-reads: none
import { describe, expect, test } from "bun:test";
import { runJob, stopExample } from "./job-client.ts";

// `ops-kit job` (#3994): a Task asks the app for its local CI / review as the app's job, through BACKLOG_URL's origin.

const ENV = { BACKLOG_URL: "http://127.0.0.1:4777/api/backlog", OPS_KIT_TASK_ID: "task_1" };

function run(argv: string[], answer: (url: string, init?: RequestInit) => Response | Promise<Response>, env: Record<string, string | undefined> = ENV) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return answer(url, init);
  };
  return runJob(argv, env, { out: (s) => out.push(s), err: (s) => err.push(s) }, { fetch, cwd: "/work/app" }).then((code) => ({ code, calls, out: out.join("\n"), err: err.join("\n") }));
}
const job = (over: Record<string, unknown> = {}) => Response.json({ id: 7, kind: "local-ci", taskId: "task_1", pr: 12, runner: null, status: "running", exitCode: null, ...over }, { status: 202 });

describe("ops-kit job (#3994)", () => {
  test("request local-ci posts the kind, PR, cwd and Task, and prints job#<id> and the stop to paste", async () => {
    const r = await run(["request", "local-ci", "12"], () => job());
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([{ url: "http://127.0.0.1:4777/api/jobs", method: "POST", body: { kind: "local-ci", taskId: "task_1", pr: 12, cwd: "/work/app" } }]);
    expect(r.out.split("\n")[0]).toBe("job#7");
    expect(r.out).toContain(stopExample({ id: 7, kind: "local-ci", pr: 12 }));
    expect(r.out).toContain('"conditions":[{"key":"job#7","value":"done","met":false}]');
    expect(r.out).toContain('"reason":"depends"');
  });

  test("request local-ci --fixtures sends the absolute folder; a relative one and one on a review are usage errors (1) and call nothing", async () => {
    const ok = await run(["request", "local-ci", "12", "--fixtures", "/home/u/fixtures"], () => job());
    expect(ok.code).toBe(0);
    expect(ok.calls[0]!.body).toEqual({ kind: "local-ci", taskId: "task_1", pr: 12, cwd: "/work/app", fixtures: "/home/u/fixtures" });
    for (const argv of [["request", "local-ci", "12", "--fixtures", "fixtures"], ["request", "review", "12", "--runner", "codex", "--prompt", "p", "--out", "o", "--fixtures", "/home/u/f"]]) {
      const r = await run(argv, () => job());
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.calls).toEqual([]);
    }
  });

  test("request review sends the runner and the files resolved against --cwd", async () => {
    const r = await run(["request", "review", "12", "--runner", "codex", "--prompt", "_review/prompt.md", "--out", "_review/codex.md", "--cwd", "/tmp/clone"], () => job({ kind: "review", runner: "codex" }));
    expect(r.code).toBe(0);
    expect(r.calls[0]!.body).toEqual({ kind: "review", taskId: "task_1", pr: 12, runner: "codex", cwd: "/tmp/clone", promptFile: "/tmp/clone/_review/prompt.md", outFile: "/tmp/clone/_review/codex.md" });
  });

  test("usage errors are 1 and call nothing; the app's 400 is 1", async () => {
    for (const argv of [["request", "review", "12", "--runner", "codex"], ["request", "shell", "12"], ["request", "local-ci", "x"], ["wait", "7"]]) {
      const r = await run(argv, () => job());
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.calls).toEqual([]);
    }
    const refused = await run(["request", "local-ci", "12"], () => Response.json({ error: "cwd is not a checkout of the task's repository" }, { status: 400 }));
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("cwd is not a checkout");
  });

  test("outside the app's Task, or with the app not reached, it cannot tell: 2", async () => {
    expect((await run(["request", "local-ci", "12"], () => job(), {})).code).toBe(2);
    expect((await run(["request", "local-ci", "12"], () => job(), { BACKLOG_URL: ENV.BACKLOG_URL })).code).toBe(2);
    const down = await run(["list"], () => {
      throw new Error("Unable to connect");
    });
    expect(down.code).toBe(2);
    expect(down.err).toContain("届きません");
  });

  test("list prints a line per job", async () => {
    const r = await run(["list"], () => Response.json([{ id: 7, kind: "review", taskId: "task_1", pr: 12, runner: "codex", status: "fail", exitCode: 1 }]));
    expect(r.code).toBe(0);
    expect(r.calls[0]).toMatchObject({ url: "http://127.0.0.1:4777/api/jobs", method: "GET" });
    expect(r.out).toBe("job#7\treview(codex)\tPR #12\tfail(1)\ttask_1");
  });
});
