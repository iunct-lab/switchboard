import { projectOf, type OpsConfig } from "./config.ts";
import type { GhClient } from "./gh.ts";

interface Field {
  id?: string;
  name?: string;
  dataType?: string;
  options?: Array<{ name: string }>;
}
interface ProjectNode {
  id: string;
  number: number;
  title: string;
  url: string;
  fields: { nodes: Field[] };
}

/** The Status choices the kit's commands use (set / request / lint); GitHub's default is Todo / In Progress / Done. */
export const STATUS_OPTIONS = ["Backlog", "Ready", "In progress", "In review", "Done"];

const FIELDS = "fields(first:50){ nodes{ ... on ProjectV2FieldCommon{ id name dataType } ... on ProjectV2SingleSelectField{ options{ name } } } }";
// projectsV2 is on ProjectV2Owner (a user or an org), not on RepositoryOwner
const PROJECTS_Q = `id ... on ProjectV2Owner{ projectsV2(first:100, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id number title url ${FIELDS} } } }`;

const option = (name: string) => ({ name, color: "GRAY", description: "" });

/** Every Project of the owner, page by page (an org can have more than 100). */
async function projectsOf(gh: GhClient, owner: string): Promise<{ ownerId: string; projects: ProjectNode[] }> {
  const projects: ProjectNode[] = [];
  let ownerId = "";
  let after: string | null = null;
  for (;;) {
    const data = (await gh.graphql(
      owner === "@me" ? `query($after:String){ viewer{ ${PROJECTS_Q} } }` : `query($o:String!,$after:String){ repositoryOwner(login:$o){ ${PROJECTS_Q} } }`,
      owner === "@me" ? { after } : { o: owner, after },
    )) as any;
    const node = owner === "@me" ? data?.viewer : data?.repositoryOwner;
    if (!node?.id) throw new Error(`Project の持ち主 ${owner} が見つかりません`);
    ownerId = node.id;
    projects.push(...((node.projectsV2?.nodes ?? []) as ProjectNode[]));
    if (node.projectsV2?.pageInfo?.hasNextPage !== true) return { ownerId, projects };
    after = node.projectsV2.pageInfo.endCursor;
  }
}

/**
 * Make the Project ready: find the config's Project (by number, else by `title`), create it if there is none, then
 * create the single-select fields of the config (Area / Kind / Priority, Phase if any) and the number field
 * `Story Points` that are missing. Idempotent: an existing field is never changed (a wrong type or missing choices
 * are listed for the UI). Status is given the kit's choices only on a Project this run created — rewriting the
 * choices of an existing Status would clear every item's Status. Views cannot be made through the API.
 */
export async function bootstrap(gh: GhClient, cfg: OpsConfig, opts: { title: string; dryRun?: boolean }, log: (s: string) => void = console.log, env: Record<string, string | undefined> = process.env): Promise<{ number: number | null; url: string | null }> {
  const { owner, number } = projectOf(cfg, env);
  const { ownerId, projects } = await projectsOf(gh, owner);
  let project = projects.find((p) => p.number === number);
  let created = false;
  if (project) {
    log(`>> 既存の Project #${project.number}「${project.title}」を使う`);
    if (project.title !== opts.title) log(`   （設定の Project の題は「${project.title}」で、指定の「${opts.title}」と違う。このあと足りないフィールドをこの Project に作る。別のリポジトリの Project なら、先に --dry-run で確かめ、設定の projectUrl を直す）`);
  } else if ((project = projects.find((p) => p.title === opts.title))) {
    log(`>> 既存の Project #${project.number}「${project.title}」を使う（題で見つけた）`);
  } else if (opts.dryRun) {
    log(`DRY_RUN> Project「${opts.title}」を ${owner} に作る`);
  } else {
    const made = (await gh.graphql(`mutation($o:ID!,$t:String!){ createProjectV2(input:{ ownerId:$o, title:$t }){ projectV2{ id number title url ${FIELDS} } } }`, { o: ownerId, t: opts.title })) as any;
    const p = made?.createProjectV2?.projectV2 as ProjectNode | undefined;
    if (!p?.id) throw new Error(`Project「${opts.title}」を作れませんでした`);
    project = p;
    created = true;
    log(`>> Project #${p.number}「${opts.title}」を作成`);
  }

  const want: Array<{ name: string; options?: string[] }> = [
    { name: "Status", options: STATUS_OPTIONS },
    { name: "Area", options: cfg.fields.area },
    { name: "Kind", options: cfg.fields.kind },
    { name: "Priority", options: cfg.fields.priority },
    ...(cfg.fields.phase ? [{ name: "Phase", options: cfg.fields.phase }] : []),
    { name: "Story Points" },
  ];
  for (const f of want) {
    const type = f.options ? "SINGLE_SELECT" : "NUMBER";
    const have = project?.fields.nodes.find((x) => x.name === f.name);
    const lacking = (f.options ?? []).filter((o) => !(have?.options ?? []).some((x) => x.name === o));
    if (have && f.name === "Status" && created && lacking.length && have.id) {
      await gh.graphql("mutation($f:ID!,$o:[ProjectV2SingleSelectFieldOptionInput!]!){ updateProjectV2Field(input:{ fieldId:$f, singleSelectOptions:$o }){ projectV2Field{ ... on ProjectV2FieldCommon{ id } } } }", { f: have.id, o: STATUS_OPTIONS.map(option) });
      log(`>> フィールド 'Status' の選択肢を ${STATUS_OPTIONS.join(" / ")} にした`);
    } else if (have && have.dataType !== type) {
      log(`>> フィールド '${f.name}' は既に存在するが型が ${have.dataType}（${type} が要る。Project の UI で直す）`);
    } else if (have) {
      log(`>> フィールド '${f.name}' は既に存在（スキップ）${lacking.length ? `。Project に無い選択肢: ${lacking.join(" / ")}（Project の UI で足す）` : ""}`);
    } else if (f.name === "Status" && !project) {
      log(`DRY_RUN> 作った Project の Status の選択肢を ${STATUS_OPTIONS.join(" / ")} にする`);
    } else if (f.name === "Status") {
      log(`>> フィールド 'Status' が無い（Project の UI で作り、選択肢を ${STATUS_OPTIONS.join(" / ")} にする）`);
    } else if (opts.dryRun || !project) {
      log(`DRY_RUN> フィールド '${f.name}' を作る${f.options ? `（${f.options.join(" / ")}）` : "（数値）"}`);
    } else {
      await gh.graphql(
        f.options
          ? "mutation($p:ID!,$n:String!,$o:[ProjectV2SingleSelectFieldOptionInput!]!){ createProjectV2Field(input:{ projectId:$p, dataType:SINGLE_SELECT, name:$n, singleSelectOptions:$o }){ projectV2Field{ ... on ProjectV2FieldCommon{ id } } } }"
          : "mutation($p:ID!,$n:String!){ createProjectV2Field(input:{ projectId:$p, dataType:NUMBER, name:$n }){ projectV2Field{ ... on ProjectV2FieldCommon{ id } } } }",
        { p: project.id, n: f.name, ...(f.options ? { o: f.options.map(option) } : {}) },
      );
      log(`>> フィールド '${f.name}' を作成`);
    }
  }
  // The URL to put in the config, unless the environment chose the Project (then the config is not what is used)
  if (project && project.url !== cfg.projectUrl && !env[`${cfg.envPrefix}_PROJECT_URL`]) log(`\nProject の URL: ${project.url}\n設定の projectUrl をこの URL にしてください（今: ${cfg.projectUrl}）`);
  return { number: project?.number ?? null, url: project?.url ?? null };
}
