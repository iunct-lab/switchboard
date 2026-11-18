// test-reads: none
// The terminal socket's entrance, called with a context made by hand: no daemon, port or shell.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyManager } from "../pty.ts";
import { socketHandlers } from "../server/serve.ts";
import { ptyTarget, socketGate, wsRoutes } from "./ws.ts";

const dir = mkdtempSync(join(tmpdir(), "switchboard-test-ws-route-"));
const file = join(dir, "a-file");
writeFileSync(file, "");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const bad = (message: string, status = 400) => Response.json({ error: message }, { status });
type Row = { id: string; cwd?: string; path?: string; machine?: string | null };
/** A store with these Tasks and Workspaces; `asked` is every id looked up. */
const store = (tasks: Row[], workspaces: Row[]) => {
  const asked: string[] = [];
  return { asked, db: { getTask: (id: string) => (asked.push(id), tasks.find((t) => t.id === id) ?? null), getWorkspace: (id: string) => (asked.push(id), workspaces.find((w) => w.id === id) ?? null) } as never };
};
const target = (q: string, s = store([{ id: "tsk_here", cwd: dir }, { id: "tsk_pc", cwd: dir, machine: "pc" }, { id: "tsk_gone", cwd: join(dir, "missing") }], [{ id: "ws_here", path: dir }, { id: "ws_gone", path: join(dir, "missing") }, { id: "ws_file", path: file }]), mode: "send" | "receive" | null = null) => {
  const r = ptyTarget({ db: s.db, bad, cfg: { uplink: { mode } } as never }, new URLSearchParams(q));
  return r instanceof Response ? r.status : r;
};

describe("whose shell /ws/pty opens", () => {
  test("a Task's shell starts in the Task's stored cwd; a Workspace's in the Workspace's stored path, whatever else the query carries", () => {
    expect(target("task=tsk_here")).toEqual({ key: "tsk_here", cwd: dir, task: "tsk_here", teleport: false });
    expect(target("task=tsk_here&teleport=1")).toMatchObject({ teleport: true });
    expect(target("workspace=ws_here")).toEqual({ key: "ws_here", cwd: dir, teleport: false });
    expect(target("workspace=ws_here&cwd=/&path=/etc")).toEqual({ key: "ws_here", cwd: dir, teleport: false });
  });

  test("a Workspace id that is not an id (a path, dots, empty) is not looked up; an unknown one is 404", () => {
    const s = store([], [{ id: "/etc", path: "/etc" }, { id: "ws_../x", path: "/" }, { id: "", path: "/" }]);
    for (const id of ["/etc", "ws_../x", "", "ws_", `ws_${"a".repeat(65)}`]) expect(target(`workspace=${encodeURIComponent(id)}`, s)).toBe(404);
    expect(s.asked).toEqual([]);
    expect(target("workspace=ws_nope")).toBe(404);
  });

  test("a Workspace whose path is not on this machine, or is a file, is refused with 409", () => {
    expect(target("workspace=ws_gone")).toBe(409);
    expect(target("workspace=ws_file")).toBe(409);
  });

  test("a Task that ran on another machine gets no shell here, nor a Teleport; neither does a Task whose cwd is not on this machine", () => {
    expect(target("task=tsk_pc")).toBe(409);
    expect(target("task=tsk_pc&teleport=1")).toBe(409);
    expect(target("task=tsk_gone")).toBe(409);
    expect(target("task=nope")).toBe(404);
  });

  test("on a work machine the Workspace terminal is refused with 409 before any lookup; a Task's shell still opens; the instance and a machine alone open both", () => {
    const s = store([{ id: "tsk_here", cwd: dir }], [{ id: "ws_here", path: dir }]);
    expect(target("workspace=ws_here", s, "send")).toBe(409);
    expect(s.asked).toEqual([]);
    expect(target("task=tsk_here", s, "send")).toMatchObject({ key: "tsk_here" });
    expect(target("workspace=ws_here", s, "receive")).toMatchObject({ key: "ws_here" });
    expect(target("workspace=ws_here", s, null)).toMatchObject({ key: "ws_here" });
  });

  test("Teleport is a Task's: with a Workspace it is 400", () => {
    expect(target("workspace=ws_here&teleport=1")).toBe(400);
  });
});

describe("the upgrade check is one for both kinds of shell", () => {
  // a store that fails the test when anything is read from it: a refused request must not get as far as its target
  const untouched = new Proxy({}, { get: (_t, k) => () => { throw new Error(`db.${String(k)} was read before the upgrade check passed`); } }) as never;
  const pty = {} as never;
  const req = (q: string, headers: Record<string, string> = {}) => new Request(`http://127.0.0.1:47831/ws/pty?${q}`, { headers: { host: "127.0.0.1:47831", ...headers } });
  const context = (over: object) => ({ refused: (_q: Request, _s: unknown, res: Response) => res, bad, authorize: async () => ({ ok: true, session: "cookie" }), recentRefusal: () => null, pty, db: untouched, cfg: { uplink: { mode: null } } as never, clientOf: () => "", logOp: () => undefined, ...over }) as never;
  const answer = async (sc: never, q: string, headers?: Record<string, string>) => {
    const r = await (wsRoutes(sc)["/ws/pty"] as (req: Request, srv: unknown) => Promise<Response>)(req(q, headers), undefined);
    return { status: r.status, body: await r.json() };
  };
  const KINDS = ["task=tsk_x", "workspace=ws_x", "task=tsk_x&teleport=1", "workspace=ws_x&shell=abc"];

  test("a foreign Origin, no login, a cookie session with no recent passkey check and a daemon with no PTY refuse a Task's shell and a Workspace's shell with the same answer, before the target is read", async () => {
    const cases: [string, never, Record<string, string> | undefined, number][] = [
      ["cross-origin", context({ authorize: async () => { throw new Error("asked for the login of a cross-origin request"); } }), { origin: "http://evil.example" }, 403],
      ["unauthorized", context({ authorize: async () => ({ ok: false }) }), undefined, 401],
      ["no recent check", context({ recentRefusal: (_r: Request, session: string | undefined) => (session === "cookie" ? Response.json({ error: "recent check needed", reason: "recent" }, { status: 401 }) : null) }), undefined, 401],
      ["no PTY", context({ pty: null }), undefined, 404],
    ];
    for (const [name, sc, headers, status] of cases) {
      const answers = await Promise.all(KINDS.map((q) => answer(sc, q, headers)));
      for (const a of answers) expect({ name, ...a }).toEqual({ name, ...answers[0]! });
      expect({ name, status: answers[0]!.status }).toEqual({ name, status });
    }
  });

  test("the login is asked for fresh and with the query token allowed, for both sockets; only the shell asks for the recent check and the PTY", async () => {
    const seen: unknown[] = [];
    const sc = context({ authorize: async (_r: Request, _s: unknown, allowQuery: boolean, fresh: boolean) => (seen.push([allowQuery, fresh]), { ok: true }), recentRefusal: () => (seen.push("recent"), null), pty: null });
    expect(await socketGate(sc, req("x"), undefined, false)).toEqual({ session: undefined });
    expect(seen).toEqual([[true, true]]);
    expect(((await socketGate(sc, req("x"), undefined, true)) as Response).status).toBe(404);
    expect(seen).toEqual([[true, true], [true, true], "recent"]);
  });
});

describe("the close message", () => {
  const manager = async () => {
    const kills: number[] = [];
    let n = 0;
    const spawn = () => {
      const pid = 4_194_500 + n++;
      const exits: (() => void)[] = [];
      return { pid, onData: () => undefined, onExit: (f: () => void) => void exits.push(f), write: () => undefined, resize: () => undefined, kill: () => { kills.push(pid); for (const f of exits) f(); } };
    };
    const m = (await PtyManager.load(async () => ({ spawn: spawn as never })))!;
    kills.length = 0;
    return { m, kills };
  };
  const send = (m: PtyManager, data: object, message: object) => socketHandlers({ pty: m } as never).message!({ data } as never, JSON.stringify(message));

  test("ends a Workspace's shell; on a Task's shell and on a Teleport it does nothing, whatever the socket says it is", async () => {
    const { m, kills } = await manager();
    m.open("tsk_1", "/", "/bin/sh");
    m.open("ws_1", "/", "/bin/sh", undefined, "workspace");
    m.prepareTeleport("tsk_2");
    // a socket of a Task's shell, and one that claims to be a Workspace's
    send(m, { ptyKey: "tsk_1", cwd: "/", ofTask: true }, { type: "close" });
    send(m, { ptyKey: "tsk_1", cwd: "/", ofTask: false }, { type: "close" });
    send(m, { ptyKey: "tsk_2", cwd: "/", ofTask: true, teleport: true }, { type: "close" });
    expect(kills).toEqual([]);
    expect([m.has("tsk_1"), m.has("tsk_2"), m.has("ws_1")]).toEqual([true, true, true]);
    send(m, { ptyKey: "ws_1", cwd: "/", ofTask: false }, { type: "close" });
    expect(kills.length).toBe(1);
    expect([m.has("tsk_1"), m.has("tsk_2"), m.has("ws_1")]).toEqual([true, true, false]);
    m.closeAll();
  });
});
