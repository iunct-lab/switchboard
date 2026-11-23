// test-reads: none
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { writeWorkspaceConfigs } from "./workspace-config.ts";
import { mergeRecordsRoutes } from "./routes/merge-records.ts";
import { OWNER } from "./merge-grants.ts";
import { NO_GH, NO_HISTORY, fakeAdapter, j, startServer } from "./api-test-harness.ts";
import { mergeRecords } from "../../../ops-kit/src/merge-records.ts";
import { judge, readGitlabPr, readPr } from "../../../scripts/merge-gate.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);

describe("GET /api/merge-records", () => {
  const boot = async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-merge-records-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter([{ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/tmp" }, { t: "session.end", status: "ok" }])], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    writeFileSync(join(h, "client-token"), "k\n");
    const meta = ((await fetch(`${b}/api/workspaces`).then(j)) as Array<{ id: string; kind: string }>).find((w) => w.kind === "meta")!;
    const task = (action: "direct" | "complete") => c.tasks.create({ workspaceId: meta.id, cwd: c.db.getWorkspace(meta.id)!.path, title: `#9 ${action}`, prompt: "p", runner: "claude", stage: { issue: 9, action } });
    const opened = (taskId: string, n: number) => {
      c.db.appendEvent(taskId, { t: "tool.call", id: `o${n}`, name: "Bash", input: { command: "gh pr create --fill" }, summary: "gh pr create" });
      c.db.appendEvent(taskId, { t: "tool.result", id: `o${n}`, ok: true, summary: `https://github.com/Acme/App/pull/${n}` });
    };
    return { b, c, tokenFile: join(h, "client-token"), task, opened, stop: async () => { await c.stop(); rmSync(h, { recursive: true, force: true }); } };
  };
  const get = (b: string, q: string) => fetch(`${b}/api/merge-records?${q}`);

  test("answers the jobs of the PR, the grant of the head and whether the app started the Task as direct", async () => {
    const x = await boot();
    try {
      const t = x.task("direct");
      x.opened(t.id, 12);
      const job = x.c.db.insertJob({ kind: "review", taskId: t.id, pr: 12, runner: "claude", cwd: "/secret/cwd", startedAt: 1, repo: "acme/app", head: HEAD, as: null, kinds: [] });
      x.c.db.insertJob({ kind: "local-ci", taskId: t.id, pr: 13, runner: null, cwd: "/c", startedAt: 2, repo: "acme/app", head: null, as: null, kinds: [] });
      x.c.db.finishJob(job.id, { status: "pass", exitCode: 0, summary: "long summary", endedAt: 3 });
      x.c.db.recordMergeGrant({ taskId: t.id, repo: "acme/app", kind: "answer", target: 12, by: OWNER, head: HEAD });
      const a = await get(x.b, `repo=Acme/App&pr=12&taskId=${t.id}&head=${HEAD}`).then(j);
      expect(a.jobs.map((r: { id: number; head: string }) => [r.id, r.head])).toEqual([[job.id, HEAD]]);
      expect(a.jobs[0]).not.toHaveProperty("summary");
      expect(a.jobs[0]).not.toHaveProperty("cwd");
      expect([a.granted, a.direct]).toEqual([true, true]);
      expect((await get(x.b, `repo=acme/app&pr=12&taskId=${t.id}&head=${OTHER}`).then(j)).granted).toBe(false);
      // without a Task and a head there is nothing to ask the grant with
      expect((await get(x.b, "repo=acme/app&pr=12").then(j))).toMatchObject({ granted: null, direct: false });
      // the same call through the terminal's client, with the app's origin only
      const via = await mergeRecords({ BACKLOG_URL: `${x.b}/api/backlog`, BACKLOG_TOKEN_FILE: x.tokenFile }, { repo: "acme/app", prs: [12], taskId: t.id, head: HEAD });
      expect([via.jobs.length, via.granted, via.direct]).toEqual([1, true, true]);
    } finally {
      await x.stop();
    }
  });

  test("a call made while the person's reply is still being read waits for the read and then answers granted: true", async () => {
    const pendingConsent = new Map<string, Promise<void>>();
    let granted = false;
    pendingConsent.set("t1", Bun.sleep(80).then(() => void (granted = true)).finally(() => pendingConsent.delete("t1")));
    const db = { jobsOf: () => [], hasMergeGrant: () => granted, getTask: () => null, createdPullsOf: () => [] };
    const sc = { pendingConsent, settings: () => ({ judgeAndChoice: { judgeTimeoutMs: 5_000 } }), db, json: (b: unknown) => Response.json(b), bad: (m: string) => new Response(m, { status: 400 }) } as unknown as Parameters<typeof mergeRecordsRoutes>[0];
    const get = (mergeRecordsRoutes(sc)["/api/merge-records"] as { GET: (r: Request) => Promise<Response> }).GET;
    expect(await (await get(new Request(`http://x/api/merge-records?repo=o%2Fa&pr=12&taskId=t1&head=${HEAD}`))).json()).toMatchObject({ granted: true });
  });

  test("a Task that is not a direct one, or a PR the direct Task did not open, is not direct", async () => {
    const x = await boot();
    try {
      const plain = x.task("complete");
      x.opened(plain.id, 12);
      const direct = x.task("direct");
      x.opened(direct.id, 12);
      expect((await get(x.b, `repo=acme/app&pr=12&taskId=${plain.id}`).then(j)).direct).toBe(false);
      expect((await get(x.b, `repo=acme/app&pr=13&taskId=${direct.id}`).then(j)).direct).toBe(false);
      expect((await get(x.b, `repo=other/app&pr=12&taskId=${direct.id}`).then(j)).direct).toBe(false);
      expect((await get(x.b, `repo=acme/app&pr=12&taskId=${direct.id}`).then(j)).direct).toBe(true);
    } finally {
      await x.stop();
    }
  });

  test("a call without a repository, with a pr that is no positive integer or with a head that is no sha is 400", async () => {
    const x = await boot();
    try {
      for (const q of ["pr=1", "repo=a/b", "repo=a/b&pr=x", "repo=a/b&pr=0", "repo=a/b&pr=1&head=abc"]) expect([q, (await get(x.b, q)).status]).toEqual([q, 400]);
    } finally {
      await x.stop();
    }
  });
});

describe("the merge verdict reads the jobs the app ran", () => {
  const BASE = "f".repeat(40);
  /** A checkout of acme/app with one commit, and an app whose jobs run a script that leaves what the real commands leave (the result of local CI, the output of a review). */
  const boot = async (origin = "https://github.com/Acme/App.git", config?: object) => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-merge-gate-jobs-"));
    const repo = join(h, "checkout");
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
    git("init", "-q");
    git("remote", "add", "origin", origin);
    if (config) writeFileSync(join(repo, "ops.config.json"), JSON.stringify(config));
    git("commit", "-q", "--allow-empty", "-m", "root");
    const head = git("rev-parse", "HEAD");
    const jobCommand = (req: { kind: string }) => ({
      argv: ["sh", "-c", req.kind === "local-ci"
        ? `printf '{"head":"${head}","base":"${BASE}","ci":{"outcome":"pass"}}' > "$J/result.json"`
        : `mkdir -p "$(dirname "$JOB_OUT")" && printf '[codex] review\\n\\n### Findings\\n- none\\n' > "$JOB_OUT"`],
      tail: "",
    });
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter([{ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/tmp" }, { t: "session.end", status: "ok" }])], { port: 0, selfdevChecks: false, gh: NO_GH, jobCommand });
    const b = `http://127.0.0.1:${c.server.port}`;
    writeFileSync(join(h, "client-token"), "k\n");
    mkdirSync(join(repo, "_review"));
    writeFileSync(join(repo, "prompt.md"), "review it\n");
    const meta = ((await fetch(`${b}/api/workspaces`).then(j)) as Array<{ id: string; kind: string }>).find((w) => w.kind === "meta")!;
    const task = c.tasks.create({ workspaceId: meta.id, cwd: repo, title: "t", prompt: "p", runner: "claude" });
    const ask = async (body: object) => {
      const r = await fetch(`${b}/api/jobs`, { method: "POST", body: JSON.stringify({ taskId: task.id, pr: 12, cwd: repo, ...body }) });
      expect([r.status, await r.clone().text()]).toEqual([202, expect.any(String)]);
      const id = ((await r.json()) as { id: number }).id;
      for (let i = 0; i < 200 && c.db.getJob(id)!.status === "running"; i++) await Bun.sleep(25);
      return c.db.getJob(id)!;
    };
    const review = (over: object = {}) => ask({ kind: "review", promptFile: "prompt.md", outFile: "_review/out.md", ...over });
    const records = (repoName: string, prs: number[], at?: string) => mergeRecords({ MERGE_RECORDS_URL: b, MERGE_RECORDS_TOKEN_FILE: join(h, "client-token") }, { repo: repoName, prs, ...(at ? { head: at } : {}) });
    const jobs = (repoName: string, prs: number[]) => records(repoName, prs).then((r) => r.jobs);
    return { b, c, h, repo, head, ask, review, jobs, records, stop: async () => { await c.stop(); rmSync(h, { recursive: true, force: true }); } };
  };
  const view = (head: string, comments: unknown[]) => ({
    // 400 lines of a path the attacking review looks at: a size recheck, an attacking review, a main review and CI are all asked of it
    files: [{ path: "scripts/promote.ts", additions: 400, deletions: 0, changeType: "MODIFIED" }],
    baseRefName: "main", baseRefOid: BASE, body: "", headRefName: "work-a", headRefOid: head, mergeStateStatus: "CLEAN", comments,
  });
  const gh = (head: string, comments: unknown[]) => async (args: string[]) => JSON.stringify(
    args[0] === "pr" ? view(head, comments) : args[1]?.includes("/actions/runs") ? { workflow_runs: [] } : { data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } } } },
  );

  test("a job the app ran at the head lifts the reason; a comment alone does not", async () => {
    const x = await boot();
    try {
      const owner = (body: string) => ({ body, createdAt: "2026-09-24T11:30:00Z", authorAssociation: "OWNER" });
      // every mark a Task could post by hand, at the head, by the owner
      const marks = ["[codex] review\n\n### Findings\n- none", "[codex] attack\n\n### Findings\n- none", `[recheck] size pass ${x.head}`, `[local-ci] pass ${x.head} base=${BASE}`].map(owner);
      const verdict = async (comments: unknown[]) => judge(await readPr(12, gh(x.head, comments), "acme/app", { root: x.repo, url: "unused" }, undefined, x.records), { allowLarge: false });
      const before = await verdict(marks);
      expect(before.verdict).toBe("stop");
      expect(before.reasons).toHaveLength(4);
      // the jobs, as the app runs them (the command is a script that leaves what the real one leaves; everything else is the real path)
      await x.ask({ kind: "local-ci" });
      await x.review();
      await x.review({ runner: "codex", as: "attack" });
      await x.review({ runner: "claude", as: "recheck", kinds: ["size"] });
      expect(await x.jobs("acme/app", [12])).toHaveLength(4);
      expect(await verdict([])).toMatchObject({ verdict: "merge", reasons: [], recheck: [] });
      // a job of another PR is not this PR's
      expect((await judge(await readPr(13, gh(x.head, []), "acme/app", { root: x.repo, url: "unused" }, undefined, x.records), { allowLarge: false })).verdict).toBe("stop");
    } finally {
      await x.stop();
    }
  });

  /** A GitLab MR `Group/App!7` as the GitLab CLI answers it, at `head`, with nothing noted: good to merge but for what the app's jobs say. */
  const gitlabSh = (head: string) => async (cmd: string[]) => {
    const M = "projects/Group%2FApp/merge_requests/7";
    const p = cmd.at(-1)!.replace(/[?&]per_page=100&page=\d+$/, "");
    const answer = ((): unknown => {
      if (p === M) return { iid: 7, web_url: "u", state: "opened", source_branch: "sb/1-x", target_branch: "main", sha: head, diff_refs: { base_sha: BASE, head_sha: head, start_sha: BASE }, detailed_merge_status: "mergeable", head_pipeline: { sha: head, status: "success" } };
      if (p === `${M}/diffs`) return [{ old_path: "src/a.ts", new_path: "src/a.ts", diff: "@@ -1 +1,2 @@\n-a\n+b\n+c\n" }];
      if (p === `${M}/commits`) return [{ authored_date: "2026-10-28T01:00:00Z" }];
      if (p.startsWith(`${M}/notes`) || p === `${M}/discussions`) return [];
      if (p === "projects/Group%2FApp/repository/branches/main") return { commit: { id: BASE } };
      throw new Error(`fake GitLab: ${p}`);
    })();
    return JSON.stringify(answer);
  };
  const lab = { service: "gitlab", host: "gitlab.example.com", repository: "Group/App" };
  const FORGE = { forge: { service: "gitlab", host: "gitlab.example.com", project: "Group/App" } };
  const ORIGIN = "https://gitlab.example.com/Group/App.git";

  test("a review job asked from a GitLab checkout is recorded under the MR's project path and satisfies the main review of the MR the verdict reads", async () => {
    const x = await boot(ORIGIN, FORGE);
    try {
      const read = async () => readGitlabPr(7, gitlabSh(x.head), lab, undefined, x.records);
      expect((await read()).reviewed).toBeUndefined();
      const job = await x.review({ pr: 7 });
      // the writer's key is the reader's: the project path in lower case, not the empty one a checkout with no GitHub origin used to get
      expect(job.repo).toBe("group/app");
      expect((await read()).reviewed).toBe(true);
      expect(judge(await read(), { allowLarge: false }).reasons.filter((r) => r.includes("主レビュー"))).toEqual([]);
    } finally {
      await x.stop();
    }
  });

  test("the same when the checkout has no ops.config.json and the workspace keeps its forge setting on Switchboard's side", async () => {
    const x = await boot(ORIGIN);
    try {
      const ws = (await fetch(`${x.b}/api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: x.repo, backlog: "switchboard" }) }).then(j)) as Parameters<typeof writeWorkspaceConfigs>[1][number];
      writeWorkspaceConfigs(x.h, [{ ...ws, config: JSON.stringify(FORGE) }]);
      const job = await x.review({ pr: 7 });
      expect(job.repo).toBe("group/app");
      expect((await readGitlabPr(7, gitlabSh(x.head), lab, undefined, x.records)).reviewed).toBe(true);
    } finally {
      await x.stop();
    }
  });
});
