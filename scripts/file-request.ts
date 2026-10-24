import { currentRepo } from "./repo.ts";
/**
 * Files a request Issue (type:request) from a scheduled check, unless an open request has the same title — the check
 * builds the same title for the same finding (check-models, merge-audit). Through scripts/setup/request_issue.sh.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The number of the open request with this title, or null. */
export function alreadyFiled(title: string, open: { number: number; title: string }[]): number | null {
  return open.find((i) => i.title === title)?.number ?? null;
}

async function run(cmd: string[]): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { out, code };
}

/** What filing did (#1272): the new Issue's number (null when request_issue.sh printed none), or the open request with the same title. */
export type Filed = { filed: number | null } | { open: number };

/** The number in request_issue.sh's `要望を作成: #N` line, or null. */
export function filedNumber(out: string): number | null {
  const m = /要望を作成: #(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

export async function fileRequest(req: { title: string; body: string }): Promise<Filed> {
  // REST, not GraphQL: the GraphQL budget is shared with the Project tools (--paginate prints one array per page).
  const listed = await run(["gh", "api", "-X", "GET", `repos/${currentRepo()}/issues`, "-f", "state=open", "-f", "labels=type:request", "-f", "per_page=100", "--paginate", "--jq", ".[] | {number, title}"]);
  if (listed.code !== 0) throw new Error(`開いている要望を読めなかった（gh api exit ${listed.code}）`);
  const open = listed.out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { number: number; title: string });
  const existing = alreadyFiled(req.title, open);
  if (existing !== null) return { open: existing }; // the caller says so (its own wording; #1272)
  const dir = mkdtempSync(join(tmpdir(), "switchboard.file-request."));
  try {
    writeFileSync(join(dir, "body.md"), req.body);
    const filed = await run(["bash", join(import.meta.dir, "setup", "request_issue.sh"), req.title, join(dir, "body.md")]);
    process.stdout.write(filed.out);
    // It can fail after the Issue exists (setting the Project Status): its output above then names the Issue.
    if (filed.code !== 0) throw new Error(`request_issue.sh exit ${filed.code}。上に「要望を作成: #N」があれば Issue はできている`);
    return { filed: filedNumber(filed.out) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
