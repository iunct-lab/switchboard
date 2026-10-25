import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAdapter } from "@switchboard/adapter-claude";
import type { RunnerAdapter } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { RunnerLogins } from "./runnerlogin.ts";
import { startServer } from "./server.ts";

// Stand-in CLIs, shaped like what the real ones print (2026-09-26). Never the real login.
let dir: string;
const script = (name: string, body: string) => {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
};
let claude: string, codex: string, hangs: string, fails: string;
const PASTED = "pasted-secret-code-4242";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "switchboard-test-runnerlogin-"));
  // claude: the URL, the prompt, then the code on stdin — echoed back (the real one may), so the test sees it never leaks
  claude = script("claude", `echo "Opening browser to sign in…"\necho "If the browser didn't open, visit: https://claude.example/oauth/authorize?code=true&state=AbC-12345&arg=$1"\nprintf "Paste code here if prompted > "\nread code\necho "got $code"\n[ "$code" = "${PASTED}" ] && { echo "Login successful."; exit 0; }\nexit 1`);
  // codex: ANSI-coloured URL and device code, then it waits for the approval elsewhere (here: 0.3 s)
  codex = script("codex", `printf '1. Open this link\\n   \\033[94mhttps://auth.example/codex/device\\033[0m\\n\\n2. Enter this one-time code \\033[90m(expires in 15 minutes)\\033[0m\\n   \\033[94mABCD-EFGHI\\033[0m\\n'\nsleep 0.3\nexit 0`);
  hangs = script("hangs", `echo "visit: https://x.example/a"\necho "Paste code here if prompted >"\nsleep 30`);
  fails = script("fails", `echo "visit: https://x.example/a"\necho "Paste code here if prompted >"\nread code\necho "nope: $code" >&2\nexit 3`);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const spawn = (argv: string[]) => Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });

describe("RunnerLogins (#354)", () => {
  test("codex: the device URL and one-time code come out of the ANSI output, not from the URL; done by itself", async () => {
    const done: string[] = [];
    const logins = new RunnerLogins(spawn, (r) => done.push(r));
    const v = await logins.start("codex", [codex]);
    expect(v).toMatchObject({ runner: "codex", state: "waiting", url: "https://auth.example/codex/device", code: "ABCD-EFGHI", needsCode: false });
    for (let i = 0; i < 50 && logins.get("codex")?.state === "waiting"; i++) await Bun.sleep(20);
    expect(logins.get("codex")?.state).toBe("done");
    expect(done).toEqual(["codex"]);
  });

  test("claude: the URL (whose state param looks like a code is not taken for one), a box for the code; the pasted code goes to stdin and nowhere else", async () => {
    const logins = new RunnerLogins(spawn, () => undefined);
    const v = await logins.start("claude", [claude]);
    expect(v).toMatchObject({ state: "waiting", needsCode: true });
    expect(v.url).toStartWith("https://claude.example/oauth/authorize");
    expect(v.code).toBeUndefined();
    const after = await logins.submit("claude", PASTED);
    expect(after?.state).toBe("done");
    expect(JSON.stringify(after)).not.toContain(PASTED);
    expect(JSON.stringify(logins.get("claude"))).not.toContain(PASTED);
  });

  test("a wrong code fails with the exit code only (the CLI's output, which echoes the code, is not relayed)", async () => {
    const logins = new RunnerLogins(spawn, () => undefined);
    await logins.start("claude", [fails]);
    const v = await logins.submit("claude", PASTED);
    expect(v?.state).toBe("failed");
    expect(v?.error).toContain("exit 3");
    expect(JSON.stringify(v)).not.toContain(PASTED);
  });

  test("a pasted code with a code-shaped part, echoed back by the CLI, never becomes a relayed code (review #357)", async () => {
    const echo = script("echoer", `echo "visit: https://claude.example/oauth/authorize"\nprintf "Paste code here if prompted > "\nread code\necho "got $code"\nsleep 0.3\nexit 0`);
    const logins = new RunnerLogins(spawn, () => undefined);
    await logins.start("claude", [echo]);
    const v = await logins.submit("claude", "sk-ABCD-12345-rest#state");
    expect(v?.code).toBeUndefined();
    expect(JSON.stringify(logins.get("claude"))).not.toContain("ABCD-12345");
  });

  test("only a URL on the runner's login hosts is relayed: an update notice printed first is skipped (review #357)", async () => {
    const noisy = script("noisy", `echo "A new version is out: https://github.com/openai/codex/releases"\necho "   https://auth.openai.com/codex/device"\necho "   ABCD-EFGHI"\nsleep 0.3\nexit 0`);
    const logins = new RunnerLogins(spawn, () => undefined);
    const v = await logins.start("codex", [noisy], ["auth.openai.com"]);
    expect(v.url).toBe("https://auth.openai.com/codex/device");
    expect(v.code).toBe("ABCD-EFGHI");
  });

  test("取り消す ends a waiting login", async () => {
    const logins = new RunnerLogins(spawn, () => undefined);
    await logins.start("claude", [hangs]);
    expect(logins.cancel("claude")).toMatchObject({ state: "failed", error: "取り消しました" });
    expect(logins.cancel("codex")).toBeUndefined();
  });

  test("one login per runner: a second start returns the running one; a login left open is killed after the timeout", async () => {
    let spawned = 0;
    const logins = new RunnerLogins((argv) => (spawned++, spawn(argv)), () => undefined, 2000);
    const a = await logins.start("claude", [hangs]);
    const b = await logins.start("claude", [hangs]);
    expect(spawned).toBe(1);
    expect(b.url).toBe(a.url!);
    for (let i = 0; i < 60 && logins.get("claude")?.state === "waiting"; i++) await Bun.sleep(50);
    expect(logins.get("claude")).toMatchObject({ state: "failed" });
    expect(logins.get("claude")?.error).toContain("時間内に終わりませんでした");
  });
});

describe("logout (#2528)", () => {
  let home: string;
  let core: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  let marker: string;
  let argsFile: string;
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "switchboard-test-logout-"));
    marker = join(home, "loggedout");
    argsFile = join(home, "logout-args");
    const bin = join(home, "claude");
    writeFileSync(bin, `#!/bin/sh\nif [ "$1 $2" = "auth logout" ]; then echo "$@" > "${argsFile}"; [ -f "${home}/fail" ] && exit 1; touch "${marker}"; exit 0; fi\nexit 9\n`);
    chmodSync(bin, 0o755);
    const claude: RunnerAdapter = {
      id: "claude",
      loginArgs: [],
      logoutArgs: ["auth", "logout"],
      async detect() {
        return existsSync(marker) ? { available: true, version: "fake", path: bin, login: "expired" } : { available: true, version: "fake", path: bin, login: "ok", loginKind: "console" };
      },
      start() {
        throw new Error("no runs");
      },
    };
    const codex: RunnerAdapter = { id: "codex", loginArgs: [], async detect() { return { available: true, version: "fake", path: bin, login: "ok" }; }, start() { throw new Error("no runs"); } };
    core = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [claude, codex], { port: 0, selfdevChecks: false });
    base = `http://127.0.0.1:${core.server.port}`;
  });
  afterAll(async () => {
    await core.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const runners = async () => ((await (await fetch(`${base}/api/health`)).json()) as { runners: { id: string; login?: string; loginKind?: string }[] }).runners;

  test("a failing logout is a 502 and leaves the login as it was", async () => {
    writeFileSync(join(home, "fail"), "");
    expect((await fetch(`${base}/api/runners/claude/logout`, { method: "POST" })).status).toBe(502);
    rmSync(join(home, "fail"));
    expect((await runners()).find((r) => r.id === "claude")).toMatchObject({ login: "ok", loginKind: "console" });
  });

  test("POST /api/runners/claude/logout runs `auth logout`, then health says expired and the kind is gone; codex has no logout", async () => {
    expect((await runners()).find((r) => r.id === "claude")).toMatchObject({ login: "ok", loginKind: "console" });
    const res = await fetch(`${base}/api/runners/claude/logout`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(readFileSync(argsFile, "utf8").trim()).toBe("auth logout");
    const claude = (await runners()).find((r) => r.id === "claude");
    expect(claude?.login).toBe("expired");
    expect(claude?.loginKind).toBeUndefined();
    expect((await fetch(`${base}/api/runners/codex/logout`, { method: "POST" })).status).toBe(404);
  });
});

describe("the account behind `claude auth status` stays out of the API and the logs (#2528)", () => {
  test("health shows the kind and nothing else of the status output; a missing executable is a 502 for logout", async () => {
    const home = mkdtempSync(join(tmpdir(), "switchboard-test-authkind-"));
    const bin = join(home, "claude");
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.281 (Claude Code)"; exit 0; fi\nif [ "$1 $2" = "auth status" ]; then echo '{"loggedIn":true,"authMethod":"api_key","email":"someone@example.com","orgName":"Acme Org","accountName":"Some Person"}'; exit 0; fi\nexit 9\n`);
    chmodSync(bin, 0o755);
    const log = spyOn(console, "log");
    const warn = spyOn(console, "warn");
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [createClaudeAdapter({ bin })], { port: 0, selfdevChecks: false });
    try {
      const base = `http://127.0.0.1:${c.server.port}`;
      const health = await (await fetch(`${base}/api/health?recheck=1`)).text();
      expect(JSON.parse(health).runners[0]).toMatchObject({ login: "ok", loginKind: "console" });
      const settings = await (await fetch(`${base}/api/settings`)).text();
      for (const text of [health, settings, JSON.stringify([...log.mock.calls, ...warn.mock.calls])]) for (const secret of ["someone@example.com", "Acme Org", "Some Person"]) expect(text).not.toContain(secret);
      rmSync(bin);
      expect((await fetch(`${base}/api/runners/claude/logout`, { method: "POST" })).status).toBe(502);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      await c.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the API (#354)", () => {
  let home: string;
  let core: Awaited<ReturnType<typeof startServer>>;
  let base: string;
  const adapter = (id: "claude" | "codex", bin: () => string, login: "ok" | "expired"): RunnerAdapter => ({
    id,
    loginArgs: [],
    loginApiArgs: id === "claude" ? ["--console"] : undefined,
    async detect() {
      return { available: true, version: "fake", path: bin(), login, loginHint: `${id} login` };
    },
    start() {
      throw new Error("no runs");
    },
  });
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "switchboard-test-runnerlogin-api-"));
    core = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(home, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [adapter("claude", () => claude, "expired"), adapter("codex", () => codex, "expired")], { port: 0, selfdevChecks: false });
    base = `http://127.0.0.1:${core.server.port}`;
  });
  afterAll(async () => {
    await core.stop();
    rmSync(home, { recursive: true, force: true });
  });
  const post = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  test("start → URL and box; the pasted code is accepted, never echoed in any response, and not written to the log", async () => {
    const log = spyOn(console, "log");
    const err = spyOn(console, "error");
    try {
      const v = (await (await post("/api/runners/claude/login")).json()) as { url: string; needsCode: boolean };
      expect(v.needsCode).toBe(true);
      expect(v.url).toStartWith("https://claude.example/");
      const r = await post("/api/runners/claude/login/code", { code: PASTED });
      const text = await r.text();
      expect(r.status).toBe(200);
      expect(text).not.toContain(PASTED);
      expect(JSON.parse(text).state).toBe("done");
      const again = await (await fetch(`${base}/api/runners/claude/login`)).text();
      expect(again).not.toContain(PASTED);
      for (const call of [...log.mock.calls, ...err.mock.calls]) expect(JSON.stringify(call)).not.toContain(PASTED);
    } finally {
      log.mockRestore();
      err.mockRestore();
    }
  });

  test("codex relays its device code; an unknown runner or a bad body is refused", async () => {
    const v = (await (await post("/api/runners/codex/login")).json()) as { code: string };
    expect(v.code).toBe("ABCD-EFGHI");
    expect((await post("/api/runners/dak/login")).status).toBe(404);
    expect((await post("/api/runners/claude/login/code", { code: "" })).status).toBe(400);
  });

  test("billing=api runs the runner's API login (claude --console)", async () => {
    const v = (await (await post("/api/runners/claude/login?billing=api")).json()) as { url: string };
    expect(v.url).toContain("arg=--console");
  });

  test("billing=api needs the runner to offer an API login", async () => {
    expect((await post("/api/runners/codex/login?billing=api")).status).toBe(404);
  });
});
