import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fakeGh, type FakeCall } from "./gh.ts";
import { parseLabels, syncLabels } from "./labels.ts";

const want = parseLabels(`
- name: bug
  color: D73A4A
  description: 想定と異なる動作
- name: "type:pbi"
  color: 5c7cfa
  description: PBI
- name: docs
  color: 0075ca
`);
const api = (c: FakeCall) => (c.kind === "api" ? c : { path: "", opts: {} as { method?: string; body?: unknown } });

describe("parseLabels", () => {
  test("name, color in lower case, description ('' when absent)", () => {
    expect(want).toEqual([
      { name: "bug", color: "d73a4a", description: "想定と異なる動作" },
      { name: "type:pbi", color: "5c7cfa", description: "PBI" },
      { name: "docs", color: "0075ca", description: "" },
    ]);
  });
  test("the repository's .github/labels.yml parses", () => {
    expect(parseLabels(readFileSync(join(import.meta.dir, "../../.github/labels.yml"), "utf8")).length).toBeGreaterThan(5);
  });
  test("a color that is not 6 hex digits or that YAML reads as a number, or no list, is refused", () => {
    expect(() => parseLabels("- name: x\n  color: red\n")).toThrow(/1 件目/);
    expect(() => parseLabels("- name: x\n  color: 5319e7\n")).toThrow(/"" で囲む/);
    expect(() => parseLabels("name: x\n")).toThrow(/一覧/);
  });
});

describe("syncLabels", () => {
  test("missing → created, changed → updated, an unknown label is not deleted", async () => {
    const gh = fakeGh([
      () => [{ name: "Bug", color: "d73a4a", description: "想定と異なる動作" }, { name: "keep-me", color: "000000", description: null }, { name: "docs", color: "111111", description: "" }],
      () => ({}),
      () => ({}),
      () => ({}),
    ]);
    const changes = await syncLabels(gh, "o/r", want, {}, () => {});
    expect(changes).toEqual(["update bug", "create type:pbi", "update docs"]);
    expect(gh.calls.map((c) => `${api(c).opts.method ?? "GET"} ${api(c).path}`)).toEqual([
      "GET repos/o/r/labels?per_page=100&page=1",
      "PATCH repos/o/r/labels/Bug",
      "POST repos/o/r/labels",
      "PATCH repos/o/r/labels/docs",
    ]);
    expect(api(gh.calls[1]!).opts.body).toEqual({ new_name: "bug", color: "d73a4a", description: "想定と異なる動作" });
    expect(api(gh.calls[2]!).opts.body).toEqual({ name: "type:pbi", color: "5c7cfa", description: "PBI" });
    expect(gh.calls.some((c) => api(c).opts.method === "DELETE")).toBe(false);
  });

  test("a second run on matching labels changes nothing; pages are read until a short one", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ name: `x${i}`, color: "000000", description: "" }));
    const gh = fakeGh([() => filler, () => want.map((l) => ({ ...l, color: l.color.toUpperCase() }))]);
    expect(await syncLabels(gh, "o/r", want, {}, () => {})).toEqual([]);
    expect(gh.calls).toHaveLength(2);
  });

  test("--dry-run lists the changes and writes nothing", async () => {
    const gh = fakeGh([() => []]);
    const log: string[] = [];
    expect(await syncLabels(gh, "o/r", want, { dryRun: true }, (s) => log.push(s))).toEqual(["create bug", "create type:pbi", "create docs"]);
    expect(gh.calls).toHaveLength(1);
    expect(log.at(-1)).toContain("変える: 3 件");
  });
});
