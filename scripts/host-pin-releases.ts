/**
 * The pinned tools' releases with the day each was published, and the newest one that has aged long enough. Read-only:
 * nothing here changes a file. `latestOf` in host-pins.ts (the daily check, against the distributor's latest) is left as
 * it is; only the side that makes a pull request waits.
 */
import { compareRpm, newest } from "./host-updates.ts";
import type { FetchText, Pin } from "./host-pins.ts";

export interface Release {
  version: string;
  /** ISO 8601 */
  published: string;
  security?: boolean;
}

export const MIN_AGE_DAYS = 7;
export const SECURITY_MIN_AGE_DAYS = 2;

const PLAIN = /^\d+(\.\d+)+$/;
const plain = (v: string) => v.replace(/^v/, "");
const DAY_MS = 86_400_000;

function asIso(value: unknown, what: string): string {
  const t = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(t)) throw new Error(`${what}: 公開日が読めない`);
  return new Date(t).toISOString();
}

function nonEmpty(releases: Release[], what: string): Release[] {
  if (releases.length === 0) throw new Error(`${what}: 版が 1 つも無い`);
  return releases;
}

/** Every release of the pin's tool with its publish date. Throws when the distributor cannot be read or shows none: the caller says "cannot tell". */
export async function releasesOf(pin: Pin, fetchText: FetchText): Promise<Release[]> {
  const { source } = pin;
  if (source.kind === "node") {
    const major = pin.pinned.split(".")[0];
    const rows = JSON.parse(await fetchText("https://nodejs.org/dist/index.json")) as { version: string; date: unknown; lts: unknown; security?: boolean }[];
    return nonEmpty(
      rows
        .filter((r) => r.lts && plain(r.version).split(".")[0] === major)
        // index.json gives the day only; read it as the end of that day so a release never counts as older than it is
        .map((r) => ({
          version: plain(r.version),
          published: asIso(typeof r.date === "string" ? `${r.date}T23:59:59.999Z` : r.date, `node ${r.version}`),
          ...(r.security === true && { security: true }),
        })),
      "node",
    );
  }
  if (source.kind === "docker") {
    const page = await fetchText("https://download.docker.com/linux/static/stable/aarch64/");
    const out: Release[] = [];
    // the listing's time is UTC without a zone
    for (const m of page.matchAll(/href="docker-(\d+(?:\.\d+)+)\.tgz"[^\n]*?(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/g)) {
      out.push({ version: m[1]!, published: asIso(`${m[2]}T${m[3]}Z`, `docker ${m[1]}`) });
    }
    const rows = page.match(/href="docker-\d+(?:\.\d+)+\.tgz"/g)?.length ?? 0;
    if (rows !== out.length) throw new Error(`docker: 日時が読めない行がある（${rows - out.length} 行）`);
    return nonEmpty(out, "docker");
  }
  if (source.kind === "npm") {
    const { time, versions } = JSON.parse(await fetchText(`https://registry.npmjs.org/${source.pkg}`)) as {
      time?: Record<string, unknown>;
      versions?: Record<string, unknown>;
    };
    if (!time || typeof time !== "object") throw new Error(`${source.pkg}: time が読めない`);
    if (!versions || typeof versions !== "object") throw new Error(`${source.pkg}: versions が読めない`);
    return nonEmpty(
      Object.entries(time)
        // npm keeps the time of an unpublished version; only versions still in the registry count
        .filter(([v]) => PLAIN.test(v) && Object.hasOwn(versions, v))
        .map(([version, at]) => ({ version, published: asIso(at, `${source.pkg} ${version}`) })),
      source.pkg,
    );
  }
  const rows = JSON.parse(await fetchText(`https://api.github.com/repos/${source.repo}/releases?per_page=20`)) as {
    tag_name?: unknown;
    published_at?: unknown;
    draft?: unknown;
    prerelease?: unknown;
  }[];
  if (!Array.isArray(rows)) throw new Error(`${source.repo}: 版の一覧が読めない`);
  return nonEmpty(
    rows
      .filter((r) => r.draft !== true && r.prerelease !== true && typeof r.tag_name === "string" && PLAIN.test(plain(r.tag_name)))
      .map((r) => ({ version: plain(r.tag_name as string), published: asIso(r.published_at, `${source.repo} ${r.tag_name}`) })),
    source.repo,
  );
}

/** The newest release newer than `pinned` that has been out for its period (`securityMinAgeDays` for a security release, `minAgeDays` for the rest); null when none. */
export function pickAged(
  releases: Release[],
  pinned: string,
  now: Date,
  opts: { minAgeDays?: number; securityMinAgeDays?: number } = {},
): Release | null {
  const minAge = opts.minAgeDays ?? MIN_AGE_DAYS;
  const securityMinAge = opts.securityMinAgeDays ?? SECURITY_MIN_AGE_DAYS;
  const aged = releases.filter(
    (r) => compareRpm(r.version, pinned) > 0 && now.getTime() - Date.parse(r.published) >= (r.security ? securityMinAge : minAge) * DAY_MS,
  );
  const best = newest(aged.map((r) => r.version));
  return aged.find((r) => r.version === best) ?? null;
}
