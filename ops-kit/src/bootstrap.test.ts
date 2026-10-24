import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { bootstrap, STATUS_OPTIONS } from "./bootstrap.ts";
import { loadConfig } from "./config.ts";
import { fakeGh, type FakeCall } from "./gh.ts";

const fixtures = join(import.meta.dir, "../fixtures");
const withPhase = loadConfig(join(fixtures, "config-with-phase.json"));
const noPhase = loadConfig(join(fixtures, "config-no-phase.json"));
const g = (c: FakeCall | undefined) => (c && c.kind === "graphql" ? c : { query: "", vars: {} as Record<string, unknown> });
const page = (projects: unknown[], next: string | null = null) => () => ({ repositoryOwner: { id: "OWNER", projectsV2: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes: projects } } });
const status = (options: string[]) => ({ id: "ST", name: "Status", dataType: "SINGLE_SELECT", options: options.map((name) => ({ name })) });

describe("bootstrap", () => {
  test("no Project yet: create it, give Status the kit's choices, then create every field of the config", async () => {
    const created = { id: "P9", number: 3, title: "Backlog", url: "https://github.com/users/example/projects/3", fields: { nodes: [status(["Todo", "In Progress", "Done"])] } };
    const gh = fakeGh([page([]), () => ({ createProjectV2: { projectV2: created } }), ...Array.from({ length: 6 }, () => () => ({}))]);
    const log: string[] = [];
    const r = await bootstrap(gh, withPhase, { title: "Backlog" }, (s) => log.push(s), {});
    expect(r).toEqual({ number: 3, url: "https://github.com/users/example/projects/3" });
    expect(g(gh.calls[0]).vars).toEqual({ o: "example", after: null });
    expect(g(gh.calls[0]).query).toContain("repositoryOwner(login:$o){ id ... on ProjectV2Owner{ projectsV2(first:100, after:$after)");
    expect(g(gh.calls[1]).vars).toEqual({ o: "OWNER", t: "Backlog" });
    expect(g(gh.calls[2]).query).toContain("updateProjectV2Field");
    expect(g(gh.calls[2]).vars).toEqual({ f: "ST", o: STATUS_OPTIONS.map((name) => ({ name, color: "GRAY", description: "" })) });
    expect(gh.calls.slice(3).map((c) => g(c).vars.n)).toEqual(["Area", "Kind", "Priority", "Phase", "Story Points"]);
    expect(g(gh.calls[3]).vars.o).toEqual([{ name: "one", color: "GRAY", description: "" }, { name: "two", color: "GRAY", description: "" }]);
    expect(g(gh.calls[7]).query).toContain("dataType:NUMBER");
    expect(log.at(-1)).toContain("設定の projectUrl をこの URL にしてください");
  });

  test("run again: nothing is written to an existing Project; a missing choice, a wrong type, and the existing Status's choices are listed", async () => {
    const fields = [
      status(["Todo", "Done"]),
      { name: "Area", dataType: "SINGLE_SELECT", options: [{ name: "one" }] },
      { name: "Kind", dataType: "TEXT" },
      { name: "Priority", dataType: "SINGLE_SELECT", options: [{ name: "high" }, { name: "low" }] },
      { name: "Story Points", dataType: "NUMBER" },
      {},
    ];
    const gh = fakeGh([page([{ id: "P7", number: 7, title: "Backlog", url: "https://github.com/orgs/example-org/projects/7", fields: { nodes: fields } }])]);
    const log: string[] = [];
    await bootstrap(gh, noPhase, { title: "Backlog" }, (s) => log.push(s), {});
    expect(gh.calls).toHaveLength(1);
    expect(log).toEqual([
      ">> 既存の Project #7「Backlog」を使う",
      ">> フィールド 'Status' は既に存在（スキップ）。Project に無い選択肢: Backlog / Ready / In progress / In review（Project の UI で足す）",
      ">> フィールド 'Area' は既に存在（スキップ）。Project に無い選択肢: two（Project の UI で足す）",
      ">> フィールド 'Kind' は既に存在するが型が TEXT（SINGLE_SELECT が要る。Project の UI で直す）",
      ">> フィールド 'Priority' は既に存在（スキップ）",
      ">> フィールド 'Story Points' は既に存在（スキップ）",
    ]);
  });

  test("the Project is looked up on every page; a number match with another title is used but noted", async () => {
    const other = { id: "P1", number: 1, title: "Sibling", url: "https://github.com/users/example/projects/1", fields: { nodes: [status(STATUS_OPTIONS)] } };
    const gh = fakeGh([page([], "C1"), page([other])]);
    const log: string[] = [];
    await bootstrap(gh, withPhase, { title: "Backlog", dryRun: true }, (s) => log.push(s), {});
    expect(g(gh.calls[1]).vars).toEqual({ o: "example", after: "C1" });
    expect(log[0]).toBe(">> 既存の Project #1「Sibling」を使う");
    expect(log[1]).toContain("指定の「Backlog」と違う");
  });

  test("a Project found by its title; --dry-run writes nothing; an environment URL gets no projectUrl hint", async () => {
    const gh = fakeGh([page([{ id: "P5", number: 5, title: "Backlog", url: "https://github.com/users/example/projects/5", fields: { nodes: [status(STATUS_OPTIONS)] } }])]);
    const log: string[] = [];
    await bootstrap(gh, withPhase, { title: "Backlog", dryRun: true }, (s) => log.push(s), {});
    expect(gh.calls).toHaveLength(1);
    expect(log[0]).toBe(">> 既存の Project #5「Backlog」を使う（題で見つけた）");
    expect(log.filter((l) => l.startsWith("DRY_RUN> フィールド"))).toHaveLength(5);
    expect(log.at(-1)).toContain("projectUrl");
    const quiet: string[] = [];
    const gh2 = fakeGh([page([{ id: "P5", number: 5, title: "Backlog", url: "https://github.com/users/example/projects/5", fields: { nodes: [] } }])]);
    await bootstrap(gh2, withPhase, { title: "Backlog", dryRun: true }, (s) => quiet.push(s), { EXAMPLE_PROJECT_URL: "https://github.com/users/example/projects/5" });
    expect(quiet.some((l) => l.includes("projectUrl"))).toBe(false);
  });

  test("the @me owner reads the viewer; an unknown owner is an error", async () => {
    const gh = fakeGh([() => ({ viewer: { id: "ME", projectsV2: { pageInfo: { hasNextPage: false }, nodes: [] } } })]);
    await bootstrap(gh, { ...withPhase, owner: "@me" }, { title: "Backlog", dryRun: true }, () => undefined, {});
    expect(g(gh.calls[0]).query).toContain("viewer{");
    await expect(bootstrap(fakeGh([() => ({ repositoryOwner: null })]), withPhase, { title: "x" }, () => undefined, {})).rejects.toThrow(/持ち主 example/);
  });
});
