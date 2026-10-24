/**
 * Sends the backlog edits kept here (#886, db.ts `backlog_operations`) to GitHub, oldest first. The operations of one
 * Issue go one after the other: one not done (held, failed, waiting for its time) holds the ones after it, so an answer's
 * label comes off only after the answer is posted. No database transaction is open while GitHub is asked.
 *
 * - A `set` is checked before and after (the 初期方式 A of #887): the field's value on GitHub is read; already the value
 *   → done; no longer the `base` it was made on → `conflict`, held and nothing written. Only that field is written, and
 *   read again: another value then → `conflict` (someone wrote between the read and the write; what they wrote may
 *   have been overwritten — #899 looks for a way to prevent it).
 * - A `create` / `comment` carries an invisible marker with the operation's id (not a secret: it signs nothing in).
 *   Its answer lost (an outage after the request went out, a restart while `sending`) → `unknown`: before anything is
 *   posted again, every Issue / comment written since the operation was made is read for the marker. Found → done with
 *   its id; not found, or not all read → still `unknown`, never posted again by itself.
 * - A limit (429, a secondary limit) stops the run until GitHub's time (`Limit`), and so does GitHub not reached at all
 *   (no connection: nothing left, so a post waits as it is, not unknown) and the login refused (401: asked again by the
 *   next send, nothing failed for it); a permission refused on one thing (403) or a refused input (4xx) → `failed`,
 *   not sent again by itself; an outage → a `set` waits and is tried again, at most MAX_ATTEMPTS times.
 * - A create's Project item, parent and state are sent after the Issue with the same operation: each step is the same
 *   when sent twice, and the Issue's id is kept (`remoteId`) as soon as GitHub gives it.
 */
import type { BacklogIssueData, BacklogSource } from "@switchboard/protocol";
import type { BacklogOperation, BacklogOperationStatus, BacklogOverwritten, Db } from "./db.ts";
import type { BacklogCreatePayload, GhRunner } from "./backlog.ts";
import { backlogFieldValue, sameBacklogValue } from "./backlog-merge.ts";
import { parseIncluded, responseOf, retryAtFromResponse, type GithubResponse } from "../../../ops-kit/src/gh.ts";
import { fieldValue, type Field } from "../../../ops-kit/src/set.ts";
import { checkForgeOperation, ForgeRefused, ForgeUnsupported, textsOf, type ForgeImpl, type ForgeKind, type ForgeOperation } from "../../../ops-kit/src/forge.ts";

/** Tries of an operation whose request failed with an outage before it is `failed`. */
const MAX_ATTEMPTS = 5;
const marker = (id: string) => `<!-- switchboard-op:${id} -->`;
const marked = (body: string, id: string) => `${body}\n\n${marker(id)}`;

/**
 * The run stops and the operation waits as it was (not a try): `limit` = GitHub said to wait until `until` (its answer
 * in `response`, for the host's wait); `offline` = GitHub was not reached (the repository waits a minute); `auth` = the
 * login was refused (401) — asked again by the next send, not by a time. A permission refused on one thing is not this:
 * that operation is failed.
 */
export class Limit extends Error {
  constructor(readonly until: number, readonly kind: "limit" | "offline" | "auth" = "limit", readonly response?: GithubResponse) {
    super(kind === "auth" ? "GitHub のログインが通らないため送りません（次の送信で確かめ直します）" : `GitHub の利用制限か接続できないため ${new Date(until).toISOString()} まで送りません`);
  }
}

/**
 * gh got no answer because it could not connect: the request never left, whatever it was. Read from gh's own wording;
 * a wording not matched makes a post `unknown` (looked for, never posted twice), not lost.
 */
const unreached = (r: GithubResponse) => r.status === undefined && /error connecting|could not resolve|connection refused|no such host|network is unreachable|gh を起動できません/i.test(r.message ?? "");

class CallError extends Error {
  constructor(message: string, readonly response: GithubResponse) {
    super(message);
  }
}

type Outcome = { status: BacklogOperationStatus; error?: string | null; retryAt?: number | null; remoteId?: string | null; overwritten?: BacklogOverwritten | null; record?: { externalId: string; remote: unknown } };

/** A call's answer with the time GitHub answered it (its `date` header; null when the answer carried none). */
async function callWith(gh: GhRunner, cwd: string, args: string[]): Promise<{ data: any; date: string | null }> {
  const r = await gh(["api", ...args.slice(0, 1), "--include", ...args.slice(1)], cwd);
  const { body, headers } = parseIncluded(r.stdout);
  if (r.code !== 0) throw new CallError(`gh api ${args[0]}: ${(r.stderr.trim() || `exit ${r.code}`).slice(0, 200)}`, responseOf(r.stdout, r.stderr));
  const data = body.trim() ? JSON.parse(body) : null;
  // GitHub answered (200) and refused the request in its errors: an input / not found, or a limit (RATE_LIMITED) —
  // not an outage
  if (args[0] === "graphql" && (!data?.data || data.errors?.length)) throw new CallError(`gh api graphql: ${String(data?.errors?.[0]?.message ?? "no data").slice(0, 200)}`, { status: 200, errors: data?.errors, message: String(data?.errors?.[0]?.message ?? "") });
  return { data: args[0] === "graphql" ? data.data : data, date: headers.date ?? null };
}
const call = async (gh: GhRunner, cwd: string, args: string[]): Promise<any> => (await callWith(gh, cwd, args)).data;

const vars = (v: Record<string, string | number>) => Object.entries(v).flatMap(([k, x]) => (typeof x === "number" ? ["-F", `${k}=${x}`] : ["-f", `${k}=${x}`]));
const graphqlWith = (gh: GhRunner, cwd: string, query: string, v: Record<string, string | number> = {}) => callWith(gh, cwd, ["graphql", "-f", `query=${query}`, ...vars(v)]);
const graphql = async (gh: GhRunner, cwd: string, query: string, v: Record<string, string | number> = {}) => (await graphqlWith(gh, cwd, query, v)).data;

const ISSUE_Q = "query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){ id title body state milestone{ title } parent{ id number } labels(first:100){ nodes{ name } } } } }";
const PROJECT_Q = "query($o:String!,$p:Int!){ repositoryOwner(login:$o){ ... on ProjectV2Owner{ projectV2(number:$p){ id fields(first:50){ nodes{ ... on ProjectV2FieldCommon{ id name dataType } ... on ProjectV2SingleSelectField{ options{ id name } } } } } } } }";
const ITEM_Q = "query($i:ID!,$f:String!){ node(id:$i){ ... on ProjectV2Item{ fieldValueByName(name:$f){ ... on ProjectV2ItemFieldSingleSelectValue{ name } ... on ProjectV2ItemFieldNumberValue{ number } ... on ProjectV2ItemFieldTextValue{ text } ... on ProjectV2ItemFieldDateValue{ date } } } } }";
/**
 * The read after a write (#1329): the field's value now, and what the edit history holds since the check read — the
 * timeline events of the fields a `set` can write and, for the body, the content edits — with the login the reads are
 * made under, so another login's edit the write replaced can be told from one's own. One call, as the read after the
 * write was before.
 */
const HISTORY_F = "timelineItems(since:$s, first:100, itemTypes:[RENAMED_TITLE_EVENT, CLOSED_EVENT, REOPENED_EVENT, LABELED_EVENT, UNLABELED_EVENT, MILESTONED_EVENT, DEMILESTONED_EVENT, PARENT_ISSUE_ADDED_EVENT, PARENT_ISSUE_REMOVED_EVENT, PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]){ pageInfo{ hasNextPage } nodes{ __typename ... on RenamedTitleEvent{ actor{ login } createdAt currentTitle } ... on ClosedEvent{ actor{ login } createdAt } ... on ReopenedEvent{ actor{ login } createdAt } ... on LabeledEvent{ actor{ login } createdAt label{ name } } ... on UnlabeledEvent{ actor{ login } createdAt label{ name } } ... on MilestonedEvent{ actor{ login } createdAt milestoneTitle } ... on DemilestonedEvent{ actor{ login } createdAt } ... on ParentIssueAddedEvent{ actor{ login } createdAt parent{ number } } ... on ParentIssueRemovedEvent{ actor{ login } createdAt } ... on ProjectV2ItemStatusChangedEvent{ actor{ login } createdAt status project{ id } } } }";
const EDITS_F = "userContentEdits(first:50){ pageInfo{ hasNextPage } nodes{ editedAt editor{ login } diff deletedAt } }";
const AFTER_ISSUE_Q = `query($o:String!,$r:String!,$n:Int!,$s:DateTime!){ viewer{ login } repository(owner:$o,name:$r){ issue(number:$n){ id title body state milestone{ title } parent{ id number } labels(first:100){ nodes{ name } } ${HISTORY_F} } } }`;
const AFTER_BODY_Q = AFTER_ISSUE_Q.replace(`${HISTORY_F} }`, `${HISTORY_F} ${EDITS_F} }`);
const AFTER_ITEM_Q = `query($o:String!,$r:String!,$n:Int!,$s:DateTime!,$i:ID!,$f:String!){ viewer{ login } node(id:$i){ ... on ProjectV2Item{ fieldValueByName(name:$f){ ... on ProjectV2ItemFieldSingleSelectValue{ name } ... on ProjectV2ItemFieldNumberValue{ number } ... on ProjectV2ItemFieldTextValue{ text } ... on ProjectV2ItemFieldDateValue{ date } } } } repository(owner:$o,name:$r){ issue(number:$n){ ${HISTORY_F} } } }`;

type HistoryEvent = { __typename: string; actor: { login: string } | null; createdAt: string; currentTitle?: string; label?: { name: string }; milestoneTitle?: string; parent?: { number: number } | null; status?: string; project?: { id: string } };
type ContentEdit = { editedAt: string; editor: { login: string } | null; diff: string | null; deletedAt: string | null };
export interface AfterAnswer { events: HistoryEvent[]; edits: ContentEdit[]; viewer: string }

/**
 * Another login's edit of the field since the check read, as the history tells it (#1329): the latest one, as the
 * value the field would read (a body's `diff` is the version's text; one deleted from the history has no value). Null
 * when there is none, or it made the field the value sent (nothing was lost).
 */
export function theirEdit(field: string, after: AfterAnswer, since: string, project: string, sent: unknown): BacklogOverwritten | null {
  const theirs = (login: { login: string } | null | undefined, at: string) => at >= since && (login?.login ?? "") !== after.viewer;
  const label = field.startsWith("label:") ? field.slice("label:".length).toLowerCase() : null;
  const found: Array<BacklogOverwritten & { at: string }> = [];
  for (const e of after.events) {
    if (!theirs(e.actor, e.createdAt)) continue;
    const hit = (value: unknown) => found.push({ value, editor: e.actor?.login ?? null, at: e.createdAt });
    if (field === "title" && e.__typename === "RenamedTitleEvent") hit(e.currentTitle);
    else if (field === "state" && e.__typename === "ClosedEvent") hit("CLOSED");
    else if (field === "state" && e.__typename === "ReopenedEvent") hit("OPEN");
    else if (label && e.__typename === "LabeledEvent" && e.label?.name.toLowerCase() === label) hit(true);
    else if (label && e.__typename === "UnlabeledEvent" && e.label?.name.toLowerCase() === label) hit(false);
    else if (field === "milestone" && e.__typename === "MilestonedEvent") hit(e.milestoneTitle ?? null);
    else if (field === "milestone" && e.__typename === "DemilestonedEvent") hit(null);
    else if (field === "parent" && e.__typename === "ParentIssueAddedEvent") hit(e.parent?.number ?? null);
    else if (field === "parent" && e.__typename === "ParentIssueRemovedEvent") hit(null);
    else if (field === "field:Status" && e.__typename === "ProjectV2ItemStatusChangedEvent" && e.project?.id === project) hit(e.status ?? null);
  }
  // GitHub lists the content edits newest first; walked oldest first, so that the stable sort below keeps the newest
  // of two edits in the same second last
  if (field === "body")
    for (const e of [...after.edits].reverse()) {
      if (!theirs(e.editor, e.editedAt)) continue;
      found.push(e.deletedAt || e.diff === null ? { editor: e.editor?.login ?? null, at: e.editedAt } : { value: e.diff, editor: e.editor?.login ?? null, at: e.editedAt });
    }
  const last = found.sort((a, b) => a.at.localeCompare(b.at)).at(-1);
  if (!last) return null;
  return "value" in last && sameBacklogValue(field, last.value, sent) ? null : last;
}

/** What one run sends with: the repository, the Issue numbers of the records, the Project (read once). */
class Sender {
  private project: { id: string; fields: Array<Field & { name: string }> } | null = null;
  /** Called after each write GitHub took (a post, a field): what was written is read back by an import. */
  onWrite: () => void = () => undefined;
  /** A limit (or GitHub not reached) met by the read after a write: thrown once the operation's outcome is stored (#1329). */
  stopAfter: Limit | null = null;
  constructor(private gh: GhRunner, private db: Db, private cwd: string, private source: BacklogSource, private now: () => number) {}
  private get o() { return this.source.repository.split("/")[0]!; }
  private get r() { return this.source.repository.split("/")[1]!; }
  private repo = (path: string) => `repos/${this.source.repository}${path}`;

  private numberOf(issue: string): number {
    const rec = this.db.getBacklogRecord({ ...this.source, objectKind: "issue", externalId: issue });
    return ((rec?.local ?? rec?.remote) as BacklogIssueData | null)?.number ?? 0;
  }

  private async issue(n: number) {
    const i = (await graphql(this.gh, this.cwd, ISSUE_Q, { o: this.o, r: this.r, n })).repository?.issue;
    if (!i) throw new CallError(`#${n} が GitHub にありません`, { status: 404 });
    return i as { id: string; title: string; body: string; state: string; milestone: { title: string } | null; parent: { id: string; number: number } | null; labels: { nodes: Array<{ name: string }> } };
  }

  private async projectOf() {
    if (this.project) return this.project;
    const p = (await graphql(this.gh, this.cwd, PROJECT_Q, { o: this.source.project.owner, p: this.source.project.number })).repositoryOwner?.projectV2;
    if (!p?.id) throw new CallError(`Project ${this.source.project.owner}/${this.source.project.number} が見つかりません`, { status: 404 });
    return (this.project = { id: p.id, fields: (p.fields.nodes as Array<Field & { name: string }>).filter((f) => f.id) });
  }

  private async milestone(title: string | null): Promise<number | null> {
    if (title === null) return null;
    const all = (await call(this.gh, this.cwd, [this.repo("/milestones?state=all&per_page=100")])) as Array<{ number: number; title: string }>;
    const m = all.find((x) => x.title === title);
    if (!m) throw new CallError(`Milestone「${title}」がありません`, { status: 422 });
    return m.number;
  }

  private async setParent(child: { id: string; parent: { id: string; number: number } | null }, parent: number | null) {
    if (child.parent && child.parent.number !== parent) await graphql(this.gh, this.cwd, "mutation($p:ID!,$c:ID!){ removeSubIssue(input:{ issueId:$p, subIssueId:$c }){ issue{ id } } }", { p: child.parent.id, c: child.id });
    if (parent !== null && child.parent?.number !== parent) await graphql(this.gh, this.cwd, "mutation($p:ID!,$c:ID!){ addSubIssue(input:{ issueId:$p, subIssueId:$c }){ issue{ id } } }", { p: (await this.issue(parent)).id, c: child.id });
  }

  private async setField(item: string, name: string, value: unknown) {
    const p = await this.projectOf();
    const field = p.fields.find((f) => f.name === name);
    if (!field) throw new CallError(`フィールド「${name}」が Project にありません`, { status: 422 });
    if (value === null) return graphql(this.gh, this.cwd, "mutation($p:ID!,$i:ID!,$f:ID!){ clearProjectV2ItemFieldValue(input:{ projectId:$p, itemId:$i, fieldId:$f }){ projectV2Item{ id } } }", { p: p.id, i: item, f: field.id });
    const v = fieldValue(name, field, String(value));
    await graphql(this.gh, this.cwd, `mutation($p:ID!,$i:ID!,$f:ID!,$value:${v.type}){ updateProjectV2ItemFieldValue(input:{ projectId:$p, itemId:$i, fieldId:$f, value:${v.input} }){ projectV2Item{ id } } }`, { p: p.id, i: item, f: field.id, value: v.value });
  }

  /**
   * The Issue's item in the Project, added when it is not there. One already there (the Project's own auto-add, or an
   * add whose answer was lost) is refused by GitHub with "Content already exists in this project": that item is it.
   */
  private async addToProject(contentId: string): Promise<string> {
    const p = await this.projectOf();
    try {
      return (await graphql(this.gh, this.cwd, "mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{ projectId:$p, contentId:$c }){ item{ id } } }", { p: p.id, c: contentId })).addProjectV2ItemById.item.id;
    } catch (e) {
      if (!(e instanceof CallError && /already exists in this project/i.test(`${e.message} ${e.response.errors?.map((x) => x.message).join(" ") ?? ""}`))) throw e;
      const items = (await graphql(this.gh, this.cwd, "query($c:ID!){ node(id:$c){ ... on Issue{ projectItems(first:100){ nodes{ id project{ id } } } } } }", { c: contentId })).node?.projectItems?.nodes ?? [];
      const item = items.find((i: { project: { id: string } }) => i.project.id === p.id);
      if (!item) throw e;
      return item.id;
    }
  }

  private static issueField(op: BacklogOperation, i: { title: string; body: string; state: string; milestone: { title: string } | null; parent: { id: string; number: number } | null; labels: { nodes: Array<{ name: string }> } }): unknown {
    return backlogFieldValue("issue", { title: i.title, body: i.body, state: i.state, milestone: i.milestone?.title ?? null, parent: i.parent?.number ?? null, labels: i.labels.nodes.map((l) => l.name) }, op.field!);
  }
  private static itemField(v: any): unknown {
    return v ? (v.name ?? v.number ?? v.text ?? v.date ?? null) : null;
  }

  /** A field's value on GitHub now, as the operation's `field` reads it, and when GitHub answered (its clock, for the history read after a write). */
  private async current(op: BacklogOperation, n: number): Promise<{ value: unknown; at: string }> {
    const since = (date: string | null) => new Date(date && !Number.isNaN(Date.parse(date)) ? Date.parse(date) : this.now() - 60_000).toISOString();
    if (op.targetKind === "project-item") {
      if (op.field === "member") return { value: !op.target.startsWith("local:"), at: since(null) };
      const r = await graphqlWith(this.gh, this.cwd, ITEM_Q, { i: op.target, f: op.field!.slice("field:".length) });
      return { value: Sender.itemField(r.data.node?.fieldValueByName), at: since(r.date) };
    }
    const r = await graphqlWith(this.gh, this.cwd, ISSUE_Q, { o: this.o, r: this.r, n });
    const i = r.data.repository?.issue;
    if (!i) throw new CallError(`#${n} が GitHub にありません`, { status: 404 });
    return { value: Sender.issueField(op, i), at: since(r.date) };
  }

  /** Whether the field's history is read after a write: an Issue's fields and a Project item's Status (the other Project fields have none). */
  private static withHistory(op: BacklogOperation): boolean {
    return op.targetKind === "issue" || op.field === "field:Status";
  }

  /** The read after a write: the value now and the history since the check (#1329). */
  private async after(op: BacklogOperation, n: number, since: string): Promise<{ value: unknown; answer: AfterAnswer; complete: boolean }> {
    const item = op.targetKind === "project-item";
    const d = await graphql(this.gh, this.cwd, item ? AFTER_ITEM_Q : op.field === "body" ? AFTER_BODY_Q : AFTER_ISSUE_Q, { o: this.o, r: this.r, n, s: since, ...(item ? { i: op.target, f: op.field!.slice("field:".length) } : {}) });
    const i = d.repository?.issue;
    if (!i) throw new CallError(`#${n} が GitHub にありません`, { status: 404 });
    const value = item ? Sender.itemField(d.node?.fieldValueByName) : Sender.issueField(op, i);
    const edits = op.field === "body" ? i.userContentEdits : null;
    // the content edits have no `since`: the newest page is whole for the window when it reaches back before the check
    // read (its oldest edit is older than `since`), however many edits the body had in its life
    const editNodes: ContentEdit[] = edits?.nodes ?? [];
    const editsWhole = !edits?.pageInfo?.hasNextPage || (editNodes.length > 0 && editNodes[editNodes.length - 1]!.editedAt < since);
    return {
      value,
      answer: { events: i.timelineItems?.nodes ?? [], edits: editNodes, viewer: d.viewer?.login ?? "" },
      complete: !i.timelineItems?.pageInfo?.hasNextPage && editsWhole,
    };
  }

  private async write(op: BacklogOperation, n: number): Promise<Outcome> {
    const out = await this.writeField(op, n);
    this.onWrite();
    return out;
  }

  private async writeField(op: BacklogOperation, n: number): Promise<Outcome> {
    const f = op.field!;
    const v = op.payload;
    if (op.targetKind === "project-item") {
      if (f === "member" && v) {
        const item = await this.addToProject((await this.issue(n)).id);
        return { status: "done", remoteId: item, record: { externalId: item, remote: { issue: n, owner: this.source.project.owner, project: this.source.project.number, fields: {} } } };
      }
      // an item GitHub has already taken out is out
      if (f === "member")
        await graphql(this.gh, this.cwd, "mutation($p:ID!,$i:ID!){ deleteProjectV2Item(input:{ projectId:$p, itemId:$i }){ deletedItemId } }", { p: (await this.projectOf()).id, i: op.target }).catch((e) => {
          if (!(e instanceof CallError && e.response.errors?.some((x) => x.type === "NOT_FOUND"))) throw e;
        });
      else await this.setField(op.target, f.slice("field:".length), v);
    } else if (f.startsWith("label:")) {
      const name = f.slice("label:".length);
      if (v) await call(this.gh, this.cwd, [this.repo(`/issues/${n}/labels`), "-X", "POST", "-f", `labels[]=${name}`]);
      else await call(this.gh, this.cwd, [this.repo(`/issues/${n}/labels/${encodeURIComponent(name)}`), "-X", "DELETE"]);
    } else if (f === "parent") await this.setParent(await this.issue(n), v as number | null);
    else if (f === "milestone") await call(this.gh, this.cwd, [this.repo(`/issues/${n}`), "-X", "PATCH", "-F", `milestone=${(await this.milestone(v as string | null)) ?? "null"}`]);
    else await call(this.gh, this.cwd, [this.repo(`/issues/${n}`), "-X", "PATCH", "-f", `${f}=${f === "state" ? String(v).toLowerCase() : v}`]);
    return { status: "done" };
  }

  /** A `set`: checked against its base, then that field only. Asks GitHub again after an unknown answer, as it does first. */
  private async set(op: BacklogOperation): Promise<Outcome> {
    const n = this.numberOf(op.issue);
    const { value: now, at: since } = await this.current(op, n);
    const same = (a: unknown, b: unknown) => sameBacklogValue(op.field!, a, b);
    if (same(now, op.payload)) return op.targetKind === "project-item" && op.field === "member" && op.payload ? this.write(op, n) : { status: "done" };
    if (!same(now, op.base)) return { status: "conflict", error: `GitHub の値が編集の元から変わっています（${op.field}: GitHub は ${JSON.stringify(now)}）` };
    const out = await this.write(op, n);
    if (op.field === "member") return out;
    // read again right after (方式 A): another value there now was written by someone between the read and the write
    if (!Sender.withHistory(op)) {
      const { value: after } = await this.current(op, n);
      // what GitHub had is kept with it (and the import after the run reads it in)
      return same(after, op.payload) ? out : { status: "conflict", error: `送った直後の GitHub の値が送った値と違います（${op.field}: GitHub は ${JSON.stringify(after)}）。ほかの編集と重なりました` };
    }
    // the same read carries the history since the check (#1329): an edit of another login in between was replaced by
    // this write — held with what it was, so nothing is lost without a word. The history not read whole, or not at
    // all, holds the write as unverified: never pending (a re-send's check would read this value back and call it done)
    let read: Awaited<ReturnType<Sender["after"]>>;
    try {
      read = await this.after(op, n, since);
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 200);
      // a limit, or GitHub not reached: the host's wait is kept as for any call (the run stops after this outcome is stored)
      if (e instanceof CallError) {
        const at = this.now();
        const c = retryAtFromResponse(e.response, at);
        if (unreached(e.response)) this.stopAfter = new Limit(at + 60_000, "offline");
        else if (c?.kind === "primary" || c?.kind === "secondary") this.stopAfter = new Limit(c.at ?? at + 60_000, "limit", e.response);
      }
      return { status: "conflict", overwritten: { editor: null, at: null, unreadable: why }, error: `書いた後に GitHub の編集履歴を読めませんでした（${why}）。ほかの編集を上書きしたか確かめられていません` };
    }
    if (!same(read.value, op.payload)) return { status: "conflict", error: `送った直後の GitHub の値が送った値と違います（${op.field}: GitHub は ${JSON.stringify(read.value)}）。ほかの編集と重なりました` };
    if (!read.complete) return { status: "conflict", overwritten: { editor: null, at: null, unreadable: "履歴が 1 ページに収まらず、読み切れませんでした" }, error: "書いた後に GitHub の編集履歴を読み切れませんでした。ほかの編集を上書きしたか確かめられていません" };
    const theirs = theirEdit(op.field!, read.answer, since, op.targetKind === "project-item" ? (await this.projectOf()).id : "", op.payload);
    if (!theirs) return out;
    const who = `${theirs.editor ?? "誰か"} が ${theirs.at ?? "書く直前"} に`;
    return {
      status: "conflict", overwritten: theirs,
      error: "value" in theirs
        ? `書く直前に ${who} ${op.field} を ${JSON.stringify(theirs.value)} にしていました（送った値で上書きしました）。どちらにするか選んでください`
        : `書く直前に ${who} ${op.field} を編集していましたが、その版の内容は履歴から消されています（送った値で上書きしました）`,
    };
  }

  /** Pages of a list since the operation was made, for its marker; null = not every page could be read. */
  private async findMarked(path: string, id: string, since: number): Promise<any | null> {
    for (let page = 1; page <= 10; page++) {
      const list = (await call(this.gh, this.cwd, [this.repo(`${path}${path.includes("?") ? "&" : "?"}since=${new Date(since - 60_000).toISOString()}&per_page=100&page=${page}`)])) as Array<{ body?: string | null }>;
      const hit = list.find((x) => x.body?.includes(marker(id)));
      if (hit || list.length < 100) return hit ?? undefined;
    }
    return null;
  }

  private async comment(op: BacklogOperation, posting: { on: boolean }): Promise<Outcome> {
    const n = this.numberOf(op.issue);
    const body = (op.payload as { body: string }).body;
    let c = op.status === "unknown" ? await this.findMarked(`/issues/${n}/comments`, op.id, op.createdAt) : undefined;
    if (op.status === "unknown" && !c) return { status: "unknown", error: c === null ? "送ったかどうかを確かめきれません" : "GitHub にこのコメントが見つかりません。送ったかどうか分からないので、もう一度は送りません" };
    if (!c) {
      posting.on = true;
      c = await call(this.gh, this.cwd, [this.repo(`/issues/${n}/comments`), "-X", "POST", "-f", `body=${marked(body, op.id)}`]);
      this.onWrite();
      if (typeof c?.node_id !== "string") throw new Error("GitHub の答えにコメントの id がありません");
    }
    return { status: "done", remoteId: c.node_id, record: { externalId: c.node_id, remote: { issue: n, body: c.body, createdAt: c.created_at } } };
  }

  private async create(op: BacklogOperation, posting: { on: boolean }): Promise<Outcome> {
    const p = op.payload as BacklogCreatePayload;
    let made: any = op.remoteId ? (await graphql(this.gh, this.cwd, "query($i:ID!){ node(id:$i){ ... on Issue{ node_id: id number html_url: url title body state created_at: createdAt updated_at: updatedAt } } }", { i: op.remoteId })).node : undefined;
    if (!made && op.status === "unknown") {
      made = await this.findMarked("/issues?state=all&sort=created&direction=desc", op.id, op.createdAt);
      if (!made) return { status: "unknown", error: made === null ? "作ったかどうかを確かめきれません" : "GitHub にこの Issue が見つかりません。作ったかどうか分からないので、もう一度は作りません" };
    }
    if (!made) {
      const milestone = await this.milestone(p.milestone);
      posting.on = true;
      made = await call(this.gh, this.cwd, [this.repo("/issues"), "-X", "POST", "-f", `title=${p.title}`, "-f", `body=${marked(p.body, op.id)}`, ...p.labels.flatMap((l) => ["-f", `labels[]=${l}`]), ...(milestone === null ? [] : ["-F", `milestone=${milestone}`])]);
      this.onWrite();
      if (typeof made?.node_id !== "string" || typeof made?.number !== "number") throw new Error("GitHub の答えに Issue の id がありません");
      posting.on = false;
    }
    const n = made.number as number;
    const remote: BacklogIssueData = {
      number: n, title: made.title, url: made.html_url, state: p.state, stateReason: p.state === "CLOSED" ? "COMPLETED" : null, body: made.body ?? "", labels: p.labels, milestone: p.milestone, parent: p.parent, subIssues: [],
      createdAt: made.created_at, updatedAt: made.updated_at, closedAt: made.closed_at ?? null,
    };
    // the Issue exists: kept at once with its id (what the create itself made: open, no parent), so a failure in the
    // steps after it neither makes it again nor leaves the record apart from it
    this.db.setBacklogOperationResult(op.id, { status: "sending", remoteId: made.node_id, record: { externalId: made.node_id, remote: { ...remote, state: "OPEN", stateReason: null, parent: null } } }, this.now());
    if (p.state === "CLOSED") await call(this.gh, this.cwd, [this.repo(`/issues/${n}`), "-X", "PATCH", "-f", "state=closed"]);
    if (p.parent !== null) await this.setParent(await this.issue(n), p.parent);
    if (p.project) {
      const item = await this.addToProject(made.node_id);
      for (const [name, v] of Object.entries(p.project.fields)) await this.setField(item, name, v);
    }
    return { status: "done", remoteId: made.node_id, record: { externalId: made.node_id, remote } };
  }

  /** Sends one operation and says how it went; throws Limit. */
  async send(op: BacklogOperation): Promise<Outcome> {
    const posting = { on: false };
    try {
      return op.kind === "set" ? await this.set(op) : op.kind === "comment" ? await this.comment(op, posting) : await this.create(op, posting);
    } catch (e) {
      const at = this.now();
      const message = String((e as Error)?.message ?? e).slice(0, 300);
      // whether GitHub carried out a post is not known (its answer lost or unreadable, or the look for it failed):
      // looked for again, never posted again blindly
      const unsure = posting.on || (op.kind !== "set" && op.status === "unknown" && !op.remoteId);
      if (!(e instanceof CallError)) return { status: unsure ? "unknown" : "failed", error: message };
      if (unreached(e.response)) throw new Limit(at + 60_000, "offline");
      const c = retryAtFromResponse(e.response, at);
      // GitHub refused it: nothing was done, and nothing more is asked until its time
      if (c?.kind === "primary" || c?.kind === "secondary") throw new Limit(c.at ?? at + 60_000, "limit", e.response);
      // the login refused: nothing was done; the next send asks again (a token renewed), nothing is failed for it. A
      // permission refused on one thing (a locked Issue, a Project the token cannot write) is that operation's: failed
      if (c?.kind === "auth" && (e.response.status === 401 || /bad credentials|gh auth login|authentication/i.test(`${e.response.message ?? ""} ${e.message}`))) throw new Limit(at, "auth", e.response);
      // a write GitHub refused for the state it is in (409 / 412): checked again, held — never failed, nothing was lost (#1329)
      if (op.kind === "set" && (e.response.status === 409 || e.response.status === 412)) {
        const { value } = await this.current(op, this.numberOf(op.issue)).catch(() => ({ value: undefined, at: "" }));
        return { status: "conflict", error: `GitHub が書き込みを拒みました（${e.response.status}）。GitHub は ${value === undefined ? "読めませんでした" : JSON.stringify(value)}。照合し直してください` };
      }
      // GitHub answered and refused the input (4xx): nothing was made, a post included
      const refused = c?.kind === "auth" || (c === null && e.response.status !== undefined && e.response.status < 500);
      if (refused && (posting.on || !unsure)) return { status: "failed", error: e.message };
      if (unsure) return { status: "unknown", error: e.message };
      if (op.attempt + 1 >= MAX_ATTEMPTS) return { status: "failed", error: `${MAX_ATTEMPTS} 回送れませんでした: ${e.message}` };
      return { status: "pending", retryAt: at + 60_000 * 2 ** op.attempt, error: e.message };
    }
  }
}

/** The forge operation a stored one is (#920): a Project item and its fields are `project`, any other field `write`. */
export const forgeKind = (op: Pick<BacklogOperation, "kind" | "field" | "targetKind">): ForgeKind =>
  op.kind === "create" ? "create" : op.kind === "comment" ? "comment" : op.targetKind === "project-item" || op.field === "member" || op.field?.startsWith("field:") ? "project" : "write";

/**
 * Sends what is waiting for one repository (`source`, gh run in `cwd`), oldest first; resolves to how many were done.
 * Throws Limit when GitHub said to wait (the rest waits too).
 */
export async function sendGithubOperations(gh: GhRunner, db: Db, cwd: string, source: BacklogSource, now = () => Date.now(), onWrite?: () => void): Promise<number> {
  const sender = new Sender(gh, db, cwd, source, now);
  if (onWrite) sender.onWrite = onWrite;
  const send = (o: ForgeOperation<BacklogOperation>) => sender.send(o.payload);
  // the services an operation can be sent to: a second service adds its entry here (docs/design/forge-integration.md)
  const services: Record<string, ForgeImpl<BacklogOperation, Outcome>> = { github: { write: send, create: send, comment: send, project: send } };
  const held = new Set<string>();
  let done = 0;
  for (const listed of db.listPendingBacklogOperations(source)) {
    // the operation as it is now: one done before it may have given its Issue an id
    let op = db.getBacklogOperation(listed.id)!;
    // done meanwhile: an import found GitHub at its value, or the user kept GitHub's value on its conflict (#887)
    if (op.status === "done") continue;
    // left `sending` by a run that broke off after its request (its result could not be stored): never sent blindly
    if (op.status === "sending") {
      db.setBacklogOperationResult(op.id, { status: op.kind === "set" || op.remoteId ? "pending" : "unknown" }, now());
      op = db.getBacklogOperation(op.id)!;
    }
    if (held.has(op.issue) || op.status === "conflict" || op.status === "failed" || (op.retryAt ?? 0) > now()) {
      held.add(op.issue);
      continue;
    }
    if (op.kind !== "create" && op.issue.startsWith("local:")) {
      held.add(op.issue);
      continue;
    }
    // a field of a Project item never made (taken out before its add was sent): nothing to set
    if (op.targetKind === "project-item" && op.target.startsWith("local:") && op.field !== "member") {
      db.setBacklogOperationResult(op.id, { status: "done", error: "Project から外したので送りません" }, now());
      continue;
    }
    // through the forge operation of the repository's service (#920): one it does not support, or a value that signs
    // in, is held as failed with why — never sent
    const forged: ForgeOperation<BacklogOperation> = { kind: forgeKind(op), target: { service: source.service, host: source.host, repository: source.repository }, texts: textsOf(op.payload), payload: op };
    let run: (op: ForgeOperation<BacklogOperation>) => Promise<Outcome>;
    try {
      run = checkForgeOperation(forged, services);
    } catch (e) {
      if (!(e instanceof ForgeUnsupported || e instanceof ForgeRefused)) throw e;
      db.setBacklogOperationResult(op.id, { status: "failed", error: e.message }, now());
      held.add(op.issue);
      continue;
    }
    if (op.status === "pending") db.setBacklogOperationResult(op.id, { status: "sending", attempt: op.attempt + 1 }, now());
    let out: Outcome;
    try {
      out = await run(forged);
    } catch (e) {
      // refused or never sent: not a try
      if (e instanceof Limit) db.setBacklogOperationResult(op.id, { status: op.status === "unknown" && op.kind !== "set" ? "unknown" : "pending", attempt: op.attempt, retryAt: e.kind === "limit" ? e.until : null, error: e.message }, now());
      throw e;
    }
    db.setBacklogOperationResult(op.id, { retryAt: null, error: null, ...out }, now());
    // the read after a write met a limit: its outcome is kept, the rest waits as after any limit
    if (sender.stopAfter) throw sender.stopAfter;
    if (out.status === "done") done++;
    // under the id it had and the one it has now (a create gives its Issue GitHub's id before its steps)
    else held.add(op.issue).add(db.getBacklogOperation(op.id)!.issue);
  }
  return done;
}
