import { recordingText, skipRecordings, assertRecordings } from "../../../scripts/recordings.ts";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAdapter, RunnerSession, StartOptions } from "@switchboard/protocol";
import { prepareTeleportWorktree } from "./claude-cloud.ts";
import { loadConfig } from "./config.ts";
import { MAX_PTY_SESSIONS, OscStatusReader, PTY_STATUS_REPLY, PtyManager, REPLAY_CHARS, TELEPORT_SESSION_NAME } from "./pty.ts";
import { startServer } from "./server.ts";

const NO_HISTORY = { SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" };

/** Teleport runs as `/usr/bin/env -u <marker>… <bin> <args>`: the program and arguments it runs, for argv assertions. */
function unwrapEnv(b: string, a: string[]): { bin: string; args: string[] } {
  if (b !== "/usr/bin/env") return { bin: b, args: a };
  let i = 0; while (a[i] === "-u") i += 2;
  return { bin: a[i]!, args: a.slice(i + 1) };
}

/** A runner that starts and then does nothing: the terminal does not depend on it. */
function idleAdapter(): RunnerAdapter {
  return {
    id: "claude",
    async detect() {
      return { available: true };
    },
    start(_o: StartOptions, emit) {
      let done!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (done = r));
      queueMicrotask(() => emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" }));
      const s: RunnerSession = { send: () => undefined, respondPermission: () => undefined, abort: async () => done(null), close: async () => done(0), exited };
      return s;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (r: Response) => r.json() as Promise<any>;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A terminal socket that collects what the shell prints. The first frame names the session (PtyAttached, #1137). */
async function connect(url: string) {
  const ws = new WebSocket(url);
  const term = {
    ws,
    shell: undefined as string | undefined,
    out: "",
    closed: false,
    code: undefined as number | undefined,
    input: (data: string) => ws.send(JSON.stringify({ type: "input", data })),
    async until(re: RegExp, ms = 5000) {
      const t0 = Date.now();
      while (!re.test(term.out)) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${re}; got ${JSON.stringify(term.out.slice(-400))}`);
        await Bun.sleep(10);
      }
    },
  };
  ws.onmessage = (e) => {
    if (term.shell === undefined) {
      const first = JSON.parse(String(e.data)) as { type: string; shell: string };
      expect(first.type).toBe("attached");
      term.shell = first.shell;
    } else term.out += String(e.data);
  };
  ws.onclose = (e) => {
    term.closed = true;
    term.code = e.code;
  };
  await new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error(`could not connect to ${url}`));
  });
  // the first frame (or a refusal) comes after the open: on a slow machine (CI runners) a test reading term.shell right
  // after connect() would see undefined
  for (const t0 = Date.now(); term.shell === undefined && !term.closed; await Bun.sleep(5))
    if (Date.now() - t0 > 5000) throw new Error(`no first frame from ${url}`);
  return term;
}

let home: string;
let repo: string;
let core: Awaited<ReturnType<typeof startServer>>;
let base: string;
let wsBase: string;
let taskId: string;
const savedShell = process.env.SHELL;

beforeAll(async () => {
  process.env.SHELL = "/bin/sh"; // the same prompt-less behaviour on a developer's machine and in CI
  home = mkdtempSync(join(tmpdir(), "sb-pty-"));
  repo = join(home, "repo");
  mkdirSync(repo);
  core = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [idleAdapter()], { port: 0 });
  base = `http://127.0.0.1:${core.server.port}`;
  wsBase = `ws://127.0.0.1:${core.server.port}`;
  taskId = (await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: repo, title: "pty", prompt: "p", runner: "claude" }) }).then(j)).id;
});
afterAll(async () => {
  await core.stop();
  if (savedShell === undefined) delete process.env.SHELL;
  else process.env.SHELL = savedShell;
  rmSync(home, { recursive: true, force: true });
});

describe("terminal tab (#16)", () => {
  test("health says the terminal is available; /ws/pty opens a shell in the task's cwd and input comes back as output", async () => {
    expect((await fetch(`${base}/api/health`).then(j)).features).toEqual({ pty: true });
    const term = await connect(`${wsBase}/ws/pty?task=${taskId}`);
    // $((…)) so the match is the command's output, not the echo of what was typed
    term.input("echo pty-$((1+1))-ok; pwd\n");
    await term.until(/pty-2-ok/);
    await term.until(new RegExp(realpathSync(repo).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    term.ws.send(JSON.stringify({ type: "resize", cols: 132, rows: 40 }));
    term.input("stty size\n");
    await term.until(/40 132/);
    term.ws.close();
  });

  test("the shell outlives its socket: a second connection gets the earlier output and the same shell", async () => {
    const first = await connect(`${wsBase}/ws/pty?task=${taskId}`);
    first.input("MARK=kept-$((20+22)); echo $MARK\n");
    await first.until(/kept-42/);
    first.ws.close();
    await Bun.sleep(50);

    const second = await connect(`${wsBase}/ws/pty?task=${taskId}`);
    await second.until(/kept-42/); // replayed, nothing was typed on this socket
    second.input("echo again-$MARK\n");
    await second.until(/again-kept-42/); // the variable lives in the same shell
    second.ws.close();
  });

  test("an unknown task is refused; a shell that exits closes its sockets and the next connection starts a new one", async () => {
    expect((await fetch(`${base}/ws/pty?task=nope`, { headers: { upgrade: "websocket", connection: "upgrade" } })).status).toBe(404);
    const term = await connect(`${wsBase}/ws/pty?task=${taskId}`);
    term.input("exit\n");
    const t0 = Date.now();
    while (!term.closed && Date.now() - t0 < 5000) await Bun.sleep(10);
    expect(term.closed).toBe(true);
    const next = await connect(`${wsBase}/ws/pty?task=${taskId}`);
    next.input("echo fresh-${MARK:-unset}\n");
    await next.until(/fresh-unset/);
    next.ws.close();
  });

  test("a request that does not become a socket starts no shell", async () => {
    const h = mkdtempSync(join(tmpdir(), "sb-pty-426-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [idleAdapter()], { port: 0 });
    try {
      const b = `http://127.0.0.1:${c.server.port}`;
      const id = (await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "pty", prompt: "p", runner: "claude" }) }).then(j)).id;
      expect((await fetch(`${b}/ws/pty?task=${id}`)).status).toBe(426);
      expect(c.pty!.pid(id)).toBeUndefined();
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("the replay is the last REPLAY_CHARS of output, whatever the chunk sizes, and never starts inside a surrogate pair", async () => {
    let emit!: (d: string) => void;
    const fake = { pid: 1, onData: (f: (d: string) => void) => void (emit = f), onExit: () => undefined, write: () => undefined, resize: () => undefined, kill: () => undefined };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (await PtyManager.load(async () => ({ spawn: (() => fake) as any })))!;
    m.open("t", "/", "/bin/sh");
    const replay = () => {
      let got = "";
      const c = { send: (d: string) => void (got += d), close: () => undefined };
      m.attach("t", c);
      m.detach("t", c);
      return got;
    };
    emit("a".repeat(40_000));
    emit("b".repeat(30_000));
    expect(replay()).toBe("a".repeat(REPLAY_CHARS - 30_000) + "b".repeat(30_000));
    emit("c".repeat(REPLAY_CHARS * 2)); // one chunk larger than the whole buffer
    expect(replay()).toBe("c".repeat(REPLAY_CHARS));
    emit("😀".repeat(REPLAY_CHARS / 2 - 1) + "xy");
    expect(replay()).toBe("😀".repeat(REPLAY_CHARS / 2 - 1) + "xy"); // exactly full, starts on a whole pair
    emit("z"); // the cut now falls inside the first pair: the orphaned half is dropped
    expect(replay()).toBe("😀".repeat(REPLAY_CHARS / 2 - 2) + "xyz");
  });

  test("stopping the daemon kills the shell and what runs in it", async () => {
    const h = mkdtempSync(join(tmpdir(), "sb-pty-stop-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [idleAdapter()], { port: 0 });
    try {
      const b = `127.0.0.1:${c.server.port}`;
      const id = (await fetch(`http://${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "pty", prompt: "p", runner: "claude" }) }).then(j)).id;
      const term = await connect(`ws://${b}/ws/pty?task=${id}`);
      term.input("echo shell=$$; sleep 300 & echo child=$!\n");
      await term.until(/shell=\d+[\s\S]*child=\d+/);
      const shell = Number(/shell=(\d+)/.exec(term.out)![1]);
      const child = Number(/child=(\d+)/.exec(term.out)![1]);
      expect(alive(shell)).toBe(true);
      expect(alive(child)).toBe(true);
      await c.stop();
      const t0 = Date.now();
      while ((alive(shell) || alive(child)) && Date.now() - t0 < 5000) await Bun.sleep(20);
      expect(alive(shell)).toBe(false);
      expect(alive(child)).toBe(false);
    } finally {
      await c.stop().catch(() => undefined);
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("the task's shell closes when the task ends", async () => {
    const h = mkdtempSync(join(tmpdir(), "sb-pty-end-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [idleAdapter()], { port: 0 });
    try {
      const b = `127.0.0.1:${c.server.port}`;
      const id = (await fetch(`http://${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "pty", prompt: "p", runner: "claude" }) }).then(j)).id;
      const term = await connect(`ws://${b}/ws/pty?task=${id}`);
      term.input("echo shell=$$; sleep 300 & echo child=$!\n");
      await term.until(/shell=\d+[\s\S]*child=\d+/);
      const shell = Number(/shell=(\d+)/.exec(term.out)![1]);
      const child = Number(/child=(\d+)/.exec(term.out)![1]);
      await fetch(`http://${b}/api/tasks/${id}/abort`, { method: "POST" });
      const t0 = Date.now();
      while ((alive(shell) || alive(child) || !term.closed) && Date.now() - t0 < 5000) await Bun.sleep(20);
      expect(alive(shell)).toBe(false);
      expect(alive(child)).toBe(false);
      expect(term.closed).toBe(true);
    } finally {
      await c.stop().catch(() => undefined);
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("no more than MAX_PTY_SESSIONS shells are open at once; a task that has one can still reconnect", async () => {
    const h = mkdtempSync(join(tmpdir(), "sb-pty-cap-"));
    let n = 0;
    const fake = () => ({ pid: 4_194_900 + n++, onData: () => undefined, onExit: () => undefined, write: () => undefined, resize: () => undefined, kill: () => undefined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [idleAdapter()], { port: 0, loadPty: () => PtyManager.load(async () => ({ spawn: (() => fake()) as any })) });
    const sockets: WebSocket[] = [];
    try {
      const b = `127.0.0.1:${c.server.port}`;
      const ids: string[] = [];
      for (let i = 0; i <= MAX_PTY_SESSIONS; i++) {
        ids.push((await fetch(`http://${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: `pty${i}`, prompt: "p", runner: "claude" }) }).then(j)).id);
      }
      for (const id of ids.slice(0, MAX_PTY_SESSIONS)) sockets.push((await connect(`ws://${b}/ws/pty?task=${id}`)).ws);
      const upgrade = { upgrade: "websocket", connection: "upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
      expect((await fetch(`http://${b}/ws/pty?task=${ids[MAX_PTY_SESSIONS]}`, { headers: upgrade })).status).toBe(429);
      // a second connection to a task that already has its shell does not count against the cap
      sockets.push((await connect(`ws://${b}/ws/pty?task=${ids[0]}`)).ws);
    } finally {
      for (const w of sockets) w.close();
      await c.stop().catch(() => undefined);
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("off loopback, /ws/pty needs the token (the query form is allowed, as for /ws); a foreign Origin is refused", async () => {
    const h = mkdtempSync(join(tmpdir(), "sb-pty-auth-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_HOST: "0.0.0.0" }), [idleAdapter()], { port: 0 });
    try {
      const b = `127.0.0.1:${c.server.port}`;
      const id = (await fetch(`http://${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` }, body: JSON.stringify({ cwd: h, title: "pty", prompt: "p", runner: "claude" }) }).then(j)).id;
      const upgrade = { upgrade: "websocket", connection: "upgrade" };
      expect((await fetch(`http://${b}/ws/pty?task=${id}`, { headers: upgrade })).status).toBe(401);
      expect((await fetch(`http://${b}/ws/pty?task=${id}&token=wrong`, { headers: upgrade })).status).toBe(401);
      expect((await fetch(`http://${b}/ws/pty?task=${id}&token=${c.token}`, { headers: { ...upgrade, origin: "http://evil.example" } })).status).toBe(403);
      const term = await connect(`ws://${b}/ws/pty?task=${id}&token=${c.token}`);
      term.input("echo auth-$((1+1))-ok\n");
      await term.until(/auth-2-ok/);
      term.ws.close();
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("operation log (#1490): opening the shell and creating a task in a danger mode each leave a line with the task id; none on loopback", async () => {
    const h = mkdtempSync(join(tmpdir(), "sb-pty-oplog-"));
    const adapter = { ...idleAdapter(), permissionModes: [{ value: "plan", label: "plan" }, { value: "yolo", label: "yolo", danger: true }] } as RunnerAdapter;
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_HOST: "0.0.0.0" }), [adapter], { port: 0 });
    const spy = spyOn(console, "log");
    try {
      const b = `127.0.0.1:${c.server.port}`;
      const post = (body: object) => fetch(`http://${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${c.token}` }, body: JSON.stringify(body) }).then(j);
      const safe = await post({ cwd: h, title: "a", prompt: "p", runner: "claude", permissionMode: "plan" });
      const risky = await post({ cwd: h, title: "b", prompt: "p", runner: "claude", permissionMode: "yolo" });
      const term = await connect(`ws://${b}/ws/pty?task=${safe.id}&token=${c.token}`);
      term.ws.close();
      const ops = spy.mock.calls.map((x) => String(x[0])).filter((l) => l.includes('"log":"op"')).map((l) => JSON.parse(l) as { op: string; task: string; detail?: unknown });
      expect(ops.map((o) => [o.op, o.task])).toEqual([["task.create.danger", risky.id], ["pty.open", safe.id]]);
      expect(ops[0]!.detail).toEqual({ runner: "claude", mode: "yolo" });
      expect(spy.mock.calls.map((x) => String(x[0])).join("\n")).not.toContain(c.token);
    } finally {
      spy.mockRestore();
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
    const quiet = spyOn(console, "log");
    try {
      await (await fetch(`${base}/api/tasks`)).text();
      await connect(`${wsBase}/ws/pty?task=${taskId}`).then((t) => t.ws.close());
      expect(quiet.mock.calls.map((x) => String(x[0])).filter((l) => l.includes('"log":"op"') || l.includes('"log":"access"'))).toEqual([]);
    } finally {
      quiet.mockRestore();
    }
  });

  test("when no PTY can be opened, health says so and /ws/pty is refused", async () => {
    const h = mkdtempSync(join(tmpdir(), "sb-pty-none-"));
    // what bun-pty does when its native library fails to load: the import succeeds, the first spawn throws
    const broken = () => PtyManager.load(async () => ({ spawn: () => { throw new TypeError("undefined is not an object (evaluating 'lib.symbols')"); } }));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [idleAdapter()], { port: 0, loadPty: broken });
    try {
      const b = `http://127.0.0.1:${c.server.port}`;
      expect((await fetch(`${b}/api/health`).then(j)).features).toEqual({ pty: false });
      const id = (await fetch(`${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "pty", prompt: "p", runner: "claude" }) }).then(j)).id;
      expect((await fetch(`${b}/ws/pty?task=${id}`, { headers: { upgrade: "websocket", connection: "upgrade" } })).status).toBe(404);
    } finally {
      await c.stop();
      rmSync(h, { recursive: true, force: true });
    }
  });
});


/** A PTY whose output the test drives; what is written comes back as output, like a terminal's echo. */
function fakePty() {
  const spawned: { emit: (d: string) => void; exit: () => void }[] = [];
  const spawn = () => {
    const data: ((d: string) => void)[] = [], exits: ((e: { exitCode: number }) => void)[] = [];
    const emit = (d: string) => { for (const f of data) f(d); };
    spawned.push({ emit, exit: () => { for (const f of exits) f({ exitCode: 0 }); } });
    return { pid: 4_194_000 + spawned.length, onData: (f: (d: string) => void) => void data.push(f), onExit: (f: (e: { exitCode: number }) => void) => void exits.push(f), write: emit, resize: () => undefined, kill: () => undefined };
  };
  return { spawned, spawn };
}
async function daemon(run: (b: string, id: string, pty: ReturnType<typeof fakePty>) => Promise<void>) {
  const h = mkdtempSync(join(tmpdir(), "sb-pty-reconnect-"));
  const pty = fakePty();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [idleAdapter()], { port: 0, loadPty: () => PtyManager.load(async () => ({ spawn: pty.spawn as any })) });
  try {
    const b = `127.0.0.1:${c.server.port}`;
    const id = (await fetch(`http://${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "pty", prompt: "p", runner: "claude" }) }).then(j)).id;
    pty.spawned.length = 0; // PtyManager.load spawns one throwaway to check the library
    await run(b, id, pty);
  } finally {
    await c.stop().catch(() => undefined);
    rmSync(h, { recursive: true, force: true });
  }
}
const closedWith = async (term: Awaited<ReturnType<typeof connect>>) => {
  for (let i = 0; i < 200 && !term.closed; i++) await Bun.sleep(10);
  return term.code;
};

describe("reconnect (#1137)", () => {
  test("a socket that comes back with ?shell= gets the same shell: what it missed, then what follows; no second shell", () => daemon(async (b, id, pty) => {
    const a = await connect(`ws://${b}/ws/pty?task=${id}`);
    expect(a.shell).toMatch(/^[0-9a-f-]{36}$/);
    a.input("one");
    await a.until(/one/);
    a.ws.close();
    await closedWith(a);
    pty.spawned[0]!.emit("two");
    const back = await connect(`ws://${b}/ws/pty?task=${id}&shell=${a.shell}`);
    expect(back.shell).toBe(a.shell);
    await back.until(/^onetwo/);
    pty.spawned[0]!.emit("three");
    await back.until(/^onetwothree$/);
    expect(pty.spawned).toHaveLength(1);
    back.ws.close();
  }));

  test("another session's id is refused with 4404 and starts nothing", () => daemon(async (b, id, pty) => {
    const a = await connect(`ws://${b}/ws/pty?task=${id}`);
    const other = await connect(`ws://${b}/ws/pty?task=${id}&shell=other`);
    expect(await closedWith(other)).toBe(4404);
    expect(other.shell).toBeUndefined();
    expect(pty.spawned).toHaveLength(1);
    a.ws.close();
  }));

  test("once the shell has exited, ?shell= is refused with 4404 and no shell is started; without it a new one starts", () => daemon(async (b, id, pty) => {
    const a = await connect(`ws://${b}/ws/pty?task=${id}`);
    pty.spawned[0]!.exit();
    expect(await closedWith(a)).toBe(1000);
    const gone = await connect(`ws://${b}/ws/pty?task=${id}&shell=${a.shell}`);
    expect(await closedWith(gone)).toBe(4404);
    expect(pty.spawned).toHaveLength(1);
    const fresh = await connect(`ws://${b}/ws/pty?task=${id}`);
    expect(pty.spawned).toHaveLength(2);
    expect(fresh.shell).toBeDefined();
    expect(fresh.shell).not.toBe(a.shell);
    fresh.ws.close();
  }));

  test("a gone shell is told 4404 even when the other tasks fill the cap (not 429, which the tab would retry forever)", () => daemon(async (b, id, pty) => {
    const a = await connect(`ws://${b}/ws/pty?task=${id}`);
    pty.spawned[0]!.exit();
    await closedWith(a);
    const others: Awaited<ReturnType<typeof connect>>[] = [];
    for (let i = 0; i < MAX_PTY_SESSIONS; i++) {
      const t = (await fetch(`http://${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: tmpdir(), title: `cap${i}`, prompt: "p", runner: "claude" }) }).then(j)).id;
      others.push(await connect(`ws://${b}/ws/pty?task=${t}`));
    }
    const gone = await connect(`ws://${b}/ws/pty?task=${id}&shell=${a.shell}`);
    expect(await closedWith(gone)).toBe(4404);
    expect(pty.spawned).toHaveLength(MAX_PTY_SESSIONS + 1);
    for (const o of others) o.ws.close();
  }));
});

test("Teleport waits for the explicit action and uses direct argv/cwd with interactive input", async () => {
  const bin = join(home, "fake-teleport");
  writeFileSync(bin, '#!/bin/sh\necho "--teleport [session] Resume a cloud session"\n', { mode: 0o755 });
  let data!: (s: string) => void, exit!: (e: { exitCode: number }) => void;
  const calls: Array<{ bin: string; args: string[]; cwd?: string }> = [], input: string[] = [];
  const fake = { pid: 99999999, onData: (f: typeof data) => { data = f; }, onExit: (f: typeof exit) => { exit = f; }, write: (s: string) => input.push(s), resize: () => {}, kill: () => {} };
  const m = (await PtyManager.load(async () => ({ spawn: ((b: string, a: string[], o: { cwd?: string }) => { calls.push({ ...unwrapEnv(b, a), cwd: o.cwd }); return fake; }) as any })))!;
  calls.length = 0;
  const cloudId = "session_0123456789abcdefghijklmn";
  m.prepareTeleport("cloud");
  let output = "", closed = false; const state: { local: string | null } = { local: null };
  m.attach("cloud", { send: s => { output += s; }, close: () => { closed = true; } });
  expect(calls).toHaveLength(0); expect(m.size).toBe(0);
  const start = m.startTeleport("cloud", repo, bin, cloudId, r => { state.local = r.localSessionId; });
  await expect(m.startTeleport("cloud", repo, bin, cloudId, () => {})).rejects.toThrow("使用中");
  await start;
  expect(calls).toEqual([{ bin, args: ["--teleport", cloudId], cwd: repo }]);
  data("Keep local changes? "); m.write("cloud", "n\r"); expect(input).toEqual(["n\r"]);
  data(`Teleport ${cloudId}\nSession resumed\nResume this session with:\nclaude --resume 11111111-1111-4111-8111-111111111111\n`);
  expect(state.local).toBeNull(); exit({ exitCode: 0 });
  expect(state.local).toBe("11111111-1111-4111-8111-111111111111"); expect(closed).toBe(true); expect(output).toContain("Keep local changes?"); expect(m.size).toBe(0);
});


test("Teleport failure and rejected dirty prompt preserve Git/config and do not restart on reconnect", async () => {
  const dir = join(home, "protected-repo"); mkdirSync(dir);
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).stdout.toString();
  git("init", "-q"); writeFileSync(join(dir, "tracked"), "base"); git("add", "tracked"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-qm", "base");
  writeFileSync(join(dir, "tracked"), "dirty"); writeFileSync(join(dir, "untracked"), "keep");
  const config = readFileSync(join(dir, ".git/config"), "utf8"), status = git("status", "--porcelain"), head = git("rev-parse", "HEAD");
  const bin = join(home, "fake-teleport"); writeFileSync(bin, '#!/bin/sh\necho "--teleport [session] Resume a cloud session"\n', { mode: 0o755 });
  // Run the fake official CLI through the real PTY; wrapper-side Git mutations now affect this repository.
  writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "--teleport [session] Resume"; exit 0; fi\necho "Uncommitted changes. Stash? [y/N]"\nread answer\nprintf "%s" "$answer" > answer\necho "Cancelled"\nexit 1\n', { mode: 0o755 });
  const m = (await PtyManager.load())!; m.prepareTeleport("cloud");
  let output = "", closed = false;
  const client = { send: (s: string) => { output += s; }, close: () => { closed = true; } }; m.attach("cloud", client);
  const result: { local: string | null | undefined } = { local: undefined };
  await m.startTeleport("cloud", dir, bin, "session_0123456789abcdefghijklmn", r => { result.local = r.localSessionId; });
  for (let i = 0; i < 100 && !output.includes("[y/N]"); i++) await Bun.sleep(10);
  expect(output).toContain("[y/N]"); expect(Bun.file(join(dir, "answer")).size).toBe(0);
  const pid = m.pid("cloud"); m.detach("cloud", client); m.attach("cloud", client); expect(m.pid("cloud")).toBe(pid);
  m.write("cloud", "n\r");
  for (let i = 0; i < 100 && !closed; i++) await Bun.sleep(10);
  expect(closed).toBe(true); expect(result.local).toBeNull();
  expect(readFileSync(join(dir, "answer"), "utf8")).toBe("n"); rmSync(join(dir, "answer"));
  expect(git("status", "--porcelain")).toBe(status); expect(git("rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(dir, "tracked"), "utf8")).toBe("dirty"); expect(readFileSync(join(dir, "untracked"), "utf8")).toBe("keep"); expect(readFileSync(join(dir, ".git/config"), "utf8")).toBe(config);
});


test("Cloud socket starts no process until explicit request and uses saved ID/cwd", async () => {
  const h = mkdtempSync(join(tmpdir(), "sb-teleport-route-"));
  const bin = join(h, "claude-fake"); writeFileSync(bin, '#!/bin/sh\necho "--teleport [session] Resume a cloud session"\n', { mode: 0o755 });
  const id = "session_0123456789abcdefghijklmn";
  gitClone(h);
  const calls: Array<{ bin: string; args: string[]; cwd?: string }> = [];
  let exit!: (e: { exitCode: number }) => void;
  const fake = { pid: 99999999, onData: () => {}, onExit: (f: typeof exit) => { exit = f; }, write: () => {}, resize: () => {}, kill: () => {} };
  const manager = (await PtyManager.load(async () => ({ spawn: ((b: string, a: string[], o: { cwd?: string }) => { calls.push({ ...unwrapEnv(b, a), cwd: o.cwd }); return fake; }) as any })))!; calls.length = 0;
  const adapter: RunnerAdapter = { ...idleAdapter(), detect: async () => ({ available: true, path: bin }), start: (_o, emit) => { emit({ t: "cloud.session.created", id, url: `https://claude.ai/code/${id}` }); return { exited: Promise.resolve(0), send: () => {}, respondPermission: () => {}, abort: async () => {}, close: async () => {} }; } };
  const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, ...NO_HISTORY }), [adapter], { port: 0, loadPty: async () => manager });
  try {
    const base = `http://127.0.0.1:${c.server.port}`, sockets = `ws://127.0.0.1:${c.server.port}`;
    const task = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runner: "claude", cwd: h, title: "Teleport", prompt: "Cloud", executionMode: "cloud" }) }).then(j);
    await Bun.sleep(30); expect(calls).toHaveLength(0);
    const term = await connect(`${sockets}/ws/pty?task=${task.id}&teleport=1`); expect(calls).toHaveLength(0);
    // the saved ID and cwd are used whatever the body says
    const first = await fetch(`${base}/api/tasks/${task.id}/teleport`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cloudId: "forged", cwd: "/elsewhere" }) });
    expect(first.status).toBe(202);
    for (let i = 0; i < 100 && calls.length === 0; i++) await Bun.sleep(10);
    expect(calls).toEqual([{ bin, args: ["--teleport", id], cwd: workCopy(h, task.id) }]);
    const second = await fetch(`${base}/api/tasks/${task.id}/teleport`, { method: "POST" });
    expect(second.status).toBe(409); expect((await j(second)).error).toContain("使用中"); expect(calls).toHaveLength(1);
    exit({ exitCode: 1 }); term.ws.close();
  } finally { await c.stop(); rmSync(h, { recursive: true, force: true }); }
});


/** A Cloud Task and Local Tasks in `h` / `other` under a daemon whose Local runner closes only when `letExit()` is called. */
async function teleportBusyFixture(env: Record<string, string>, run: (f: {
  base: string; sockets: string; h: string; other: string; bin: string; id: string; calls: Array<{ bin: string; args: string[]; cwd?: string }>;
  finish: Map<string, () => void>; closed: string[]; letExit: () => void; create: (body: object) => Promise<any>;
}) => Promise<void>) {
  const h = mkdtempSync(join(tmpdir(), "sb-teleport-busy-")), other = mkdtempSync(join(tmpdir(), "sb-teleport-other-"));
  const bin = join(h, "claude-fake"); writeFileSync(bin, '#!/bin/sh\necho "--teleport [session] Resume a cloud session"\n', { mode: 0o755 });
  const id = "session_0123456789abcdefghijklmn";
  const calls: Array<{ bin: string; args: string[]; cwd?: string }> = [];
  const fake = { pid: 99999999, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} };
  const manager = (await PtyManager.load(async () => ({ spawn: ((b: string, a: string[], o: { cwd?: string }) => { calls.push({ ...unwrapEnv(b, a), cwd: o.cwd }); return fake; }) as any })))!; calls.length = 0;
  const finish = new Map<string, () => void>(), closed: string[] = [];
  let letExit!: () => void; const exitGate = new Promise<void>(r => (letExit = r));
  const adapter: RunnerAdapter = { ...idleAdapter(), detect: async () => ({ available: true, path: bin }), start: (o, emit) => {
    if (o.executionMode === "cloud") { emit({ t: "cloud.session.created", id, url: `https://claude.ai/code/${id}` }); return { exited: Promise.resolve(0), send: () => {}, respondPermission: () => {}, abort: async () => {}, close: async () => {} }; }
    let done!: (c: number | null) => void; const exited = new Promise<number | null>(r => (done = r));
    queueMicrotask(() => emit({ t: "session.start", runner: "claude", runnerSessionId: `s-${o.prompt}`, cwd: o.cwd }));
    finish.set(o.prompt, () => emit({ t: "session.end", status: "ok" }));
    return { exited, send: () => {}, respondPermission: () => {}, abort: async () => done(null), close: async () => { closed.push(o.prompt); await exitGate; done(0); } };
  } };
  const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, ...NO_HISTORY, ...env }), [adapter], { port: 0, loadPty: async () => manager });
  try {
    const base = `http://127.0.0.1:${c.server.port}`;
    const create = (body: object) => fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runner: "claude", ...body }) }).then(j);
    await run({ base, sockets: `ws://127.0.0.1:${c.server.port}`, h, other, bin, id, calls, finish, closed, letExit, create });
  } finally { letExit(); await c.stop(); rmSync(h, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
}

/** A git clone with one commit: Teleport continues in a worktree of it (#1395). */
function gitClone(dir: string) {
  const g = (...a: string[]) => { const p = Bun.spawnSync(["git", ...a], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }); if (p.exitCode !== 0) throw new Error(p.stderr.toString()); return p.stdout.toString().trim(); };
  g("init", "-q"); writeFileSync(join(dir, "tracked"), "one"); g("add", "tracked"); g("commit", "-qm", "init");
  return g;
}
const workCopy = (h: string, cloudId: string) => join(realpathSync(h), ".claude", "worktrees", `teleport-${cloudId}`);

test("a Local Task at work in the clone does not block Teleport: it continues in a worktree and leaves the clone alone", () => teleportBusyFixture({}, async ({ base, h, other, bin, id, calls, finish, closed, letExit, create }) => {
  const g = gitClone(h);
  const cloud = await create({ cwd: h, title: "Teleport", prompt: "cloud", executionMode: "cloud" });
  const local = await create({ cwd: h, title: "同じ場所の作業", prompt: "same" });
  await create({ cwd: other, title: "別の場所", prompt: "other" });
  for (let i = 0; i < 100 && finish.size < 2; i++) await Bun.sleep(10);
  const snapshot = () => [g("rev-parse", "HEAD"), g("symbolic-ref", "HEAD"), g("for-each-ref"), g("status", "--porcelain"), g("diff", "--cached"), readFileSync(join(h, "tracked"), "utf8")].join("\n");
  writeFileSync(join(h, "tracked"), "dirty by the Local Task"); writeFileSync(join(h, "scratch"), "untracked");
  const before = snapshot();
  const post = () => fetch(`${base}/api/tasks/${cloud.id}/teleport`, { method: "POST" });
  expect((await post()).status).toBe(202);
  const wc = workCopy(h, cloud.id);
  for (let i = 0; i < 100 && calls.length === 0; i++) await Bun.sleep(10);
  expect(calls).toEqual([{ bin, args: ["--teleport", id], cwd: wc }]);
  expect(closed).toEqual([]); // the busy Local Task keeps its process
  expect(snapshot()).toBe(before);
  expect(readFileSync(join(wc, "tracked"), "utf8")).toBe("one"); // a clean checkout of HEAD, not the dirty file
  expect(g("worktree", "list")).toContain(`teleport-${cloud.id}`);
  expect(readFileSync(join(h, ".git", "info", "exclude"), "utf8").split("\n").filter(l => l === "/.claude/worktrees/")).toHaveLength(1);
  expect(g("status", "--porcelain")).not.toContain(".claude");
  // the Local Task in the clone can still be replied to
  const reply = await fetch(`${base}/api/tasks/${local.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "more" }) });
  expect(reply.ok).toBe(true);
  expect((await j(await fetch(`${base}/api/tasks/${cloud.id}`))).task.id).toBe(cloud.id);
  letExit();
}));

test("preparing the worktree again reuses it without touching its changes", () => {
  const h = mkdtempSync(join(tmpdir(), "sb-teleport-prep-"));
  try {
    gitClone(h);
    const first = prepareTeleportWorktree(h, "cloud-1");
    expect(first).toBe(workCopy(h, "cloud-1"));
    writeFileSync(join(first, "tracked"), "edited in the worktree"); writeFileSync(join(first, "new"), "untracked");
    expect(prepareTeleportWorktree(h, "cloud-1")).toBe(first);
    expect(readFileSync(join(first, "tracked"), "utf8")).toBe("edited in the worktree"); expect(readFileSync(join(first, "new"), "utf8")).toBe("untracked");
    expect(readFileSync(join(h, ".git", "info", "exclude"), "utf8").split("\n").filter(l => l === "/.claude/worktrees/")).toHaveLength(1);
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("a link into the clone at the work-copy place is not a worktree; a Workspace below the repo root is refused", () => {
  const h = mkdtempSync(join(tmpdir(), "sb-teleport-link-"));
  try {
    gitClone(h); mkdirSync(join(h, "app"));
    const wc = workCopy(h, "cloud-2"); mkdirSync(join(h, ".claude", "worktrees"), { recursive: true });
    symlinkSync(realpathSync(h), wc);
    expect(() => prepareTeleportWorktree(h, "cloud-2")).toThrow("別のものがあります");
    expect(() => prepareTeleportWorktree(join(h, "app"), "cloud-3")).toThrow("ルート");
  } finally { rmSync(h, { recursive: true, force: true }); }
});

test("a directory that is not a worktree at the work-copy place stops Teleport and is left as it is", () => teleportBusyFixture({}, async ({ base, h, calls, create }) => {
  gitClone(h);
  const cloud = await create({ cwd: h, title: "Teleport", prompt: "cloud", executionMode: "cloud" });
  const wc = workCopy(h, cloud.id); mkdirSync(wc, { recursive: true }); writeFileSync(join(wc, "mine"), "keep");
  const r = await fetch(`${base}/api/tasks/${cloud.id}/teleport`, { method: "POST" });
  expect(r.status).toBe(409); expect((await j(r)).error).toContain("別のものがあります");
  expect(readFileSync(join(wc, "mine"), "utf8")).toBe("keep"); expect(calls).toHaveLength(0);
}));

test("a Local Task at work in the continuation worktree blocks a second Teleport; an idling one there is closed first", () => teleportBusyFixture({}, async ({ base, h, bin, id, calls, finish, closed, letExit, create }) => {
  const g = gitClone(h);
  const cloud = await create({ cwd: h, title: "Teleport", prompt: "cloud", executionMode: "cloud" });
  const wc = workCopy(h, cloud.id);
  g("worktree", "add", "--detach", wc, "HEAD");
  const local = await create({ cwd: wc, title: "続きの作業", prompt: "same" });
  for (let i = 0; i < 100 && finish.size < 1; i++) await Bun.sleep(10);
  const post = () => fetch(`${base}/api/tasks/${cloud.id}/teleport`, { method: "POST" });
  const refused = await post();
  expect(refused.status).toBe(409); expect((await j(refused)).error).toContain("この Cloud Task の続きの Local Task「続きの作業」が作業中です。終わってから押してください"); expect(calls).toHaveLength(0);
  finish.get("same")!();
  for (let i = 0; i < 100 && (await fetch(`${base}/api/tasks/${local.id}`).then(j)).task.status === "running"; i++) await Bun.sleep(10);
  expect((await post()).status).toBe(202);
  for (let i = 0; i < 100 && closed.length === 0; i++) await Bun.sleep(10);
  expect(closed).toEqual(["same"]);
  await Bun.sleep(50); expect(calls).toHaveLength(0); // the idling process has not exited yet
  const reply = await fetch(`${base}/api/tasks/${local.id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "more" }) });
  expect(reply.ok).toBe(false); expect(await reply.text()).toContain("Teleport Terminalが使用中");
  letExit();
  for (let i = 0; i < 100 && calls.length === 0; i++) await Bun.sleep(10);
  expect(calls).toEqual([{ bin, args: ["--teleport", id], cwd: wc }]);
}));

test("an archived Local Task idling in the continuation worktree is closed before Teleport too (#1164)", () => teleportBusyFixture({}, async ({ base, h, bin, id, calls, finish, closed, letExit, create }) => {
  const g = gitClone(h);
  const cloud = await create({ cwd: h, title: "Teleport", prompt: "cloud", executionMode: "cloud" });
  const wc = workCopy(h, cloud.id);
  g("worktree", "add", "--detach", wc, "HEAD");
  const local = await create({ cwd: wc, title: "続きの作業", prompt: "same" });
  for (let i = 0; i < 100 && finish.size < 1; i++) await Bun.sleep(10);
  finish.get("same")!();
  for (let i = 0; i < 100 && (await fetch(`${base}/api/tasks/${local.id}`).then(j)).task.status === "running"; i++) await Bun.sleep(10);
  const archived = await fetch(`${base}/api/tasks/${local.id}/archive`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
  expect(archived.status).toBe(200);
  expect((await fetch(`${base}/api/tasks/${cloud.id}/teleport`, { method: "POST" })).status).toBe(202);
  for (let i = 0; i < 100 && closed.length === 0; i++) await Bun.sleep(10);
  expect(closed).toEqual(["same"]);
  letExit();
  for (let i = 0; i < 100 && calls.length === 0; i++) await Bun.sleep(10);
  expect(calls).toEqual([{ bin, args: ["--teleport", id], cwd: wc }]);
}));

test("Teleport waits for a Local process in the worktree the idle timer is still closing", () => teleportBusyFixture({ SWITCHBOARD_RUNNER_IDLE_MS: "20" }, async ({ base, h, bin, id, calls, finish, closed, letExit, create }) => {
  const g = gitClone(h);
  const cloud = await create({ cwd: h, title: "Teleport", prompt: "cloud", executionMode: "cloud" });
  const wc = workCopy(h, cloud.id);
  g("worktree", "add", "--detach", wc, "HEAD");
  await create({ cwd: wc, title: "続きの作業", prompt: "same" });
  for (let i = 0; i < 100 && !finish.has("same"); i++) await Bun.sleep(10);
  finish.get("same")!();
  for (let i = 0; i < 100 && closed.length === 0; i++) await Bun.sleep(10);
  expect(closed).toEqual(["same"]); // released by the idle timer, its close still in flight
  expect((await fetch(`${base}/api/tasks/${cloud.id}/teleport`, { method: "POST" })).status).toBe(202);
  await Bun.sleep(50); expect(calls).toHaveLength(0);
  letExit();
  for (let i = 0; i < 100 && calls.length === 0; i++) await Bun.sleep(10);
  expect(calls).toEqual([{ bin, args: ["--teleport", id], cwd: wc }]);
}));

test("unused Teleport reservation releases normal Terminal and remembers fitted size", async () => {
  const calls: any[] = [];
  const fake = { pid: 99999999, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} };
  const m = (await PtyManager.load(async () => ({ spawn: ((...args: any[]) => { calls.push(args); return fake; }) as any })))!; calls.length = 0;
  const client = { send: () => {}, close: () => {} };
  m.prepareTeleport("unused"); m.attach("unused", client); m.detach("unused", client);
  m.open("unused", repo, "/bin/sh"); expect(calls[0][1]).toEqual(["-i"]);
  m.prepareTeleport("sized"); m.attach("sized", client); m.resize("sized", 132, 40);
  const bin = join(home, "size-help"); writeFileSync(bin, '#!/bin/sh\necho "--teleport [id] Resume"\n', { mode: 0o755 });
  await m.startTeleport("sized", repo, bin, "session_0123456789abcdefghijklmn", () => {});
  expect(calls[1][2]).toMatchObject({ cols: 132, rows: 40 });
});


test("failed Teleport help after disconnect releases its reservation", async () => {
  const calls: any[] = [];
  const fake = { pid: 99999999, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} };
  const m = (await PtyManager.load(async () => ({ spawn: ((...a: any[]) => { calls.push(a); return fake; }) as any })))!; calls.length = 0;
  const bin = join(home, "late-help-failure"); writeFileSync(bin, '#!/bin/sh\nsleep 0.05\nexit 1\n', { mode: 0o755 });
  const client = { send: () => {}, close: () => {} }; m.prepareTeleport("late"); m.attach("late", client);
  const start = m.startTeleport("late", repo, bin, "session_0123456789abcdefghijklmn", () => {});
  m.detach("late", client); await expect(start).rejects.toThrow();
  m.open("late", repo, "/bin/sh"); expect(calls[0][1]).toEqual(["-i"]);
});


test("official CLI failure guidance reaches Terminal without changing Git or auth settings", async () => {
  const dir = join(home, "auth-failure-repo"); mkdirSync(dir);
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir }).stdout.toString();
  git("init", "-q"); writeFileSync(join(dir, "tracked"), "dirty"); writeFileSync(join(dir, "auth-settings-fixture"), "fixture");
  const status = git("status", "--porcelain"), config = readFileSync(join(dir, ".git/config"), "utf8");
  const cases = [["requires a Claude.ai subscription", "サブスクリプション"], ["Bedrock provider unsupported", "サブスクリプション"], ["account mismatch", "アカウント"], ["repository mismatch", "リポジトリ"], ["branch not pushed", "push済み"], ["permission denied", "アクセス"]];
  const m = (await PtyManager.load())!;
  for (const [error, guidance] of cases) {
    const bin = join(dir, "fake-cli"); writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "--teleport [session] Resume"; exit 0; fi\necho "${error}"\nexit 1\n`, { mode: 0o755 });
    const baseline = git("status", "--porcelain"); let output = "", closed = false;
    m.prepareTeleport("failed"); m.attach("failed", { send: s => { output += s; }, close: () => { closed = true; } });
    let local: string | null | undefined;
    await m.startTeleport("failed", dir, bin, "session_0123456789abcdefghijklmn", r => { local = r.localSessionId; });
    for (let i = 0; i < 100 && !closed; i++) await Bun.sleep(10);
    expect(closed).toBe(true); expect(local).toBeNull(); expect(output).toContain(guidance!);
    expect(git("status", "--porcelain")).toBe(baseline); expect(readFileSync(join(dir, ".git/config"), "utf8")).toBe(config);
    expect(readFileSync(join(dir, "auth-settings-fixture"), "utf8")).toBe("fixture"); expect(readFileSync(join(dir, "tracked"), "utf8")).toBe("dirty");
    rmSync(bin);
  }
  expect(git("status", "--porcelain")).toBe(status);
});


test("Teleport waits for async import and sends its result to reconnected clients before closing", async () => {
  let exit!: (e: { exitCode: number }) => void;
  const fake = { pid: 99999999, onData: () => {}, onExit: (f: typeof exit) => { exit = f; }, write: () => {}, resize: () => {}, kill: () => {} };
  const m = (await PtyManager.load(async () => ({ spawn: (() => fake) as any })))!;
  const bin = join(home, "async-import-help"); writeFileSync(bin, '#!/bin/sh\necho "--teleport [session] Resume"\n', { mode: 0o755 });
  let finish!: () => void, output = "", closed = false;
  const first = { send: () => {}, close: () => {} }, second = { send: (s: string) => { output += s; }, close: () => { closed = true; } };
  m.prepareTeleport("async"); m.attach("async", first);
  await m.startTeleport("async", repo, bin, "session_0123456789abcdefghijklmn", async result => {
    await new Promise<void>(r => { finish = r; }); result.message = "Local履歴は未確認です。";
  });
  exit({ exitCode: 0 }); expect(closed).toBe(false); expect(m.size).toBe(1);
  m.detach("async", first); m.attach("async", second); finish();
  for (let i = 0; i < 100 && !closed; i++) await Bun.sleep(10);
  expect(closed).toBe(true); expect(output).toContain("Local履歴は未確認"); expect(m.size).toBe(0);
});

test("Teleport cleanup never touches an exited PTY and survives rejected callbacks and clients", async () => {
  let exit!: (e: { exitCode: number }) => void, touched = 0;
  const fake = { pid: 99999999, onData: () => {}, onExit: (f: typeof exit) => { exit = f; }, write: () => { touched++; }, resize: () => { touched++; }, kill: () => { touched++; } };
  const m = (await PtyManager.load(async () => ({ spawn: (() => fake) as any })))!; touched = 0;
  const bin = join(home, "reject-import-help"); writeFileSync(bin, '#!/bin/sh\necho "--teleport [session] Resume"\n', { mode: 0o755 });
  let finish!: () => void, closed = 0, output = "";
  m.prepareTeleport("hung"); m.attach("hung", { send: () => {}, close: () => { closed++; } });
  await m.startTeleport("hung", repo, bin, "session_0123456789abcdefghijklmn", () => new Promise<void>(r => { finish = r; }));
  exit({ exitCode: 0 }); expect(m.pid("hung")).toBeUndefined();
  m.write("hung", "ignored"); m.resize("hung", 90, 30); m.closeAll();
  expect(touched).toBe(0); expect(m.size).toBe(0); expect(closed).toBe(1);
  m.prepareTeleport("hung"); finish(); await Bun.sleep(10);
  await m.startTeleport("hung", repo, bin, "session_0123456789abcdefghijklmn", () => {});
  expect(m.size).toBe(1); // Completion of an old import cannot delete a new reservation.
  exit({ exitCode: 0 });
  m.closeAll();
  for (const throwing of [false, true]) {
    output = ""; const beforeClosed = closed;
    m.prepareTeleport("reject");
    m.attach("reject", { send: () => { throw new Error("closed client"); }, close: () => { throw new Error("closed client"); } });
    m.attach("reject", { send: s => { output += s; }, close: () => { closed++; } });
    await m.startTeleport("reject", repo, bin, "session_0123456789abcdefghijklmn", () => { if (throwing) throw new Error("fixture"); return Promise.reject(new Error("fixture")); });
    exit({ exitCode: 0 }); await Bun.sleep(10);
    expect(m.size).toBe(0); expect(output).toContain("Local取込み結果は未確認"); expect(closed).toBe(beforeClosed + 1);
  }
});

test("Teleport does not hand the daemon's own Claude Code session markers to the CLI", async () => {
  // bun-pty adds the given env to the process's real environment, so the marker must be in that environment:
  // run the manager in a child process started with it, as a daemon launched from inside Claude Code would be.
  const dir = mkdtempSync(join(tmpdir(), "sb-teleport-env-"));
  const bin = join(dir, "fake-claude"); writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--help" ]; then echo "--teleport [session] Resume"; exit 0; fi\necho "MARK=${CLAUDE_CODE_CHILD_SESSION:-unset} SID=${CLAUDE_CODE_SESSION_ID:-unset} KEEP=${KEEP_ME:-unset}"\n', { mode: 0o755 });
  const script = join(dir, "run.ts");
  writeFileSync(script, `import { PtyManager } from ${JSON.stringify(join(import.meta.dir, "pty.ts"))};
const m = (await PtyManager.load())!; m.prepareTeleport("t"); let out = "";
m.attach("t", { send: s => { out += s; }, close: () => { console.log(out.trim()); process.exit(0); } });
await m.startTeleport("t", ${JSON.stringify(dir)}, ${JSON.stringify(bin)}, "session_0123456789abcdefghijklmn", () => {});`);
  try {
    const p = Bun.spawnSync([process.execPath, script], { env: { ...process.env, CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_SESSION_ID: "parent", KEEP_ME: "yes" } });
    expect(p.stdout.toString()).toContain("MARK=unset SID=unset KEEP=yes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

describe("Teleport without the terminal (#1347)", () => {
  const cloudId = "session_0123456789abcdefghijklmn", UUID = "22222222-2222-4222-8222-222222222222";
  const FAST = { exitQuietMs: 50, questionQuietMs: 150, exitWaitMs: 300 };
  /** A fake official CLI run through the real PTY. `body` is the shell after the --help branch; stdin is recorded in ./input. */
  async function run(body: string, finish: (f: { m: PtyManager; dir: string; phases: Array<{ phase: string; question?: string }>; result: { local: string | null | undefined }; closed: () => boolean }) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), "sb-teleport-exit-"));
    try {
      const bin = join(dir, "claude-fake");
      writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "--teleport [session] Resume"; exit 0; fi\n${body}\n`, { mode: 0o755 });
      const m = (await PtyManager.load(undefined, FAST))!; m.prepareTeleport("cloud");
      let closed = false; m.attach("cloud", { send: () => {}, close: () => { closed = true; } });
      const phases: Array<{ phase: string; question?: string }> = [], result: { local: string | null | undefined } = { local: undefined };
      await m.startTeleport("cloud", dir, bin, cloudId, r => { result.local = r.localSessionId; }, p => phases.push(p));
      try { await finish({ m, dir, phases, result, closed: () => closed }); } finally { m.closeAll(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const until = async (f: () => boolean, ms = 5000) => { for (let t = Date.now(); !f() && Date.now() - t < ms;) await Bun.sleep(10); };

  // Like the official CLI (#1865): the resumed conversation is logged only once the session records an entry, and the
  // evidence prints only when that log exists. `/rename` is the recorded entry; `/exit` alone prints nothing.
  const cli = `echo "Teleport ${cloudId}"; echo "Session resumed"; named=; while IFS= read -r line; do printf '%s\\n' "$line" >> input;
case "$line" in "/rename "*) named=1; echo "Session renamed to: \${line#/rename }";; "/exit") [ -n "$named" ] && echo "claude --resume ${UUID}"; exit 0;; esac; done`;

  test("with no question it names the session, then writes /exit once, and reads the evidence, with no input from the user", () => run(
    cli,
    async ({ dir, phases, result, closed }) => {
      await until(closed);
      expect(result.local).toBe(UUID);
      expect(readFileSync(join(dir, "input"), "utf8")).toBe(`/rename ${TELEPORT_SESSION_NAME}\n/exit\n`);
      expect(phases.map(p => p.phase)).toEqual(["teleporting", "exiting"]);
    }));

  test("a CLI that does not confirm the name gets no /exit and the person is asked", () => run(
    `echo "Teleport ${cloudId}"; echo "Session resumed"; IFS= read -r line; printf '%s\\n' "$line" >> input; sleep 30`,
    async ({ dir, phases }) => {
      await until(() => phases.some(p => p.phase === "needs-input"));
      expect(phases.map(p => p.phase)).toEqual(["teleporting", "exiting", "needs-input"]);
      await Bun.sleep(3 * FAST.exitWaitMs);
      expect(readFileSync(join(dir, "input"), "utf8")).toBe(`/rename ${TELEPORT_SESSION_NAME}\n`); // no /exit without the confirmation
    }));

  test("a question before resumed is shown and nothing is written to the CLI", () => run(
    `echo "Fixture approval: type y or n"; IFS= read -r line; printf '%s' "$line" > input; exit 1`,
    async ({ m, dir, phases }) => {
      await until(() => phases.some(p => p.phase === "needs-input"));
      expect(phases.map(p => p.phase)).toEqual(["teleporting", "needs-input"]);
      expect(phases[1]!.question).toContain("Fixture approval: type y or n");
      await Bun.sleep(3 * FAST.questionQuietMs);
      expect(Bun.file(join(dir, "input")).size).toBe(0); // nothing was typed; the file is only created once a line arrives
      m.write("cloud", "n\r");
      await until(() => Bun.file(join(dir, "input")).size > 0);
      expect(readFileSync(join(dir, "input"), "utf8")).toBe("n");
    }));

  test("a name confirmed only after the person was asked gets no /exit", () => run(
    `echo "Teleport ${cloudId}"; echo "Session resumed"; IFS= read -r line; printf '%s\\n' "$line" >> input; sleep 0.6; echo "Session renamed to: x"; IFS= read -r line; printf '%s\\n' "$line" >> input; sleep 30`,
    async ({ dir, phases }) => {
      await until(() => phases.some(p => p.phase === "needs-input"));
      await Bun.sleep(3 * FAST.exitWaitMs);
      expect(readFileSync(join(dir, "input"), "utf8")).toBe(`/rename ${TELEPORT_SESSION_NAME}\n`);
      expect(phases.map(p => p.phase)).toEqual(["teleporting", "exiting", "needs-input"]);
    }));

  test("the marker without a trailing newline is enough, and an /exit the CLI ignores is not repeated", () => run(
    `printf 'Teleport ${cloudId}\\nSession resumed'; IFS= read -r line; printf '%s\\n' "$line" >> input; echo "Session renamed to: x"; IFS= read -r line; printf '%s\\n' "$line" >> input; sleep 30`,
    async ({ phases, dir }) => {
      await until(() => phases.some(p => p.phase === "needs-input"));
      expect(phases.map(p => p.phase)).toEqual(["teleporting", "exiting", "needs-input"]);
      await Bun.sleep(3 * FAST.exitWaitMs);
      expect(readFileSync(join(dir, "input"), "utf8")).toBe(`/rename ${TELEPORT_SESSION_NAME}\n/exit\n`); // once; no second /exit and no further Enter
      expect(phases).toHaveLength(3);
    }));

  test("resumed with another target gets nothing typed", () => run(
    `echo "Teleport session_other0123456789abcdefg"; echo "Session resumed"; IFS= read -r line; printf '%s' "$line" > input; exit 1`,
    async ({ phases, dir }) => {
      await until(() => phases.some(p => p.phase === "needs-input"));
      expect(phases.map(p => p.phase)).toEqual(["teleporting", "needs-input"]);
      await Bun.sleep(3 * FAST.exitQuietMs);
      expect(Bun.file(join(dir, "input")).size).toBe(0);
    }));
});

describe("Claude Code's status in the terminal (#1574)", () => {
  // The sequences Claude Code 2.1.311 printed in a PTY for one prompt that needed a permission, then /exit, each in the
  // chunk it came in (the recording keeps them with what surrounded them).
  const ESC = "\x1b", BEL = "\x07";
  const CHUNKS = [
    `${ESC}[?u${ESC}]7501;?${BEL}${ESC}[c`,
    `${ESC}]7501;state=idle:app=claude-code${BEL}${ESC}]0;Claude Code${BEL}`,
    `${ESC}]7501;state=working:app=claude-code${BEL}`,
    `${ESC}]7501;state=blocked:app=claude-code:kind=permission:msg=YXBwcm92ZQ==${BEL}${ESC}]0;title${BEL}`,
    `${ESC}]7501;state=working:app=claude-code${BEL}`,
    `${ESC}]7501;state=done:app=claude-code${BEL}${ESC}[?25l${ESC}[H done`,
    `${ESC}]7501;state=working:app=claude-code${BEL}`,
    `${ESC}[?25h${ESC}7${ESC}[r${ESC}8${ESC}]7501;state=clear${BEL}${ESC}[?25h${ESC}]7501;state=clear${BEL}`,
    `${ESC}[?1004l${ESC}]7501;state=clear${BEL}${ESC}]0;${BEL}`,
  ];
  const EXPECTED = ["done", "working", "waiting", "working", "done", "working", null, null, null];
  const RECORDING = "packages/core/fixtures/osc7501-claude.jsonl";
  const read = (pieces: string[]) => {
    const r = new OscStatusReader();
    const statuses: unknown[] = []; let queries = 0;
    for (const p of pieces) { const o = r.push(p); statuses.push(...o.statuses); if (o.query) queries++; }
    return { statuses, queries };
  };
  const bytes = (chunks: string[]) => [...chunks.join("")];

  test("OscStatusReader: the recorded sequences yield done → working → waiting → working → done → working → ended, chunk by chunk and one byte at a time", () => {
    expect(read(CHUNKS)).toEqual({ statuses: EXPECTED, queries: 1 });
    expect(read(bytes(CHUNKS))).toEqual({ statuses: EXPECTED, queries: 1 });
    expect(read([CHUNKS.join("")])).toEqual({ statuses: EXPECTED, queries: 1 });
  });

  test.skipIf(skipRecordings(RECORDING))("OscStatusReader: the recording (fixtures/osc7501-claude.jsonl) replays the same, chunk by chunk and one byte at a time", () => {
    assertRecordings(RECORDING);
    const chunks = recordingText(RECORDING).split("\n").filter(Boolean).map(l => JSON.parse(l) as string);
    expect(read(chunks)).toEqual({ statuses: EXPECTED, queries: 1 });
    expect(read(bytes(chunks))).toEqual({ statuses: EXPECTED, queries: 1 });
  });

  test("OscStatusReader: ST ends a sequence too; another program's status, other OSCs and an over-long unfinished sequence are not read", () => {
    expect(read([`${ESC}]7501;state=blocked:app=claude-code${ESC}`, "\\"]).statuses).toEqual(["waiting"]);
    expect(read([`${ESC}]7501;state=working:app=other${BEL}`, `${ESC}]0;state=working:app=claude-code${BEL}`]).statuses).toEqual([]);
    expect(read([`${ESC}]7501;state=working:app=claude-code:msg=${"A".repeat(300)}`, BEL]).statuses).toEqual([]);
    // an unfinished one cut off by another sequence is dropped, and what follows is read
    expect(read([`${ESC}]7501;state=working`, `${ESC}[c${ESC}]7501;state=done:app=claude-code${BEL}`]).statuses).toEqual(["done"]);
    // … and the start of the next one at the end of the chunk is kept, as when the chunks are joined
    expect(read([`${ESC}]7501;state=working`, `${ESC}]750`, `1;state=blocked:app=claude-code${BEL}`]).statuses).toEqual(["waiting"]);
  });

  test("open: the question is answered, onStatus fires on a change only, and null on exit", async () => {
    const pty = fakePty();
    const written: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (await PtyManager.load(async () => ({ spawn: ((...a: unknown[]) => { const p = (pty.spawn as any)(...a); return { ...p, write: (d: string) => void written.push(d) }; }) as any })))!;
    pty.spawned.length = 0;
    const seen: unknown[] = [];
    m.open("t", "/", "/bin/sh", s => seen.push(s));
    const client: string[] = [];
    m.attach("t", { send: d => void client.push(d), close: () => undefined });
    for (const c of CHUNKS.slice(0, 3)) pty.spawned[0]!.emit(c);
    pty.spawned[0]!.emit(CHUNKS[2]!); // the same state again
    expect(written).toEqual([PTY_STATUS_REPLY]);
    expect(seen).toEqual(["done", "working"]);
    expect(client.join("")).toBe(CHUNKS.slice(0, 3).join("") + CHUNKS[2]); // the output is passed on unchanged
    pty.spawned[0]!.emit(CHUNKS[3]!);
    pty.spawned[0]!.exit();
    expect(seen).toEqual(["done", "working", "waiting", null]);
  });

  test("a real shell: its status is read, and ending the Task (which closes the shell) clears it", async () => {
    const h = mkdtempSync(join(tmpdir(), "sb-pty-status-"));
    const c = await startServer(loadConfig({ SWITCHBOARD_HOME: h, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [idleAdapter()], { port: 0 });
    try {
      const b = `127.0.0.1:${c.server.port}`;
      const id = (await fetch(`http://${b}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: h, title: "pty", prompt: "p", runner: "claude" }) }).then(j)).id;
      const ws = new WebSocket(`ws://${b}/ws`);
      const got: unknown[] = [];
      ws.onmessage = e => { const m = JSON.parse(String(e.data)); if (m.type === "task.terminal") got.push(m.status); };
      await new Promise<void>(r => (ws.onopen = () => r()));
      const term = await connect(`ws://${b}/ws/pty?task=${id}`);
      term.input("printf '\\033]7501;state=working:app=claude-code\\007'\n");
      for (let i = 0; i < 300 && got.length < 1; i++) await Bun.sleep(10);
      expect(got).toEqual(["working"]);
      await fetch(`http://${b}/api/tasks/${id}/abort`, { method: "POST" });
      for (let i = 0; i < 300 && got.length < 2; i++) await Bun.sleep(10);
      expect(got).toEqual(["working", null]);
      ws.close();
    } finally {
      await c.stop().catch(() => undefined);
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("/ws: task.terminal is broadcast on a change; a new client gets them all in task.terminals after hello; the shell's exit clears it", () => daemon(async (b, id, pty) => {
    const listen = async () => {
      const ws = new WebSocket(`ws://${b}/ws`);
      const got: { type: string; version?: string; taskId?: string; status?: unknown; terminals?: unknown }[] = [];
      ws.onmessage = e => void got.push(JSON.parse(String(e.data)));
      await new Promise<void>(r => (ws.onopen = () => r()));
      await until(() => got.length >= 2);
      return { ws, got, changes: () => got.filter(m => m.type === "task.terminal").map(m => [m.taskId, m.status]) };
    };
    const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await Bun.sleep(10); expect(f()).toBe(true); };
    const first = await listen();
    expect(first.got.slice(0, 2)).toEqual([{ type: "hello", version: expect.any(String) }, { type: "task.terminals", terminals: {} }]);
    const term = await connect(`ws://${b}/ws/pty?task=${id}`);
    pty.spawned[0]!.emit(CHUNKS[3]!);
    await until(() => first.changes().length === 1);
    expect(first.changes()).toEqual([[id, "waiting"]]);
    term.ws.close(); // the tab is closed; the shell and its status stay
    const second = await listen();
    expect(second.got.slice(0, 2)).toEqual([{ type: "hello", version: expect.any(String) }, { type: "task.terminals", terminals: { [id]: "waiting" } }]);
    pty.spawned[0]!.exit();
    await until(() => second.changes().length === 1);
    expect(second.changes()).toEqual([[id, null]]);
    const third = await listen();
    expect(third.got[1]).toEqual({ type: "task.terminals", terminals: {} });
    for (const l of [first, second, third]) l.ws.close();
  }));
});
