// test-reads: none
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTarball, fetchTarball, latestRelease, shaOfTag } from "./github-release.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHORT = SHA.slice(0, 7);
const work = mkdtempSync(join(tmpdir(), "switchboard.ghrelease."));

/** Pack `files` under a top directory named like GitHub's (`owner-name-<short sha>`), the way `/tarball/<tag>` does. */
function pack(name: string, files: Record<string, string>, top = `o-n-${SHORT}`): Buffer {
  const src = join(work, `src-${name}`);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(src, top, path, ".."), { recursive: true });
    writeFileSync(join(src, top, path), body);
  }
  const out = join(work, `${name}.tgz`);
  Bun.spawnSync(["tar", "-czf", out, "-C", src, top]);
  return Buffer.from(readFileSync(out));
}

const good = pack("good", { "package.json": JSON.stringify({ version: "1.2.3" }), "a.txt": "a" });
let mode = "ok";
let big: Buffer;
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  big = Buffer.alloc(4096, 1);
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/repos/o/n/releases/latest") return Response.json({ tag_name: mode === "badtag" ? "latest" : "v1.2.3" });
      if (pathname === "/repos/o/n/commits/v1.2.3") return Response.json({ sha: mode === "badsha" ? "abc" : SHA });
      if (pathname === "/repos/o/n/tarball/v1.2.3") {
        if (mode === "plain-http") return new Response(null, { status: 302, headers: { location: "http://codeload.github.com/o/n/legacy.tar.gz/v1.2.3" } });
        const to = mode === "other-repo" ? "/evil/n/legacy.tar.gz/v1.2.3" : "/o/n/legacy.tar.gz/v1.2.3";
        return new Response(null, { status: 302, headers: { location: to } });
      }
      if (pathname.endsWith("/legacy.tar.gz/v1.2.3")) {
        if (mode === "stray") return new Response(readFileSync(join(work, "stray.tgz")));
        if (mode === "link") return new Response(readFileSync(join(work, "link.tgz")));
        if (mode === "made") return new Response(pack("made", { "a.txt": "a", "packages/core/dist/index.js": "x" }));
        if (mode === "dotdot") return new Response(readFileSync(join(work, "dotdot.tgz")));
        if (mode === "other-sha") return new Response(pack("sha", { "package.json": JSON.stringify({ version: "1.2.3" }) }, "o-n-fffffff"));
        if (mode === "large") return new Response(big);
        if (mode === "notgz") return new Response("not a tarball");
        return new Response(good);
      }
      return new Response("no", { status: 404 });
    },
  });
  process.env.SWITCHBOARD_GITHUB_API = `http://localhost:${server.port}`;
  // A member `top/../../escape`: tar refuses to create it with -c unless -P is given.
  const d = join(work, "dd");
  mkdirSync(join(d, "top"), { recursive: true });
  writeFileSync(join(d, "x"), "x");
  Bun.spawnSync(["tar", "-czPf", join(work, "dotdot.tgz"), "-C", d, "--transform=s,^x$,top/../../escape,", "x"]);
  // The right top directory first, then a member under another one: --strip-components would mix it into the tree.
  const st = join(work, "st");
  mkdirSync(join(st, `o-n-${SHORT}`), { recursive: true });
  mkdirSync(join(st, "other-dir"), { recursive: true });
  writeFileSync(join(st, `o-n-${SHORT}`, "a.txt"), "a");
  writeFileSync(join(st, "other-dir", "b.txt"), "b");
  Bun.spawnSync(["tar", "-czf", join(work, "stray.tgz"), "-C", st, `o-n-${SHORT}`, "other-dir"]);
  const lk = join(work, "lk", `o-n-${SHORT}`);
  mkdirSync(lk, { recursive: true });
  writeFileSync(join(lk, "a.txt"), "a");
  symlinkSync("/etc/hostname", join(lk, "notes.txt"));
  Bun.spawnSync(["tar", "-czf", join(work, "link.tgz"), "-C", join(work, "lk"), `o-n-${SHORT}`]);
});
afterAll(() => {
  server.stop(true);
  delete process.env.SWITCHBOARD_GITHUB_API;
  delete process.env.SWITCHBOARD_MAX_TARBALL_BYTES;
  rmSync(work, { recursive: true, force: true });
});
beforeEach(() => {
  mode = "ok";
  delete process.env.SWITCHBOARD_MAX_TARBALL_BYTES;
});

const dest = () => mkdtempSync(join(work, "dest-"));

describe("latestRelease", () => {
  test("returns the tag and the full sha of its commit", async () => {
    expect(await latestRelease("o/n")).toEqual({ tag: "v1.2.3", sha: SHA });
  });
  test("a tag that is not vX.Y.Z or a short sha throws", async () => {
    mode = "badtag";
    await expect(latestRelease("o/n")).rejects.toThrow("not a version tag");
    mode = "badsha";
    await expect(latestRelease("o/n")).rejects.toThrow("full sha");
  });
  test("a source that is not owner/name throws before any request", async () => {
    await expect(latestRelease("o/n/../x")).rejects.toThrow("owner/name");
    await expect(shaOfTag("o/n/../x", "v1.2.3")).rejects.toThrow("owner/name");
  });
});

describe("fetchTarball and extractTarball", () => {
  test("a good tarball is fetched, checked and unpacked", async () => {
    const d = dest();
    const file = await fetchTarball("o/n", "v1.2.3", d);
    const out = join(work, "tree-ok");
    await extractTarball(file, out, { tag: "v1.2.3", sha: SHA });
    expect(readFileSync(join(out, "a.txt"), "utf8")).toBe("a");
  });

  test("a redirect to another repository throws and leaves nothing", async () => {
    mode = "other-repo";
    const d = dest();
    await expect(fetchTarball("o/n", "v1.2.3", d)).rejects.toThrow("different repository");
    expect(readdirSync(d)).toEqual([]);
  });

  test("a tarball cut short throws and leaves nothing", async () => {
    // A server cannot send fewer bytes than it declares through Bun.serve, so the response comes from a stub fetch.
    const cut: typeof fetch = (async () =>
      new Response(good.subarray(0, 20), { headers: { "content-length": String(good.length) } })) as unknown as typeof fetch;
    const d = dest();
    await expect(fetchTarball("o/n", "v1.2.3", d, cut)).rejects.toThrow("cut short");
    expect(readdirSync(d)).toEqual([]);
  });

  test("a redirect to codeload over plain http throws", async () => {
    mode = "plain-http";
    const d = dest();
    await expect(fetchTarball("o/n", "v1.2.3", d)).rejects.toThrow("different repository");
    expect(readdirSync(d)).toEqual([]);
  });

  test("a tag already fetched is not fetched again", async () => {
    const d = dest();
    const file = await fetchTarball("o/n", "v1.2.3", d);
    const never: typeof fetch = (async () => {
      throw new Error("fetched again");
    }) as unknown as typeof fetch;
    expect(await fetchTarball("o/n", "v1.2.3", d, never)).toBe(file);
  });

  test("a body that is not a tarball throws and leaves nothing", async () => {
    mode = "notgz";
    const d = dest();
    await expect(fetchTarball("o/n", "v1.2.3", d)).rejects.toThrow();
    expect(readdirSync(d)).toEqual([]);
  });

  test("a tarball over the size limit throws and leaves nothing", async () => {
    mode = "large";
    process.env.SWITCHBOARD_MAX_TARBALL_BYTES = "1000";
    const d = dest();
    await expect(fetchTarball("o/n", "v1.2.3", d)).rejects.toThrow("larger than");
    expect(readdirSync(d)).toEqual([]);
  });

  test("a member outside the commit's top directory throws and leaves nothing", async () => {
    mode = "stray";
    const file = await fetchTarball("o/n", "v1.2.3", dest());
    const out = join(work, "tree-stray");
    await expect(extractTarball(file, out, { tag: "v1.2.3", sha: SHA })).rejects.toThrow("member outside");
    expect(() => readdirSync(out)).toThrow();
  });

  test("a link member throws and leaves nothing", async () => {
    mode = "link";
    const file = await fetchTarball("o/n", "v1.2.3", dest());
    const out = join(work, "tree-link");
    await expect(extractTarball(file, out, { tag: "v1.2.3", sha: SHA })).rejects.toThrow("has a link");
    expect(() => readdirSync(out)).toThrow();
  });

  test("a name sb-rescue makes in a release (here a dist directory) throws and leaves nothing", async () => {
    mode = "made";
    const file = await fetchTarball("o/n", "v1.2.3", dest());
    const out = join(work, "tree-made");
    await expect(extractTarball(file, out, { tag: "v1.2.3", sha: SHA })).rejects.toThrow("sb-rescue makes");
    expect(() => readdirSync(out)).toThrow();
  });

  test("an existing target is refused and kept", async () => {
    const file = await fetchTarball("o/n", "v1.2.3", dest());
    const out = dest();
    writeFileSync(join(out, "keep"), "k");
    await expect(extractTarball(file, out, { tag: "v1.2.3", sha: SHA })).rejects.toThrow("already exists");
    expect(readdirSync(out)).toEqual(["keep"]);
  });

  test("a tree of another commit throws and leaves nothing", async () => {
    mode = "other-sha";
    const file = await fetchTarball("o/n", "v1.2.3", dest());
    const out = join(work, "tree-sha");
    await expect(extractTarball(file, out, { tag: "v1.2.3", sha: SHA })).rejects.toThrow("not the tree");
    expect(() => readdirSync(out)).toThrow();
  });

  test("a member with ../ throws before anything is unpacked", async () => {
    mode = "dotdot";
    const file = await fetchTarball("o/n", "v1.2.3", dest());
    const out = join(work, "tree-dotdot");
    await expect(extractTarball(file, out, { tag: "v1.2.3", sha: SHA })).rejects.toThrow("outside the target");
    expect(() => readdirSync(out)).toThrow();
  });
});
