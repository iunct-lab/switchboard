// test-reads: ops-kit/fixtures/ ops-kit/template/ ops.config.json
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_ENV, configFileOf, configShapeError, defaultConfig, extraReviewerOf, findConfig, loadConfig, loadPublicSync, mergeGateOf, parseConfig, projectOf, publicCopyOf, publicCopyRefusal, resolveProject, sharedFilesOf, STORY_POINTS, TEMPLATE_CONFIG } from "./config.ts";
import { forgeOf } from "./forge.ts";

const fixtures = join(import.meta.dir, "../fixtures");
const withPhase = () => loadConfig(join(fixtures, "config-with-phase.json"));
const noPhase = () => loadConfig(join(fixtures, "config-no-phase.json"));

describe("config", () => {
  test("both fixtures load; Story Points are not defaulted by the config", () => {
    expect(withPhase().fields.phase).toEqual(["Phase 0", "Phase 1"]);
    expect(noPhase().fields.phase).toBeUndefined();
    expect(noPhase().storyPoints).toBeUndefined();
  });

  test("extraReviewer names the extra reviewer; without the key, or without a config, there is none", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-config-extra-"));
    try {
      expect(extraReviewerOf(dir)).toBeNull();
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ ...defaultConfig(), extraReviewer: "local" }));
      expect(extraReviewerOf(dir)).toBe("local");
      expect(loadConfig(undefined, dir).extraReviewer).toBe("local"); // the strict schema knows the key
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify(defaultConfig()));
      expect(extraReviewerOf(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("story points belong to the kit — a config that still has storyPoints loads and the kit's scale is 1 to 13", () => {
    expect(withPhase().storyPoints).toEqual([1, 2, 3, 5, 8]);
    expect(STORY_POINTS).toEqual([1, 2, 3, 5, 8, 13]);
    expect(defaultConfig().storyPoints).toBeUndefined();
  });

  test("defaultConfig is the kit's template with no Phase and no Milestone", () => {
    const template = JSON.parse(require("node:fs").readFileSync(TEMPLATE_CONFIG, "utf8"));
    const cfg = defaultConfig();
    expect(cfg.fields).toEqual({ priority: template.fields.priority });
    expect([cfg.sections, cfg.envPrefix]).toEqual([template.sections, "BACKLOG"]);
    expect([cfg.fields.phase, cfg.milestone]).toEqual([undefined, undefined]);
  });

  test("a config that still has fields.area and fields.kind loads without them: they are dropped, not read", () => {
    const base = JSON.parse(require("node:fs").readFileSync(join(fixtures, "config-no-phase.json"), "utf8"));
    const old = { ...base, fields: { ...base.fields, area: ["one", "two"], kind: ["bug", "feature"] } };
    expect(parseConfig(old).fields).toEqual(base.fields);
  });

  test("a config with forge parses; its keys are checked", () => {
    const base = JSON.parse(require("node:fs").readFileSync(join(fixtures, "config-no-phase.json"), "utf8"));
    expect(parseConfig({ ...base, forge: { service: "github" } }).forge).toEqual({ service: "github" });
    expect(() => parseConfig({ ...base, forge: { service: "" } })).toThrow(/forge\.service/);
    // nothing reads a host or a repository from here (they are the service's to find): one written is refused, not ignored
    expect(() => parseConfig({ ...base, forge: { service: "github", repository: "org/other" } })).toThrow(/forge/);
    expect(loadConfig(join(import.meta.dir, "../../ops.config.json")).forge).toEqual({ service: "github" });
  });

  test("GitLab's forge names its host and project; GitHub's names neither", () => {
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

  test("publicSync.allowRefs names paths the exclude leaves out", () => {
    const base = withPhase();
    const ps = (allowRefs: string[]) => ({ ...base, publicSync: { target: "example-org/app-public", exclude: ["a.md", "dir/"], allowRefs } });
    expect(parseConfig(ps(["a.md", "dir/b.md", "dir/"])).publicSync?.allowRefs).toEqual(["a.md", "dir/b.md", "dir/"]);
    expect(() => parseConfig(ps(["other.md"]))).toThrow(/publicSync\.allowRefs: other\.md は exclude が外すパスではありません/);
  });

  test("an invalid config is refused with the path of each problem", () => {
    const base = withPhase();
    expect(() => parseConfig({ ...base, projectUrl: "https://example.com/p/1" })).toThrow(/projectUrl/);
    expect(() => parseConfig({ ...base, fields: { ...base.fields, priority: [] } })).toThrow(/fields\.priority/);
    expect(() => parseConfig({ ...base, extra: 1 })).toThrow(/extra|Unrecognized/);
    expect(() => parseConfig({ ...base, envPrefix: "lower" })).toThrow(/envPrefix/);
    expect(() => parseConfig({ ...base, milestone: { pattern: "(" } })).toThrow(/milestone\.pattern/);
    expect(() => parseConfig({ ...base, sections: { ...base.sections, origin: { name: "x", pattern: "(", hint: "h" } } })).toThrow(/sections\.origin\.pattern/);
    // storyPoints is not read (the kit owns the scale), so even a malformed leftover does not fail the config
    expect(() => parseConfig({ ...base, storyPoints: [1.5] })).not.toThrow();
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

  test("which settings apply is one rule: the repository's ops.config.json when it has one, else the file OPS_KIT_CONFIG names, else none — a file as a whole, never mixed key by key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit-config-rule-"));
    try {
      const repo = join(dir, "repo");
      mkdirSync(join(repo, "a"), { recursive: true });
      const kept = join(dir, "kept.json");
      writeFileSync(kept, JSON.stringify({ ...withPhase(), envPrefix: "KEPT", mergeGate: "scripts/gate.ts", extraReviewer: "bot", sharedFiles: ["a.md"], depsCheck: { extraConditions: ["x"] }, forge: { service: "gitlab", host: "gitlab.example.com", project: "g/p" } }));
      // 1. neither: none
      expect(configFileOf(repo, "")).toBeNull();
      expect(() => findConfig(undefined, repo, "")).toThrow(/OPS_KIT_CONFIG/);
      expect(() => loadConfig(undefined, repo)).toThrow(/ops\.config\.json/);
      expect([mergeGateOf(repo, ""), extraReviewerOf(repo, ""), forgeOf(repo, "")]).toEqual([null, null, "app"]);
      // 2. no file in the repository + the kept settings: every reader takes them (the backlog's keys, mergeGate, forge, depsCheck)
      expect(configFileOf(repo, kept)).toBe(kept);
      expect(findConfig(undefined, join(repo, "a"), kept)).toBe(kept);
      expect([mergeGateOf(repo, kept), extraReviewerOf(repo, kept), forgeOf(repo, kept)]).toEqual(["scripts/gate.ts", "bot", "gitlab"]);
      const saved = process.env[CONFIG_ENV];
      process.env[CONFIG_ENV] = kept;
      try {
        // the variable is the default of that argument: a command run in the repository needs nothing else
        expect(loadConfig(undefined, join(repo, "a"))).toMatchObject({ envPrefix: "KEPT", depsCheck: { extraConditions: ["x"] } });
        expect([mergeGateOf(repo), sharedFilesOf(repo), forgeOf(repo)]).toEqual(["scripts/gate.ts", ["a.md"], "gitlab"]);
        // publicSync is the repository's alone (it is read at the commit that is sent)
        writeFileSync(kept, JSON.stringify({ publicSync: { target: "o/public", exclude: [] } }));
        expect(publicCopyOf(repo)).toBeNull();
        expect(() => loadPublicSync(undefined, repo)).toThrow(/ops\.config\.json/);
        // 3. the repository has its own file: that file alone, even for the keys it leaves out
        writeFileSync(kept, JSON.stringify({ ...withPhase(), envPrefix: "KEPT", mergeGate: "scripts/gate.ts" }));
        writeFileSync(join(repo, "ops.config.json"), JSON.stringify({ ...withPhase(), envPrefix: "OWN" }));
        expect(configFileOf(repo)).toBe(join(repo, "ops.config.json"));
        expect(loadConfig(undefined, join(repo, "a")).envPrefix).toBe("OWN");
        expect(mergeGateOf(repo)).toBeNull();
        // a file the variable names but that is not there is none
        process.env[CONFIG_ENV] = join(dir, "gone.json");
        rmSync(join(repo, "ops.config.json"));
        expect(configFileOf(repo)).toBeNull();
      } finally {
        if (saved === undefined) delete process.env[CONFIG_ENV];
        else process.env[CONFIG_ENV] = saved;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("configShapeError: keys may be left out, but each one present must be in its shape and none unknown", () => {
    expect(configShapeError({})).toBeNull();
    expect(configShapeError({ ci: { steps: [{ run: "make" }] } })).toBeNull();
    expect(configShapeError(withPhase())).toBeNull();
    expect(configShapeError({ ci: { steps: [] } })).toContain("ci.steps");
    expect(configShapeError({ nope: 1 })).not.toBeNull();
    expect(configShapeError({ milestone: { pattern: "(" } })).not.toBeNull();
    for (const bad of [null, [], "x", 3]) expect(configShapeError(bad)).toBe("設定は JSON のオブジェクトで書く");
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

