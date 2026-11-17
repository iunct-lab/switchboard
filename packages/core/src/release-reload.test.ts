import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { readShippedDefaults, startServer, type CoreServer } from "./server.ts";

const NO_GH = async () => ({ code: 1, stdout: "", stderr: "no gh in this test" });
const price = (input: number) => JSON.stringify({ version: 1, billing: {}, models: { "m-test": { input, output: 1, cacheRead: 0, cacheWrite: 0 } }, aliases: {} });

let home: string;
let core: CoreServer;
let base: string;

function release(sha: string, pricing: string | null) {
  const root = join(home, "releases", sha);
  mkdirSync(join(root, "apps", "web", "dist"), { recursive: true });
  mkdirSync(join(root, "packages", "core", "config"), { recursive: true });
  writeFileSync(join(root, "apps", "web", "dist", "index.html"), `<title>${sha}</title>`);
  if (pricing !== null) writeFileSync(join(root, "packages", "core", "config", "pricing.json"), pricing);
}
function point(sha: string) {
  try { unlinkSync(join(home, "releases", "current")); } catch { /* first time */ }
  symlinkSync(sha, join(home, "releases", "current"));
}
const get = (path: string) => fetch(`${base}${path}`);
const inputPrice = async () => ((await (await get("/api/ledger/pricing")).json()) as { models: Record<string, { input: number }> }).models["m-test"]?.input;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "switchboard-test-release-reload-"));
  release("shaA", price(1));
  release("shaB", price(2));
  release("shaBroken", "{ not json");
  point("shaA");
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  // the daemon at boot serves the version `current` names, as sb-rescue starts it from there
  core = await startServer({ ...cfg, codeRoot: join(home, "releases", "shaA"), webDist: join(home, "releases", "shaA", "apps", "web", "dist") }, [], { port: 0, selfdevChecks: false, gh: NO_GH });
  base = `http://127.0.0.1:${core.server.port}`;
});
afterAll(async () => {
  await core.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("reloadRelease", () => {
  test("serves the new Web UI, prices and webRelease after current moves; a broken shipped file keeps the old value; the user's copy wins", async () => {
    expect(await (await get("/")).text()).toContain("shaA");
    expect(await inputPrice()).toBe(1);

    point("shaB");
    expect(core.reloadRelease()).toBe("shaB");
    expect(await (await get("/")).text()).toContain("shaB");
    expect(await inputPrice()).toBe(2);
    expect(((await (await get("/api/health")).json()) as { webRelease: string }).webRelease).toBe("shaB");

    // a version whose pricing.json is broken: the UI moves on, the table stays shaB's
    point("shaBroken");
    expect(core.reloadRelease()).toBe("shaBroken");
    expect(await (await get("/")).text()).toContain("shaBroken");
    expect(await inputPrice()).toBe(2);

    // the user's own copy is read first
    writeFileSync(join(home, "pricing.json"), price(9));
    try {
      point("shaA");
      expect(core.reloadRelease()).toBe("shaA");
      expect(await inputPrice()).toBe(9);
    } finally {
      rmSync(join(home, "pricing.json"), { force: true });
      point("shaA");
    }
  });

  test("without releases/current nothing changes and null comes back", async () => {
    point("shaA");
    expect(core.reloadRelease()).toBe("shaA");
    unlinkSync(join(home, "releases", "current"));
    try {
      expect(core.reloadRelease()).toBeNull();
      expect(await (await get("/")).text()).toContain("shaA");
    } finally {
      point("shaA");
    }
  });
});

describe("readShippedDefaults", () => {
  const dir = () => {
    const d = mkdtempSync(join(tmpdir(), "switchboard-test-shipped-defaults-"));
    const root = join(d, "rel");
    mkdirSync(join(root, "packages", "core", "config"), { recursive: true });
    return { d, root, put: (file: string, body: string) => writeFileSync(join(root, "packages", "core", "config", file), body) };
  };

  test("reads routing.yaml and mcp.yaml from the release; the user's copy wins", () => {
    const { d, root, put } = dir();
    try {
      put("routing.yaml", "version: 1\nrules: []\nfallback: { runner: codex, reason: shipped }\n");
      put("mcp.yaml", "sessions:\n  maxPerTask: 7\n");
      put("pricing.json", price(5));
      const a = readShippedDefaults(d, root);
      expect(a.kept).toEqual([]);
      expect(a.pricing?.table.models["m-test"]?.input).toBe(5);
      expect(a.routing?.table.fallback.runner).toBe("codex");
      expect(a.mcpPolicy?.sessions.maxPerTask).toBe(7);
      writeFileSync(join(d, "mcp.yaml"), "sessions:\n  maxPerTask: 3\n");
      expect(readShippedDefaults(d, root).mcpPolicy?.sessions.maxPerTask).toBe(3);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("a broken or missing shipped file leaves that table out so the previous value stays", () => {
    const { d, root, put } = dir();
    try {
      put("routing.yaml", "rules: [\n");
      put("mcp.yaml", "sessions: [\n");
      const b = readShippedDefaults(d, root);
      expect(b.routing).toBeUndefined();
      expect(b.mcpPolicy).toBeUndefined();
      expect(b.pricing).toBeUndefined(); // no pricing.json anywhere
      expect(b.kept.length).toBe(3);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
