import type { ForgeImpl } from "./forge.ts";

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
