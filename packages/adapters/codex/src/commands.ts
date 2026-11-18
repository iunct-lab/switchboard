import type { RunnerCommand } from "@switchboard/protocol";
import { CLIENT_INFO, jsonRpcNotification, jsonRpcRequest } from "./parse.ts";

type Answer = { result?: unknown; error?: { message?: string } };

/** The part of app-server's `skills/list` answer the "/" list reads. */
interface SkillsListAnswer {
  data?: { skills?: { name?: unknown; description?: unknown; shortDescription?: unknown; enabled?: unknown }[] }[];
}

/** What starts the app-server: the config flags and environment of a session's process, without the `app-server` words. */
export interface ListSpawn {
  args: string[];
  env: Record<string, string>;
}

/**
 * The enabled skills Codex offers in `cwd`, as "/" candidates whose `insert` is Codex's own `$<name>`. Starts an
 * app-server, sends `initialize`, `initialized` and `skills/list` and nothing else (no thread, no turn, so the model is
 * not called), and stops the process whether it answered, failed or timed out. Rejects on a failure or no answer
 * within `timeoutMs`.
 */
export async function listCodexSkills(bin: string, cwd: string, timeoutMs: number, spawn: ListSpawn): Promise<RunnerCommand[]> {
  const proc = Bun.spawn([bin, "app-server", "--listen", "stdio://", ...spawn.args], { cwd, env: spawn.env, stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true });
  const stop = () => {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const write = (line: string) => {
      proc.stdin.write(line);
      proc.stdin.flush();
    };
    const answers = new Map<number, (m: Answer) => void>();
    const failed = new Promise<never>((_, reject) => {
      void proc.exited.then((code) => reject(new Error(`codex app-server exited (${code}) before it answered`)));
      timer = setTimeout(() => reject(new Error(`codex app-server did not answer within ${timeoutMs} ms`)), timeoutMs);
    });
    failed.catch(() => undefined);
    void (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          try {
            const m = JSON.parse(line) as Answer & { id?: unknown; method?: unknown };
            if (typeof m.id === "number" && typeof m.method !== "string") answers.get(m.id)?.(m);
          } catch {
            /* not JSON: ignore */
          }
        }
      }
    })().catch(() => undefined);
    const request = (id: number, method: string, params: unknown) => {
      const answered = new Promise<Answer>((r) => answers.set(id, r));
      write(jsonRpcRequest(id, method, params));
      return Promise.race([answered, failed]);
    };
    const init = await request(1, "initialize", { clientInfo: CLIENT_INFO, capabilities: null });
    if (init.error) throw new Error(init.error.message ?? "initialize failed");
    write(jsonRpcNotification("initialized"));
    const res = await request(2, "skills/list", { cwds: [cwd] });
    if (res.error) throw new Error(res.error.message ?? "skills/list failed");
    const out: RunnerCommand[] = [];
    for (const entry of (res.result as SkillsListAnswer | undefined)?.data ?? []) {
      for (const s of entry.skills ?? []) {
        if (s.enabled !== true || typeof s.name !== "string" || s.name === "") continue;
        const description = typeof s.shortDescription === "string" && s.shortDescription !== "" ? s.shortDescription : typeof s.description === "string" ? s.description : "";
        out.push({ name: s.name, description, insert: `$${s.name}` });
      }
    }
    return out;
  } finally {
    clearTimeout(timer);
    stop();
  }
}
