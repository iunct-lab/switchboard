import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, findConfig, loadConfig, parseConfig, projectOf, publicCopyOf, publicCopyRefusal, resolveProject, TEMPLATE_CONFIG } from "./config.ts";

const fixtures = join(import.meta.dir, "../fixtures");
const withPhase = () => loadConfig(join(fixtures, "config-with-phase.json"));
const noPhase = () => loadConfig(join(fixtures, "config-no-phase.json"));

describe("config", () => {
  test("both fixtures load; Story Points default to 1, 2, 3, 5, 8", () => {
    expect(withPhase().fields.phase).toEqual(["Phase 0", "Phase 1"]);
    expect(noPhase().fields.phase).toBeUndefined();
    expect(noPhase().storyPoints).toEqual([1, 2, 3, 5, 8]);
  });

  test("defaultConfig is the kit's template with Area app, no Phase and no Milestone (#2361)", () => {
    const template = JSON.parse(require("node:fs").readFileSync(TEMPLATE_CONFIG, "utf8"));
    const cfg = defaultConfig();
    expect(cfg.fields).toEqual({ area: ["app"], kind: template.fields.kind, priority: template.fields.priority });
    expect([cfg.sections, cfg.storyPoints, cfg.envPrefix]).toEqual([template.sections, template.storyPoints, "BACKLOG"]);
    expect([cfg.fields.phase, cfg.milestone]).toEqual([undefined, undefined]);
  });

  test("a config with forge parses (#920); its keys are checked", () => {
    const base = JSON.parse(require("node:fs").readFileSync(join(fixtures, "config-no-phase.json"), "utf8"));
    expect(parseConfig({ ...base, forge: { service: "github" } }).forge).toEqual({ service: "github" });
    expect(() => parseConfig({ ...base, forge: { service: "" } })).toThrow(/forge\.service/);
    // nothing reads a host or a repository from here (they are the service's to find): one written is refused, not ignored
    expect(() => parseConfig({ ...base, forge: { service: "github", repository: "org/other" } })).toThrow(/forge/);
    expect(loadConfig(join(import.meta.dir, "../../ops.config.json")).forge).toEqual({ service: "github" });
  });

  test("GitLab's forge names its host and project (#892); GitHub's names neither", () => {
    const base = JSON.parse(require("node:fs").readFileSync(join(fixtures, "config-no-phase.json"), "utf8"));
    const lab = { service: "gitlab", host: "gitlab.example.com", project: "group/sub/app" };
    expect(parseConfig({ ...base, forge: lab }).forge).toEqual(lab);
    expect(() => parseConfig({ ...base, forge: { service: "gitlab" } })).toThrow(/forge\.host.*gitlab には host が要ります/s);
    expect(() => parseConfig({ ...base, forge: { ...lab, project: "app" } })).toThrow(/forge\.project/);
    for (const host of ["https://gitlab.example.com", "gitlab.example.com/x", "gitlab.example.com:8443", ""]) expect(() => parseConfig({ ...base, forge: { ...lab, host } })).toThrow(/forge\.host/);
    expect(() => parseConfig({ ...base, forge: { service: "github", host: "gitlab.example.com" } })).toThrow(/github では host を書けません/);
    expect(() => parseConfig({ ...base, forge: { ...lab, token: "x" } })).toThrow(/forge/);
  });

  test("a config with publicSync parses; its keys are checked", () => {
    const base = withPhase();
    expect(parseConfig({ ...base, publicSync: { target: "example-org/app-public", exclude: ["a"] } }).publicSync).toEqual({ target: "example-org/app-public", exclude: ["a"], rewrite: [] });
    expect(() => parseConfig({ ...base, publicSync: { target: "x" } })).toThrow(/publicSync\.target/);
    expect(parseConfig({ ...base, publicSync: { target: "example-org/app-public", serviceUsers: ["svc"] } }).publicSync?.serviceUsers).toEqual(["svc"]);
  });

  test("an invalid config is refused with the path of each problem", () => {
    const base = withPhase();
    expect(() => parseConfig({ ...base, projectUrl: "https://example.com/p/1" })).toThrow(/projectUrl/);
    expect(() => parseConfig({ ...base, fields: { ...base.fields, area: [] } })).toThrow(/fields\.area/);
    expect(() => parseConfig({ ...base, extra: 1 })).toThrow(/extra|Unrecognized/);
    expect(() => parseConfig({ ...base, envPrefix: "lower" })).toThrow(/envPrefix/);
    expect(() => parseConfig({ ...base, milestone: { pattern: "(" } })).toThrow(/milestone\.pattern/);
    expect(() => parseConfig({ ...base, sections: { ...base.sections, origin: { name: "x", pattern: "(", hint: "h" } } })).toThrow(/sections\.origin\.pattern/);
    expect(() => parseConfig({ ...base, storyPoints: [1.5] })).toThrow(/storyPoints/);
  });

  test("without --config the nearest ops.config.json from the working folder up is used", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit-config-"));
    try {
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify(withPhase()));
      mkdirSync(join(dir, "a/b"), { recursive: true });
      expect(findConfig(undefined, join(dir, "a/b"))).toBe(join(dir, "ops.config.json"));
      expect(loadConfig(undefined, join(dir, "a/b")).envPrefix).toBe("EXAMPLE");
      expect(() => findConfig(undefined, tmpdir())).toThrow(/ops\.config\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the Project comes from the URL (user or org); <envPrefix>_PROJECT_URL and the owner setting win", () => {
    expect(projectOf(withPhase(), {})).toEqual({ owner: "example", number: 1 });
    expect(projectOf(noPhase(), {})).toEqual({ owner: "example-org", number: 7 });
    expect(projectOf(withPhase(), { EXAMPLE_PROJECT_URL: "https://github.com/orgs/other/projects/9" })).toEqual({ owner: "other", number: 9 });
    expect(projectOf({ ...withPhase(), owner: "@me" }, {})).toEqual({ owner: "@me", number: 1 });
    // the owner setting belongs to the config's URL: a URL from the environment brings its own owner
    expect(projectOf({ ...withPhase(), owner: "@me" }, { EXAMPLE_PROJECT_URL: "https://github.com/orgs/other/projects/9" })).toEqual({ owner: "other", number: 9 });
    expect(projectOf(withPhase(), { EXAMPLE_PROJECT_URL: "https://github.com/orgs/other/projects/9", EXAMPLE_PROJECT_OWNER: "@me" })).toEqual({ owner: "@me", number: 9 });
  });
});

for (const source of ["environment", "config", "variable"]) {
  test(`Project URL from ${source}, in precedence order`, async () => {
    const calls: string[][] = [];
    const url = "https://github.com/orgs/chosen/projects/8";
    const gh = {
      run: async (args: string[]) => { calls.push(args); return url + "\n"; },
      api: async () => { throw new Error("unexpected api"); },
      graphql: async () => { throw new Error("unexpected graphql"); },
    };
    const cfg = parseConfig({ ...withPhase(), projectUrl: source === "variable" ? undefined : source === "config" ? url : withPhase().projectUrl });
    const env = source === "environment" ? { EXAMPLE_PROJECT_URL: url } : {};
    const resolved = await resolveProject(cfg, gh, env);
    expect(projectOf(resolved, env)).toEqual({ owner: "chosen", number: 8 });
    expect(calls).toEqual(source === "variable" ? [["variable", "get", "EXAMPLE_PROJECT_URL"]] : []);
  });
}

describe("publicCopyOf", () => {
  const tree = (config?: string) => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit-publiccopy-"));
    if (config !== undefined) writeFileSync(join(dir, "ops.config.json"), config);
    mkdirSync(join(dir, "sub"));
    return dir;
  };

  test("the nearest ops.config.json's publicSync.target, read from below", () => {
    const dir = tree(JSON.stringify({ publicSync: { target: "acme/widget" }, fields: "not checked here" }));
    try {
      expect(publicCopyOf(join(dir, "sub"))).toBe("acme/widget");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("null without the key and with broken JSON", () => {
    for (const config of [JSON.stringify({ envPrefix: "X" }), "{ not json", JSON.stringify(null)]) {
      const dir = tree(config);
      try {
        expect(publicCopyOf(dir)).toBeNull();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("publicCopyRefusal matches the target in any form a repository is written, and only it", () => {
    const dir = tree(JSON.stringify({ publicSync: { target: "acme/widget" } }));
    try {
      for (const repo of ["acme/widget", "Acme/Widget", "github.com/acme/widget", "https://github.com/acme/widget.git", "https://github.com/acme/widget.git/", "https://github.com/acme/widget/", "git@github.com:acme/widget.git"]) {
        expect(publicCopyRefusal(repo, dir)).toContain("gh repo set-default");
      }
      for (const repo of ["acme/widget-dev", "someone/widget", "acme/widgets"]) expect(publicCopyRefusal(repo, dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

