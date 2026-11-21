import { beforeEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunnerCommand } from "@switchboard/protocol";
import { SlashList } from "./components/SlashPicker.tsx";
import { forgetCommands, loadCommands, putCommand, readFor, slashView } from "./slashCommands.ts";

const cmd = (name: string, description: string, insert = `/${name}`): RunnerCommand => ({ name, description, insert });
const list = [cmd("pbi-complete", "PBI を終える"), cmd("pbi-to-tasks", "PBI を Task にする")];

beforeEach(forgetCommands);

test("nothing is read until / is typed", () => {
  let reads = 0;
  const read = async () => (reads++, { commands: list });
  // the picker's effect asks readFor with what the box holds; it reads only once the box starts with "/"
  for (const typed of ["", "p", "pbi", "hello /pbi"]) expect(readFor(typed, "claude", null, read)).toBeNull();
  expect(reads).toBe(0);
  return readFor("/", "claude", null, read)!.then(() => expect(reads).toBe(1));
});

test("a typed / shows rows with the name and the description, and the chosen one is marked", () => {
  const v = slashView("/pbi-c", list);
  expect(v.kind).toBe("rows");
  const html = renderToStaticMarkup(createElement(SlashList, { rows: v.kind === "rows" ? v.rows : null, query: "pbi-c", at: 0, onPick: () => {} }));
  expect(html).toContain("/<mark>pbi-c</mark>omplete");
  expect(html).toContain("PBI を終える");
  expect(html).not.toContain("pbi-to-tasks");
  expect(html).toContain('aria-selected="true"');
});

test("Tab puts insert and a space at the head of the box", () => {
  expect(putCommand("/pbi-c", "$pbi-complete")).toBe("$pbi-complete ");
  expect(putCommand("/pbi-c 4837", "/pbi-complete")).toBe("/pbi-complete 4837");
});

test("a failed read shows one line and nothing else (the box and its send button are not the picker's)", async () => {
  const err = await loadCommands("claude", null, async () => { throw new Error("no login"); }).catch((e) => e as Error);
  const v = slashView("/", err);
  expect(v).toEqual({ kind: "failed" });
  const html = renderToStaticMarkup(createElement(SlashList, { rows: null, query: "", at: 0, onPick: () => {} }));
  expect(html.match(/role="alert"/g)).toHaveLength(1);
  expect(html).not.toContain("role=\"option\"");
});

test("a runner with an empty list shows nothing", async () => {
  const data = await loadCommands("adk", null, async () => ({ commands: [] }));
  expect(slashView("/", data)).toEqual({ kind: "none" });
  expect(slashView("/x", data)).toEqual({ kind: "none" });
});
