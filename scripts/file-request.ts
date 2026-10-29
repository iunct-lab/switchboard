import { currentRepo } from "./repo.ts";
/**
 * Files a request Issue (type:request) from a scheduled check, unless an open request has the same title — the check
 * builds the same title for the same finding (check-models, merge-audit). Through scripts/setup/request_issue.sh.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRecords } from "../ops-kit/src/backlog-client.ts";

/** An open request: `ref` is `#N`, or the localId of one stored in the app that GitHub has not numbered yet. */
export type OpenRequest = { ref: string; title: string };

/** The ref of the open request with this title, or null. */
export function alreadyFiled(title: string, open: OpenRequest[]): string | null {
  return open.find((i) => i.title === title)?.ref ?? null;
}

type Exec = (cmd: string[]) => Promise<{ out: string; code: number }>;

async function run(cmd: string[]): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { out, code };
}

export interface FileDeps {
  env: Record<string, string | undefined>;
  exec: Exec;
  /** The app's stored records (`GET /api/backlog/records`), read after `backlog list --fresh` has synced. */
  records: (env: Record<string, string | undefined>) => Promise<{ issues: Array<{ number: number; title: string; state: string; labels: string[] }> }>;
}

const CLI = join(import.meta.dir, "..", "ops-kit", "src", "cli.ts");

const DEPS: FileDeps = { env: process.env, exec: run, records: (env) => readRecords(env, { fresh: false }) };

/**
 * The open requests. In the app's Task (BACKLOG_URL) they are what the app stores — an Issue `ops-kit request` made is
 * stored there and reaches GitHub later, or never (a backlog kept in the app) — : the stored open type:request Issues,
 * and the open creates GitHub has not numbered yet (they carry no labels: any type, compared by title). When the app does
 * not answer nothing is filed: falling back to GitHub would make two sources for one judgement. Outside, GitHub's REST.
 */
export async function openRequests(deps: FileDeps = DEPS): Promise<OpenRequest[]> {
  if (deps.env.BACKLOG_URL) {
    const listed = await deps.exec(["bun", CLI, "backlog", "list", "--fresh", "--json"]);
    if (listed.code !== 0) throw new Error(`アプリから開いている要望を読めなかった（ops-kit backlog list exit ${listed.code}）。判定できないので起票しない`);
    const ws = JSON.parse(listed.out) as { creates?: Array<{ localId: string; title: string }> };
    const stored = await deps.records(deps.env).catch((e: Error) => {
      throw new Error(`アプリから開いている要望を読めなかった（${e.message}）。判定できないので起票しない`);
    });
    // a create stays in `creates` after it is closed here (the close waits for its number): read its state as shown
    const creates: OpenRequest[] = [];
    for (const c of ws.creates ?? []) {
      const viewed = await deps.exec(["bun", CLI, "backlog", "view", c.localId, "--json"]);
      if (viewed.code !== 0) throw new Error(`アプリから ${c.localId} を読めなかった（ops-kit backlog view exit ${viewed.code}）。判定できないので起票しない`);
      if ((JSON.parse(viewed.out) as { issue: { state: string } }).issue.state === "OPEN") creates.push({ ref: c.localId, title: c.title });
    }
    return [...stored.issues.filter((i) => i.state === "OPEN" && i.labels.includes("type:request")).map((i) => ({ ref: `#${i.number}`, title: i.title })), ...creates];
  }
  // REST, not GraphQL: the GraphQL budget is shared with the Project tools (--paginate prints one array per page).
  const listed = await deps.exec(["gh", "api", "-X", "GET", `repos/${currentRepo()}/issues`, "-f", "state=open", "-f", "labels=type:request", "-f", "per_page=100", "--paginate", "--jq", ".[] | {number, title}"]);
  if (listed.code !== 0) throw new Error(`開いている要望を読めなかった（gh api exit ${listed.code}）`);
  return listed.out.split("\n").filter(Boolean).map((l) => {
    const i = JSON.parse(l) as { number: number; title: string };
    return { ref: `#${i.number}`, title: i.title };
  });
}

/** What filing did (#1272): the new Issue's number (null when request_issue.sh printed none), or the open request with the same title (`#N` or a localId). */
export type Filed = { filed: number | null } | { open: string };

/** The number in request_issue.sh's `要望を作成: #N` line, or null. */
export function filedNumber(out: string): number | null {
  const m = /要望を作成: #(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

export async function fileRequest(req: { title: string; body: string }, deps: FileDeps = DEPS): Promise<Filed> {
  const existing = alreadyFiled(req.title, await openRequests(deps));
  if (existing !== null) return { open: existing }; // the caller says so (its own wording; #1272)
  const dir = mkdtempSync(join(tmpdir(), "switchboard.file-request."));
  try {
    writeFileSync(join(dir, "body.md"), req.body);
    const filed = await deps.exec(["bash", join(import.meta.dir, "setup", "request_issue.sh"), req.title, join(dir, "body.md")]);
    process.stdout.write(filed.out);
    // It can fail after the Issue exists (setting the Project Status): its output above then names the Issue.
    if (filed.code !== 0) throw new Error(`request_issue.sh exit ${filed.code}。上に「要望を作成: #N」があれば Issue はできている`);
    return { filed: filedNumber(filed.out) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
