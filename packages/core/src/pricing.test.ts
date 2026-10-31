import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_BEDROCK_MODELS, createClaudeHistoryParser } from "@switchboard/adapter-claude";
import { CODEX_BEDROCK_MODELS } from "@switchboard/adapter-codex";
import type { AgentEvent } from "@switchboard/protocol";
import { billedUsd, isBedrockModel, ledgerRowFor, loadPricing, priceUsage, resolveModel, usageSince } from "./pricing.ts";

const { table, source } = loadPricing([join(import.meta.dir, "..", "config", "pricing.json")]);

describe("pricing (#14)", () => {
  test("GPT-6.1 Sol is its own row: cache reads are $0.10, not gpt-6-sol's $0.20", () => {
    expect(resolveModel(table, "gpt-6.1-sol", "codex")).toMatchObject({
      name: "gpt-6.1-sol",
      price: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
    });
  });

  test("Haiku 5.5 is its own row, not Haiku 4.5's: the up-to-100K prices", () => {
    expect(resolveModel(table, "claude-haiku-5-5", "claude")).toMatchObject({
      name: "claude-haiku-5-5",
      price: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, cacheWrite1h: 0.2 },
    });
  });

  test("the shipped table loads and prices known models per million tokens", () => {
    expect(source).toContain("pricing.json");
    const r = priceUsage(table, "claude-haiku-4-5-20251001", "claude", { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(r).toEqual({ costUsd: 1, priced: true, model: "claude-haiku-4-5" });
    // gpt-6-luna at its current list price: $0.10 in / $0.50 out / $0.01 cached
    const mixed = priceUsage(table, "gpt-6-luna", "codex", { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 400_000, cacheWriteTokens: 0 });
    expect(mixed.costUsd).toBeCloseTo(0.01 + 0.005 + 0.004, 6);
  });

  test("the shipped table keeps the tiers apart: Fable 5.1 is not Opus 5, and its cache reads are 0.025x input", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    expect(priceUsage(table, "claude-fable-5-1", "claude", u).costUsd).toBeCloseTo(10 + 50 + 0.25 + 12.5, 6);
    expect(priceUsage(table, "claude-fable-5", "claude", u).costUsd).toBeCloseTo(10 + 50 + 1 + 12.5, 6);
    expect(priceUsage(table, "claude-opus-5", "claude", u).costUsd).toBeCloseTo(5 + 25 + 0.5 + 6.25, 6);
    expect(priceUsage(table, "claude-sonnet-5", "claude", u).costUsd).toBeCloseTo(2 + 10 + 0.2 + 2.5, 6);
    expect(priceUsage(table, "claude-sonnet-5-5", "claude", u)).toMatchObject({ costUsd: expect.closeTo(2 + 10 + 0.2 + 2.5, 6), model: "claude-sonnet-5-5" });
    // Gemini 3.7 Flash introductory price (through 2026-12-31); no per-token cache write charge
    expect(priceUsage(table, "gemini-3.7-flash", "dak", u).costUsd).toBeCloseTo(0.75 + 3.75 + 0.075, 6);
  });

  test("model resolution: exact, alias, date suffix, longest prefix; a named unknown model is unpriced, only a missing name uses the runner default", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(priceUsage(table, undefined, "codex", u)).toMatchObject({ costUsd: 0.1, priced: true, model: "gpt-6-luna" });
    expect(priceUsage(table, "claude-sonnet-5-20260301", "claude", u)).toMatchObject({ costUsd: 2, model: "claude-sonnet-5" });
    expect(priceUsage(table, "claude-opus-5-20260301", "claude", u)).toMatchObject({ costUsd: 5, model: "claude-opus-5" });
    expect(priceUsage(table, "gemini-3.7-flash@001", "dak", u)).toMatchObject({ costUsd: 0.75 });
    // a context-window tag is not part of the model: every [1m] name prices as its base model
    expect(priceUsage(table, "claude-fable-5-1[1m]", "claude", u)).toMatchObject({ costUsd: 10, model: "claude-fable-5-1" });
    expect(priceUsage(table, "claude-opus-5[1m]", "claude", u)).toMatchObject({ costUsd: 5, model: "claude-opus-5" });
    // a newer minor is another tier: claude-fable-5-2 must not borrow claude-fable-5's row through the prefix
    expect(priceUsage(table, "claude-fable-5-2", "claude", u)).toEqual({ costUsd: 0, priced: false, model: "claude-fable-5-2" });
    expect(priceUsage(table, "claude-fable-5-10-20270101", "claude", u)).toMatchObject({ priced: false });
    expect(priceUsage(table, "claude-opus-4-80", "claude", u)).toMatchObject({ priced: false });
    expect(priceUsage(table, "mystery-model", "dak", u)).toEqual({ costUsd: 0, priced: false, model: "mystery-model" });
    const empty = loadPricing(["/nonexistent.json"]).table;
    expect(priceUsage(empty, "x", "claude", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toEqual({ costUsd: 0, priced: false, model: "x" });
  });

  test("billing: subscription runners pay 0, api runners pay the API-equivalent", () => {
    expect(billedUsd(table, "claude", 1.23)).toBe(0);
    expect(billedUsd(table, "codex", 1.23)).toBe(0);
    expect(billedUsd(table, "dak", 1.23)).toBe(1.23);
  });

  test("billedUsd: a Bedrock model id is billed at the API price under a subscription runner (#1730)", () => {
    expect(isBedrockModel("global.anthropic.claude-haiku-5-5")).toBe(true);
    expect(isBedrockModel("anthropic.claude-haiku-5-5")).toBe(true);
    expect(isBedrockModel("claude-haiku-5-5")).toBe(false);
    expect(billedUsd(table, "claude", 1.23, "global.anthropic.claude-haiku-5-5")).toBe(1.23);
    expect(billedUsd(table, "claude", 1.23, "claude-haiku-5-5")).toBe(0);
    expect(billedUsd(table, "claude", 1.23, null)).toBe(0);
  });

  test("every Bedrock id of the claude adapter is priced (#1730)", () => {
    const u = { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const m of CLAUDE_BEDROCK_MODELS) expect(priceUsage(table, m.value, "claude", u)).toMatchObject({ priced: true });
    expect(priceUsage(table, "global.anthropic.claude-haiku-5-5", "claude", u).model).toBe("claude-haiku-5-5");
    expect(priceUsage(table, "global.anthropic.claude-haiku-4-5-20251001-v1:0", "claude", u).model).toBe("claude-haiku-4-5");
    // a row or an alias the user wrote for the Bedrock id wins over the Anthropic row
    const own = { ...table, models: { ...table.models, "global.anthropic.claude-haiku-5-5": { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } } };
    expect(priceUsage(own, "global.anthropic.claude-haiku-5-5", "claude", u).model).toBe("global.anthropic.claude-haiku-5-5");
    const aliased = { ...table, aliases: { ...table.aliases, "us.anthropic.claude-haiku-5-5": "claude-haiku-4-5" } };
    expect(priceUsage(aliased, "us.anthropic.claude-haiku-5-5", "claude", u).model).toBe("claude-haiku-4-5");
    expect(priceUsage(table, "us.anthropic.claude-haiku-5-5", "claude", u).costUsd).toBe(priceUsage(table, "claude-haiku-5-5", "claude", u).costUsd);
  });

  test("every Bedrock id of the codex adapter is priced and billed at the API price (#1731)", () => {
    const u = { inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const m of CODEX_BEDROCK_MODELS) {
      const p = priceUsage(table, m.value, "codex", u);
      expect(p).toMatchObject({ priced: true, model: m.value.replace(/^openai\./, "") });
      expect(p.costUsd).toBeGreaterThan(0);
      expect(billedUsd(table, "codex", p.costUsd, m.value)).toBe(p.costUsd);
    }
    // the ledger row of a Bedrock codex task: actual cost = API cost, not unpriced
    const row = ledgerRowFor(table, { id: "t", runner: "codex", model: "openai.gpt-6-luna" }, { t: "usage", source: "turn", model: "openai.gpt-6-luna", ...u }, Date.now());
    expect(row.source).not.toBe("unpriced");
    expect(row.billedUsd).toBe(row.costUsd);
    expect(row.billedUsd).toBeGreaterThan(0);
  });

  test("an invalid user file is skipped with the problem reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-pricing-"));
    const bad = join(dir, "pricing.json");
    writeFileSync(bad, '{"version": 1, "models": {"m": {"input": "x"}}}');
    const logs: string[] = [];
    const r = loadPricing([bad, join(import.meta.dir, "..", "config", "pricing.json")], (m) => logs.push(m));
    expect(r.source).toContain("config");
    expect(r.problems[0]).toContain("input");
    expect(logs).toHaveLength(1);
  });

  test("dated price changes: Gemini 3.7 Flash doubles at 2027-01-01T00:00Z; a table without changes and a call without a time keep the row", () => {
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 };
    const before = priceUsage(table, "gemini-3.7-flash", "dak", u, Date.parse("2026-12-31T23:59:59Z")).costUsd;
    const after = priceUsage(table, "gemini-3.7-flash", "dak", u, Date.parse("2027-01-01T00:00:00Z")).costUsd;
    expect(before).toBeCloseTo(0.75 + 3.75 + 0.075, 6);
    expect(after).toBeCloseTo(1.5 + 7.5 + 0.15, 6);
    expect(after).toBeCloseTo(2 * before, 6);
    expect(priceUsage(table, "gemini-3.7-flash", "dak", u).costUsd).toBeCloseTo(before, 6);
    // the user's own table in the old shape (no `changes`) still loads and prices the same at any time
    const dir = mkdtempSync(join(tmpdir(), "sb-pricing-old-"));
    writeFileSync(join(dir, "pricing.json"), JSON.stringify({ version: 1, billing: { dak: "api" }, models: { "gemini-3.7-flash": { input: 0.75, output: 3.75, cacheRead: 0.075 } } }));
    const old = loadPricing([join(dir, "pricing.json")]);
    expect(old.problems).toEqual([]);
    expect(priceUsage(old.table, "gemini-3.7-flash", "dak", u, Date.parse("2027-06-01T00:00:00Z")).costUsd).toBeCloseTo(before, 6);
  });

  test("dated price changes: the last change that has started wins, a field left out keeps the row, and the ledger row uses the usage time", () => {
    const t = { version: 1 as const, billing: {}, aliases: {}, models: { m: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, changes: [{ from: "2027-06-01", input: 4 }, { from: "2027-01-01", input: 3 }] } } };
    const u = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(priceUsage(t, "m", "dak", u, Date.parse("2026-12-31T00:00:00Z")).costUsd).toBe(3);
    expect(priceUsage(t, "m", "dak", u, Date.parse("2027-03-01T00:00:00Z")).costUsd).toBe(5);
    expect(priceUsage(t, "m", "dak", u, Date.parse("2027-06-01T00:00:00Z")).costUsd).toBe(6);
    const ev = { t: "usage" as const, source: "turn" as const, model: "m", ...u };
    expect(ledgerRowFor(t, { id: "t1", runner: "dak", model: null }, ev, Date.parse("2027-03-01T00:00:00Z")).costUsd).toBe(5);
  });

  test("dated price changes: a day that does not exist (2027-02-30, month 13) is reported, not rolled over or ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "pricing-date-"));
    for (const from of ["2027-02-30", "2027-13-01"]) {
      const bad = join(dir, `${from}.json`);
      writeFileSync(bad, JSON.stringify({ version: 1, billing: {}, aliases: {}, models: { m: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, changes: [{ from, input: 4 }] } } }));
      const r = loadPricing([bad, join(import.meta.dir, "..", "config", "pricing.json")], () => undefined);
      expect(r.source).not.toBe(bad);
      expect(r.problems.join(" ")).toContain("not a calendar date");
    }
  });

  test("1-hour cache writes are priced at 2x input, the rest of the writes at 1.25x; a row without cacheWrite1h uses cacheWrite", () => {
    const u = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 600_000 };
    expect(priceUsage(table, "claude-fable-5-1", "claude", u).costUsd).toBeCloseTo(0.6 * 20 + 0.4 * 12.5, 6);
    expect(priceUsage(table, "claude-haiku-4-5", "claude", u).costUsd).toBeCloseTo(0.6 * 2 + 0.4 * 1.25, 6);
    expect(priceUsage(table, "claude-haiku-4-5", "claude", { ...u, cacheWrite1hTokens: undefined }).costUsd).toBeCloseTo(1.25, 6);
    expect(priceUsage(table, "gpt-6-luna", "codex", u).costUsd).toBeCloseTo(0.125, 6); // no cacheWrite1h: all at cacheWrite
    const ev = { t: "usage" as const, source: "turn" as const, model: "claude-haiku-4-5", ...u };
    expect(ledgerRowFor(table, { id: "t1", runner: "claude", model: null }, ev, 0)).toMatchObject({ cacheWrite: 1_000_000, cacheWrite1h: 600_000, source: "priced" });
  });

  test("1-hour cache writes from an imported terminal session (the history replay) reach the ledger row and its price", () => {
    // what Claude Code writes to ~/.claude/projects for one assistant message: the usage with its cache_creation split
    const rec = {
      type: "assistant", uuid: "s1", sessionId: "11111111-1111-4111-8111-111111111111", timestamp: "2026-09-06T12:53:01.057Z", cwd: "/work/repo", entrypoint: "cli",
      message: {
        model: "claude-haiku-4-5", id: "msg_1h", type: "message", role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 400_000, ephemeral_1h_input_tokens: 600_000 } },
      },
    };
    const p = createClaudeHistoryParser();
    const usage = [...p.feed(JSON.stringify(rec)), ...p.flush()].map((e) => e.ev).find((ev): ev is Extract<AgentEvent, { t: "usage" }> => ev.t === "usage")!;
    expect(usage.cacheWrite1hTokens).toBe(600_000);
    const row = ledgerRowFor(table, { id: "t1", runner: "claude", model: null }, usage, 0);
    expect(row).toMatchObject({ cacheWrite: 1_000_000, cacheWrite1h: 600_000, source: "priced" });
    expect(row.costUsd).toBeCloseTo(0.6 * 2 + 0.4 * 1.25, 6);
  });
});

describe("usageSince (#2353)", () => {
  const total = (costUsd: number, tokens = 0): Extract<AgentEvent, { t: "usage" }> => ({ t: "usage", source: "reported", model: "m", inputTokens: tokens, outputTokens: tokens, cacheReadTokens: tokens, cacheWriteTokens: tokens, costUsd, cumulative: true });
  test("the difference from the previous total of the session; the event loses its cumulative mark", () => {
    const first = usageSince(null, total(1.0, 10), "s")!;
    expect(first.usage).toEqual({ t: "usage", source: "reported", model: "m", inputTokens: 10, outputTokens: 10, cacheReadTokens: 10, cacheWriteTokens: 10, costUsd: 1.0 });
    const second = usageSince(first.total, total(1.5, 25), "s")!;
    expect([second.usage.costUsd, second.usage.inputTokens, second.total.costUsd]).toEqual([0.5, 15, 1.5]);
    expect(usageSince(second.total, total(1.5, 25), "s")).toBeNull(); // nothing grew: no row
  });
  test("a total that went down, or another session, starts from 0", () => {
    const prev = { session: "s", inputTokens: 10, outputTokens: 10, cacheReadTokens: 10, cacheWriteTokens: 10, costUsd: 1.0 };
    expect(usageSince(prev, total(0.4, 4), "s")!.usage.costUsd).toBe(0.4);
    expect(usageSince(prev, total(3.0, 30), "s2")!.usage.costUsd).toBe(3.0);
  });
  test("a model's first total is counted against what the migrated rows booked (credit), and records the part used", () => {
    const a = usageSince(null, total(1.1, 10), "s", 1.25)!;
    expect([a.usage.costUsd, a.total.carried]).toEqual([0, 1.1]);
    const b = usageSince(null, total(0.3, 5), "s", 1.25 - 1.1)!;
    expect([Math.round(b.usage.costUsd! * 1e6) / 1e6, b.total.carried]).toEqual([0.15, 1.25 - 1.1]);
    expect(usageSince({ session: "s", costUsd: 1.1 }, total(1.5, 10), "s", 9)!.usage.costUsd).toBe(0.4); // a prev: no credit
  });
});
