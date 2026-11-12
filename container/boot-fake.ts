// The fake daemon of container/e2e.sh (#4191), in the stand-alone image in place of container/entrypoint.sh: the relay
// on 47831 and a daemon on 47832 with one fake runner (a copy of the boot.ts of .claude/skills/verify-live-ui, the
// runner of packages/core/src/devproxy.test.ts). SWITCHBOARD_HOME is the daemon's default, the sb-home volume.
// SWITCHBOARD_CANDIDATE=1 comes from the override file of e2e.sh. The turn writes a marked session file as a real
// runner would, to ~/.claude/projects/<cwd folder>/<session id>.jsonl, which the run after a recreate looks for.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeProjectDirName } from "../packages/adapters/claude/src/history.ts";
import type { AgentEvent, RunnerAdapter } from "@switchboard/protocol";
import { loadConfig } from "../packages/core/src/config.ts";
import { startServer } from "../packages/core/src/server.ts";
import { startRelay } from "./relay.ts";

export const SESSION_ID = "e2e-session-1";

// the judge and the title suggester would ask the fake runner for sessions of their own; here they never answer
const never = () => new Promise<never>(() => undefined);

const adapter: RunnerAdapter = {
  id: "claude",
  async detect() {
    return { available: true, version: "fake" };
  },
  start(opts, emit) {
    const dir = join(homedir(), ".claude", "projects", claudeProjectDirName(opts.cwd));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${SESSION_ID}.jsonl`), `${JSON.stringify({ type: "e2e-mark", cwd: opts.cwd })}\n`);
    // the events come from a microtask: emitted inside start() they would arrive before the Task is running
    const script: AgentEvent[] = [
      { t: "session.start", runner: "claude", runnerSessionId: SESSION_ID, cwd: opts.cwd, model: "fake" },
      { t: "message.delta", role: "assistant", text: "done" },
      { t: "session.end", status: "ok", summary: "done" },
    ];
    let resolveExit!: (c: number | null) => void;
    const exited = new Promise<number | null>((r) => (resolveExit = r));
    queueMicrotask(() => {
      for (const ev of script) emit(ev);
      resolveExit(0);
    });
    return {
      send: () => undefined,
      respondPermission: () => undefined,
      abort: async () => resolveExit(null),
      close: async () => resolveExit(0),
      exited,
    };
  },
};

if (import.meta.main) {
  const port = 47832;
  await startServer(loadConfig({ ...process.env, SWITCHBOARD_PORT: String(port), SWITCHBOARD_CANDIDATE: "1", SWITCHBOARD_HISTORY_POLL_MS: "0" }), [adapter], { port, judge: never, rubricJudge: never, titleSuggester: never });
  startRelay(47831, port);
  console.log("fake daemon up");
}
