import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AnswerPolicy, AskList, Backlog, RunnerAdapter, RunnerId, RunnerSession } from "@switchboard/protocol";
import { importing } from "../fixtures/github-import.ts";
import type { GhRunner } from "./backlog.ts";
import { loadConfig } from "./config.ts";
import { startServer, type CoreServer } from "./server.ts";

/* The daemon the policy tests (#938) boot: a scripted runner, a fake gh with a PR, and the helpers that ask it things. */

const pages = (await Bun.file(new URL("../fixtures/backlog-graphql.json", import.meta.url)).json()) as unknown[];
const decisions = (await Bun.file(new URL("../fixtures/backlog-decisions.json", import.meta.url)).json()) as unknown;
export const HEAD = "c".repeat(40);
export const DAY = 86_400_000;

export const CHECK = "PR を出しました。\n\n**確認**: PR #12 をマージしてよいか\n**選択肢**:\n- A: マージする\n- B: 待つ\n**推奨**: A — CI が緑\n**止めた場所**: PR #12";
export const EXEC: AgentEvent = { t: "permission.ask", id: "perm1", kind: "exec", tool: "Bash", input: { command: "bun test packages/core" }, detail: "bun test packages/core" };

/** Replays `script`, pausing on a permission.ask until it is answered; a message sent to it replays the script. */
export function runner(id: RunnerId, script: AgentEvent[], sent: string[] = []): RunnerAdapter {
  return {
    id,
    detect: async () => ({ available: true, version: "fake" }),
    start(_opts, emit) {
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      let i = 0;
      let waitingFor: string | null = null;
      const pump = () => {
        while (i < script.length) {
          const ev = script[i++]!;
          if (ev.t === "permission.ask") waitingFor = ev.id;
          emit(ev);
          if (ev.t === "permission.ask") return;
        }
      };
      queueMicrotask(pump);
      return {
        send: (text) => {
          sent.push(text);
          emit({ t: "message.delta", role: "user", text });
          i = 0;
          queueMicrotask(pump);
        },
        respondPermission: (pid, decision) => {
          if (waitingFor !== pid) throw new Error("unexpected permission id");
          waitingFor = null;
          emit({ t: "permission.resolved", id: pid, decision, by: "user" });
          queueMicrotask(pump);
        },
        abort: async () => resolveExit(null),
        close: async () => resolveExit(0),
        exited,
      } satisfies RunnerSession;
    },
  };
}

export const until = async (ok: () => Promise<boolean>) => {
  for (let n = 0; n < 400 && !(await ok()); n++) await Bun.sleep(10);
};

export function harness() {
  const h = {
    core: null as CoreServer | null,
    home: "",
    base: "",
    /** The kinds of the `[merge-ask]` mark on the PR's head, or null for none. */
    mark: null as string | null,
    prCalls: 0,
    prFails: false,
    /** What the codex runner was sent after its first turn (the check Task's replies). */
    sent: [] as string[],
    gh: (async (args) => {
      if (args[0] === "repo") return { code: 0, stdout: "acme/app true\n", stderr: "" };
      if (args[0] === "variable") return { code: 0, stdout: "https://github.com/users/acme/projects/11\n", stderr: "" };
      if (args[0] === "pr" && args[1] === "view") {
        h.prCalls++;
        if (h.prFails) return { code: 1, stdout: "", stderr: "boom" };
        const comments = h.mark ? [{ body: `[merge-ask] ${h.mark} ${HEAD}`, createdAt: "2026-01-01T00:00:00Z" }] : [];
        return { code: 0, stdout: JSON.stringify({ state: "OPEN", headRefOid: HEAD, comments, commits: [] }), stderr: "" };
      }
      if (args.some((a) => a.includes("comments(last:"))) return { code: 0, stdout: JSON.stringify(decisions), stderr: "" };
      return { code: 0, stdout: JSON.stringify(args.includes("after=CURSOR1") ? pages[1] : pages[0]), stderr: "" };
    }) as GhRunner,
    async boot(confirm: string[] = []) {
      h.mark = null;
      h.prCalls = 0;
      h.prFails = false;
      h.sent = [];
      h.home = mkdtempSync(join(tmpdir(), "sb-policies-"));
      if (confirm.length) {
        mkdirSync(join(h.home, "knowledge", "rules"), { recursive: true });
        writeFileSync(join(h.home, "knowledge", "rules", "g.md"), `---\napproval: { confirm: [${confirm.map((c) => `'${c}'`).join(", ")}] }\n---\nrules\n`);
      }
      const cfg = loadConfig({ SWITCHBOARD_HOME: h.home, SWITCHBOARD_KNOWLEDGE: join(h.home, "knowledge"), SWITCHBOARD_CLAUDE_PROJECTS: join(h.home, "history"), SWITCHBOARD_HISTORY_POLL_MS: "0" });
      const end: AgentEvent = { t: "session.end", status: "ok", summary: CHECK };
      h.core = await startServer(cfg, [runner("claude", [EXEC]), runner("codex", [end], h.sent)], { port: 0, selfdevChecks: false, dryRunRestart: true, gh: importing(h.gh), backlogAutoImport: true, judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined) });
      h.base = `http://127.0.0.1:${h.core.server.port}`;
      await until(async () => !((await fetch(`${h.base}/api/backlog`).then((r) => r.json())) as Backlog).syncs.some((s) => s.syncing));
    },
    async stop() {
      await h.core?.stop();
      h.core = null;
      rmSync(h.home, { recursive: true, force: true });
    },
    // the web page sends its own origin; a Task's curl does not (#938)
    post: (path: string, body: unknown, headers?: Record<string, string>) => fetch(`${h.base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(headers ?? { origin: h.base, "sec-fetch-site": "same-origin" }) }, body: JSON.stringify(body) }),
    patch: (path: string, body: unknown, headers?: Record<string, string>) => fetch(`${h.base}${path}`, { method: "PATCH", headers: { "content-type": "application/json", ...(headers ?? { origin: h.base, "sec-fetch-site": "same-origin" }) }, body: JSON.stringify(body) }),
    meta: () => h.core!.db.listWorkspaces().find((w) => w.kind === "meta")!,
    asks: async () => ((await fetch(`${h.base}/api/asks`).then((r) => r.json())) as AskList).asks,
    policies: async () => ((await fetch(`${h.base}/api/policies`).then((r) => r.json())) as { policies: AnswerPolicy[] }).policies,
    /** A Task that asks to run `bun test packages/core` (claude) and waits. */
    async approvalTask(title: string) {
      const t = (await (await h.post("/api/tasks", { cwd: h.home, title, prompt: "run", runner: "claude", workspaceId: h.meta().id })).json()) as { id: string };
      // waiting, or already allowed by a rule / policy
      await until(async () => h.core!.db.getTask(t.id)!.status === "waiting" || h.core!.db.listEvents(t.id).some((e) => e.ev.t === "permission.resolved"));
      return t.id;
    },
    /** A Task that ended with an operational check about PR #12, with a decision stop record before it, marked 要対応. */
    async checkTask(title: string, op = "gh pr merge", stop: { reason?: string; evidence?: string } = {}) {
      const t = (await (await h.post("/api/tasks", { cwd: h.home, title, prompt: "open the PR", runner: "codex", workspaceId: h.meta().id })).json()) as { id: string };
      await until(async () => h.core!.db.getTask(t.id)!.status !== "running");
      h.core!.db.appendEvent(t.id, { t: "stop.record", stop: { id: "s1", work: { workspaceId: h.meta().id, issue: null, taskId: t.id }, op, target: "PR #12", reason: (stop.reason ?? "decision") as "decision", evidence: stop.evidence ?? "merge check", safety: "unknown", conditions: [], answer: null, actions: [], state: "waiting", at: Date.now() - 600_000 } });
      await h.post(`/api/tasks/${t.id}/outcome`, { outcome: "needs_action" });
      return t.id;
    },
  };
  return h;
}

export const policyOf = (over: Record<string, unknown> = {}) => ({ scope: "repo", target: "bun test*", when: [], expiresAt: Date.now() + 30 * DAY, ...over });
