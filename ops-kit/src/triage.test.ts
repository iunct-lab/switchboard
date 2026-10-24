import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { fakeGh, type FakeCall } from "./gh.ts";
import { UsageError } from "./set.ts";
import { reconcileProject, triage } from "./triage.ts";

const fixtures = join(import.meta.dir, "../fixtures");
const withPhase = loadConfig(join(fixtures, "config-with-phase.json"));
const noPhase = loadConfig(join(fixtures, "config-no-phase.json"));

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.GH_REPO;
  process.env.GH_REPO = "example/repo";
});
afterEach(() => {
  if (saved === undefined) delete process.env.GH_REPO;
  else process.env.GH_REPO = saved;
});

const select = (id: string, name: string, options: string[]) => ({ id, name, options: options.map((o) => ({ id: `${id}:${o}`, name: o })) });
const fields = [
  select("A", "Area", ["one", "two"]),
  select("K", "Kind", ["bug", "feature"]),
  select("P", "Priority", ["P0", "P1", "P2", "P3", "high", "low"]),
  select("PH", "Phase", ["Phase 0", "Phase 1"]),
  select("S", "Status", ["Backlog", "Ready"]),
  {}, // a field that is not single-select
];
const read = (opts: { items?: Array<{ id: string; project: { number: number } }>; parent?: boolean; fields?: unknown[] } = {}) => () => ({
  repositoryOwner: { projectV2: { id: "P1", fields: { nodes: opts.fields ?? fields } } },
  repository: { issue: { id: "I1", projectItems: { nodes: opts.items ?? [{ id: "IT1", project: { number: 1 } }] } }, ...(opts.parent ? { parent: { id: "PARENT" } } : {}) },
});
const g = (c: FakeCall | undefined) => (c && c.kind === "graphql" ? c : { query: "", vars: {} as Record<string, unknown> });

describe("triage", () => {
  test("with Phase: every field in one mutation, then the parent", async () => {
    const gh = fakeGh([read({ parent: true }), () => ({}), () => ({})]);
    const log: string[] = [];
    await triage(gh, withPhase, 72, { area: "one", kind: "feature", priority: "P3", phase: "Phase 1", parent: 16 }, (s) => log.push(s));
    expect(gh.calls).toHaveLength(3);
    expect(g(gh.calls[0]).vars).toEqual({ o: "example", p: 1, ro: "example", rn: "repo", n: 72, pn: 16 });
    expect(g(gh.calls[0]).query).toContain("parent: issue(number:$pn)");
    expect(g(gh.calls[1]).vars).toEqual({ p: "P1", i: "IT1", f0: "A", o0: "A:one", f1: "K", o1: "K:feature", f2: "P", o2: "P:P3", f3: "PH", o3: "PH:Phase 1", f4: "S", o4: "S:Backlog" });
    expect(g(gh.calls[2]).vars).toEqual({ p: "PARENT", c: "I1" });
    expect(log).toEqual([">> Project に既存: #72", "   Area = one", "   Kind = feature", "   Priority = P3", "   Phase = Phase 1", "   Status = Backlog", "   parent = #16"]);
  });

  test("without Phase: no Phase field, a phase is refused; an Issue not in the Project is added", async () => {
    const gh = fakeGh([read({ items: [] }), () => ({ addProjectV2ItemById: { item: { id: "NEW" } } }), () => ({})]);
    const log: string[] = [];
    await triage(gh, noPhase, 5, { area: "two", kind: "bug", priority: "high", status: "Ready" }, (s) => log.push(s));
    expect(g(gh.calls[0]).vars).toEqual({ o: "example-org", p: 7, ro: "example", rn: "repo", n: 5 });
    expect(g(gh.calls[0]).query).not.toContain("$pn");
    expect(g(gh.calls[2]).vars).toEqual({ p: "P1", i: "NEW", f0: "A", o0: "A:two", f1: "K", o1: "K:bug", f2: "P", o2: "P:high", f3: "S", o3: "S:Ready" });
    expect(log).toEqual([">> Project に追加: #5", "   Area = two", "   Kind = bug", "   Priority = high", "   Status = Ready"]);
    await expect(triage(fakeGh([]), noPhase, 5, { area: "two", kind: "bug", priority: "high", phase: "Phase 1" })).rejects.toThrow(/Phase が無い/);
  });

  test("a missing phase is refused before calling GitHub; a value the config does not list goes to the Project, which decides", async () => {
    const gh = fakeGh([]);
    const p = triage(gh, withPhase, 1, { area: "one", kind: "bug", priority: "P1" });
    await expect(p).rejects.toThrow(/phase を渡して/);
    await expect(p).rejects.toBeInstanceOf(UsageError);
    expect(gh.calls).toHaveLength(0);
    // another repository's Project (through <envPrefix>_PROJECT_URL) has its own choices
    const other = fakeGh([read({ fields: [select("A", "Area", ["agent"]), ...fields.slice(1)] }), () => ({})]);
    const log: string[] = [];
    await triage(other, withPhase, 1, { area: "agent", kind: "chore", priority: "P1", phase: "Phase 0" }, (s) => log.push(s));
    expect(log).toContain("   Area = agent");
    expect(log).toContain("   (フィールド Kind / 選択肢 chore が無いためスキップ)");
    // Priority and Phase the config does not list either: the Project has them, so they are set
    const more = fakeGh([read({ fields: [...fields.slice(0, 2), select("P", "Priority", ["urgent"]), select("PH", "Phase", ["Phase 9"]), fields[4]!] }), () => ({})]);
    const log2: string[] = [];
    await triage(more, withPhase, 1, { area: "one", kind: "bug", priority: "urgent", phase: "Phase 9" }, (s) => log2.push(s));
    expect(log2).toContain("   Priority = urgent");
    expect(log2).toContain("   Phase = Phase 9");
  });

  test("a field or choice the Project lacks is skipped with a note; a parent that cannot be linked is noted", async () => {
    const gh = fakeGh([read({ parent: true, fields: fields.filter((f) => (f as { name?: string }).name !== "Kind") }), () => ({}), () => { throw new Error("already has a parent"); }]);
    const log: string[] = [];
    await triage(gh, withPhase, 9, { area: "one", kind: "bug", priority: "P0", phase: "Phase 0", parent: 2 }, (s) => log.push(s));
    expect(log).toContain("   (フィールド Kind / 選択肢 bug が無いためスキップ)");
    expect(Object.keys(g(gh.calls[1]).vars)).not.toContain("f4");
    expect(log.at(-1)).toBe("   (parent の設定をスキップ: 既に親がある可能性)");
  });

  test("a parent that does not exist is an error", async () => {
    await expect(triage(fakeGh([read({ parent: false })]), withPhase, 9, { area: "one", kind: "bug", priority: "P0", phase: "Phase 0", parent: 404 }, () => undefined)).rejects.toThrow(/#404/);
  });
});

describe("reconcileProject", () => {
  const head = () => ({ repositoryOwner: { projectV2: { id: "P1" } } });
  const node = (number: number, projects: string[]) => ({ id: `N${number}`, number, projectItems: { nodes: projects.map((p) => ({ id: `IT${number}`, project: { id: p, number: 1 } })) } });
  const page = (kind: string, nodes: unknown[], next?: string) => () => ({ repository: { [kind]: { pageInfo: { hasNextPage: !!next, endCursor: next ?? null }, nodes } } });

  test("adds only the open Issues / PRs not in the Project (another owner's Project #1 is not it), sets no field; a second run adds nothing", async () => {
    const gh = fakeGh([
      head,
      page("issues", [node(1, ["P1"]), node(2, [])], "c1"),
      page("issues", [node(3, ["OTHER"])]),
      page("pullRequests", [node(4, ["P1"])]),
      () => ({ addProjectV2ItemById: { item: { id: "A2" } } }),
      () => ({ addProjectV2ItemById: { item: { id: "A3" } } }),
    ]);
    expect(await reconcileProject(gh, withPhase, {}, () => {})).toEqual([2, 3]);
    expect(g(gh.calls[2]).vars).toEqual({ ro: "example", rn: "repo", c: "c1" });
    const mutations = gh.calls.filter((c) => g(c).query.startsWith("mutation"));
    expect(mutations.map((c) => g(c).vars)).toEqual([{ p: "P1", c: "N2" }, { p: "P1", c: "N3" }]);
    expect(mutations.every((c) => !g(c).query.includes("updateProjectV2ItemFieldValue"))).toBe(true);

    const again = fakeGh([head, page("issues", [node(1, ["P1"]), node(2, ["P1"])]), page("pullRequests", [node(4, ["P1"])])]);
    expect(await reconcileProject(again, withPhase, {}, () => {})).toEqual([]);
    expect(again.calls).toHaveLength(3);
  });

  test("--dry-run lists and writes nothing; a missing Project throws", async () => {
    const gh = fakeGh([head, page("issues", [node(2, [])]), page("pullRequests", [node(5, [])])]);
    const log: string[] = [];
    expect(await reconcileProject(gh, withPhase, { dryRun: true }, (s) => log.push(s))).toEqual([2, 5]);
    expect(log).toEqual([">> 追加する: #2", ">> 追加する: #5", "追加する: 2 件"]);
    await expect(reconcileProject(fakeGh([() => ({ repositoryOwner: { projectV2: null } })]), withPhase)).rejects.toThrow(/見つかりません/);
  });
});
