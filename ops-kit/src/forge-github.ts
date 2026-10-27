import type { ForgeImpl } from "./forge.ts";
import type { GhClient } from "./gh.ts";

/**
 * GitHub's side of the kit's forge operations (#920), through the signed-in `gh` (no credential is kept here).
 * `sh` runs a command and throws on a non-zero exit.
 */
export interface Verification {
  pr: number;
  body: string;
}

export const githubForge = (sh: (cmd: string[]) => Promise<string>): ForgeImpl<Verification, void> => ({
  verification: async (op) => {
    if (!op.target.repository) throw new Error("GitHub の verification にはリポジトリ（owner/name）が要ります");
    await sh(["gh", "pr", "comment", String(op.payload.pr), "-R", op.target.host === "github.com" ? op.target.repository : `${op.target.host}/${op.target.repository}`, "--body", op.payload.body]);
  },
});

/**
 * Resolve one pull request review thread: the one mutation a Task is allowed (#2150) instead of a general `gh api graphql`.
 * Throws when GitHub does not answer that the thread is resolved.
 */
export async function resolveReviewThread(gh: GhClient, threadId: string): Promise<void> {
  const data = await gh.graphql("mutation($t:ID!){ resolveReviewThread(input:{threadId:$t}){ thread{ isResolved } } }", { t: threadId }) as
    { resolveReviewThread?: { thread?: { isResolved?: boolean } } };
  if (data.resolveReviewThread?.thread?.isResolved !== true) throw new Error(`${threadId} が resolve にならなかった`);
}
