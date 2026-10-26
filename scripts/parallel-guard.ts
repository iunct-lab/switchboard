import { currentRepo } from "./repo.ts";
/**
 * Lets several /pbi-complete sessions run side by side, each in its own worktree (gh stack keeps its state per worktree,
 * in .git/worktrees/<name>/gh-stack, so the stacks do not see each other). Two things are not safe by themselves:
 *   claim   — the same PBI started twice. The first claim comment on the PBI after the last release wins; a later one
 *             withdraws. A takeover (the user said 再開 after a session died) starts a new holder.
 *   overlap — two sessions editing the same file. A Task's named paths are compared with the files of open PRs and the
 *             paths named by other In progress Tasks. Work left untouched for STALE_HOURS is reported but does not block.
 *             After setting In progress, `--claimed` leaves a claim comment on the Task; of two In progress Tasks on the
 *             same file the one whose claim came first (smaller comment id) goes on. It also judges the
 *             prerequisites the Task and its PBI name (`**前提**:`, #937) as the daemon does (prereqState): one of
 *             another PBI not done yet waits (`wait`), one withdrawn / not found / not judged stops (`stop`). A merged
 *             （リリース） one goes: whether it runs is the daemon's to judge before it starts the PBI.
 * Comment ids only grow, across a repository's issues too, so they order claims without trusting clocks.
 * On a backlog kept in the app (#2265: BACKLOG_URL, and the records' service is `switchboard`) the comments are the
 * app's stored ones (`appBoard`, the same API as `ops-kit backlog`): ids `sb:<seq>`, in the order they were made, and
 * gh is never called. They cannot be deleted, so a session takes its claim back with a withdraw mark naming its token.
 */

import { prereqsOf, prereqState, type WaitTarget } from "../packages/core/src/backlog.ts";
import { readRecords, type StoredRecords } from "../ops-kit/src/backlog-client.ts";

export const STALE_HOURS = 72;
const MARKER = /<!-- pbi-complete:(claim|takeover|release)(?: (\S+))? -->/;
const TASK_CLAIM = /^<!-- parallel-guard:task-claim(?: (\S+))? -->/;
const WITHDRAW = /<!-- parallel-guard:withdraw (\S+) -->/;
/** The tokens taken back (#2265): a claim with one of them does not count. */
const withdrawn = (comments: Comment[]) => new Set(comments.flatMap((c) => WITHDRAW.exec(c.body)?.[1] ?? []));
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?) #(\d+)|^Backlog-Task: (\d+)\s*$/gim;

/** The Issues a PR is linked to (#1059): its body's `Closes #n` (close / fix / resolve and their -s / -d forms) or the line `Backlog-Task: n` of a backlog kept in Switchboard (#2344: no `#n`, it would be a GitHub Issue), and its branch `sb/<n>-`. */
export function linkedIssues(pr: { body: string | null; headRefName: string | null }): number[] {
  const linked = [...(pr.body ?? "").matchAll(CLOSES)].map((m) => Number(m[1] ?? m[2]));
  const branch = /^sb\/(\d+)-/.exec(pr.headRefName ?? "");
  if (branch) linked.push(Number(branch[1]));
  return linked;
}

export interface Comment { id: number; body: string }
export interface Holder { id: number; token: string }

/** The session that holds the PBI: comments in id order, a release clears, a takeover replaces. */
export function holder(comments: Comment[]): Holder | null {
  let h: Holder | null = null;
  const back = withdrawn(comments);
  for (const c of [...comments].sort((a, b) => a.id - b.id)) {
    const m = MARKER.exec(c.body);
    if (!m || (m[1] !== "release" && m[2] && back.has(m[2]))) continue;
    if (m[1] === "release") h = null;
    else if (m[1] === "takeover" || !h) h = { id: c.id, token: m[2] ?? "" };
  }
  return h;
}

/** The latest claim comment of a Task (a Task that yielded and started again has claimed twice). */
export const lastClaim = (comments: Comment[]) => {
  const back = withdrawn(comments);
  return comments
    .filter((c) => {
      const m = TASK_CLAIM.exec(c.body);
      return !!m && !(m[1] && back.has(m[1]));
    })
    .reduce<number | undefined>((a, c) => (a === undefined || c.id > a ? c.id : a), undefined);
};

/** A stored comment's id as a number to order by (#2265): the app's `sb:<seq>`, or GitHub's. Compared within one backlog only. */
export const commentId = (id: string | number): number => (typeof id === "number" ? id : Number(id.replace(/^sb:/, "")));

const FILE_EXT = /\.(?:tsx?|[cm]?js|json|md|ya?ml|toml|lock|sh|css|html|sql|txt)$/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Repository paths named in an Issue body. `top` is the repository's root (plus what open PRs add to it): its
 * directories start a path, its files are paths by themselves (`package.json`). A backticked word that looks like a
 * file (it ends in a file extension) counts too, so a file no branch has yet (`new-config.json`) is still seen.
 * `path:line` loses the line; a directory keeps its trailing slash.
 */
export function pathsIn(text: string, top: { name: string; dir: boolean }[]): string[] {
  const dirs = top.filter((t) => t.dir).map((t) => esc(t.name));
  const files = top.filter((t) => !t.dir).map((t) => esc(t.name));
  const alts = [...(dirs.length ? [`(?:${dirs.join("|")})\\/[\\w.@\\/-]*[\\w\\/]`] : []), ...(files.length ? [`(?:${files.join("|")})`] : [])];
  const found = alts.length
    ? [...text.matchAll(new RegExp(`(?<![\\w./-])(?:${alts.join("|")})(?![\\w-])`, "g"))].map((m) => m[0])
    : [];
  // Only a file name counts here: `turn/completed`, `origin/main` and `@switchboard/protocol` have a / but are not paths
  for (const m of text.matchAll(/`([\w.-]+(?:\/[\w.-]+)*)(?::\d+(?:-\d+)?)?`/g)) {
    if (m[1] && FILE_EXT.test(m[1]) && !m[1].startsWith(".")) found.push(m[1]);
  }
  return [...new Set(found)];
}

export const overlaps = (a: string, b: string) =>
  a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b));

export interface Work { ref: string; task?: number; paths: string[]; updatedAt: string; claimId?: number }
export interface Hit { ref: string; path: string; updatedAt: string }
export interface Verdict { verdict: "go" | "defer"; blocking: Hit[]; stale: Hit[] }
/** A prerequisite (#937): `sibling` = a Task of the same PBI (its order is the stack's, so it does not wait). */
export interface Prereq { ref: string; state: ReturnType<typeof prereqState>; sibling: boolean }

/** The prerequisites' verdict: `stop` (a person has to fix the body), `wait` (another PBI's, not done yet) or null. */
export function prereqVerdict(prereqs: Prereq[]): "wait" | "stop" | null {
  if (prereqs.some((p) => p.state !== "met" && p.state !== "pending")) return "stop";
  return prereqs.some((p) => p.state === "pending" && !p.sibling) ? "wait" : null;
}

/**
 * Before claiming (`claimId` undefined) every overlapping PR or In progress Task blocks. After claiming, an In progress
 * Task blocks only if it claimed first; one without a claim comment yet will claim after this one and yield itself.
 */
export function judge(mine: { paths: string[]; claimId?: number }, others: Work[], now: Date): Verdict {
  const blocking: Hit[] = [];
  const stale: Hit[] = [];
  for (const w of others) {
    if (mine.claimId !== undefined && w.task !== undefined && !(w.claimId !== undefined && w.claimId < mine.claimId)) continue;
    const old = now.getTime() - Date.parse(w.updatedAt) > STALE_HOURS * 3600_000;
    for (const p of mine.paths) {
      const q = w.paths.find((x) => overlaps(p, x));
      if (q) (old ? stale : blocking).push({ ref: w.ref, path: q, updatedAt: w.updatedAt });
    }
  }
  return { verdict: blocking.length > 0 ? "defer" : "go", blocking, stale };
}

type Run = (args: string[]) => Promise<string>;

async function gh(args: string[]): Promise<string> {
  const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed: ${err.trim()}`);
  return out;
}

const lines = (s: string) => s.split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function comments(repo: string, n: number, run: Run): Promise<Comment[]> {
  return lines(await run(["api", "--paginate", `repos/${repo}/issues/${n}/comments`, "-q", ".[] | {id, body}"]));
}

async function post(repo: string, n: number, body: string, run: Run): Promise<number> {
  return JSON.parse(await run(["api", "-X", "POST", `repos/${repo}/issues/${n}/comments`, "-f", `body=${body}`])).id;
}

const remove = (repo: string, id: number, run: Run) => run(["api", "-X", "DELETE", `repos/${repo}/issues/comments/${id}`]);

/**
 * Where the claims are written and read, and the overlap check's material: GitHub's comments (`ghBoard`) or the app's
 * stored ones (`appBoard`, #2265). `remove` takes back a comment this session wrote (`token`: the one in its mark).
 */
export interface Board {
  comments(n: number): Promise<Comment[]>;
  post(n: number, body: string): Promise<number>;
  remove(n: number, id: number, token: string): Promise<void>;
  material(task: number): Promise<Material>;
}

export const ghBoard = (repo: string, run: Run = gh): Board => ({
  comments: (n) => comments(repo, n, run),
  post: (n, body) => post(repo, n, body, run),
  remove: async (_n, id) => void (await remove(repo, id, run)),
  material: (task) => ghMaterial(repo, task, run),
});

/**
 * The app's stored comments (#2265), through the API `ops-kit backlog` uses (BACKLOG_URL / BACKLOG_TOKEN_FILE /
 * BACKLOG_WORKSPACE): read from GET /api/backlog/:n, written with POST /api/backlog/:n/comment. A stored comment cannot be
 * deleted: one taken back gets a withdraw mark. What a post made is found again by its token, as the newest comment
 * carrying it. The material is the stored records, read as they are (nothing is sent elsewhere).
 */
export function appBoard(env: Record<string, string | undefined>, f: typeof fetch = fetch): Board {
  const api = async (method: string, path: string, body?: unknown) => {
    const key = env.BACKLOG_TOKEN_FILE ? (await Bun.file(env.BACKLOG_TOKEN_FILE).text()).trim() : "";
    const res = await f(`${env.BACKLOG_URL!.replace(/\/+$/, "")}${path}`, { method, headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const answer = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`backlog ${method} ${path}: ${res.status} ${(answer as { error?: string } | null)?.error ?? res.statusText}`);
    return answer;
  };
  let workspace: string | undefined;
  const records = async () => {
    const r = await readRecords(env, { fresh: false, fetch: f });
    workspace = r.workspaceId;
    return r;
  };
  const ws = async () => workspace ?? (await records()).workspaceId;
  const read = async (n: number): Promise<Comment[]> => {
    const d = (await api("GET", `/${n}?workspaceId=${encodeURIComponent(await ws())}`)) as { comments: Array<{ id: string; body: string }> };
    return d.comments.map((c) => ({ id: commentId(c.id), body: c.body }));
  };
  const write = async (n: number, text: string) => void (await api("POST", `/${n}/comment`, { workspaceId: await ws(), text }));
  return {
    comments: read,
    post: async (n, body) => {
      await write(n, body);
      const mine = (await read(n)).filter((c) => c.body === body);
      if (!mine.length) throw new Error(`#${n} に書いたコメントが読めません`);
      return Math.max(...mine.map((c) => c.id));
    },
    remove: (n, _id, token) => write(n, `<!-- parallel-guard:withdraw ${token} -->\n取り下げ（parallel-guard）`),
    material: async (task) => storedMaterial(await records(), task),
  };
}

export async function claim(board: Board, pbi: number, takeover: boolean): Promise<{ held: boolean; holder: Holder | null }> {
  const before = holder(await board.comments(pbi));
  if (before && !takeover) return { held: false, holder: before };
  const token = crypto.randomUUID();
  const kind = takeover ? "takeover" : "claim";
  const id = await board.post(pbi, `<!-- pbi-complete:${kind} ${token} -->\n/pbi-complete ${takeover ? "再開（前のセッションから引き継ぐ）" : "開始"}。worktree: ../switchboard-pbi${pbi}`);
  const after = holder(await board.comments(pbi));
  if (after?.token === token) return { held: true, holder: after };
  await board.remove(pbi, id, token);
  return { held: false, holder: after };
}

/**
 * A release, with the PRs / Issues the PBI waits for when it stopped on an overlap or an unfinished prerequisite
 * (`waits=603,778`, read back by the backlog, #817). `holder()` skips the list; a later release without it clears the wait.
 */
export function releaseBody(reason: string, waits: number[] = [], overlap = false): string {
  const list = [...new Set(waits)].sort((a, b) => a - b);
  return `<!-- pbi-complete:release${list.length ? ` ${overlap ? "overlap" : "waits"}=${list.join(",")}` : ""} -->\n/pbi-complete 終了: ${reason}`;
}

/** `release <PBI> <理由…> [--waits n,n | --overlap-waits n,n]`'s words after the PBI; null = usage (no reason, a malformed or repeated --waits). */
export function releaseArgs(words: string[]): { reason: string; waits: number[]; overlap?: boolean } | null {
  if (words.includes("--waits") && words.includes("--overlap-waits")) return null;
  const flag = words.includes("--overlap-waits") ? "--overlap-waits" : "--waits";
  const at = words.indexOf(flag);
  if (at >= 0 && (!/^[1-9]\d*(,[1-9]\d*)*$/.test(words[at + 1] ?? "") || words.lastIndexOf(flag) !== at)) return null;
  const reason = (at >= 0 ? words.filter((_, i) => i !== at && i !== at + 1) : words).join(" ");
  return reason ? { reason, waits: at >= 0 ? words[at + 1]!.split(",").map(Number) : [], ...(flag === "--overlap-waits" ? { overlap: true } : {}) } : null;
}

export async function release(board: Board, pbi: number, reason: string, waits: number[] = [], overlap = false): Promise<void> {
  await board.post(pbi, releaseBody(reason, waits, overlap));
}

/** Project owner and number from SWITCHBOARD_PROJECT_URL (the variable, as scripts/setup/*.sh read it). */
async function project(repo: string, run: Run): Promise<{ owner: string; number: string }> {
  const url = process.env.SWITCHBOARD_PROJECT_URL || (await run(["variable", "get", "SWITCHBOARD_PROJECT_URL", "-R", repo])).trim();
  const m = /\/(?:users|orgs)\/([^/]+)\/projects\/(\d+)/.exec(url);
  if (!m) throw new Error(`Project の URL が読めない: ${url || "(空)"}`);
  return { owner: m[1]!, number: m[2]! };
}

/**
 * What the overlap check reads (#919): the top level of the repository, the Task with its PBI, the open PRs, the other
 * In progress Tasks (in the Project, not `needs-decision`) and each prerequisite's state — from GitHub (`ghMaterial`)
 * or from the records the app stored (`storedMaterial`), judged the same way (`readOthers`).
 */
export interface Material {
  top: { name: string; dir: boolean }[];
  issue: { body: string; parent: { number: number; body: string; subIssues: number[] } | null };
  /** `files` null = not all stored (more than 100): judged only where it would block, else skipped. */
  prs: { number: number; linked: number[]; updatedAt: string; files: string[] | null; isDraft: boolean; labels: string[] }[];
  working: { number: number; body: string; updatedAt: string }[];
  /** A prerequisite's state; undefined = not found. */
  target: (n: number) => Promise<WaitTarget | undefined>;
}

export async function ghMaterial(repo: string, task: number, run: Run = gh): Promise<Material> {
  const [owner, name] = repo.split("/");
  const top = lines(await run(["api", `repos/${repo}/contents`, "-q", '.[] | {name, dir: (.type == "dir")}'])) as { name: string; dir: boolean }[];
  const issue = JSON.parse(
    await run([
      "api", "graphql",
      "-f", "query=query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){ body parent{ number body subIssues(first:100){ nodes{ number } } } } } }",
      "-f", `o=${owner}`, "-f", `r=${name}`, "-F", `n=${task}`,
    ]),
  ).data.repository.issue;
  const prs = JSON.parse(
    await run(["pr", "list", "-R", repo, "--state", "open", "-L", "200", "--json", "number,headRefName,body,updatedAt,files,isDraft,labels"]),
  ) as { number: number; headRefName: string; body: string; updatedAt: string; files: { path: string }[]; isDraft: boolean; labels: { name: string }[] }[];
  // From the Issue side, not the Project's item list: that reads every item of the Project (about 400 points a call)
  const p = await project(repo, run);
  const tasks = lines(
    await run([
      "api", "graphql", "--paginate",
      "-f", 'query=query($o:String!,$r:String!,$endCursor:String){ repository(owner:$o,name:$r){ issues(states:OPEN, labels:["type:task"], first:100, after:$endCursor){ pageInfo{ hasNextPage endCursor } nodes{ number body updatedAt labels(first:100){ nodes{ name } } projectItems(first:10){ nodes{ project{ number owner{ ... on Organization{ login } ... on User{ login } } } fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } } } } } }',
      "-f", `o=${owner}`, "-f", `r=${name}`,
      "-q", ".data.repository.issues.nodes[] | {number, body, updatedAt, labels, projectItems}",
    ]),
  ) as { number: number; body: string; updatedAt: string; labels: { nodes: { name: string }[] }; projectItems: { nodes: { project: { number: number; owner: { login?: string } }; fieldValueByName: { name?: string } | null }[] } }[];
  return {
    top,
    issue: { body: issue.body, parent: issue.parent && { number: issue.parent.number, body: issue.parent.body, subIssues: issue.parent.subIssues.nodes.map((n: { number: number }) => n.number) } },
    prs: prs.map((pr) => ({ number: pr.number, linked: linkedIssues(pr), updatedAt: pr.updatedAt, files: pr.files.map((f) => f.path), isDraft: pr.isDraft, labels: pr.labels.map((l) => l.name) })),
    // A Project is numbered within its owner: another owner's Project #2 is not this one
    working: tasks.filter((t) => {
      const item = t.projectItems.nodes.find((i) => String(i.project.number) === p.number && i.project.owner.login?.toLowerCase() === p.owner.toLowerCase());
      return item?.fieldValueByName?.name === "In progress" && !t.labels.nodes.some((l) => l.name === "needs-decision");
    }),
    target: async (n) => {
      try {
        const r = JSON.parse(await run(["api", `repos/${repo}/issues/${n}`, "-q", "{state, state_reason, merged: (.pull_request.merged_at != null), pr: (.pull_request != null)}"])) as { state: string; state_reason: string | null; merged: boolean; pr: boolean };
        const state = r.pr && r.merged ? "MERGED" : r.state.toUpperCase();
        return { kind: r.pr ? "pr" : "issue", state, isDraft: false, labels: [], closes: [], stateReason: r.state_reason?.toUpperCase() ?? null, mergeCommit: null };
      } catch (e) {
        if (!/HTTP 404|HTTP 410|Not Found|Gone/.test((e as Error).message)) throw e;
        return undefined;
      }
    },
  };
}

/**
 * The same material from the app's stored records (#919), read after the app sent and imported (`--fresh`): no GitHub
 * call. A Task not stored cannot be judged (an error, exit 2); a PR stored without all its files, only where it counts (`readOthers`).
 */
export function storedMaterial(r: StoredRecords, task: number): Material {
  const issues = new Map(r.issues.map((i) => [i.number, i]));
  const mine = issues.get(task);
  if (!mine || r.unread.includes(task)) throw new Error(`Task #${task} がアプリに保存されていない（または最後の取込みで読めなかった）`);
  const parent = mine.parent === null ? undefined : issues.get(mine.parent);
  if (mine.parent !== null && (!parent || r.unread.includes(mine.parent))) throw new Error(`Task #${task} の親 #${mine.parent} がアプリに保存されていない（または最後の取込みで読めなかった）`);
  const prs = r.pulls.filter((p) => p.state === "OPEN").map((p) => ({ number: p.number, linked: p.closes, updatedAt: p.updatedAt, files: p.files, isDraft: p.isDraft, labels: p.labels }));
  const pulls = new Map(r.pulls.map((p) => [p.number, p]));
  return {
    top: r.top.map((t) => ({ ...t })),
    issue: { body: mine.body, parent: parent ? { number: parent.number, body: parent.body, subIssues: parent.subIssues } : null },
    prs,
    working: r.issues.filter((t) => t.state === "OPEN" && t.labels.includes("type:task") && !t.labels.includes("needs-decision") && t.fields?.Status === "In progress"),
    target: async (n) => {
      const p = pulls.get(n);
      if (p) return { kind: "pr", state: p.state, isDraft: p.isDraft, labels: p.labels, closes: p.closes, mergeCommit: p.mergeCommit, stateReason: null };
      const i = issues.get(n);
      return i && !r.unread.includes(n) ? { kind: "issue", state: i.state, isDraft: false, labels: i.labels, closes: [], stateReason: i.stateReason, mergeCommit: null } : undefined;
    },
  };
}

/** The Task's paths and active work: ready PRs and non-decision In progress Tasks, minus its own PBI.
 * A Draft reserves nothing by itself; an In progress Task working on that Draft is still protected. */
export async function readOthers(task: number, m: Material): Promise<{ paths: string[]; others: Work[]; prereqs: Prereq[] }> {
  const top = [...m.top];
  const { issue } = m;
  const own = new Set<number>([task, ...(issue.parent?.subIssues ?? [])]);
  if (issue.parent) own.add(issue.parent.number);

  const others: Work[] = [];
  for (const f of m.prs.flatMap((pr) => pr.files ?? [])) {
    const [head, ...more] = f.split("/");
    if (!top.some((t) => t.name === head)) top.push({ name: head!, dir: more.length > 0 });
  }
  for (const t of m.working) {
    if (own.has(t.number)) continue;
    others.push({ ref: `Task #${t.number}`, task: t.number, paths: pathsIn(t.body, top), updatedAt: t.updatedAt });
  }

  const paths = pathsIn(issue.body, top);
  for (const pr of m.prs) {
    const files = () => {
      if (pr.files === null) throw new Error(`PR #${pr.number} の変更ファイルが記録に無い（101 件以上）`);
      return pr.files;
    };
    if (pr.linked.includes(task)) paths.push(...files());
    if (pr.linked.some((n) => own.has(n))) continue;
    const active = others.filter((w) => w.ref.startsWith("Task #") && w.task !== undefined && pr.linked.includes(w.task));
    const deferred = pr.isDraft || pr.labels.includes("needs-decision");
    if (deferred && !active.length) continue;
    if (deferred) {
      // Draft files belong to the live Task: keep its claim ordering when both Tasks resume together.
      for (const task of active) others.push({ ref: `PR #${pr.number}`, task: task.task, paths: files(), updatedAt: pr.updatedAt });
    } else {
      others.push({ ref: `PR #${pr.number}`, paths: files(), updatedAt: pr.updatedAt });
    }
  }

  // Keep PRs before Tasks in the diagnostic, as before.
  others.sort((a, b) => Number(!a.ref.startsWith("PR #")) - Number(!b.ref.startsWith("PR #")));
  const siblings = new Set<number>(issue.parent?.subIssues ?? []);
  return { paths: [...new Set(paths)], others, prereqs: await readPrereqs([issue.body, issue.parent?.body ?? ""], siblings, m.target) };
}

/**
 * The prerequisites the Task's and its PBI's bodies name (#937), each read by `target` (from GitHub: a 404 / 410 = not
 * found). A release is not judged here: the daemon knows what runs and starts the PBI only once it is in, so a merged
 * PR is met (stopping on it would stop what the daemon just started, every firing); an Issue named as a release stays unknown.
 */
async function readPrereqs(bodies: string[], siblings: Set<number>, target: Material["target"]): Promise<Prereq[]> {
  const named = new Map<number, boolean>();
  for (const p of bodies.flatMap(prereqsOf)) named.set(p.number, !!named.get(p.number) || p.release);
  const out: Prereq[] = [];
  for (const [n, release] of named) {
    const t = await target(n);
    // a PR's （リリース） is judged as merged here (see above)
    const state = prereqState(t, t?.kind === "pr" ? "merged" : release ? "release" : "done", () => null);
    out.push({ ref: `${t?.kind === "pr" ? "PR " : ""}#${n}`, state, sibling: siblings.has(n) });
  }
  return out;
}

/**
 * The overlap check. `claimed`: the Task was just set In progress — leave a claim comment, read the claims of the
 * overlapping In progress Tasks, and withdraw the comment again if this Task has to yield.
 */
export async function overlap(board: Board, task: number, claimed: boolean, now = new Date()) {
  const token = crypto.randomUUID();
  const claimId = claimed ? await board.post(task, `<!-- parallel-guard:task-claim ${token} -->\n着手（parallel-guard）。同じファイルに先に着手した Task があれば譲る`) : undefined;
  const back = () => (claimId !== undefined ? board.remove(task, claimId, token) : Promise.resolve());
  let found: Awaited<ReturnType<typeof readOthers>>;
  try {
    found = await readOthers(task, await board.material(task));
  } catch (e) {
    // could not judge: the claim does not stay
    await back();
    throw e;
  }
  const { paths, others, prereqs } = found;
  if (paths.length === 0) {
    await back();
    throw new Error(`Task #${task} の本文に触るファイルのパスが無い（pbi-to-tasks で名指しする）`);
  }
  if (claimId !== undefined) {
    for (const w of others) {
      if (w.task !== undefined && paths.some((a) => w.paths.some((b) => overlaps(a, b)))) {
        w.claimId = lastClaim(await board.comments(w.task));
      }
    }
  }
  const v = judge({ paths, claimId }, others, now);
  const verdict = prereqVerdict(prereqs) ?? v.verdict;
  if (verdict !== "go") await back();
  return { paths, ...v, verdict, ...(prereqs.length ? { prereqs } : {}) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const env = process.env;
  const repoAt = args.indexOf("--repo");
  const rest = repoAt >= 0 ? args.filter((_, i) => i !== repoAt && i !== repoAt + 1) : args;
  const [cmd, num, ...more] = rest;
  const n = Number(num);
  const usage = () => {
    console.error(
      "usage: bun scripts/parallel-guard.ts claim <PBI> [--takeover] | release <PBI> <理由> [--waits <n,n,...>] | overlap <Task> [--claimed]  [--repo <owner/name>]",
    );
    process.exit(2);
  };
  // a backlog kept in the app (#2265): the claims and the records are the app's, gh is not called and no repository is
  // named. A Task the app gave its workspace (BACKLOG_WORKSPACE, only for such a backlog) that cannot read it cannot
  // judge — it never falls back to GitHub; another goes on with GitHub's comments as before
  let local = false;
  if (env.BACKLOG_URL && repoAt < 0) {
    const records = await readRecords(env, { fresh: false }).catch((e: Error) => {
      if (env.BACKLOG_WORKSPACE && !env.GH_REPO) {
        console.error(`判定できなかった: ${e.message}`);
        process.exit(2);
      }
      return null;
    });
    local = records?.service === "switchboard";
  }
  let repo: string | undefined;
  try {
    repo = local ? undefined : repoAt >= 0 ? args[repoAt + 1] : currentRepo();
  } catch {
    usage();
  }
  if (!/^\d+$/.test(num ?? "") || (!local && (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)))) usage();
  // in the app's Task (BACKLOG_URL), the overlap check's candidates are its stored records, brought up to date first
  // (#919); when the app cannot reach GitHub they are judged as stored, and said so (#2264). The claims of a GitHub
  // backlog stay on GitHub: their order is the comments' ids
  const board: Board = local
    ? appBoard(env)
    : {
        ...ghBoard(repo!),
        ...(env.BACKLOG_URL && {
          material: async (task: number) => {
            const records = await readRecords(env, { fresh: true, repo: repo! });
            if (records.unsynced) console.error(records.unsynced);
            return storedMaterial(records, task);
          },
        }),
      };
  try {
    if (cmd === "claim") {
      const r = await claim(board, n!, more.includes("--takeover"));
      console.log(JSON.stringify(r, null, 2));
      if (!r.held) console.log(`PBI #${n} は別のセッションが実行中（コメント ${r.holder?.id}）`);
      process.exit(r.held ? 0 : 1);
    } else if (cmd === "release") {
      const r = releaseArgs(more);
      if (!r) usage();
      await release(board, n!, r!.reason, r!.waits, r!.overlap);
    } else if (cmd === "overlap") {
      const v = await overlap(board, n!, more.includes("--claimed"));
      console.log(JSON.stringify(v, null, 2));
      process.exit(v.verdict === "go" ? 0 : 1);
    } else usage();
  } catch (e) {
    console.error(`判定できなかった: ${(e as Error).message}`);
    process.exit(2);
  }
}
