import { projectOf, sectionName, STORY_POINTS, type OpsConfig, type Section } from "./config.ts";
import { GhError, repoOf, type GhClient } from "./gh.ts";
import { projectFragment, selectProject } from "./set.ts";
import type { StoredRecords } from "./backlog-client.ts";
import { KNOWN_FAILURES_FILE, type KnownFailure } from "./known-failures.ts";
import { proceedLine, proceedRefusal, tableRefusal, unfenced, type AskPlace } from "./reversibility.ts";

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
  comments: Array<{ body: string; createdAt: string }>;
  projectItems?: { nodes: Array<{ project: { number: number }; fieldValues: { nodes: Array<{ number?: number; name?: string; field?: { name?: string } }> } }> };
}

const PROJECT_FIELDS =
  "projectItems(first:10){ nodes{ project{ number } fieldValues(first:30){ nodes{ ... on ProjectV2ItemFieldNumberValue{ number field{ ... on ProjectV2FieldCommon{ name } } } ... on ProjectV2ItemFieldSingleSelectValue{ name field{ ... on ProjectV2FieldCommon{ name } } } } } } }";

// comments(last:10): the 進め方 line check reads the last 10 comments of each Issue when it reads GitHub directly; the
// app's stored records carry every comment
/** With the Project, the query also reads its id, so a Project the config names wrongly fails the fetch (exit 2). */
export function lintQuery(withProject: boolean, projectOwner = ""): string {
  const vars = withProject ? `${projectOwner === "@me" ? "" : ",$o:String!"},$p:Int!` : "";
  const project = withProject ? `${projectFragment(projectOwner, "")} ` : "";
  return `query($ro:String!,$rn:String!,$after:String${vars}){ ${project}repository(owner:$ro,name:$rn){ issues(states:OPEN, labels:["type:pbi","type:task","type:request"], first:100, after:$after, orderBy:{field:CREATED_AT, direction:DESC}){ pageInfo{ hasNextPage endCursor } nodes{ number body labels(first:50){ nodes{ name } } parent{ number labels(first:20){ nodes{ name } } } subIssues(first:1){ totalCount } comments(last:10){ nodes{ body createdAt } } ${withProject ? PROJECT_FIELDS : ""} } } } }`;
}

/** The kinds of a `（マージの後: <種類> …）` mark. Core keeps the same four for the app's reading. */
export const POST_MERGE_KINDS = ["画面", "E2E", "実ランナー", "観測"] as const;
const POST_MERGE_MARK = "（マージの後:";
/** A code span of any number of backticks (the same rule core reads criteria with). */
const CODE_SPAN = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
const OBSERVE_DUE = /期日\s+\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})\s*以降/;

/**
 * What is wrong with the 「マージの後」 marks in a PBI's 受け入れ条件 (checkbox lines outside fences; a mark inside inline
 * code is not read): a kind other than the four, an 観測 without `期日 <ISO 8601 with a time zone> 以降`, and a line that
 * also carries `（利用者確認:` (the one answer would be read two ways).
 */
export function postMergeProblems(body: string): string[] {
  const problems: string[] = [];
  let level = 0;
  for (const line of unfenced(body)) {
    const heading = /^(#+) +(.*)$/.exec(line);
    if (heading) {
      if (level === 0 && /^到達点 \/ 受け入れ条件/.test(heading[2]!)) level = heading[1]!.length;
      else if (level > 0 && heading[1]!.length <= level) level = 0;
      continue;
    }
    if (level === 0 || !/^- \[[ x]\]/.test(line)) continue;
    const text = line.replace(CODE_SPAN, "");
    const marks = text.split(POST_MERGE_MARK).slice(1);
    if (marks.length === 0) continue;
    const shown = [...line.trim()].slice(0, 40).join("");
    for (const rest of marks) {
      const mark = rest.split("）")[0]!.trim();
      const kind = mark.split(/[\s、,]/)[0]!;
      if (!(POST_MERGE_KINDS as readonly string[]).includes(kind)) problems.push(`受け入れ条件の「マージの後」の種類は ${POST_MERGE_KINDS.join(" / ")} のどれか（今: ${kind}。行: ${shown}）`);
      else if (kind === "観測" && !OBSERVE_DUE.test(mark)) problems.push(`受け入れ条件の「マージの後: 観測」に「期日 <ISO 8601 のタイムゾーンつき> 以降」が無い（行: ${shown}）`);
    }
    if (text.includes("（利用者確認:")) problems.push(`受け入れ条件の「マージの後」と「利用者確認」が同じ行にある。行を分ける（行: ${shown}）`);
  }
  return problems;
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

/**
 * Why a body about to be saved over `before` is broken (null when it is not): its first line is the `null` that
 * `jq -r .body` prints for a missing key, or, for a PBI, it loses a required section (`pbiSections`) or the
 * `**Story Points**:` line that `before` had. A section `before` already lacked is not asked for.
 */
export function bodyLoss(before: string, after: string, isPbi: boolean, pbiSections: string[]): string | null {
  if (after.split("\n").find((l) => l.trim())?.trim() === "null") return "本文の先頭が null だけ（jq -r .body は null を出す。本文は .issue.body にある）";
  if (!isPbi) return null;
  const lost = [...pbiSections.filter((s) => hasSection(before, s) && !hasSection(after, s)).map((s) => `「## ${s}」`), ...(bodyStoryPoints(before) !== null && bodyStoryPoints(after) === null ? ["「**Story Points**:」の行"] : [])];
  return lost.length ? `PBI の必須の節が無くなる: ${lost.join("、")}` : null;
}

/** The numbers on the first `**前提**:` line outside fences: all the schedule and the parallel guard read. */
export function declaredPrereqs(body: string): number[] {
  for (const line of unfenced(body)) if (line.startsWith("**前提**:")) return [...line.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  return [];
}

/** The numbers on the first `**前提**:` line (outside fences) that carry `（リリース）`: `#N（リリース）`. */
export function releasePrereqs(body: string): number[] {
  for (const line of unfenced(body)) if (line.startsWith("**前提**:")) return [...new Set([...line.matchAll(/#(\d+)\s*（リリース）/g)].map((m) => Number(m[1])))];
  return [];
}

/** The free-text phrasings after `#N` that name a predecessor, besides `前提: #N`. A fixed list, not configured. */
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

/** How a `## 判断待ち` says the work goes on: `recommended` = on with the recommended option, `wait` = stopped until the answer. */
export type AskProceed = "recommended" | "wait";

/** From this time on, a `## 判断待ち` that says 推奨で進める without the table's leave is a violation (older ones are read as `wait` and not reported: a comment cannot be edited). */
export const PROCEED_KIND_SINCE = "2026-11-18T00:00:00+09:00";

/** From this time on, a `## 判断待ち` comment without the 進め方 line is a violation; an older one is read as `wait`. */
export const PROCEED_LINE_SINCE = "2026-11-14T00:00:00+09:00";

/**
 * How the work goes on after a `## 判断待ち`, or null when it has no 進め方 line. `recommended` only when the line says
 * 推奨で進める AND the reversibility table lets a question of its kind go on (`proceedRefusal`: the kind named, listed as
 * compensable, no stop word in the question, and the question's `place` agreeing with the kind — without a place it
 * cannot be checked and is `wait`). A line that says 推奨で進める without that is `wait`: what its writer wrote
 * does not by itself let the work go on. Every reader (the lint, the app's questions, the counts) reads it here.
 */
export function askProceed(body: string, place: AskPlace | null = null): AskProceed | null {
  const line = proceedLine(body);
  if (!line) return null;
  return line.said === "recommended" && proceedRefusal(body, undefined, place) === null ? "recommended" : "wait";
}

async function fetchAll(gh: GhClient, owner: string, name: string, project: { owner: string; number: number } | null, sleep: (ms: number) => Promise<void>): Promise<Row[]> {
  const withProject = project !== null;
  const projectVars = project === null ? {} : { ...(project.owner === "@me" ? {} : { o: project.owner }), p: project.number };
  const rows: Row[] = [];
  let after: string | null = null;
  for (;;) {
    let page: any;
    for (let attempt = 1; ; attempt++) {
      // GraphQL fails now and then: up to 3 tries, no wait after the last; a limit, an outage or an auth failure is not
      // asked again (the client waits for GitHub's time)
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
    rows.push(...issues.nodes.map((n: Row & { comments?: { nodes?: Row["comments"] } }) => ({ ...n, comments: n.comments?.nodes ?? [] })));
    if (issues.pageInfo?.hasNextPage !== true) return rows;
    after = issues.pageInfo.endCursor;
  }
}

const TYPES = ["type:pbi", "type:task", "type:request"];

/**
 * The rows the query would answer, from the records the app stored: its open PBIs, Tasks and requests, the
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
    // a child kept in the app and not in GitHub's list yet counts, as the backlog's rows count it
    subIssues: { totalCount: i.subIssues.length + (i.waitingSubIssues?.length ?? 0) },
    comments: r.comments.filter((c) => c.issue === i.number),
    ...(withProject && {
      projectItems: { nodes: i.fields ? [{ project: { number: r.project.number }, fieldValues: { nodes: Object.entries(i.fields).map(([name, v]) => (typeof v === "number" ? { number: v, field: { name } } : { name: v ?? undefined, field: { name } })) } }] : [] },
    }),
  }));
}

/**
 * Check the open PBIs, Tasks and requests against the writing rules, reading every one of them with one paged query —
 * or, given `records`, from what the app stored, with the Project the app reads for the workspace.
 * `withProject: false` skips what needs the Project (Story Points there, Status) — for a gh without the project scope.
 * `knownFailures` is the repository's registry of failures tolerated until a date: each row's Issue must be an open PBI with a
 * Priority, or an open request with such a PBI (no extra API calls: an Issue not among the open rows is read as closed).
 * Without the Project (`withProject: false`) the Priority is not checked, only that the Issue and a PBI are open.
 */
export async function lint(gh: GhClient, cfg: OpsConfig, opts: { withProject?: boolean; sleep?: (ms: number) => Promise<void>; records?: StoredRecords; knownFailures?: KnownFailure[]; /** The names at the top of the linted repository's checkout (`repoTop`); absent = no checkout of it here, and a question's kind is not checked against its paths. */ top?: { name: string; dir: boolean }[] } = {}): Promise<{ violations: Violation[]; warnings: Violation[]; fetched: number }> {
  const withProject = opts.withProject ?? true;
  const project = !withProject ? null : opts.records ? opts.records.project : projectOf(cfg);
  const projectNumber = project?.number ?? 0;
  let rows: Row[];
  // where `（リリース）` on a number is checked against GitHub; null = a backlog kept in the app only (no GitHub behind it)
  let repoPath: string | null = null;
  if (opts.records) {
    rows = storedRows(opts.records, withProject);
    if (opts.records.service === "github") repoPath = opts.records.repository;
  } else {
    const repo = await repoOf(gh);
    repoPath = `${repo.owner}/${repo.name}`;
    rows = await fetchAll(gh, repo.owner, repo.name, project, opts.sleep ?? ((ms) => Bun.sleep(ms)));
  }
  const violations: Violation[] = [];
  const bad = (issue: number, message: string) => violations.push({ issue, message });
  // shown, but not counted: the exit stays what the violations make it
  const warnings: Violation[] = [];
  // a predecessor named only in free text: an open PBI or Task, not on the **前提**: line, and not the Issue's own
  // parent, child or sibling Task (the stack's order). A closed one is met and stops nothing
  const open = new Set(rows.filter((r) => labelsOf(r).some((l) => l === "type:pbi" || l === "type:task")).map((r) => r.number));
  const parentOf = new Map(rows.map((r) => [r.number, r.parent?.number ?? null]));
  const freePrereqs = (row: Row, body: string) => {
    const declared = declaredPrereqs(body);
    const parent = row.parent?.number ?? null;
    const own = (k: number) => k === row.number || k === parent || parentOf.get(k) === row.number || (parent !== null && parentOf.get(k) === parent);
    const named = freeTextPrereqs(body).filter((k) => open.has(k) && !declared.includes(k) && !own(k));
    if (named.length) warnings.push({ issue: row.number, message: freeTextPrereq(named) });
  };
  // `（リリース）` is for a PR's number: an Issue's number carries none (it is read as a pull request by the schedule)
  const released = new Map<number, number[]>();
  const noteReleased = (row: Row, body: string) => {
    for (const k of releasePrereqs(body)) released.set(k, [...(released.get(k) ?? []), row.number]);
  };
  const points = STORY_POINTS.join(" / ");
  const isPoint = (n: number) => STORY_POINTS.includes(n);

  const origin = cfg.sections.origin;
  // the marks of `fields.kernel` on a PBI's or a request's Project item: a value outside the choices is a violation; one
  // not set is not (the report counts it as not marked yet)
  type Item = NonNullable<Row["projectItems"]>["nodes"][number];
  const kernelMarks = (n: number, item: Item) => {
    for (const [field, options] of Object.entries(cfg.fields.kernel ?? {})) {
      const mark = item.fieldValues.nodes.find((v) => v.field?.name === field)?.name;
      if (mark && !options.includes(mark)) bad(n, `Project の ${field} が ${options.join(" / ")} 以外（${mark}）`);
    }
  };
  for (const row of rows.filter((r) => labelsOf(r).includes("type:pbi"))) {
    const n = row.number;
    const body = row.body.replace(/\r\n/g, "\n");
    for (const s of cfg.sections.pbi) if (sectionName(s) !== origin?.name && !hasSection(body, sectionName(s))) bad(n, missing("PBI ", s));
    if (!/^- \[[ x]\]/m.test(body)) bad(n, "PBI の受け入れ条件にチェックボックス行が無い");
    for (const message of postMergeProblems(body)) bad(n, message);
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
    else if (!isPoint(bodySp)) bad(n, `Story Points は ${points} のどれか（本文: ${bodySp}）`);
    freePrereqs(row, body);
    noteReleased(row, body);
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
    kernelMarks(n, item);
    const status = value("Status")?.name;
    if ((status === "Ready" || status === "In progress") && row.subIssues.totalCount === 0) bad(n, `Status=${status} なのに Task（sub-issue）が無い`);
  }

  for (const row of rows.filter((r) => labelsOf(r).includes("type:task"))) {
    const body = row.body.replace(/\r\n/g, "\n");
    for (const s of cfg.sections.task) if (!hasSection(body, sectionName(s))) bad(row.number, missing("Task ", s));
    if (!row.parent) bad(row.number, "Task に親 PBI（sub-issue の親）が付いていない");
    else if (!labelsOf(row.parent).includes("type:pbi")) bad(row.number, `Task の親 #${row.parent.number} が type:pbi ではない`);
    freePrereqs(row, body);
    noteReleased(row, body);
  }

  // the top of the linted repository: this checkout's when it is that repository's (`opts.top`), else what the app's records carry of the workspace's
  const top = opts.top?.length ? opts.top : (opts.records?.top ?? []);
  // where a question stands, for the check of its kind: its Issue, and its PBI's Tasks (the rows whose parent is that PBI)
  const placeOf = (row: Row): AskPlace => {
    const pbi = labelsOf(row).includes("type:pbi") ? row.number : row.parent && labelsOf(row.parent).includes("type:pbi") ? row.parent.number : null;
    return { issue: { number: row.number, body: row.body, labels: labelsOf(row) }, pbi: pbi === null ? null : { number: pbi, tasks: rows.filter((r) => r.parent?.number === pbi).map((r) => r.number) }, top };
  };
  for (const row of rows.filter((r) => labelsOf(r).some((l) => l === "type:pbi" || l === "type:task"))) {
    // the heading is `## 判断待ち` itself: another heading that starts with it (`## 判断待ちの取り下げ`) is not an ask
    const asks = row.comments.filter((c) => /^## 判断待ち(?:\s|$)/.test(c.body.trimStart()));
    // an ask re-posted with the line replaces the older ones without it (a comment cannot be edited)
    const lastWithLine = Math.max(-Infinity, ...asks.filter((c) => askProceed(c.body) !== null).map((c) => Date.parse(c.createdAt)));
    for (const c of asks) {
      // the newest ask says 推奨で進める and the table does not let its kind go on: the work must stop and ask
      const refusal = Date.parse(c.createdAt) >= Date.parse(PROCEED_KIND_SINCE) && Date.parse(c.createdAt) >= lastWithLine ? (top.length ? proceedRefusal(c.body, undefined, placeOf(row)) : tableRefusal(c.body)) : null;
      if (refusal) bad(row.number, `## 判断待ち（${c.createdAt}）は「推奨で進める」では進められない: ${refusal}。「**進め方**: 止めて待つ — 理由」で書き直してラベル needs-decision を付け、回答を待つ`);
      if (Date.parse(c.createdAt) < Date.parse(PROCEED_LINE_SINCE) || askProceed(c.body) !== null || Date.parse(c.createdAt) < lastWithLine) continue;
      bad(row.number, `## 判断待ち（${c.createdAt}）に「**進め方**: 推奨で進める（種類: <種類>） / 止めて待つ — 理由」の行が無い`);
    }
  }

  // one REST call per distinct number: no `pull_request` = an Issue; not found (404) is no violation
  if (repoPath !== null) {
    for (const [k, owners] of released) {
      let found: { pull_request?: unknown } | null;
      try {
        found = (await gh.api(`repos/${repoPath}/issues/${k}`)) as { pull_request?: unknown } | null;
      } catch (e) {
        if (/HTTP 404/.test((e as Error).message)) continue;
        throw new LintFetchError(`#${k} が Issue か PR かの取得に失敗: ${(e as Error).message.slice(0, 200)}`);
      }
      if (!found || found.pull_request) continue;
      for (const o of owners) bad(o, `**前提**: の #${k} は Issue なので（リリース）は付けられない。（リリース）は PR の番号にだけ付く。#${k} を閉じた PR の番号に直す`);
    }
  }

  for (const row of rows.filter((r) => labelsOf(r).includes("type:request"))) {
    const body = row.body.replace(/\r\n/g, "\n");
    for (const s of cfg.sections.request) if (!hasSection(body, sectionName(s))) bad(row.number, missing("要望", s));
    if (hasSection(body, "出典") && !speakerOf(body)) bad(row.number, SPEAKER_MISSING);
    const item = withProject ? row.projectItems?.nodes.find((i) => i.project.number === projectNumber) : undefined;
    if (item) kernelMarks(row.number, item);
  }

  for (const k of opts.knownFailures ?? []) {
    const at = `${KNOWN_FAILURES_FILE} の登録（${k.test}、期限 ${k.until}）`;
    const fix = `登録を消す PR を出すか、#${k.issue} に Priority の付いた PBI を用意する`;
    const target = rows.find((r) => r.number === k.issue);
    if (!target || !labelsOf(target).some((l) => l === "type:pbi" || l === "type:request")) {
      bad(k.issue, `${at}が指す #${k.issue} は open の要望・PBI に無い（閉じているか、要望・PBI でない）。${fix}`);
      continue;
    }
    // the PBIs a request leads to name it on the first line of their 元要望 section
    const derived = (r: Row) => {
      const lines = r.body.replace(/\r\n/g, "\n").split("\n");
      const start = lines.findIndex((l) => new RegExp(`^##+ *${escape(origin?.name ?? "元要望")}`).test(l));
      const first = start < 0 ? "" : (lines.slice(start + 1).find((l) => l.trim() !== "") ?? "");
      return [...first.matchAll(/#(\d+)(?!\d)/g)].some((m) => Number(m[1]) === k.issue);
    };
    const hasPriority = (r: Row) => !withProject || r.projectItems?.nodes.some((i) => i.project.number === projectNumber && i.fieldValues.nodes.some((v) => v.field?.name === "Priority" && !!v.name)) === true;
    const pbis = labelsOf(target).includes("type:pbi") ? [target] : rows.filter((r) => labelsOf(r).includes("type:pbi") && derived(r));
    if (!pbis.some(hasPriority)) bad(k.issue, `${at}が指す #${k.issue} に、Priority の付いた open の PBI が無い（${pbis.length === 0 ? "PBI が無いか、閉じている" : "Priority が未設定"}）。${fix}`);
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
