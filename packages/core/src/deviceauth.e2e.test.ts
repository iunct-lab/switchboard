import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Database } from "bun:sqlite";
import type { AgentEvent, RunnerAdapter, RunnerSession, ServerMessage } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";

/**
 * The approval path end to end (#662, docs/design/device-auth.md): a fake runner runs a fake login through the kit's
 * `device-auth` with the environment the daemon gave it, reports what the command printed as its tool result, then
 * writes the outcome to an Issue with `gh` (through the kit's check in front of it, to a fake gh that records).
 * Made-up values only.
 */
const BIN = join(import.meta.dir, "../../../ops-kit/bin/device-auth");
const URL_ = "https://device.login.example/activate";
const CODE = ["QRST", "UVWX"].join("-");

let dir: string;
let home: string;
let ghLog: string;
let core: Awaited<ReturnType<typeof startServer>>;
let base: string;
/** The first entry of each runner's PATH: the kit's bin, whose gh is the check the write goes through. */
const kits: string[] = [];

/** The runner's turn: `device-auth --expires-in <n> -- bun login.ts <done>`, then `gh pr comment` with the exit code only (an Issue of the workspace is written through the app, #2694). */
function runner(): RunnerAdapter {
  return {
    id: "claude",
    async detect() {
      return { available: true, version: "fake" };
    },
    start(opts, emit) {
      let exit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (exit = r));
      const [, expires, done] = opts.prompt.match(/expires=(\d+) done=(\S+)/) ?? [];
      void (async () => {
        emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${expires}`, cwd: opts.cwd });
        emit({ t: "tool.call", id: "t1", name: "Bash", input: { command: "device-auth -- cloud login" }, summary: "device-auth -- cloud login" });
        // the fake gh right after the kit's bin, so a write still passes the kit's check in front of gh
        const [kit = "", ...rest] = (opts.env?.PATH ?? "").split(delimiter);
        kits.push(kit);
        const env = { ...process.env, ...opts.env, PATH: [kit, dir, ...rest].join(delimiter) };
        const p = Bun.spawn([BIN, "--expires-in", expires!, "--", "bun", join(dir, "login.ts"), done!], { env, stdout: "pipe", stderr: "pipe" });
        const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
        emit({ t: "tool.result", id: "t1", ok: code === 0, summary: `${out}${err}` });
        // cwd: outside this checkout, whose publicSync would have the guard ask gh which repository it writes to
        const gh = Bun.spawnSync(["gh", "pr", "comment", "1", "--body", `承認の結果: exit ${code}`], { cwd: dir, env, stdout: "pipe", stderr: "pipe" });
        const ev: AgentEvent = { t: "message.delta", role: "assistant", text: `gh exit ${gh.exitCode}` };
        emit(ev);
        emit({ t: "session.end", status: "ok", summary: "ok" });
        exit(0);
      })();
      const session: RunnerSession = { send: () => undefined, respondPermission: () => undefined, abort: async () => exit(null), close: async () => exit(0), exited };
      return session;
    },
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-test-deviceauth-e2e-"));
  home = join(dir, "home");
  mkdirSync(home);
  ghLog = join(dir, "gh.jsonl");
  writeFileSync(
    join(dir, "login.ts"),
    `const [done] = process.argv.slice(2);
console.log("Open this page to sign in:");
console.log("\\x1b[94m${URL_}\\x1b[0m");
console.log("and enter the code \\x1b[1m${CODE}\\x1b[0m");
while (!(await Bun.file(done).exists())) await Bun.sleep(20);
console.log("Signed in.");
`,
  );
  // records its arguments and its standard input (a body sent with --body-file - counts too)
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(ghLog)}\ncat >> ${JSON.stringify(ghLog)}\n`);
  chmodSync(join(dir, "gh"), 0o755);
  const cfg = loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(dir, "no-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
  core = await startServer(cfg, [runner()], { port: 0, selfdevChecks: false, dryRunRestart: true, judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined) });
  base = `http://127.0.0.1:${core.server.port}`;
});
afterAll(async () => {
  await core.stop();
  rmSync(dir, { recursive: true, force: true });
});

const j = (r: Response) => r.json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const until = async (ok: () => boolean | Promise<boolean>, ms = 10_000) => {
  for (const end = Date.now() + ms; !(await ok()) && Date.now() < end; ) await Bun.sleep(20);
  expect(await ok()).toBe(true);
};
const start = (expires: number, done: string) =>
  fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: home, title: "cloud login", prompt: `expires=${expires} done=${done}`, runner: "claude" }) }).then(j);
const toolResult = async (id: string) => ((await fetch(`${base}/api/tasks/${id}`).then(j)).events as Array<{ ev: AgentEvent }>).map((e) => e.ev).find((e) => e.t === "tool.result") as Extract<AgentEvent, { t: "tool.result" }> | undefined;

function socket() {
  const msgs: ServerMessage[] = [];
  const ws = new WebSocket(`${base.replace("http", "ws")}/ws`);
  ws.onmessage = (m) => msgs.push(JSON.parse(String(m.data)));
  return { msgs, ws, open: new Promise<void>((r) => (ws.onopen = () => r())) };
}

describe("device auth end to end (#662)", () => {
  test("the screen gets the URL and code; the approval lets the Task go on and only the exit code reaches the Issue; nothing stored holds the values", async () => {
    const { msgs, ws, open } = socket();
    await open;
    const done = join(dir, "approved");
    const task = await start(600, done);

    // (a) while it waits: the API and the WebSocket carry the values
    await until(() => msgs.some((m) => m.type === "task.deviceAuth" && m.taskId === task.id && m.auth?.code === CODE));
    expect(await fetch(`${base}/api/tasks/${task.id}/device-auth`).then(j)).toMatchObject({ url: URL_, code: CODE });
    expect((await fetch(`${base}/api/tasks/${task.id}`).then(j)).task.status).toBe("running");

    // (d) the person approves (the login ends): the card goes, the Task goes on, gh gets the exit code only
    writeFileSync(done, "");
    await until(async () => (await fetch(`${base}/api/tasks/${task.id}`).then(j)).task.status === "done");
    expect(msgs.some((m) => m.type === "task.deviceAuth" && m.taskId === task.id && m.auth === null)).toBe(true);
    expect(await fetch(`${base}/api/tasks/${task.id}/device-auth`).then(j)).toBeNull();
    expect(readFileSync(ghLog, "utf8")).toBe("pr comment 1 --body 承認の結果: exit 0\n");
    // the write went through the kit's check in front of gh, as a real runner's does
    expect(kits.at(-1)).toBe(join(import.meta.dir, "../../../ops-kit/bin"));
    expect(readFileSync(join(kits.at(-1)!, "gh"), "utf8")).toContain("// gh-guard");
    const result = await toolResult(task.id);
    expect(result?.ok).toBe(true);
    expect(result?.summary).toContain("[画面に表示]");
    expect(result?.summary).toContain("Signed in.");
    ws.close();

    // (b) the DB (events, tasks, everything) and every broadcast other than task.deviceAuth hold neither value
    expect(JSON.stringify(msgs.filter((m) => m.type !== "task.deviceAuth"))).not.toContain(CODE);
    expect(JSON.stringify(msgs.filter((m) => m.type !== "task.deviceAuth"))).not.toContain("login.example");
    const db = new Database(join(home, "switchboard.db"), { readonly: true });
    try {
      for (const { name } of db.query<{ name: string }, []>("select name from sqlite_master where type = 'table'").all()) {
        const rows = JSON.stringify(db.query(`select * from "${name}"`).all());
        expect(rows).not.toContain(CODE);
        expect(rows).not.toContain("login.example");
      }
    } finally {
      db.close();
    }
  }, 30_000);

  test("(c) the code expires: the screen is told, device-auth stops the login with exit 124, and the Issue gets that only", async () => {
    rmSync(ghLog, { force: true });
    const { msgs, ws, open } = socket();
    await open;
    const task = await start(1, join(dir, "never"));
    await until(() => msgs.some((m) => m.type === "task.deviceAuth" && m.taskId === task.id && m.auth?.code === CODE));
    await until(() => msgs.some((m) => m.type === "task.deviceAuth" && m.taskId === task.id && m.auth === null), 5_000);
    await until(async () => (await fetch(`${base}/api/tasks/${task.id}`).then(j)).task.status === "done");
    const result = await toolResult(task.id);
    expect(result?.ok).toBe(false);
    expect(result?.summary).toContain("期限");
    expect(result?.summary).not.toContain(CODE);
    expect(existsSync(ghLog) && readFileSync(ghLog, "utf8")).toBe("pr comment 1 --body 承認の結果: exit 124\n");
    ws.close();
  }, 30_000);
});
