import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "flow-report-test."));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const report = async (args: string[], env: Record<string, string | undefined> = {}) => {
  const clean = { ...process.env, SWITCHBOARD_HOME: home, BACKLOG_URL: undefined, BACKLOG_WORKSPACE: undefined, GH_REPO: undefined, ...env };
  const p = Bun.spawn(["bun", join(import.meta.dir, "flow-report.ts"), ...args], { env: clean, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(p.stderr).text();
  return { code: await p.exited, stderr };
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
