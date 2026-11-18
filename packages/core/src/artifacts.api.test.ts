// test-reads: packages/core/fixtures/ scripts/parallel-guard.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, StartOptions, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { NO_GH, NO_HISTORY, fakeAdapter, j, startServer, useCoreDaemon, waitFor } from "./api-test-harness.ts";

useCoreDaemon();

describe("artifact fence", () => {
  const send = (url: string, method: string, body?: unknown) => fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const fence = (o: object) => "できました。\n```switchboard-artifact\n" + JSON.stringify(o) + "\n```\n";
  const script = (h: string, reply: string): AgentEvent[] => [
    { t: "session.start", runner: "claude", runnerSessionId: "s-art", cwd: h },
    { t: "message.delta", role: "assistant", text: reply },
    { t: "session.end", status: "ok", summary: "done" },
  ];

  test("the agent's fence registers the file as the Task's artifact, the preamble says how, the same path again replaces the copy", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-artifact-fence-"));
    writeFileSync(join(h, "report.html"), "<h1>v1</h1>");
    const starts: StartOptions[] = [];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script(h, fence({ path: "report.html", title: "週報" })), { starts })], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)) as { task: Task; events: Array<{ ev: AgentEvent }> };
    try {
      const t = await send(`${b}/api/tasks`, "POST", { cwd: h, title: "fence", prompt: "作って", runner: "claude" }).then(j);
      await waitFor(async () => (await get(t.id)).task.status === "done");
      expect(starts[0]!.preamble).toContain("```switchboard-artifact");
      const arts = await fetch(`${b}/api/tasks/${t.id}/artifacts`).then(j);
      expect(arts).toHaveLength(1);
      expect(arts[0]).toMatchObject({ title: "週報", kind: "file", entry: "report.html", mime: "text/html" });
      expect((await get(t.id)).events.map((e) => e.ev).filter((e) => e.t === "artifact.saved")).toEqual([{ t: "artifact.saved", id: arts[0].id, title: "週報" }]);
      expect(readFileSync(join(h, "artifacts", t.id, arts[0].id, "report.html"), "utf8")).toBe("<h1>v1</h1>");
      // a follow-up whose reply names the same path: one artifact, its copy the new content
      writeFileSync(join(h, "report.html"), "<h1>v2</h1>");
      await send(`${b}/api/tasks/${t.id}/send`, "POST", { text: "もう一度" });
      await waitFor(async () => (await get(t.id)).events.filter((e) => e.ev.t === "artifact.saved").length === 2);
      const again = await fetch(`${b}/api/tasks/${t.id}/artifacts`).then(j);
      expect(again).toHaveLength(1);
      expect(again[0].id).toBe(arts[0].id);
      expect(readFileSync(join(h, "artifacts", t.id, arts[0].id, "report.html"), "utf8")).toBe("<h1>v2</h1>");
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a fence that ends the reply without a newline is read before what ends the reply: its row before the tool row, the stop before 完了", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-artifact-fence-"));
    writeFileSync(join(h, "a.html"), "<h1>a</h1>");
    writeFileSync(join(h, "b.html"), "<h1>b</h1>");
    const stop = { id: "wait-ci", op: "CI を待つ", target: "PR #1", reason: "depends", safety: "read-only", evidence: "CI が走っている", state: "waiting", actions: [{ attempt: 1, what: "待った", ok: null }] };
    const events: AgentEvent[] = [
      { t: "session.start", runner: "claude", runnerSessionId: "s-art", cwd: h },
      { t: "message.delta", role: "assistant", text: "1 つ目。\n```switchboard-artifact\n" + JSON.stringify({ path: "a.html", title: "A" }) + "\n```" },
      { t: "tool.call", id: "c1", name: "Bash", summary: "ls", input: { command: "ls" } },
      { t: "tool.result", id: "c1", ok: true, summary: "" },
      { t: "message.delta", role: "assistant", text: "2 つ目。\n```switchboard-artifact\n" + JSON.stringify({ path: "b.html", title: "B" }) + "\n```\n```switchboard-stop\n" + JSON.stringify(stop) + "\n```" },
      { t: "session.end", status: "ok", summary: "done" },
    ];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(events)], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)) as { task: Task; events: Array<{ ev: AgentEvent }> };
    try {
      const t = await send(`${b}/api/tasks`, "POST", { cwd: h, title: "fence", prompt: "作って", runner: "claude" }).then(j);
      await waitFor(async () => (await get(t.id)).task.status === "done");
      const kinds = (await get(t.id)).events.map((e) => e.ev).filter((e) => e.t !== "status" && e.t !== "usage" && e.t !== "quota").map((e) => (e.t === "artifact.saved" ? `artifact:${e.title}` : e.t === "message.delta" ? `delta:${e.role}` : e.t));
      expect(kinds.slice(kinds.indexOf("session.start"))).toEqual(["session.start", "delta:assistant", "artifact:A", "tool.call", "tool.result", "delta:assistant", "artifact:B", "stop.record", "session.end"]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("an artifact fence that is the reply's last line, right before an ask, is registered before the ask row", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-artifact-fence-"));
    writeFileSync(join(h, "d.html"), "<h1>d</h1>");
    const events: AgentEvent[] = [
      { t: "session.start", runner: "claude", runnerSessionId: "s-art", cwd: h },
      { t: "message.delta", role: "assistant", text: "書きます。\n```switchboard-artifact\n" + JSON.stringify({ path: "d.html", title: "D" }) + "\n```" },
      { t: "permission.ask", id: "p1", kind: "exec", tool: "Bash", input: { command: "rm x" }, detail: "rm x" },
    ];
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(events)], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)) as { task: Task; events: Array<{ ev: AgentEvent }> };
    try {
      const t = await send(`${b}/api/tasks`, "POST", { cwd: h, title: "fence", prompt: "作って", runner: "claude" }).then(j);
      await waitFor(async () => (await get(t.id)).task.status === "waiting");
      const kinds = (await get(t.id)).events.map((e) => e.ev.t).filter((k) => k === "message.delta" || k === "artifact.saved" || k === "permission.ask");
      expect(kinds).toEqual(["message.delta", "artifact.saved", "permission.ask"]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("an artifact fence that is the reply's last line, right before session.end, is registered before 完了", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-artifact-fence-"));
    writeFileSync(join(h, "c.html"), "<h1>c</h1>");
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script(h, "できました。\n```switchboard-artifact\n" + JSON.stringify({ path: "c.html", title: "C" }) + "\n```"))], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)) as { task: Task; events: Array<{ ev: AgentEvent }> };
    try {
      const t = await send(`${b}/api/tasks`, "POST", { cwd: h, title: "fence", prompt: "作って", runner: "claude" }).then(j);
      await waitFor(async () => (await get(t.id)).task.status === "done");
      const kinds = (await get(t.id)).events.map((e) => e.ev.t).filter((k) => k === "artifact.saved" || k === "session.end");
      expect(kinds).toEqual(["artifact.saved", "session.end"]);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("broken JSON and a path outside the scope register nothing and each leave one status line; a quoted example is not read at all", async () => {
    const h = mkdtempSync(join(tmpdir(), "switchboard-artifact-fence-"));
    const reply = "```switchboard-artifact\n{not json\n```\n" + "例:\n~~~text\n```switchboard-artifact\n" + JSON.stringify({ path: "quoted.html" }) + "\n```\n~~~\n" + fence({ path: "/etc/hostname", title: "外" });
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [fakeAdapter(script(h, reply))], { port: 0, selfdevChecks: false, gh: NO_GH });
    const b = `http://127.0.0.1:${c.server.port}`;
    const get = async (id: string) => (await fetch(`${b}/api/tasks/${id}`).then(j)) as { task: Task; events: Array<{ ev: AgentEvent }> };
    try {
      const t = await send(`${b}/api/tasks`, "POST", { cwd: h, title: "fence", prompt: "作って", runner: "claude" }).then(j);
      await waitFor(async () => (await get(t.id)).task.status === "done");
      expect(await fetch(`${b}/api/tasks/${t.id}/artifacts`).then(j)).toHaveLength(0);
      const refused = (await get(t.id)).events.map((e) => e.ev).filter((e): e is Extract<AgentEvent, { t: "status" }> => e.t === "status" && e.text.startsWith("成果物を登録できませんでした"));
      expect(refused.map((r) => r.text)).toEqual([expect.stringContaining("フェンスが読めません: JSON として読めません"), expect.stringContaining("outside this task's scope")]);
      expect((await get(t.id)).events.some((e) => e.ev.t === "artifact.saved")).toBe(false);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});
