import { repoOf, type GhClient } from "./gh.ts";
import { withBodyFile, type DepsCheckDeps, type Exec, type OpenPr } from "./deps-check.ts";

/** Runs a command of this kit (`backlog …`, `request …`) in process and gives its exit code and what it printed. */
export type KitRun = (argv: string[]) => Promise<{ code: number; out: string }>;

export const spawnExec: Exec = async (cmd, opts) => {
  const stderr = opts?.stderr ?? "inherit";
  const p = Bun.spawn(cmd, { cwd: opts?.cwd, stdin: opts?.stdin === undefined ? "ignore" : new Blob([opts.stdin]), stdout: "pipe", stderr: stderr === "merge" ? "pipe" : stderr });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), stderr === "merge" ? new Response(p.stderr as ReadableStream).text() : "", p.exited]);
  return { out: out + err, code };
};

/** Every page of a REST list (100 a page, until a short page); a list that is not an array throws. */
export async function allPages<T>(gh: GhClient, path: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const got = await gh.api(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    if (!Array.isArray(got)) throw new Error(`${path} の応答が一覧でない`);
    all.push(...(got as T[]));
    if (got.length < 100) return all;
  }
}

const LOCKED = /(^|\/)(bun\.lock|package\.json|uv\.lock|pyproject\.toml)$/;

/**
 * The open PRs that change `bun.lock` / `package.json` / `uv.lock` / `pyproject.toml`, with the changed lines of those files (REST: the GraphQL budget
 * is shared with the Project tools). Null when GitHub cannot be read; a file whose patch GitHub left out (too large) is in `unread`.
 */
export async function openLockPrs(gh: GhClient, env: Record<string, string | undefined>, cwd: string): Promise<OpenPr[] | null> {
  try {
    const repo = await repoOf(gh, env, cwd);
    const base = `repos/${repo.owner}/${repo.name}`;
    const pulls = await allPages<{ number: number }>(gh, `${base}/pulls?state=open`);
    const prs: OpenPr[] = [];
    for (const p of pulls) {
      const files = await allPages<{ filename: string; patch?: string }>(gh, `${base}/pulls/${p.number}/files`);
      const changed = files.filter((f) => LOCKED.test(f.filename));
      // GitHub leaves the patch out of a large diff (a lockfile often is): that file is named, the others are still read
      const unread = changed.filter((f) => f.patch === undefined).map((f) => f.filename);
      const read = changed.filter((f) => f.patch !== undefined).map((f) => ({ path: f.filename, patch: f.patch! }));
      if (changed.length) prs.push({ number: p.number, files: read, ...(unread.length ? { unread } : {}) });
    }
    return prs;
  } catch {
    return null;
  }
}

/**
 * The open requests through `backlog list` (the app's stored values in a Task, GitHub outside): the open `type:request`
 * Issues, and in a Task the creates the app has not numbered yet (no labels: any type, compared by title; one closed
 * here stays among them, so its state is read).
 */
export async function openRequestsOf(kit: KitRun): Promise<Array<{ ref: string; title: string }>> {
  const listed = await kit(["backlog", "list", "--fresh", "--json", "--label", "type:request"]);
  if (listed.code !== 0) throw new Error(`開いている要望を読めなかった（backlog list exit ${listed.code}）。判定できないので起票しない`);
  const json = JSON.parse(listed.out) as { items: Array<{ number: number; title: string }>; creates?: Array<{ localId: string; title: string }> };
  const found = json.items.map((i) => ({ ref: `#${i.number}`, title: i.title }));
  for (const c of json.creates ?? []) {
    const viewed = await kit(["backlog", "view", c.localId, "--json"]);
    if (viewed.code !== 0) throw new Error(`${c.localId} を読めなかった（backlog view exit ${viewed.code}）。判定できないので起票しない`);
    if ((JSON.parse(viewed.out) as { issue: { state: string } }).issue.state === "OPEN") found.push({ ref: c.localId, title: c.title });
  }
  return found;
}

export function realDepsCheckDeps(gh: GhClient, env: Record<string, string | undefined>, kit: KitRun, io: Pick<DepsCheckDeps, "out" | "err">, cwd = process.cwd()): DepsCheckDeps {
  return {
    exec: spawnExec,
    fetchJson: async (url) => {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        return r.ok ? ((await r.json()) as unknown) : null;
      } catch {
        return null;
      }
    },
    now: () => new Date(),
    cwd,
    openPrs: () => openLockPrs(gh, env, cwd),
    openRequests: () => openRequestsOf(kit),
    fileRequest: (title, body) =>
      withBodyFile(body, async (file) => {
        const r = await kit(["request", title, file]);
        if (r.code !== 0) throw new Error(`request が exit ${r.code} で終わった。${r.out.trim()}`);
        return /要望を作成: (#\d+)/.exec(r.out)?.[1] ?? null;
      }),
    comment: (ref, body) =>
      withBodyFile(body, async (file) => {
        const r = await kit(["backlog", "comment", ref.replace(/^#/, ""), "--body-file", file]);
        if (r.code !== 0) throw new Error(`${ref} にコメントできなかった（backlog comment exit ${r.code}）`);
      }),
    ...io,
  };
}
