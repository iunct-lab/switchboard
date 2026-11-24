import type { BacklogItem, CreatedIssue, CreatedIssueRow, Workspace } from "@switchboard/protocol";
import { storedIssueReader } from "../backlog-stored.ts";
import type { ServerContext } from "./context.ts";

/**
 * The open requests and PBIs among the Issues a Task opened, in the order it opened them, each in the workspace whose
 * backlog reads its repository (`backlogReads`), with its backlog item and stage Task (`withActive`) for the stage
 * buttons. Each such workspace's stored backlog is read once; nothing is read when the Task opened none. One the backlog
 * has no item for (a request with a derived PBI) is read from its stored Issue, kept with `item: null` while it is an
 * open request or PBI. A closed Issue, a Task Issue and one of a repository no workspace reads are left out.
 */
export const createdRowsOf = (sc: Pick<ServerContext, "db" | "backlogReads" | "storedBacklog" | "withActive">, created: CreatedIssue[]): CreatedIssueRow[] => {
  if (created.length === 0) return [];
  const workspaces = sc.db.listWorkspaces().filter((ws) => sc.backlogReads(ws));
  const repoOf = new Map(workspaces.map((ws) => [ws.id, sc.db.getWorkspaceBacklogSource(ws.id)?.repository.toLowerCase() ?? null]));
  const items = new Map<string, Map<number, BacklogItem>>();
  // the stored Issues as readStoredIssue shows them, each workspace's read once (readStoredIssue reads every record shown, per Issue)
  const issues = storedIssueReader(sc.db);
  const itemsOf = (ws: Workspace) => {
    if (!items.has(ws.id)) {
      const wanted = new Set(created.filter((c) => c.repo.toLowerCase() === repoOf.get(ws.id)).map((c) => c.number));
      // only the created Issues' items get their stage Tasks read
      const stored = sc.storedBacklog(ws).items.filter((i) => wanted.has(i.number));
      items.set(ws.id, new Map(sc.withActive({ fetchedAt: 0, items: stored, errors: [], changes: [], syncs: [] }).items.map((i) => [i.number, i])));
    }
    return items.get(ws.id)!;
  };
  return created.flatMap((c): CreatedIssueRow[] => {
    const ws = workspaces.find((w) => repoOf.get(w.id) === c.repo.toLowerCase());
    if (!ws) return [];
    const item = itemsOf(ws).get(c.number);
    if (item) return [{ repo: c.repo, number: c.number, workspaceId: ws.id, title: item.title, url: item.url, kind: item.type, item }];
    const issue = issues.issue(ws.id, c.number);
    const kind = issue?.labels.includes("type:request") ? ("request" as const) : issue?.labels.includes("type:pbi") ? ("pbi" as const) : null;
    if (!issue || issue.state !== "OPEN" || !kind) return [];
    return [{ repo: c.repo, number: c.number, workspaceId: ws.id, title: issue.title, url: issue.url, kind, item: null }];
  });
};
