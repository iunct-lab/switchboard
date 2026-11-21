// test-reads: container/Dockerfile aws/host/devtools.sh aws/host/node.sh
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPins } from "./host-pins.ts";
import { main, type Deps } from "./bump-host-pins.ts";

const root = join(import.meta.dir, "..");
const PATHS = ["aws/host/devtools.sh", "aws/host/node.sh", "container/Dockerfile"];
const files = () => Object.fromEntries(PATHS.map((p) => [p, readFileSync(join(root, p), "utf8")]));
const NOW = new Date("2026-11-20T00:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const stream = (s: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });

// The newer versions are derived from what is pinned now, so this test still holds on the branch of a PR that raised them.
const pinnedNow = (() => {
  const f = files();
  const { pins } = readPins(f["aws/host/node.sh"]!, f["aws/host/devtools.sh"]!);
  return (n: string) => pins.find((p) => p.name === n)!.pinned;
})();
const patchUp = (v: string, d: number) => v.replace(/\.(\d+)$/, (_m, p: string) => `.${Number(p) + d}`);
const minorUp = (v: string) => v.replace(/^(\d+)\.(\d+)\.\d+$/, (_m, a: string, b: string) => `${a}.${Number(b) + 1}.0`);
const UV_OLD = pinnedNow("UV_VERSION");
const UV_AGED = patchUp(UV_OLD, 1);
const UV_FRESH = patchUp(UV_OLD, 2);
const NODE_OLD = pinnedNow("NODE_VERSION");
const NODE_SECURITY = patchUp(NODE_OLD, 1);
const NODE_ORDINARY = minorUp(NODE_OLD);
const UV_URL = (cpu: string) => `https://github.com/astral-sh/uv/releases/download/${UV_AGED}/uv-${cpu}-unknown-linux-gnu.tar.gz`;
const NODE_FILE = (cpu: string) => `node-v${NODE_SECURITY}-linux-${cpu}.tar.xz`;

/**
 * A distributor where every tool has only its pinned version, except: uv's next patch is 20 days old and the one after
 * it 2 days old, and Node.js's next patch is a 4-day-old security release while its next minor is a 4-day-old ordinary one.
 */
function distributor(opts: { uvShaOverride?: Record<string, string>; dockerWithoutSha256?: true } = {}) {
  const pinned = pinnedNow;
  const day = (n: number) => ago(n).slice(0, 10);
  return async (url: string): Promise<string> => {
    if (url === "https://nodejs.org/dist/index.json")
      return JSON.stringify([
        { version: `v${NODE_ORDINARY}`, date: day(4), lts: "Krypton" },
        { version: `v${NODE_SECURITY}`, date: day(4), lts: "Krypton", security: true },
        { version: `v${pinned("NODE_VERSION")}`, date: "2026-01-01", lts: "Krypton" },
      ]);
    if (url === `https://nodejs.org/dist/v${NODE_SECURITY}/SHASUMS256.txt`)
      return ["arm64", "x64"].map((cpu) => `${sha(`https://nodejs.org/dist/v${NODE_SECURITY}/${NODE_FILE(cpu)}`)}  ${NODE_FILE(cpu)}`).join("\n");
    if (opts.dockerWithoutSha256 && url.startsWith("https://download.docker.com/") && url.endsWith(".sha256")) throw new Error("download.docker.com answered 404");
    if (url.startsWith("https://download.docker.com/linux/static/stable/aarch64/"))
      return (
        `<a href="docker-${pinned("DOCKER_VERSION")}.tgz">x</a>  2026-01-01 00:00:00  1M\n` +
        (opts.dockerWithoutSha256 ? `<a href="docker-${patchUp(pinned("DOCKER_VERSION"), 1)}.tgz">x</a>  ${day(30)} 00:00:00  1M\n` : "")
      );
    const gh = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\?per_page=20$/.exec(url);
    if (gh) {
      const repoTo: Record<string, string> = { "docker/compose": "COMPOSE_VERSION", "astral-sh/uv": "UV_VERSION", "gitleaks/gitleaks": "GITLEAKS_VERSION", "aws/aws-sam-cli": "SAM_VERSION", "github/gh-stack": "GH_STACK_VERSION", "sigstore/cosign": "COSIGN_VERSION" };
      const rows = [{ tag_name: `v${pinned(repoTo[gh[1]!]!)}`, published_at: ago(100) }];
      if (gh[1] === "astral-sh/uv") rows.push({ tag_name: UV_AGED, published_at: ago(20) }, { tag_name: UV_FRESH, published_at: ago(2) });
      return JSON.stringify(rows);
    }
    const npm = /^https:\/\/registry\.npmjs\.org\/(.+)$/.exec(url);
    if (npm) {
      const v = pinned(npm[1] === "playwright" ? "PLAYWRIGHT_VERSION" : "PLAYWRIGHT_MCP_VERSION");
      return JSON.stringify({ time: { [v]: ago(100) }, versions: { [v]: {} } });
    }
    const sha256File = /^(.*)\.sha256$/.exec(url);
    if (sha256File) return `${opts.uvShaOverride?.[sha256File[1]!] ?? sha(sha256File[1]!)}  x\n`;
    throw new Error(`unexpected url ${url}`);
  };
}

function setup(o: { open?: string; fetchText?: (u: string) => Promise<string> } = {}) {
  const before = files();
  const calls: string[][] = [];
  const downloads: string[] = [];
  const blobs = new Map<string, string>();
  const tree: Record<string, string> = {};
  const logs: string[] = [];
  const bodies: string[] = [];
  const sh: Deps["sh"] = (cmd, input) => {
    calls.push(cmd);
    if (cmd[0] === "gh" && cmd[2] === "create") bodies.push(input ?? "");
    const git = cmd[0] === "env" ? cmd.slice(2) : cmd;
    const ok = (out = "") => ({ ok: true, out });
    if (git[0] === "git" && git[1] === "fetch") return ok();
    if (git[0] === "git" && git[1] === "show") return ok(before[git[2]!.replace("origin/main:", "")]!.trim());
    if (git[1] === "remote") return ok("git@github.com:o/r.git");
    if (git[0] === "gh" && git[1] === "pr" && git[2] === "list") return ok(o.open ?? "");
    if (git[1] === "read-tree" || git[1] === "push") return ok();
    if (git[1] === "ls-files") return ok(`100755 deadbeef 0\t${git[4]}`);
    if (git[1] === "hash-object") {
      const id = sha(input!);
      blobs.set(id, input!);
      return ok(id);
    }
    if (git[1] === "update-index") {
      const [, blob, path] = git[3]!.split(",");
      tree[path!] = blobs.get(blob!)!;
      return ok();
    }
    if (git[1] === "write-tree") return ok("tree1");
    if (git[1] === "commit-tree") return ok("commit1");
    if (git[0] === "gh" && git[2] === "create") return ok("https://github.com/o/r/pull/9");
    return { ok: false, out: `unexpected ${cmd.join(" ")}` };
  };
  const deps: Deps = {
    sh,
    fetchText: o.fetchText ?? distributor(),
    fetchBytes: async (url) => {
      downloads.push(url);
      return stream(url);
    },
    now: () => NOW,
    log: (l) => logs.push(l),
    repo: "o/r",
  };
  return { deps, calls, downloads, tree, logs, before, bodies };
}

const versionOf = (text: string, name: string) => new RegExp(`^(?:ARG )?${name}=(\\S+)$`, "m").exec(text)?.[1];

describe("bump-host-pins main", () => {
  test("main --pr: 期間を過ぎた版だけが PR の差分に入り、期間内の版は入らない", async () => {
    const t = setup();
    expect(await main(["--pr"], t.deps)).toBe(0);
    // uv's 20-day-old patch is in, the 2-day-old one is not; Node.js's 4-day-old security release is in, the 4-day-old ordinary one is not
    expect(versionOf(t.tree["aws/host/devtools.sh"]!, "UV_VERSION")).toBe(UV_AGED);
    expect(versionOf(t.tree["container/Dockerfile"]!, "UV_VERSION")).toBe(UV_AGED);
    expect(versionOf(t.tree["aws/host/node.sh"]!, "NODE_VERSION")).toBe(NODE_SECURITY);
    expect(versionOf(t.tree["container/Dockerfile"]!, "NODE_VERSION")).toBe(NODE_SECURITY);
    expect(Object.values(t.tree).join("\n")).not.toContain(`UV_VERSION=${UV_FRESH}`);
    expect(Object.values(t.tree).join("\n")).not.toContain(`NODE_VERSION=${NODE_ORDINARY}`);
    // the sha256 lines moved with the versions (arm64 and x86-64 are different files)
    expect(versionOf(t.tree["aws/host/devtools.sh"]!, "UV_SHA256")).toBe(sha(UV_URL("aarch64")));
    expect(versionOf(t.tree["container/Dockerfile"]!, "UV_SHA256_X86_64")).toBe(sha(UV_URL("x86_64")));
    expect(versionOf(t.tree["aws/host/node.sh"]!, "NODE_SHA256")).toBe(sha(`https://nodejs.org/dist/v${NODE_SECURITY}/${NODE_FILE("arm64")}`));
    // a tool with nothing newer is untouched, and the file keeps its mode
    expect(versionOf(t.tree["aws/host/devtools.sh"]!, "COMPOSE_VERSION")).toBe(versionOf(t.before["aws/host/devtools.sh"]!, "COMPOSE_VERSION"));
    expect(t.calls.some((c) => c.includes("--cacheinfo") && c.some((a) => a.startsWith("100755,")))).toBe(true);
    expect(t.logs.at(-1)).toBe("PR: https://github.com/o/r/pull/9");
  });

  test("main --pr: PR 本文に公開からの経過日数と、公表値の無かった物の URL が入る", async () => {
    const t = setup({ fetchText: distributor({ dockerWithoutSha256: true }) });
    expect(await main(["--pr"], t.deps)).toBe(0);
    const body = t.bodies.join("\n");
    expect(body).toContain(`| UV | ${UV_OLD} → ${UV_AGED} | ${ago(20).slice(0, 10)}（20 日） |`);
    const docker = patchUp(pinnedNow("DOCKER_VERSION"), 1);
    // the note under the table names each file without a published value (not only the table's list of URLs)
    expect(body).toContain(`算出した値）: https://download.docker.com/linux/static/stable/aarch64/docker-${docker}.tgz、`);
    expect(body).toMatch(new RegExp(`DOCKER: 次の物は.*、https://download\\.docker\\.com/linux/static/stable/x86_64/docker-${docker.replace(/\./g, "\\.")}\\.tgz`));
  });

  test("main --pr: 公表値と合わなければ PR を作らず、道具の名前と理由を出して 1", async () => {
    const t = setup({ fetchText: distributor({ uvShaOverride: { [UV_URL("aarch64")]: "0".repeat(64) } }) });
    expect(await main(["--pr"], t.deps)).toBe(1);
    const failure = t.logs.find((l) => l.startsWith("照合に失敗"))!;
    expect(failure).toContain("UV_VERSION");
    expect(failure).toContain("uv-aarch64-unknown-linux-gnu.tar.gz");
    expect(failure).toContain("0".repeat(64));
    expect(t.calls.some((c) => c.includes("push") || (c[0] === "gh" && c[2] === "create"))).toBe(false);
  });

  test("main --pr: この checkout のファイルを書かず、push は host-pins/bump だけ", async () => {
    const t = setup();
    expect(await main(["--pr"], t.deps)).toBe(0);
    expect(files()).toEqual(t.before);
    const pushes = t.calls.filter((c) => c.includes("push"));
    expect(pushes).toEqual([["git", "push", "origin", "+commit1:refs/heads/host-pins/bump"]]);
    const creates = t.calls.filter((c) => c[0] === "gh" && c[2] === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("host-pins/bump");
    expect(creates[0]).toContain("-R");
    // no command that changes the work tree or its index (the index used is a temporary file)
    for (const c of t.calls) {
      if (c[0] === "env") expect(c[1]).toMatch(/^GIT_INDEX_FILE=.+switchboard\.host-pins\./);
      else expect(c.slice(0, 2)).not.toEqual(["git", "checkout"]);
      expect(c.slice(0, 2)).not.toEqual(["git", "add"]);
      expect(c.slice(0, 2)).not.toEqual(["git", "commit"]);
    }
  });

  test("main --pr: 開いた PR があれば作らず、ダウンロードもしない", async () => {
    const t = setup({ open: "77" });
    expect(await main(["--pr"], t.deps)).toBe(0);
    expect(t.logs.join("\n")).toContain("開いた PR #77");
    expect(t.logs.join("\n")).toContain(`UV ${UV_AGED}`);
    expect(t.downloads).toEqual([]);
    expect(t.calls.some((c) => c.includes("push") || (c[0] === "gh" && c[2] === "create"))).toBe(false);
  });

  test("main: --pr なしは選んだ版を出すだけで、ダウンロードも書き込みもしない。日数は引数で変えられる", async () => {
    const t = setup();
    expect(await main([], t.deps)).toBe(0);
    expect(t.logs.join("\n")).toContain(`UV ${UV_OLD} → ${UV_AGED}（公開 `);
    expect(t.downloads).toEqual([]);
    expect(t.calls.every((c) => c[0] === "git" && (c[1] === "fetch" || c[1] === "show"))).toBe(true);
    // an empty value is not read as 0 days
    expect(await main(["--min-age-days", ""], setup().deps)).toBe(2);
    const shorter = setup();
    expect(await main(["--min-age-days", "1"], shorter.deps)).toBe(0);
    expect(shorter.logs.join("\n")).toContain(`UV ${UV_OLD} → ${UV_FRESH}`);
    expect(shorter.logs.join("\n")).toContain(`NODE ${NODE_OLD} → ${NODE_ORDINARY}`);
  });

  test("main: 選べる版が無ければ 更新なし で 0", async () => {
    const t = setup();
    expect(await main(["--min-age-days", "30", "--security-min-age-days", "30"], t.deps)).toBe(0);
    expect(t.logs).toEqual(["更新なし"]);
  });

  test("main: 配布元が読めなければ 判定できない で 2", async () => {
    const t = setup({ fetchText: async () => { throw new Error("registry.npmjs.org answered 503"); } });
    expect(await main(["--pr"], t.deps)).toBe(2);
    expect(t.logs.join("\n")).toContain("判定できない");
    expect(t.logs.join("\n")).toContain("503");
    expect(t.downloads).toEqual([]);
  });
});
