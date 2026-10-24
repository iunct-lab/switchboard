import { GhError, type GhClient } from "./gh.ts";
import { findSecrets, NO_HOST, type HostAws } from "./secrets.ts";

export interface ScanHit {
  url: string;
  kind: string;
  line: number;
}

/** What could not be read; the scan then has no answer (never "nothing found"). */
export class ScanFetchError extends Error {}

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
      // a limit, an outage or an auth failure is not asked again (the client waits for GitHub's time, #894)
      if (attempt >= RETRIES || (e instanceof GhError && e.kind !== null)) throw new ScanFetchError(`${what} の取得に失敗（${attempt} 回）: ${(e as Error).message.slice(0, 200)}`);
      await sleep(RETRY_WAIT_MS * attempt);
    }
  }
}

/**
 * Every text of the repository that an agent or a person wrote on GitHub, checked with findSecrets (#661): the lists
 * above and the review bodies of every pull request. The answer names where and which kind, not the value, and how
 * many texts were read.
 */
export async function scanIssues(gh: GhClient, repo: string, sleep: (ms: number) => Promise<void> = Bun.sleep, host: HostAws = NO_HOST): Promise<{ hits: ScanHit[]; scanned: number }> {
  const hits: ScanHit[] = [];
  let scanned = 0;
  const pulls: number[] = [];
  const read = async (list: string, onRow?: (r: { number?: unknown; pull_request?: unknown }) => void) => {
    const what = list.split("?")[0]!;
    for (let page = 1; ; page++) {
      const rows = await fetchWithRetry(gh, `repos/${repo}/${list}&per_page=100&page=${page}`.replace("?&", "?"), what, sleep);
      if (!Array.isArray(rows)) throw new ScanFetchError(`${what} の取得結果の形が想定と違う`);
      for (const r of rows as Array<{ html_url?: unknown; title?: unknown; body?: unknown; number?: unknown; pull_request?: unknown }>) {
        if (typeof r?.html_url !== "string") throw new ScanFetchError(`${what} の取得結果の形が想定と違う（html_url が無い）`);
        onRow?.(r);
        // a review without a body (an approval alone) is no text
        if (list.includes("/reviews?") && !(typeof r.body === "string" && r.body !== "")) continue;
        scanned++;
        const text = `${typeof r.title === "string" ? r.title : ""}\n${typeof r.body === "string" ? r.body : ""}`;
        // line 1 is the title (empty for a comment), the body starts at line 2: report the line within the body
        for (const h of findSecrets(text, host)) hits.push({ url: r.html_url, kind: h.kind, line: Math.max(1, h.line - 1) });
      }
      if (rows.length < 100) break;
    }
  };
  for (const list of LISTS) {
    await read(list, list === LISTS[0] ? (r) => void (r.pull_request && typeof r.number === "number" && pulls.push(r.number)) : undefined);
  }
  for (const n of pulls) await read(`pulls/${n}/reviews?`);
  return { hits, scanned };
}
