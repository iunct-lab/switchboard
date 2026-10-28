import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";

const made: string[] = [];
const dir = (parent: string, prefix: string) => {
  const d = mkdtempSync(join(parent, prefix));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("knowledgeDir (#2865)", () => {
  test("a temporary data folder keeps Knowledge inside it, not in the user's ~/Knowledge", () => {
    const home = dir(tmpdir(), "sb-config-");
    expect(loadConfig({ SWITCHBOARD_HOME: home }).knowledgeDir).toBe(join(home, "Knowledge"));
  });

  test("a temporary database alone counts as temporary", () => {
    const home = dir(homedir(), ".sb-config-test-");
    const db = join(dir(tmpdir(), "sb-config-db-"), "switchboard.db");
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_DB: db }).knowledgeDir).toBe(join(home, "Knowledge"));
  });

  test("SWITCHBOARD_KNOWLEDGE wins over the temporary default", () => {
    const home = dir(tmpdir(), "sb-config-");
    const knowledge = dir(tmpdir(), "sb-config-k-");
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_KNOWLEDGE: knowledge }).knowledgeDir).toBe(knowledge);
  });

  test("a data folder outside the temp area keeps the default ~/Knowledge", () => {
    const home = dir(homedir(), ".sb-config-test-");
    expect(loadConfig({ SWITCHBOARD_HOME: home }).knowledgeDir).toBe(join(homedir(), "Knowledge"));
  });
});
