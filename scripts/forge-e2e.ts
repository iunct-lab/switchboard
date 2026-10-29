#!/usr/bin/env bun
/**
 * GitHub and GitLab chosen per repository (#892), through the daemon's own code with fake services only: a temporary
 * database, a local bare git repository, the fake GitHub of the backlog tests and a fake GitLab behind a fake glab. No
 * runner, no network: every gh / glab call goes to a fake, and the run fails if one names another host.
 * `env -u SWITCHBOARD_SUPERVISED bun scripts/forge-e2e.ts` → each case and whether it passed; exit 0 = all passed.
 * docs/design/forge-integration.md.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BacklogIssueData, BacklogSource } from "@switchboard/protocol";
import { Db } from "../packages/core/src/db.ts";
import { answerStoredDecision, createStoredIssue, editStoredIssue, readStoredBacklog, type GhRunner } from "../packages/core/src/backlog.ts";
import { sendGithubOperations } from "../packages/core/src/backlog-send.ts";
import { BacklogSync } from "../packages/core/src/backlog-sync.ts";
import { fakeGithub } from "../packages/core/src/backlog-fake-github.ts";
import { forgeOf } from "../ops-kit/src/forge.ts";
import { createGitlabMr, gitlabMrDiscussions, resolveGitlabDiscussion, startGitlabDiscussion } from "../ops-kit/src/forge-gitlab.ts";
import { main as mergeGate } from "./merge-gate.ts";
import { reportResult } from "./local-ci.ts";

const HOST = "gitlab.example.com";
const LAB_KEY = { service: "gitlab" as const, host: HOST, repository: "group/app" };
const HUB: BacklogSource = { service: "github", host: "github.com", repository: "acme/app", project: { owner: "acme", number: 1 } };

/** A fake GitLab (REST API v4) behind glab: Issues with notes, one MR with discussions and notes, and every write. */
function fakeGitlab(head: () => string, base: () => string) {
  type Issue = { id: number; iid: number; title: string; description: string; state: "opened" | "closed"; labels: string[]; updated_at: string; notes: Array<{ id: number; body: string; system: boolean; created_at: string }> };
  const issues = new Map<number, Issue>([[12, { id: 9001, iid: 12, title: "GitLab の PBI", description: "本文", state: "opened", labels: ["type:pbi"], updated_at: "2026-10-01T00:00:00Z", notes: [] }]]);
  const mr = { notes: [] as Array<{ id: number; body: string; created_at: string; system: boolean; author: { id: number } }>, discussions: [] as Array<{ id: string; notes: Array<{ id: number; body: string; resolvable: boolean; resolved: boolean; system: boolean }> }>, merged: false, made: false };
  const writes: string[] = [];
  const hosts = new Set<string>();
  let lose: string | null = null;
  let next = 9100;
  let clock = Date.parse("2026-10-02T00:00:00Z");
  const at = () => new Date((clock += 1000)).toISOString();
  const raw = (i: Issue) => ({ id: i.id, iid: i.iid, title: i.title, description: i.description, state: i.state, labels: i.labels, milestone: null, web_url: `https://${HOST}/group/app/-/issues/${i.iid}`, created_at: "2026-10-01T00:00:00Z", updated_at: i.updated_at, closed_at: null });
  const mrRaw = () => ({ iid: 7, web_url: `https://${HOST}/group/app/-/merge_requests/7`, state: mr.merged ? "merged" : "opened", source_branch: "sb/13-share", target_branch: "main", sha: head(), diff_refs: { base_sha: base(), head_sha: head(), start_sha: base() }, detailed_merge_status: mr.discussions.some((d) => d.notes.some((n) => n.resolvable && !n.resolved)) ? "discussions_not_resolved" : "mergeable", head_pipeline: null });
  const glab = async (cmd: string[]) => {
    if (cmd[0] !== "glab" || cmd[1] !== "api" || cmd[2] !== "--hostname") throw new Error(`not glab api: ${cmd.join(" ")}`);
    hosts.add(cmd[3]!);
    const m = cmd[cmd.indexOf("-X") + 1]!;
    const path = cmd.at(-1)!.replace("projects/group%2Fapp", "");
    const f: Record<string, string> = {};
    cmd.forEach((a, k) => cmd[k - 1] === "-f" && (f[a.slice(0, a.indexOf("="))] = a.slice(a.indexOf("=") + 1)));
    const bare = path.replace(/[?].*/, "");
    if (m !== "GET") writes.push(`${m} ${bare}`);
    const page1 = !/[?&]page=([2-9]|\d\d)/.test(path);
    const answer = ((): unknown => {
      if (m === "GET" && bare === "/issues") return page1 ? [...issues.values()].filter((i) => path.includes(`state=${i.state}`) || !path.includes("state=")).map(raw) : [];
      const one = /^\/issues\/(\d+)(\/notes)?$/.exec(bare);
      if (one) {
        const i = issues.get(Number(one[1]))!;
        if (one[2] && m === "POST") return i.notes.push({ id: next++, body: f.body!, system: false, created_at: at() }), (i.updated_at = at()), i.notes.at(-1);
        if (one[2]) return page1 ? [...i.notes] : [];
        if (m === "PUT") {
          if (f.title) i.title = f.title;
          if (f.description !== undefined) i.description = f.description;
          if (f.add_labels) i.labels.push(f.add_labels);
          i.updated_at = at();
        }
        return raw(i);
      }
      if (m === "POST" && bare === "/issues") {
        const iid = Math.max(...issues.keys()) + 1;
        issues.set(iid, { id: next++, iid, title: f.title!, description: f.description!, state: "opened", labels: f.labels ? f.labels.split(",") : [], updated_at: at(), notes: [] });
        return raw(issues.get(iid)!);
      }
      if (m === "POST" && bare === "/merge_requests") return (mr.made = true), mrRaw();
      if (bare === "/merge_requests/7") return mrRaw();
      if (bare === "/merge_requests/7/diffs") return page1 ? [{ old_path: "a.ts", new_path: "a.ts", diff: "@@ -1 +1 @@\n-a\n+b\n" }] : [];
      if (bare === "/merge_requests/7/commits") return page1 ? [{ authored_date: "2026-10-01T12:00:00Z" }] : [];
      if (bare === "/merge_requests/7/notes" && m === "POST") return mr.notes.push({ id: next++, body: f.body!, created_at: at(), system: false, author: { id: 1 } }), mr.notes.at(-1);
      if (bare === "/merge_requests/7/notes") return page1 ? mr.notes : [];
      if (bare === "/merge_requests/7/discussions" && m === "POST") {
        const d = { id: (next++).toString(16).padStart(40, "0"), notes: [{ id: next++, body: f.body!, resolvable: true, resolved: false, system: false }] };
        mr.discussions.push(d);
        // the review's summary goes on the MR as a note too, as the review step posts it
        mr.notes.push({ id: next++, body: "[codex] review\n\n### Verdict\nmergeable after the should-fix items", created_at: at(), system: false, author: { id: 1 } });
        return d;
      }
      if (bare === "/merge_requests/7/discussions") return page1 ? mr.discussions : [];
      const res = /^\/merge_requests\/7\/discussions\/([0-9a-f]+)$/.exec(bare);
      if (res) {
        const d = mr.discussions.find((x) => x.id === res[1])!;
        d.notes.forEach((n) => (n.resolved = true));
        return d;
      }
      if (/^\/members\/all\/\d+$/.test(bare)) return { access_level: 40 };
      if (bare === "/repository/branches/main") return { commit: { id: base() } };
      if (bare === "/merge_requests/7/merge") {
        if (f.sha !== head()) throw new Error("glab: 409 SHA does not match HEAD of source branch (HTTP 409)");
        return (mr.merged = true), { state: "merged" };
      }
      throw new Error(`fake GitLab: no ${m} ${path}`);
    })();
    if (lose && `${m} ${bare}` === lose) {
      lose = null;
      throw new Error("glab: 502 Bad Gateway (HTTP 502)");
    }
    return JSON.stringify(answer);
  };
  return { issues, mr, writes, hosts, glab, loseNext: (call: string) => void (lose = call) };
}

const sh = (cwd: string, ...a: string[]) => {
  const r = Bun.spawnSync(["git", "-C", cwd, ...a], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.com", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.com" } });
  if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString().trim()}`);
  return r.stdout.toString().trim();
};
function ok(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(what);
}

export async function run(log = console.log): Promise<boolean> {
  const home = mkdtempSync(join(tmpdir(), "forge-e2e-"));
  const db = new Db(join(home, "switchboard.db"));
  let t = 1_000_000;
  const clock = () => (t += 1000);
  const results: Array<{ name: string; ok: boolean; why?: string }> = [];
  const step = async (name: string, fn: () => Promise<void> | void) => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, why: String((e as Error)?.message ?? e).slice(0, 300) });
    }
  };
  // the GitLab checkout: its origin is the project its forge names; branches go with plain git to a local bare repository
  const lab = join(home, "lab");
  const hub = join(home, "hub");
  sh(home, "init", "-q", "--bare", join(home, "remote.git"));
  for (const d of [lab, hub]) sh(home, "init", "-q", "-b", "main", d);
  sh(lab, "remote", "add", "origin", `git@${HOST}:group/app.git`);
  sh(lab, "remote", "add", "local", join(home, "remote.git"));
  sh(hub, "remote", "add", "origin", "https://github.com/acme/app.git");
  writeFileSync(join(lab, "ops.config.json"), JSON.stringify({ forge: { service: "gitlab", host: HOST, project: "group/app" } }));
  writeFileSync(join(lab, "a.ts"), "a\n");
  sh(lab, "add", "a.ts", "ops.config.json");
  sh(lab, "commit", "-q", "-m", "a");
  const base = sh(lab, "rev-parse", "HEAD");
  sh(lab, "push", "-q", "local", "main");
  let head = base;
  const g = fakeGitlab(() => head, () => base);
  const github = fakeGithub(() => t);
  const ghCalls: string[][] = [];
  const gh: GhRunner = async (args, cwd) => (ghCalls.push(args), github.gh(args, cwd));
  const labWs = db.upsertWorkspace({ name: "lab", path: lab, kind: "repo" });
  const hubWs = db.upsertWorkspace({ name: "hub", path: hub, kind: "repo" });
  const sync = new BacklogSync(db, async (a) => {
    throw new Error(`gh asked during the GitLab import: ${a.join(" ")}`);
  }, clock, undefined, false);
  sync.glab = g.glab;
  /** The fake GitHub answering an import's reads too (as backlog-send.test.ts's importsToo), from the same Issues. */
  const importing: GhRunner = async (args, cwd) => {
    const raw = (i: { node_id: string; number: number; title: string; body: string; state: string; labels: string[] }) => ({ id: i.node_id, number: i.number, title: i.title, url: "", state: i.state, body: i.body, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-03T00:00:00Z", milestone: null, parent: null,
      labels: { totalCount: i.labels.length, nodes: i.labels.map((name) => ({ name })) }, subIssues: { totalCount: 0, nodes: [] }, comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] }, projectItems: { totalCount: 0, nodes: [] } });
    const page = (nodes: unknown[]) => ({ code: 0, stdout: JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes }, pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }), stderr: "" });
    if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
    if (args[0] === "variable") return { code: 0, stdout: "https://github.com/orgs/acme/projects/1\n", stderr: "" };
    const q = args.find((a) => a.startsWith("query=")) ?? "";
    if (q.includes("states:[OPEN,CLOSED]")) return page([...github.issues.values()].filter((i) => i.labels.some((l) => l.startsWith("type:"))).map(raw));
    if (q.includes("states:OPEN")) return page([]);
    if (q.includes("issueOrPullRequest")) return { code: 0, stdout: JSON.stringify({ data: { repository: Object.fromEntries([...q.matchAll(/w(\d+): /g)].map((m) => [`w${m[1]}`, { __typename: "Issue", ...raw(github.issues.get(Number(m[1]))!) }])) } }), stderr: "" };
    return github.gh(args, cwd);
  };
  const labIssue = (n: number) => db.listBacklogRecords(LAB_KEY, "issue").find((r) => (r.remote as BacklogIssueData | null)?.number === n);

  try {
    await step("GitLab の Issue を glab で取り込み、GitHub の #12 と混ざらない", async () => {
      const twelve: BacklogIssueData = { number: 12, title: "PBI", url: "", state: "OPEN", stateReason: null, body: "本文", labels: ["type:pbi", "needs-decision"], milestone: null, parent: null, subIssues: [], createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", closedAt: null };
      db.putBacklogSnapshot(HUB, { records: [{ objectKind: "issue", externalId: "I_12", remote: twelve, fetchState: "fetched" }, { objectKind: "issue", externalId: "I_3", remote: { ...twelve, number: 3, title: "親", labels: ["type:pbi"] }, fetchState: "fetched" }], cursor: null, syncedAt: 1 });
      db.setWorkspaceBacklogSource(hubWs.id, HUB);
      await sync.sync(labWs);
      ok(labIssue(12)?.externalId === "gitlab:issue:9001", "GitLab の #12 が保存されていない");
      const titles = (ws: { id: string; name: string; path: string }) => readStoredBacklog(db, ws).items.map((i) => `${i.number} ${i.title}`);
      ok(JSON.stringify(titles(labWs)) === JSON.stringify(["12 GitLab の PBI"]), `lab: ${titles(labWs)}`);
      ok(titles(hubWs).includes("12 PBI") && !titles(hubWs).some((x) => x.includes("GitLab")), `hub: ${titles(hubWs)}`);
    });

    await step("両側の編集: 送れる編集は送り、GitLab 側で変わった値は conflict で何も書かない（GitHub も同じ）", async () => {
      const source = db.getWorkspaceBacklogSource(labWs.id)!;
      editStoredIssue(db, source, 12, { title: "直した題" });
      await sendGithubOperations(gh, db, lab, source, clock, undefined, undefined, undefined, g.glab);
      ok(g.issues.get(12)!.title === "直した題", `GitLab の題: ${g.issues.get(12)!.title}`);
      editStoredIssue(db, source, 12, { body: "手元の本文" });
      g.issues.get(12)!.description = "GitLab で書いた本文";
      const before = g.writes.length;
      await sendGithubOperations(gh, db, lab, source, clock, undefined, undefined, undefined, g.glab);
      ok(db.listPendingBacklogOperations(source).some((o) => o.field === "body" && o.status === "conflict"), "GitLab の body が conflict にならない");
      ok(g.writes.length === before, "conflict なのに書いた");
      editStoredIssue(db, HUB, 12, { title: "GitHub で直した題" });
      await sendGithubOperations(gh, db, hub, HUB, clock);
      ok(github.issues.get(12)!.title === "GitHub で直した題", "GitHub に送られない");
      editStoredIssue(db, HUB, 12, { body: "手元の本文" });
      github.issues.get(12)!.body = "GitHub で書いた本文";
      await sendGithubOperations(gh, db, hub, HUB, clock);
      ok(db.listPendingBacklogOperations(HUB).some((o) => o.field === "body" && o.status === "conflict"), "GitHub の body が conflict にならない");
      ok(github.issues.get(12)!.body === "GitHub で書いた本文", "GitHub の conflict で書いた");
    });

    await step("コメントの答えを失っても印で見つけ、二重に投稿しない", async () => {
      const source = db.getWorkspaceBacklogSource(labWs.id)!;
      db.sqlite.query("DELETE FROM backlog_operations WHERE service = 'gitlab'").run();
      answerStoredDecision(db, source, 12, "A で");
      g.loseNext("POST /issues/12/notes");
      await sendGithubOperations(gh, db, lab, source, clock, undefined, undefined, undefined, g.glab);
      ok(db.listPendingBacklogOperations(source).some((o) => o.kind === "comment" && o.status === "unknown"), "答えを失ったコメントが unknown でない");
      await sendGithubOperations(gh, db, lab, source, clock, undefined, undefined, undefined, g.glab);
      ok(g.issues.get(12)!.notes.length === 1, `note が ${g.issues.get(12)!.notes.length} 件`);
      ok(!db.listPendingBacklogOperations(source).some((o) => o.kind === "comment"), "コメントが送信待ちに残る");
    });

    await step("GitHub も同じ: コメントと作成の答えを失っても印で見つけ、二重に送らない", async () => {
      // on #3: #12's held conflict holds what comes after it on #12
      answerStoredDecision(db, HUB, 3, "GitHub で A");
      github.fail.push({ match: (a) => a[1]!.endsWith("/comments") && a.includes("POST"), status: 502, after: true });
      await sendGithubOperations(gh, db, hub, HUB, clock);
      ok(db.listPendingBacklogOperations(HUB).some((o) => o.kind === "comment" && o.status === "unknown"), "GitHub のコメントが unknown でない");
      await sendGithubOperations(gh, db, hub, HUB, clock);
      ok(github.issues.get(3)!.comments.length === 1, `GitHub のコメントが ${github.issues.get(3)!.comments.length} 件`);
      createStoredIssue(db, HUB, { title: "GitHub の Task", body: "", labels: ["type:task"], milestone: null, parent: null, fields: null });
      github.fail.push({ match: (a) => a[1] === "repos/acme/app/issues" && a.includes("POST"), status: 502, after: true });
      await sendGithubOperations(gh, db, hub, HUB, clock);
      ok(db.listPendingBacklogOperations(HUB).some((o) => o.kind === "create" && o.status === "unknown"), "GitHub の作成が unknown でない");
      await sendGithubOperations(gh, db, hub, HUB, clock);
      ok([...github.issues.values()].filter((i) => i.title === "GitHub の Task").length === 1, "GitHub の作成が 1 件でない");
      ok(!db.listPendingBacklogOperations(HUB).some((o) => o.kind !== "set" && o.status !== "done"), "GitHub の作成・コメントが送信待ちに残る");
    });

    await step("Issue の作成の答えを失っても印で見つけ、二重に作らない", async () => {
      const source = db.getWorkspaceBacklogSource(labWs.id)!;
      createStoredIssue(db, source, { title: "Task: 共有の API", body: "## 親 PBI\n#12", labels: ["type:task"], milestone: null, parent: 12, fields: null });
      g.loseNext("POST /issues");
      await sendGithubOperations(gh, db, lab, source, clock, undefined, undefined, undefined, g.glab);
      ok(db.listPendingBacklogOperations(source).some((o) => o.kind === "create" && o.status === "unknown"), "答えを失った作成が unknown でない");
      await sendGithubOperations(gh, db, lab, source, clock, undefined, undefined, undefined, g.glab);
      ok([...g.issues.values()].filter((i) => i.title === "Task: 共有の API").length === 1, "作成が 1 件でない");
      ok(!db.listPendingBacklogOperations(source).some((o) => o.kind === "create"), "作成が送信待ちに残る");
      // the next import reads it with its parent from the body
      await sync.sync(labWs);
      ok(labIssue(13) && (labIssue(13)!.remote as BacklogIssueData).parent === 12 && (labIssue(12)!.remote as BacklogIssueData).subIssues.includes(13), "作った Issue の親が読めない");
    });

    await step("git で push した枝から GitLab の MR を作り、discussion を始めて resolve する", async () => {
      sh(lab, "checkout", "-q", "-b", "sb/13-share");
      writeFileSync(join(lab, "a.ts"), "b\n");
      sh(lab, "commit", "-q", "-am", "b");
      head = sh(lab, "rev-parse", "HEAD");
      sh(lab, "push", "-q", "local", "sb/13-share");
      ok(sh(join(home, "remote.git"), "rev-parse", "sb/13-share") === head, "bare に push されていない");
      const made = await createGitlabMr(g.glab, LAB_KEY, { source: "sb/13-share", target: "main", title: "Task #13", description: "Closes #13" });
      ok(made.iid === 7 && made.head === head, "MR の head が push した sha でない");
      const id = await startGitlabDiscussion(g.glab, LAB_KEY, 7, "[codex] - [should-fix] `a.ts:1` — x", { path: "a.ts", line: 1 });
      ok((await gitlabMrDiscussions(g.glab, LAB_KEY, 7)).some((d) => d.id === id && !d.resolved), "discussion が未解決で読めない");
    });

    await step("未解決の discussion はマージを止め、ローカル CI の合格を MR に知らせ、resolve の後は判定した head だけをマージする", async () => {
      const quiet = () => undefined;
      const noGh = async (a: string[]) => {
        throw new Error(`gh asked for a GitLab MR: ${a.join(" ")}`);
      };
      const gate = async () => {
        const out: string[] = [];
        const code = await mergeGate(["7", "--merge"], noGh, (s) => out.push(s), quiet, () => undefined, g.glab, lab);
        return { code, out: out.join("\n") };
      };
      const post = (body: string) => reportResult({ pr: 7, repo: "group/app", root: lab }, body, async (c) => {
        throw new Error(`gh asked: ${c.join(" ")}`);
      }, g.glab);
      // a pass of an older head is no CI of this one
      await post(`[local-ci] pass ${base} base=${base}`);
      const stale = await gate();
      ok(stale.code === 1 && stale.out.includes("CI のチェックが 1 つも無い") && !g.mr.merged, "古い head の合格で止まらない");
      await post(`[local-ci] pass ${head} base=${base}`);
      ok(g.mr.notes.some((n) => n.body === `[local-ci] pass ${head} base=${base}`), "ローカル CI の結果が MR に無い");
      // CI passes now: what stops it is the open discussion, and nothing is merged
      const open = await gate();
      ok(open.code === 1 && open.out.includes("解決していないレビュースレッドが 1 件") && !open.out.includes("CI のチェック") && !g.mr.merged, `未解決で止まる理由が違う: ${open.out.slice(0, 200)}`);
      ok(!g.writes.includes("PUT /merge_requests/7/merge"), "止めたのにマージを頼んだ");
      for (const d of await gitlabMrDiscussions(g.glab, LAB_KEY, 7)) await resolveGitlabDiscussion(g.glab, LAB_KEY, 7, d.id);
      // the review summary (posted with the discussion) is older than no commit since: the gate counts it
      ok((await mergeGate(["7", "--merge"], noGh, quiet, (s) => log(`  ${s}`), () => undefined, g.glab, lab)) === 0, "resolve の後にマージされない");
      ok(g.mr.merged, "GitLab がマージしていない");
    });

    await step("GitHub の設定に戻しても、GitLab の保存データは消えず、GitHub の workspace は今までどおり読める", async () => {
      const kept = db.listBacklogRecords(LAB_KEY).length;
      const hubKept = db.listBacklogRecords(HUB).length;
      writeFileSync(join(lab, "ops.config.json"), JSON.stringify({}));
      ok(forgeOf(lab) === "github", "forge が github に戻らない");
      // the next import of that checkout reads GitHub, never GitLab, and the checkout reads GitHub's records
      const asked: string[][] = [];
      const back = new BacklogSync(db, async (a, cwd) => (asked.push(a), importing(a, cwd)), clock, undefined, false);
      const labCalls = g.hosts.size + g.writes.length;
      back.glab = g.glab;
      await back.sync(labWs).catch(() => undefined);
      back.stop();
      ok(asked.length > 0 && asked[0]![0] === "repo", `GitHub に聞いていない: ${JSON.stringify(asked[0])}`);
      ok(db.getWorkspaceBacklogSource(labWs.id)?.service === "github", `source が GitHub に戻らない: ${db.getWorkspaceBacklogSource(labWs.id)?.service}`);
      ok(readStoredBacklog(db, labWs).items.some((i) => i.number === 12 && i.title === github.issues.get(12)!.title), "戻した checkout が GitHub の #12 を読まない");
      ok(g.hosts.size + g.writes.length === labCalls, "GitHub に戻したのに GitLab に書いた");
      ok(db.listBacklogRecords(LAB_KEY).length === kept, "GitLab の記録が消えた");
      ok(readStoredBacklog(db, hubWs).items.some((i) => i.number === 12) && db.listBacklogRecords(HUB).length >= hubKept, "GitHub の workspace が読めない");
    });

    await step("外への接続 0: gh と glab は偽のものだけで、glab は GitLab の host だけ", () => {
      ok([...g.hosts].every((h) => h === HOST), `glab の host: ${[...g.hosts]}`);
      ok(ghCalls.length > 0 && ghCalls.every((a) => a[0] === "api"), "gh の呼び出しが偽の GitHub の外");
    });
  } finally {
    sync.stop();
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
  for (const r of results) log(`${r.ok ? "pass" : "FAIL"}  ${r.name}${r.why ? `\n      ${r.why}` : ""}`);
  log(`${results.filter((r) => r.ok).length} / ${results.length} pass`);
  return results.every((r) => r.ok);
}

if (import.meta.main) process.exit((await run()) ? 0 : 1);
