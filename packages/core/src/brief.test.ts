import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "bun:test";
import type { Workspace } from "@switchboard/protocol";
import { BRIEF_REQUEST_MARKER, detectChecks, detectRun, workspaceBrief } from "./brief.ts";
import { findRepoRoot } from "./config.ts";

const dirs: string[] = [];
function repo(files: Record<string, string>, dirsToo: string[] = []): string {
  const d = mkdtempSync(join(tmpdir(), "sb-brief-"));
  dirs.push(d);
  for (const sub of dirsToo) mkdirSync(join(d, sub), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(d, rel, ".."), { recursive: true });
    writeFileSync(join(d, rel), body);
  }
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const RUNNERS = ["claude", "codex"] as const;
const ws = (path: string, kind: Workspace["kind"] = "repo", name = "proj"): Workspace => ({ id: "ws_x", name, path, kind, createdAt: 0, backlog: "github", sweep: { implement: 1, plan: 1 } });

describe("workspace brief", () => {
  test("the meta workspace keeps the Switchboard architecture map and this repository's real check commands", () => {
    const text = workspaceBrief(ws(findRepoRoot(import.meta.dir), "meta", "switchboard"), RUNNERS);
    expect(text.startsWith("あなたは Switchboard（このアプリ自身）のリポジトリで作業しています。")).toBe(true);
    expect(text).toContain("packages/adapters/{claude,codex}（");
    expect(text).not.toContain("dak");
    expect(text).toContain("`bun run typecheck`");
    expect(text).toContain("`bun test`");
    expect(text.endsWith(`${BRIEF_REQUEST_MARKER}\n`)).toBe(true);
  });

  test("the adapters in the architecture map are the registered runners, so enabling DAK adds it and disabling removes it", () => {
    const meta = ws(findRepoRoot(import.meta.dir), "meta", "switchboard");
    expect(workspaceBrief(meta, ["claude", "codex", "dak"])).toContain("packages/adapters/{claude,codex,dak}（");
    expect(workspaceBrief(meta, ["claude"])).toContain("packages/adapters/{claude}（");
  });

  test("a repository workspace names itself and its path, never Switchboard", () => {
    const d = repo({ "README.md": "# x" });
    const text = workspaceBrief(ws(d, "repo", "Decentralized-Agent-Kit"), RUNNERS);
    expect(text.startsWith(`あなたは Decentralized-Agent-Kit（${d}）のリポジトリで作業しています。`)).toBe(true);
    expect(text).not.toContain("Switchboard");
    expect(text).toContain("テスト: 変更にはテストを添え、既存テストを壊さないこと。");
    expect(text).not.toContain("起動:");
    expect(text.endsWith(`${BRIEF_REQUEST_MARKER}\n`)).toBe(true);
  });

  test("a DAK-shaped repository: layout, instruction files, pytest via uv, docker compose", () => {
    const d = repo(
      {
        "AGENTS.md": "rules",
        "CLAUDE.md": "rules",
        "docker-compose.yml": "services: {}",
        "uv.lock": "",
        "pyproject.toml": "[project]\nname='dak'\n[tool.pytest.ini_options]\n",
        "node_modules/x.js": "",
        ".env": "",
      },
      ["agent", "bff", "cli", "tests", "dist"],
    );
    const text = workspaceBrief(ws(d), RUNNERS);
    expect(text).toContain("構成: agent/, bff/, cli/, tests/, AGENTS.md, CLAUDE.md, docker-compose.yml, pyproject.toml, uv.lock");
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain(".env");
    expect(text).not.toContain("dist/");
    expect(text).toContain("指示: リポジトリの CLAUDE.md / AGENTS.md に従うこと。");
    expect(text).toContain("テスト: リポジトリ直下で `uv run pytest`。");
    expect(text).toContain("起動: `docker compose up`。");
  });

  test("a symlinked directory is listed as a directory", () => {
    const d = repo({ "README.md": "# x" }, ["real"]);
    require("node:fs").symlinkSync(join(d, "real"), join(d, "linked"));
    expect(workspaceBrief(ws(d), RUNNERS)).toContain("構成: linked/, real/, README.md");
  });

  test("the layout is capped so a wide tree does not swallow the prompt", () => {
    const d = repo({}, Array.from({ length: 20 }, (_, i) => `d${String(i).padStart(2, "0")}`));
    const text = workspaceBrief(ws(d), RUNNERS);
    expect(text).toContain("d13/, …（他 6 件）");
    expect(text).not.toContain("d14/");
  });
});

describe("detectChecks / detectRun", () => {
  test("JS: the package manager comes from the lockfile; only a literal \"bun test\" is shortened, arguments are kept", () => {
    expect(detectChecks(repo({ "package.json": JSON.stringify({ scripts: { test: "bun test", typecheck: "tsc", lint: "eslint ." } }), "bun.lock": "" }))).toEqual(["bun run typecheck", "bun run lint", "bun test"]);
    expect(detectChecks(repo({ "package.json": JSON.stringify({ scripts: { test: "bun test packages apps" } }), "bun.lock": "" }))).toEqual(["bun run test"]);
    expect(detectChecks(repo({ "package.json": JSON.stringify({ scripts: { test: "bun test --preload ./setup.ts" } }), "bunfig.toml": "" }))).toEqual(["bun run test"]);
    // manifests of an unexpected shape are not a crash
    expect(detectChecks(repo({ "package.json": JSON.stringify({ scripts: "npm test" }) }))).toEqual([]);
    expect(detectChecks(repo({ "package.json": JSON.stringify({ scripts: { test: 5, lint: ["x"] } }) }))).toEqual([]);
    expect(detectChecks(repo({ "package.json": "[1,2]" }))).toEqual([]);
    expect(workspaceBrief(ws(repo({ "package.json": JSON.stringify({ scripts: 5 }) })), RUNNERS)).toContain("テスト: 変更にはテストを添え、既存テストを壊さないこと。");
    expect(detectChecks(repo({ "package.json": JSON.stringify({ scripts: { test: "vitest" } }), "pnpm-lock.yaml": "" }))).toEqual(["pnpm run test"]);
    expect(detectChecks(repo({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) }))).toEqual(["npm run test"]);
    expect(detectChecks(repo({ "package.json": JSON.stringify({ scripts: { build: "x" } }) }))).toEqual([]);
    expect(detectChecks(repo({ "package.json": "{not json" }))).toEqual([]);
  });

  test("Python only counts when pytest is configured / depended on or a tests dir is there; Rust, Go and Make are by manifest", () => {
    expect(detectChecks(repo({ "pyproject.toml": "[project]\nname='x'\n" }))).toEqual([]);
    expect(detectChecks(repo({ "pyproject.toml": "[project]\n" }, ["tests"]))).toEqual(["pytest"]);
    expect(detectChecks(repo({ "pyproject.toml": "[project]\ndependencies = [\"pytest>=8\"]\n" }))).toEqual(["pytest"]);
    // a mention is not a suite: an exclude list, a comment, a file named tests
    expect(detectChecks(repo({ "pyproject.toml": "[tool.ruff]\nextend-exclude = ['.pytest_cache']\n# pytest someday\n", tests: "#!/bin/sh\n" }))).toEqual([]);
    expect(detectChecks(repo({ "Cargo.toml": "", "go.mod": "", Makefile: "build:\n\techo\ntest:\n\techo\n" }))).toEqual(["cargo test", "go test ./...", "make test"]);
    expect(detectChecks(repo({ Makefile: "build:\n\techo\n" }))).toEqual([]);
  });

  test("compose file at the root → docker compose up", () => {
    expect(detectRun(repo({ "compose.yaml": "" }))).toBe("docker compose up");
    expect(detectRun(repo({}))).toBeNull();
  });
});
