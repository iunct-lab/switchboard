import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { parseConfig, resolveProject } from "../ops-kit/src/config.ts";
import { fakeGh } from "../ops-kit/src/gh.ts";
import { lint } from "../ops-kit/src/lint.ts";
import { findSecrets } from "../ops-kit/src/secrets.ts";
import { setupScripts } from "../packages/core/src/skillsync.ts";
import { checkoutSteps } from "./local-ci.ts";

/**
 * #1446: ops-kit/template/ filled with made-up values is a repository the shared tools work in. The test copies the
 * template to a temp directory, replaces `__NAME__` with `values`, drops `.tmpl`, and runs the kit's checks on it.
 */
const root = join(import.meta.dir, "..");
const template = join(root, "ops-kit/template");
const values: Record<string, string> = {
  __OWNER__: "example",
  __REPO__: "sample-app",
  __PREFIX__: "SAMPLE",
  __AREA__: "app",
  __TEST_ALL__: "bun test",
  __TEST_TYPECHECK__: "bun run typecheck",
  __TEST_ONE__: "bun test <file> -t \"<name>\"",
  __KIT_HOME_VAR__: "SAMPLE_KIT_HOME",
  __COMPAT__: "利用者は 1 人で、外部クライアントは無い",
  __LIVE_CHECK__: "ローカルで起動して画面を見る",
  __DEPLOY_OK__: "利用者の OK を取ってから",
  __KIT_REPO__: "example/kit-home",
  __TASK_CHECK__: "環境変数 SAMPLE_TASK が 1",
  __QUOTA_CHECK__: "利用上限は管理アプリの画面で見る",
};

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function filesOf(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === ".git") return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesOf(p) : [p];
  });
}

function fillTemplate(dir: string, vals: Record<string, string>): void {
  cpSync(template, dir, { recursive: true });
  for (const f of filesOf(dir)) {
    const text = readFileSync(f, "utf8").replace(/__[A-Z_]+__/g, (m) => vals[m] ?? m);
    writeFileSync(f, text);
    if (f.endsWith(".tmpl")) renameSync(f, f.slice(0, -".tmpl".length));
  }
  const git = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
  if (git.exitCode !== 0) throw new Error(`git init: ${git.stderr.toString()}`);
}

function filled(): string {
  const dir = mkdtempSync(join(tmpdir(), "switchboard.new-repo-template."));
  made.push(dir);
  fillTemplate(dir, values);
  return dir;
}

describe("new-repo template", () => {
  test("new-repo template: every placeholder is filled", () => {
    const dir = filled();
    const left = filesOf(dir).flatMap((f) => (readFileSync(f, "utf8").match(/__[A-Z_]+__/g) ?? []).map((m) => `${relative(dir, f)}: ${m}`));
    expect(left).toEqual([]);
  });

  test("new-repo template: lint passes on the filled config", async () => {
    const dir = filled();
    const cfg = parseConfig(JSON.parse(readFileSync(join(dir, "ops.config.json"), "utf8")));
    expect(cfg.projectUrl).toBeUndefined(); // the Project URL is the repository variable, not a tracked value
    const page = () => ({ repositoryOwner: { projectV2: { id: "P1" } }, repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    const prev = process.env.GH_REPO;
    process.env.GH_REPO = "example/sample-app";
    try {
      const gh = fakeGh([() => "https://github.com/orgs/example/projects/7\n", page]);
      const r = await lint(gh, await resolveProject(cfg, gh, {}), { sleep: async () => undefined });
      expect(gh.calls[0]).toEqual({ kind: "run", args: ["variable", "get", "SAMPLE_PROJECT_URL"] });
      expect(r.violations).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = prev;
    }
  });

  test("new-repo template: no file carries a value usable for auth", () => {
    const dir = filled();
    const hits = filesOf(dir).flatMap((f) => findSecrets(readFileSync(f, "utf8")).map((h) => `${relative(dir, f)}:${h.line} ${h.kind}`));
    expect(hits).toEqual([]);
  });

  test("new-repo template: local-ci reads at least one step from ci.yml (another repository has no scripts/ci.ts, #1203)", async () => {
    const dir = filled();
    const steps = await checkoutSteps(dir, {});
    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps.map((s) => s.run)).toContain("bun test");
  });

  test("new-repo template: the entries call the kit", () => {
    const dir = filled();
    const r = setupScripts({ metaPath: root, cwd: dir });
    expect(r.config).toBe(true);
    expect(r.copies).toEqual([]);
    expect(r.kit.length).toBe(4);
  });

  test("new-repo template: CLAUDE.md and AGENTS.md lose the .tmpl name", () => {
    const dir = filled();
    const names = readdirSync(dir);
    expect(names).toContain("CLAUDE.md");
    expect(names).toContain("AGENTS.md");
    expect(names.filter((n) => n.endsWith(".tmpl"))).toEqual([]);
  });
});
