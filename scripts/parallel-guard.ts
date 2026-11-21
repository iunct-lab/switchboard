import { currentRepo } from "./repo.ts";
/**
 * Lets several /pbi-complete sessions run side by side, each in its own worktree (gh stack keeps one catalog per clone,
 * in `<common-dir>/gh-stack`, and each worktree's stack is its own entry in it). Two things are not safe by themselves:
 *   claim   — the same PBI started twice. The first claim comment on the PBI after the last release wins; a later one
 *             withdraws. A takeover (the user said 再開 after a session died) starts a new holder.
 *   overlap — two sessions editing the same file. A Task's named paths are compared with the files of open PRs and the
 *             paths named by other In progress Tasks (not those of a PBI no session holds: no `claim` of it after its last
 *             release, and a Task with no PBI counts). Work left untouched for STALE_HOURS is reported but does not block.
 *             After setting In progress, `--claimed` leaves a claim comment on the Task; of two In progress Tasks on the
 *             same file the one whose claim came first (smaller comment order) goes on. It also judges the
 *             prerequisites the Task and its PBI name (`**前提**:`) as the daemon does (prereqState): one of
 *             another PBI not done yet waits (`wait`), one withdrawn / not found / not judged stops (`stop`). A merged
 *             （リリース） one goes: whether it runs is the daemon's to judge before it starts the PBI.
 *   shared  — the files many PBIs touch (`sharedFiles` of ops.config.json) hold no one back: an overlap only on them is
 *             reported (`shared`) and goes on; the merge gate asks for a local CI on the base once one moved there.
 *   turn    — a PBI that yielded on an overlap keeps its place on the paths it yielded on (`Turn`, kept by the app): a
 *             Task of a PBI that came later yields to it even after claiming, so the one that waited starts first.
 * The app judges what it starts with the same functions (`othersOf`, `turnsAhead`, `judge`), so a Task it started as
 * free of overlaps is not deferred here.
 * Claims are ordered by a number that only grows, so they need no trusted clock.
 * With BACKLOG_URL, on a repository the app syncs, GitHub-synced or kept in the app only, the comments are the
 * app's stored ones (`appBoard`, the same API as `ops-kit backlog`), in the order the app stored them (`comments[].seq`),
 * and gh is never called. They cannot be deleted, so a session takes its claim back with a withdraw mark naming its token.
 * On a repository the app does not know, and without BACKLOG_URL, they are GitHub's (`ghBoard`), ordered by comment id,
 * which grows across a repository's issues.
 */

import { pbiFactsOf, prereqsOf } from "../packages/core/src/backlog-item.ts";
import { prereqOf, prereqState, storedIssueTarget, waitsOf, type WaitTarget } from "../packages/core/src/backlog-waits.ts";
import { pbiProgress } from "../packages/core/src/pbi-progress.ts";
import { appSync, BacklogUnknown, readRecords, type StoredRecords } from "../ops-kit/src/backlog-client.ts";
import { linkedIssues } from "./task-paths.ts";
import { overlaps, pathsIn } from "../ops-kit/src/task-paths.ts";
import { sharedFilesOf } from "../ops-kit/src/config.ts";

export const STALE_HOURS = 72;
const MARKER = /<!-- pbi-complete:(claim|takeover|release)(?: (\S+))?(?: (after=\S+))? -->/;
const TASK_CLAIM = /^<!-- parallel-guard:task-claim(?: (\S+))? -->/;
const WITHDRAW = /<!-- parallel-guard:withdraw (\S+) -->/;
/** The tokens taken back: a claim with one of them does not count. */
const withdrawn = (comments: Comment[]) => new Set(comments.flatMap((c) => WITHDRAW.exec(c.body)?.[1] ?? []));
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

/**
 * Whether a Task only waits for a check: work is done and nothing is left that changes the files its body names. Of the PRs
 * linked to the Task (`linkedIssues`; `state` is OPEN / CLOSED / MERGED) at least one is merged and none is open (a Draft
 * is open). A merged PR that was never read (not in `pulls`) is not seen, so such a Task is not taken for waiting.
 * The app's overlap check and this guard both use it.
 */
export function waitsOnlyForCheck(task: number, pulls: { state: string; linked: number[] }[]): boolean {
  const mine = pulls.filter((p) => p.linked.includes(task));
  return mine.some((p) => p.state === "MERGED") && !mine.some((p) => p.state === "OPEN");
}

/** `turn`: not work under way but the place of a PBI that yielded (its number): see `Turn`. */
export interface Work { ref: string; task?: number; paths: string[]; updatedAt: string; claimId?: number; turn?: number }
export interface Hit { ref: string; path: string; updatedAt: string; turn?: number }
/** `shared`: the overlaps on shared files only, which do not hold the Task back; absent = none. */
export interface Verdict { verdict: "go" | "defer"; blocking: Hit[]; stale: Hit[]; shared?: Hit[] }

/**
 * The place of a PBI that yielded on an overlap: `paths` of its Task `task` are kept for it since `since` (when it first
 * yielded), ahead of every PBI that has no place or a later one. The app reads them from the occupancy marks and leaves
 * out a PBI that cannot move now (packages/core/src/backlog-overlap.ts `turnWorks`); the guard reads the app's list.
 * `yieldsTo` names the PBIs of what the place's PBI waits for now: the place is not ahead of those.
 */
export type Turn = NonNullable<StoredRecords["turns"]>[number];

/** The places ahead of `pbi`'s own, as other work: every other PBI's when it has none, else the ones taken earlier (the same time: the smaller number). Not one that yields to `pbi`. */
export function turnsAhead(turns: Turn[], pbi: number | null): Work[] {
  const mine = turns.find((t) => t.pbi === pbi);
  return turns
    .filter((t) => t.pbi !== pbi && !(pbi !== null && t.yieldsTo?.includes(pbi)) && (!mine || t.since < mine.since || (t.since === mine.since && t.pbi < mine.pbi)))
    .map((t) => ({ ref: `Task #${t.task}`, task: t.task, paths: t.paths, updatedAt: t.since, turn: t.pbi }));
}
/** A prerequisite: `sibling` = a Task of the same PBI (its order is the stack's, so it does not wait). */
export interface Prereq { ref: string; state: ReturnType<typeof prereqState>; sibling: boolean; fix?: string;
  /** `met` because only the person's own checks are left (`prereqOf`, the app's own rule). */ confirming?: boolean }

/** The prerequisites' verdict: `stop` (a person has to fix the body), `wait` (another PBI's, not done yet) or null. */
export function prereqVerdict(prereqs: Prereq[]): "wait" | "stop" | null {
  if (prereqs.some((p) => p.state !== "met" && p.state !== "pending")) return "stop";
  return prereqs.some((p) => p.state === "pending" && !p.sibling) ? "wait" : null;
}

/** A wait key of a stop record (`conditions`): the daemon reads `pr#N` / `issue#N` and resumes the Task once all are closed. */
export interface WaitCondition { key: string; value: string; met: false }

/**
 * What a Task that cannot go waits for, as stop-record conditions the runner copies into its stop report: each blocking
 * PR / Task, and each prerequisite of another PBI not met yet. A go waits for nothing.
 */
export function waitConditions(v: { verdict: string; blocking: Hit[]; prereqs?: Prereq[] }): WaitCondition[] {
  if (v.verdict === "go") return [];
  const out = new Map<string, WaitCondition>();
  const put = (ref: string, value: string) => {
    const m = /^(PR |Task )?#(\d+)$/.exec(ref);
    if (!m) return;
    const key = `${m[1] === "PR " ? "pr" : "issue"}#${m[2]}`;
    if (!out.has(key)) out.set(key, { key, value, met: false });
  };
  for (const b of v.blocking) put(b.ref, "open");
  for (const p of v.prereqs ?? []) if (p.state !== "met" && !p.sibling) put(p.ref, p.state);
  return [...out.values()];
}

/**
 * Before claiming (`claimId` undefined) every overlapping PR or In progress Task blocks. After claiming, an In progress
 * Task blocks only if it claimed first; one without a claim comment yet will claim after this one and yield itself.
 * A place ahead (`turn`) blocks whatever the claims and its age: the app already left out the ones too old.
 * An overlap where the file both sides touch is one of `sharedFiles` does not block (`shared`).
 */
export function judge(mine: { paths: string[]; claimId?: number }, others: Work[], now: Date, sharedFiles: string[] = []): Verdict {
  const blocking: Hit[] = [];
  const stale: Hit[] = [];
  const shared: Hit[] = [];
  for (const w of others) {
    if (mine.claimId !== undefined && w.task !== undefined && w.turn === undefined && !(w.claimId !== undefined && w.claimId < mine.claimId)) continue;
    const old = w.turn === undefined && now.getTime() - Date.parse(w.updatedAt) > STALE_HOURS * 3600_000;
    // every path of the other side that meets one of mine is sorted on its own: a shared file named first must not hide
    // the next file under the same directory. One hit per path of the other side and list it falls in.
    const seen = new Set<string>();
    for (const p of mine.paths) {
      for (const q of w.paths.filter((x) => overlaps(p, x))) {
        // what both touch is the narrower of the two (a directory named on one side meets the file named on the other)
        const both = p.length >= q.length ? p : q;
        const into = sharedFiles.includes(both) ? shared : old ? stale : blocking;
        const key = `${into === shared ? "s" : into === stale ? "o" : "b"}\0${q}`;
        if (seen.has(key)) continue;
        seen.add(key);
        into.push({ ref: w.ref, path: q, updatedAt: w.updatedAt, ...(w.turn !== undefined ? { turn: w.turn } : {}) });
      }
    }
  }
  return { verdict: blocking.length > 0 ? "defer" : "go", blocking, stale, ...(shared.length ? { shared } : {}) };
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
 * stored ones (`appBoard`). `remove` takes back a comment this session wrote (`token`: the one in its mark).
 */
export interface Board {
  comments(n: number): Promise<Comment[]>;
  post(n: number, body: string): Promise<number>;
  remove(n: number, id: number, token: string): Promise<void>;
  material(task: number): Promise<Material>;
  /**
   * The PBI's lease, where the app shares work with another machine: taken and given back through the app, which holds
   * and renews it (the script never asks S3). `enabled: false` = the app runs alone, nothing was asked. Absent on
   * GitHub's comments: without the app there is no lease.
   */
  lease?(pbi: number, action: "acquire" | "release"): Promise<Lease>;
}

export type Lease = { enabled: false } | { enabled: true; ok: true } | { enabled: true; ok: false; holder: string; until: number; error: string };

/** `sharedFiles`: the checkout's (`sharedFilesOf`); GitHub's comments carry no places, so none are read here. */
export const ghBoard = (repo: string, run: Run = gh, sharedFiles: string[] = []): Board => ({
  comments: (n) => comments(repo, n, run),
  post: (n, body) => post(repo, n, body, run),
  remove: async (_n, id) => void (await remove(repo, id, run)),
  material: async (task) => ({ ...(await ghMaterial(repo, task, run)), shared: sharedFiles }),
});

/**
 * The app's stored comments, through the API `ops-kit backlog` uses (BACKLOG_URL / BACKLOG_TOKEN_FILE /
 * BACKLOG_WORKSPACE, or `repo`): read from GET /api/backlog/:n, written with POST /api/backlog/:n/comment. A stored comment cannot be
 * deleted: one taken back gets a withdraw mark. What a post made is found again by its token, as the newest comment
 * carrying it. Comments are ordered by `seq`, which sending to GitHub does not change (the id and the time do); one only
 * imported has none and comes by its time before every one written here. The material is the stored records: of a
 * GitHub-synced repository brought up to date first, of a backlog kept in the app read as they are.
 */
export function appBoard(env: Record<string, string | undefined>, f: typeof fetch = fetch, repo?: string): Board {
  const api = async (method: string, path: string, body?: unknown) => {
    const key = env.BACKLOG_TOKEN_FILE ? (await Bun.file(env.BACKLOG_TOKEN_FILE).text()).trim() : "";
    const res = await f(`${env.BACKLOG_URL!.replace(/\/+$/, "")}${path}`, { method, headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) }, ...(body !== undefined && { body: JSON.stringify(body) }) });
    const answer = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`backlog ${method} ${path}: ${res.status} ${(answer as { error?: string } | null)?.error ?? res.statusText}`);
    return answer;
  };
  let workspace: string | undefined;
  const records = async () => {
    const r = await readRecords(env, { fresh: false, repo, fetch: f });
    workspace = r.workspaceId;
    return r;
  };
  const ws = async () => workspace ?? (await records()).workspaceId;
  const read = async (n: number): Promise<Comment[]> => {
    const d = (await api("GET", `/${n}?workspaceId=${encodeURIComponent(await ws())}`)) as { comments: Array<{ seq: number | null; body: string; createdAt: string }> };
    return d.comments.map((c) => ({ id: c.seq ?? Date.parse(c.createdAt) - 1e13, body: c.body }));
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
    lease: async (n, action) => (await api("POST", `/${n}/lease`, { workspaceId: await ws(), action })) as Lease,
    material: async (task) => {
      const r = await records();
      if (r.service === "switchboard") return storedMaterial(r, task);
      const fresh = await readRecords(env, { fresh: true, repo, fetch: f });
      if (fresh.unsynced) console.error(fresh.unsynced);
      return storedMaterial(fresh, task);
    },
  };
}

/**
 * `leased`: the claim was won here but another machine holds the PBI's lease (its line says who, until when); the claim
 * comment is taken back. A lease that cannot be asked for throws after the comment is taken back: not judged.
 */
export async function claim(board: Board, pbi: number, takeover: boolean): Promise<{ held: boolean; holder: Holder | null; leased?: string }> {
  const before = holder(await board.comments(pbi));
  if (before && !takeover) return { held: false, holder: before };
  const token = crypto.randomUUID();
  const kind = takeover ? "takeover" : "claim";
  const id = await board.post(pbi, `<!-- pbi-complete:${kind} ${token} -->\n/pbi-complete ${takeover ? "再開（前のセッションから引き継ぐ）" : "開始"}。worktree: ../switchboard-pbi${pbi}`);
  const after = holder(await board.comments(pbi));
  if (after?.token !== token) {
    await board.remove(pbi, id, token);
    return { held: false, holder: after };
  }
  let lease: Lease | undefined;
  try {
    lease = await board.lease?.(pbi, "acquire");
  } catch (e) {
    await board.remove(pbi, id, token);
    throw e;
  }
  if (lease?.enabled && !lease.ok) {
    await board.remove(pbi, id, token);
    return { held: false, holder: null, leased: lease.error };
  }
  return { held: true, holder: after };
}

/**
 * A release, with the PRs / Issues the PBI waits for when it stopped on an overlap or an unfinished prerequisite
 * (`waits=603, 778`, read back by the backlog). `holder()` skips the list; a later release without it clears the wait.
 */
export function releaseBody(reason: string, waits: number[] = [], overlap = false, after?: string): string {
  const list = [...new Set(waits)].sort((a, b) => a - b);
  return `<!-- pbi-complete:release${list.length ? ` ${overlap ? "overlap" : "waits"}=${list.join(",")}` : ""}${after ? ` after=${after}` : ""} -->\n/pbi-complete 終了: ${reason}`;
}

/** A time with a zone (ISO 8601, `Z` or `±hh:mm`) in ms; NaN when it is not one: a time with no zone is not read as local time. */
export const afterTime = (value: string): number =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim()) ? Date.parse(value) : NaN;

/** A PBI whose last release waits for a date still ahead (`after=`): its In progress Tasks are no one's overlap until then. */
export const waitsForDate = (comments: { body: string; createdAt: string }[], now: number): boolean => {
  const after = waitsOf(comments)?.after;
  return !!after && afterTime(after) > now;
};

/**
 * `release <PBI> <理由…> [--waits n,n | --overlap-waits n,n] [--after <ISO 8601 with a zone>]`'s words after the PBI; null = usage
 * (no reason, a malformed or repeated --waits / --after, a time that is no time or has no zone).
 */
export function releaseArgs(words: string[]): { reason: string; waits: number[]; overlap?: boolean; after?: string } | null {
  if (words.includes("--waits") && words.includes("--overlap-waits")) return null;
  const flag = words.includes("--overlap-waits") ? "--overlap-waits" : "--waits";
  const at = words.indexOf(flag);
  if (at >= 0 && (!/^[1-9]\d*(,[1-9]\d*)*$/.test(words[at + 1] ?? "") || words.lastIndexOf(flag) !== at)) return null;
  const afterAt = words.indexOf("--after");
  const after = afterAt >= 0 ? words[afterAt + 1] : undefined;
  if (afterAt >= 0 && (words.lastIndexOf("--after") !== afterAt || !after || Number.isNaN(afterTime(after)))) return null;
  const flagged = new Set([...(at >= 0 ? [at, at + 1] : []), ...(afterAt >= 0 ? [afterAt, afterAt + 1] : [])]);
  const reason = words.filter((_, i) => !flagged.has(i)).join(" ");
  return reason ? { reason, waits: at >= 0 ? words[at + 1]!.split(",").map(Number) : [], ...(flag === "--overlap-waits" ? { overlap: true } : {}), ...(after ? { after } : {}) } : null;
}

export async function release(board: Board, pbi: number, reason: string, waits: number[] = [], overlap = false, after?: string): Promise<void> {
  await board.post(pbi, releaseBody(reason, waits, overlap, after));
  // the session is done with the PBI for now: the other machine may take it
  await board.lease?.(pbi, "release");
}

/** Project owner and number from SWITCHBOARD_PROJECT_URL (the variable, as scripts/setup/*.sh read it). */
async function project(repo: string, run: Run): Promise<{ owner: string; number: string }> {
  const url = process.env.SWITCHBOARD_PROJECT_URL || (await run(["variable", "get", "SWITCHBOARD_PROJECT_URL", "-R", repo])).trim();
  const m = /\/(?:users|orgs)\/([^/]+)\/projects\/(\d+)/.exec(url);
  if (!m) throw new Error(`Project の URL が読めない: ${url || "(空)"}`);
  return { owner: m[1]!, number: m[2]! };
}

/**
 * What the overlap check reads: the top level of the repository, the Task with its PBI, the open PRs, the other
 * In progress Tasks (in the Project, not `needs-decision`, not under a PBI that waits for a date still ahead, not under a PBI
 * no session holds — a Task with no PBI counts) and each prerequisite's state — from GitHub (`ghMaterial`)
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
  /** The files that hold no one back (`sharedFiles`): the app's reading of the checkout, or the caller's. */
  shared: string[];
  /** The places of the PBIs that yielded, as the app keeps them; none when read from GitHub. */
  turns: Turn[];
}

/**
 * Of the Tasks (none with an open PR) the ones that only wait for a check: the PRs that refer to each Task's Issue, read
 * by one GraphQL call for all of them (last 20 references each), those linked to it by `linkedIssues` judged by `waitsOnlyForCheck`.
 * No call when there is no Task.
 */
async function waitingForCheck(owner: string, name: string, tasks: number[], run: Run): Promise<number[]> {
  if (tasks.length === 0) return [];
  const fields = "timelineItems(itemTypes:[CROSS_REFERENCED_EVENT], last:20){ nodes{ ... on CrossReferencedEvent{ source{ ... on PullRequest{ number state body headRefName repository{ nameWithOwner } } } } } }";
  const query = `query($o:String!,$r:String!){ repository(owner:$o,name:$r){ ${tasks.map((n) => `t${n}: issue(number:${n}){ ${fields} }`).join(" ")} } }`;
  const repository = JSON.parse(await run(["api", "graphql", "-f", `query=${query}`, "-f", `o=${owner}`, "-f", `r=${name}`])).data.repository as Record<string, { timelineItems: { nodes: ({ source?: { number?: number; state?: string; body?: string; headRefName?: string; repository?: { nameWithOwner?: string } } } | null)[] } } | null>;
  const here = `${owner}/${name}`.toLowerCase();
  return tasks.filter((n) => {
    // a PR of another repository that mentions this Issue is not linked to it (its `sb/<n>-` branch is that repository's Task)
    const pulls = (repository[`t${n}`]?.timelineItems.nodes ?? []).flatMap((e) => {
      const s = e?.source;
      return s?.number !== undefined && s.state && s.repository?.nameWithOwner?.toLowerCase() === here ? [{ state: s.state, linked: linkedIssues({ body: s.body ?? null, headRefName: s.headRefName ?? null }) }] : [];
    });
    return waitsOnlyForCheck(n, pulls);
  });
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
      "-f", 'query=query($o:String!,$r:String!,$endCursor:String){ repository(owner:$o,name:$r){ issues(states:OPEN, labels:["type:task"], first:100, after:$endCursor){ pageInfo{ hasNextPage endCursor } nodes{ number body updatedAt parent{ number } labels(first:100){ nodes{ name } } projectItems(first:10){ nodes{ project{ number owner{ ... on Organization{ login } ... on User{ login } } } fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } } } } } }',
      "-f", `o=${owner}`, "-f", `r=${name}`,
      "-q", ".data.repository.issues.nodes[] | {number, body, updatedAt, parent, labels, projectItems}",
    ]),
  ) as { number: number; body: string; updatedAt: string; parent?: { number: number } | null; labels: { nodes: { name: string }[] }; projectItems: { nodes: { project: { number: number; owner: { login?: string } }; fieldValueByName: { name?: string } | null }[] } }[];
  // A Project is numbered within its owner: another owner's Project `#2` is not this one
  const inProgress = tasks.filter((t) => {
    const item = t.projectItems.nodes.find((i) => String(i.project.number) === p.number && i.project.owner.login?.toLowerCase() === p.owner.toLowerCase());
    return item?.fieldValueByName?.name === "In progress" && !t.labels.nodes.some((l) => l.name === "needs-decision");
  });
  // a PBI no session holds holds its Tasks' files no more: every comment of it is read, as holder() reads them, for
  // each parent of an In progress Task (a few). A PBI that waits for a date ended with a release, so it is not held either
  const held = new Set<number>();
  for (const n of new Set(inProgress.flatMap((t) => (t.parent ? [t.parent.number] : [])))) {
    if (holder(await comments(repo, n, run)) !== null) held.add(n);
  }
  const unlinked = inProgress.filter((t) => (!t.parent || held.has(t.parent.number)) && !prs.some((pr) => linkedIssues(pr).includes(t.number)));
  const checking = new Set<number>(await waitingForCheck(owner!, name!, unlinked.map((t) => t.number), run));
  return {
    top,
    issue: { body: issue.body, parent: issue.parent && { number: issue.parent.number, body: issue.parent.body, subIssues: issue.parent.subIssues.nodes.map((n: { number: number }) => n.number) } },
    prs: prs.map((pr) => ({ number: pr.number, linked: linkedIssues(pr), updatedAt: pr.updatedAt, files: pr.files.map((f) => f.path), isDraft: pr.isDraft, labels: pr.labels.map((l) => l.name) })),
    // a Task of a PBI no session holds is no one's work: it blocks no other PBI
    working: inProgress.filter((t) => (!t.parent || held.has(t.parent.number)) && !checking.has(t.number)),
    shared: [],
    turns: [],
    target: async (n) => {
      try {
        const r = JSON.parse(await run(["api", `repos/${repo}/issues/${n}`, "-q", "{state, state_reason, merged: (.pull_request.merged_at != null), pr: (.pull_request != null), body, labels: [.labels[].name], sub: .sub_issues_summary}"])) as { state: string; state_reason: string | null; merged: boolean; pr: boolean; body: string | null; labels: string[]; sub: { total: number; completed: number } | null };
        const state = r.pr && r.merged ? "MERGED" : r.state.toUpperCase();
        const confirmOnly = !r.pr && pbiProgress(pbiFactsOf({ labels: r.labels, body: r.body ?? "", status: null, tasks: { total: r.sub?.total ?? 0, done: r.sub?.completed ?? 0 } })).prereqMet;
        return { kind: r.pr ? "pr" : "issue", state, isDraft: false, labels: r.labels, closes: [], stateReason: r.state_reason?.toUpperCase() ?? null, mergeCommit: null, confirmOnly };
      } catch (e) {
        if (!/HTTP 404|HTTP 410|Not Found|Gone/.test((e as Error).message)) throw e;
        return undefined;
      }
    },
  };
}

/**
 * The same material from the app's stored records, read after the app sent and imported (`--fresh`): no GitHub
 * call. A Task not stored cannot be judged (an error, exit 2); a PR stored without all its files, only where it counts (`readOthers`).
 */
export function storedMaterial(r: StoredRecords, task: number, now = Date.now()): Material {
  const issues = new Map(r.issues.map((i) => [i.number, i]));
  const mine = issues.get(task);
  if (!mine || r.unread.includes(task)) throw new Error(`Task #${task} がアプリに保存されていない（または最後の取込みで読めなかった）`);
  const parent = mine.parent === null ? undefined : issues.get(mine.parent);
  if (mine.parent !== null && (!parent || r.unread.includes(mine.parent))) throw new Error(`Task #${task} の親 #${mine.parent} がアプリに保存されていない（または最後の取込みで読めなかった）`);
  const prs = r.pulls.filter((p) => p.state === "OPEN").map((p) => ({ number: p.number, linked: p.closes, updatedAt: p.updatedAt, files: p.files, isDraft: p.isDraft, labels: p.labels }));
  const pulls = new Map(r.pulls.map((p) => [p.number, p]));
  const linked = r.pulls.map((p) => ({ state: p.state, linked: p.closes }));
  return {
    top: r.top.map((t) => ({ ...t })),
    issue: { body: mine.body, parent: parent ? { number: parent.number, body: parent.body, subIssues: parent.subIssues } : null },
    prs,
    // a Task whose PBI waits for a date still ahead holds no file until then; nor does one whose PBI no session holds.
    // A PBI whose last read was not complete may have a claim not stored yet: it counts as held, as the app counts it
    working: r.issues.filter((t) => t.state === "OPEN" && t.labels.includes("type:task") && !t.labels.includes("needs-decision") && t.fields?.Status === "In progress" && !(t.parent !== null && waitsForDate(r.comments.filter((c) => c.issue === t.parent), now)) && (t.parent === null || r.unread.includes(t.parent) || (!r.unheld?.includes(t.parent) && holder(r.comments.filter((c) => c.issue === t.parent).map((c, k) => ({ id: k, body: c.body }))) !== null)) && !waitsOnlyForCheck(t.number, linked)),
    shared: r.shared ?? [],
    turns: r.turns ?? [],
    // an Issue first, as the app reads a number stored as both (a workspace kept only here numbers its own)
    target: async (n) => {
      const i = storedIssueTarget(n, issues, (m) => r.unread.includes(m));
      if (i) return i;
      const p = pulls.get(n);
      return p ? { kind: "pr", state: p.state, isDraft: p.isDraft, labels: p.labels, closes: p.closes, mergeCommit: p.mergeCommit, stateReason: null, confirmOnly: false } : undefined;
    },
  };
}

/** The top level a body's paths are read against: the checkout's, and what the open PRs' files add to it (a Draft's new directory too). */
export function topWith(top: { name: string; dir: boolean }[], prs: { files: string[] | null }[]): { name: string; dir: boolean }[] {
  const out = new Map(top.map((t) => [t.name, t.dir]));
  for (const f of prs.flatMap((pr) => pr.files ?? [])) {
    const [head, ...more] = f.split("/");
    if (head && (more.length > 0 || !out.has(head))) out.set(head, more.length > 0 || out.get(head) === true);
  }
  return [...out].map(([name, dir]) => ({ name, dir }));
}

/**
 * The other work a PBI's Task is compared with (`own`: the PBI, its Tasks), the one reading the app's judgement before a
 * start and the guard in the Task share: each ready PR (not a Draft, not `needs-decision`, not the PBI's own) with its
 * files, and each Task at work (`working`) of another PBI with the paths its body names. A Task with a ready PR and no
 * other is judged by that PR's files, not by its plan; a Draft or `needs-decision` PR reserves nothing by itself, but its
 * files belong to the Task at work on it (with that Task's claim order). `top`: `topWith`. `pathsOfBody`: how a body is read for its paths (the app passes one that remembers). `unknown`: the PRs that count
 * but whose files are not all stored — they cannot be judged.
 */
export function othersOf(own: Set<number>, m: Pick<Material, "prs" | "working">, top: { name: string; dir: boolean }[], pathsOfBody: (body: string) => string[] = (body) => pathsIn(body, top)): { others: Work[]; unknown: number[] } {
  const others: Work[] = [];
  const unknown: number[] = [];
  const parked = (pr: Material["prs"][number]) => pr.isDraft || pr.labels.includes("needs-decision");
  const kept = new Set(m.prs.filter(parked).flatMap((pr) => pr.linked));
  const inPr = new Set(m.prs.filter((pr) => !parked(pr)).flatMap((pr) => pr.linked).filter((n) => !kept.has(n)));
  for (const t of m.working) {
    if (own.has(t.number)) continue;
    others.push({ ref: `Task #${t.number}`, task: t.number, paths: inPr.has(t.number) ? [] : pathsOfBody(t.body), updatedAt: t.updatedAt });
  }
  for (const pr of m.prs) {
    if (pr.linked.some((n) => own.has(n))) continue;
    const active = others.filter((w) => w.ref.startsWith("Task #") && w.task !== undefined && pr.linked.includes(w.task));
    if (parked(pr) && !active.length) continue;
    if (pr.files === null) unknown.push(pr.number);
    // Draft files belong to the live Task: keep its claim ordering when both Tasks resume together.
    else if (parked(pr)) for (const task of active) others.push({ ref: `PR #${pr.number}`, task: task.task, paths: pr.files, updatedAt: pr.updatedAt });
    else others.push({ ref: `PR #${pr.number}`, paths: pr.files, updatedAt: pr.updatedAt });
  }
  // Keep PRs before Tasks in the diagnostic, as before.
  others.sort((a, b) => Number(!a.ref.startsWith("PR #")) - Number(!b.ref.startsWith("PR #")));
  return { others, unknown };
}

const NO_FILES = (pr: number) => `PR #${pr} の変更ファイルが記録に無い（101 件以上）`;

/** The Task's paths (its body's, and its own PRs' files), the other work (`othersOf`) with the places ahead of its PBI's (`turnsAhead`), and its prerequisites. */
export async function readOthers(task: number, m: Material): Promise<{ paths: string[]; others: Work[]; prereqs: Prereq[]; shared: string[] }> {
  const { issue } = m;
  const own = new Set<number>([task, ...(issue.parent?.subIssues ?? [])]);
  if (issue.parent) own.add(issue.parent.number);
  const top = topWith(m.top, m.prs);
  const paths = pathsIn(issue.body, top);
  for (const pr of m.prs) {
    if (!pr.linked.includes(task)) continue;
    if (pr.files === null) throw new Error(NO_FILES(pr.number));
    paths.push(...pr.files);
  }
  const { others, unknown } = othersOf(own, m, top);
  if (unknown.length) throw new Error(NO_FILES(unknown[0]!));
  others.push(...turnsAhead(m.turns, issue.parent?.number ?? null).filter((w) => !own.has(w.task!)));
  const siblings = new Set<number>(issue.parent?.subIssues ?? []);
  return { paths: [...new Set(paths)], others, prereqs: await readPrereqs([issue.body, issue.parent?.body ?? ""], siblings, m.target), shared: m.shared };
}

/**
 * The prerequisites the Task's and its PBI's bodies name, each read by `target` (from GitHub: a 404 / 410 = not
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
    const { state, confirming } = prereqOf(t, t?.kind === "pr" ? "merged" : release ? "release" : "done", () => null);
    const fix = t?.kind === "issue" && release && state === "unknown" ? "Issue に（リリース）が付いている。この Issue を閉じた PR の番号に書き直す" : undefined;
    out.push({ ref: `${t?.kind === "pr" ? "PR " : ""}#${n}`, state, sibling: siblings.has(n), ...(fix ? { fix } : {}), ...(confirming ? { confirming } : {}) });
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
  const { paths, others, prereqs, shared } = found;
  if (paths.length === 0) {
    await back();
    throw new Error(`Task #${task} の本文に触るファイルのパスが無い（pbi-to-tasks で名指しする）`);
  }
  if (claimId !== undefined) {
    for (const w of others) {
      if (w.task !== undefined && w.turn === undefined && paths.some((a) => w.paths.some((b) => overlaps(a, b)))) {
        w.claimId = lastClaim(await board.comments(w.task));
      }
    }
  }
  const v = judge({ paths, claimId }, others, now, shared);
  const verdict = prereqVerdict(prereqs) ?? v.verdict;
  if (verdict !== "go") await back();
  const conditions = waitConditions({ verdict, blocking: v.blocking, prereqs });
  return { paths, ...v, verdict, ...(prereqs.length ? { prereqs } : {}), ...(conditions.length ? { conditions } : {}) };
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
      "usage: bun scripts/parallel-guard.ts claim <PBI> [--takeover] | release <PBI> <理由> [--waits <n,n,...>] [--after <ISO 8601 のタイムゾーンつき日時>] | overlap <Task> [--claimed]  [--repo <owner/name>]",
    );
    process.exit(2);
  };
  const named = repoAt >= 0 ? args[repoAt + 1] : undefined;
  const repoName = /^[\w.-]+\/[\w.-]+$/;
  if (!/^\d+$/.test(num ?? "") || (repoAt >= 0 && !repoName.test(named ?? ""))) usage();
  // with BACKLOG_URL, a repository the app syncs has its claims and records there, whether or not GitHub is
  // behind it, and gh is not called. An app that cannot be asked cannot judge: it never falls back to GitHub (exit 2).
  // Only a repository it does not know goes on with GitHub's comments, as without BACKLOG_URL
  let board: Board | undefined;
  if (env.BACKLOG_URL) {
    try {
      if (await appSync(env, { repo: named })) board = appBoard(env, fetch, named);
    } catch (e) {
      if (!(e instanceof BacklogUnknown)) throw e;
      console.error(`判定できなかった: ${e.message}`);
      process.exit(2);
    }
  }
  if (!board) {
    let repo = named;
    try {
      repo ??= currentRepo();
    } catch {
      usage();
    }
    if (!repo || !repoName.test(repo)) usage();
    board = ghBoard(repo!, gh, sharedFilesOf());
  }
  try {
    if (cmd === "claim") {
      const r = await claim(board, n!, more.includes("--takeover"));
      console.log(JSON.stringify(r, null, 2));
      if (!r.held) console.log(r.leased ?? `PBI #${n} は別のセッションが実行中（コメント ${r.holder?.id}）`);
      process.exit(r.held ? 0 : 1);
    } else if (cmd === "release") {
      const r = releaseArgs(more);
      if (!r) usage();
      await release(board, n!, r!.reason, r!.waits, r!.overlap, r!.after);
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
