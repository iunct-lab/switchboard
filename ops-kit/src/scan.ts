import { GhError, type GhClient } from "./gh.ts";
import { findSecrets, NO_HOST, type HostAws } from "./secrets.ts";

export interface ScanHit {
  url: string;
  kind: string;
  line: number;
}

/** What could not be read; the scan then has no answer (never "nothing found"). */
export class ScanFetchError extends Error {
  constructor(message: string, readonly gone = false) {
    super(message);
  }
}

/** Issue and pull request bodies and titles, their comments, and the review comments of pull requests. */
const LISTS = ["issues?state=all", "issues/comments?", "pulls/comments?"];

/** Tries of one page before the scan has no answer; a page that GitHub answered once wrongly is not a gap (#775). */
const RETRIES = 3;
const RETRY_WAIT_MS = 2000;

async function fetchWithRetry(gh: GhClient, path: string, what: string, sleep: (ms: number) => Promise<void>): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await gh.api(path);
    } catch (e) {
      // a limit, an outage or an auth failure is not asked again (the client waits for GitHub's time, #894), nor what is not there
      const gone = /HTTP 404|HTTP 410/.test((e as Error).message);
      if (attempt >= RETRIES || gone || (e instanceof GhError && e.kind !== null)) throw new ScanFetchError(`${what} の取得に失敗（${attempt} 回）: ${(e as Error).message.slice(0, 200)}`, gone);
      await sleep(RETRY_WAIT_MS * attempt);
    }
  }
}

/**
 * The API path of one text from its html_url (`…/issues/<n>`, `…/pull/<n>`, and the fragments of a comment, a review
 * comment and a review), or null for a URL of another form.
 */
function apiOf(repo: string, url: string): string | null {
  const m = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)(?:#(issuecomment-|discussion_r|pullrequestreview-)(\d+))?$/.exec(url);
  if (!m || m[1] !== repo) return null;
  const [, , n, frag, id] = m;
  if (frag === "issuecomment-") return `repos/${repo}/issues/comments/${id}`;
  if (frag === "discussion_r") return `repos/${repo}/pulls/comments/${id}`;
  if (frag === "pullrequestreview-") return `repos/${repo}/pulls/${n}/reviews/${id}`;
  return `repos/${repo}/issues/${n}`;
}

/**
 * Every text of the repository that an agent or a person wrote on GitHub, checked with findSecrets (#661): the lists
 * above and the review bodies of every pull request. The answer names where and which kind, not the value, and how
 * many texts were read. With `since` (ISO 8601) only what was updated after it is read — the lists by GitHub's
 * `since`, the review bodies of the pull requests updated since then (a review updates its pull request) — and
 * `recheck` (the places of earlier hits) is read again one by one, so a hit outside the difference stays until it is
 * gone; one deleted (404, or 410 for an Issue) is gone.
 */
export async function scanIssues(gh: GhClient, repo: string, sleep: (ms: number) => Promise<void> = Bun.sleep, host: HostAws = NO_HOST, opts: { since?: string; recheck?: readonly string[] } = {}): Promise<{ hits: ScanHit[]; scanned: number }> {
  const hits: ScanHit[] = [];
  let scanned = 0;
  const pulls: number[] = [];
  const seen = new Set<string>();
  const check = (url: string, title: unknown, body: unknown) => {
    scanned++;
    const text = `${typeof title === "string" ? title : ""}\n${typeof body === "string" ? body : ""}`;
    // line 1 is the title (empty for a comment), the body starts at line 2: report the line within the body
    for (const h of findSecrets(text, host)) hits.push({ url, kind: h.kind, line: Math.max(1, h.line - 1) });
  };
  const since = opts.since === undefined ? "" : `since=${encodeURIComponent(opts.since)}&`;
  const read = async (list: string, onRow?: (r: { number?: unknown; pull_request?: unknown }) => void) => {
    const what = list.split("?")[0]!;
    for (let page = 1; ; page++) {
      const rows = await fetchWithRetry(gh, `repos/${repo}/${list}&per_page=100&page=${page}`.replace("?&", "?"), what, sleep);
      if (!Array.isArray(rows)) throw new ScanFetchError(`${what} の取得結果の形が想定と違う`);
      for (const r of rows as Array<{ html_url?: unknown; title?: unknown; body?: unknown; number?: unknown; pull_request?: unknown }>) {
        if (typeof r?.html_url !== "string") throw new ScanFetchError(`${what} の取得結果の形が想定と違う（html_url が無い）`);
        onRow?.(r);
        seen.add(r.html_url);
        // a review without a body (an approval alone) is no text
        if (list.includes("/reviews?") && !(typeof r.body === "string" && r.body !== "")) continue;
        check(r.html_url, r.title, r.body);
      }
      if (rows.length < 100) break;
    }
  };
  for (const list of LISTS) {
    const at = since ? list.replace("?", `?${since}`).replace(/&$/, "") : list;
    await read(at, list === LISTS[0] ? (r) => void (r.pull_request && typeof r.number === "number" && pulls.push(r.number)) : undefined);
  }
  for (const n of pulls) await read(`pulls/${n}/reviews?`);
  for (const url of new Set(opts.recheck ?? [])) {
    if (seen.has(url)) continue;
    const path = apiOf(repo, url);
    if (!path) throw new ScanFetchError(`読み直す場所の形が想定と違う: ${url.slice(0, 200)}`);
    let r: { title?: unknown; body?: unknown };
    try {
      r = (await fetchWithRetry(gh, path, "recheck", sleep)) as typeof r;
    } catch (e) {
      // deleted since: nothing left to find
      if (e instanceof ScanFetchError && e.gone) continue;
      throw e;
    }
    check(url, r?.title, r?.body);
  }
  return { hits, scanned };
}
