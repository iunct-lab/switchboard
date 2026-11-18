import type { ForgeImpl } from "./forge.ts";
import type { Verification } from "./forge-github.ts";
import { runBacklog } from "./backlog-client.ts";

/**
 * The agent management app's side of the kit's forge operations: a repository with no remote, whose PRs are local changes kept in
 * the app. `verification` = a comment on the change `pr`, through the kit's backlog client (BACKLOG_URL and
 * BACKLOG_WORKSPACE, its key): without them, or refused, it fails with the reason — never sent some other way. Always as
 * a change (`--change`): in a workspace whose Issues are GitHub's the same number is an Issue or a PR.
 */
export const appForge = (env: Record<string, string | undefined>, fetch?: (url: string, init?: RequestInit) => Promise<Response>): ForgeImpl<Verification, void> => ({
  verification: async (op) => {
    if (!env.BACKLOG_URL || !env.BACKLOG_WORKSPACE) throw new Error("ローカルの変更への報告には BACKLOG_URL と BACKLOG_WORKSPACE が要ります（アプリの Task の中で実行する）");
    const err: string[] = [];
    const code = await runBacklog(["comment", String(op.payload.pr), "--change", "--body-file", "-"], env, { out: () => {}, err: (s) => err.push(s), stdin: async () => op.payload.body }, fetch ? { fetch } : {});
    if (code !== 0) throw new Error(`#${op.payload.pr} にコメントできない: ${err.join(" ").trim() || `exit ${code}`}`);
  },
});
