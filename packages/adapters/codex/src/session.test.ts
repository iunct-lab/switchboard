import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@switchboard/protocol";
import { bedrockModelName, CODEX_BEDROCK_MODELS, codexSessionExists, createCodexAdapter, memoryOffNote } from "./index.ts";

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

describe("bedrock (#1731)", () => {
  test("app-server gets the amazon-bedrock provider and region only when StartOptions.bedrock is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-codex-bedrock-"));
    const bin = join(dir, "codex");
    writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "$OUT"\nenv > "$OUT.env"\n`, { mode: 0o755 });
    const run = async (name: string, bedrock?: { region: string }) => {
      const out = join(dir, name);
      const s = createCodexAdapter({ bin, codexHome: dir, config: ["x=1"] }).start({ cwd: dir, scope: [dir], prompt: "p", env: { OUT: out }, bedrock }, () => undefined);
      await s.exited;
      return { argv: readFileSync(out, "utf8").trim().split("\n"), env: readFileSync(`${out}.env`, "utf8") };
    };
    try {
      const plain = await run("plain");
      expect(plain.argv).toEqual(["app-server", "--listen", "stdio://", "-c", "features.memories=false", "-c", "x=1"]);
      const bedrock = await run("bedrock", { region: "ap-northeast-1" });
      expect(bedrock.argv).toEqual(["app-server", "--listen", "stdio://", "-c", "features.memories=false", "-c", "x=1", "-c", 'model_provider="amazon-bedrock"', "-c", 'model_providers.amazon-bedrock.aws.region="ap-northeast-1"']);
      // the environment is the same either way: no key or variable is added for Bedrock
      const names = (env: string) => env.split("\n").map((l) => l.split("=")[0]).filter((n) => n && n !== "OUT").sort();
      expect(names(bedrock.env)).toEqual(names(plain.env));
      expect(CODEX_BEDROCK_MODELS.map((m) => m.value)).toEqual(["openai.gpt-6.1-sol", "openai.gpt-6-astra", "openai.gpt-6-luna"]);
      expect(createCodexAdapter().bedrockModels).toBe(CODEX_BEDROCK_MODELS);
      // the model the usage is reported under: the Bedrock id on Bedrock (also for the config.toml default), as is otherwise
      expect(bedrockModelName({ bedrock: { region: "ap-northeast-1" } }, "gpt-6-luna")).toBe("openai.gpt-6-luna");
      expect(bedrockModelName({ bedrock: { region: "ap-northeast-1" } }, "openai.gpt-6.1-sol")).toBe("openai.gpt-6.1-sol");
      expect(bedrockModelName({}, "gpt-6-luna")).toBe("gpt-6-luna");
      expect(bedrockModelName({ bedrock: { region: "ap-northeast-1" } }, undefined)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("on Bedrock a task with no model and no config.toml model reports usage under the model app-server runs, as a Bedrock id", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-bedrock-default-"));
    const events: AgentEvent[] = [];
    const s = createCodexAdapter({ bin: FAKE, codexHome: home }).start({ cwd: home, scope: [home], prompt: "p", permissionMode: "auto", bedrock: { region: "ap-northeast-1" } }, (e) => events.push(e));
    try {
      const deadline = Date.now() + 5000;
      while (!events.some((e) => e.t === "permission.ask") && Date.now() < deadline) await Bun.sleep(20);
      const ask = events.find((e) => e.t === "permission.ask");
      if (ask?.t === "permission.ask") s.respondPermission(ask.id, "allow");
      while (!events.some((e) => e.t === "usage") && Date.now() < deadline) await Bun.sleep(20);
      expect(events.filter((e) => e.t === "usage").map((e) => (e.t === "usage" ? e.model : ""))).toContain("openai.gpt-6-luna");
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("memories", () => {
  test("memories: app-server is started with features.memories=false", async () => {
    const home = mkdtempSync(join(tmpdir(), "sb-codex-memories-"));
    const log = join(home, "wire.jsonl");
    const s = createCodexAdapter({ bin: FAKE, codexHome: home, config: [`test_wire_log=${log}`] }).start({ cwd: home, scope: [home], prompt: "p", permissionMode: "auto" }, () => {});
    try {
      const argv = () => {
        try {
          return (JSON.parse(readFileSync(log, "utf8").split("\n")[0]!) as { argv: string[] }).argv;
        } catch {
          return undefined;
        }
      };
      const deadline = Date.now() + 5000;
      while (!argv() && Date.now() < deadline) await Bun.sleep(20);
      const got = argv() ?? [];
      expect(got[got.indexOf("features.memories=false") - 1]).toBe("-c");
    } finally {
      await s.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("memories note: detect warns only when memories stays on", async () => {
    const before = process.env.FAKE_CODEX_MEMORIES;
    try {
      process.env.FAKE_CODEX_MEMORIES = "true";
      expect((await createCodexAdapter({ bin: FAKE }).detect()).note).toContain("features.memories");
      process.env.FAKE_CODEX_MEMORIES = "false";
      expect((await createCodexAdapter({ bin: FAKE }).detect()).note).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.FAKE_CODEX_MEMORIES;
      else process.env.FAKE_CODEX_MEMORIES = before;
    }
  });

  test("memories note: a two-word stage is read as off, a CLI without the row warns", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sb-codex-memories-note-"));
    const bin = join(dir, "codex");
    const script = (row: string) => {
      writeFileSync(bin, `#!/bin/sh\necho '${row}'\n`);
      chmodSync(bin, 0o755);
      return bin;
    };
    try {
      expect(await memoryOffNote(script("memories   under development   false"))).toBeUndefined();
      expect(await memoryOffNote(script("other_feature   stable   false"))).toContain("features.memories");
      // a false row does not count when the command failed or was cut off after printing it
      expect(await memoryOffNote(script("memories   stable   false'; exit 1; echo '"))).toContain("features.memories");
      expect(await memoryOffNote(script("memories   stable   false'; sleep 5; echo '"), 100)).toContain("features.memories");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
