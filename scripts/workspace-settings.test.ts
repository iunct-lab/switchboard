// test-reads: none
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_CONFIG_DIR, WORKSPACE_CONFIG_INDEX, workspaceSettingsOf } from "./workspace-settings.ts";

const W = mkdtempSync(join(tmpdir(), "switchboard.workspace-settings."));
afterAll(() => rmSync(W, { recursive: true, force: true }));

test("the settings of a clone's workspace: the file the app names inside a Task, else found in the daemon's index by the clone's folder or the main work tree of a worktree", () => {
  const home = join(W, "home");
  const repo = join(W, "lib");
  const file = join(home, WORKSPACE_CONFIG_DIR, "ws_1", "ops.config.json");
  mkdirSync(join(home, WORKSPACE_CONFIG_DIR, "ws_1"), { recursive: true });
  mkdirSync(repo);
  Bun.spawnSync(["git", "init", "-q", repo]);
  Bun.spawnSync(["git", "-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgSign=false", "commit", "-q", "--allow-empty", "-m", "x"]);
  const wt = join(W, "lib-wt");
  Bun.spawnSync(["git", "-C", repo, "worktree", "add", "-q", "--detach", wt]);
  writeFileSync(file, '{"ci":{"steps":[{"run":"make"}]}}');
  const index = (workspaces: unknown) => writeFileSync(join(home, WORKSPACE_CONFIG_DIR, WORKSPACE_CONFIG_INDEX), JSON.stringify({ workspaces }));
  const env = { SWITCHBOARD_HOME: home };
  // no index yet: none
  expect(workspaceSettingsOf(repo, env)).toBeUndefined();
  index([{ id: "ws_1", name: "lib", path: repo, file }, { id: "ws_2", name: "other", path: join(W, "other"), file: join(home, "nope.json") }]);
  // outside a Task: by the folder, and from a worktree of the same clone
  expect(workspaceSettingsOf(repo, env)).toEqual({ name: "lib", file });
  expect(workspaceSettingsOf(wt, env)).toEqual({ name: "lib", file });
  // another clone has none; an entry whose file is gone is none
  expect(workspaceSettingsOf(W, env)).toBeUndefined();
  expect(workspaceSettingsOf(join(W, "other"), env)).toBeUndefined();
  // inside a Task or a job: the file the app names (the variable the kit reads), named by the index
  const other = join(W, "elsewhere");
  mkdirSync(other);
  expect(workspaceSettingsOf(other, { ...env, OPS_KIT_CONFIG: file })).toEqual({ name: "lib", file });
  // a named file that is gone is none (the checkout's own files decide then), and it is not looked up by folder instead
  expect(workspaceSettingsOf(repo, { ...env, OPS_KIT_CONFIG: join(home, "gone.json") })).toBeUndefined();
  // an index that cannot be read is none
  writeFileSync(join(home, WORKSPACE_CONFIG_DIR, WORKSPACE_CONFIG_INDEX), "{");
  expect(workspaceSettingsOf(repo, env)).toBeUndefined();
});

test("the daemon's writer and this reader agree on the place and the index's shape", async () => {
  const core = await import("../packages/core/src/workspace-config.ts");
  expect([core.WORKSPACE_CONFIG_DIR, core.WORKSPACE_CONFIG_INDEX]).toEqual([WORKSPACE_CONFIG_DIR, WORKSPACE_CONFIG_INDEX]);
  const home = join(W, "home2");
  const repo = join(W, "app");
  mkdirSync(repo);
  core.writeWorkspaceConfigs(home, [{ id: "ws_9", name: "app", path: repo, kind: "repo", createdAt: 0, backlog: "github", sweep: { implement: 1, plan: 1 }, allocation: { share: null, mode: "continuing" }, issueArtifacts: false, config: '{"ci":{"steps":[{"run":"make"}]}}\n' }]);
  expect(workspaceSettingsOf(repo, { SWITCHBOARD_HOME: home })).toEqual({ name: "app", file: core.workspaceConfigFile(home, "ws_9") });
});
