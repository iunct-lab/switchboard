/**
 * The rescue agent (#178): `claude -p` started from the rescue page in a fresh git worktree, with the daemon log, the
 * promotion history and the diff between the last two releases in its prompt. It may fix and open a pull request; it
 * is never given a way to promote or restart — a person does that after reviewing the PR.
 * Approvals are not switched off: edits are accepted and the shell is limited to the commands listed here. None of
 * them runs code from the repository — no `bun test`, no `bun install` — because code the agent can write and then
 * run could call sb-rescue on loopback, or write under ~/.switchboard, as the same OS user. CI on the pull request
 * runs the checks instead. This is Claude Code's permission system, not an OS sandbox — so sb-rescue's own secrets
 * (the token for 作り直す, the CDN's shared header value) are not in the agent's environment either (#2077).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { currentOf, previousOf, readHistory, run, type HistoryEntry } from "./releases.ts";
import type { Supervisor } from "./supervisor.ts";

export const ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git add:*)", "Bash(git commit:*)", "Bash(git push:*)", "Bash(gh pr create:*)"];
/** The prompt goes in on stdin. stream-json, because the text format prints nothing until the run is over. */
export const DEFAULT_AGENT_ARGV = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools", ALLOWED_TOOLS.join(",")];
const MAX_OUTPUT = 20_000;
const STOP_KILL_MS = 5000;

/** One output line for the page: what the agent said or did from a stream-json line, anything else as it is. */
export function formatLine(line: string): string | null {
  if (!line.startsWith("{")) return line;
  let m: { type?: string; message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> }; result?: unknown; is_error?: boolean };
  try {
    m = JSON.parse(line);
  } catch {
    return line;
  }
  if (m.type === "assistant") {
    const parts = (m.message?.content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : c.type === "tool_use" ? [`→ ${c.name} ${JSON.stringify(c.input ?? {}).slice(0, 300)}`] : []));
    return parts.length ? parts.join("\n") : null;
  }
  if (m.type === "result") return `${m.is_error ? "failed" : "finished"}: ${typeof m.result === "string" ? m.result : ""}`;
  return null; // system / user (tool results) / control lines
}

export function buildPrompt(i: { current: string | null; previous: string | null; history: HistoryEntry[]; diffStat: string; log: string[] }): string {
  return [
    "Switchboard (this repository) runs from immutable releases under sb-rescue. A release failed: it did not start, or it was rolled back. Find the cause and fix it.",
    "",
    `Running release now: ${i.current ?? "none"}. Release before it: ${i.previous ?? "none"}. This worktree is a new branch at the running release.`,
    "",
    "Rules:",
    "- Fix the cause in this worktree and add or adjust a test. You cannot run code here; CI on the pull request runs `bun run typecheck` and `bun test`.",
    "- Commit, push the branch and open a pull request with `gh pr create`. Say in the PR what failed, why, and that the checks have not been run locally.",
    "- Do not promote, restart or roll back anything, do not touch ~/.switchboard, and do not change rescue/ — a person reviews the PR and promotes it.",
    "- If you cannot find the cause, stop and write what you checked.",
    "",
    "## Promotion history (newest first)",
    ...(i.history.length ? i.history.map((h) => `- ${new Date(h.ts).toISOString()} ${h.action} ${h.from ?? "-"} -> ${h.to ?? "-"} ${h.ok ? "ok" : "FAILED"}: ${h.reason}`) : ["(none)"]),
    "",
    "## git diff --stat between the two releases",
    i.diffStat || "(no earlier release to compare with)",
    "",
    `## Last ${i.log.length} lines of the daemon log`,
    ...i.log,
    "",
  ].join("\n");
}

export class RescueAgent {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private output = "";
  private exitCode: number | null = null;
  private worktree: string | null = null;
  private starting = false;
  private error: string | null = null;

  constructor(
    private ctx: { home: string; repo: string; sup: Supervisor },
    private argv: string[] = DEFAULT_AGENT_ARGV,
  ) {}

  status() {
    return { running: this.starting || this.proc !== null, output: this.output, exitCode: this.exitCode, worktree: this.worktree, error: this.error, allowed: this.argv === DEFAULT_AGENT_ARGV ? ALLOWED_TOOLS : null };
  }

  async start(): Promise<void> {
    if (this.starting || this.proc) throw new Error("the rescue agent is already running");
    this.starting = true; // taken before the first await: two requests must not both get past the line above
    this.error = null;
    try {
      await this.launch();
    } catch (e) {
      this.error = String((e as Error).message ?? e); // kept for the page: the POST's answer is gone after one refresh
      throw e;
    } finally {
      this.starting = false;
    }
  }

  private async launch(): Promise<void> {
    const current = currentOf(this.ctx.home);
    if (!current) throw new Error("there is no current release to start from");
    const previous = previousOf(this.ctx.home);
    const stamp = new Date().toISOString().replace(/[-:.]/g, "");
    const worktree = join(this.ctx.home, "rescue-work", stamp);
    mkdirSync(join(this.ctx.home, "rescue-work"), { recursive: true });
    await run(["git", "-C", this.ctx.repo, "worktree", "add", "-b", `rescue/${stamp}`, worktree, current], this.ctx.repo);
    const diffStat = previous ? await run(["git", "-C", this.ctx.repo, "diff", "--stat", previous, current], this.ctx.repo).catch((e) => String(e)) : "";
    const prompt = buildPrompt({ current, previous, history: readHistory(this.ctx.home).slice(-8).reverse(), diffStat, log: this.ctx.sup.logTail(200) });
    this.output = "";
    this.exitCode = null;
    this.worktree = worktree;
    // The same OS user, so what the agent must not have is not in its environment either: sb-rescue's secret for 作り直す
    // and the CDN's shared header value, which only sb-rescue and the daemon use (#2077). Everything else stays.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    delete env.SWITCHBOARD_STARTER_TOKEN;
    delete env.SWITCHBOARD_EDGE_HEADER_VALUE;
    const proc = Bun.spawn(this.argv, { cwd: worktree, env, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
    this.proc = proc;
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      let rest = "";
      const emit = (line: string) => {
        const text = formatLine(line);
        if (text !== null) this.output = (this.output + text + "\n").slice(-MAX_OUTPUT);
      };
      for await (const chunk of stream) {
        const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
        rest = lines.pop() ?? "";
        lines.forEach(emit);
      }
      if (rest) emit(rest);
    };
    void pump(proc.stdout as ReadableStream<Uint8Array>);
    void pump(proc.stderr as ReadableStream<Uint8Array>);
    // The exit decides "running": a grandchild that keeps the pipes open must not keep the button disabled.
    void proc.exited.then((code) => {
      this.exitCode = code;
      if (this.proc === proc) this.proc = null;
    });
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    proc.kill("SIGTERM");
    const killer = setTimeout(() => proc.kill("SIGKILL"), STOP_KILL_MS);
    await proc.exited;
    clearTimeout(killer);
  }
}
