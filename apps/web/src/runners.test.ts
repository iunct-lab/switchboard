import { expect, test } from "bun:test";
import type { RunnerInfo } from "@switchboard/protocol";
import { ledgerRunners, listedRunners } from "./runners.ts";

const info = (id: string) => ({ id, available: true, permissionModes: [], models: [], efforts: [] }) as unknown as RunnerInfo;

test("listedRunners omits dak when the daemon does not list it", () => {
  expect(listedRunners([info("claude"), info("codex")])).toEqual(["claude", "codex"]);
  expect(listedRunners(undefined)).toEqual(["claude", "codex"]);
  expect(listedRunners([info("claude"), info("codex")], "dak")).toEqual(["claude", "codex", "dak"]);
  expect(listedRunners([info("claude"), info("codex"), info("dak")])).toEqual(["claude", "codex", "dak"]);
});

test("ledgerRunners adds a recorded runner that is not listed", () => {
  expect(ledgerRunners(["claude", "codex"], ["dak", "claude", "dak"])).toEqual(["claude", "codex", "dak"]);
});

test("ledgerRunners adds nothing without records", () => {
  expect(ledgerRunners(["claude", "codex"], [])).toEqual(["claude", "codex"]);
});
