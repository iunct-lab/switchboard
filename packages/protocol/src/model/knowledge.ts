import { z } from "zod";

export const Footprint = z.object({
  files: z.number(),
  bytes: z.number(),
  estTokens: z.number(),
  truncated: z.boolean(),
});
export type Footprint = z.infer<typeof Footprint>;

/** Frontmatter of a knowledge document. Unknown keys pass through; known keys are validated. */
export const KnowledgeTarget = z.enum(["claude", "codex", "agents-md", "commands"]);
export type KnowledgeTarget = z.infer<typeof KnowledgeTarget>;

export const KnowledgeFrontmatter = z
  .object({
    /** YAML turns `title: 2026` into a number; accept and stringify rather than invalidating the whole block. */
    title: z.union([z.string(), z.number()]).transform(String).optional(),
    /** Which generated files this document feeds (Materializer). */
    targets: z.array(KnowledgeTarget).optional(),
    /** Absolute repository path(s) this applies to; omitted = global. */
    repo: z.string().optional(),
    repos: z.array(z.string()).optional(),
    /** Approval rules matched against permission.ask (glob patterns on the touched path / command). */
    approval: z.object({ confirm: z.array(z.string()).optional(), allow: z.array(z.string()).optional() }).optional(),
    tags: z.array(z.string()).optional(),
    /** Set by the indexer when the frontmatter did not validate. */
    _invalid: z.string().optional(),
  })
  .passthrough();
export type KnowledgeFrontmatter = z.infer<typeof KnowledgeFrontmatter>;

export const KnowledgeDoc = z.object({
  /** Path relative to the knowledge folder, "/"-separated. */
  path: z.string(),
  title: z.string(),
  kind: z.enum(["rules", "commands", "notes", "docs", "other"]),
  frontmatter: KnowledgeFrontmatter,
  mtime: z.number(),
  size: z.number(),
});
export type KnowledgeDoc = z.infer<typeof KnowledgeDoc>;

export const KnowledgeSearchHit = z.object({ path: z.string(), title: z.string(), kind: KnowledgeDoc.shape.kind, snippet: z.string(), rank: z.number() });
export type KnowledgeSearchHit = z.infer<typeof KnowledgeSearchHit>;

export const MaterializeApplyInput = z.object({
  workspaceId: z.string().min(1).optional(),
  paths: z.array(z.string()).optional(),
  /** relPath → hash of the previewed content; the daemon refuses to write a file whose plan moved since the preview. */
  expected: z.record(z.string(), z.string()).optional(),
  /** Overwrite managed blocks that were edited by hand in the repository file. */
  force: z.boolean().optional(),
});
export type MaterializeApplyInput = z.infer<typeof MaterializeApplyInput>;
