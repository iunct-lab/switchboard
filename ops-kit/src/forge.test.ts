// test-reads: ops.config.json
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SERVICE, forgeOf, LOCAL_SERVICE, forgeTargetOf, ForgeRefused, remoteOf, ForgeUnsupported, runForgeOperation, textsOf, type ForgeImpl, type ForgeOperation, type ForgeTarget } from "./forge.ts";
import { githubForge } from "./forge-github.ts";
import { appForge } from "./forge-app.ts";

// The forge operations: the service is picked by the target, what is not supported is said, nothing that signs in goes out.

const github: ForgeTarget = { service: "github", host: "github.com", repository: "example/app" };

describe("forge", () => {
  test("an operation runs on its target's service with its host and repository; another service's entry is not asked", async () => {
    const seen: string[] = [];
    const impl = (name: string): ForgeImpl<string, string> => ({ comment: async (op) => (seen.push(`${name} ${op.target.host} ${op.target.repository} ${op.payload}`), name) });
    const services = { github: impl("github"), gitlab: impl("gitlab") };
    expect(await runForgeOperation({ kind: "comment", target: github, payload: "a" }, services)).toBe("github");
    expect(await runForgeOperation({ kind: "comment", target: { service: "github", host: "ghe.example.com", repository: "corp/app" }, payload: "b" }, services)).toBe("github");
    expect(await runForgeOperation({ kind: "comment", target: { service: "gitlab", host: "gitlab.example.com", repository: "group/app" }, payload: "c" }, services)).toBe("gitlab");
    expect(seen).toEqual(["github github.com example/app a", "github ghe.example.com corp/app b", "gitlab gitlab.example.com group/app c"]);
  });

  test("a service not supported, or an operation its entry does not have, is said — never run some other way", async () => {
    let ran = 0;
    const services: Record<string, ForgeImpl<null, void>> = { github: { read: async () => void ran++ } };
    const op = (over: Partial<ForgeOperation<null>>): ForgeOperation<null> => ({ kind: "read", target: github, payload: null, ...over });
    await expect(runForgeOperation(op({ target: { ...github, service: "gitlab" } }), services)).rejects.toThrow(new ForgeUnsupported("サービス gitlab には対応していません（対応: github）"));
    await expect(runForgeOperation(op({ kind: "verification" }), services)).rejects.toThrow("サービス github の verification には対応していません");
    // an inherited name is not a service
    await expect(runForgeOperation(op({ target: { ...github, service: "toString" } }), services)).rejects.toBeInstanceOf(ForgeUnsupported);
    expect(ran).toBe(0);
  });

  test("what would go out is checked right before it is sent: a value that signs in is refused and the service is not asked", async () => {
    let sent = 0;
    const services = { github: { comment: async () => void sent++ } };
    const token = "ghp_" + "a".repeat(36);
    await expect(runForgeOperation({ kind: "comment", target: github, texts: ["本文", `x ${token}`], payload: null }, services)).rejects.toBeInstanceOf(ForgeRefused);
    // the host's AWS names count as the kit's other checks do
    await expect(runForgeOperation({ kind: "comment", target: github, texts: ["profile example-admin"], payload: null }, services, { names: ["example-admin"], accountIds: [] })).rejects.toBeInstanceOf(ForgeRefused);
    const id = ["8642", "9753", "1086"].join("");
    await expect(runForgeOperation({ kind: "comment", target: github, texts: [`[local-ci] pass ${id}`], payload: null }, services, { names: [], accountIds: [id] })).rejects.toBeInstanceOf(ForgeRefused);
    expect(sent).toBe(0);
    await runForgeOperation({ kind: "comment", target: github, texts: ["本文"], payload: null }, services);
    expect(sent).toBe(1);
    expect(textsOf({ title: "t", labels: { add: ["a"], remove: [] }, n: 3, fields: { Status: "Ready" } })).toEqual(["t", "a", "Ready"]);
  });

  test("forgeOf reads `forge` of the repository's ops.config.json; none is GitHub; a malformed one is said", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit-forge-"));
    try {
      // a checkout with an origin (none: forgeOf of a checkout without a remote, below)
      Bun.spawnSync(["git", "init", "-q", dir]);
      Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", "https://github.com/example/app.git"]);
      expect(forgeOf(dir)).toBe(DEFAULT_SERVICE);
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ envPrefix: "X" }));
      expect(forgeOf(dir)).toBe("github");
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ forge: { service: "gitlab", host: "gitlab.example.com", project: "group/app" } }));
      expect(forgeOf(dir)).toBe("gitlab");
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ forge: { service: "gitlab" } }));
      expect(() => forgeOf(dir)).toThrow(/forge が不正です: host: gitlab には host が要ります/);
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ forge: { service: "github", host: "ghe.example.com" } }));
      expect(() => forgeOf(dir)).toThrow(/forge が不正です/);
      expect(forgeOf(join(import.meta.dir, "../.."))).toBe("github");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GitLab's target is the host and project its forge names, only when the checkout's origin is that project", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit-forge-"));
    try {
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ forge: { service: "gitlab", host: "gitlab.example.com", project: "Group/Sub/App" } }));
      const lab = { service: "gitlab", host: "gitlab.example.com", repository: "Group/Sub/App" };
      for (const origin of ["https://gitlab.example.com/Group/Sub/App.git", "git@gitlab.example.com:group/sub/app.git", "ssh://git@gitlab.example.com:2222/Group/Sub/App", "https://oauth2@gitlab.example.com/Group/Sub/App/"])
        expect(forgeTargetOf(dir, origin)).toEqual(lab);
      // another host (GitHub's), another project, or no origin: nothing is sent, and the remote is not changed
      expect(() => forgeTargetOf(dir, "https://github.com/Group/App.git")).toThrow("origin（github.com/Group/App）が forge の gitlab.example.com/Group/Sub/App と違うので GitLab に送りません");
      expect(() => forgeTargetOf(dir, "git@gitlab.example.com:group/other.git")).toThrow(ForgeUnsupported);
      expect(() => forgeTargetOf(dir, "https://gitlab.example.com.evil.test/Group/Sub/App.git")).toThrow(ForgeUnsupported);
      expect(() => forgeTargetOf(dir, null)).toThrow("origin（無し）");
      // GitHub's is found as before: the host gh uses, the repository from the checkout
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({}));
      expect(forgeTargetOf(dir, "https://gitlab.example.com/Group/Sub/App.git")).toEqual({ service: "github", host: process.env.GH_HOST || "github.com", repository: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(remoteOf("/srv/git/app.git")).toBeNull();
    expect(remoteOf("git@host:/abs/path")).toBeNull();
  });

  test("GitHub's verification posts the pass on the PR as `gh pr comment` did; another host is named in -R", async () => {
    const calls: string[][] = [];
    const impl = githubForge(async (cmd) => (calls.push(cmd), ""));
    await runForgeOperation({ kind: "verification", target: github, payload: { pr: 7, body: "[local-ci] pass abc" } }, { github: impl });
    await runForgeOperation({ kind: "verification", target: { ...github, host: "ghe.example.com" }, payload: { pr: 8, body: "b" } }, { github: impl });
    expect(calls).toEqual([
      ["gh", "pr", "comment", "7", "-R", "example/app", "--body", "[local-ci] pass abc"],
      ["gh", "pr", "comment", "8", "-R", "ghe.example.com/example/app", "--body", "b"],
    ]);
    await expect(runForgeOperation({ kind: "verification", target: { ...github, repository: null }, payload: { pr: 9, body: "c" } }, { github: impl })).rejects.toThrow("リポジトリ");
  });

  test("a checkout with no origin and no forge is the app; a forge named still wins; forgeTargetOf stays GitHub", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit-forge-local-"));
    try {
      Bun.spawnSync(["git", "init", "-q", dir]);
      expect(forgeOf(dir)).toBe(LOCAL_SERVICE);
      expect(LOCAL_SERVICE).toBe("app");
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ envPrefix: "X" }));
      expect(forgeOf(dir)).toBe("app");
      expect(forgeTargetOf(dir, null).service).toBe("github");
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ forge: { service: "github" } }));
      expect(forgeOf(dir)).toBe("github");
      // an origin with forge naming the app: the app's too
      Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", "https://github.com/example/app.git"]);
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ forge: { service: LOCAL_SERVICE } }));
      expect(forgeOf(dir)).toBe(LOCAL_SERVICE);
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ envPrefix: "X" }));
      expect(forgeOf(dir)).toBe("github");
      writeFileSync(join(dir, "ops.config.json"), "{");
      expect(() => forgeOf(dir)).toThrow(ForgeUnsupported);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the app's verification is a comment on the change through the app's API; without the app it fails, nothing sent", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const fetch = async (url: string, init: RequestInit = {}) => {
      const path = url.replace("http://app/api/backlog", "");
      calls.push({ method: init.method ?? "GET", path, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(path === "/syncs" ? { syncs: [{ workspaceId: "ws_l", backlog: "local", repository: "ws_l", syncedAt: 1, syncing: false, sync: { state: "synced", reason: null, pendingCount: 0 } }], items: [] } : { id: "c" }), { status: path === "/syncs" ? 200 : 202 });
    };
    const target = { service: LOCAL_SERVICE, host: "local", repository: "ws_l" };
    const env = { BACKLOG_URL: "http://app/api/backlog", BACKLOG_WORKSPACE: "ws_l" };
    await runForgeOperation({ kind: "verification", target, texts: ["[local-ci] pass"], payload: { pr: 7, body: "[local-ci] pass" } }, { [LOCAL_SERVICE]: appForge(env, fetch) });
    expect(calls.at(-1)).toEqual({ method: "POST", path: "/7/comment", body: { workspaceId: "ws_l", text: "[local-ci] pass" } });
    calls.length = 0;
    await expect(runForgeOperation({ kind: "verification", target, payload: { pr: 7, body: "x" } }, { [LOCAL_SERVICE]: appForge({}, fetch) })).rejects.toThrow("BACKLOG_URL と BACKLOG_WORKSPACE");
    expect(calls).toEqual([]);
  });
});
