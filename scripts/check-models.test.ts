// test-reads: packages/core/config/pricing.json
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_MODELS } from "../packages/adapters/claude/src/index.ts";
import { CODEX_MODELS } from "../packages/adapters/codex/src/index.ts";
import { Database } from "bun:sqlite";
import { loadPricing } from "../packages/core/src/pricing.ts";
import { hostReaders, SHIPPED_HIDDEN_MODELS, type Readers } from "../packages/core/src/model-catalog.ts";
import { checkModels, listedModels, classifyUnpriced, compareModels, hiddenModels, KINDS, requestFor, settingsPrices, unpricedLedgerNames, unpricedListed, type Report } from "./check-models";
import { alreadyFiled } from "./file-request";

// An excerpt of codex-cli 0.159.2's `debug models --bundled`.
const CODEX_JSON = JSON.stringify({
  models: [
    { slug: "gpt-6.1-sol", visibility: "list" },
    { slug: "gpt-6-astra", visibility: "list" },
    { slug: "gpt-6-sol", visibility: "list" },
    { slug: "codex-auto-review", visibility: "hide" },
  ],
});

/** The ids looked at with no settings saved: the bundled lists and what they leave out on purpose. */
const KNOWN = {
  claude: [...CLAUDE_MODELS.map((m) => m.value), ...SHIPPED_HIDDEN_MODELS.claude],
  codex: [...CODEX_MODELS.map((m) => m.value), ...SHIPPED_HIDDEN_MODELS.codex],
};
const PRICING = loadPricing([join(import.meta.dir, "..", "packages", "core", "config", "pricing.json")]).table;
const sources = (read: Readers, pricing = PRICING) => ({ read, pricing, dbPath: join(tmpdir(), "switchboard.check-models.no-such.db") });
/** Tables that match the UI's lists exactly: no drift of their own, so a test sees only the drift it sets up. */
const CLEAN: Readers = {
  claude: async () => KNOWN.claude.map((id) => `{id:"${id}",family:"x",display_name:"X"}`).join(","),
  codex: async () => JSON.stringify({ models: KNOWN.codex.map((slug) => ({ slug, visibility: "list" })) }),
};

describe("check-models", () => {
  test("stale id is reported", () => {
    const r = compareModels({ listed: ["claude-opus-5-4", "claude-haiku-4-5"], catalog: ["claude-opus-5-5", "claude-haiku-4-5"], reviewed: ["claude-opus-5-5", "claude-haiku-4-5"] });
    expect(r).toEqual({ stale: ["claude-opus-5-4"], unseen: [] });
  });

  test("new catalog id is reported", () => {
    const r = compareModels({ listed: ["gpt-6-sol"], catalog: ["gpt-6-sol", "gpt-6.1-sol", "gpt-5.6-terra"], reviewed: ["gpt-6-sol", "gpt-5.6-terra"] });
    expect(r).toEqual({ stale: [], unseen: ["gpt-6.1-sol"] });
  });

  test("exit 2 when a CLI is missing or its table reads as empty; drift still shows for the other", async () => {
    const r = await checkModels(sources({ claude: async () => null, codex: async () => CODEX_JSON }));
    expect(r.code).toBe(2);
    // CODEX_JSON lacks gpt-6-luna, which the UI lists: the codex comparison still runs after claude could not be read.
    expect(r.lines).toEqual(["claude: 判定できなかった（CLI が PATH に無い）", "codex stale: gpt-6-luna", "unpriced (ledger): なし"]);
    expect((await checkModels(sources({ claude: async () => "", codex: async () => CODEX_JSON }))).lines[0]).toContain("0 件");
    const claude = async () => KNOWN.claude.map((id) => `{id:"${id}",family:"x",display_name:"X"}`).join(",");
    const stuck = await checkModels(sources({ claude, codex: async () => { throw new Error("codex debug models --bundled did not answer within 30s"); } }));
    expect(stuck.code).toBe(2);
    expect(stuck.lines).toContain("codex: 判定できなかった（codex debug models --bundled did not answer within 30s）");
  });

  test("unpriced listed model", async () => {
    const { "claude-sonnet-5-5": _, ...models } = PRICING.models;
    const table = { ...PRICING, models };
    expect(unpricedListed(["claude-opus-5-5", "claude-sonnet-5-5"], table, "claude")).toEqual(["claude-sonnet-5-5"]);
    expect(unpricedListed(["claude-opus-5-5", "claude-sonnet-5-5"], PRICING, "claude")).toEqual([]);
    const claude = async () => KNOWN.claude.map((id) => `{id:"${id}",family:"x",display_name:"X"}`).join(",");
    const codex = async () => JSON.stringify({ models: KNOWN.codex.map((slug) => ({ slug, visibility: "list" })) });
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

  test("listedModels: the list saved on the settings screen per runner; the bundled list for a runner never saved, and when there is no database, settings table or row", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.check-models."));
    const bundled = { claude: CLAUDE_MODELS.map((m) => m.value), codex: CODEX_MODELS.map((m) => m.value) };
    try {
      expect(listedModels(join(dir, "missing.db"))).toEqual(bundled);
      const dbPath = join(dir, "switchboard.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE ledger (runner TEXT NOT NULL, model TEXT, source TEXT NOT NULL)");
      expect(listedModels(dbPath)).toEqual(bundled); // no settings table
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, json TEXT NOT NULL)");
      expect(listedModels(dbPath)).toEqual(bundled); // no row
      db.query("INSERT INTO settings VALUES ('settings', ?)").run(JSON.stringify({ autoResume: { claude: true } }));
      expect(listedModels(dbPath)).toEqual(bundled); // a row that has no list
      db.query("UPDATE settings SET json = ? WHERE key = 'settings'").run('{"models": {"claude": [');
      expect(listedModels(dbPath)).toEqual(bundled); // a broken row, as the daemon reads it
      db.query("UPDATE settings SET json = ? WHERE key = 'settings'").run(JSON.stringify({ models: { claude: [{ value: "claude-x", label: "X" }, { value: CLAUDE_MODELS[0]!.value, label: "Y" }] } }));
      db.close();
      expect(listedModels(dbPath)).toEqual({ claude: ["claude-x", CLAUDE_MODELS[0]!.value], codex: bundled.codex });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("checkModels reads the list saved on the settings screen: an id saved there that the CLI's table lacks is stale; a runner not saved is checked on the bundled list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.check-models."));
    try {
      const dbPath = join(dir, "switchboard.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, json TEXT NOT NULL)");
      db.query("INSERT INTO settings VALUES ('settings', ?)").run(JSON.stringify({ models: { claude: [{ value: "claude-x", label: "X" }] } }));
      db.close();
      const claude = async () => KNOWN.claude.map((id) => `{id:"${id}",family:"x",display_name:"X"}`).join(",");
      const codex = async () => JSON.stringify({ models: KNOWN.codex.filter((id) => id !== CODEX_MODELS[0]!.value).map((slug) => ({ slug, visibility: "list" })) });
      const r = await checkModels({ read: { claude, codex }, pricing: PRICING, dbPath });
      expect(r.findings).toContainEqual({ runner: "claude", kind: "stale", ids: ["claude-x"] });
      expect(r.findings).toContainEqual({ runner: "claude", kind: "価格表未整備", ids: ["claude-x"] });
      expect(r.findings).toContainEqual({ runner: "codex", kind: "stale", ids: [CODEX_MODELS[0]!.value] }); // the bundled list
      expect(r.code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hiddenModels: the settings' 載せない list hides an id from unseen; a runner never saved, and no database or row, falls back to SHIPPED_HIDDEN_MODELS", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.check-models."));
    try {
      const dbPath = join(dir, "switchboard.db");
      expect(hiddenModels(join(dir, "missing.db"))).toEqual(SHIPPED_HIDDEN_MODELS);
      const db = new Database(dbPath);
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, json TEXT NOT NULL)");
      expect(hiddenModels(dbPath)).toEqual(SHIPPED_HIDDEN_MODELS); // no row
      const claude = async () => [...KNOWN.claude, "claude-opus-6"].map((id) => `{id:"${id}",family:"x",display_name:"X"}`).join(",");
      const codex = async () => JSON.stringify({ models: KNOWN.codex.map((slug) => ({ slug, visibility: "list" })) });
      const run = () => checkModels({ read: { claude, codex }, pricing: PRICING, dbPath });
      expect((await run()).findings).toEqual([{ runner: "claude", kind: "unseen", ids: ["claude-opus-6"] }]);
      // 載せない on the settings screen: the saved list replaces the shipped one for that runner only
      db.query("INSERT INTO settings VALUES ('settings', ?)").run(JSON.stringify({ hiddenModels: { claude: ["claude-opus-6"] } }));
      db.close();
      expect(hiddenModels(dbPath)).toEqual({ claude: ["claude-opus-6"], codex: SHIPPED_HIDDEN_MODELS.codex });
      expect((await run()).findings).toEqual([{ runner: "claude", kind: "unseen", ids: SHIPPED_HIDDEN_MODELS.claude }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("settingsPrices: a price saved on the settings screen prices a listed id, as the daemon lays it over pricing.json; a database without one still reports it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.check-models."));
    try {
      const dbPath = join(dir, "switchboard.db");
      const db = new Database(dbPath);
      db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, json TEXT NOT NULL)");
      db.query("INSERT INTO settings VALUES ('settings', ?)").run(JSON.stringify({ models: { claude: [{ value: "claude-x", label: "X" }] } }));
      const run = () => checkModels({ read: CLEAN, pricing: PRICING, dbPath });
      expect(settingsPrices(dbPath)).toEqual({});
      expect((await run()).findings).toContainEqual({ runner: "claude", kind: "価格表未整備", ids: ["claude-x"] });
      db.query("UPDATE settings SET json = ? WHERE key = 'settings'").run(JSON.stringify({ models: { claude: [{ value: "claude-x", label: "X" }] }, prices: { "claude-x": { input: 1, output: 2 } } }));
      db.close();
      expect(settingsPrices(dbPath)["claude-x"]).toMatchObject({ input: 1, output: 2 }); // parsed by Settings, its defaults filled
      expect((await run()).findings.filter((f) => f.kind === "価格表未整備")).toEqual([]);
      expect(settingsPrices(join(dir, "missing.db"))).toEqual({});
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
      const claude = async () => [...KNOWN.claude, "claude-opus-6"].map((id) => `{id:"${id}",family:"x",display_name:"X"}`).join(",");
      const codex = async () => JSON.stringify({ models: KNOWN.codex.map((slug) => ({ slug, visibility: "list" })) });
      const r = await checkModels({ read: { claude, codex }, pricing: PRICING, dbPath });
      expect(r.lines).toContain("unpriced (ledger) new（価格表未整備）: claude claude-opus-6");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const SOURCE = { date: "2026-09-30", versions: ["claude 2.1.285 (Claude Code)", "codex 0.159.2"] };
  const drift = (findings: Report["findings"]): Report => ({ lines: ["codex unseen: gpt-6.1-sol"], code: 1, findings });

  test("the request's fixes are the kinds the script reports, all on the settings screen; none is a CLI update", () => {
    expect(KINDS).toEqual(["stale", "unseen", "価格表未整備"]);
    const req = requestFor(drift([{ runner: "claude", kind: "unseen", ids: ["claude-opus-6"] }]), SOURCE)!;
    expect(req.body.split("\n").filter((l) => l.startsWith("- `")).map((l) => l.slice(3, l.indexOf("`", 3)))).toEqual([...KINDS]);
    expect(req.body).not.toContain("CLI を更新");
    expect(req.body).toContain("`unseen`: 設定画面の「ランナー」のまとまりの、そのランナーの「モデルの選択肢」で「CLI の表を読む」を押し"); // the fix is on the screen, no REVIEWED
    expect(req.body).not.toContain("REVIEWED");
  });

  test("the 出典 says 誰の言葉: 定期の検査", () => {
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
    expect(alreadyFiled(title, [{ ref: "#601", title: "モデル一覧の設定化" }, { ref: "#750", title }])).toBe("#750");
    expect(alreadyFiled(title, [{ ref: "#751", title: `${title} / codex unseen gpt-7` }])).toBeNull();
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

    test("no network: the tables are read and compared without it, whether they drift or not", async () => {
      const real = globalThis.fetch;
      let called = 0;
      globalThis.fetch = Object.assign(() => {
        called++;
        throw new Error("no network in check-models");
      }, real) as typeof fetch;
      try {
        install(KNOWN.claude, KNOWN.codex);
        expect(await checkModels(sources(hostReaders(dir)))).toEqual({ lines: ["claude: ズレなし（22 件）", "codex: ズレなし（9 件）", "unpriced (ledger): なし"], code: 0, findings: [] });
        install(KNOWN.claude.filter((id) => id !== "claude-opus-5-5"), [...KNOWN.codex, "gpt-7"]);
        expect(await checkModels(sources(hostReaders(dir)))).toEqual({
          lines: ["claude stale: claude-opus-5-5", "codex unseen: gpt-7", "unpriced (ledger): なし"],
          code: 1,
          findings: [
            { runner: "claude", kind: "stale", ids: ["claude-opus-5-5"] },
            { runner: "codex", kind: "unseen", ids: ["gpt-7"] },
          ],
        });
        expect(called).toBe(0);
      } finally {
        globalThis.fetch = real;
      }
    });
  });
});
