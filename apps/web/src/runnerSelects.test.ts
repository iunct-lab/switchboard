// test-reads: apps/web/src/components/ModelSelect.tsx apps/web/src/components/EffortSelect.tsx apps/web/src/modelOptions.ts apps/web/src/effortOptions.ts
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunnerInfo } from "@switchboard/protocol";
import { EffortSelect } from "./components/EffortSelect.tsx";
import { ModelSelect } from "./components/ModelSelect.tsx";

// the selects of a Settings row (bare, named empty choice) and of Home (label in front of every option)
const codex = { id: "codex", available: true, permissionModes: [], models: [{ value: "gpt-6", label: "GPT 6" }], efforts: [{ value: "high", label: "high" }] } as RunnerInfo;
const noop = () => undefined;
const options = (html: string) => [...html.matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((m) => m[1]);

describe("ModelSelect / EffortSelect", () => {
  test("a Settings row: no label in front of the options, and the empty choice says what it falls back to", () => {
    const model = renderToStaticMarkup(createElement(ModelSelect, { runner: codex, value: "", onChange: noop, label: "モデル", bare: true, emptyLabel: "ランナーの既定（GPT 6）" }));
    expect(options(model).slice(0, 2)).toEqual(["ランナーの既定（GPT 6）", "GPT 6（gpt-6）"]);
    const effort = renderToStaticMarkup(createElement(EffortSelect, { runner: codex, value: "", onChange: noop, label: "思考の深さ", bare: true, emptyLabel: "ランナーの既定（high）" }));
    expect(options(effort)).toEqual(["ランナーの既定（high）", "high"]);
  });

  test("without bare / emptyLabel (Home): every option carries the label and the empty one is the CLI default", () => {
    const model = renderToStaticMarkup(createElement(ModelSelect, { runner: codex, value: "", onChange: noop, label: "モデル" }));
    expect(options(model).slice(0, 2)).toEqual(["モデル: CLI 既定", "モデル: GPT 6（gpt-6）"]);
    const effort = renderToStaticMarkup(createElement(EffortSelect, { runner: codex, value: "", onChange: noop, label: "思考の深さ" }));
    expect(options(effort)).toEqual(["思考の深さ: CLI 既定", "思考の深さ: high"]);
  });

  test("the aria-label stays the label when the options are bare (the select is still named)", () => {
    expect(renderToStaticMarkup(createElement(ModelSelect, { runner: codex, value: "", onChange: noop, label: "モデル", bare: true }))).toContain('aria-label="モデル"');
    expect(renderToStaticMarkup(createElement(EffortSelect, { runner: codex, value: "", onChange: noop, label: "思考の深さ", bare: true }))).toContain('aria-label="思考の深さ"');
  });
});
