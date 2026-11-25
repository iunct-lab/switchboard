import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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

describe("reposDir", () => {
  test("next to the development checkout by default; SWITCHBOARD_REPOS_DIR names another place", () => {
    const home = dir(tmpdir(), "sb-config-");
    const c = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: "/srv/code/switchboard" });
    expect(c.reposDir).toBe("/srv/code");
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: "/srv/code/switchboard", SWITCHBOARD_REPOS_DIR: "/home/switchboard/repos/" }).reposDir).toBe("/home/switchboard/repos");
  });
});

describe("repoRoot", () => {
  test("a release directory next to releases/current is read as the link; another directory is kept as given", () => {
    const home = dir(tmpdir(), "sb-config-");
    const releases = join(home, "releases");
    const sha = "a".repeat(40);
    mkdirSync(join(releases, sha), { recursive: true });
    mkdirSync(join(releases, "b".repeat(40)));
    symlinkSync("b".repeat(40), join(releases, "current"));
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: join(releases, sha) }).repoRoot).toBe(join(releases, "current"));
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: join(releases, "current") }).repoRoot).toBe(join(releases, "current"));
    // the candidate sb-rescue starts on a release is that release, not the running one `current` still names
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: join(releases, sha), SWITCHBOARD_CANDIDATE: "1" }).repoRoot).toBe(join(releases, sha));
    // a release id under a folder that is not `releases`, even with a `current` beside it; a name that is not a release id: as given
    mkdirSync(join(home, "code", sha), { recursive: true });
    symlinkSync(sha, join(home, "code", "current"));
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: join(home, "code", sha) }).repoRoot).toBe(join(home, "code", sha));
    mkdirSync(join(releases, "current-not"), { recursive: true });
    expect(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_REPO_ROOT: join(releases, "current-not") }).repoRoot).toBe(join(releases, "current-not"));
  });
});

describe("knowledgeDir", () => {
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

describe("dockerdIdleMs", () => {
  test("dockerd idle wait defaults to 10 minutes", () => {
    expect(loadConfig({ SWITCHBOARD_HOME: tmpdir() }).dockerdIdleMs).toBe(10 * 60_000);
  });
  test("dockerd idle wait is overridden by SWITCHBOARD_DOCKERD_IDLE_MIN; a non-number or 0 or less keeps the default", () => {
    expect(loadConfig({ SWITCHBOARD_HOME: tmpdir(), SWITCHBOARD_DOCKERD_IDLE_MIN: "3" }).dockerdIdleMs).toBe(3 * 60_000);
    for (const bad of ["x", "0", "-5", ""]) expect(loadConfig({ SWITCHBOARD_HOME: tmpdir(), SWITCHBOARD_DOCKERD_IDLE_MIN: bad }).dockerdIdleMs).toBe(10 * 60_000);
  });
});
