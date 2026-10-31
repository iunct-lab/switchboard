/**
 * A fake GitHub for the backlog's send and import tests (#886, #2266): its Issues, Project items and every write; `fail`
 * answers a call instead of it (after carrying it out when `after`). `now` = the time its answers are dated.
 */
import type { GhRunner } from "./backlog.ts";

export type Issue = { node_id: string; number: number; title: string; body: string; state: string; labels: string[]; parent: number | null; milestone?: number | null; closedAt?: string | null; comments: Array<{ node_id: string; body: string; created_at: string }> };

/** The Project's Status options; option `o<n>` is the n-th. */
const STATUS = ["Backlog", "Ready", "In progress", "In review", "Done"];

export function fakeGithub(now: () => number) {
  const issues = new Map<number, Issue>([
    [12, { node_id: "I_12", number: 12, title: "PBI", body: "本文", state: "OPEN", labels: ["type:pbi", "needs-decision"], parent: null, comments: [] }],
    [3, { node_id: "I_3", number: 3, title: "親", body: "", state: "OPEN", labels: ["type:pbi"], parent: null, comments: [] }],
  ]);
  const milestones = [{ number: 7, title: "Phase 2" }];
  const items = new Map<string, { issue: string; fields: Record<string, string | number | null> }>([["PVTI_I_12", { issue: "I_12", fields: { Status: "Backlog" } }]]);
  const writes: string[] = [];
  const fail: Array<{ match: (a: string[]) => boolean; status: number; headers?: string; after?: boolean; stderr?: string }> = [];
  // GitHub's edit history (#1329): who wrote which field to what, when (`deleted`: the revision's content is gone)
  const history: Array<{ issue: number; by: string; at: string; field: string; value?: unknown; deleted?: boolean }> = [];
  // autoAdd: the Project's own auto-add puts a new Issue in it, and an add of one already there is refused as GitHub does
  // next: the number GitHub gives the next Issue made (0 = 100 + how many it has)
  const state = { viewer: "me", historyNext: false, editsNext: false, lastWrite: "", autoAdd: false, next: 0 };
  const ok = (body: unknown) => ({ code: 0, stdout: `HTTP/2.0 200 OK\ncontent-type: application/json\ndate: ${new Date(now()).toUTCString()}\n\n${JSON.stringify(body)}`, stderr: "" });
  const byId = (id: string) => [...issues.values()].find((i) => i.node_id === id)!;
  const gh: GhRunner = async (args) => {
    const v: Record<string, any> = {};
    for (let k = 0; k < args.length; k++) if (args[k] === "-f" || args[k] === "-F") {
      const [key, ...rest] = args[k + 1]!.split("=");
      const val = rest.join("=");
      if (key!.endsWith("[]")) (v[key!.slice(0, -2)] ??= []).push(val);
      else v[key!] = args[k] === "-F" && /^\d+$/.test(val) ? Number(val) : val;
    }
    const method = args.includes("-X") ? args[args.indexOf("-X") + 1]! : "GET";
    const f = fail.findIndex((x) => x.match(args));
    const failure = f >= 0 ? fail.splice(f, 1)[0]! : null;
    const answer = (body: unknown) => (failure ? { code: 1, stdout: `HTTP/2.0 ${failure.status} X\ncontent-type: application/json\n${failure.headers ?? ""}\n{}`, stderr: failure.stderr ?? `HTTP ${failure.status}` } : ok(body));
    if (failure && !failure.after) return answer(null);
    const path = args[1]!;
    const q: string = v.query ?? "";
    if (method !== "GET" || q.startsWith("mutation")) writes.push(q ? q.slice(10, q.indexOf("(input")) : `${method} ${path}`);
    if (method === "PATCH") state.lastWrite = Object.keys(v)[0] ?? "";
    if (q.includes("updateProjectV2ItemFieldValue")) state.lastWrite = "field:Status";
    if (path === "graphql") {
      if (q.includes("timelineItems")) {
        // the read after a write: the Issue's fields (or the item's field), the history since $s, the viewer
        const i = issues.get(v.n);
        const since = String(v.s ?? "");
        const ev = (e: (typeof history)[number], node: Record<string, unknown>) => ({ actor: { login: e.by }, createdAt: e.at, ...node });
        const events = history.filter((e) => e.issue === v.n && e.at >= since && e.field !== "body").map((e) =>
          e.field === "title" ? ev(e, { __typename: "RenamedTitleEvent", currentTitle: e.value })
          : e.field === "state" ? ev(e, { __typename: e.value === "CLOSED" ? "ClosedEvent" : "ReopenedEvent" })
          : e.field.startsWith("label:") ? ev(e, { __typename: e.value ? "LabeledEvent" : "UnlabeledEvent", label: { name: e.field.slice("label:".length) } })
          : e.field === "milestone" ? ev(e, e.value === null ? { __typename: "DemilestonedEvent" } : { __typename: "MilestonedEvent", milestoneTitle: e.value })
          : e.field === "parent" ? ev(e, e.value === null ? { __typename: "ParentIssueRemovedEvent" } : { __typename: "ParentIssueAddedEvent", parent: { number: e.value } })
          : ev(e, { __typename: "ProjectV2ItemStatusChangedEvent", status: e.value, project: { id: e.value === "Other" ? "P_other" : "P_1" } }));
        // GitHub lists the content edits newest first, the body's whole life (no `since` on them)
        const edits = history.filter((e) => e.issue === v.n && e.field === "body").reverse().map((e) => ({ editedAt: e.at, editor: { login: e.by }, diff: e.deleted ? null : e.value, deletedAt: e.deleted ? e.at : null }));
        // the body's content edits are asked for a body write only (#1384 review)
        if (q.includes("userContentEdits") && state.lastWrite !== "body") throw new Error(`the body's edits were asked after a write of ${state.lastWrite || "nothing"}`);
        const issue = i && { id: i.node_id, title: i.title, body: i.body, state: i.state, closedAt: i.closedAt ?? null, milestone: milestones.find((m) => m.number === i.milestone) ?? null, parent: i.parent && { id: issues.get(i.parent)!.node_id, number: i.parent }, labels: { nodes: i.labels.map((name) => ({ name })) },
          timelineItems: { pageInfo: { hasNextPage: state.historyNext }, nodes: events }, userContentEdits: { pageInfo: { hasNextPage: state.editsNext }, nodes: edits } };
        return answer({ data: { viewer: { login: state.viewer }, repository: { issue }, node: v.i ? { fieldValueByName: items.get(v.i)?.fields[v.f] != null ? { name: items.get(v.i)!.fields[v.f] } : null } : null } });
      }
      if (q.includes("issue(number:$n)")) {
        const i = issues.get(v.n);
        return answer({ data: { repository: { issue: i && { id: i.node_id, title: i.title, body: i.body, state: i.state, milestone: milestones.find((m) => m.number === i.milestone) ?? null, parent: i.parent && { id: issues.get(i.parent)!.node_id, number: i.parent }, labels: { nodes: i.labels.map((name) => ({ name })) } } } } });
      }
      if (q.includes("projectV2(number:$p)")) return answer({ data: { repositoryOwner: { projectV2: { id: "P_1", fields: { nodes: [{ id: "F_s", name: "Status", dataType: "SINGLE_SELECT", options: STATUS.map((name, n) => ({ id: `o${n + 1}`, name })) }] } } } } });
      if (q.includes("addProjectV2ItemById")) {
        const id = `PVTI_${v.c}`;
        if (state.autoAdd && items.has(id)) return { code: 1, stdout: `HTTP/2.0 200 OK\ncontent-type: application/json\n\n${JSON.stringify({ data: { addProjectV2ItemById: null }, errors: [{ type: "UNPROCESSABLE", message: "Content already exists in this project" }] })}`, stderr: "gh: Content already exists in this project" };
        items.set(id, items.get(id) ?? { issue: v.c, fields: {} });
        return answer({ data: { addProjectV2ItemById: { item: { id } } } });
      }
      if (q.includes("projectItems")) return answer({ data: { node: { projectItems: { nodes: [...items].filter(([, i]) => i.issue === v.c).map(([id]) => ({ id, project: { id: "P_1" } })) } } } });
      if (q.includes("updateProjectV2ItemFieldValue")) return (items.get(v.i)!.fields.Status = STATUS[Number(String(v.value).slice(1)) - 1]!), answer({ data: {} });
      if (q.includes("deleteProjectV2Item")) return items.delete(v.i), answer({ data: {} });
      if (q.includes("removeSubIssue")) return (byId(v.c).parent = null), answer({ data: {} });
      if (q.includes("addSubIssue")) return (byId(v.c).parent = byId(v.p).number), answer({ data: {} });
      if (q.includes("... on Issue{ node_id")) {
        const i = byId(v.i);
        return answer({ data: { node: { ...i, html_url: `https://github.com/acme/app/issues/${i.number}`, created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z" } } });
      }
      if (q.includes("fieldValueByName")) return answer({ data: { node: { fieldValueByName: items.get(v.i)?.fields[v.f] != null ? { name: items.get(v.i)!.fields[v.f] } : null } } });
    }
    if (path.startsWith("repos/acme/app/milestones")) return answer(milestones);
    const m = /^repos\/acme\/app\/issues(?:\/(\d+))?(\/comments|\/labels(?:\/(.+))?)?(?:\?(.*))?$/.exec(path)!;
    const n = Number(m[1]);
    if (!m[1] && method === "POST") {
      const number = state.next ? state.next++ : issues.size + 100;
      const i: Issue = { node_id: `I_${number}`, number, title: v.title, body: v.body, state: "OPEN", labels: v.labels ?? [], parent: null, comments: [] };
      issues.set(i.number, i);
      if (state.autoAdd) items.set(`PVTI_${i.node_id}`, { issue: i.node_id, fields: {} });
      return answer({ ...i, html_url: `https://github.com/acme/app/issues/${i.number}`, created_at: "2026-10-08T00:00:00Z", updated_at: "2026-10-08T00:00:00Z" });
    }
    if (!m[1]) return answer([...issues.values()]);
    if (m[2] === "/comments" && method === "POST") {
      const c = { node_id: `IC_${n}_${issues.get(n)!.comments.length}`, body: v.body, created_at: "2026-10-08T00:00:00Z" };
      issues.get(n)!.comments.push(c);
      return answer(c);
    }
    if (m[2] === "/comments") return answer(issues.get(n)!.comments);
    if (m[2]?.startsWith("/labels")) {
      const i = issues.get(n)!;
      i.labels = method === "POST" ? [...i.labels, ...v.labels] : i.labels.filter((l) => l !== decodeURIComponent(m[3]!));
      return answer([]);
    }
    if (method === "PATCH") Object.assign(issues.get(n)!, v.state ? { state: v.state.toUpperCase() } : "milestone" in v ? { milestone: v.milestone === "null" ? null : v.milestone } : v);
    return answer({});
  };
  return { gh, issues, items, writes, fail, history, state };
}

