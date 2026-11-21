// test-reads: container/Dockerfile aws/host/devtools.sh aws/host/node.sh
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPins } from "./host-pins.ts";
import { PIN_FILES, VERSION_FILES, prBody, rewrite, verifyFiles, type Texts } from "./host-pin-files.ts";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const texts = (): Texts => ({ devtools: read("aws/host/devtools.sh"), node: read("aws/host/node.sh"), dockerfile: read("container/Dockerfile") });

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** a stream that hands out the bytes in two pieces, as a download does */
const stream = (s: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      const b = new TextEncoder().encode(s);
      c.enqueue(b.slice(0, 3));
      c.enqueue(b.slice(3));
      c.close();
    },
  });
/** the body of a URL is the URL itself, so each file has its own sha256 */
const bytes = async (url: string) => stream(url);
const own = (url: string) => sha(url);

describe("verifyFiles", () => {
  test("verifyFiles: 公表値と合わない物は ok: false で道具とファイルを名指しする", async () => {
    const fetchText = async (u: string) => {
      if (u.endsWith("uv-aarch64-unknown-linux-gnu.tar.gz.sha256")) return `${"0".repeat(64)}  uv-aarch64-unknown-linux-gnu.tar.gz\n`;
      return `${own(u.replace(/\.sha256$/, ""))}  x\n`;
    };
    const got = await verifyFiles("UV_VERSION", "0.14.0", bytes, fetchText);
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.why).toContain("UV_VERSION");
    expect(got.why).toContain("uv-aarch64-unknown-linux-gnu.tar.gz");
    expect(got.why).toContain("UV_SHA256");
    expect(got.why).toContain("0".repeat(64));
  });

  test("verifyFiles: Docker の .sha256 が無ければ公表なしで算出値を返す", async () => {
    const asked: string[] = [];
    const fetchText = async (u: string) => {
      asked.push(u);
      throw new Error("download.docker.com answered 404");
    };
    const got = await verifyFiles("DOCKER_VERSION", "29.10.0", bytes, fetchText);
    // four files over three URLs: the arm64 docker tgz is pinned twice but its .sha256 is read once
    expect(asked.length).toBe(3);
    expect(got).toEqual({
      ok: true,
      how: "公表なし",
      shas: {
        DOCKER_SHA256: own("https://download.docker.com/linux/static/stable/aarch64/docker-29.10.0.tgz"),
        DOCKER_ROOTLESS_SHA256: own("https://download.docker.com/linux/static/stable/aarch64/docker-rootless-extras-29.10.0.tgz"),
        DOCKER_SHA256_X86_64: own("https://download.docker.com/linux/static/stable/x86_64/docker-29.10.0.tgz"),
      },
      unpublished: [
        "https://download.docker.com/linux/static/stable/aarch64/docker-29.10.0.tgz",
        "https://download.docker.com/linux/static/stable/aarch64/docker-rootless-extras-29.10.0.tgz",
        "https://download.docker.com/linux/static/stable/x86_64/docker-29.10.0.tgz",
      ],
    });
    // a failure that is not "no such file" is "cannot tell", not "not published"
    await expect(verifyFiles("DOCKER_VERSION", "29.10.0", bytes, async () => { throw new Error("download.docker.com answered 503"); })).rejects.toThrow("503");
    // a 404 elsewhere in the message (a version like 29.404.0 in a URL) is not "no such file"
    await expect(verifyFiles("DOCKER_VERSION", "29.404.0", bytes, async (u) => { throw new Error(`${u} answered 503`); })).rejects.toThrow("503");
    // a file that is not optional has no "not published"
    await expect(verifyFiles("UV_VERSION", "0.14.0", bytes, async () => { throw new Error("github.com answered 404"); })).rejects.toThrow("404");
  });

  test("verifyFiles: Docker の .sha256 があれば公表値と照らす", async () => {
    const fetchText = async (u: string) => `${own(u.replace(/\.sha256$/, ""))}  docker.tgz\n`;
    const got = await verifyFiles("DOCKER_VERSION", "29.10.0", bytes, fetchText);
    expect(got.ok && got.how).toBe("公表値と一致");
    // only the rootless extras without a .sha256: the others are still checked, and that one file is named
    const partly = await verifyFiles("DOCKER_VERSION", "29.10.0", bytes, async (u) => {
      if (u.includes("rootless")) throw new Error("download.docker.com answered 404");
      return fetchText(u);
    });
    expect(partly.ok && partly.how).toBe("公表なし");
    expect(partly.ok && partly.unpublished).toEqual(["https://download.docker.com/linux/static/stable/aarch64/docker-rootless-extras-29.10.0.tgz"]);
    // the two CPUs' archives have the same file name: the one without a .sha256 is named by its URL
    const x86 = await verifyFiles("DOCKER_VERSION", "29.10.0", bytes, async (u) => {
      if (u.includes("x86_64")) throw new Error("download.docker.com answered 404");
      return fetchText(u);
    });
    expect(x86.ok && x86.unpublished).toEqual(["https://download.docker.com/linux/static/stable/x86_64/docker-29.10.0.tgz"]);
  });

  test("verifyFiles: github-digest・checksums.txt・SHASUMS256.txt を読んで照らす", async () => {
    // GitHub's digest (SAM)
    const samUrl = "https://github.com/aws/aws-sam-cli/releases/download/v1.173.0/aws-sam-cli-linux-arm64.zip";
    const release = (digest: string) => JSON.stringify({ assets: [{ name: "other.zip", digest: `sha256:${"1".repeat(64)}` }, { name: "aws-sam-cli-linux-arm64.zip", digest: `sha256:${digest}` }] });
    const sam = await verifyFiles("SAM_VERSION", "1.173.0", bytes, async (u) => {
      expect(u).toBe("https://api.github.com/repos/aws/aws-sam-cli/releases/tags/v1.173.0");
      return release(own(samUrl));
    });
    expect(sam).toEqual({ ok: true, how: "GitHub の digest と一致", shas: { SAM_SHA256: own(samUrl) }, unpublished: [] });
    const bad = await verifyFiles("SAM_VERSION", "1.173.0", bytes, async () => release("2".repeat(64)));
    expect(bad.ok).toBe(false);
    // an asset without a digest is not taken on trust
    await expect(verifyFiles("SAM_VERSION", "1.173.0", bytes, async () => JSON.stringify({ assets: [{ name: "aws-sam-cli-linux-arm64.zip" }] }))).rejects.toThrow("digest");

    // gitleaks_<version>_checksums.txt: both CPUs' lines in one list
    const arm = "https://github.com/gitleaks/gitleaks/releases/download/v8.31.0/gitleaks_8.31.0_linux_arm64.tar.gz";
    const x64 = "https://github.com/gitleaks/gitleaks/releases/download/v8.31.0/gitleaks_8.31.0_linux_x64.tar.gz";
    const list = [`${own(x64)}  gitleaks_8.31.0_linux_x64.tar.gz`, `${own(arm)}  gitleaks_8.31.0_linux_arm64.tar.gz`, `${"3".repeat(64)}  gitleaks_8.31.0_darwin_arm64.tar.gz`].join("\n");
    const gl = await verifyFiles("GITLEAKS_VERSION", "8.31.0", bytes, async (u) => {
      expect(u).toBe("https://github.com/gitleaks/gitleaks/releases/download/v8.31.0/gitleaks_8.31.0_checksums.txt");
      return list;
    });
    expect(gl).toEqual({ ok: true, how: "公表値と一致", shas: { GITLEAKS_SHA256: own(arm), GITLEAKS_SHA256_X86_64: own(x64) }, unpublished: [] });
    // a list without the file's line cannot be checked against
    await expect(verifyFiles("GITLEAKS_VERSION", "8.31.0", bytes, async () => `${"3".repeat(64)}  other\n`)).rejects.toThrow("gitleaks_8.31.0_linux_arm64.tar.gz");
    // a list with two different lines for the same file is not read as a match on the first one
    await expect(verifyFiles("GITLEAKS_VERSION", "8.31.0", bytes, async () => `${list}\n${"4".repeat(64)}  gitleaks_8.31.0_linux_arm64.tar.gz\n`)).rejects.toThrow("2 つ");

    // nodejs.org SHASUMS256.txt: one fetch per file, three files over two URLs of downloads
    const fetched: string[] = [];
    const nodeArm = "https://nodejs.org/dist/v24.23.0/node-v24.23.0-linux-arm64.tar.xz";
    const nodeX64 = "https://nodejs.org/dist/v24.23.0/node-v24.23.0-linux-x64.tar.xz";
    const downloads: string[] = [];
    const node = await verifyFiles(
      "NODE_VERSION",
      "24.23.0",
      async (u) => (downloads.push(u), stream(u)),
      async (u) => {
        fetched.push(u);
        expect(u).toBe("https://nodejs.org/dist/v24.23.0/SHASUMS256.txt");
        return `${own(nodeX64)}  node-v24.23.0-linux-x64.tar.xz\n${own(nodeArm)}  node-v24.23.0-linux-arm64.tar.xz\n`;
      },
    );
    expect(node).toEqual({ ok: true, how: "公表値と一致", shas: { NODE_SHA256: own(nodeArm), NODE_SHA256_X86_64: own(nodeX64) }, unpublished: [] });
    // the arm64 file is pinned in node.sh and in the Dockerfile but downloaded once, and the list is read once
    expect(downloads.sort()).toEqual([nodeArm, nodeX64]);
    expect(fetched).toEqual(["https://nodejs.org/dist/v24.23.0/SHASUMS256.txt"]);
  });

  test("verifyFiles: Playwright は版だけ、表に無い道具は ok: false", async () => {
    const never = async () => {
      throw new Error("no fetch");
    };
    expect(await verifyFiles("PLAYWRIGHT_VERSION", "1.66.0", never as never, never)).toEqual({ ok: true, shas: {}, how: "版だけ（npm）", unpublished: [] });
    expect((await verifyFiles("BUN_VERSION", "1.5.0", never as never, never)).ok).toBe(false);
  });
});

describe("rewrite", () => {
  test("rewrite: 本物の 3 つのファイルを書き換えても container/versions.test.ts と同じ検査が通る", () => {
    const before = texts();
    const bumps = Object.keys(PIN_FILES).map((name, i) => ({
      name,
      version: `9.${i}.1`,
      shas: Object.fromEntries(PIN_FILES[name]!.map((f) => [f.shaVar, sha(`${name}/${f.shaVar}`)])),
    }));
    const after = rewrite(before, bumps);
    expect(Object.keys(VERSION_FILES).sort()).toEqual(Object.keys(PIN_FILES).sort());
    const arg = (text: string, name: string) => new RegExp(`^(?:ARG )?${name}=(\\S+)$`, "m").exec(text)?.[1];
    const { pins, unreadable } = readPins(after.node, after.devtools);
    expect(unreadable).toEqual([]);
    for (const b of bumps) {
      // the host's pin and the image's agree, and a `v` prefix is kept as the line had it
      expect(pins.find((p) => p.name === b.name)?.pinned ?? b.version).toBe(b.version);
      // every file that pins the version has it, raised (as container/versions.test.ts requires of the image)
      for (const file of VERSION_FILES[b.name]!) expect(arg(after[file], b.name)?.replace(/^v/, "")).toBe(b.version);
      // and, not taken from the table: every file that had the version line before has the new version
      for (const file of ["devtools", "node", "dockerfile"] as const)
        if (arg(before[file], b.name) !== undefined) expect({ file, name: b.name, v: arg(after[file], b.name)?.replace(/^v/, "") }).toEqual({ file, name: b.name, v: b.version });
    }
    expect(arg(after.dockerfile, "GH_STACK_VERSION")).toBe(`v${bumps.find((b) => b.name === "GH_STACK_VERSION")!.version}`);
    expect(arg(after.devtools, "GH_STACK_VERSION")).toBe(`v${bumps.find((b) => b.name === "GH_STACK_VERSION")!.version}`);
    for (const tool of ["NODE", "DOCKER", "COMPOSE", "UV", "GITLEAKS"]) {
      const host = arg(tool === "NODE" ? after.node : after.devtools, `${tool}_SHA256`);
      expect(host).toMatch(/^[0-9a-f]{64}$/);
      expect(arg(after.dockerfile, `${tool}_SHA256`)).toBe(host);
      // as container/versions.test.ts: the x86-64 checksum is there, is a sha256 and is a different file's
      expect(arg(after.dockerfile, `${tool}_SHA256_X86_64`)).toMatch(/^[0-9a-f]{64}$/);
      expect(arg(after.dockerfile, `${tool}_SHA256_X86_64`)).not.toBe(host);
    }
    // the image's checks from container/versions.test.ts, with its own list of tools (not this script's table)
    for (const tool of ["DOCKER", "COMPOSE", "UV", "GITLEAKS", "NODE", "GH", "GH_STACK"]) {
      expect({ tool, arm64: arg(after.dockerfile, `${tool}_SHA256`) }).toEqual({ tool, arm64: expect.stringMatching(/^[0-9a-f]{64}$/) });
      const x86 = arg(after.dockerfile, `${tool}_SHA256_X86_64`);
      expect({ tool, x86 }).toEqual({ tool, x86: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect({ tool, same: x86 === arg(after.dockerfile, `${tool}_SHA256`) }).toEqual({ tool, same: false });
    }
    // every sha256 given is written where the table says (both CPUs, every tool, gh-stack's x86-64 too)
    for (const b of bumps) for (const f of PIN_FILES[b.name]!) expect(arg(after[f.file], f.shaVar)).toBe(b.shas[f.shaVar]);
    expect(after.node).toMatch(/\nNODE_SHA256=[0-9a-f]{64}\n/);
    expect(after.node).toMatch(/\nNODE_VERSION=\S+\n/);
    // only the pinned lines changed: same line count, and every changed line is a version or a sha256 line
    for (const file of ["devtools", "node", "dockerfile"] as const) {
      const a = before[file].split("\n");
      const b = after[file].split("\n");
      expect(b.length).toBe(a.length);
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) expect(b[i]).toMatch(/^(ARG )?[A-Z0-9_]+_(VERSION|SHA256(_X86_64)?)=\S+$/);
    }
    // what is not in the table stays
    expect(arg(after.dockerfile, "BUN_VERSION")).toBe(arg(before.dockerfile, "BUN_VERSION"));
    expect(arg(after.devtools, "COSIGN_VERSION")).toBe(arg(before.devtools, "COSIGN_VERSION"));
  });

  test("rewrite: 置き換える行が無ければ throw", () => {
    const shas = { UV_SHA256: "a".repeat(64), UV_SHA256_X86_64: "b".repeat(64) };
    const t = texts();
    expect(() => rewrite({ ...t, devtools: t.devtools.replace(/^UV_SHA256=.*\n/m, "") }, [{ name: "UV_VERSION", version: "0.14.0", shas }])).toThrow("UV_SHA256");
    expect(() => rewrite({ devtools: "", node: "", dockerfile: "" }, [{ name: "UV_VERSION", version: "0.14.0", shas }])).toThrow("UV_VERSION");
    expect(() => rewrite(t, [{ name: "BUN_VERSION", version: "1.5.0", shas: {} }])).toThrow("BUN_VERSION");
    // the same bytes for both CPUs would leave the image's x86-64 pin equal to its arm64 one
    expect(() => rewrite(t, [{ name: "UV_VERSION", version: "0.14.0", shas: { UV_SHA256: "a".repeat(64), UV_SHA256_X86_64: "a".repeat(64) } }])).toThrow("UV_SHA256_X86_64 が arm64");
    // every file that pins the version must still have its line (the other file's line is not enough)
    expect(() => rewrite({ ...t, dockerfile: t.dockerfile.replace(/^ARG PLAYWRIGHT_VERSION=.*\n/m, "") }, [{ name: "PLAYWRIGHT_VERSION", version: "1.66.0", shas: {} }])).toThrow("dockerfile に PLAYWRIGHT_VERSION=");
    expect(() => rewrite({ ...t, devtools: t.devtools.replace(/^GH_STACK_VERSION=.*\n/m, "") }, [{ name: "GH_STACK_VERSION", version: "0.9.0", shas: { GH_STACK_SHA256: "a".repeat(64), GH_STACK_SHA256_X86_64: "b".repeat(64) } }])).toThrow("devtools に GH_STACK_VERSION=");
    // a version that is not digits and dots is not written into a shell script
    for (const bad of ["24.23.0$(id)", "24.23.0;x", "24.23.0 x", "", "v24.23.0", "24.23.0-rc.1", "2", "1.2", "24.23.0.1"])
      expect(() => rewrite(t, [{ name: "PLAYWRIGHT_VERSION", version: bad, shas: {} }])).toThrow("版の形");
    expect(() => rewrite({ ...t, dockerfile: t.dockerfile.replace(/^ARG UV_VERSION=.*\n/m, "") }, [{ name: "UV_VERSION", version: "0.14.0", shas }])).toThrow("dockerfile に UV_VERSION=");
    expect(() => rewrite(t, [{ name: "UV_VERSION", version: "0.14.0", shas: { UV_SHA256: "a".repeat(64) } }])).toThrow("UV_SHA256_X86_64");
  });
});

describe("prBody", () => {
  test("prBody: 旧版 → 新版・公開日・取得元の URL・確かめ方が道具ごとに並ぶ", () => {
    const body = prBody(
      [
        { name: "UV_VERSION", from: "0.13.7", to: "0.14.0", published: "2026-11-10T01:02:03.000Z", urls: ["https://example.test/uv-a", "https://example.test/uv-b"], how: "公表値と一致", unpublished: [] },
        { name: "DOCKER_VERSION", from: "29.9.3", to: "29.10.0", published: "2026-11-01T00:00:00.000Z", urls: ["https://example.test/docker"], how: "公表なし", unpublished: ["https://example.test/docker-x86_64/docker-29.10.0.tgz"] },
        { name: "SAM_VERSION", from: "1.172.1", to: "1.173.0", published: "2026-11-05T00:00:00.000Z", urls: ["https://example.test/sam"], how: "GitHub の digest と一致", unpublished: [] },
      ],
      { minAgeDays: 7, securityMinAgeDays: 2, now: new Date("2026-11-20T00:00:00Z") },
    );
    expect(body).toContain("| UV | 0.13.7 → 0.14.0 | 2026-11-10（9 日） | https://example.test/uv-a<br>https://example.test/uv-b | 公表値と一致 |");
    expect(body).toContain("| DOCKER | 29.9.3 → 29.10.0 | 2026-11-01（19 日） | https://example.test/docker | 公表なし |");
    expect(body).toContain("| SAM | 1.172.1 → 1.173.0 | 2026-11-05（15 日） | https://example.test/sam | GitHub の digest と一致 |");
    expect(body).toContain("公開から 7 日（セキュリティ修正の版は 2 日）");
    expect(body).toContain("DOCKER: 次の物は配布元が checksum を公表していないので、取ってきた物が正しいかを確かめられない（sha256 は取ってきた物から算出した値）: https://example.test/docker-x86_64/docker-29.10.0.tgz");
    // "公表なし" without the list of files (or a list without "公表なし") is refused, not written as an empty note
    expect(() => prBody([{ name: "DOCKER_VERSION", from: "1", to: "2", published: "2026-11-10T00:00:00Z", urls: ["u"], how: "公表なし", unpublished: [] }], { minAgeDays: 7, securityMinAgeDays: 2, now: new Date("2026-11-20T00:00:00Z") })).toThrow("合わない");
    // nothing is said about the files that were checked, so a tool with none checked is not described as partly checked
    expect(body).not.toContain("ほかの物");
    // a publish date that cannot be read is not shown as NaN days
    expect(() => prBody([{ name: "UV_VERSION", from: "1", to: "2", published: "?", urls: ["u"], how: "公表値と一致", unpublished: [] }], { minAgeDays: 7, securityMinAgeDays: 2, now: new Date("2026-11-20T00:00:00Z") })).toThrow("公開日");
    expect(body).not.toContain("UV: 配布元が checksum を公表していない");
    expect(body).toContain("SAM: 照らした相手は GitHub が受け取った物の digest");
    // all checked against a published value: no "cannot be checked" line
    expect(prBody([{ name: "UV_VERSION", from: "1", to: "2", published: "2026-11-10T00:00:00Z", urls: ["u"], how: "公表値と一致", unpublished: [] }], { minAgeDays: 7, securityMinAgeDays: 2, now: new Date("2026-11-20T00:00:00Z") })).not.toContain("確かめられない");
  });
});
