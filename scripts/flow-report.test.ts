// test-reads: scripts/flow-report.ts
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "flow-report-test."));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const report = async (args: string[], env: Record<string, string | undefined> = {}) => {
  const clean = { ...process.env, SWITCHBOARD_HOME: home, BACKLOG_URL: undefined, BACKLOG_WORKSPACE: undefined, GH_REPO: undefined, ...env };
  const p = Bun.spawn(["bun", join(import.meta.dir, "flow-report.ts"), ...args], { env: clean, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, stdout, stderr };
};

describe("flow-report's entry exits 2", () => {
  test("on bad arguments, with the usage", async () => {
    const r = await report(["--days", "0"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage: bun scripts/flow-report.ts");
    expect(r.stderr).toContain("--repo はアプリに取り込まれたリポジトリだけ");
  });

  test("without BACKLOG_URL: the stored values cannot be read", async () => {
    const r = await report(["--days", "7"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("アプリの保存値を読めません");
    expect(r.stderr).toContain("BACKLOG_URL がありません");
  });

  test("--repo on a backlog kept in the app only: no workspace has that repository", async () => {
    using app = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ syncs: [{ workspaceId: "ws_local", repository: null, syncedAt: "2026-10-30T00:00:00.000Z", sync: { state: "ok" } }] }) });
    const r = await report(["--days", "7", "--repo", "acme/widgets"], { BACKLOG_URL: `http://127.0.0.1:${app.port}/api/backlog`, BACKLOG_WORKSPACE: "ws_local" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("acme/widgets のバックログはアプリに取り込まれていません");
  });
});

describe("flow-report's review-rounds table", () => {
  const bin = join(home, "bin");
  const fixture = join(import.meta.dir, "review-rounds.fixture.json");

  /** A `gh` first on PATH: the rate limit, no merged PR, and the fixture's comments (PR 5845's again as PRs 9001 and 9002); with `broken` every call fails. */
  const fakeGh = (broken: boolean) => {
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gh"), String.raw`#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
if (${broken}) { console.error("HTTP 502\n{\n  \"message\": \"Bad Gateway\"\n}"); process.exit(1); }
const fx = JSON.parse(readFileSync(${JSON.stringify(fixture)}, "utf8"));
const copies = (xs) => [...xs, ...xs.filter((c) => c.pr === 5845).flatMap((c) => [9001, 9002].map((pr) => ({ ...c, pr })))];
const issue = copies(fx.issue), inline = copies(fx.inline);
const lines = (xs) => xs.map((x) => JSON.stringify(x)).join("\n");
const path = args.find((a) => a.startsWith("repos/")) ?? "";
if (args.includes("rate_limit")) console.log("1000000000");
else if (args.includes("search/issues")) console.log("page false 0");
else if (path === "repos/o/r/issues/comments") console.log(lines(issue.map((c) => ({ ...c, issue_url: "https://api.github.com/repos/o/r/issues/" + c.pr, html_url: "https://github.com/o/r/pull/" + c.pr }))));
else if (path === "repos/o/r/pulls/comments") console.log(lines(inline.map((c) => ({ ...c, pull_request_url: "https://api.github.com/repos/o/r/pulls/" + c.pr }))));
else if (/^repos\/o\/r\/issues\/\d+\/comments$/.test(path)) console.log(lines(issue.filter((c) => path.includes("/" + c.pr + "/"))));
else if (/^repos\/o\/r\/pulls\/\d+$/.test(path)) console.log(JSON.stringify({ merged_at: "2026-11-19T22:31:00Z", head: { sha: "2d24ee961c492c29cd2f1f25ca78c8b2f1591770" } }));
else if (path === "repos/o/r/commits") console.log("");
else { console.error("unexpected: " + args.join(" ")); process.exit(1); }
`);
    chmodSync(join(bin, "gh"), 0o755);
  };

  /** The app as flow-report asks it: one imported workspace for `o/r` with no PBI closed (so the PR stages read nothing). */
  const app = () => Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: (req) => new URL(req.url).pathname.endsWith("/syncs")
      ? Response.json({ syncs: [{ workspaceId: "ws_1", repository: "o/r", syncedAt: "2026-11-20T00:00:00.000Z", sync: { state: "ok" } }] })
      : Response.json({ workspaceId: "ws_1", service: "github", repository: "o/r", project: { owner: "o", number: 1 }, fetchedAt: 0, top: [], issues: [], comments: [], unread: [], pulls: [] }),
  });
  const run = (server: { port: number | undefined }, extra: string[] = []) =>
    report(["--days", "3650", "--repo", "o/r", ...extra], { BACKLOG_URL: `http://127.0.0.1:${server.port}/api/backlog`, PATH: `${bin}:${process.env.PATH}` });

  test("prints the table and the candidates after the Story Points table, and --json keeps its keys and adds reviews", async () => {
    fakeGh(false);
    using server = app();
    const out = join(home, "flow.json");
    const r = await run(server, ["--json", out]);
    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n");
    const table = lines.findIndex((l) => l.startsWith("決まり\t"));
    expect(lines.findIndex((l) => l.startsWith("SP\t"))).toBeLessThan(table);
    expect(lines.slice(table + 1).filter((l) => l.startsWith("review\t") || l.startsWith("size\t") || l.startsWith("responsibility\t"))).toHaveLength(3);
    // PR 5845's rounds three times over: the review and the size recheck went 3+ PRs, 2+ rounds, fixing under 1 a round
    expect(lines.filter((l) => l.startsWith("見直しの候補:")).map((l) => l.split("（")[0])).toEqual(["見直しの候補: size", "見直しの候補: review"]);
    expect(lines.find((l) => l.startsWith("見直しの候補: size"))).toContain("PR 3 件、往復の中央値 6、18 回で指摘 237 件・修正 0 件");
    const json = JSON.parse(readFileSync(out, "utf8"));
    expect(Object.keys(json)).toEqual(expect.arrayContaining(["bottleneck", "closed", "stages", "pbis", "reviews"]));
    expect(json.reviews.candidates.map((c: { rule: string }) => c.rule)).toEqual(["size", "review"]);
    expect(json.reviews.rows.map((x: { rule: string }) => x.rule)).toEqual(expect.arrayContaining(["review", "size", "responsibility", "direct"]));
  });

  test("a table that cannot be read is one line, and the exit code stays 0 (null in --json)", async () => {
    fakeGh(true);
    using server = app();
    const out = join(home, "flow-broken.json");
    const r = await run(server, ["--json", out]);
    expect(r.code).toBe(0);
    // a multi-line error of gh stays on one line
    expect(r.stdout.split("\n").filter((l) => l.startsWith("レビューと再チェック: 読めなかった（")).every((l) => l.endsWith("）"))).toBe(true);
    expect(r.stdout).toContain("レビューと再チェック: 読めなかった（");
    expect(r.stdout).not.toContain("見直しの候補");
    expect(JSON.parse(readFileSync(out, "utf8")).reviews).toBeNull();
  });
});
