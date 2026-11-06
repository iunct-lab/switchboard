// test-reads: none
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_MODELS } from "@switchboard/adapter-claude";
import { CODEX_MODELS } from "@switchboard/adapter-codex";
import { CODEX_CATALOG_TIMEOUT_MS, claudeCatalog, claudeTableText, codexCatalog, hostReaders, modelCandidates, SHIPPED_HIDDEN_MODELS } from "./model-catalog.ts";

// Excerpts of what the CLIs carry (claude 2.1.285's embedded table, codex-cli 0.159.2's `debug models --bundled`).
const CLAUDE_TABLE =
  'x=[{id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5",max_tokens:128000},' +
  '{id:"claude-haiku-4-5",family:"haiku",display_name:"Haiku 4.5"},{id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5"}];' +
  'y={id:"not-a-model",family:"x"}';
const CODEX_JSON = JSON.stringify({
  models: [
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" },
    { slug: "gpt-6-astra", display_name: "GPT-6 Astra", visibility: "list" },
    { slug: "gpt-6-sol", visibility: "list" },
    { slug: "codex-auto-review", display_name: "Auto review", visibility: "hide" },
  ],
});

describe("model-catalog", () => {
  test("claudeCatalog reads each model of the embedded table once, with its display_name", () => {
    expect(claudeCatalog(CLAUDE_TABLE)).toEqual([
      { value: "claude-opus-5-5", label: "Opus 5.5" },
      { value: "claude-haiku-4-5", label: "Haiku 4.5" },
    ]);
    expect(claudeCatalog("no table here")).toEqual([]);
  });

  test("codexCatalog keeps the listed models with their display_name (else the slug) and drops hidden ones", () => {
    expect(codexCatalog(CODEX_JSON)).toEqual([
      { value: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { value: "gpt-6-astra", label: "GPT-6 Astra" },
      { value: "gpt-6-sol", label: "gpt-6-sol" },
    ]);
  });

  test("modelCandidates leaves out the listed and the hidden ids, in the table's order", () => {
    expect(modelCandidates(codexCatalog(CODEX_JSON), ["gpt-6-sol"], ["gpt-6.1-sol"])).toEqual([{ value: "gpt-6-astra", label: "GPT-6 Astra" }]);
    expect(modelCandidates([], ["gpt-6-sol"], [])).toEqual([]);
  });

  test("SHIPPED_HIDDEN_MODELS and the bundled lists do not share an id", () => {
    for (const m of CLAUDE_MODELS) expect(SHIPPED_HIDDEN_MODELS.claude).not.toContain(m.value);
    for (const m of CODEX_MODELS) expect(SHIPPED_HIDDEN_MODELS.codex).not.toContain(m.value);
  });

  test("claudeTableText finds entries across chunk boundaries of a large file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.model-catalog."));
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
      const head = "\0".repeat(first - 20) + entry("claude-opus-5-5");
      writeFileSync(file, head + "\0".repeat(1_000_000) + entry("claude-haiku-4-5") + "\0".repeat(1_000_000));
      expect(claudeCatalog(await claudeTableText(file)).map((m) => m.value)).toEqual(["claude-opus-5-5", "claude-haiku-4-5"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hostReaders: codex is asked with --bundled (no network refresh), a CLI not on PATH reads as null, a failing codex throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.model-catalog."));
    try {
      const argv = join(dir, "argv");
      writeFileSync(join(dir, "codex"), `#!/bin/sh\necho "$*" > "${argv}"\necho '${CODEX_JSON}'\n`);
      chmodSync(join(dir, "codex"), 0o755);
      const read = hostReaders(dir);
      expect(codexCatalog((await read.codex())!).length).toBe(3);
      expect(readFileSync(argv, "utf8").trim()).toBe("debug models --bundled");
      expect(await read.claude()).toBeNull();
      expect(await hostReaders(join(dir, "no-such-dir")).codex()).toBeNull();
      writeFileSync(join(dir, "codex"), `#!/bin/sh\necho boom >&2\nexit 3\n`);
      await expect(read.codex()).rejects.toThrow("codex debug models --bundled exited 3: boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("hostReaders: a codex that does not answer is stopped at the limit and the read fails with the limit", async () => {
    // The limit ends before Bun's idleTimeout (120 s) would close the settings request with no reason shown (#3845).
    expect(CODEX_CATALOG_TIMEOUT_MS).toBeLessThan(120_000);
    const dir = mkdtempSync(join(tmpdir(), "switchboard.model-catalog."));
    try {
      const pidfile = join(dir, "pid");
      writeFileSync(join(dir, "codex"), `#!/bin/sh\necho $$ > "${pidfile}"\nexec sleep 60\n`);
      chmodSync(join(dir, "codex"), 0o755);
      const started = Date.now();
      await expect(hostReaders(dir, 200).codex()).rejects.toThrow("codex debug models --bundled did not answer within 0.2s");
      expect(Date.now() - started).toBeLessThan(2_000);
      const pid = Number(readFileSync(pidfile, "utf8").trim());
      expect(() => process.kill(pid, 0)).toThrow();
      // A codex that exits while a child it left keeps the output open is held to the same limit.
      writeFileSync(join(dir, "codex"), `#!/bin/sh\nsleep 60 &\necho $! > "${pidfile}"\nexit 0\n`);
      try {
        const before = Date.now();
        await expect(hostReaders(dir, 200).codex()).rejects.toThrow("did not answer within 0.2s");
        expect(Date.now() - before).toBeLessThan(2_000);
      } finally {
        process.kill(Number(readFileSync(pidfile, "utf8").trim()), "SIGKILL");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
