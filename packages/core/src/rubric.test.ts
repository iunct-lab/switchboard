import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Rubric } from "@switchboard/protocol";
import { DEFAULT_RUBRIC, loadRubric, rubricKey, rubricPath } from "./rubric.ts";

describe("rubric (#1219)", () => {
  test("the default parses and names the five criteria, each with 1 / 3 / 5 anchors", () => {
    expect(Rubric.safeParse(DEFAULT_RUBRIC).success).toBe(true);
    expect(DEFAULT_RUBRIC.criteria.map((c) => c.id)).toEqual(["goal", "instructions", "efficiency", "communication", "safety"]);
    for (const c of DEFAULT_RUBRIC.criteria) expect(Object.keys(c.anchors).sort()).toEqual(["1", "3", "5"]);
    expect(rubricKey(DEFAULT_RUBRIC)).toBe("switchboard-default@1");
  });

  test("the person's evals/rubric.json replaces the default; a broken or invalid one falls back with one warning; none → default, no warning", () => {
    const home = mkdtempSync(join(tmpdir(), "switchboard-rubric-"));
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    try {
      expect(loadRubric(home, log)).toBe(DEFAULT_RUBRIC);
      expect(logs).toEqual([]);
      mkdirSync(join(home, "evals"), { recursive: true });
      const own = { id: "mine", version: 2, criteria: [{ id: "a", title: "A", anchors: { "1": "x", "3": "y", "5": "z" } }, { id: "b", title: "B", anchors: { "1": "x", "3": "y", "5": "z" } }] };
      writeFileSync(rubricPath(home), JSON.stringify(own));
      const r = loadRubric(home, log);
      expect(rubricKey(r)).toBe("mine@2");
      expect(r.criteria).toHaveLength(2);
      expect(logs).toEqual([]);
      writeFileSync(rubricPath(home), "{ not json");
      expect(loadRubric(home, log)).toBe(DEFAULT_RUBRIC);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("既定を使う");
      writeFileSync(rubricPath(home), JSON.stringify({ id: "mine", version: 3, criteria: [] }));
      expect(loadRubric(home, log)).toBe(DEFAULT_RUBRIC);
      expect(logs).toHaveLength(2);
      expect(logs[1]).toContain("criteria");
      // the same id twice would leave one score without a slot: refused like any other invalid rubric
      writeFileSync(rubricPath(home), JSON.stringify({ ...own, criteria: [own.criteria[0], own.criteria[0]] }));
      expect(loadRubric(home, log)).toBe(DEFAULT_RUBRIC);
      expect(logs).toHaveLength(3);
      expect(logs[2]).toContain("unique");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
