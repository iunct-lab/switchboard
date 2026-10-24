import { projectOf, type OpsConfig } from "./config.ts";
import { repoOf, type GhClient } from "./gh.ts";

/** A mistake in what was asked (unknown field or choice, a value of the wrong type): exit 1, nothing written. */
export class UsageError extends Error {}

const FIELD_Q = "field(name:$f){ ... on ProjectV2FieldCommon{ id dataType } ... on ProjectV2SingleSelectField{ options{ id name } } }";
const ISSUE_Q = "repository(owner:$ro,name:$rn){ issue(number:$n){ id projectItems(first:10){ nodes{ id project{ number } } } } }";

export interface Field {
  id: string;
  dataType: string;
  options?: Array<{ id: string; name: string }>;
}
export interface IssueRef {
  id: string;
  projectItems: { nodes: Array<{ id: string; project: { number: number } }> };
}

/** The part of a query that reaches the Project: `viewer` for `@me`, else the owner's login (a user or an org). */
export function projectFragment(owner: string, inner: string): string {
  return owner === "@me" ? `viewer{ projectV2(number:$p){ id ${inner} } }` : `repositoryOwner(login:$o){ ... on ProjectV2Owner{ projectV2(number:$p){ id ${inner} } } }`;
}
export function selectProject(owner: string, data: any): any {
  return owner === "@me" ? data?.viewer?.projectV2 : data?.repositoryOwner?.projectV2;
}

/** Put the Issue in the Project if it is not there yet (the first item if it is there twice); resolves to the item id. */
export async function ensureItem(gh: GhClient, projectId: string, projectNumber: number, issue: IssueRef, num: number, log: (s: string) => void): Promise<string> {
  const found = issue.projectItems.nodes.find((i) => i.project.number === projectNumber);
  if (found) return found.id;
  const data = (await gh.graphql("mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{ projectId:$p, contentId:$c }){ item{ id } } }", { p: projectId, c: issue.id })) as any;
  const id = data?.addProjectV2ItemById?.item?.id;
  if (typeof id !== "string") throw new Error(`#${num} を Project に追加できませんでした`);
  log(`>> Project に追加: #${num}`);
  return id;
}

/** The value part of updateProjectV2ItemFieldValue for a field of this type, after checking the value fits it. */
export function fieldValue(name: string, field: Field, value: string): { type: string; input: string; value: string | number } {
  switch (field.dataType) {
    case "SINGLE_SELECT": {
      const opt = field.options?.find((o) => o.name === value);
      if (!opt) throw new UsageError(`'${name}' に選択肢 '${value}' がありません: ${(field.options ?? []).map((o) => o.name).join(" / ")}`);
      return { type: "String!", input: "{ singleSelectOptionId: $value }", value: opt.id };
    }
    case "NUMBER":
      if (!/^[0-9]+$/.test(value)) throw new UsageError(`'${name}' は数値フィールドです。整数だけを渡す（例: 5）: '${value}'`);
      return { type: "Float!", input: "{ number: $value }", value: Number(value) };
    case "TEXT":
      return { type: "String!", input: "{ text: $value }", value };
    case "DATE":
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) throw new UsageError(`'${name}' は日付フィールドです。YYYY-MM-DD で渡す: '${value}'`);
      return { type: "Date!", input: "{ date: $value }", value };
    default:
      throw new UsageError(`未対応のフィールド型: ${field.dataType}（ITERATION などは Project の UI で設定する）`);
  }
}

/**
 * Set one Project field of one Issue (single select / number / text / date). One query reads the Project, the field
 * and the Issue; one mutation writes (plus one to add the Issue to the Project when it is not there).
 */
export async function setField(gh: GhClient, cfg: OpsConfig, num: number, name: string, value: string, log: (s: string) => void = console.log): Promise<void> {
  const { owner, number } = projectOf(cfg);
  const repo = await repoOf(gh);
  const query = `query(${owner === "@me" ? "" : "$o:String!,"}$p:Int!,$f:String!,$ro:String!,$rn:String!,$n:Int!){ ${projectFragment(owner, FIELD_Q)} ${ISSUE_Q} }`;
  const data = (await gh.graphql(query, { ...(owner === "@me" ? {} : { o: owner }), p: number, f: name, ro: repo.owner, rn: repo.name, n: num })) as any;
  const project = selectProject(owner, data);
  if (!project?.id) throw new Error(`Project ${owner}/${number} が見つかりません`);
  const issue = data?.repository?.issue as IssueRef | undefined;
  if (!issue?.id) throw new Error(`Issue #${num} が ${repo.owner}/${repo.name} にありません`);
  const field = project.field as Field | null;
  if (!field?.id) throw new UsageError(`フィールド '${name}' が Project にありません`);
  const v = fieldValue(name, field, value);
  const item = await ensureItem(gh, project.id, number, issue, num, log);
  await gh.graphql(`mutation($p:ID!,$i:ID!,$f:ID!,$value:${v.type}){ updateProjectV2ItemFieldValue(input:{ projectId:$p, itemId:$i, fieldId:$f, value:${v.input} }){ projectV2Item{ id } } }`, {
    p: project.id,
    i: item,
    f: field.id,
    value: v.value,
  });
  log(`#${num}  ${name} = ${value}`);
}

