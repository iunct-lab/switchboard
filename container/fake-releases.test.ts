// test-reads: container/fake-releases.ts rescue/src/github-release.ts rescue/src/releases.ts
/**
 * The fake Releases API answers what the install reads, in the shape it checks: the real client
 * (rescue/src/github-release.ts) resolves the latest tag, downloads its tarball and unpacks it against the commit.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTarball, fetchTarball, latestRelease } from "../rescue/src/github-release.ts";
import { releasesIn, startFakeReleases } from "./fake-releases.ts";

const root = mkdtempSync(join(tmpdir(), "sb-fake-releases-"));
const dir = join(root, "releases");
const shaOf = { "v0.1.0": "a".repeat(40), "v0.2.0": "b".repeat(40), "v0.10.0": "c".repeat(40) } as Record<string, string>;
let fake: ReturnType<typeof startFakeReleases>;
const was = process.env.SWITCHBOARD_GITHUB_API;

beforeAll(() => {
  mkdirSync(dir, { recursive: true });
  for (const [tag, sha] of Object.entries(shaOf)) {
    const top = `o-n-${sha.slice(0, 7)}`;
    mkdirSync(join(root, tag, top), { recursive: true });
    writeFileSync(join(root, tag, top, "VERSION"), tag);
    const tar = Bun.spawnSync(["tar", "-czf", join(dir, `${tag}.tar.gz`), "-C", join(root, tag), top]);
    if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
    writeFileSync(join(dir, `${tag}.sha`), sha + "\n");
  }
  writeFileSync(join(dir, "v9.9.9.tar.gz"), "no sha beside it: not a release");
  fake = startFakeReleases({ repo: "o/n", releases: releasesIn(dir) });
  process.env.SWITCHBOARD_GITHUB_API = fake.url;
});
afterAll(() => {
  fake.stop();
  if (was === undefined) delete process.env.SWITCHBOARD_GITHUB_API;
  else process.env.SWITCHBOARD_GITHUB_API = was;
  rmSync(root, { recursive: true, force: true });
});

test("releasesIn lists the tarballs that have a sha, lowest version first (by number, not by letter)", () => {
  expect(releasesIn(dir).map((r) => [r.tag, r.sha])).toEqual([["v0.1.0", shaOf["v0.1.0"]], ["v0.2.0", shaOf["v0.2.0"]], ["v0.10.0", shaOf["v0.10.0"]]]);
});

test("the install's own client reads latest, the tag's commit and a tarball that unpacks as that commit's tree", async () => {
  expect(await latestRelease("o/n")).toEqual({ tag: "v0.1.0", sha: shaOf["v0.1.0"]! });
  const tarball = await fetchTarball("o/n", "v0.1.0", join(root, "dl"));
  await extractTarball(tarball, join(root, "tree"), { tag: "v0.1.0", sha: shaOf["v0.1.0"]! });
  expect(readFileSync(join(root, "tree", "VERSION"), "utf8")).toBe("v0.1.0");
});

test("latest is switched by the POST and by setLatest; an unknown tag changes nothing", async () => {
  const post = (tag: unknown) => fetch(`${fake.url}/e2e/latest`, { method: "POST", body: JSON.stringify({ tag }) });
  expect((await post("v0.2.0")).status).toBe(200);
  expect(await latestRelease("o/n")).toEqual({ tag: "v0.2.0", sha: shaOf["v0.2.0"]! });
  expect((await post("v7.0.0")).status).toBe(404);
  expect((await post(undefined)).status).toBe(404);
  expect(fake.latest()).toBe("v0.2.0");
  expect(fake.setLatest("v0.10.0")).toBe(true);
  expect(await latestRelease("o/n")).toEqual({ tag: "v0.10.0", sha: shaOf["v0.10.0"]! });
  expect(fake.setLatest("v0.1.0")).toBe(true);
});

test("another repository, an unknown tag and a longer path are 404", async () => {
  for (const path of ["/repos/o/other/releases/latest", "/repos/o/n/commits/v7.0.0", "/repos/o/n/tarball/v7.0.0", "/repos/o/n/tarball/v0.1.0/x", "/repos/o/n/releases/latest/x", "/"]) {
    expect({ path, status: (await fetch(fake.url + path)).status }).toEqual({ path, status: 404 });
  }
  const tarball = await fetch(`${fake.url}/repos/o/n/tarball/v0.2.0`);
  expect(Number(tarball.headers.get("content-length"))).toBe((await tarball.arrayBuffer()).byteLength);
});
