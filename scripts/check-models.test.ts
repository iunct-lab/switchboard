import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_MODELS } from "../packages/adapters/claude/src/index.ts";
import { CODEX_MODELS } from "../packages/adapters/codex/src/index.ts";
import { Database } from "bun:sqlite";
import { loadPricing } from "../packages/core/src/pricing.ts";
import { checkModels, claudeCatalog, claudeTableText, classifyUnpriced, codexCatalog, compareModels, compareVersions, hostReaders, hostVersions, KINDS, REVIEWED, requestFor, unpricedLedgerNames, unpricedListed, type Readers, type Report, type VersionReaders } from "./check-models";
import { alreadyFiled } from "./file-request";

// Excerpts of what the CLIs carry (claude 2.1.285's embedded table, codex-cli 0.159.2's `debug models --bundled`).
const CLAUDE_TABLE =
  'x=[{id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5",max_tokens:128000},' +
  '{id:"claude-haiku-4-5",family:"haiku",display_name:"Haiku 4.5"},{id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5"}];' +
  'y={id:"not-a-model",family:"x"}';
const CODEX_JSON = JSON.stringify({
  models: [
    { slug: "gpt-6.1-sol", visibility: "list" },
    { slug: "gpt-6-astra", visibility: "list" },
    { slug: "gpt-6-sol", visibility: "list" },
    { slug: "codex-auto-review", visibility: "hide" },
  ],
});

const PRICING = loadPricing([join(import.meta.dir, "..", "packages", "core", "config", "pricing.json")]).table;
/** No CLI on PATH as far as the version check is concerned: nothing is compared, no line. */
const NO_VERSIONS: VersionReaders = { installed: async () => null, latest: async () => { throw new Error("not asked"); } };
const sources = (read: Readers, pricing = PRICING, versions: VersionReaders = NO_VERSIONS) => ({ read, versions, pricing, dbPath: join(tmpdir(), "switchboard.check-models.no-such.db") });
/** Tables that match the UI's lists exactly: no drift of their own, so a test of the version check sees only its lines. */
const CLEAN: Readers = {
  claude: async () => REVIEWED.claude.map((id) => `{id:"${id}",family:"x",display_name:"X"}`).join(","),
  codex: async () => JSON.stringify({ models: REVIEWED.codex.map((slug) => ({ slug, visibility: "list" })) }),
};

describe("check-models", () => {
  test("claudeCatalog reads the ids of the embedded table once each", () => {
    expect(claudeCatalog(CLAUDE_TABLE)).toEqual(["claude-opus-5-5", "claude-haiku-4-5"]);
    expect(claudeCatalog("no table here")).toEqual([]);
  });

  test("codexCatalog keeps the listed slugs and drops hidden ones", () => {
    expect(codexCatalog(CODEX_JSON)).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol"]);
  });

  test("stale id is reported", () => {
    const r = compareModels({ listed: ["claude-opus-5-4", "claude-haiku-4-5"], catalog: ["claude-opus-5-5", "claude-haiku-4-5"], reviewed: ["claude-opus-5-5", "claude-haiku-4-5"] });
    expect(r).toEqual({ stale: ["claude-opus-5-4"], unseen: [] });
  });

  test("new catalog id is reported", () => {
    const r = compareModels({ listed: ["gpt-6-sol"], catalog: ["gpt-6-sol", "gpt-6.1-sol", "gpt-5.6-terra"], reviewed: ["gpt-6-sol", "gpt-5.6-terra"] });
    expect(r).toEqual({ stale: [], unseen: ["gpt-6.1-sol"] });
  });

  test("the lists in the UI are all reviewed ids", () => {
    for (const m of CLAUDE_MODELS) expect(REVIEWED.claude).toContain(m.value);
    for (const m of CODEX_MODELS) expect(REVIEWED.codex).toContain(m.value);
  });

  test("exit 2 when a CLI is missing or its table reads as empty; drift still shows for the other", async () => {
    const r = await checkModels(sources({ claude: async () => null, codex: async () => CODEX_JSON }));
    expect(r.code).toBe(2);
    // CODEX_JSON lacks gpt-6-luna, which the UI lists: the codex comparison still runs after claude could not be read.
    expect(r.lines).toEqual(["claude: 判定できなかった（CLI が PATH に無い）", "codex stale: gpt-6-luna", "unpriced (ledger): なし"]);
    expect((await checkModels(sources({ claude: async () => "", codex: async () => CODEX_JSON }))).lines[0]).toContain("0 件");
  });

  test("unpriced listed model", async () => {
    const { "claude-sonnet-5-5": _, ...models } = PRICING.models;
    const table = { ...PRICING, models };
    expect(unpricedListed(["claude-opus-5-5", "claude-sonnet-5-5"], table, "claude")).toEqual(["claude-sonnet-5-5"]);
    expect(unpricedListed(["claude-opus-5-5", "claude-sonnet-5-5"], PRICING, "claude")).toEqual([]);
    const claude = async () => REVIEWED.claude.map((id) => `{id:"${id}",family:"x",display_name:"X"}`).join(",");
    const codex = async () => JSON.stringify({ models: REVIEWED.codex.map((slug) => ({ slug, visibility: "list" })) });
    const r = await checkModels(sources({ claude, codex }, table));
    expect(r.code).toBe(1);
    expect(r.lines[0]).toBe("claude 価格表未整備: claude-sonnet-5-5");
  });

  test("unpriced ledger names are classified", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.check-models."));
    try {
      const path = join(dir, "switchboard.db");
      const db = new Database(path);
      db.exec("CREATE TABLE ledger (runner TEXT NOT NULL, model TEXT, source TEXT NOT NULL)");
      const add = db.prepare("INSERT INTO ledger (runner, model, source) VALUES (?, ?, ?)");
      for (const row of [["claude", "claude-opus-6[1m]", "unpriced"], ["claude", "claude-opus-6[1m]", "unpriced"], ["codex", "gpt-6-typo", "unpriced"], ["codex", "gpt-6-sol", "reported"], ["dak", "llamacpp", "unpriced"], ["codex", null, "unpriced"]]) add.run(...(row as [string, string | null, string]));
      db.close();
      const names = unpricedLedgerNames(path);
      expect(names).toEqual([{ runner: "claude", model: "claude-opus-6[1m]" }, { runner: "codex", model: "gpt-6-typo" }]);
      expect(classifyUnpriced(names, { claude: ["claude-opus-6"], codex: ["gpt-6-sol"] })).toEqual({ new: ["claude claude-opus-6[1m]"], unknown: ["codex gpt-6-typo"] });
      expect(classifyUnpriced(names, { claude: ["claude-opus-6"] })).toEqual({ new: ["claude claude-opus-6[1m]"], unknown: [] });
      expect(classifyUnpriced([{ runner: "claude", model: "claude-opus-6-20261101" }], { claude: ["claude-opus-6"] }).new).toEqual(["claude claude-opus-6-20261101"]);
      const empty = join(dir, "empty.db");
      new Database(empty).close();
      expect(unpricedLedgerNames(empty)).toEqual([]);
      expect(unpricedLedgerNames(join(dir, "missing.db"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("claudeTableText finds entries across chunk boundaries of a large file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.check-models."));
    try {
      const file = join(dir, "claude");
      const entry = (id: string) => `{id:"${id}",family:"x",display_name:"X"}`;
      writeFileSync(file, "\0".repeat(3_000_000));
      let first = 0;
      for await (const c of Bun.file(file).stream()) {
        first = c.length;
        break;
      }
      // One entry cut in two by the first chunk boundary, one well inside a later chunk.
      const a = entry("claude-opus-5-5");
      const head = "\0".repeat(first - 20) + a;
      writeFileSync(file, head + "\0".repeat(1_000_000) + entry("claude-haiku-4-5") + "\0".repeat(1_000_000));
      expect(claudeCatalog(await claudeTableText(file))).toEqual(["claude-opus-5-5", "claude-haiku-4-5"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a ledger name the price table now prices is not reported", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.check-models."));
    try {
      const dbPath = join(dir, "switchboard.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE ledger (runner TEXT NOT NULL, model TEXT, source TEXT NOT NULL)");
      db.exec("INSERT INTO ledger VALUES ('claude', 'claude-opus-5-5', 'unpriced'), ('claude', 'claude-opus-6', 'unpriced')");
      db.close();
      const claude = async () => [...REVIEWED.claude, "claude-opus-6"].map((id) => `{id:"${id}",family:"x",display_name:"X"}`).join(",");
      const codex = async () => JSON.stringify({ models: REVIEWED.codex.map((slug) => ({ slug, visibility: "list" })) });
      const r = await checkModels({ read: { claude, codex }, versions: NO_VERSIONS, pricing: PRICING, dbPath });
      expect(r.lines).toContain("unpriced (ledger) new（価格表未整備）: claude claude-opus-6");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const SOURCE = { date: "2026-09-30", versions: ["claude 2.1.285 (Claude Code)", "codex 0.159.2"] };
  const drift = (findings: Report["findings"]): Report => ({ lines: ["codex unseen: gpt-6.1-sol"], code: 1, findings });

  test("compareVersions: numeric major.minor.patch, anything after ignored", () => {
    expect(compareVersions("2.1.289", "2.1.293")).toBe(-1);
    expect(compareVersions("2.1.293", "2.1.289")).toBe(1);
    expect(compareVersions("0.162.1", "0.162.1")).toBe(0);
    expect(compareVersions("2.1.296 (Claude Code)", "2.1.296")).toBe(0);
    expect(compareVersions("codex-cli 0.9.10", "0.10.0")).toBe(-1); // numeric, not lexical
    expect(compareVersions("3.0.0", "2.99.99")).toBe(1);
    expect(() => compareVersions("latest", "1.0.0")).toThrow("not a version");
  });

  test("outdated: an installed CLI behind the registry's latest is drift (exit 1) with a finding; the same or newer is a version line", async () => {
    const versions = (installed: Record<string, string | null>, latest: Record<string, string>): VersionReaders => ({ installed: async (r) => installed[r] ?? null, latest: async (r) => latest[r]! });
    const r = await checkModels(sources(CLEAN, PRICING, versions({ claude: "2.1.289", codex: "0.162.1" }, { claude: "2.1.293", codex: "0.162.1" })));
    expect(r.lines).toContain("claude outdated: 2.1.289 → 2.1.293");
    expect(r.lines).toContain("codex version: 0.162.1（最新）");
    expect(r.findings).toContainEqual({ runner: "claude", kind: "outdated", ids: ["2.1.289"] }); // the installed version only: one request while the CLI stays, whatever npm publishes
    expect(r.code).toBe(1);
    // a CLI not on PATH for the version check: no line, nothing asked of the registry
    const none = await checkModels(sources(CLEAN, PRICING, versions({ claude: null, codex: null }, {})));
    expect(none.lines.filter((l) => /version|outdated|latest/.test(l))).toEqual([]);
    expect(none.code).toBe(0);
    // the table comparison's result stands: both up to date and the tables clean → 0; an exit 2 stays 2 with an outdated CLI
    expect((await checkModels(sources(CLEAN, PRICING, versions({ claude: "2.1.296", codex: "0.162.1" }, { claude: "2.1.296", codex: "0.162.1" })))).code).toBe(0);
    expect((await checkModels(sources({ claude: async () => null, codex: async () => CODEX_JSON }, PRICING, versions({ claude: "1.0.0", codex: "0.1.0" }, { claude: "2.0.0", codex: "0.1.0" })))).code).toBe(2);
  });

  test("latest unknown: the registry not answering, or --version failing, is reported and changes neither the exit code nor the findings", async () => {
    const versions: VersionReaders = {
      installed: async (r) => (r === "claude" ? "2.1.289" : (() => { throw new Error("codex --version exited 9"); })()),
      latest: async () => { throw new Error("registry.npmjs.org answered 503"); },
    };
    const r = await checkModels(sources(CLEAN, PRICING, versions));
    expect(r.lines).toContain("claude latest: 分からない（registry.npmjs.org answered 503）");
    expect(r.lines).toContain("codex version: 分からない（codex --version exited 9）");
    expect(r.lines.some((l) => l.includes("outdated"))).toBe(false);
    expect(r.code).toBe(0);
    expect(r.findings).toEqual([]);
  });

  test("outdated is the last kind in a request title, and the body says the CLI is updated by hand", () => {
    expect(KINDS).toEqual(["stale", "unseen", "価格表未整備", "outdated"]);
    const req = requestFor(drift([{ runner: "claude", kind: "outdated", ids: ["2.1.289"] }, { runner: "claude", kind: "unseen", ids: ["claude-opus-6"] }]), SOURCE)!;
    expect(req.title).toBe("モデル一覧のズレ: claude unseen claude-opus-6 / claude outdated 2.1.289");
    expect(req.body).toContain("`outdated`: CLI を更新する");
  });

  test("the 出典 says 誰の言葉: 定期の検査 (#1818)", () => {
    expect(requestFor(drift([{ runner: "codex", kind: "unseen", ids: ["gpt-7"] }]), SOURCE)!.body).toContain("## 出典\n- 誰の言葉: 定期の検査\n");
  });

  test("no request without drift", () => {
    expect(requestFor({ lines: ["claude: ズレなし（21 件）"], code: 0, findings: [] }, SOURCE)).toBeNull();
    // exit 2 files nothing even when the other runner drifted: a changed CLI format is the script's to fix
    expect(requestFor({ lines: [], code: 2, findings: [{ runner: "codex", kind: "unseen", ids: ["gpt-7"] }] }, SOURCE)).toBeNull();
  });

  test("request title is stable", () => {
    const a = requestFor(drift([
      { runner: "codex", kind: "unseen", ids: ["gpt-7", "gpt-6.1-sol"] },
      { runner: "claude", kind: "価格表未整備", ids: ["claude-opus-6"] },
      { runner: "claude", kind: "stale", ids: ["claude-opus-5-4"] },
    ]), SOURCE)!;
    const b = requestFor(drift([
      { runner: "claude", kind: "stale", ids: ["claude-opus-5-4"] },
      { runner: "claude", kind: "価格表未整備", ids: ["claude-opus-6"] },
      { runner: "codex", kind: "unseen", ids: ["gpt-6.1-sol", "gpt-7"] },
    ]), { date: "2026-10-01", versions: [] })!;
    expect(a.title).toBe("モデル一覧のズレ: claude stale claude-opus-5-4 / claude 価格表未整備 claude-opus-6 / codex unseen gpt-6.1-sol,gpt-7");
    expect(b.title).toBe(a.title);
    expect(a.body).toMatch(/^## 要望\n/m);
    expect(a.body).toContain("codex unseen: gpt-6.1-sol");
    expect(a.body).toMatch(/^## 出典\n- 誰の言葉: 定期の検査\n`bun scripts\/check-models.ts --file-request`（定期実行） \/ 2026-09-30 \/ claude 2.1.285 \(Claude Code\) \/ codex 0.159.2$/m);
  });

  test("a long request title is cut to 256 characters and stays stable", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `gpt-7-model-${i}`);
    const a = requestFor(drift([{ runner: "codex", kind: "unseen", ids }]), SOURCE)!.title;
    const b = requestFor(drift([{ runner: "codex", kind: "unseen", ids: [...ids].reverse() }]), SOURCE)!.title;
    const c = requestFor(drift([{ runner: "codex", kind: "unseen", ids: [...ids, "gpt-7-model-99"] }]), SOURCE)!.title;
    expect(a.length).toBeLessThanOrEqual(256);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  test("already filed request is detected", () => {
    const title = requestFor(drift([{ runner: "codex", kind: "unseen", ids: ["gpt-6.1-sol"] }]), SOURCE)!.title;
    expect(alreadyFiled(title, [{ number: 601, title: "モデル一覧の設定化" }, { number: 750, title }])).toBe(750);
    expect(alreadyFiled(title, [{ number: 751, title: `${title} / codex unseen gpt-7` }])).toBeNull();
  });

  describe("with fake CLIs on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.check-models."));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const table = (ids: string[]) => ids.map((id) => `{id:"${id}",family:"x",display_name:"X"}`).join(",");
    const bundled = (slugs: string[]) => JSON.stringify({ models: slugs.map((slug) => ({ slug, visibility: "list" })) });
    const install = (claudeIds: string[], codexSlugs: string[]) => {
      // claude: a script that answers --version and carries the table in its own file, as the real executable does
      writeFileSync(join(dir, "claude"), `#!/bin/sh\n[ "$1" = --version ] && { echo "2.1.296 (Claude Code)"; exit 0; }\nexit 9\n# ${table(claudeIds)}\n`);
      chmodSync(join(dir, "claude"), 0o755);
      writeFileSync(join(dir, "models.json"), bundled(codexSlugs));
      // Answers --version and `debug models --bundled`; any other argument list fails the run.
      writeFileSync(join(dir, "codex"), `#!/bin/sh\n[ "$1" = --version ] && { echo "codex-cli 0.162.1"; exit 0; }\n[ "$*" = "debug models --bundled" ] || exit 9\ncat "${join(dir, "models.json")}"\n`);
      chmodSync(join(dir, "codex"), 0o755);
    };

    test("no network: the tables are read and compared without it; only the version check asks the registry, and says 分からない when it fails", async () => {
      const real = globalThis.fetch;
      let called = 0;
      globalThis.fetch = Object.assign(() => {
        called++;
        throw new Error("no network in check-models");
      }, real) as typeof fetch;
      try {
        install(REVIEWED.claude, REVIEWED.codex);
        expect(await checkModels(sources(hostReaders(dir)))).toEqual({ lines: ["claude: ズレなし（22 件）", "codex: ズレなし（8 件）", "unpriced (ledger): なし"], code: 0, findings: [] });
        expect(called).toBe(0); // the table comparison alone never touches the network
        install(REVIEWED.claude.filter((id) => id !== "claude-opus-5-5"), [...REVIEWED.codex, "gpt-7"]);
        expect(await checkModels(sources(hostReaders(dir), PRICING, hostVersions(dir)))).toEqual({
          lines: ["claude stale: claude-opus-5-5", "codex unseen: gpt-7", "claude latest: 分からない（no network in check-models）", "codex latest: 分からない（no network in check-models）", "unpriced (ledger): なし"],
          code: 1,
          findings: [
            { runner: "claude", kind: "stale", ids: ["claude-opus-5-5"] },
            { runner: "codex", kind: "unseen", ids: ["gpt-7"] },
          ],
        });
        expect(called).toBe(2); // one GET per runner, after `--version` answered
      } finally {
        globalThis.fetch = real;
      }
    });

    test("hostVersions reads `--version` of the CLIs on PATH, and the registry's latest through fetch", async () => {
      install(REVIEWED.claude, REVIEWED.codex);
      const v = hostVersions(dir);
      expect(await v.installed("claude")).toBe("2.1.296");
      expect(await v.installed("codex")).toBe("0.162.1");
      expect(await hostVersions(join(dir, "no-such-dir")).installed("claude")).toBeNull();
      const real = globalThis.fetch;
      const urls: string[] = [];
      globalThis.fetch = Object.assign(async (url: string | URL | Request) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ version: "9.9.9" }), { status: 200 });
      }, real) as typeof fetch;
      try {
        expect(await v.latest("claude")).toBe("9.9.9");
        expect(urls).toEqual(["https://registry.npmjs.org/@anthropic-ai/claude-code/latest"]);
        globalThis.fetch = Object.assign(async () => new Response("down", { status: 503 }), real) as typeof fetch;
        await expect(v.latest("codex")).rejects.toThrow("registry.npmjs.org answered 503");
        globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({}), { status: 200 }), real) as typeof fetch;
        await expect(v.latest("codex")).rejects.toThrow("no version in the answer");
      } finally {
        globalThis.fetch = real;
      }
    });
  });
});
