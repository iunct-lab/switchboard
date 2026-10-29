import { projectOf, sectionName, type OpsConfig, type Section } from "./config.ts";
import { GhError, repoOf, type GhClient } from "./gh.ts";
import { projectFragment, selectProject } from "./set.ts";
import type { StoredRecords } from "./backlog-client.ts";

export interface Violation {
  issue: number;
  message: string;
}

/** The open Issues could not be read, or came back in a shape the checks do not know: exit 2, never "0 violations". */
export class LintFetchError extends Error {}

interface Row {
  number: number;
  body: string;
  labels: { nodes: Array<{ name: string }> };
  parent: { number: number; labels: { nodes: Array<{ name: string }> } } | null;
  subIssues: { totalCount: number };
  projectItems?: { nodes: Array<{ project: { number: number }; fieldValues: { nodes: Array<{ number?: number; name?: string; field?: { name?: string } }> } }> };
}

const PROJECT_FIELDS =
  "projectItems(first:10){ nodes{ project{ number } fieldValues(first:30){ nodes{ ... on ProjectV2ItemFieldNumberValue{ number field{ ... on ProjectV2FieldCommon{ name } } } ... on ProjectV2ItemFieldSingleSelectValue{ name field{ ... on ProjectV2FieldCommon{ name } } } } } } }";

/** With the Project, the query also reads its id, so a Project the config names wrongly fails the fetch (exit 2). */
export function lintQuery(withProject: boolean, projectOwner = ""): string {
  const vars = withProject ? `${projectOwner === "@me" ? "" : ",$o:String!"},$p:Int!` : "";
  const project = withProject ? `${projectFragment(projectOwner, "")} ` : "";
  return `query($ro:String!,$rn:String!,$after:String${vars}){ ${project}repository(owner:$ro,name:$rn){ issues(states:OPEN, labels:["type:pbi","type:task","type:request"], first:100, after:$after, orderBy:{field:CREATED_AT, direction:DESC}){ pageInfo{ hasNextPage endCursor } nodes{ number body labels(first:50){ nodes{ name } } parent{ number labels(first:20){ nodes{ name } } } subIssues(first:1){ totalCount } ${withProject ? PROJECT_FIELDS : ""} } } } }`;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const hasSection = (body: string, name: string) => new RegExp(`^##+ *${escape(name)}`, "m").test(body);
/** Whose words a request is (request-to-backlog's 「誰の言葉」): fixed in the kit, not configurable. */
export const SPEAKERS = ["利用者", "エージェント", "定期の検査"] as const;
export const SPEAKER_MISSING = `要望の「## 出典」に「- 誰の言葉: ${SPEAKERS.join(" / ")}」の行が無い`;
const SPEAKER_LINE = new RegExp(`^- 誰の言葉: (${SPEAKERS.join("|")})(?:[（( ].*)?$`);

/**
 * The value of the first `- 誰の言葉: <value>` line under the 出典 heading, or null when there is none of the three.
 * The section ends at the next heading of the same or a higher level (the Issue form writes `### 出典`).
 */
export function speakerOf(body: string): string | null {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^##+ *出典/.test(l));
  if (start < 0) return null;
  const level = /^#+/.exec(lines[start]!)![0].length;
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#+) /.exec(line);
    if (heading && heading[1]!.length <= level) break;
    const m = SPEAKER_LINE.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

const missing = (kind: string, s: Section) => `${kind}に「## ${sectionName(s)}」が無い${typeof s === "string" ? "" : `（${s.hint}）`}`;
const labelsOf = (r: { labels: { nodes: Array<{ name: string }> } }) => r.labels.nodes.map((l) => l.name);

/** Story Points written in the body: `**Story Points**: N`, or the first number under a `## Story Points` heading. */
export function bodyStoryPoints(body: string): number | null {
  const m = /^\*\*Story Points\*\*: *([0-9]+)/m.exec(body);
  if (m) return Number(m[1]);
  let under = false;
  for (const line of body.split("\n")) {
    if (/^##+ *Story Points/.test(line)) under = true;
    else if (under && /^##/.test(line)) return null;
    else if (under && /^[0-9]+/.test(line)) return Number(/^[0-9]+/.exec(line)![0]);
  }
  return null;
}

/** Each line outside fences (``` / ~~~): the same reading as core's prereqsOf. */
function* unfenced(body: string): Generator<string> {
  let fence: string | null = null;
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const before = fence;
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    fence = fence ? (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker ? null : fence) : (marker ?? null);
    if (!before && !fence) yield line;
  }
}

/** The numbers on the first `**前提**:` line outside fences: all the schedule and the parallel guard read. */
export function declaredPrereqs(body: string): number[] {
  for (const line of unfenced(body)) if (line.startsWith("**前提**:")) return [...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  return [];
}

/** The free-text phrasings after `#N` that name a predecessor (#2149), besides `前提: #N` (#1990). A fixed list, not configured. */
export const PREREQ_PHRASES = ["の後", "のマージ後", "の完了後", "を待つ", "が先"] as const;
const FREE_PREREQ = new RegExp(`前提[:：]\\s*#(\\d+)|#(\\d+)(?!\\d)[^#\\n]{0,12}?(?:${PREREQ_PHRASES.join("|")})`, "g");

/** The numbers free text names as predecessors: outside fences, inline code and the `**前提**:` line. */
export function freeTextPrereqs(body: string): number[] {
  const out = new Set<number>();
  for (const line of unfenced(body)) {
    if (line.startsWith("**前提**:")) continue;
    // a code span opens and closes with a whole run of the same number of backticks (``#1 の後``); a run with no
    // closing one is text, and a span may start after it
    for (const m of line.replace(/(?<!`)(`+)(?!`).+?(?<!`)\1(?!`)/g, "").matchAll(FREE_PREREQ)) out.add(Number(m[1] ?? m[2]));
  }
  return [...out];
}

export const freeTextPrereq = (named: number[]) => `本文の自由文に先行（${named.map((k) => `#${k}`).join(", ")}）があるが **前提**: 行に無い。定期実行と並列ガードは **前提**: 行だけを読む`;

async function fetchAll(gh: GhClient, owner: string, name: string, project: { owner: string; number: number } | null, sleep: (ms: number) => Promise<void>): Promise<Row[]> {
  const withProject = project !== null;
  const projectVars = project === null ? {} : { ...(project.owner === "@me" ? {} : { o: project.owner }), p: project.number };
  const rows: Row[] = [];
  let after: string | null = null;
  for (;;) {
    let page: any;
    for (let attempt = 1; ; attempt++) {
      // GraphQL fails now and then: up to 3 tries, no wait after the last; a limit, an outage or an auth failure is not
      // asked again (the client waits for GitHub's time, #894)
      try {
        page = await gh.graphql(lintQuery(withProject, project?.owner), { ro: owner, rn: name, after, ...projectVars });
        break;
      } catch (e) {
        if (attempt === 3 || (e instanceof GhError && e.kind !== null)) throw new LintFetchError(`open の Issue の取得に失敗: ${(e as Error).message.slice(0, 200)}`);
        await sleep(attempt * 2000);
      }
    }
    if (project && !selectProject(project.owner, page)?.id) throw new LintFetchError(`Project ${project.owner}/${project.number} が見つかりません`);
    const issues = page?.repository?.issues;
    if (!Array.isArray(issues?.nodes)) throw new LintFetchError("open の Issue の取得結果の形が想定と違う");
    if (withProject && issues.nodes.some((n: Row) => !Array.isArray(n?.projectItems?.nodes) || n.projectItems!.nodes.some((i) => !Array.isArray(i?.fieldValues?.nodes)))) {
      throw new LintFetchError("open の Issue の取得結果の形が想定と違う（Project のフィールドが無い）");
    }
    rows.push(...issues.nodes);
    if (issues.pageInfo?.hasNextPage !== true) return rows;
    after = issues.pageInfo.endCursor;
  }
}

const TYPES = ["type:pbi", "type:task", "type:request"];

/**
 * The rows the query would answer, from the records the app stored (#919): its open PBIs, Tasks and requests, the
 * parents' labels from the stored Issues, the fields in the workspace's Project. An open one whose last read was not
 * complete fails (exit 2): what is stored of it is not read as current.
 */
export function storedRows(r: StoredRecords, withProject: boolean): Row[] {
  const byNumber = new Map(r.issues.map((i) => [i.number, i]));
  const open = r.issues.filter((i) => i.state === "OPEN" && i.labels.some((l) => TYPES.includes(l)));
  const unread = open.filter((i) => r.unread.includes(i.number)).map((i) => `#${i.number}`);
  if (unread.length) throw new LintFetchError(`最後の取込みで読めていない Issue がある: ${unread.join(", ")}（--fresh で取り込み直す）`);
  const nodes = (labels: string[]) => ({ nodes: labels.map((name) => ({ name })) });
  return open.map((i) => ({
    number: i.number,
    body: i.body,
    labels: nodes(i.labels),
    // a parent not stored has no type label (the import reads every typed Issue)
    parent: i.parent === null ? null : { number: i.parent, labels: nodes(byNumber.get(i.parent)?.labels ?? []) },
    subIssues: { totalCount: i.subIssues.length },
    ...(withProject && {
      projectItems: { nodes: i.fields ? [{ project: { number: r.project.number }, fieldValues: { nodes: Object.entries(i.fields).map(([name, v]) => (typeof v === "number" ? { number: v, field: { name } } : { name: v ?? undefined, field: { name } })) } }] : [] },
    }),
  }));
}

/**
 * Check the open PBIs, Tasks and requests against the writing rules, reading every one of them with one paged query —
 * or, given `records` (#919), from what the app stored, with the Project the app reads for the workspace.
 * `withProject: false` skips what needs the Project (Story Points there, Status) — for a gh without the project scope.
 */
export async function lint(gh: GhClient, cfg: OpsConfig, opts: { withProject?: boolean; sleep?: (ms: number) => Promise<void>; records?: StoredRecords } = {}): Promise<{ violations: Violation[]; warnings: Violation[]; fetched: number }> {
  const withProject = opts.withProject ?? true;
  const project = !withProject ? null : opts.records ? opts.records.project : projectOf(cfg);
  const projectNumber = project?.number ?? 0;
  let rows: Row[];
  if (opts.records) rows = storedRows(opts.records, withProject);
  else {
    const repo = await repoOf(gh);
    rows = await fetchAll(gh, repo.owner, repo.name, project, opts.sleep ?? ((ms) => Bun.sleep(ms)));
  }
  const violations: Violation[] = [];
  const bad = (issue: number, message: string) => violations.push({ issue, message });
  // shown, but not counted: the exit stays what the violations make it (#1990)
  const warnings: Violation[] = [];
  // a predecessor named only in free text: an open PBI or Task, not on the **前提**: line, and not the Issue's own
  // parent, child or sibling Task (the stack's order). A closed one is met and stops nothing (#2149)
  const open = new Set(rows.filter((r) => labelsOf(r).some((l) => l === "type:pbi" || l === "type:task")).map((r) => r.number));
  const parentOf = new Map(rows.map((r) => [r.number, r.parent?.number ?? null]));
  const freePrereqs = (row: Row, body: string) => {
    const declared = declaredPrereqs(body);
    const parent = row.parent?.number ?? null;
    const own = (k: number) => k === row.number || k === parent || parentOf.get(k) === row.number || (parent !== null && parentOf.get(k) === parent);
    const named = freeTextPrereqs(body).filter((k) => open.has(k) && !declared.includes(k) && !own(k));
    if (named.length) warnings.push({ issue: row.number, message: freeTextPrereq(named) });
  };
  const points = cfg.storyPoints.join(" / ");
  const isPoint = (n: number) => cfg.storyPoints.includes(n);

  const origin = cfg.sections.origin;
  for (const row of rows.filter((r) => labelsOf(r).includes("type:pbi"))) {
    const n = row.number;
    const body = row.body.replace(/\r\n/g, "\n");
    for (const s of cfg.sections.pbi) if (sectionName(s) !== origin?.name && !hasSection(body, sectionName(s))) bad(n, missing("PBI ", s));
    if (!/^- \[[ x]\]/m.test(body)) bad(n, "PBI の受け入れ条件にチェックボックス行が無い");
    if (origin && !hasSection(body, origin.name)) {
      bad(n, missing("PBI ", cfg.sections.pbi.find((s) => sectionName(s) === origin.name) ?? origin.name));
    } else if (origin) {
      // the first non-empty line under the heading
      const lines = body.split("\n");
      const at = lines.findIndex((l) => new RegExp(`^##+ *${escape(origin.name)}`).test(l));
      const first = lines.slice(at + 1).find((l) => l.trim() !== "") ?? "";
      if (!new RegExp(origin.pattern).test(first)) bad(n, `PBI の「## ${origin.name}」は ${origin.hint}（今: ${[...first].slice(0, 40).join("")}）`);
    }
    const bodySp = bodyStoryPoints(body);
    if (bodySp === null) bad(n, "PBI 本文に `**Story Points**: N` が無い");
    else if (bodySp > Math.max(...cfg.storyPoints)) bad(n, `Story Points ${bodySp} は「大きすぎる」の印。分割してから Backlog に入れる`);
    else if (!isPoint(bodySp)) bad(n, `Story Points は ${points} のどれか（本文: ${bodySp}）`);
    freePrereqs(row, body);
    if (row.parent) bad(n, `PBI に親 Issue（#${row.parent.number}）が付いている。PBI は親なし（Backlog ビューに出すため）`);
    if (!withProject) continue;
    const item = row.projectItems!.nodes.find((i) => i.project.number === projectNumber);
    if (!item) {
      bad(n, "Project に入っていない（triage で追加する）");
      continue;
    }
    const value = (field: string) => item.fieldValues.nodes.find((v) => v.field?.name === field);
    const spRaw = value("Story Points")?.number;
    const sp = typeof spRaw === "number" && Number.isInteger(spRaw) ? spRaw : null;
    if (sp === null) bad(n, `Project の Story Points が未設定（set ${n} "Story Points" ${bodySp ?? "N"}）`);
    else if (!isPoint(sp)) bad(n, `Project の Story Points が ${points} 以外（${sp}）`);
    else if (bodySp !== null && sp !== bodySp) bad(n, `Story Points が本文（${bodySp}）と Project（${sp}）で違う`);
    const priority = value("Priority")?.name;
    const priorities = cfg.fields.priority.join(" / ");
    if (!priority) bad(n, `Project の Priority が未設定（backlog set ${n} Priority <${priorities}>）`);
    else if (!cfg.fields.priority.includes(priority)) bad(n, `Project の Priority が ${priorities} 以外（${priority}）`);
    const status = value("Status")?.name;
    if ((status === "Ready" || status === "In progress") && row.subIssues.totalCount === 0) bad(n, `Status=${status} なのに Task（sub-issue）が無い`);
  }

  for (const row of rows.filter((r) => labelsOf(r).includes("type:task"))) {
    const body = row.body.replace(/\r\n/g, "\n");
    for (const s of cfg.sections.task) if (!hasSection(body, sectionName(s))) bad(row.number, missing("Task ", s));
    if (!row.parent) bad(row.number, "Task に親 PBI（sub-issue の親）が付いていない");
    else if (!labelsOf(row.parent).includes("type:pbi")) bad(row.number, `Task の親 #${row.parent.number} が type:pbi ではない`);
    freePrereqs(row, body);
  }

  for (const row of rows.filter((r) => labelsOf(r).includes("type:request"))) {
    const body = row.body.replace(/\r\n/g, "\n");
    for (const s of cfg.sections.request) if (!hasSection(body, sectionName(s))) bad(row.number, missing("要望", s));
    if (hasSection(body, "出典") && !speakerOf(body)) bad(row.number, SPEAKER_MISSING);
  }

  return { violations, warnings, fetched: rows.length };
}

/** The lines `lint_backlog.sh` printed: `#N: message` per violation, `warning: #N: message` per warning, then the counts. */
export function formatLint(violations: Violation[], warnings: Violation[] = []): string[] {
  return [
    ...violations.map((v) => `#${v.issue}: ${v.message}`),
    ...warnings.map((w) => `warning: #${w.issue}: ${w.message}`),
    `violations: ${violations.length}  warnings: ${warnings.length}  (api errors: 0)`,
  ];
}
