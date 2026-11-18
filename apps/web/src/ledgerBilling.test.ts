import { expect, test } from "bun:test";
import type { LedgerBilling, LedgerModelRow } from "@switchboard/protocol";
import { billingChoices, billingLabel, billingRows, ledgerReadKey, rowsFor } from "./ledgerBilling.ts";

const row = (billing: LedgerBilling, model = "claude-opus-5-5", costUsd = 1): LedgerModelRow => ({ runner: "claude", model, billing, tasks: 1, tokens: 10, costUsd, billedUsd: 0, unpriced: false });

test("billingLabel: the three logins by Anthropic's names, the other runners' two kinds", () => {
  expect((["claude.ai", "console", "bedrock", "subscription", "api"] as const).map(billingLabel)).toEqual(["Claude アカウント", "Anthropic Console", "Bedrock", "契約", "API"]);
});

test("billingChoices: only the kinds the period's rows have (and the picked one), in the fixed order, each once", () => {
  expect(billingChoices([row("api"), row("console"), row("claude.ai"), row("console", "claude-haiku-5-5")])).toEqual(["claude.ai", "console", "api"]);
  expect(billingChoices([])).toEqual([]);
  // the picked kind stays offered while the rows are being read again, or when the new period has none of it
  expect(billingChoices([], "console")).toEqual(["console"]);
  expect(billingChoices([row("api")], "claude.ai")).toEqual(["claude.ai", "api"]);
});

test("billingRows: すべて shows every row, a kind only its rows — the same model stays one row per kind", () => {
  const models = [row("claude.ai", "claude-opus-5-5", 3), row("console", "claude-opus-5-5", 4), row("bedrock", "global.anthropic.claude-haiku-5-5", 8)];
  expect(billingRows(models, "")).toEqual(models);
  expect(billingRows(models, "console")).toEqual([models[1]!]);
  expect(billingRows(models, "api")).toEqual([]);
});

test("rowsFor: the rows read for a period and billing kind are shown only under that period and kind", () => {
  const read = { key: ledgerReadKey(7, "console"), rows: [row("console")] };
  expect(rowsFor(read, ledgerReadKey(7, "console"))).toEqual(read.rows);
  // another kind or another period picked: nothing of the old read under the new name, until its own rows come
  expect(rowsFor(read, ledgerReadKey(7, "bedrock"))).toEqual([]);
  expect(rowsFor(read, ledgerReadKey(30, "console"))).toEqual([]);
  expect(rowsFor(read, ledgerReadKey(7, ""))).toEqual([]);
  expect(rowsFor(null, ledgerReadKey(7, ""))).toEqual([]);
});
