import { beforeEach, expect, test } from "bun:test";
import type { RunnerCommand } from "@switchboard/protocol";
import { forgetCommands, loadCommands, putCommand, slashOpen, slashQuery, suggestCommands } from "./slashCommands.ts";

const cmd = (name: string, description = ""): RunnerCommand => ({ name, description, insert: `/${name}` });
const names = (l: RunnerCommand[]) => l.map((c) => c.name);

beforeEach(forgetCommands);

test("slashQuery reads the word after a leading slash and nothing else", () => {
  expect(slashQuery("/pbi")).toBe("pbi");
  expect(slashQuery("a /pbi")).toBeNull();
  expect(slashQuery("/pbi 12")).toBe("pbi");
  expect(slashQuery("/")).toBe("");
  expect(slashQuery("/pbi\nnext")).toBe("pbi");
  expect(slashQuery("")).toBeNull();
});

test("slashOpen holds only while the head word is being typed", () => {
  expect(slashOpen("/")).toBe(true);
  expect(slashOpen("/pbi")).toBe(true);
  expect(slashOpen("/pbi ")).toBe(false);
  expect(slashOpen("/pbi 12")).toBe(false);
  expect(slashOpen("hello /pbi")).toBe(false);
});

test("suggestCommands narrows by name, prefix first", () => {
  const list = [cmd("pbi-to-tasks"), cmd("review"), cmd("pbi-complete"), cmd("a-pbi")];
  expect(names(suggestCommands(list, "pbi"))).toEqual(["pbi-complete", "pbi-to-tasks", "a-pbi"]);
  expect(names(suggestCommands(list, "PBI-C"))).toEqual(["pbi-complete"]);
  expect(names(suggestCommands(list, ""))).toEqual(["a-pbi", "pbi-complete", "pbi-to-tasks", "review"]);
  expect(suggestCommands(list, "zzz")).toEqual([]);
});

test("putCommand replaces the head word with insert and one space, keeping what follows", () => {
  expect(putCommand("/pb", "/pbi-complete")).toBe("/pbi-complete ");
  expect(putCommand("/", "$skill")).toBe("$skill ");
  expect(putCommand("/pb 12", "/pbi-complete")).toBe("/pbi-complete 12");
});

test("loadCommands reads once per runner and workspace and again after a failure", async () => {
  const calls: string[] = [];
  let fail = true;
  const read = async (runner: string, ws: string | null) => {
    calls.push(`${runner}:${ws}`);
    if (runner === "codex" && fail) throw new Error("down");
    return { commands: [cmd(runner)] };
  };
  await loadCommands("claude", "w1", read);
  await loadCommands("claude", "w1", read);
  expect(calls).toEqual(["claude:w1"]);
  await loadCommands("claude", null, read);
  await loadCommands("claude", "w2", read);
  expect(calls).toEqual(["claude:w1", "claude:null", "claude:w2"]);
  await expect(loadCommands("codex", "w1", read)).rejects.toThrow("down");
  fail = false;
  expect(names(await loadCommands("codex", "w1", read))).toEqual(["codex"]);
  expect(calls.filter((c) => c === "codex:w1")).toHaveLength(2);
});
