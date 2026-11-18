// test-reads: packages/core/fixtures/ ops.config.json scripts/parallel-guard.ts ops-kit/processes/p0-pipeline.md
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backlog } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";
import { importing } from "../fixtures/github-import.ts";
import { otherRepoRules } from "./backlog-prompt.ts";
import { type GhRunner, projectOf } from "./backlog-gh.ts";
import { FAKE_ORIGIN, boot, fakeGh, refreshed, useBacklogDaemon } from "./api-test-harness.ts";

let core: CoreServer | undefined;
let home: string | undefined;
/** The open PRs of the fake GitHub: `{ number, files, labels?, isDraft?, headRefName?, body? }`. */
let openPulls: Array<Record<string, unknown>> = [];
useBacklogDaemon({ get core() { return core; }, set core(v) { core = v; }, get home() { return home; }, set home(v) { home = v; }, get openPulls() { return openPulls; }, set openPulls(v) { openPulls = v; } });

test("a workspace names the repository variable its Project URL is under (PATCH /api/workspaces/:id); unset = SWITCHBOARD_PROJECT_URL (kind project-var)", async () => {
  const fake = fakeGh();
  const gh: GhRunner = async (args, cwd) => {
    if (args[0] === "variable" && args[2] !== "CAPSULE_PROJECT_URL") return { code: 1, stdout: "", stderr: `variable ${args[2]} was not found` };
    return fake.gh(args, cwd);
  };
  const base = await boot(gh);
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const before = await fetch(`${base}/api/backlog`).then((r) => r.json()) as Backlog;
  expect(before.items).toEqual([]);
  expect(before.errors[0]?.message).toContain("SWITCHBOARD_PROJECT_URL was not found");
  expect(before.errors[0]?.kind).toBe("project-var");

  const patch = (body: unknown) => fetch(`${base}/api/workspaces/${meta.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await patch({ projectVar: "not a name" })).status).toBe(400);
  expect((await patch({ projectVar: 7 })).status).toBe(400);
  expect((await fetch(`${base}/api/workspaces/ws_nope`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(404);
  const saved = await patch({ projectVar: " CAPSULE_PROJECT_URL " });
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as { projectVar?: string }).projectVar).toBe("CAPSULE_PROJECT_URL");
  expect(core!.db.getWorkspace(meta.id)?.projectVar).toBe("CAPSULE_PROJECT_URL");

  // the environment's SWITCHBOARD_PROJECT_URL applies to every workspace; a workspace that names its variable keeps it
  process.env.SWITCHBOARD_PROJECT_URL = "https://github.com/users/acme/projects/99";
  const after = await fetch(`${base}/api/backlog`).then((r) => r.json()) as Backlog;
  expect(after.errors).toEqual([]);
  expect(after.items.map((i) => i.number)).toContain(305); // Project 11's fields, from CAPSULE_PROJECT_URL
  expect(after.items.find((i) => i.number === 305)).toMatchObject({ priority: "P0" });
  expect(fake.calls.filter((a) => a[0] === "variable").map((a) => a[2])).toEqual(["CAPSULE_PROJECT_URL"]);

  // null or empty goes back to SWITCHBOARD_PROJECT_URL
  expect(((await (await patch({ projectVar: null })).json()) as { projectVar?: string }).projectVar).toBeUndefined();
  expect(core!.db.getWorkspace(meta.id)?.projectVar).toBeUndefined();
  await patch({ projectVar: "CAPSULE_PROJECT_URL" });
  expect(((await (await patch({ projectVar: "  " })).json()) as { projectVar?: string }).projectVar).toBeUndefined();
});

describe("otherRepoRules: the scripts/setup of the repository", () => {
  const rules = (setup: { config: boolean; kit: string[]; copies: string[]; saved?: boolean }) => otherRepoRules({ meta: "/work/switchboard", projectVar: "LIB_URL", setup }, { merges: true });
  // local-ci once on the top of a stack: the rule's place in the meta's docs
  const kept = ["--repo <このリポジトリの owner/name>", "`bun /work/switchboard/scripts/local-ci.ts <PR> --repo", "回すのはスタックの一番上で 1 回", "`/work/switchboard/docs/merge-gate.md` の「When to run local CI and how it counts」"];

  test("otherRepoRules: its own entries and ops.config.json are used, with OPS_KIT; no Project URL variable is handed over", () => {
    const r = rules({ config: true, kit: ["lint_backlog.sh"], copies: [] });
    expect(r).toContain("運用ツール（`scripts/setup/` の lint_backlog.sh）はこのリポジトリの入口を使ってください");
    expect(r).toContain("`OPS_KIT=/work/switchboard/ops-kit`");
    expect(r).not.toContain("SWITCHBOARD_PROJECT_URL=$(gh variable get");
    for (const k of kept) expect(r).toContain(k);
  });

  test("otherRepoRules: without its own kit entries the scripts are the meta's, with the Project URL", () => {
    const r = rules({ config: false, kit: [], copies: [] });
    expect(r).toContain("はこのリポジトリには無く");
    expect(r).toContain("SWITCHBOARD_PROJECT_URL=$(gh variable get LIB_URL)");
    expect(r).not.toContain("写し");
    for (const k of kept) expect(r).toContain(k);
  });

  test("otherRepoRules: a repository with no ops.config.json whose settings are kept on Switchboard's side is told the tools already read them, and not to add the file", () => {
    const r = rules({ config: false, kit: [], copies: [], saved: true });
    expect(r).toContain("設定（`ops.config.json` と同じ形: CI の手順・Project のフィールド・必須の節など）は Switchboard の側にあり、アプリが環境変数 `OPS_KIT_CONFIG` でそのファイルを渡しています");
    expect(r).toContain("このリポジトリに `ops.config.json` を作らない・コミットしない");
    for (const k of kept) expect(r).toContain(k);
    // none saved, or the repository has its own file: no such line
    for (const setup of [{ config: false, kit: [], copies: [] }, { config: true, kit: ["lint_backlog.sh"], copies: [] }]) expect(rules(setup)).not.toContain("OPS_KIT_CONFIG");
  });

  test("otherRepoRules: a copy is not used; the meta's entry of the same name is, with the Project URL", () => {
    const r = rules({ config: false, kit: [], copies: ["lint_backlog.sh"] });
    expect(r).toContain("`scripts/setup/` の lint_backlog.sh は共通キットを呼ばない写しなので使わない");
    expect(r).toContain("/work/switchboard の `scripts/setup/` の同じ名前の入口に `SWITCHBOARD_PROJECT_URL=$(gh variable get LIB_URL)` を付けて使う");
    for (const k of kept) expect(r).toContain(k);
  });
});

test("projectOf: the settings the checkout is run with name the Project before the repository variable is asked; a workspace's own variable still wins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-backlog-projecturl-"));
  const asked: string[][] = [];
  const gh: GhRunner = async (args) => (asked.push(args), { code: 0, stdout: "https://github.com/users/me/projects/3\n", stderr: "" });
  const env = process.env.SWITCHBOARD_PROJECT_URL;
  delete process.env.SWITCHBOARD_PROJECT_URL;
  try {
    writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ projectUrl: "https://github.com/orgs/acme/projects/7" }));
    expect(await projectOf(gh, { path: dir })).toEqual({ owner: "acme", number: 7 });
    expect(asked).toEqual([]);
    expect(await projectOf(gh, { path: dir, projectVar: "LIB_URL" })).toEqual({ owner: "me", number: 3 });
    rmSync(join(dir, "ops.config.json"));
    expect(await projectOf(gh, { path: dir })).toEqual({ owner: "me", number: 3 });
    expect(asked.map((a) => a.slice(0, 3).join(" "))).toEqual(["variable get LIB_URL", "variable get SWITCHBOARD_PROJECT_URL"]);
  } finally {
    if (env !== undefined) process.env.SWITCHBOARD_PROJECT_URL = env;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("otherRepoRules: after a merge the Task tags it with release-tag.ts --repo; local-ci.ts runs with --repo", () => {
  const rules = otherRepoRules({ meta: "/work/switchboard", setup: { config: false, kit: [], copies: [] } }, { merges: true });
  expect(rules).toContain("`bun /work/switchboard/scripts/release-tag.ts --pr <PR> --repo <このリポジトリの owner/name>`");
  expect(rules).not.toContain("rev-parse origin/main");
  expect(rules).toContain("`bun /work/switchboard/scripts/rollback-pr.ts <tag> --repo <このリポジトリの owner/name>`");
  expect(rules).toContain("`bun /work/switchboard/scripts/local-ci.ts <PR> --repo <このリポジトリの owner/name>`");
  expect(rules.match(/[^。]*実行しない/g)).toBeNull();
});

test("PATCH /api/workspaces/:id: the same projectVar keeps the stored backlog; another one forgets it and imports again", async () => {
  const fake = fakeGh();
  const base = await boot(fake.gh);
  const meta = core!.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const patch = (projectVar: string | null) => fetch(`${base}/api/workspaces/${meta.id}`, { method: "PATCH", body: JSON.stringify({ projectVar }) });
  const source = core!.db.getWorkspaceBacklogSource(meta.id);
  expect(source).not.toBeNull();
  await patch(null); // unset, as it was
  expect(core!.db.getWorkspaceBacklogSource(meta.id)).toEqual(source);
  const before = fake.calls.length;
  await patch("OTHER_PROJECT_URL");
  // the PATCH itself asks for the import (before any look at the backlog)
  for (let i = 0; fake.calls.length === before && i < 100; i++) await Bun.sleep(10);
  expect(fake.calls.length).toBeGreaterThan(before);
  const after = await refreshed(base, false);
  expect(core!.db.getWorkspaceBacklogSource(meta.id)).toEqual(source); // imported again: the fake answers the same Project
  expect(after.items.length).toBeGreaterThan(0);
});

test("a workspace registered over the API and given its projectVar is in GET /api/backlog with no errors, even with 0 Issues", async () => {
  const fake = fakeGh();
  // a Project with no Issue yet: the same answers, an empty page for the GraphQL reads
  const gh: GhRunner = async (args, cwd) => {
    if (args[0] === "api" && args.some((a) => a.includes("issues("))) return { code: 0, stdout: JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }), stderr: "" };
    return fake.gh(args, cwd);
  };
  const base = await boot(gh);
  const seen: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${core!.server.port}/ws`);
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)) as { type: string }; if (m.type === "workspaces.updated") seen.push(m.type); };
  await new Promise<void>((r) => (ws.onopen = () => r()));
  const dir = mkdtempSync(join(home!, "new-"));
  Bun.spawnSync(["git", "init", "-q", dir]);
  const created = (await (await fetch(`${base}/api/workspaces`, { method: "POST", body: JSON.stringify({ path: dir, name: "fresh" }) })).json()) as { id: string };
  for (let i = 0; seen.length < 1 && i < 100; i++) await Bun.sleep(10);
  expect(seen).toHaveLength(1);
  expect((await fetch(`${base}/api/workspaces/${created.id}`, { method: "PATCH", body: JSON.stringify({ projectVar: "FRESH_PROJECT_URL" }) })).status).toBe(200);
  for (let i = 0; seen.length < 2 && i < 100; i++) await Bun.sleep(10);
  expect(seen).toHaveLength(2);
  const after = await refreshed(base, false);
  ws.close();
  expect(after.errors.filter((e) => e.workspaceId === created.id)).toEqual([]);
  expect(after.syncs.find((s) => s.workspaceId === created.id)).toMatchObject({ syncing: false, syncedAt: expect.any(Number), sync: expect.objectContaining({ state: expect.not.stringMatching(/^error$/) }) });
  expect(after.items.filter((i) => i.workspaceId === created.id)).toEqual([]);
});

test("GET /api/backlog before the first import: no items, the workspace in errors and its import under way — never an empty list as if read", async () => {
  const ok = fakeGh();
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const gh: GhRunner = async (args, cwd) => {
    if (args[0] === "api") await held; // GitHub has not answered yet
    return ok.gh(args, cwd);
  };
  home = mkdtempSync(join(tmpdir(), "sb-backlog-"));
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: join(home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [], { port: 0, selfdevChecks: false, dryRunRestart: true, gitOrigin: FAKE_ORIGIN, gh: importing(gh) });
  const base = `http://127.0.0.1:${core.server.port}`;
  const meta = core.db.listWorkspaces().find((w) => w.kind === "meta")!;
  const first = await (await fetch(`${base}/api/backlog`)).json() as Backlog;
  expect(first.items).toEqual([]);
  expect(first.errors).toEqual([{ workspaceId: meta.id, workspaceName: meta.name, message: "まだ GitHub から取り込んでいません", kind: "other" }]);
  expect(first.syncs).toEqual([{ workspaceId: meta.id, backlog: "github", enabling: null, repository: null, syncing: true, syncedAt: null, creates: [], issues: [], sync: expect.objectContaining({ state: "error", reason: "unfetched", lastSuccessfulSync: null }) }]);
  // an answer or a start has nothing stored to check against: 424, nothing written
  const answer = await fetch(`${base}/api/backlog/306/answer`, { method: "POST", body: JSON.stringify({ workspaceId: meta.id, text: "A" }) });
  expect(answer.status).toBe(424);
  release();
  const after = await refreshed(base, false);
  expect(after.errors).toEqual([]);
  expect(after.items.length).toBeGreaterThan(0);
});
