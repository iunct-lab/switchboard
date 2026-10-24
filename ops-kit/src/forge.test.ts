import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SERVICE, forgeOf, ForgeRefused, ForgeUnsupported, runForgeOperation, textsOf, type ForgeImpl, type ForgeOperation, type ForgeTarget } from "./forge.ts";
import { githubForge } from "./forge-github.ts";

// The forge operations (#920): the service is picked by the target, what is not supported is said, nothing that signs in goes out.

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
      expect(forgeOf(dir)).toBe(DEFAULT_SERVICE);
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ envPrefix: "X" }));
      expect(forgeOf(dir)).toBe("github");
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ forge: { service: "gitlab" } }));
      expect(forgeOf(dir)).toBe("gitlab");
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ forge: { service: "github", host: "ghe.example.com" } }));
      expect(() => forgeOf(dir)).toThrow(/forge が不正です/);
      expect(forgeOf(join(import.meta.dir, "../.."))).toBe("github");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
});
