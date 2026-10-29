import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { bootstrap } from "../ops-kit/src/bootstrap.ts";
import { parseConfig, resolveProject } from "../ops-kit/src/config.ts";
import { fakeGh, type FakeCall } from "../ops-kit/src/gh.ts";
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

  /** The command lines of the bash blocks under `## <n>.` of the new-repo skill, in order (continuations joined). */
  function skillCommands(n: number): string[] {
    const skill = readFileSync(join(root, ".claude/skills/new-repo/SKILL.md"), "utf8");
    const section = skill.split(/^## /m).find((s) => s.startsWith(`${n}. `)) ?? "";
    const blocks = [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
    return blocks.flatMap((b) => b.replace(/\\\n\s*/g, " ").split("\n")).map((l) => l.replace(/\s+#.*$/, "").trim()).filter(Boolean);
  }

  test("new-repo skill: step 2 links the Project bootstrap created to the repository before the variable (#2599)", async () => {
    const lines = skillCommands(2);
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    expect(at(/ops-kit\/src\/cli\.ts" bootstrap/)).toBeGreaterThanOrEqual(0);
    expect(at(/^gh project link /)).toBeGreaterThan(at(/ops-kit\/src\/cli\.ts" bootstrap/));
    expect(at(/^gh variable set /)).toBeGreaterThan(at(/^gh project link /));
    expect(lines[at(/^gh project link /) + 1]).toMatch(/^gh repo view <owner>\/<name> --json projectsV2 /);

    // Play the steps on one fake gh: bootstrap (the kit's code) makes the Project, then the skill's gh lines run as written
    const fill = (l: string) => l.replaceAll("<owner>/<name>", "example/sample-app").replaceAll("<owner>", "example").replaceAll("<n>", "7").replaceAll("<PREFIX>", "SAMPLE").replaceAll("<URL>", "https://github.com/orgs/example/projects/7");
    const project = { id: "P7", number: 7, title: "sample-app", url: "https://github.com/orgs/example/projects/7", fields: { nodes: [{ id: "F1", name: "Status", dataType: "SINGLE_SELECT", options: [] }] } };
    const answer = (c: FakeCall) => {
      if (c.kind !== "graphql") return "";
      if (c.query.includes("repositoryOwner")) return { repositoryOwner: { id: "O1", projectsV2: { nodes: [] } } };
      if (c.query.includes("createProjectV2(")) return { createProjectV2: { projectV2: project } };
      return {};
    };
    const gh = fakeGh(Array.from({ length: 50 }, () => answer));
    const cfg = parseConfig({ ...JSON.parse(readFileSync(join(filled(), "ops.config.json"), "utf8")), projectUrl: "https://github.com/orgs/example/projects/0" });
    const log: string[] = [];
    for (const l of lines) {
      if (l.includes('cli.ts" bootstrap')) await bootstrap(gh, cfg, { title: "sample-app" }, (s) => log.push(s), {});
      else if (l.startsWith("gh ")) {
        const args = fill(l).split(" ").slice(1);
        await gh.run(args.includes("-q") ? args.slice(0, args.indexOf("-q")) : args); // the jq filter has spaces; not needed here
      }
    }
    expect(log.join("\n")).toContain("Project の URL: https://github.com/orgs/example/projects/7");
    const order = gh.calls.flatMap((c) => (c.kind === "graphql" && c.query.includes("createProjectV2(") ? ["create"] : c.kind === "run" ? [c.args.slice(0, 2).join(" ")] : []));
    expect(order).toEqual(["repo create", "repo view", "create", "project link", "repo view", "variable set", "variable get"]);
    expect(gh.calls.find((c) => c.kind === "run" && c.args[1] === "link")).toEqual({ kind: "run", args: ["project", "link", "7", "--owner", "example", "-R", "example/sample-app"] });
  });

  test("new-repo skill: step 4 sends the daemon's key and no skill says the API needs no token (#2599)", () => {
    const lines = skillCommands(4);
    expect(lines).toContain('K=$(cat "$BACKLOG_TOKEN_FILE")');
    const curls = lines.filter((l) => /\bcurl\b/.test(l));
    expect(curls.length).toBeGreaterThanOrEqual(2);
    for (const l of curls) expect(l).toContain('-H "authorization: Bearer $K"');
    const said = Bun.spawnSync(["git", "grep", "-l", "トークンが要らない", "--", ".claude/skills"], { cwd: root });
    expect(said.stdout.toString()).toBe("");
  });
});
