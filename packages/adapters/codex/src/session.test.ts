import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@switchboard/protocol";
import { codexSessionExists, createCodexAdapter } from "./index.ts";

const FAKE = new URL("../fixtures/fake-app-server.ts", import.meta.url).pathname;

describe("codexSessionExists", () => {
  test("finds the thread's rollout under sessions/YYYY/MM/DD; false when missing or there is no sessions folder", () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-home-"));
    const id = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
    try {
      expect(codexSessionExists(id, home)).toBe(false);
      mkdirSync(join(home, "sessions", "2026", "09", "20"), { recursive: true });
      expect(codexSessionExists(id, home)).toBe(false);
      writeFileSync(join(home, "sessions", "2026", "09", "20", `rollout-2026-09-20T10-00-00-${id}.jsonl`), "{}\n");
      expect(codexSessionExists(id, home)).toBe(true);
      expect(codexSessionExists(id.slice(1), home)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("without a home it looks where the spawned codex keeps its sessions: CODEX_HOME, which the child inherits", () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-env-"));
    const before = process.env.CODEX_HOME;
    try {
      mkdirSync(join(home, "sessions", "2026", "09", "20"), { recursive: true });
      writeFileSync(join(home, "sessions", "2026", "09", "20", "rollout-2026-09-20T10-00-00-thread-env.jsonl"), "{}\n");
      process.env.CODEX_HOME = home;
      expect(codexSessionExists("thread-env")).toBe(true);
      expect(createCodexAdapter().hasSession?.("thread-env")).toBe(true);
    } finally {
      if (before === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("preamble", () => {
  test("goes to codex ahead of the prompt in the first turn, but the transcript shows only what the user typed", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-preamble-"));
    const log = join(home, "wire.jsonl");
    const events: AgentEvent[] = [];
    const s = createCodexAdapter({ bin: FAKE, codexHome: home, config: [`test_wire_log=${log}`] }).start(
      { cwd: home, scope: [home], prompt: "状況は？", preamble: "RECAP", permissionMode: "auto" },
      (e) => events.push(e),
    );
    try {
      const deadline = Date.now() + 5000;
      const turnStart = () => {
        try {
          return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((m) => m.method === "turn/start");
        } catch {
          return undefined;
        }
      };
      while (!turnStart() && Date.now() < deadline) await Bun.sleep(20);
      expect(turnStart()?.params.input[0].text).toBe("RECAP\n\n状況は？");
      expect(events.filter((e) => e.t === "message.delta" && e.role === "user").map((e) => (e.t === "message.delta" ? e.text : ""))).toEqual(["状況は？"]);
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("effort (#833)", () => {
  test("effort: every turn/start of the session carries it (the first and a reply); thread/start does not; none without one", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-effort-"));
    const log = join(home, "wire.jsonl");
    const wire = () => {
      try {
        return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    };
    const run = async (effort: string | undefined, turns: string[]) => {
      const events: AgentEvent[] = [];
      const s = createCodexAdapter({ bin: FAKE, codexHome: home, config: [`test_wire_log=${log}`] }).start({ cwd: home, scope: [home], prompt: turns[0]!, permissionMode: "auto", ...(effort === undefined ? {} : { effort }) }, (e) => events.push(e));
      const until = async (pred: () => boolean) => {
        for (const deadline = Date.now() + 5000; !pred() && Date.now() < deadline; ) await Bun.sleep(20);
        expect(pred()).toBe(true);
      };
      try {
        for (const [i, text] of turns.entries()) {
          if (i > 0) s.send(text);
          await until(() => events.filter((e) => e.t === "permission.ask").length === i + 1);
          const ask = events.filter((e) => e.t === "permission.ask").at(-1)!;
          if (ask.t === "permission.ask") s.respondPermission(ask.id, "allow");
          await until(() => events.filter((e) => e.t === "session.end").length === i + 1);
        }
      } finally {
        await s.close();
      }
    };
    try {
      await run("high", ["first", "reply"]);
      const starts = wire().filter((m) => m.method === "turn/start");
      expect(starts.map((m) => m.params.input[0].text)).toEqual(["first", "reply"]);
      expect(starts.map((m) => m.params.effort)).toEqual(["high", "high"]);
      expect(wire().find((m) => m.method === "thread/start").params).not.toHaveProperty("effort");
      rmSync(log);
      await run(undefined, ["plain"]);
      expect(wire().find((m) => m.method === "turn/start").params).not.toHaveProperty("effort");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
