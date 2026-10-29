import { describe, expect, test } from "bun:test";
import { createGitlabMr, gitlabAuth, GitlabError, gitlabMrDiscussions, resolveGitlabDiscussion, startGitlabDiscussion, viewGitlabMr, gitlabId, glabApi, parentIn, projectPath, readGitlabIssue, readGitlabIssues, readGitlabNotes, statusOf } from "./forge-gitlab.ts";
import { ForgeRefused, type ForgeTarget } from "./forge.ts";

// GitLab through the signed-in glab (#892): only glab is run, on the target's host; no login is kept or printed.

const lab: ForgeTarget = { service: "gitlab", host: "gitlab.example.com", repository: "group/sub/app" };

describe("forge-gitlab", () => {
  test("a call is `glab api` on the target's host and project, never gh", async () => {
    const calls: string[][] = [];
    const sh = async (cmd: string[]) => (calls.push(cmd), cmd.includes("POST") ? '{"iid":3}' : "[]");
    expect(await glabApi(sh, lab, `${projectPath(lab)}/issues?per_page=100`)).toEqual([]);
    expect(await glabApi(sh, lab, `${projectPath(lab)}/issues`, { method: "POST", fields: { title: "t", description: "a=b" } })).toEqual({ iid: 3 });
    // a read with fields stays a read (glab would make it a POST)
    await glabApi(sh, lab, `${projectPath(lab)}/issues`, { method: "GET", fields: { state: "opened" } });
    expect(calls).toEqual([
      ["glab", "api", "--hostname", "gitlab.example.com", "-X", "GET", "projects/group%2Fsub%2Fapp/issues?per_page=100"],
      ["glab", "api", "--hostname", "gitlab.example.com", "-X", "POST", "-f", "title=t", "-f", "description=a=b", "projects/group%2Fsub%2Fapp/issues"],
      ["glab", "api", "--hostname", "gitlab.example.com", "-X", "GET", "-f", "state=opened", "projects/group%2Fsub%2Fapp/issues"],
    ]);
    expect(calls.every((c) => c[0] === "glab")).toBe(true);
    expect(() => projectPath({ service: "github", host: "github.com", repository: "group/app" })).toThrow("project");
    expect(() => projectPath({ ...lab, repository: null })).toThrow("project");
  });

  test("not signed in is said as the fact the person acts on, without what glab printed", async () => {
    const token = "glpat-" + "x".repeat(20);
    const out = await gitlabAuth(async () => {
      throw new Error(`gitlab.example.com\n  x Token: ${token}\n  401 Unauthorized`);
    }, lab);
    expect(out).toEqual({ ok: false, reason: "gitlab.example.com の glab にログインしていません（glab auth login --hostname gitlab.example.com は利用者が行う）" });
    expect(JSON.stringify(out)).not.toContain(token);
    const calls: string[][] = [];
    expect(await gitlabAuth(async (cmd) => (calls.push(cmd), `Logged in to gitlab.example.com\nToken: ${token}`), lab)).toEqual({ ok: true });
    expect(calls).toEqual([["glab", "auth", "status", "--hostname", "gitlab.example.com"]]);
  });

  test("a stored id is the instance-wide id with its kind: an Issue's and a note's id 7 are two records", () => {
    expect(gitlabId("issue", 7)).toBe("gitlab:issue:7");
    expect(gitlabId("note", 7)).not.toBe(gitlabId("issue", 7));
  });
});

const fixture = require("../fixtures/gitlab-issues.json") as { opened: unknown[]; closed: unknown[]; notes: Record<string, unknown[]> };

/** A fake glab answering GitLab's REST paths from `routes` (a path's answer, or a status it fails with). */
function fakeGlab(routes: (path: string) => unknown | { status: number }) {
  const calls: string[][] = [];
  const sh = async (cmd: string[]) => {
    calls.push(cmd);
    const got = routes(cmd[cmd.length - 1]!);
    if (got && typeof got === "object" && "status" in got) throw new Error(`glab: ${got.status} Not Found (HTTP ${got.status})`);
    return JSON.stringify(got);
  };
  return { sh, calls };
}

describe("forge-gitlab read (#892)", () => {
  const P = "projects/group%2Fapp";
  const app: ForgeTarget = { ...lab, repository: "group/app" };
  test("the Issues of a state, every page, as the backlog stores them; notes without GitLab's own", async () => {
    const many = Array.from({ length: 100 }, (_, k) => ({ ...(fixture.opened[1] as object), id: 1000 + k, iid: 100 + k }));
    const { sh, calls } = fakeGlab((p) => (p.includes("state=opened") ? (p.endsWith("page=1") ? many : fixture.opened) : p.includes("/notes") ? fixture.notes["12"] : []));
    const open = await readGitlabIssues(sh, app, "opened", null);
    expect(open).toHaveLength(103);
    expect(open[100]).toEqual({
      id: "gitlab:issue:9001", number: 12, title: "PBI: 予定を共有する", url: "https://gitlab.example.com/group/app/-/issues/12", state: "OPEN", stateReason: null,
      body: "## ユーザーストーリー\n共有したい\n\n## Tasks\n#13", labels: ["type:pbi", "Ready"], milestone: "Phase 2", parent: undefined,
      createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z", closedAt: null,
    });
    expect(open[101]).toMatchObject({ number: 13, parent: 12, milestone: null });
    expect(open[102]).toMatchObject({ number: 14, body: "" });
    await readGitlabIssues(sh, app, "closed", "2026-10-02T00:00:00Z");
    expect(await readGitlabNotes(sh, app, 12)).toEqual([{ id: "gitlab:note:501", issue: 12, body: "## 回答\nA でよい", createdAt: "2026-10-02T00:00:00.000Z" }]);
    expect(calls.map((c) => c.slice(4).join(" "))).toEqual([
      `-X GET ${P}/issues?state=opened&order_by=updated_at&sort=asc&per_page=100&page=1`,
      `-X GET ${P}/issues?state=opened&order_by=updated_at&sort=asc&per_page=100&page=2`,
      `-X GET ${P}/issues?state=closed&order_by=updated_at&sort=asc&updated_after=2026-10-02T00%3A00%3A00Z&per_page=100&page=1`,
      `-X GET ${P}/issues/12/notes?sort=asc&order_by=created_at&per_page=100&page=1`,
    ]);
  });

  test("one Issue by number: 404 is unavailable, 403 forbidden, anything else fails; a closed one is completed", async () => {
    const { sh } = fakeGlab((p) => (p.endsWith("/issues/11") ? fixture.closed[0] : p.endsWith("/issues/40") ? { status: 404 } : p.endsWith("/issues/41") ? { status: 403 } : { status: 502 }));
    expect(await readGitlabIssue(sh, app, 11)).toMatchObject({ state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-10-02T12:00:00.000Z" });
    expect(await readGitlabIssue(sh, app, 40)).toBe("unavailable");
    expect(await readGitlabIssue(sh, app, 41)).toBe("forbidden");
    await expect(readGitlabIssue(sh, app, 42)).rejects.toThrow("502");
    const odd = fakeGlab(() => ({ id: 1, iid: 2, state: "locked" }));
    await expect(readGitlabIssue(odd.sh, app, 2)).rejects.toThrow("形が想定と違います");
    expect(statusOf(new GitlabError("x", 409))).toBe(409);
    expect(parentIn("## 親 PBI\n\n親は #7 です")).toBe(7);
    expect(parentIn("## 親 PBI\n- なし")).toBeNull();
    expect(parentIn("## Tasks\n#3")).toBeUndefined();
    expect(parentIn("## 親 PBI\r\n\r\n#7\r\n")).toBe(7);
  });
});

describe("forge-gitlab merge requests (#923)", () => {
  const mrs = require("../fixtures/gitlab-merge-requests.json") as { mr: Record<string, unknown>; discussions: Array<{ id: string; notes: Array<Record<string, unknown>> }> };
  const app: ForgeTarget = { ...lab, repository: "group/app" };
  const P = "projects/group%2Fapp/merge_requests";

  test("a branch pushed with git becomes GitLab's own MR; its discussions are read, started on a line and resolved there", async () => {
    // the branch goes with plain git, to a bare repository standing in for the GitLab remote
    const home = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "ops-kit-mr-"));
    const git = (...a: string[]) => {
      const r = Bun.spawnSync(["git", ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
      if (r.exitCode !== 0) throw new Error(r.stderr.toString());
      return r.stdout.toString().trim();
    };
    try {
      git("init", "-q", "--bare", `${home}/remote.git`);
      git("init", "-q", "-b", "main", `${home}/app`);
      require("node:fs").writeFileSync(`${home}/app/a.ts`, "export const a = 1;\n");
      git("-C", `${home}/app`, "add", "a.ts");
      git("-C", `${home}/app`, "commit", "-q", "-m", "a");
      git("-C", `${home}/app`, "remote", "add", "origin", `${home}/remote.git`);
      git("-C", `${home}/app`, "push", "-q", "origin", "main:sb/13-share");
      expect(git("--git-dir", `${home}/remote.git`, "branch", "--list", "sb/13-share")).toContain("sb/13-share");
    } finally {
      require("node:fs").rmSync(home, { recursive: true, force: true });
    }
    const discussions = structuredClone(mrs.discussions);
    const { sh, calls } = fakeGlab((p) => {
      if (p === P) return mrs.mr;
      if (p === `${P}/7`) return mrs.mr;
      if (p.startsWith(`${P}/7/discussions?`)) return discussions;
      if (p.startsWith(`${P}/7/diffs?`)) return [{ old_path: "old/a.ts", new_path: "a.ts", diff: "@@ -0,0 +1 @@\n+export const a = 1;\n" }];
      if (p === `${P}/7/discussions`) return { id: "bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11", notes: [] };
      if (p === `${P}/7/discussions/6a9c1750b37d513a43987b574953fceb50b03ce7?resolved=true`) return { ...discussions[0], notes: discussions[0]!.notes.map((n) => ({ ...n, resolved: true })) };
      return { status: 404 };
    });
    const made = await createGitlabMr(sh, app, { source: "sb/13-share", target: "main", title: "Task #13", description: "Closes #13" });
    expect(made).toEqual({ iid: 7, url: "https://gitlab.example.com/group/app/-/merge_requests/7", state: "opened", draft: false, source: "sb/13-share", target: "main", head: "1".repeat(40), base: "2".repeat(40), mergeStatus: "discussions_not_resolved" });
    expect(await viewGitlabMr(sh, app, 7)).toEqual(made);
    const read = await gitlabMrDiscussions(sh, app, 7);
    // GitLab's own note is no discussion; a thread is resolved only when every resolvable note is
    expect(read.map((d) => [d.id.slice(0, 6), d.resolvable, d.resolved, d.notes.map((n) => [n.id, n.author, n.path, n.line, n.oldPath, n.oldLine])])).toEqual([
      ["6a9c17", true, false, [[801, "reviewer", "src/a.ts", 3, "src/a.ts", null], [802, "author", "src/a.ts", 3, "src/a.ts", null]]],
      ["87805b", false, false, [[803, "reviewer", null, null, null, null]]],
      // a removed line has only the old side
      ["cc22cc", true, false, [[805, "reviewer", "src/b.ts", null, "src/b.ts", 9]]],
    ]);
    expect(await startGitlabDiscussion(sh, app, 7, "[codex] - [nit] `a.ts:1` — x", { path: "a.ts", line: 1 })).toBe("bb11bb11bb11bb11bb11bb11bb11bb11bb11bb11");
    await resolveGitlabDiscussion(sh, app, 7, "6a9c1750b37d513a43987b574953fceb50b03ce7");
    const posted = calls.find((c) => c.includes("POST") && c.at(-1) === `${P}/7/discussions`)!;
    expect(posted.filter((a, k) => posted[k - 1] === "-f")).toEqual(["body=[codex] - [nit] `a.ts:1` — x", "position[position_type]=text", `position[base_sha]=${"2".repeat(40)}`, `position[start_sha]=${"2".repeat(40)}`, `position[head_sha]=${"1".repeat(40)}`, "position[old_path]=old/a.ts", "position[new_path]=a.ts", "position[new_line]=1"]);
    // a file the MR does not change has no line to start on
    await expect(startGitlabDiscussion(sh, app, 7, "x", { path: "z.ts", line: 1 })).rejects.toThrow("z.ts は !7 の差分にありません");
    expect(calls.find((c) => c.includes("POST") && c.at(-1) === P)!.filter((a, k) => calls[0]![k - 1] === "-f")).toEqual(["source_branch=sb/13-share", "target_branch=main", "title=Task #13", "description=Closes #13"]);
    // a resolve GitLab did not take, and an id that is none, are said
    await expect(resolveGitlabDiscussion(fakeGlab(() => discussions[0]).sh, app, 7, "6a9c1750b37d513a43987b574953fceb50b03ce7")).rejects.toThrow("resolve にならなかった");
    await expect(resolveGitlabDiscussion(sh, app, 7, "../../x")).rejects.toThrow("discussion の id ではありません");
    expect(calls.every((c) => c[0] === "glab")).toBe(true);
  });

  test("what carries a value that signs in is not posted to the MR", async () => {
    const { sh, calls } = fakeGlab(() => mrs.mr);
    await expect(createGitlabMr(sh, app, { source: "a", target: "main", title: "t", description: `token ghp_${"b".repeat(36)}` })).rejects.toBeInstanceOf(ForgeRefused);
    await expect(startGitlabDiscussion(sh, app, 7, `ghp_${"a".repeat(36)}`)).rejects.toBeInstanceOf(ForgeRefused);
    expect(calls).toEqual([]);
  });
});
