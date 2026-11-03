// test-reads: none
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerId, RunnerSession, StartOptions } from "@switchboard/protocol";
import { FAKE_PNG, FAKE_REPORT, startFakeAdk } from "../fixtures/fake-adk.ts";
import { createAdkAdapter } from "./index.ts";

/** An endpoint that is not DAK: nothing in the adapter may fall back to DAK's values. */
const fake = startFakeAdk(0, "sample_agent");
afterAll(() => fake.stop());
const adapter = (extra: Partial<Parameters<typeof createAdkAdapter>[0]> = {}) => createAdkAdapter({ id: "custom:sample" as RunnerId, label: "Sample", baseUrl: fake.url, app: "sample_agent", ...extra });
const opts = (prompt: string, extra: Partial<StartOptions> = {}): StartOptions => ({ cwd: "/tmp", scope: ["/tmp"], prompt, ...extra });

function run(start: (emit: (e: AgentEvent) => void) => RunnerSession) {
  const events: AgentEvent[] = [];
  const session = start((e) => events.push(e));
  const until = async (pred: (e: AgentEvent) => boolean) => {
    const t0 = Date.now();
    while (!events.some(pred)) {
      if (Date.now() - t0 > 20_000) throw new Error(`timeout: ${events.map((e) => e.t).join(",")}`);
      await Bun.sleep(10);
    }
    return events.find(pred)!;
  };
  return { events, session, until, ended: () => until((e) => e.t === "session.end") };
}
const text = (events: AgentEvent[]) => events.flatMap((e) => (e.t === "message.delta" && e.role === "assistant" ? [e.text] : [])).join("");

describe("createAdkAdapter against a fake ADK server", () => {
  test("detect looks for the endpoint's app and names the label when unreachable", async () => {
    expect(await adapter().detect()).toMatchObject({ available: true, note: `app sample_agent at ${fake.url}` });
    expect((await adapter({ app: "other" }).detect()).available).toBe(false);
    const down = await adapter({ baseUrl: "http://127.0.0.1:9", timeoutMs: 500 }).detect();
    expect(down.note).toContain("Sample agent not reachable");
    expect(down.note).not.toContain("docker");
  });

  test("a turn streams under the entry's id and app, and reports usage", async () => {
    const c = run((emit) => adapter().start(opts("hello"), emit));
    await c.ended();
    expect(adapter().id).toBe("custom:sample" as RunnerId);
    expect(c.events.find((e) => e.t === "session.start")).toMatchObject({ runner: "custom:sample" });
    expect(text(c.events)).toBe("echo:hello");
    expect(c.events.find((e) => e.t === "usage" && e.source === "reported")).toMatchObject({ inputTokens: 60, outputTokens: 10, cacheReadTokens: 40 });
    expect(fake.requests.some((r) => r.path === "/apps/sample_agent/users/switchboard/sessions")).toBe(true);
  });

  test.each([
    ["adk_request_confirmation", "confirm x", "delete_file", "fc-1"],
    ["requestedToolConfirmations", "confirm-native x", "delete_file", "fc-4"],
  ])("a confirmation in the %s form is asked and the answer continues the turn", async (_form, prompt, tool, id) => {
    const c = run((emit) => adapter().start(opts(prompt), emit));
    expect(await c.until((e) => e.t === "permission.ask")).toMatchObject({ id, tool });
    c.session.respondPermission(id, "allow");
    await c.ended();
    expect(c.events.find((e) => e.t === "permission.resolved")).toMatchObject({ id, decision: "allow", by: "user" });
    expect(fake.received.at(-1)?.parts).toEqual([{ functionResponse: { id, name: "adk_request_confirmation", response: { confirmed: true } } }]);
    expect(text(c.events)).toBe("done");
  });

  test("abort ends the session as aborted", async () => {
    const c = run((emit) => adapter().start(opts("sleep"), emit));
    await c.until((e) => e.t === "message.delta" && e.role === "assistant");
    await c.session.abort();
    expect(await c.ended()).toMatchObject({ status: "aborted" });
  });

  test("resuming a session the server no longer has says so and starts a new one", async () => {
    const c = run((emit) => adapter().start(opts("hello", { resumeSessionId: "gone" }), emit));
    await c.ended();
    expect(c.events.some((e) => e.t === "status" && e.text.includes("gone"))).toBe(true);
    expect(c.events.find((e) => e.t === "session.start")).toMatchObject({ runnerSessionId: expect.stringMatching(/^sess-/) });
  });

  test("an attachment goes out inline", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "adk-att-")), "a.png");
    writeFileSync(path, FAKE_PNG);
    const c = run((emit) => adapter().start(opts("hello", { attachments: [{ path, name: "a.png", mime: "image/png" }] as StartOptions["attachments"] }), emit));
    await c.ended();
    expect(fake.received.at(-1)?.parts[1]).toEqual({ inline_data: { mime_type: "image/png", data: Buffer.from(FAKE_PNG).toString("base64") } });
  });

  test("artifactDelta is fetched; artifactSkipPrefix leaves the agent's own, and without it nothing is left out", async () => {
    const attachmentDir = mkdtempSync(join(tmpdir(), "adk-art-"));
    const c = run((emit) => adapter({ artifactSkipPrefix: "spill_" }).start(opts("artifact-spill", { attachmentDir }), emit));
    await c.ended();
    const paths = c.events.flatMap((e) => (e.t === "artifact" && e.kind === "file" ? [e.path] : []));
    expect(paths).toEqual([join(attachmentDir, "report.txt")]);
    expect(readFileSync(paths[0]!, "utf8")).toBe(FAKE_REPORT);
    const attachmentDir2 = mkdtempSync(join(tmpdir(), "adk-art-"));
    const all = run((emit) => adapter().start(opts("artifact-spill", { attachmentDir: attachmentDir2 }), emit));
    await all.ended();
    expect(all.events.filter((e) => e.t === "artifact")).toHaveLength(2);
  });

  test("tokenEnv: every request carries the value read from the environment at that moment; unset sends none", async () => {
    const env = "SWITCHBOARD_TEST_ADK_TOKEN";
    const attachmentDir = mkdtempSync(join(tmpdir(), "adk-tok-"));
    const a = adapter({ tokenEnv: env });
    try {
      process.env[env] = "value-1";
      fake.requests.length = 0;
      await a.detect();
      const c = run((emit) => a.start(opts("artifact-spill", { attachmentDir }), emit));
      await c.ended();
      expect(new Set(fake.requests.map((r) => r.authorization))).toEqual(new Set(["Bearer value-1"]));
      expect(fake.requests.some((r) => r.path.includes("/artifacts/"))).toBe(true);
      expect(fake.requests.some((r) => r.path === "/run_sse")).toBe(true);

      process.env[env] = "value-2";
      c.session.send("again");
      await c.until((e) => e.t === "message.delta" && e.role === "assistant" && e.text.includes("again"));
      expect(fake.requests.at(-1)?.authorization).toBe("Bearer value-2");

      const sid = c.events.flatMap((e) => (e.t === "session.start" ? [e.runnerSessionId] : []))[0]!;
      const resumed = run((emit) => a.start(opts("hello", { resumeSessionId: sid }), emit));
      await resumed.ended();
      expect(fake.requests.find((r) => r.path.endsWith(`/sessions/${sid}`))?.authorization).toBe("Bearer value-2");

      process.env[env] = "";
      fake.requests.length = 0;
      await a.detect();
      expect(fake.requests).toEqual([{ path: "/list-apps", authorization: null }]);
    } finally {
      delete process.env[env];
    }
  });
});
