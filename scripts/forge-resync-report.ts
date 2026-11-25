// A supporting file that decides no verdict: moved out of forge-resync.ts, it only leaves on GitHub, once it is back,
// what was done locally (`--report`). It never merges and never pushes; the change list it reads (`listChanges`) stays in
// forge-resync.ts, where the push guard reads it too.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { client, readRecords, type Detail } from "../ops-kit/src/backlog-client.ts";
import { closedBy } from "./local-merge.ts";
import { githubOrigin, listChanges, spawn, unreachable, type ListedChange, type ResyncDeps } from "./forge-resync.ts";

/**
 * What is left on GitHub for a change: one line saying what happened, then the first line of each of its comments that
 * is a mark (`[<runner>] review`, `[local-ci]`, `[recheck]`, …), oldest first — as list items, so none of them reads as a
 * mark of the PR itself. The first line names the change and its commit: `report` finds it again and does not write twice.
 */
export function changeSummary(c: Pick<ListedChange, "number" | "head" | "mergeCommit">, comments: Array<{ body: string; createdAt: string }>): string {
  const first = c.mergeCommit
    ? `ローカルでマージしました（GitHub が使えなかった間。L${c.number}、${c.head}、マージコミット ${c.mergeCommit.slice(0, 7)}）`
    : `GitHub が使えなかった間のローカルの変更 L${c.number}（${c.head}）を閉じ、この PR で続けます（ローカルではマージしていません）`;
  const marks = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((x) => x.body.split("\n")[0]!.trim()).filter((l) => l.startsWith("["));
  return [first, "", ...(marks.length ? marks.map((m) => `- ${m}`) : ["- （レビュー・判定の印は無い）"])].join("\n");
}

/**
 * `--report`: after GitHub is back and has the local main, the review and judgement marks of each change merged here go
 * on the PR it stood in for (closed when GitHub did not take it as merged) or, with no PR, on the Task it closed; a change
 * that stood in for a PR and was not merged here is closed, its marks summed up on the PR. Reads the app's changes of the
 * checkout's workspace; writes with gh (a PR) or the app (a Task). Exit 0 = all left / 1 = one could not be / 2 = not run
 * (the app's changes or the checkout could not be read, or `git fetch` failed otherwise) / 4 = GitHub not reachable yet
 * (the rest waits for the next `--report`).
 */
export async function report(cwd: string, deps: ResyncDeps): Promise<number> {
  const run = deps.run ?? spawn;
  const log = deps.log ?? console.log;
  const err = deps.err ?? console.error;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  let root: string;
  let changes: ListedChange[];
  let workspaceId: string;
  let stored: Awaited<ReturnType<typeof readRecords>>;
  let apart: boolean;
  const api = client(env, deps.fetch ?? fetch);
  try {
    const top = await run(["git", "rev-parse", "--show-toplevel"], cwd);
    if (top.code !== 0) throw new Error("リポジトリの中で実行してください");
    root = top.stdout.trim();
    stored = await readRecords(env, { fresh: false, cwd: root, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    workspaceId = stored.workspaceId;
    apart = stored.service !== "switchboard";
    changes = (await listChanges(api, workspaceId)).filter((c) => c.reportedAt === null && (c.mergeCommit !== null || (c.state === "OPEN" && c.pr !== null)));
  } catch (e) {
    err(`変更を読めない: ${(e as Error).message}`);
    return 2;
  }
  if (changes.length === 0) return log(JSON.stringify({ result: "nothing", reported: [] })), 0;
  const fetched = await run(["git", "fetch", "-q", "origin", "main"], root);
  if (fetched.code !== 0) {
    const line = fetched.stderr.trim().split("\n")[0];
    err(unreachable(fetched.stderr, now()) ? `まだ GitHub に届かない（${line}）。何も書いていない` : `git fetch origin main が失敗した（${line}）。何も書いていない`);
    return unreachable(fetched.stderr, now()) ? 4 : 2;
  }
  const repo = deps.repo ?? githubOrigin(root);
  const reported: number[] = [];
  let failed = false;
  // oldest first: the order they were made in
  for (const c of [...changes].sort((a, b) => a.number - b.number)) {
    // a change merged here is reported once GitHub's main has its commit: before that the PR could not be told merged
    if (c.mergeCommit && (await run(["git", "merge-base", "--is-ancestor", c.mergeCommit, "refs/remotes/origin/main"], root)).code !== 0) continue;
    try {
      const d = (await api("GET", `/${c.number}?workspaceId=${encodeURIComponent(workspaceId)}&change=1`)) as Detail;
      const summary = changeSummary(c, d.comments);
      if (c.pr !== null) {
        if (!repo) throw new Error("origin が GitHub のリポジトリでない");
        const viewed = await run(["gh", "pr", "view", String(c.pr), "-R", repo, "--json", "state,comments"], root);
        if (viewed.code !== 0) throw new GhFailed(viewed);
        const pr = JSON.parse(viewed.stdout) as { state: string; comments: Array<{ body: string }> };
        // written before and lost on the way (the close failed, the app was down): not twice
        if (!pr.comments.some((x) => x.body.startsWith(summary.split("\n")[0]!))) {
          const file = join(deps.cache ?? join(homedir(), ".cache"), `switchboard.forge-resync-report-${c.number}-${now()}.md`);
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, summary);
          const commented = await run(["gh", "pr", "comment", String(c.pr), "-R", repo, "--body-file", file], root).finally(() => rmSync(file, { force: true }));
          if (commented.code !== 0) throw new GhFailed(commented);
        }
        // merged here and GitHub did not take the PR as merged (its head is not what main got): closed, with the summary above
        if (c.mergeCommit && pr.state === "OPEN") {
          const closed = await run(["gh", "pr", "close", String(c.pr), "-R", repo], root);
          if (closed.code !== 0) throw new GhFailed(closed);
        }
      } else {
        // no PR was ever made: a record on the Task it closed, kept by the app and sent as its other comments are
        for (const t of closedBy(0, d.issue.body, c.head)) await api("POST", `/${t}/comment`, { workspaceId, text: summary });
      }
      // GitHub's main has the commits now: the Tasks the change closes are closed here, not at the local merge (a Task is
      // not Done on GitHub before its code is there). One already closed is left as it is
      if (c.mergeCommit && apart) {
        for (const t of closedBy(0, d.issue.body, c.head)) {
          if (stored.issues.find((i) => i.number === t && !i.change)?.state === "CLOSED") continue;
          await api("PATCH", `/${t}`, { workspaceId, state: "CLOSED", fields: { Status: "Done" } });
        }
      }
      const at = new Date(now()).toISOString();
      await api("PATCH", `/${c.number}?change=1`, { workspaceId, ...(c.mergeCommit ? {} : { state: "CLOSED" }), change: { reportedAt: at } });
      reported.push(c.number);
    } catch (e) {
      if (e instanceof GhFailed && unreachable(`${e.result.stdout}\n${e.result.stderr}`, now())) {
        err(`まだ GitHub に届かない（${e.message}）。L${c.number} から先は次の --report で`);
        log(JSON.stringify({ result: "waiting", reported }));
        return 4;
      }
      err(`L${c.number} の要約を残せなかった: ${(e as Error).message}`);
      failed = true;
    }
  }
  log(JSON.stringify({ result: failed ? "partial" : "reported", reported }));
  return failed ? 1 : 0;
}

class GhFailed extends Error {
  constructor(readonly result: { code: number; stdout: string; stderr: string }) {
    super((result.stderr.trim() || result.stdout.trim()).split("\n")[0] || `gh が exit ${result.code}`);
  }
}
