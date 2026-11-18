// A stand-in for the three GitHub answers an install from Releases reads (rescue/src/github-release.ts), for checks
// that must not reach GitHub: container/e2e-release.sh runs it as a service beside the container, and
// scripts/release-smoke.test.ts and its own test start it in the test process.
//   GET /repos/<owner>/<name>/releases/latest -> {tag_name}      the tag switched to last
//   GET /repos/<owner>/<name>/commits/<tag>   -> {sha}
//   GET /repos/<owner>/<name>/tarball/<tag>   -> the tag's tarball, with Content-Length
//   POST /e2e/latest {tag}                    -> switch what `latest` answers (404 for a tag it does not have)
// As a command: bun container/fake-releases.ts <port> <owner/name> <dir>, where <dir> holds one <tag>.tar.gz and one
// <tag>.sha (the 40-character commit) per release; `latest` starts at the lowest tag.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface FakeRelease { tag: string; sha: string; tarball: string }

const TAG = /^v\d+\.\d+\.\d+$/;
const byVersion = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** The releases in `dir`: every `<tag>.tar.gz` that has a `<tag>.sha` beside it, lowest version first. */
export function releasesIn(dir: string): FakeRelease[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith(".tar.gz") && TAG.test(n.slice(0, -7)) && existsSync(join(dir, `${n.slice(0, -7)}.sha`)))
    .map((n) => ({ tag: n.slice(0, -7), sha: readFileSync(join(dir, `${n.slice(0, -7)}.sha`), "utf8").trim(), tarball: join(dir, n) }))
    .sort((a, b) => byVersion(a.tag, b.tag));
}

/**
 * Serve `releases` as the Releases of `repo` (`owner/name`). `latest` is the first of them until `setLatest` (or the
 * POST) names another. `hostname` is 127.0.0.1 unless the caller is the service of the E2E, which other containers reach.
 */
export function startFakeReleases(o: { repo: string; releases: FakeRelease[]; port?: number; hostname?: string }) {
  if (!o.releases.length) throw new Error("fake-releases: no release to serve");
  const byTag = new Map(o.releases.map((r) => [r.tag, r]));
  let latest = o.releases[0]!.tag;
  const setLatest = (tag: string): boolean => {
    if (!byTag.has(tag)) return false;
    latest = tag;
    return true;
  };
  const prefix = `/repos/${o.repo}/`;
  const server = Bun.serve({
    port: o.port ?? 0,
    hostname: o.hostname ?? "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "POST" && path === "/e2e/latest") {
        const tag = ((await req.json().catch(() => null)) as { tag?: unknown } | null)?.tag;
        return typeof tag === "string" && setLatest(tag) ? Response.json({ latest }) : Response.json({ error: `no such release: ${String(tag)}` }, { status: 404 });
      }
      if (req.method !== "GET" || !path.startsWith(prefix)) return new Response("not found", { status: 404 });
      const [kind, tag, ...rest] = path.slice(prefix.length).split("/");
      if (kind === "releases" && tag === "latest" && !rest.length) return Response.json({ tag_name: latest });
      const release = rest.length ? undefined : byTag.get(tag ?? "");
      if (kind === "commits" && release) return Response.json({ sha: release.sha });
      if (kind === "tarball" && release) {
        const body = readFileSync(release.tarball);
        return new Response(body, { headers: { "content-type": "application/gzip", "content-length": String(body.length) } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, url: `http://${o.hostname ?? "127.0.0.1"}:${server.port}`, setLatest, latest: () => latest, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const [port, repo, dir] = process.argv.slice(2);
  if (!Number(port) || !repo || !dir) {
    console.error("usage: bun container/fake-releases.ts <port> <owner/name> <dir of <tag>.tar.gz and <tag>.sha>");
    process.exit(2);
  }
  const fake = startFakeReleases({ repo, releases: releasesIn(dir), port: Number(port), hostname: "0.0.0.0" });
  console.log(`fake releases of ${repo} on ${port}: latest ${fake.latest()}`);
}
