// test-reads: container/Dockerfile
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chooseCodexSource, codexPin, resolveGeneration, sweepStaleFetches } from "./codex_types";

let cache: string;
beforeEach(() => {
  cache = mkdtempSync(join(tmpdir(), "switchboard.codex-types-test."));
});
afterEach(() => rmSync(cache, { recursive: true, force: true }));

const base = () => ({ pin: "0.167.0", hostVersion: "codex-cli 0.167.0", hostBin: "/host/codex", env: {}, cacheDir: cache });

describe("codexPin", () => {
  test("reads the version from the real container/Dockerfile", () => {
    const dockerfile = readFileSync(resolve(import.meta.dir, "..", "container", "Dockerfile"), "utf8");
    expect(codexPin(dockerfile)).toMatch(/^\d+\.\d+\.\d+/);
  });
  test("reads the ARG line and throws when it is missing", () => {
    expect(codexPin("FROM x\nARG CODEX_VERSION=1.2.3\nRUN y\n")).toBe("1.2.3");
    expect(() => codexPin("FROM x\n")).toThrow();
  });
});

describe("chooseCodexSource", () => {
  test("uses the host's Codex only when its version is the pin", () => {
    expect(chooseCodexSource(base())).toEqual({ kind: "bin", bin: "/host/codex" });
  });
  test("does not use the host's Codex when its version differs from the pin", () => {
    const s = chooseCodexSource({ ...base(), hostVersion: "codex-cli 0.170.0" });
    expect(s).toEqual({ kind: "fetch", dir: join(cache, "0.167.0") });
  });
  test("does not use a host version that merely starts with the pin", () => {
    expect(chooseCodexSource({ ...base(), hostVersion: "codex-cli 0.167.01" }).kind).toBe("fetch");
  });
  test("fetches when there is no host Codex", () => {
    expect(chooseCodexSource({ ...base(), hostVersion: undefined, hostBin: undefined }).kind).toBe("fetch");
  });
  test("reads the cache instead of fetching when it holds the pin", () => {
    mkdirSync(join(cache, "0.167.0"), { recursive: true });
    writeFileSync(join(cache, "0.167.0", "VERSION"), "codex-cli 0.167.0\n");
    expect(chooseCodexSource({ ...base(), hostVersion: "codex-cli 0.170.0" })).toEqual({ kind: "dir", dir: join(cache, "0.167.0") });
  });
  test("a cache for another version does not count", () => {
    mkdirSync(join(cache, "0.166.0"), { recursive: true });
    writeFileSync(join(cache, "0.166.0", "VERSION"), "codex-cli 0.166.0\n");
    expect(chooseCodexSource({ ...base(), hostVersion: "codex-cli 0.170.0" }).kind).toBe("fetch");
  });
  test("CODEX_TS_DIR wins over everything, then CODEX_BIN", () => {
    expect(chooseCodexSource({ ...base(), env: { CODEX_TS_DIR: "/g", CODEX_BIN: "/b" } })).toEqual({ kind: "dir", dir: "/g" });
    expect(chooseCodexSource({ ...base(), hostVersion: "codex-cli 0.170.0", env: { CODEX_BIN: "/b" } })).toEqual({ kind: "bin", bin: "/b" });
  });
});

describe("resolveGeneration", () => {
  test("a failed fetch throws and does not fall back to the host's Codex", () => {
    const a = { ...base(), hostVersion: "codex-cli 0.170.0", fetch: () => { throw new Error("npm が失敗"); } };
    expect(() => resolveGeneration(a)).toThrow("pin の Codex 0.167.0 を取れない: npm が失敗");
  });
  test("a fetch that succeeds reads the pin's cache dir", () => {
    const a = { ...base(), hostVersion: "codex-cli 0.170.0", fetch: () => {} };
    expect(resolveGeneration(a)).toEqual({ genDir: join(cache, "0.167.0") });
  });
});

describe("sweepStaleFetches", () => {
  test("removes old .fetch- dirs a killed fetch left, keeps young ones and the generations", () => {
    for (const d of [".fetch-old", ".fetch-young", "0.167.0"]) mkdirSync(join(cache, d));
    const now = Date.now();
    const old = new Date(now - 60 * 60_000);
    utimesSync(join(cache, ".fetch-old"), old, old);
    utimesSync(join(cache, "0.167.0"), old, old);
    sweepStaleFetches(cache, now);
    expect(existsSync(join(cache, ".fetch-old"))).toBe(false);
    expect(existsSync(join(cache, ".fetch-young"))).toBe(true);
    expect(existsSync(join(cache, "0.167.0"))).toBe(true);
  });
});
