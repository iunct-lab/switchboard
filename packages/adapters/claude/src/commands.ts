import type { RunnerCommand } from "@switchboard/protocol";
import { initializeLine } from "./parse.ts";

/** The part of a `commands` entry of claude's `initialize` answer the "/" list reads. */
interface InitCommand {
  name?: unknown;
  description?: unknown;
  argumentHint?: unknown;
}

/**
 * The commands and skills Claude offers in `cwd`, as "/" candidates whose `insert` is `/<name>`. Starts a claude with
 * the session's stream-json flags and MCP isolation (only the servers Switchboard hands over, here none: the user-wide
 * and workspace ones would start on every read, and offer commands a session does not load), then `extraArgs` as a
 * session appends them, writes `initialize` and nothing else (no user message, so the model is not called),
 * reads `commands` from the answer and stops the process group whether it answered, failed or timed out. The list is
 * the runner's own: no command or skill folder is read here. `env` is the environment of a session's process (the caller's `childEnv`). Rejects on a failure or no answer within `timeoutMs`.
 */
export async function listClaudeCommands(bin: string, cwd: string, timeoutMs: number, env: Record<string, string> = process.env as Record<string, string>, extraArgs: string[] = []): Promise<RunnerCommand[]> {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} })];
  const proc = Bun.spawn([bin, ...args, ...extraArgs], {
    cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    detached: true,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // an exit is seen when its output ends (below), after any answer already in the pipe has been read
    const failed = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`claude did not answer within ${timeoutMs} ms`)), timeoutMs);
    });
    failed.catch(() => undefined);
    const answer = (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let m: { type?: unknown; response?: { subtype?: unknown; error?: unknown; response?: { commands?: unknown } } };
          try {
            m = JSON.parse(line);
          } catch {
            continue; // not JSON: ignore
          }
          if (m?.type !== "control_response") continue;
          if (m.response?.subtype === "error") throw new Error(`claude refused initialize: ${String(m.response.error ?? "")}`);
          return commandsOf(m.response?.response?.commands);
        }
      }
      throw new Error(`claude exited (${await proc.exited}) before it answered`);
    })();
    answer.catch(() => undefined);
    proc.stdin.write(initializeLine());
    proc.stdin.flush();
    return await Promise.race([answer, failed]);
  } finally {
    clearTimeout(timer);
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

/** `commands` of the initialize answer as the protocol's list: an entry without a name is left out, an empty argument hint is absent. */
export function commandsOf(commands: unknown): RunnerCommand[] {
  if (!Array.isArray(commands)) return [];
  return (commands as InitCommand[]).flatMap((c) => {
    if (typeof c?.name !== "string" || c.name === "") return [];
    const hint = typeof c.argumentHint === "string" && c.argumentHint !== "" ? c.argumentHint : undefined;
    return [{ name: c.name, description: typeof c.description === "string" ? c.description : "", ...(hint ? { argumentHint: hint } : {}), insert: `/${c.name}` }];
  });
}
