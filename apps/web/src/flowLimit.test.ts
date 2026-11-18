import { expect, test } from "bun:test";
import { FLOW_LIMIT_FIELD } from "@switchboard/protocol";
import { flowLimitRows, flowNumbers } from "./flowLimit.ts";
import { settings } from "./i18n/settings.ts";

test("flowLimitRows: names the counted and the held PBIs per workspace and leaves out empty ones", () => {
  const names = new Map([["ws_a", "switchboard"], ["ws_b", "lib"]]);
  const rows = flowLimitRows({ limit: 1, workspaces: [
    { workspaceId: "ws_a", counted: [5192], held: [5198, 5170] },
    { workspaceId: "ws_b", counted: [], held: [7] },
    { workspaceId: "ws_gone", counted: [9], held: [] },
  ] }, names);
  expect(rows).toEqual([
    { kind: "counted", ws: "switchboard", numbers: [5192] },
    { kind: "held", ws: "switchboard", numbers: [5198, 5170] },
    { kind: "held", ws: "lib", numbers: [7] },
    { kind: "counted", ws: "ws_gone", numbers: [9] },
  ]);
  expect(flowLimitRows({ limit: 1, workspaces: [] }, names)).toEqual([]);
  expect(flowNumbers([5198, 5170])).toBe("#5198 #5170");
});

test("the field's label is the name the log line points at, and the hint says what the number limits and what 0 does", () => {
  expect(settings.flowLimit.ja).toBe(FLOW_LIMIT_FIELD);
  expect(settings.flowLimitHint.ja).toBe("開発の流れ（flow-improvement）の PBI を同時に何件まで実装中にするか。0 なら P0 以外の flow PBI を始めない");
});
