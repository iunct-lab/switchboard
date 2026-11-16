// test-reads: rescue/
/**
 * The install without git, end to end: `bun rescue/install.ts --source o/n` against a fake Releases API, then sb-rescue
 * started from what it wrote. The child processes see a PATH with `tar`, `gzip` and `mkdir` (the fixture build) and nothing else, so a git that is called fails.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { commitFile, daemonSource, freePort, health, makeRepo, until } from "./fixture.ts";
import { readHistory, run } from "./releases.ts";

let f: Awaited<ReturnType<typeof makeRepo>>;
let api: ReturnType<typeof Bun.serve>;
let sha = "";
let bin = "";
let latestTag = "v0.1.0";
const installScript = resolve(import.meta.dir, "..", "install.ts");

const childEnv = (extra: Record<string, string>) => {
  const env: Record<string, string> = { PATH: bin, HOME: f.root, SWITCHBOARD_HOME: f.home, SWITCHBOARD_GITHUB_API: `http://localhost:${api.port}`, ...extra };
  return env;
};

beforeAll(async () => {
  f = await makeRepo();
  sha = await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("from-tarball"), "v0.1.0");
  const tgz = join(f.root, "v0.1.0.tgz");
  await run(["git", "archive", "--format=tar.gz", `--prefix=o-n-${sha.slice(0, 7)}/`, "-o", tgz, sha], f.repo);
  bin = join(f.root, "bin-no-git");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["tar", "gzip", "mkdir"]) symlinkSync(Bun.which(tool)!, join(bin, tool));
  api = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      // o/broken: a release whose tarball is not one, so the install fails after the download, before anything is built
      if (path === "/repos/o/n/releases/latest" || path === "/repos/o/broken/releases/latest") return Response.json({ tag_name: latestTag });
      if (path === "/repos/o/broken/commits/v0.1.0") return Response.json({ sha });
      if (path.startsWith("/repos/o/broken/tarball/")) return new Response("not a tarball");
      if (path === "/repos/o/n/commits/v0.1.0") return Response.json({ sha });
      if (path === "/repos/o/n/commits/v0.2.0") return Response.json({ sha: "b".repeat(40) });
      if (path.startsWith("/repos/o/n/tarball/")) {
        const body = readFileSync(tgz);
        return new Response(body, { headers: { "content-length": String(body.length) } });
      }
      return new Response("no", { status: 404 });
    },
  });
});
afterAll(() => {
  api.stop(true);
  rmSync(f.root, { recursive: true, force: true });
});

test("install --source builds the first release from the tarball, records the source, and sb-rescue then runs it with no git", async () => {
  expect(Bun.which("git", { PATH: bin })).toBeNull();
  const install = Bun.spawn([process.execPath, installScript, "--source", "o/n"], { env: childEnv({}), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(install.stdout).text(), new Response(install.stderr).text(), install.exited]);
  expect({ code, err }).toEqual({ code: 0, err: "" });
  expect(out).toContain(`bun ${join(f.home, "rescue", "sb-rescue.js")}`);
  expect(out).not.toContain("SWITCHBOARD_REPO_ROOT");

  expect(JSON.parse(readFileSync(join(f.home, "update-source.json"), "utf8"))).toEqual({ source: "o/n" });
  expect(realpathSync(join(f.home, "releases", "current"))).toBe(realpathSync(join(f.home, "releases", sha)));
  expect(JSON.parse(readFileSync(join(f.home, "releases", sha, ".release.json"), "utf8"))).toEqual({ tag: "v0.1.0", sha });
  expect(readHistory(f.home).map((h) => [h.action, h.ok, h.to])).toEqual([["install", true, sha]]);
  expect(readdirSync(join(f.home, "releases")).filter((n) => n.startsWith(".tmp-"))).toEqual([]);

  const port = await freePort();
  const rescuePort = await freePort();
  const rescue = Bun.spawn([process.execPath, join(f.home, "rescue", "sb-rescue.js")], {
    env: childEnv({ SWITCHBOARD_PORT: String(port), SWITCHBOARD_RESCUE_PORT: String(rescuePort) }),
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const h = await until(() => health(port), "daemon up from the tarball release");
    expect(h.ok).toBe(true);
    expect((await until(() => fetch(`http://127.0.0.1:${rescuePort}/`).then((r) => (r.ok ? r : null)), "rescue page")).status).toBe(200);
    const status = (await fetch(`http://127.0.0.1:${rescuePort}/api/status`).then((r) => r.json())) as { current: string };
    expect(status.current).toBe(sha);
    expect(await run(["find", f.home, "-name", ".git"], f.root)).toBe("");
  } finally {
    rescue.kill();
    await rescue.exited;
  }
}, 120_000);

test("install --source again leaves what runs: a newer release is not switched to without its check, and another source is refused", async () => {
  latestTag = "v0.2.0"; // a newer Latest (from a hijacked source, say) must not reach current by an install
  try {
    const again = Bun.spawn([process.execPath, installScript, "--source", "o/n"], { env: childEnv({}), stdout: "pipe", stderr: "pipe" });
    const [out, code] = await Promise.all([new Response(again.stdout).text(), again.exited]);
    expect(code).toBe(0);
    expect(out).toContain("v0.1.0 already runs from o/n");
    expect(realpathSync(join(f.home, "releases", "current"))).toBe(realpathSync(join(f.home, "releases", sha)));
    expect(readHistory(f.home).map((h) => h.action)).toEqual(["install"]);
    const other = Bun.spawn([process.execPath, installScript, "--source", "o/other"], { env: childEnv({}), stdout: "pipe", stderr: "pipe" });
    const [err, code2] = await Promise.all([new Response(other.stderr).text(), other.exited]);
    expect(code2).toBe(1);
    expect(err).toContain("is installed from o/n");
    expect(JSON.parse(readFileSync(join(f.home, "update-source.json"), "utf8"))).toEqual({ source: "o/n" });
  } finally {
    latestTag = "v0.1.0";
  }
}, 60_000);

test("install --source without a value, or with an unknown option, stops with the usage and writes nothing", async () => {
  const home = join(f.root, "home-usage");
  for (const args of [["--source"], ["--sauce", "o/n"], ["o/n"]]) {
    const p = Bun.spawn([process.execPath, installScript, ...args], { env: childEnv({ SWITCHBOARD_HOME: home }), stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    expect({ args, code, usage: err.includes("usage:") }).toEqual({ args, code: 2, usage: true });
  }
  expect(existsSync(home)).toBe(false);
});

test("a failed install leaves no update-source.json behind: sb-rescue then says to install first", async () => {
  // o/missing fails at the API; o/broken after the download, where a source file written early would be left behind
  for (const source of ["o/missing", "o/broken"]) {
    const home = join(f.root, `home-fail-${source.slice(2)}`);
    const p = Bun.spawn([process.execPath, installScript, "--source", source], { env: childEnv({ SWITCHBOARD_HOME: home }), stdout: "pipe", stderr: "pipe" });
    const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    expect({ source, code, failed: err.includes("install failed") }).toEqual({ source, code: 1, failed: true });
    expect(existsSync(join(home, "update-source.json"))).toBe(false);
    expect(existsSync(join(home, "releases", "current"))).toBe(false);
  }
});
