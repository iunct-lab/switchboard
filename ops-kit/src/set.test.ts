import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { fakeGh, type FakeCall } from "./gh.ts";
import { setField, UsageError } from "./set.ts";

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

const field = { id: "F1", dataType: "SINGLE_SELECT", options: [{ id: "O1", name: "Backlog" }, { id: "O2", name: "Ready" }] };
const read = (f: unknown, items: Array<{ id: string; project: { number: number } }>, via: "repositoryOwner" | "viewer" = "repositoryOwner") => () => ({
  [via]: { projectV2: { id: "P1", field: f } },
  repository: { issue: { id: "I1", projectItems: { nodes: items } } },
});
const vars = (c: FakeCall | undefined) => (c && c.kind === "graphql" ? c.vars : undefined);
const query = (c: FakeCall | undefined) => (c && c.kind === "graphql" ? c.query : "");

describe("set", () => {
  test("a single-select field of an Issue already in the Project: one read, one write", async () => {
    const gh = fakeGh([read(field, [{ id: "OTHER", project: { number: 2 } }, { id: "IT1", project: { number: 1 } }]), () => ({})]);
    const log: string[] = [];
    await setField(gh, withPhase, 16, "Status", "Ready", (s) => log.push(s));
    expect(gh.calls).toHaveLength(2);
    expect(vars(gh.calls[0])).toEqual({ o: "example", p: 1, f: "Status", ro: "example", rn: "repo", n: 16 });
    expect(query(gh.calls[0])).toContain("repositoryOwner(login:$o)");
    expect(vars(gh.calls[1])).toEqual({ p: "P1", i: "IT1", f: "F1", value: "O2" });
    expect(query(gh.calls[1])).toContain("singleSelectOptionId: $value");
    expect(log).toEqual(["#16  Status = Ready"]);
  });

  test("an Issue not in the Project is added first; a number field takes an integer", async () => {
    const gh = fakeGh([read({ id: "F2", dataType: "NUMBER" }, []), () => ({ addProjectV2ItemById: { item: { id: "NEW" } } }), () => ({})]);
    const log: string[] = [];
    await setField(gh, noPhase, 3, "Story Points", "5", (s) => log.push(s));
    expect(vars(gh.calls[0])).toMatchObject({ o: "example-org", p: 7 });
    expect(vars(gh.calls[1])).toEqual({ p: "P1", c: "I1" });
    expect(vars(gh.calls[2])).toEqual({ p: "P1", i: "NEW", f: "F2", value: 5 });
    expect(query(gh.calls[2])).toContain("$value:Float!");
    expect(log).toEqual([">> Project に追加: #3", "#3  Story Points = 5"]);
  });

  test("a value that does not fit the field is refused before anything is written", async () => {
    for (const [f, value, msg] of [
      [field, "Done", /選択肢 'Done'.*Backlog \/ Ready/],
      [{ id: "F", dataType: "NUMBER" }, "13（分割が必要）", /整数だけ/],
      [{ id: "F", dataType: "DATE" }, "9/28", /YYYY-MM-DD/],
      [{ id: "F", dataType: "ITERATION" }, "x", /未対応/],
      [null, "x", /フィールド 'Nope' が Project にありません/],
    ] as const) {
      const gh = fakeGh([read(f, [{ id: "IT1", project: { number: 1 } }])]);
      const p = setField(gh, withPhase, 1, "Nope", value, () => undefined);
      await expect(p).rejects.toThrow(msg);
      await expect(p).rejects.toBeInstanceOf(UsageError);
      expect(gh.calls).toHaveLength(1);
    }
  });

  test("text and date fields; the @me owner reads the viewer's Project", async () => {
    const gh = fakeGh([read({ id: "F3", dataType: "DATE" }, [{ id: "IT1", project: { number: 1 } }], "viewer"), () => ({})]);
    await setField(gh, { ...withPhase, owner: "@me" }, 1, "Due", "2026-09-28", () => undefined);
    expect(query(gh.calls[0])).toContain("viewer{ projectV2(number:$p)");
    expect(vars(gh.calls[0])).not.toHaveProperty("o");
    expect(vars(gh.calls[1])).toMatchObject({ value: "2026-09-28" });
    expect(query(gh.calls[1])).toContain("$value:Date!");
    const gh2 = fakeGh([read({ id: "F4", dataType: "TEXT" }, [{ id: "IT1", project: { number: 1 } }]), () => ({})]);
    await setField(gh2, withPhase, 1, "Note", "hi", () => undefined);
    expect(query(gh2.calls[1])).toContain("{ text: $value }");
  });

  test("a missing Project or Issue is an error, not a silent no-op", async () => {
    await expect(setField(fakeGh([() => ({ repositoryOwner: { projectV2: null }, repository: { issue: { id: "I1", projectItems: { nodes: [] } } } })]), withPhase, 1, "Status", "Ready", () => undefined)).rejects.toThrow(/Project example\/1/);
    await expect(setField(fakeGh([() => ({ repositoryOwner: { projectV2: { id: "P1", field } }, repository: { issue: null } })]), withPhase, 1, "Status", "Ready", () => undefined)).rejects.toThrow(/Issue #1/);
  });
});
