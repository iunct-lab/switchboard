import { projectOf, type OpsConfig } from "./config.ts";
import { repoOf, type GhClient } from "./gh.ts";
import { ensureItem, projectFragment, selectProject, UsageError, type IssueRef } from "./set.ts";

export interface TriageInput {
  area: string;
  kind: string;
  priority: string;
  /** Required when the config has `fields.phase`, refused when it does not. */
  phase?: string;
  /** A Task's parent PBI (a PBI gets none: the Backlog view is `no:parent-issue`). */
  parent?: number;
  status?: string;
}

const FIELDS_Q = "fields(first:50){ nodes{ ... on ProjectV2SingleSelectField{ id name options{ id name } } } }";

/**
 * Put one Issue in the Project and set Area / Kind / Priority / (Phase) / Status, and its parent. One query reads the
 * Project's fields, the Issue and the parent; one mutation sets every field; one more links the parent.
 */
export async function triage(gh: GhClient, cfg: OpsConfig, num: number, input: TriageInput, log: (s: string) => void = console.log): Promise<void> {
  // The choices are the Project's (a value it lacks is skipped with a note, as below): the same entry is used with
  // <envPrefix>_PROJECT_URL for another repository's Project, whose choices are not this config's.
  if (cfg.fields.phase) {
    if (input.phase === undefined) throw new UsageError("この設定には Phase があるので phase を渡してください");
  } else if (input.phase !== undefined) {
    throw new UsageError("この設定には Phase が無いので phase は渡せません");
  }
  const want: Array<[string, string]> = [
    ["Area", input.area],
    ["Kind", input.kind],
    ["Priority", input.priority],
    ...(input.phase === undefined ? [] : ([["Phase", input.phase]] as Array<[string, string]>)),
    ["Status", input.status ?? "Backlog"],
  ];

  const { owner, number } = projectOf(cfg);
  const repo = await repoOf(gh);
  const withParent = input.parent !== undefined;
  const query = `query(${owner === "@me" ? "" : "$o:String!,"}$p:Int!,$ro:String!,$rn:String!,$n:Int!${withParent ? ",$pn:Int!" : ""}){ ${projectFragment(owner, FIELDS_Q)} repository(owner:$ro,name:$rn){ issue(number:$n){ id projectItems(first:10){ nodes{ id project{ number } } } }${withParent ? " parent: issue(number:$pn){ id }" : ""} } }`;
  const data = (await gh.graphql(query, { ...(owner === "@me" ? {} : { o: owner }), p: number, ro: repo.owner, rn: repo.name, n: num, ...(withParent ? { pn: input.parent } : {}) })) as any;
  const project = selectProject(owner, data);
  if (!project?.id) throw new Error(`Project ${owner}/${number} が見つかりません`);
  const issue = data?.repository?.issue as IssueRef | undefined;
  if (!issue?.id) throw new Error(`Issue #${num} が ${repo.owner}/${repo.name} にありません`);
  const parentId = withParent ? (data?.repository?.parent?.id as string | undefined) : undefined;
  if (withParent && !parentId) throw new Error(`親の Issue #${input.parent} が ${repo.owner}/${repo.name} にありません`);

  const existing = issue.projectItems.nodes.some((i) => i.project.number === number);
  const item = await ensureItem(gh, project.id, number, issue, num, log);
  if (existing) log(`>> Project に既存: #${num}`);

  const fields = ((project.fields?.nodes ?? []) as Array<{ id?: string; name?: string; options?: Array<{ id: string; name: string }> }>).filter((f) => f.id);
  const sets: Array<{ name: string; value: string; field: string; option: string }> = [];
  for (const [name, value] of want) {
    const f = fields.find((x) => x.name === name);
    const opt = f?.options?.find((o) => o.name === value);
    if (!f?.id || !opt) log(`   (フィールド ${name} / 選択肢 ${value} が無いためスキップ)`);
    else sets.push({ name, value, field: f.id, option: opt.id });
  }
  if (sets.length) {
    const vars: Record<string, unknown> = { p: project.id, i: item };
    const decl = sets.map((_, k) => `$f${k}:ID!,$o${k}:String!`).join(",");
    const body = sets.map((_, k) => `s${k}: updateProjectV2ItemFieldValue(input:{ projectId:$p, itemId:$i, fieldId:$f${k}, value:{ singleSelectOptionId:$o${k} } }){ projectV2Item{ id } }`).join(" ");
    sets.forEach((s, k) => Object.assign(vars, { [`f${k}`]: s.field, [`o${k}`]: s.option }));
    await gh.graphql(`mutation($p:ID!,$i:ID!,${decl}){ ${body} }`, vars);
    for (const s of sets) log(`   ${s.name} = ${s.value}`);
  }

  if (parentId) {
    try {
      await gh.graphql("mutation($p:ID!,$c:ID!){ addSubIssue(input:{issueId:$p, subIssueId:$c}){ issue { number } } }", { p: parentId, c: issue.id });
      log(`   parent = #${input.parent}`);
    } catch {
      log("   (parent の設定をスキップ: 既に親がある可能性)");
    }
  }
}

const OPEN_Q = (kind: "issues" | "pullRequests") =>
  `${kind}(states:OPEN, first:100, after:$c){ pageInfo{ hasNextPage endCursor } nodes{ id number projectItems(first:10){ nodes{ id project{ id number } } } } }`;

/**
 * Put every open Issue and PR that is not in the Project yet into it, without fields (#916): what `project-autoadd.yml`
 * does on open / reopen, for when Actions does not run. An item already there is not touched (its Status stays), so a
 * second run adds nothing. `dryRun`: only list what would be added. Resolves to the numbers added (or to add).
 */
export async function reconcileProject(gh: GhClient, cfg: OpsConfig, opts: { dryRun?: boolean } = {}, log: (s: string) => void = console.log): Promise<number[]> {
  const { owner, number } = projectOf(cfg);
  const repo = await repoOf(gh);
  const head = (await gh.graphql(`query(${owner === "@me" ? "" : "$o:String!,"}$p:Int!){ ${projectFragment(owner, "")} }`, { ...(owner === "@me" ? {} : { o: owner }), p: number })) as any;
  const projectId = selectProject(owner, head)?.id as string | undefined;
  if (!projectId) throw new Error(`Project ${owner}/${number} が見つかりません`);
  const missing: Array<IssueRef & { number: number }> = [];
  for (const kind of ["issues", "pullRequests"] as const) {
    let cursor: string | null = null;
    do {
      const data = (await gh.graphql(`query($ro:String!,$rn:String!,$c:String){ repository(owner:$ro,name:$rn){ ${OPEN_Q(kind)} } }`, { ro: repo.owner, rn: repo.name, c: cursor })) as any;
      const page = data?.repository?.[kind];
      if (!page) throw new Error(`${repo.owner}/${repo.name} の ${kind} が読めません`);
      // by the Project's id: the number alone is the owner's, and another owner's Project #N is not this one
      for (const n of page.nodes as Array<{ id: string; number: number; projectItems: { nodes: Array<{ project: { id: string } }> } }>) {
        if (n.projectItems.nodes.some((i) => i.project.id === projectId)) continue;
        missing.push({ id: n.id, number: n.number, projectItems: { nodes: [] } });
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
  }
  for (const item of missing) {
    if (opts.dryRun) log(`>> 追加する: #${item.number}`);
    else await ensureItem(gh, projectId, number, item, item.number, log);
  }
  log(`${opts.dryRun ? "追加する" : "追加した"}: ${missing.length} 件`);
  return missing.map((m) => m.number);
}
