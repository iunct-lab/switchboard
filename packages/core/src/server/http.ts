import type { ServerMessage, Workspace } from "@switchboard/protocol";
import { ArtifactError } from "../artifacts.ts";
import type { ServerContext } from "./context.ts";
import { TOPIC } from "./helpers.ts";

export const broadcast = (sc: Pick<ServerContext, "server">, msg: ServerMessage) => sc.server?.publish(TOPIC, JSON.stringify(msg));

export const askRescue = (sc: Pick<ServerContext, "cfg" | "token">, path: string, init: RequestInit = {}) => fetch(`${sc.cfg.rescueUrl}${path}`, { signal: AbortSignal.timeout(5000), ...init, headers: { "content-type": "application/json", authorization: `Bearer ${sc.token}` } });

export const git = async (sc: Pick<ServerContext, "cfg">, args: string[]) => {
  // Never a prompt for credentials (a fetch of tags from an SSH remote would hang the firing), and a time limit.
  const p = Bun.spawn(["git", "-C", sc.cfg.repoRoot, ...args], { stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" } });
  const timer = setTimeout(() => p.kill(), 30_000);
  try {
    const out = (await new Response(p.stdout).text()).trim();
    const code = await p.exited;
    if (code !== 0) throw Object.assign(new Error(`git ${args.join(" ")} failed in ${sc.cfg.repoRoot}`), { exitCode: code });
    return out;
  } finally {
    clearTimeout(timer);
  }
};

// content-length so the request's bytes can be recorded without reading the body again
export const json = (_sc: unknown, data: unknown, status = 200) => {
  const body = JSON.stringify(data);
  return new Response(body, { status, headers: { "content-type": "application/json;charset=utf-8", "content-length": String(Buffer.byteLength(body)) } });
};

export const bad = (_sc: unknown, message: string, status = 400) => Response.json({ error: message }, { status });

export const artifactResult = (sc: Pick<ServerContext, "bad">, f: () => Response): Response => {
  try {
    return f();
  } catch (e) {
    return e instanceof ArtifactError ? sc.bad(e.message, e.status) : sc.bad(String((e as Error).message ?? e), 500);
  }
};

/** A backlog Issue in a path: its number, or the local id of one made here. */
export const issueRef = (_sc: unknown, p: string): number | string => (/^\d+$/.test(p) ? Number(p) : p);

/** A request's body, or null once it is longer than `max` bytes (read no further). */
export const readCapped = async (_sc: unknown, req: Request, max: number): Promise<Uint8Array | null> => {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body ?? []) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

/** Tasks (a shadow too) running or waiting in a workspace: named for it, or working inside its directory (a worktree made under it). */
export const runningTasksIn = (sc: Pick<ServerContext, "db">, ws: Workspace) => sc.db.listWorkingTasks("slot").filter((t) => t.workspaceId === ws.id || t.cwd === ws.path || t.cwd.startsWith(`${ws.path}/`)).length;

export const readJson = async <T>(_sc: unknown, req: Request, parse: (x: unknown) => T): Promise<T> => parse(await req.json().catch(() => ({})));
