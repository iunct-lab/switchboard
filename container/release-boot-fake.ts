// The daemon of container/e2e-release.sh: what a release built for that check starts in place of
// packages/core/src/main.ts (the script puts a one-line main.ts that imports this file into each release's tree).
// It is the real core under the real sb-rescue: the newest release is read, its diff checked and the promotion decided
// by the same code as in a real start; only the runner is a fake, and the check for a new release comes every 2 seconds
// instead of the setting's minutes. Port, home, repository and sb-rescue's address come from sb-rescue's environment.
// The fake runner answers the check of a release's diff with the verdict in <home>/e2e-verdict (`ok` or `concern`;
// no file = ok), and any other Task with one line. A promotion's candidate start (SWITCHBOARD_CANDIDATE=1) gets no
// address of sb-rescue, so only the daemon itself asks for promotions.
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentEvent, RunnerAdapter } from "@switchboard/protocol";
import { loadConfig } from "../packages/core/src/config.ts";
import { seedNewHome, startServer } from "../packages/core/src/server.ts";

const never = () => new Promise<never>(() => undefined);

/** The last reply of a check of a release's diff, as the prompt asks for it (packages/core/src/release-review.ts). */
export function reviewReply(verdict: string): string {
  const result = verdict === "concern" ? { verdict: "concern", findings: [{ path: "e2e-version", why: "the E2E asked for a concern" }] } : { verdict: "ok", findings: [] };
  return "確認した。\n```switchboard-release-review\n" + JSON.stringify(result) + "\n```";
}

/** What the fake runner is told to answer: the content of `<home>/e2e-verdict`, `ok` when there is none. */
export function verdictOf(home: string): string {
  const file = join(home, "e2e-verdict");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "ok";
}

export function fakeRunner(home: string): RunnerAdapter {
  return {
    id: "claude",
    async detect() {
      return { available: true, version: "fake" };
    },
    models: [{ value: "fake", label: "fake" }],
    permissionModes: [{ value: "plan", label: "plan", description: "" }],
    start(opts, emit) {
      const review = opts.cwd.includes("/release-review/");
      const summary = review ? reviewReply(verdictOf(home)) : "done";
      const script: AgentEvent[] = [
        { t: "session.start", runner: "claude", runnerSessionId: `e2e-${Date.now()}`, cwd: opts.cwd, model: "fake" },
        { t: "session.end", status: "ok", summary },
      ];
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      // from a microtask: emitted inside start() the events would arrive before the Task is running
      queueMicrotask(() => {
        for (const ev of script) emit(ev);
        resolveExit(0);
      });
      return { send: () => undefined, respondPermission: () => undefined, abort: async () => resolveExit(null), close: async () => resolveExit(0), exited };
    },
  };
}

if (import.meta.main) {
  const cfg = loadConfig({ ...process.env, SWITCHBOARD_HISTORY_POLL_MS: "0" });
  seedNewHome(cfg.dbPath);
  const core = await startServer(cfg, [fakeRunner(cfg.home)], { port: cfg.port, promotionCheckMs: 2000, judge: never, rubricJudge: never, titleSuggester: never });
  // the promotion is asked about only with a meta workspace: the repository the daemon runs from (the release, or the clone)
  if (!core.db.listWorkspaces().some((w) => w.kind === "meta")) core.db.upsertWorkspace({ name: basename(cfg.repoRoot), path: cfg.repoRoot, kind: "meta" });
  console.log(`e2e daemon up on ${cfg.port}${cfg.candidate ? " (candidate)" : ""}`);
}
