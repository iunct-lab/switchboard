import { expect, test } from "bun:test";
import type { RunnerInfo } from "@switchboard/protocol";
import { customRunnerFromDraft, isAdkRunner, ledgerRunners, listedRunners, rememberRunnerLabels, runnerLabel, sendsOffHost } from "./runners.ts";

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

test("runnerLabel prefers the daemon's label, then the built-in name, then the id", () => {
  expect(runnerLabel("claude")).toBe("Claude");
  expect(runnerLabel("custom:r", { label: "Research" })).toBe("Research");
  expect(runnerLabel("custom:unknown")).toBe("custom:unknown");
  rememberRunnerLabels([{ ...info("custom:x"), label: "Agent X" } as RunnerInfo]);
  expect(runnerLabel("custom:x")).toBe("Agent X");
});

test("isAdkRunner: DAK and the servers added in Settings", () => {
  expect(isAdkRunner("dak")).toBe(true);
  expect(isAdkRunner("custom:x")).toBe(true);
  expect(isAdkRunner("claude")).toBe(false);
});

test("customRunnerFromDraft keeps only a token variable's name and says why a draft cannot be added", () => {
  const d = { name: "research", label: "", url: "http://127.0.0.1:8001/", app: "research_agent", tokenEnv: "" };
  expect(customRunnerFromDraft(d, [])).toEqual({ entry: { name: "research", label: "research", url: "http://127.0.0.1:8001", app: "research_agent" } });
  expect(customRunnerFromDraft({ ...d, tokenEnv: "RESEARCH_TOKEN" }, [])).toEqual({ entry: { name: "research", label: "research", url: "http://127.0.0.1:8001", app: "research_agent", tokenEnv: "RESEARCH_TOKEN" } });
  expect("error" in customRunnerFromDraft({ ...d, tokenEnv: "sk-secret-value" }, [])).toBe(true);
  expect("error" in customRunnerFromDraft({ ...d, name: "Bad Name" }, [])).toBe(true);
  expect("error" in customRunnerFromDraft({ ...d, name: "dak" }, [])).toBe(true);
  expect("error" in customRunnerFromDraft({ ...d, url: "ftp://x" }, [])).toBe(true);
  expect("error" in customRunnerFromDraft({ ...d, app: " " }, [])).toBe(true);
  expect("error" in customRunnerFromDraft(d, [{ name: "research", label: "r", url: "http://x", app: "a" }])).toBe(true);
});

test("sendsOffHost: loopback stays on the machine", () => {
  expect(sendsOffHost("http://127.0.0.1:8000")).toBe(false);
  expect(sendsOffHost("http://localhost:8000")).toBe(false);
  expect(sendsOffHost("http://[::1]:8000")).toBe(false);
  expect(sendsOffHost("https://agent.example.com")).toBe(true);
  expect(sendsOffHost("https://127.agent.example.com")).toBe(true); // a name that starts like loopback is not loopback
});
