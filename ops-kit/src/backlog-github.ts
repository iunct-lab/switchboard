import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Detail, ListFilter } from "./backlog-client.ts";
import type { OpsConfig } from "./config.ts";
import type { GhClient } from "./gh.ts";
import { setField } from "./set.ts";

/**
 * `ops-kit backlog …` without BACKLOG_URL (#3071): outside the app's Task, the same commands read and write GitHub
 * itself, in the same shape as with the app. Only when there is no BACKLOG_URL: an app that cannot be reached is never
 * replaced by GitHub (backlog-client.ts).
 */

export interface Repo {
  owner: string;
  name: string;
}
export type Project = { owner: string; number: number } | null;

const FIELD = "field{ ... on ProjectV2FieldCommon{ name } }";
/** The Project's items of an Issue, read as the app reads them (packages/core/src/backlog-sync.ts `PROJECT_ITEMS`). */
const PROJECT_ITEMS = `projectItems(first:20){ nodes{ project{ number owner{ ... on Organization{ login } ... on User{ login } } } fieldValues(first:50){ nodes{ ... on ProjectV2ItemFieldSingleSelectValue{ name ${FIELD} } ... on ProjectV2ItemFieldNumberValue{ number ${FIELD} } ... on ProjectV2ItemFieldTextValue{ text ${FIELD} } ... on ProjectV2ItemFieldDateValue{ date ${FIELD} } } } } }`;

interface ProjectItems {
  nodes: Array<{ project: { number: number; owner?: { login?: string } }; fieldValues: { nodes: Array<{ name?: string; number?: number; text?: string; date?: string; field?: { name?: string } }> } }>;
}

/** The Project's fields of an Issue (as the app stores them): null when the Issue is not in the Project (its owner and number). `viewer`: who `@me` is. */
function fieldsOf(items: ProjectItems | undefined, project: Project, viewer: string | undefined): Record<string, string | number | null> | null {
  const owner = (project?.owner === "@me" ? viewer : project?.owner)?.toLowerCase();
  const item = project && owner ? items?.nodes.find((n) => n.project?.number === project.number && n.project.owner?.login?.toLowerCase() === owner) : undefined;
  if (!item) return null;
  const fields: Record<string, string | number | null> = {};
  for (const v of item.fieldValues.nodes) if (v.field?.name) fields[v.field.name] = v.name ?? v.number ?? v.text ?? v.date ?? null;
  return fields;
}

/** `viewer{ login }` when the Project is the signed-in user's (`@me`): its owner is matched by that login. */
const viewerOf = (project: Project) => (project?.owner === "@me" ? "viewer{ login } " : "");

/** The search for `f`: GitHub's word search is wider than a part of the title, so the caller filters again. */
export function searchQuery(repo: Repo, f: ListFilter): string {
  const word = f.search?.replace(/"/g, " ").trim();
  return [`repo:${repo.owner}/${repo.name}`, "is:issue", ...(f.state === "all" ? [] : [`is:${f.state}`]), ...f.labels.map((l) => `label:"${l.replace(/"/g, "")}"`), ...(word ? [`"${word}" in:title`] : [])].join(" ");
}

/** The Issues of `repo` for `f`, with their Status in `project` (null = not in it, or no Project). */
export async function listFromGithub(gh: GhClient, repo: Repo, project: Project, f: ListFilter): Promise<Array<{ number: number; title: string; state: string; labels: string[]; status: string | null }>> {
  const query = `query($q:String!,$after:String){ ${viewerOf(project)}search(type:ISSUE, query:$q, first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ ... on Issue{ number title state labels(first:50){ nodes{ name } } ${project ? PROJECT_ITEMS : ""} } } } }`;
  const issues: Array<{ number: number; title: string; state: string; labels: string[]; status: string | null }> = [];
  for (let after: string | null = null; ; ) {
    const r = (await gh.graphql(query, { q: searchQuery(repo, f), after })) as { viewer?: { login: string }; search: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ number?: number; title: string; state: string; labels: { nodes: Array<{ name: string }> }; projectItems?: ProjectItems }> } };
    for (const n of r.search.nodes) {
      if (typeof n.number !== "number") continue;
      const status = fieldsOf(n.projectItems, project, r.viewer?.login)?.Status;
      issues.push({ number: n.number, title: n.title, state: n.state, labels: n.labels.nodes.map((l) => l.name), status: typeof status === "string" ? status : null });
    }
    if (!r.search.pageInfo.hasNextPage) break;
    after = r.search.pageInfo.endCursor;
  }
  return issues;
}

const COMMENTS = "comments(first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id body createdAt } }";
type Comments = { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string; body: string; createdAt: string }> };

/** One Issue of `repo` as `backlog view` shows the app's stored one; `sync.state` "github" = read from GitHub just now. */
export async function viewFromGithub(gh: GhClient, repo: Repo, project: Project, num: number, now = Date.now()): Promise<Detail> {
  const query = `query($o:String!,$n:String!,$num:Int!,$after:String){ ${viewerOf(project)}repository(owner:$o,name:$n){ issue(number:$num){ number title state body url labels(first:50){ nodes{ name } } milestone{ title } parent{ number } ${COMMENTS} ${project ? PROJECT_ITEMS : ""} } } }`;
  const r = (await gh.graphql(query, { o: repo.owner, n: repo.name, num, after: null })) as { viewer?: { login: string }; repository: { issue: { number: number; title: string; state: string; body: string; url: string; labels: { nodes: Array<{ name: string }> }; milestone: { title: string } | null; parent: { number: number } | null; comments: Comments; projectItems?: ProjectItems } | null } };
  const i = r.repository.issue;
  if (!i) throw new Error(`#${num} は ${repo.owner}/${repo.name} にありません`);
  // every comment, as the app stores them: the latest answer may be past the first page
  const comments = [...i.comments.nodes];
  for (let page = i.comments.pageInfo; page.hasNextPage; ) {
    const more = (await gh.graphql(`query($o:String!,$n:String!,$num:Int!,$after:String){ repository(owner:$o,name:$n){ issue(number:$num){ ${COMMENTS} } } }`, { o: repo.owner, n: repo.name, num, after: page.endCursor })) as { repository: { issue: { comments: Comments } } };
    comments.push(...more.repository.issue.comments.nodes);
    page = more.repository.issue.comments.pageInfo;
  }
  return {
    issue: { number: i.number, title: i.title, state: i.state, labels: i.labels.nodes.map((l) => l.name), milestone: i.milestone?.title ?? null, parent: i.parent?.number ?? null, body: i.body, url: i.url },
    comments,
    fields: fieldsOf(i.projectItems, project, r.viewer?.login),
    fetchedAt: now,
    localId: null,
    pending: 0,
    sync: { state: "github", reason: null, lastSuccessfulSync: now },
  };
}

/** `gh <args> --body-file <a file holding body>`: gh.run takes no standard input. */
async function withBody<T>(body: string | undefined, run: (file: string | null) => Promise<T>): Promise<T> {
  if (body === undefined) return run(null);
  const dir = mkdtempSync(join(tmpdir(), "ops-kit.backlog-body."));
  try {
    writeFileSync(join(dir, "body.md"), body);
    return await run(join(dir, "body.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const slug = (repo: Repo) => `${repo.owner}/${repo.name}`;

/** Makes `parent` the parent of `child` (null: removes the one it has). */
async function setParent(gh: GhClient, repo: Repo, child: number, parent: number | null): Promise<void> {
  const q = `query($o:String!,$n:String!,$c:Int!${parent === null ? "" : ",$p:Int!"}){ repository(owner:$o,name:$n){ child: issue(number:$c){ id parent{ id } }${parent === null ? "" : " parent: issue(number:$p){ id }"} } }`;
  const r = (await gh.graphql(q, { o: repo.owner, n: repo.name, c: child, ...(parent === null ? {} : { p: parent }) })) as { repository: { child: { id: string; parent: { id: string } | null } | null; parent?: { id: string } | null } };
  const c = r.repository.child;
  if (!c) throw new Error(`#${child} は ${slug(repo)} にありません`);
  if (parent === null) {
    if (c.parent) await gh.graphql("mutation($p:ID!,$c:ID!){ removeSubIssue(input:{issueId:$p, subIssueId:$c}){ issue{ number } } }", { p: c.parent.id, c: c.id });
    return;
  }
  const p = r.repository.parent;
  if (!p) throw new Error(`親の #${parent} は ${slug(repo)} にありません`);
  await gh.graphql("mutation($p:ID!,$c:ID!,$r:Boolean){ addSubIssue(input:{issueId:$p, subIssueId:$c, replaceParent:$r}){ issue{ number } } }", { p: p.id, c: c.id, r: true });
}

export interface CreateInput {
  title: string;
  body: string | undefined;
  labels: string[];
  milestone: string | undefined;
  parent: number | null;
  fields: Record<string, string>;
}

/** `backlog create` on GitHub: the Issue, then its parent and Project fields. Resolves to its number. */
export async function createOnGithub(gh: GhClient, cfg: (() => Promise<OpsConfig>) | null, repo: Repo, input: CreateInput, log: (s: string) => void): Promise<number> {
  const url = await withBody(input.body ?? "", (file) => gh.run(["issue", "create", "-R", slug(repo), "--title", input.title, "--body-file", file!, ...input.labels.flatMap((l) => ["--label", l]), ...(input.milestone ? ["--milestone", input.milestone] : [])]));
  const m = /\/issues\/(\d+)\s*$/.exec(url.trim());
  if (!m) throw new Error(`gh issue create の答えから番号が読めません: ${url.trim().slice(0, 200)}`);
  const num = Number(m[1]);
  if (input.parent !== null) await setParent(gh, repo, num, input.parent);
  if (Object.keys(input.fields).length) {
    const c = await cfg!();
    for (const [name, value] of Object.entries(input.fields)) await setField(gh, c, num, name, value, log);
  }
  return num;
}

export interface EditInput {
  title?: string;
  body?: string;
  add: string[];
  remove: string[];
  state?: "OPEN" | "CLOSED";
  /** null: remove it. */
  milestone?: string | null;
  /** null: remove it. */
  parent?: number | null;
}

/** `backlog edit` on GitHub: one `gh issue edit` for the text, labels and milestone; close / reopen; the parent. */
export async function editOnGithub(gh: GhClient, repo: Repo, num: number, input: EditInput): Promise<void> {
  const edits = [...(input.title !== undefined ? ["--title", input.title] : []), ...input.add.flatMap((l) => ["--add-label", l]), ...input.remove.flatMap((l) => ["--remove-label", l]), ...(input.milestone === null ? ["--remove-milestone"] : input.milestone !== undefined ? ["--milestone", input.milestone] : [])];
  if (edits.length || input.body !== undefined) await withBody(input.body, (file) => gh.run(["issue", "edit", String(num), "-R", slug(repo), ...edits, ...(file ? ["--body-file", file] : [])]));
  if (input.state) await gh.run(["issue", input.state === "CLOSED" ? "close" : "reopen", String(num), "-R", slug(repo)]);
  if (input.parent !== undefined) await setParent(gh, repo, num, input.parent);
}

/** `backlog comment` on GitHub. */
export async function commentOnGithub(gh: GhClient, repo: Repo, num: number, body: string): Promise<void> {
  await withBody(body, (file) => gh.run(["issue", "comment", String(num), "-R", slug(repo), "--body-file", file!]));
}
