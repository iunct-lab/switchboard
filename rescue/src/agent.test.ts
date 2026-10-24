import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_TOOLS, DEFAULT_AGENT_ARGV, formatLine, RescueAgent } from "./agent.ts";
import { commitFile, daemonSource, freePort, health, makeRepo, until } from "./fixture.ts";
import { appendHistory, buildRelease, currentOf, readHistory, switchTo } from "./releases.ts";
import { startRescue } from "./server.ts";
import { Supervisor } from "./supervisor.ts";

let f: Awaited<ReturnType<typeof makeRepo>>;
let sup: Supervisor;
let v2: string;
/** Stands in for `claude -p`: echoes what it was given on stdin, a line at a time, then a marker. */
const FAKE = ["/bin/sh", "-c", 'echo "cwd=$(pwd)"; while IFS= read -r line; do echo "got: $line"; done; sleep 0.3; echo "fake agent done"'];

beforeAll(async () => {
  f = await makeRepo();
  await buildRelease(f.repo, "HEAD", f.home);
  v2 = await buildRelease(f.repo, await commitFile(f.repo, "packages/core/src/main.ts", daemonSource("v2"), "v2"), f.home);
  switchTo(f.home, f.v1);
  switchTo(f.home, v2);
  appendHistory(f.home, { action: "rejected", from: v2, to: "deadbeef", ok: false, reason: "the candidate exited (1): boom at boot" });
  const port = await freePort();
  sup = new Supervisor({ home: f.home, repo: f.repo, port });
  sup.start();
  await until(() => health(port), "up");
  await until(() => sup.logTail().some((l) => l.includes("fixture daemon v2")), "the daemon's first line is in the log");
});
afterAll(async () => {
  await sup.stop();
  rmSync(f.root, { recursive: true, force: true });
});

test("the default command line accepts edits, streams, and allows no command that runs code from the repository", () => {
  expect(DEFAULT_AGENT_ARGV.slice(0, 7)).toEqual(["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"]);
  expect(DEFAULT_AGENT_ARGV.join(" ")).not.toMatch(/dangerously|bypass/i);
  // Code the agent can write and then run could POST to sb-rescue on loopback: only fixed git / gh subcommands.
  expect(ALLOWED_TOOLS.filter((t) => t.startsWith("Bash("))).toEqual(["status", "diff", "log", "show", "add", "commit", "push"].map((c) => `Bash(git ${c}:*)`).concat("Bash(gh pr create:*)"));
  expect(ALLOWED_TOOLS.some((t) => /bun|node|npm|curl|promote|Bash\((?!git |gh pr create)/.test(t))).toBe(false);
});

test("stream-json lines become what the agent said and did; anything else passes through", () => {
  expect(formatLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "The boot fails in main.ts." }, { type: "tool_use", name: "Edit", input: { file_path: "packages/core/src/main.ts" } }] } }))).toBe('The boot fails in main.ts.\n→ Edit {"file_path":"packages/core/src/main.ts"}');
  expect(formatLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Opened the PR." }))).toBe("finished: Opened the PR.");
  expect(formatLine(JSON.stringify({ type: "system", subtype: "init" }))).toBeNull();
  expect(formatLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "…" }] } }))).toBeNull();
  expect(formatLine("claude: command failed")).toBe("claude: command failed");
  expect(formatLine("{not json")).toBe("{not json");
});

test("two start requests at once start one agent; a command that cannot start leaves its reason in the status", async () => {
  const agent = new RescueAgent({ home: f.home, repo: f.repo, sup }, ["/bin/sh", "-c", "sleep 30"]);
  const results = await Promise.allSettled([agent.start(), agent.start()]);
  expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(agent.status().running).toBe(true);
  await agent.stop();
  expect(agent.status().running).toBe(false);

  const missing = new RescueAgent({ home: f.home, repo: f.repo, sup }, ["/nonexistent/claude"]);
  await expect(missing.start()).rejects.toThrow();
  expect(missing.status()).toMatchObject({ running: false });
  expect(missing.status().error).toBeTruthy();
});

test("the agent runs in a fresh worktree with the log, history and diff in its prompt; its output streams; nothing is promoted", async () => {
  const agent = new RescueAgent({ home: f.home, repo: f.repo, sup }, FAKE);
  const before = { current: currentOf(f.home), history: readHistory(f.home).length };
  await agent.start();
  await expect(agent.start()).rejects.toThrow(/already running/);
  await until(() => agent.status().output.includes("got: "), "first lines arrive while it runs");
  expect(agent.status().running).toBe(true);
  await until(() => !agent.status().running, "agent finished");
  const s = agent.status();
  expect(s.exitCode).toBe(0);
  expect(s.output).toContain("fake agent done");
  expect(s.output).toContain(`cwd=`);
  expect(s.worktree!.startsWith(join(f.home, "rescue-work"))).toBe(true);
  expect(readFileSync(join(s.worktree!, "packages/core/src/main.ts"), "utf8")).toContain('"v2"'); // the running release, not the working tree
  expect(s.output).toContain(`Running release now: ${v2}. Release before it: ${f.v1}.`);
  expect(s.output).toContain("rejected");
  expect(s.output).toContain("boom at boot");
  expect(s.output).toContain("packages/core/src/main.ts |"); // git diff --stat previous..current
  expect(s.output).toContain("fixture daemon v2"); // the daemon log
  expect(s.output).toContain("Do not promote, restart or roll back");
  expect({ current: currentOf(f.home), history: readHistory(f.home).length }).toEqual(before);
});

test("the page starts and stops it over HTTP and shows the output in /api/status", async () => {
  const flag = join(f.root, "started");
  const rescue = startRescue({ home: f.home, repo: f.repo, port: 1, sup }, { port: 0, agentArgv: ["/bin/sh", "-c", `touch ${flag}; echo hello from the agent; sleep 30`] });
  const base = `http://127.0.0.1:${rescue.server.port}`;
  try {
    expect((await fetch(`${base}/api/agent/start`, { method: "POST" })).status).toBe(202);
    expect((await fetch(`${base}/api/agent/start`, { method: "POST" })).status).toBe(409);
    const s = await until(async () => { const x = (await fetch(`${base}/api/status`).then((r) => r.json())) as { agent: { running: boolean; output: string; allowed: string[] | null } }; return x.agent.output.includes("hello") ? x : null; }, "output in status");
    expect(s.agent).toMatchObject({ running: true, allowed: null });
    expect(existsSync(flag)).toBe(true);
    expect((await fetch(`${base}/api/agent/stop`, { method: "POST" })).status).toBe(200);
    expect(((await fetch(`${base}/api/status`).then((r) => r.json())) as { agent: { running: boolean } }).agent.running).toBe(false);
  } finally {
    await rescue.stop();
  }
  writeFileSync(flag, "");
});

test("the agent does not get sb-rescue's starter token or the edge header value (#2077)", async () => {
  // the same OS user, so what it must not have is not in its environment either; the rest of the environment stays
  process.env.SWITCHBOARD_STARTER_TOKEN = "tok";
  process.env.SWITCHBOARD_EDGE_HEADER_VALUE = "edge";
  try {
    const agent = new RescueAgent({ home: f.home, repo: f.repo, sup }, ["/bin/sh", "-c", 'echo "starter=${SWITCHBOARD_STARTER_TOKEN-unset} edge=${SWITCHBOARD_EDGE_HEADER_VALUE-unset} home=${HOME-unset}"']);
    await agent.start();
    await until(() => !agent.status().running, "agent finished");
    expect(agent.status().exitCode).toBe(0);
    expect(agent.status().output).toContain(`starter=unset edge=unset home=${process.env.HOME}`);
  } finally {
    delete process.env.SWITCHBOARD_STARTER_TOKEN;
    delete process.env.SWITCHBOARD_EDGE_HEADER_VALUE;
  }
});
