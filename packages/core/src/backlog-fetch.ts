/**
 * The reads of GitHub an import is made of (the head of backlog-sync.ts says which and when): the GraphQL queries, the
 * pages of a list read to the end, and `fetchGithubSnapshot`, which turns what GitHub answered into the entries
 * Db.putBacklogSnapshot stores. Nothing here writes to the database.
 */
import type { BacklogCommentData, BacklogIssueData, BacklogPullRequestData, BacklogObjectKind, BacklogRecord, BacklogProjectField, BacklogSource } from "@switchboard/protocol";
import type { BacklogSnapshotEntry } from "./db.ts";
import { BacklogError, GH_LOGIN_REFUSED, type GhRunner } from "./backlog-gh.ts";
import { confirmationsOf, confirmDecisionsOf, prereqsOf } from "./backlog-item.ts";
import { waitsOf } from "./backlog-waits.ts";
import { linkedIssues } from "../../../scripts/task-paths.ts";
import { parseIncluded, responseOf } from "../../../ops-kit/src/gh.ts";

export const TYPES = ["type:request", "type:pbi", "type:task"];
const LABELS = `labels:${JSON.stringify(TYPES)}`;
const FIELD = "field{ ... on ProjectV2FieldCommon{ name } }";
const PROJECT_ITEMS = `projectItems(first:20){ totalCount nodes{ id project{ number owner{ ... on Organization{ login } ... on User{ login } } } fieldValues(first:50){ totalCount nodes{ ... on ProjectV2ItemFieldSingleSelectValue{ name ${FIELD} } ... on ProjectV2ItemFieldNumberValue{ number ${FIELD} } ... on ProjectV2ItemFieldTextValue{ text ${FIELD} } ... on ProjectV2ItemFieldDateValue{ date ${FIELD} } } } } }`;
const COMMENTS = "pageInfo{ hasNextPage endCursor } nodes{ id body createdAt }";
const ISSUE = `id number title url state stateReason body createdAt updatedAt closedAt milestone{ title } parent{ number } labels(first:100){ totalCount nodes{ name } } subIssues(first:100){ totalCount nodes{ number } } comments(first:100){ ${COMMENTS} } ${PROJECT_ITEMS}`;

const changedQuery = (since: boolean) =>
  `query($o:String!,$r:String!,$after:String${since ? ",$since:DateTime!" : ""}){ repository(owner:$o,name:$r){ issues(first:50, after:$after, states:[OPEN,CLOSED], ${LABELS}${since ? ", filterBy:{since:$since}" : ""}, orderBy:{field:UPDATED_AT, direction:ASC}){ pageInfo{ hasNextPage endCursor } nodes{ ${ISSUE} } } } }`;
const PR_FILES = "files(first:100){ totalCount nodes{ path } }";
const PR_FIELDS = `id number state isDraft updatedAt closedAt mergedAt headRefName headRefOid body labels(first:100){ totalCount nodes{ name } } ${PR_FILES} comments(first:100){ ${COMMENTS} }`;
/** The open Issues with their Project items and Milestone. */
const OPEN_ISSUES = `query($o:String!,$r:String!,$after:String){ repository(owner:$o,name:$r){ issues(first:100, after:$after, states:OPEN, ${LABELS}){ pageInfo{ hasNextPage endCursor } nodes{ number milestone{ title } ${PROJECT_ITEMS} } } } }`;
const OPEN_PULLS = `query($o:String!,$r:String!,$after:String){ repository(owner:$o,name:$r){ pullRequests(first:50, after:$after, states:OPEN, orderBy:{field:UPDATED_AT, direction:DESC}){ pageInfo{ hasNextPage endCursor } nodes{ ${PR_FIELDS} } } } }`;
const PROJECT_ID = "query($o:String!,$p:Int!){ repositoryOwner(login:$o){ ... on ProjectV2Owner{ projectV2(number:$p){ id fields(first:50){ nodes{ ... on ProjectV2FieldCommon{ name dataType } ... on ProjectV2SingleSelectField{ options{ name } } } } } } } }";
const MORE_COMMENTS = `query($o:String!,$r:String!,$n:Int!,$after:String!){ repository(owner:$o,name:$r){ issue(number:$n){ comments(first:100, after:$after){ ${COMMENTS} } } } }`;
const MORE_PULL_COMMENTS = `query($o:String!,$r:String!,$n:Int!,$after:String!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ comments(first:100, after:$after){ ${COMMENTS} } } } }`;
const recheckQuery = (numbers: number[]) =>
  `query($o:String!,$r:String!){ repository(owner:$o,name:$r){ ${numbers.map((n) => `w${n}: issueOrPullRequest(number:${n}){ __typename ... on Issue{ ${ISSUE} } ... on PullRequest{ ${PR_FIELDS} mergeCommit{ oid } } }`).join(" ")} } }`;
/** The Project items of the Issues named: what a light import reads of those it has to (`items`). */
const itemsQuery = (numbers: number[]) =>
  `query($o:String!,$r:String!){ repository(owner:$o,name:$r){ ${numbers.map((n) => `w${n}: issue(number:${n}){ number ${PROJECT_ITEMS} }`).join(" ")} } }`;
/** The Issues a PR closes: the rule of `scripts/task-paths.ts` (`linkedIssues`). No duplicates, ascending. */
export const closesOf = (body: string | null, headRefName: string | null): number[] => [...new Set(linkedIssues({ body, headRefName }))].sort((a, b) => a - b);
/** A PR as stored: `files` null = more than the 100 read, so what it touches is not fully known. */
function pullEntry(raw: RawPull): BacklogSnapshotEntry {
  const text = (v: unknown) => typeof v === "string";
  if (!text(raw?.id) || typeof raw.number !== "number" || !text(raw.state) || !text(raw.updatedAt)) throw new BacklogError("gh api graphql（PR）の応答の形が想定と違います");
  const f = raw.files;
  const files = Array.isArray(f?.nodes) && typeof f.totalCount === "number" && f.totalCount <= f.nodes.length ? f.nodes.map((x) => x.path) : null;
  return {
    objectKind: "pull-request", externalId: raw.id, fetchState: "fetched",
    remote: { number: raw.number, state: raw.state, isDraft: !!raw.isDraft, labels: all(raw.labels, `#${raw.number} のラベル`).map((l) => l.name), closes: closesOf(raw.body, raw.headRefName), mergeCommit: raw.mergeCommit?.oid ?? null, updatedAt: raw.updatedAt, files, closedAt: raw.closedAt ?? null, mergedAt: raw.mergedAt ?? null, head: raw.headRefOid ?? null },
  };
}
/** Numbers per recheck query: each alias is a whole Issue. */
const RECHECK_BATCH = 20;

type Page<T> = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: T[] };
type Counted<T> = { totalCount: number; nodes: T[] };
type RawItem = { id: string; project: { number: number; owner: { login: string } }; fieldValues: Counted<{ name?: string; number?: number; text?: string; date?: string; field?: { name: string } }> };
type RawPull = { id: string; number: number; state: "OPEN" | "CLOSED" | "MERGED"; isDraft: boolean; updatedAt: string; closedAt?: string | null; mergedAt?: string | null; headRefName: string | null; headRefOid?: string | null; body: string | null; comments: Page<RawComment>; labels: Counted<{ name: string }>; files: Counted<{ path: string }>; mergeCommit?: { oid: string } | null };
type RawComment = { id: string; body: string; createdAt: string };
type RawIssue = {
  id: string; number: number; title: string; url: string; state: "OPEN" | "CLOSED"; stateReason?: BacklogIssueData["stateReason"]; body: string; createdAt: string; updatedAt: string; closedAt?: string | null;
  milestone: { title: string } | null; parent: { number: number } | null; labels: Counted<{ name: string }>; subIssues: Counted<{ number: number }>;
  comments: Page<RawComment>; projectItems: Counted<RawItem>;
};
type GqlError = { type?: string; path?: Array<string | number>; message?: string };
type Vars = Record<string, string | number>;

/**
 * One GraphQL call. `partial`: an alias GitHub answered with NOT_FOUND / FORBIDDEN is an answer (null data plus the
 * error), not a failure; every other error fails the import.
 */
async function graphql(gh: GhRunner, cwd: string, query: string, vars: Vars, partial = false): Promise<{ data: any; errors: GqlError[] }> {
  const args = ["api", "graphql", "--include", "-f", `query=${query}`, ...Object.entries(vars).flatMap(([k, v]) => (typeof v === "number" ? ["-F", `${k}=${v}`] : ["-f", `${k}=${v}`]))];
  const r = await gh(args, cwd);
  let answer: { data?: unknown; errors?: GqlError[] } | null = null;
  try {
    answer = JSON.parse(parseIncluded(r.stdout).body);
  } catch {}
  const errors = Array.isArray(answer?.errors) ? answer.errors : [];
  const answered = errors.every((e) => partial && (e.type === "NOT_FOUND" || e.type === "FORBIDDEN") && e.path?.length === 2);
  if (!answer?.data || !answered || (r.code !== 0 && !errors.length))
    throw new BacklogError(`gh api graphql: ${(errors[0]?.message ?? (r.stderr.trim() || `exit ${r.code}`)).slice(0, 200)}`, responseOf(r.stdout, r.stderr), r.code !== 0 && !errors.length && GH_LOGIN_REFUSED.test(r.stderr) ? "gh-login" : undefined);
  return { data: answer.data, errors };
}

function page<T>(p: unknown, what: string): Page<T> {
  const v = p as Page<T> | undefined;
  if (!v || !Array.isArray(v.nodes) || typeof v.pageInfo?.hasNextPage !== "boolean") throw new BacklogError(`gh api graphql（${what}）の応答の形が想定と違います`);
  return v;
}

/** Throws when a list was cut at its `first:` — an import is complete or not stored. */
function all<T>(c: Counted<T> | undefined, what: string): T[] {
  if (!c || !Array.isArray(c.nodes) || c.totalCount > c.nodes.length) throw new BacklogError(`${what}を全部は読めません（${c?.totalCount ?? "?"} 件）`);
  return c.nodes;
}

function itemEntries(issue: number, items: Counted<RawItem> | undefined): BacklogSnapshotEntry[] {
  return all(items, `#${issue} の Project 項目`).map((i) => {
    const fields = Object.fromEntries(all(i.fieldValues, `#${issue} の Project 項目の値`).flatMap((v) => (v.field?.name ? [[v.field.name, v.name ?? v.number ?? v.text ?? v.date ?? null]] : [])));
    return { objectKind: "project-item", externalId: i.id, remote: { issue, owner: i.project.owner.login, project: i.project.number, fields }, fetchState: "fetched" };
  });
}

/** Every comment of Issue or pull request `n`: the first page is `first`, the pages after it are asked for with `more`. */
async function allComments(gh: GhRunner, cwd: string, vars: Vars, n: number, first: unknown, more: string, field: "issue" | "pullRequest"): Promise<BacklogSnapshotEntry[]> {
  const comments = [...page<RawComment>(first, `#${n} のコメント`).nodes];
  for (let p = first as Page<RawComment>; p.pageInfo.hasNextPage; ) {
    const { data } = await graphql(gh, cwd, more, { ...vars, n, after: p.pageInfo.endCursor ?? "" });
    p = page<RawComment>(data?.repository?.[field]?.comments, `#${n} のコメント`);
    comments.push(...p.nodes);
  }
  return comments.map((c): BacklogSnapshotEntry => ({ objectKind: "comment", externalId: c.id, remote: { issue: n, body: c.body, createdAt: c.createdAt }, fetchState: "fetched" }));
}

/** A pull request read in full: itself and every comment, kept as `comment` records of the PR's number. */
async function pullEntries(gh: GhRunner, cwd: string, vars: Vars, raw: RawPull): Promise<BacklogSnapshotEntry[]> {
  const entry = pullEntry(raw);
  return [entry, ...(await allComments(gh, cwd, vars, raw.number, raw.comments, MORE_PULL_COMMENTS, "pullRequest"))];
}

/** An Issue read in full: itself, every comment (the pages after the first are asked for), its Project items. */
async function issueEntries(gh: GhRunner, cwd: string, vars: Vars, raw: RawIssue): Promise<BacklogSnapshotEntry[]> {
  const text = (v: unknown) => typeof v === "string";
  if (!text(raw?.id) || typeof raw.number !== "number" || ![raw.title, raw.url, raw.state, raw.body, raw.createdAt, raw.updatedAt].every(text))
    throw new BacklogError("gh api graphql（Issue）の応答の形が想定と違います");
  const n = raw.number;
  const comments = await allComments(gh, cwd, vars, n, raw.comments, MORE_COMMENTS, "issue");
  const issue: BacklogIssueData = {
    number: n, title: raw.title, url: raw.url, state: raw.state, stateReason: raw.stateReason ?? null, body: raw.body, labels: all(raw.labels, `#${n} のラベル`).map((l) => l.name),
    milestone: raw.milestone?.title ?? null, parent: raw.parent?.number ?? null, subIssues: all(raw.subIssues, `#${n} の sub-issue`).map((s) => s.number),
    createdAt: raw.createdAt, updatedAt: raw.updatedAt, closedAt: raw.closedAt ?? null,
  };
  return [
    { objectKind: "issue", externalId: raw.id, remote: issue, fetchState: "fetched" },
    ...comments,
    ...itemEntries(n, raw.projectItems),
  ];
}

const issueNumber = (r: BacklogRecord) => (r.remote ? ("issue" in r.remote ? r.remote.issue : r.remote.number) : null);

/**
 * Reads what one import stores, against what is `stored` for the repository. `since` = the cursor: the newest
 * `updatedAt` of the last import (null = read every Issue). `full` = false leaves out what costs as much as there are
 * open Issues: their Project items, and asking again by number the stored ones that list no longer has (a first import
 * is full all the same). `items` names the Issues whose Project items are read all the same, unless a list has them.
 * Throws BacklogError on any failure.
 */
export async function fetchGithubSnapshot(gh: GhRunner, cwd: string, repo: { owner: string; name: string }, stored: BacklogRecord[], since: string | null, full = true, items: number[] = [], stopWaits: number[] = []): Promise<{ records: BacklogSnapshotEntry[]; cursor: string | null }> {
  const vars: Vars = { o: repo.owner, r: repo.name };
  const out = new Map<string, BacklogSnapshotEntry>();
  const put = (e: BacklogSnapshotEntry) => out.set(`${e.objectKind}:${e.externalId}`, e);
  // the stored records by kind and Issue, made once: `replace` runs per Issue and kind, and a scan of all `stored` each time is quadratic
  const byIssue = new Map<string, string[]>();
  for (const r of stored) {
    const key = `${r.objectKind}:${issueNumber(r)}`;
    const ids = byIssue.get(key);
    if (ids) ids.push(r.externalId);
    else byIssue.set(key, [r.externalId]);
  }
  const children = (kind: BacklogObjectKind, n: number) => byIssue.get(`${kind}:${n}`) ?? [];
  /** Puts `entries` and marks the stored `kind` records of Issue n they no longer list. */
  const replace = (n: number, kinds: BacklogObjectKind[], entries: BacklogSnapshotEntry[]) => {
    entries.forEach(put);
    for (const kind of kinds) {
      const seen = new Set(entries.filter((e) => e.objectKind === kind).map((e) => e.externalId));
      for (const id of children(kind, n)) if (!seen.has(id)) put({ objectKind: kind, externalId: id, remote: null, fetchState: "unavailable" });
    }
  };
  const read = new Set<number>();
  /** Asked at once, the reads of one import do not wait for each other; what they find is put in the order a sequential read would. A read nobody awaits yet must not be an unhandled rejection. */
  const started = <T,>(p: Promise<T>) => (p.catch(() => {}), p);
  const readIssue = (raw: RawIssue) => started(issueEntries(gh, cwd, vars, raw));
  const putIssue = (n: number, entries: BacklogSnapshotEntry[]) => {
    replace(n, ["comment", "project-item"], entries);
    read.add(n);
  };

  /** List 1: the Issues changed since the cursor; the pages follow each other by their cursor, each Issue's comment pages are read while the next page is. */
  const listChanged = async () => {
    const found: Array<{ raw: RawIssue; entries: Promise<BacklogSnapshotEntry[]> }> = [];
    for (let after: string | null = null; ; ) {
      const { data } = await graphql(gh, cwd, changedQuery(!!since), { ...vars, ...(after ? { after } : {}), ...(since ? { since } : {}) });
      const issues = page<RawIssue>(data?.repository?.issues, "Issue");
      for (const raw of issues.nodes) found.push({ raw, entries: readIssue(raw) });
      if (!issues.pageInfo.hasNextPage) break;
      after = issues.pageInfo.endCursor;
    }
    return found;
  };
  /** List 2: the open Issues with their Project items and Milestone. */
  const open = new Set<number>();
  const listsOpen = full || !since;
  const listOpen = async () => {
    const found: Array<{ number: number; milestone: { title: string } | null; projectItems: Counted<RawItem> }> = [];
    for (let after: string | null = null; listsOpen; ) {
      const { data } = await graphql(gh, cwd, OPEN_ISSUES, { ...vars, ...(after ? { after } : {}) });
      const issues = page<{ number: number; milestone: { title: string } | null; projectItems: Counted<RawItem> }>(data?.repository?.issues, "開いた Issue");
      found.push(...issues.nodes);
      if (!issues.pageInfo.hasNextPage) break;
      after = issues.pageInfo.endCursor;
    }
    return found;
  };
  /** List 3: the open PRs. */
  const listPulls = async () => {
    const found: RawPull[] = [];
    for (let after: string | null = null; ; ) {
      const { data } = await graphql(gh, cwd, OPEN_PULLS, { ...vars, ...(after ? { after } : {}) });
      const pulls = page<RawPull>(data?.repository?.pullRequests, "開いた PR");
      found.push(...pulls.nodes);
      if (!pulls.pageInfo.hasNextPage) break;
      after = pulls.pageInfo.endCursor;
    }
    return found;
  };
  const pullsRead = started(listPulls());
  /** An open PR's comment pages are asked while the lists are still read. */
  const putPull = (raw: RawPull, entries: Promise<BacklogSnapshotEntry[]>) => entries.then((e) => replace(raw.number, ["comment"], e));

  let cursor = since;
  const [changed, opened] = await Promise.all([listChanged(), listOpen()]);
  for (const { raw, entries } of changed) {
    putIssue(raw.number, await entries);
    if (!cursor || raw.updatedAt > cursor) cursor = raw.updatedAt;
  }
  // the stored Issue records by number, made once: a Milestone deleted on GitHub leaves the Issue's updatedAt where it was
  const storedIssues = new Map<number, BacklogRecord>();
  for (const r of stored) if (r.objectKind === "issue" && r.fetchState === "fetched" && !r.externalId.startsWith("sb:") && r.remote) storedIssues.set(issueNumber(r) as number, r);
  for (const raw of opened) {
    open.add(raw.number);
    if (read.has(raw.number)) continue;
    replace(raw.number, ["project-item"], itemEntries(raw.number, raw.projectItems));
    const record = storedIssues.get(raw.number);
    const milestone = raw.milestone?.title ?? null;
    if (record && (record.remote as BacklogIssueData).milestone !== milestone) put({ objectKind: "issue", externalId: record.externalId, remote: { ...(record.remote as BacklogIssueData), milestone }, fetchState: "fetched" });
  }
  // without the list, an open Issue is one stored as read and open with the list's labels: closing it moved its
  // updatedAt, so the first read has it. Any other (a wait on an Issue of no type) is asked by number, as it was
  const listed = new Set(open);
  if (!listsOpen) for (const r of stored) {
    const issue = r.objectKind === "issue" && r.fetchState === "fetched" && !r.externalId.startsWith("sb:") ? (r.remote as BacklogIssueData | null) : null;
    if (issue?.state === "OPEN" && issue.labels.some((l) => TYPES.includes(l))) open.add(issue.number);
  }

  // a closed Issue is on no list: a full import asks it too
  const asked = [...new Set(items)].filter((n) => !read.has(n) && !listed.has(n)).sort((a, b) => a - b);
  const askedBatches = Array.from({ length: Math.ceil(asked.length / RECHECK_BATCH) }, (_, i) => asked.slice(i * RECHECK_BATCH, (i + 1) * RECHECK_BATCH));
  const askedAnswersRead = started(Promise.all(askedBatches.map((batch) => graphql(gh, cwd, itemsQuery(batch), vars, true))));

  const openPulls = new Set<number>();
  const pulls = await pullsRead;
  const pullReads = pulls.map((raw) => ({ raw, entries: started(pullEntries(gh, cwd, vars, raw)) }));
  for (const raw of pulls) openPulls.add(raw.number);
  // what is known after the two lists: the stored records with `entries` (this import's) on top. What is asked again
  // follows from it, so it is worked out twice: before the Project items of the named Issues are in (to start at once), and after
  const recheckNumbers = (entries: Map<string, BacklogSnapshotEntry>) => {
    const known = new Map(stored.map((r) => [`${r.objectKind}:${r.externalId}`, { kind: r.objectKind, id: r.externalId, remote: r.remote, state: r.fetchState }]));
    for (const [k, e] of entries) known.set(k, { kind: e.objectKind, id: e.externalId, remote: e.fetchState === "fetched" ? e.remote : (known.get(k)?.remote ?? null), state: e.fetchState });
    // an Issue made here and not on GitHub yet (turning the sync on) is no Issue of GitHub's to ask for
    const issues = [...known.values()].filter((r) => r.kind === "issue" && r.remote && !r.id.startsWith("sb:")) as Array<{ id: string; remote: BacklogIssueData }>;
    const stale = !listsOpen ? [] : issues.filter((r) => r.remote.state === "OPEN" && !open.has(r.remote.number) && !read.has(r.remote.number)).map((r) => r.remote.number);
    const waits = issues
      .filter((r) => r.remote.state === "OPEN" && r.remote.labels.includes("type:pbi"))
      .flatMap((pbi) => {
        const comments = [...known.values()].filter((c) => c.kind === "comment" && c.state === "fetched" && (c.remote as BacklogCommentData | null)?.issue === pbi.remote.number).map((c) => c.remote as BacklogCommentData);
        return waitsOf(comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))?.numbers ?? [];
      });
    // the prerequisites an open PBI / Task names are asked like the waits
    const prereqs = issues.filter((r) => r.remote.state === "OPEN" && (r.remote.labels.includes("type:pbi") || r.remote.labels.includes("type:task"))).flatMap((r) => prereqsOf(r.remote.body).map((p) => p.number));
    // and the decisions an open In progress / In review PBI's confirmation lines name to be checked by their answers
    const working = new Set([...known.values()].filter((r) => r.kind === "project-item" && ["In progress", "In review"].includes(String((r.remote as { fields?: Record<string, unknown> } | null)?.fields?.Status))).map((r) => (r.remote as { issue: number }).issue));
    const confirmDecisions = issues
      .filter((r) => r.remote.state === "OPEN" && r.remote.labels.includes("type:pbi") && working.has(r.remote.number))
      .flatMap((r) => confirmationsOf(r.remote.body).flatMap((c) => confirmDecisionsOf(c.text)));
    const byNumber = new Map([...known.values()].filter((r) => (r.kind === "issue" || r.kind === "pull-request") && r.remote && !r.id.startsWith("sb:")).map((r) => [(r.remote as { number: number }).number, r]));
    // a wait on a closed request / PBI / Task is answered by what is stored: reopening it moves its updatedAt, and the
    // first read lists it then. Another closed Issue is asked again: no list would show it reopened
    const closed = (n: number) => {
      const r = byNumber.get(n);
      const issue = r?.kind === "issue" && r.state === "fetched" ? (r.remote as BacklogIssueData) : null;
      return !!issue && issue.state === "CLOSED" && issue.labels.some((l) => TYPES.includes(l));
    };
    // a stored open PR the full list no longer has was closed or merged: asked again by its number
    const gone = [...known.values()].filter((r) => r.kind === "pull-request" && (r.remote as BacklogPullRequestData | null)?.state === "OPEN").map((r) => (r.remote as BacklogPullRequestData).number).filter((n) => !openPulls.has(n));
    // and what the Tasks' depends stops wait for, asked like the waits
    const numbers = [...new Set([...stale, ...gone, ...[...waits, ...prereqs, ...confirmDecisions, ...stopWaits].filter((n) => !closed(n))])].filter((n) => !read.has(n) && !open.has(n) && !openPulls.has(n)).sort((a, b) => a - b);
    return { numbers, byNumber };
  };
  // the rechecks do not wait for the items' answer: they are asked for what the items cannot change, and the rest after
  const askRecheck = (numbers: number[]) => {
    const batches = Array.from({ length: Math.ceil(numbers.length / RECHECK_BATCH) }, (_, i) => numbers.slice(i * RECHECK_BATCH, (i + 1) * RECHECK_BATCH));
    // a batch's failure counts only for the numbers still wanted after the items: one asked early and no longer needed does not fail the import
    return started(Promise.all(batches.map((batch) => graphql(gh, cwd, recheckQuery(batch), vars, true).then((answer) => ({ answer }), (error: unknown) => ({ error })))).then((answers) => batches.flatMap((batch, i) => batch.map((n) => ({ n, ...answers[i]! })))));
  };
  const early = new Map(out);
  for (const e of pulls.map(pullEntry)) early.set(`${e.objectKind}:${e.externalId}`, e);
  const firstNumbers = recheckNumbers(early).numbers;
  const firstRead = askRecheck(firstNumbers);

  const askedAnswers = await askedAnswersRead;
  askedBatches.forEach((batch, i) => {
    // one gone or hidden is seen by a full import
    for (const n of batch) if (askedAnswers[i]!.data?.repository?.[`w${n}`]) replace(n, ["project-item"], itemEntries(n, askedAnswers[i]!.data.repository[`w${n}`].projectItems));
  });
  for (const { raw, entries } of pullReads) await putPull(raw, entries);

  // the items may have moved a PBI to In progress: what its confirmation lines name is asked now (normally nothing)
  const { numbers, byNumber } = recheckNumbers(out);
  const firstAsked = new Set(firstNumbers);
  const laterRead = askRecheck(numbers.filter((n) => !firstAsked.has(n)));
  const wanted = new Set(numbers);
  const answered = new Map<number, Awaited<ReturnType<typeof graphql>>>();
  for (const r of [...(await firstRead), ...(await laterRead)].filter(({ n }) => wanted.has(n))) {
    if ("error" in r) throw r.error;
    answered.set(r.n, r.answer!);
  }
  // the Issues' comment pages are asked together, what comes back is put in the order of the numbers
  const rechecked = numbers.map((n) => { const answer = answered.get(n)!; return { n, node: answer.data?.repository?.[`w${n}`], errors: answer.errors, entries: answer.data?.repository?.[`w${n}`]?.__typename === "Issue" ? readIssue(answer.data.repository[`w${n}`]) : null }; });
  for (const { n, node, errors, entries } of rechecked) {
    if (entries) putIssue(node.number, await entries);
    else if (node?.__typename === "PullRequest")
      await putPull(node, pullEntries(gh, cwd, vars, node));
    else {
      const type = errors.find((e) => e.path?.[1] === `w${n}`)?.type;
      if (type !== "NOT_FOUND" && type !== "FORBIDDEN") throw new BacklogError(`gh api graphql（再確認）の応答に #${n} がありません`);
      const prev = byNumber.get(n);
      if (prev) put({ objectKind: prev.kind, externalId: prev.id, remote: null, fetchState: type === "FORBIDDEN" ? "forbidden" : "unavailable" } as BacklogSnapshotEntry);
    }
  }
  return { records: [...out.values()], cursor };
}

/**
 * Refuses an import whose token cannot read the Project: GitHub then leaves the Project's items out of every
 * Issue without an error, which reads as "not in the Project" and would mark every stored item gone. It answers such a
 * Project as null, with no error or with NOT_FOUND / FORBIDDEN. A limit or a refused login still fails as itself. Throws BacklogError.
 */
export async function requireReadableProject(gh: GhRunner, cwd: string, project: BacklogSource["project"]): Promise<BacklogProjectField[]> {
  const { data } = await graphql(gh, cwd, PROJECT_ID, { o: project.owner, p: project.number }, true);
  const p = data?.repositoryOwner?.projectV2;
  if (!p?.id) throw new BacklogError(`Project ${project.owner}/${project.number} を読めない（トークンの権限）`);
  // the same answer gives the fields a value can be written to, in the Project's order; the others (ITERATION,
  // TITLE, LABELS …) are no field a `set` sends
  const nodes = (p.fields?.nodes ?? []) as Array<{ name?: string; dataType?: string; options?: Array<{ name: string }> }>;
  return nodes.flatMap((f) => (f.name && (WRITABLE as readonly string[]).includes(f.dataType ?? "") ? [{ name: f.name, dataType: f.dataType as BacklogProjectField["dataType"], options: (f.options ?? []).map((o) => o.name) }] : []));
}
const WRITABLE = ["SINGLE_SELECT", "NUMBER", "TEXT", "DATE"] as const;
