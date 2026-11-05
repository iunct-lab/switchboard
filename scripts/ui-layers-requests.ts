/**
 * bun scripts/ui-layers-requests.ts --findings <file> — files the monthly floor / ceiling / walls check's findings (what got
 * worse since the last run, and new problems) as request Issues (`request-to-backlog`'s 要望 Issue): at most
 * MAX_REQUESTS a run, in the order given, none whose title an open request already has (an exact match of
 * `要望: <title>`; no body search). `--findings` is a JSON file: `[{"key","title","detail","source"}]`, `source` being
 * `定期の検査` (a measure the scripts counted) or `エージェント` (what the Task read). Creates through `ops-kit backlog`
 * (inside the app's Task; the app puts the Issue in the Project). Prints `{"created":[…],"duplicates":n,"overLimit":n}`.
 */
import { readFileSync } from "node:fs";

export interface Finding {
  key: string;
  title: string;
  detail: string;
  source: "定期の検査" | "エージェント";
}

export const MAX_REQUESTS = 3;
const SOURCES: readonly string[] = ["定期の検査", "エージェント"];

const titleOf = (f: Finding): string => `要望: ${f.title}`;

/** The findings whose request title no open request, nor an earlier finding, has; in order. */
function unfiled(findings: Finding[], openTitles: string[]): Finding[] {
  const seen = new Set(openTitles);
  return findings.filter((f) => !seen.has(titleOf(f)) && !!seen.add(titleOf(f)));
}

/** The findings to file: the unfiled ones, in order, MAX_REQUESTS at most. */
export const pickToFile = (findings: Finding[], openTitles: string[]): Finding[] => unfiled(findings, openTitles).slice(0, MAX_REQUESTS);

export function requestBody(f: Finding, date: string): string {
  // a fence longer than any backtick run in the text (4 at least, request-to-backlog)
  const fence = "`".repeat(Math.max(4, ...[...f.detail.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `## 要望

${fence}text
${f.detail}
${fence}

## 出典
- 誰の言葉: ${f.source}
- いつ: ${date}
- 経路: 床・天井・壁の月次の点検（所見 ${f.key}）

## 添付
なし

## 派生 PBI
（PBI を作ったら追記）
`;
}

export interface RequestDeps {
  listOpenRequestTitles(): Promise<string[]>;
  /** Creates the request Issue and answers how it is named (`#123`, or the app's localId before GitHub numbers it). */
  create(title: string, body: string): Promise<string>;
}

export async function fileRequests(findings: Finding[], deps: RequestDeps, date: string): Promise<{ created: string[]; duplicates: number; overLimit: number }> {
  const bad = findings.find((f) => !SOURCES.includes(f.source));
  if (bad) throw new Error(`source は ${SOURCES.join(" か ")}: ${JSON.stringify(bad.source)}（所見 ${bad.key}）`);
  const openTitles = await deps.listOpenRequestTitles();
  const fresh = unfiled(findings, openTitles);
  const picked = fresh.slice(0, MAX_REQUESTS);
  const created: string[] = [];
  for (const f of picked) created.push(await deps.create(titleOf(f), requestBody(f, date)));
  return { created, duplicates: findings.length - fresh.length, overLimit: fresh.length - picked.length };
}

async function opsKit(args: string[], stdin?: string): Promise<string> {
  const p = Bun.spawn(["ops-kit", "backlog", ...args], { stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "inherit" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) throw new Error(`ops-kit backlog ${args[0]} が失敗しました`);
  return out;
}

/** How `ops-kit backlog create`'s line names the Issue: `#123`, or `localId <id>` before GitHub numbers it. */
export const createdRef = (out: string): string => out.match(/#\d+/)?.[0] ?? out.match(/localId [^\s。、（）()]+/)?.[0] ?? out.trim();

export const opsKitDeps: RequestDeps = {
  async listOpenRequestTitles() {
    const r = JSON.parse(await opsKit(["list", "--label", "type:request", "--state", "open", "--json"])) as { items: Array<{ title: string }> };
    return r.items.map((i) => i.title);
  },
  async create(title, body) {
    const out = await opsKit(["create", "--title", title, "--label", "type:request", "--field", "Status=Backlog", "--body-file", "-"], body);
    return createdRef(out);
  },
};

if (import.meta.main) {
  const i = process.argv.indexOf("--findings");
  const file = i < 0 ? undefined : process.argv[i + 1];
  if (!file) {
    console.error("usage: bun scripts/ui-layers-requests.ts --findings <file>");
    process.exit(2);
  }
  const findings = JSON.parse(readFileSync(file, "utf8")) as Finding[];
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  console.log(JSON.stringify(await fileRequests(findings, opsKitDeps, date)));
}
