/**
 * A backlog kept in Switchboard only (#2265): its edits are not sent anywhere — each operation an edit queued (#886)
 * is applied to the stored records at once, as if the service had answered it. The edit functions in backlog.ts are the
 * same for every workspace; only where their operations go differs (BacklogSync.send).
 */
import type { BacklogCommentData, BacklogIssueData, BacklogObjectKind, BacklogProjectItemData, BacklogPullRequestData, BacklogSource } from "@switchboard/protocol";
import { applyBacklogField, type BacklogOperation, type BacklogSnapshotEntry, type Db } from "./db.ts";
import { BacklogEditError, type BacklogCreatePayload } from "./backlog.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, defaultConfig, loadConfig, type OpsConfig } from "../../../ops-kit/src/config.ts";
import { STATUS_OPTIONS } from "../../../ops-kit/src/bootstrap.ts";

/**
 * Applies the workspace's queued operations, oldest first, in one transaction (a failure applies none): a `create` gets
 * the next number of the workspace (its highest + 1) and the record id `sb:<id>` (`local:` stays the mark of one not
 * made yet), with its Project item and its place in the parent's sub-issues; a `set` is written on the record (a parent
 * change moves it between the parents' sub-issues); a `comment` gets `sb:<seq, 12 digits>` — the order the parallel
 * guard decides who came first by. The Issue's `updatedAt` is now. The workspace then reads as synced now. Returns how
 * many were applied; what waits (appliesHere) stays as it is.
 */
export function applyLocalOperations(db: Db, source: BacklogSource, now = Date.now()): number {
  const at = new Date(now).toISOString();
  return db.sqlite.transaction(() => {
    const ops = db.listPendingBacklogOperations(source);
    const record = (kind: BacklogObjectKind, externalId: string) => db.getBacklogRecord({ ...source, objectKind: kind, externalId });
    const valueOf = <T>(kind: BacklogObjectKind, externalId: string) => {
      const r = record(kind, externalId);
      return (r?.remote ?? r?.local ?? null) as T | null;
    };
    // a record no operation targets (a parent, a Project item a create makes) is written as an import would
    const store = (kind: BacklogObjectKind, externalId: string, remote: unknown) =>
      db.putBacklogSnapshot(source, { records: [{ objectKind: kind, externalId, remote, fetchState: "fetched" } as BacklogSnapshotEntry], cursor: null, syncedAt: now });
    const issues = () => db.listBacklogRecords(source, "issue").flatMap((r) => {
      const v = (r.remote ?? r.local) as BacklogIssueData | null;
      return v ? [{ id: r.externalId, value: v }] : [];
    });
    const byNumber = (n: number) => issues().find((i) => i.value.number === n);
    const moveSub = (n: number, from: number | null, to: number | null) => {
      const old = from === null ? undefined : byNumber(from);
      if (old) store("issue", old.id, { ...old.value, subIssues: old.value.subIssues.filter((x) => x !== n) });
      const next = to === null ? undefined : byNumber(to);
      if (next && !next.value.subIssues.includes(n)) store("issue", next.id, { ...next.value, subIssues: [...next.value.subIssues, n] });
    };
    // GitHub numbers Issues and pull requests alike: a number one of the PRs it had is not given (#2266)
    const pulls = () => db.listBacklogRecords(source, "pull-request").flatMap((r) => ((r.remote as BacklogPullRequestData | null)?.number ? [(r.remote as BacklogPullRequestData).number] : []));
    let applied = 0;
    for (const listed of ops) {
      // an earlier create renamed what later ones name (Db.setBacklogOperationResult)
      const op = db.getBacklogOperation(listed.id)!;
      if (!appliesHere(op)) continue;
      applied++;
      if (op.kind === "create") {
        const p = op.payload as BacklogCreatePayload;
        const number = Math.max(0, ...issues().map((i) => i.value.number), ...pulls()) + 1;
        // the API refuses a parent that is not there (checkLocalParent); one gone meanwhile is not kept
        const parent = p.parent !== null && byNumber(p.parent) ? p.parent : null;
        const id = `sb:${op.id}`;
        const value: BacklogIssueData = { number, title: p.title, url: "", state: p.state, stateReason: null, body: p.body, labels: p.labels, milestone: p.milestone, parent, subIssues: [], createdAt: at, updatedAt: at, closedAt: p.state === "CLOSED" ? at : null };
        db.setBacklogOperationResult(op.id, { status: "done", remoteId: id, record: { externalId: id, remote: value } }, now);
        if (p.project) store("project-item", `sb:item:${op.id}`, { issue: number, owner: p.project.owner, project: p.project.number, fields: p.project.fields } satisfies BacklogProjectItemData);
        if (parent !== null) moveSub(number, null, parent);
        continue;
      }
      const id = op.target.startsWith("local:") ? (op.kind === "comment" ? `sb:${String(op.seq).padStart(12, "0")}` : `sb:${op.target.slice("local:".length)}`) : op.target;
      if (op.kind === "comment") db.setBacklogOperationResult(op.id, { status: "done", remoteId: id, record: { externalId: id, remote: valueOf<BacklogCommentData>("comment", op.target) } }, now);
      else {
        const cur = valueOf<Record<string, unknown>>(op.targetKind, op.target);
        // out of the Project: the item is no longer shown
        let next = op.field === "member" && op.payload === false ? null : cur && applyBacklogField(op.targetKind, cur, op.field!, op.payload);
        if (op.targetKind === "issue" && next) {
          const issue = next as BacklogIssueData;
          if (op.field === "state") next = { ...issue, closedAt: issue.state === "CLOSED" ? at : null, stateReason: null };
          if (op.field === "parent") {
            // the relationship stays whole: a parent not there is dropped with its reason (as a send would be refused;
            // the API refuses it first, checkLocalParent), and the old one keeps it. Done, so it is not shown or tried again
            if (issue.parent !== null && (issue.parent === issue.number || !byNumber(issue.parent))) {
              db.setBacklogOperationResult(op.id, { status: "done", error: `#${issue.parent} は親にできないので確定しませんでした` }, now);
              continue;
            }
            moveSub(issue.number, (cur as unknown as BacklogIssueData).parent, issue.parent);
          }
        }
        db.setBacklogOperationResult(op.id, { status: "done", record: { externalId: id, remote: next } }, now);
      }
      // the Issue changed now: a stage that ran before it is not "unchanged" any more
      const issue = record("issue", db.getBacklogOperation(op.id)!.issue);
      if (issue?.remote) store("issue", issue.externalId, { ...(issue.remote as BacklogIssueData), updatedAt: at });
    }
    db.putBacklogSnapshot(source, { records: [], cursor: null, syncedAt: now });
    return applied;
  })();
}

/**
 * What is decided here at once: a create, a comment, an edit of an Issue made here (`sb:` / `local:`). An edit of an Issue
 * GitHub has — in a workspace whose GitHub sync is off (#2266) — waits for the sync to be on, and is sent then with the
 * check of what it was made on (#887); so does an operation sent or lost on the way (`sending` / `unknown`, …).
 */
const appliesHere = (op: BacklogOperation) =>
  op.status === "pending" && !op.remoteId && (op.kind !== "set" || op.issue.startsWith("sb:") || op.issue.startsWith("local:")) &&
  // a create of turning the sync on (#2266, backlog-enable.ts) makes an Issue made here on GitHub: it waits for GitHub
  !(op.kind === "create" && "former" in (op.payload as object));

/** The parent an edit of a backlog kept here (#2265) names must be one of its Issues, not the Issue itself: 422 otherwise, before anything is stored. */
export function checkLocalParent(db: Db, source: BacklogSource, parent: number | null | undefined, self?: number): void {
  if (parent === undefined || parent === null) return;
  const there = db.listBacklogRecords(source, "issue").some((r) => ((r.remote ?? r.local) as BacklogIssueData | null)?.number === parent);
  if (!there || parent === self) throw new BacklogEditError(`#${parent} は親にできません（${there ? "自分自身です" : "この workspace にありません"}）`, 422);
}

/**
 * The Project fields and the Milestone of an edit of a backlog kept here (#2265), checked against the workspace's
 * `ops.config.json` before anything is stored — there is no GitHub Project to resolve them when sent: Status takes the
 * kit's STATUS_OPTIONS, Area / Kind / Priority / Phase the config's `fields`, Story Points one of `storyPoints` (a
 * number; a numeric text, as `ops-kit backlog create --field` sends it, is read as one), the Milestone `milestone.pattern`.
 * null (a value taken off) passes. Without a config the kit's template (`defaultConfig`, #2361) gives the choices; with
 * one that cannot be read, any field or Milestone is refused. Throws BacklogEditError 422; returns the fields to store.
 */
export function checkLocalFields(dir: string, input: { fields?: Record<string, string | number | null> | null; milestone?: string | null }): Record<string, string | number | null> | undefined {
  const fields = input.fields ?? undefined;
  const named = Object.keys(fields ?? {}).length > 0 || (input.milestone !== undefined && input.milestone !== null);
  if (!named) return fields;
  const own = existsSync(join(dir, CONFIG_FILE));
  const source = own ? CONFIG_FILE : "既定の選択肢: ops-kit/template/ops.config.json";
  let cfg: OpsConfig;
  try {
    cfg = own ? loadConfig(join(dir, CONFIG_FILE)) : defaultConfig();
  } catch {
    throw new BacklogEditError(`${CONFIG_FILE} を読めないので Project のフィールドと Milestone は付けられません`, 422);
  }
  const choices: Record<string, Array<string | number> | undefined> = {
    Status: STATUS_OPTIONS, Area: cfg.fields.area, Kind: cfg.fields.kind, Priority: cfg.fields.priority, Phase: cfg.fields.phase, "Story Points": cfg.storyPoints,
  };
  const out: Record<string, string | number | null> = {};
  for (const [name, raw] of Object.entries(fields ?? {})) {
    // own names only: `toString` / `constructor` are no fields either
    const options = Object.hasOwn(choices, name) ? choices[name] : undefined;
    if (!options) throw new BacklogEditError(`${name} というフィールドはありません（${Object.keys(choices).filter((k) => choices[k]).join(" / ")}。${source}）`, 422);
    const v = name === "Story Points" && typeof raw === "string" && /^[0-9]+$/.test(raw) ? Number(raw) : raw;
    if (v !== null && !options.includes(v)) throw new BacklogEditError(`${name} は ${v} にできません（選択肢: ${options.join(", ")}。${source}）`, 422);
    out[name] = v;
  }
  const m = input.milestone;
  if (m !== undefined && m !== null && !(cfg.milestone && new RegExp(cfg.milestone.pattern).test(m)))
    throw new BacklogEditError(`Milestone は ${m} にできません（${cfg.milestone ? `${cfg.milestone.pattern} に合うもの` : "milestone.pattern がありません"}。${source}）`, 422);
  return fields ? out : fields;
}
