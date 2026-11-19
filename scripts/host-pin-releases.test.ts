import { describe, expect, test } from "bun:test";
import type { Pin } from "./host-pins.ts";
import { MIN_AGE_DAYS, pickAged, releasesOf, SECURITY_MIN_AGE_DAYS, type Release } from "./host-pin-releases.ts";

const NOW = new Date("2026-11-20T00:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const rel = (version: string, days: number, security?: boolean): Release => ({ version, published: ago(days), ...(security && { security: true }) });
const serve = (url: string, body: string) => async (u: string) => {
  if (u !== url) throw new Error(`unexpected url ${u}`);
  return body;
};

describe("pickAged", () => {
  test("pickAged: 期間内の版は選ばれず、期間を過ぎた最新の版が選ばれる", () => {
    const got = pickAged([rel("0.13.7", 30), rel("0.13.8", 8), rel("0.13.9", 2)], "0.13.7", NOW);
    expect(got?.version).toBe("0.13.8");
    // the larger version wins, not the later publish date (a backport published after it)
    expect(pickAged([rel("1.1.0", 10), rel("1.0.5", 8)], "1.0.0", NOW)?.version).toBe("1.1.0");
  });

  test("pickAged: 既定の期間はセキュリティ版 2 日、それ以外 7 日", () => {
    expect(MIN_AGE_DAYS).toBe(7);
    expect(SECURITY_MIN_AGE_DAYS).toBe(2);
    expect(pickAged([rel("1.1.0", 3, true)], "1.0.0", NOW)?.version).toBe("1.1.0");
    expect(pickAged([rel("1.1.0", 3)], "1.0.0", NOW)).toBeNull();
    // the period is passed in: a shorter one lets the 3-day normal release through
    expect(pickAged([rel("1.1.0", 3)], "1.0.0", NOW, { minAgeDays: 3 })?.version).toBe("1.1.0");
    expect(pickAged([rel("1.1.0", 3, true)], "1.0.0", NOW, { securityMinAgeDays: 4 })).toBeNull();
  });

  test("pickAged: 期間を過ぎた版が無ければ null", () => {
    expect(pickAged([rel("0.13.7", 30), rel("0.13.8", 1)], "0.13.7", NOW)).toBeNull();
    expect(pickAged([rel("0.13.6", 90), rel("0.13.7", 30)], "0.13.7", NOW)).toBeNull();
  });
});

describe("releasesOf", () => {
  test("releasesOf: github は draft・prerelease・版でない tag を外す", async () => {
    const pin: Pin = { name: "SAM_VERSION", pinned: "1.150.0", source: { kind: "github", repo: "aws/aws-sam-cli" } };
    const body = JSON.stringify([
      { tag_name: "v1.152.0", published_at: "2026-11-10T00:00:00Z" },
      { tag_name: "v1.153.0", published_at: "2026-11-11T00:00:00Z", draft: true },
      { tag_name: "v1.154.0-rc1", published_at: "2026-11-12T00:00:00Z", prerelease: true },
      { tag_name: "v1.155.0", published_at: "2026-11-13T00:00:00Z", prerelease: true },
      { tag_name: "sam-cli-nightly", published_at: "2026-11-14T00:00:00Z" },
      { tag_name: "1.151.0", published_at: "2026-11-05T12:00:00Z" },
    ]);
    const got = await releasesOf(pin, serve("https://api.github.com/repos/aws/aws-sam-cli/releases?per_page=20", body));
    expect(got).toEqual([
      { version: "1.152.0", published: "2026-11-10T00:00:00.000Z" },
      { version: "1.151.0", published: "2026-11-05T12:00:00.000Z" },
    ]);
  });

  test("releasesOf: docker の一覧から日時を読む", async () => {
    const pin: Pin = { name: "DOCKER_VERSION", pinned: "29.9.0", source: { kind: "docker" } };
    const page = [
      '<a href="docker-29.9.0.tgz">docker-29.9.0.tgz</a>                       2026-10-01 03:04:05       60MB',
      '<a href="docker-29.10.0.tgz">docker-29.10.0.tgz</a>                     2026-11-12 23:30:00       61MB',
      '<a href="docker-rootless-extras-29.10.0.tgz">docker-rootless-extras-29.10.0.tgz</a>  2026-11-12 23:31:00  1MB',
    ].join("\n");
    const got = await releasesOf(pin, serve("https://download.docker.com/linux/static/stable/aarch64/", page));
    expect(got).toEqual([
      { version: "29.9.0", published: "2026-10-01T03:04:05.000Z" },
      { version: "29.10.0", published: "2026-11-12T23:30:00.000Z" },
    ]);
  });

  test("releasesOf: npm の time から公開日を読む", async () => {
    const pin: Pin = { name: "PLAYWRIGHT_VERSION", pinned: "1.50.0", source: { kind: "npm", pkg: "@playwright/mcp" } };
    const body = JSON.stringify({
      time: {
        created: "2025-01-01T00:00:00.000Z",
        modified: "2026-11-15T00:00:00.000Z",
        "1.50.0": "2026-09-01T10:00:00.000Z",
        "1.51.0": "2026-11-01T10:00:00.000Z",
        "1.52.0-alpha-2026-11-14": "2026-11-14T10:00:00.000Z",
        // unpublished: npm keeps its time but not the version
        "1.53.0": "2026-11-02T10:00:00.000Z",
      },
      versions: { "1.50.0": {}, "1.51.0": {}, "1.52.0-alpha-2026-11-14": {} },
    });
    const got = await releasesOf(pin, serve("https://registry.npmjs.org/@playwright/mcp", body));
    expect(got).toEqual([
      { version: "1.50.0", published: "2026-09-01T10:00:00.000Z" },
      { version: "1.51.0", published: "2026-11-01T10:00:00.000Z" },
    ]);
  });

  test("releasesOf: node は固定の major の LTS だけで security を持つ", async () => {
    const pin: Pin = { name: "NODE_VERSION", pinned: "24.1.0", source: { kind: "node" } };
    const body = JSON.stringify([
      { version: "v25.0.0", date: "2026-10-20", lts: false },
      { version: "v24.3.0", date: "2026-11-10", lts: "Krypton", security: true },
      { version: "v24.2.0", date: "2026-10-15", lts: "Krypton", security: false },
      { version: "v22.9.0", date: "2026-11-11", lts: "Jod", security: true },
      { version: "v24.4.0", date: "2026-11-18", lts: false },
    ]);
    const got = await releasesOf(pin, serve("https://nodejs.org/dist/index.json", body));
    expect(got).toEqual([
      { version: "24.3.0", published: "2026-11-10T23:59:59.999Z", security: true },
      { version: "24.2.0", published: "2026-10-15T23:59:59.999Z" },
    ]);
    // the day alone is read as its end: released late on 11-10, it is not 2 days old at 11-12 00:00
    expect(pickAged(got, "24.1.0", new Date("2026-11-12T00:00:00Z"))?.version).toBe("24.2.0");
    expect(pickAged(got, "24.1.0", new Date("2026-11-13T00:00:00Z"))?.version).toBe("24.3.0");
  });

  test("releasesOf: 読めない応答は throw", async () => {
    const gh: Pin = { name: "UV_VERSION", pinned: "0.5.0", source: { kind: "github", repo: "astral-sh/uv" } };
    const npm: Pin = { name: "PLAYWRIGHT_VERSION", pinned: "1.50.0", source: { kind: "npm", pkg: "playwright" } };
    const docker: Pin = { name: "DOCKER_VERSION", pinned: "29.9.0", source: { kind: "docker" } };
    const node: Pin = { name: "NODE_VERSION", pinned: "24.1.0", source: { kind: "node" } };
    const down = async () => {
      throw new Error("download.docker.com answered 503");
    };
    await expect(releasesOf(docker, down)).rejects.toThrow("503");
    await expect(releasesOf(gh, async () => "not json")).rejects.toThrow();
    await expect(releasesOf(gh, async () => JSON.stringify({ message: "API rate limit exceeded" }))).rejects.toThrow("版の一覧が読めない");
    await expect(releasesOf(gh, async () => "[]")).rejects.toThrow("版が 1 つも無い");
    await expect(releasesOf(gh, async () => JSON.stringify([{ tag_name: "v0.6.0", published_at: "yesterday" }]))).rejects.toThrow("公開日が読めない");
    await expect(releasesOf(npm, async () => "{}")).rejects.toThrow("time が読めない");
    await expect(releasesOf(npm, async () => JSON.stringify({ time: { "1.50.0": "2026-09-01T10:00:00.000Z" } }))).rejects.toThrow("versions が読めない");
    await expect(releasesOf(docker, async () => "<html>nothing</html>")).rejects.toThrow("版が 1 つも無い");
    await expect(
      releasesOf(docker, async () => '<a href="docker-29.9.0.tgz">x</a> 2026-10-01 03:04:05\n<a href="docker-29.10.0.tgz">x</a> -'),
    ).rejects.toThrow("日時が読めない行");
    await expect(releasesOf(node, async () => JSON.stringify([{ version: "v24.1.0", date: "soon", lts: "Krypton" }]))).rejects.toThrow("公開日が読めない");
  });
});
