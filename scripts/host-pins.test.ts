// test-reads: aws/host/node.sh aws/host/devtools.sh
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestOf, outdatedPins, PinsUnreadable, readPins, readPinsOutdated, type FetchText, type Pin } from "./host-pins";

const repo = join(import.meta.dir, "..");
const nodeSh = readFileSync(join(repo, "aws/host/node.sh"), "utf8");
const devtoolsSh = readFileSync(join(repo, "aws/host/devtools.sh"), "utf8");
const NAMES = ["NODE_VERSION", "DOCKER_VERSION", "COMPOSE_VERSION", "UV_VERSION", "GITLEAKS_VERSION", "SAM_VERSION", "PLAYWRIGHT_VERSION", "PLAYWRIGHT_MCP_VERSION", "GH_STACK_VERSION"];

const answers = (table: Record<string, unknown>): FetchText => async (url) => {
  const a = Object.entries(table).find(([k]) => url.includes(k));
  if (!a) throw new Error(`no answer for ${url}`);
  return typeof a[1] === "string" ? a[1] : JSON.stringify(a[1]);
};

const node: Pin = { name: "NODE_VERSION", pinned: "24.22.1", source: { kind: "node" } };
const uv: Pin = { name: "UV_VERSION", pinned: "0.12.19", source: { kind: "github", repo: "astral-sh/uv" } };
const rel = (tag_name: string, over = {}) => ({ tag_name, draft: false, prerelease: false, ...over });

describe("readPins", () => {
  test("reads every pin of the real files, without the v", () => {
    const { pins, unreadable } = readPins(nodeSh, devtoolsSh);
    expect(unreadable).toEqual([]);
    expect(pins.map((p) => p.name)).toEqual(NAMES);
    for (const p of pins) expect(p.pinned).toMatch(/^\d+(\.\d+)+$/);
  });

  test("a missing or malformed pin is unreadable, not dropped", () => {
    const r = readPins("NODE_VERSION=latest\n", devtoolsSh.replace(/^UV_VERSION=.*$/m, ""));
    expect(r.unreadable).toEqual(["NODE_VERSION", "UV_VERSION"]);
  });
});

describe("latestOf", () => {
  const index = [
    { version: "v25.1.0", lts: false, security: true },
    { version: "v24.23.0", lts: "Krypton", security: false },
    { version: "v24.22.1", lts: "Krypton", security: false },
    { version: "v24.22.0", lts: "Krypton", security: true },
    { version: "v22.30.0", lts: "Jod", security: true },
  ];

  test("Node.js: the newest LTS of the pinned major, not a security release when only older or other lines are", async () => {
    expect(await latestOf(node, answers({ "index.json": index }))).toEqual({ latest: "24.23.0", security: false });
  });

  test("Node.js: a security release after the pin", async () => {
    const rows = [{ version: "v24.24.0", lts: "Krypton", security: false }, { version: "v24.23.0", lts: "Krypton", security: true }, ...index.slice(2)];
    expect(await latestOf(node, answers({ "index.json": rows }))).toEqual({ latest: "24.24.0", security: true });
  });

  test("GitHub: releases/latest, which leaves pre-releases out", async () => {
    expect(await latestOf(uv, answers({ "repos/astral-sh/uv/releases/latest": rel("v0.12.20") }))).toEqual({ latest: "0.12.20" });
    expect(await latestOf(uv, answers({ "repos/astral-sh/uv/releases/latest": rel("0.12.20") }))).toEqual({ latest: "0.12.20" });
  });

  test("docker: the highest version of the file list, version-wise", async () => {
    const page = `<a href="docker-29.9.2.tgz">x</a><a href="docker-29.10.0.tgz">x</a><a href="docker-rootless-extras-30.0.0.tgz">x</a><a href="docker-30.0.0-rc1.tgz">x</a>`;
    expect(await latestOf({ name: "DOCKER_VERSION", pinned: "29.8.1", source: { kind: "docker" } }, answers({ "download.docker.com": page }))).toEqual({ latest: "29.10.0" });
  });

  test("npm: the latest tag", async () => {
    expect(await latestOf({ name: "PLAYWRIGHT_MCP_VERSION", pinned: "0.0.82", source: { kind: "npm", pkg: "@playwright/mcp" } }, answers({ "@playwright/mcp/latest": { version: "0.0.90" } }))).toEqual({ latest: "0.0.90" });
  });

  test("an answer with no version throws", async () => {
    await expect(latestOf(uv, answers({ releases: {} }))).rejects.toThrow();
    await expect(latestOf(uv, answers({ releases: rel("v0.13.0-rc1") }))).rejects.toThrow(/pre-release/);
    await expect(latestOf({ name: "PLAYWRIGHT_VERSION", pinned: "1.63.0", source: { kind: "npm", pkg: "playwright" } }, answers({ "playwright/latest": { version: "1.65.0-beta" } }))).rejects.toThrow();
    await expect(latestOf(node, answers({ "index.json": "<html>" }))).rejects.toThrow();
  });
});

describe("outdatedPins", () => {
  test("nothing behind", () => {
    expect(outdatedPins([node, uv], { NODE_VERSION: { latest: "24.22.1", security: false }, UV_VERSION: { latest: "0.12.19" } })).toEqual([]);
  });
  test("behind, with the security mark only when it is one; a pin newer than the latest is not behind", () => {
    expect(outdatedPins([node, uv], { NODE_VERSION: { latest: "24.23.0", security: true }, UV_VERSION: { latest: "0.12.18" } })).toEqual([{ name: "NODE_VERSION", pinned: "24.22.1", latest: "24.23.0", security: true }]);
    expect(outdatedPins([uv], { UV_VERSION: { latest: "0.12.20" } })).toEqual([{ name: "UV_VERSION", pinned: "0.12.19", latest: "0.12.20" }]);
  });
});

describe("readPinsOutdated", () => {
  const nodeMajor = /^NODE_VERSION=(\d+)\./m.exec(nodeSh)![1];
  const nodePinned = /^NODE_VERSION=(\S+)$/m.exec(nodeSh)![1];
  const distributors: Record<string, unknown> = {
    "index.json": [{ version: `v${nodeMajor}.999.0`, lts: "Krypton", security: true }],
    "download.docker.com": `<a href="docker-0.0.1.tgz">x</a>`,
    "docker/compose": rel("v0.0.1"),
    "astral-sh/uv": rel("0.0.1"),
    "gitleaks/gitleaks": rel("v0.0.1"),
    "aws/aws-sam-cli": rel("v0.0.1"),
    "playwright/latest": { version: "0.0.1" },
    "@playwright/mcp/latest": { version: "0.0.1" },
    "github/gh-stack": rel("v0.0.1"),
  };

  test("all nine read: what is behind", async () => {
    expect(await readPinsOutdated(answers(distributors))).toEqual([{ name: "NODE_VERSION", pinned: nodePinned!, latest: `${nodeMajor}.999.0`, security: true }]);
  });

  test("one distributor failing is unreadable for the whole read, and names it", async () => {
    const f: FetchText = async (url) => {
      if (url.includes("gitleaks")) throw new Error("api.github.com answered 403");
      return answers(distributors)(url);
    };
    await expect(readPinsOutdated(f)).rejects.toBeInstanceOf(PinsUnreadable);
    await expect(readPinsOutdated(f)).rejects.toThrow("GITLEAKS_VERSION: api.github.com answered 403");
  });

  test("a pin line that cannot be read is unreadable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.host-pins."));
    try {
      mkdirSync(join(dir, "aws/host"), { recursive: true });
      writeFileSync(join(dir, "aws/host/node.sh"), nodeSh);
      writeFileSync(join(dir, "aws/host/devtools.sh"), devtoolsSh.replace(/^UV_VERSION=.*$/m, ""));
      await expect(readPinsOutdated(answers(distributors), dir)).rejects.toThrow("UV_VERSION: 固定の行が読めない");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
