/**
 * The model tables the installed CLIs carry (PBI #248, #1401): claude — the table embedded in the installed executable;
 * codex — `codex debug models --bundled`, the table shipped in the binary (without `--bundled` it refreshes over the
 * network, so the flag is always given). Local data only: no vendor API, no API key (#155). Read by
 * `scripts/check-models.ts` and by the settings screen's 「CLI の表を読む」 (GET /api/settings/model-candidates), only
 * when asked: the claude executable is about 240 MB.
 */
import { realpathSync } from "node:fs";
import type { ModelOption } from "@switchboard/protocol";

export type CatalogRunner = "claude" | "codex";

/**
 * Ids a person has looked at and left out of the bundled lists (CLAUDE_MODELS / CODEX_MODELS) on purpose (2026-10-30,
 * claude 2.1.312 / codex-cli 0.166.0). The settings' 載せない list of a runner that has none saved yet.
 */
export const SHIPPED_HIDDEN_MODELS: Record<CatalogRunner, string[]> = {
  claude: [
    "claude-3-5-haiku", "claude-3-5-sonnet", "claude-3-7-sonnet",
    "claude-fable-5",
    "claude-mythos-5", "claude-mythos-5-1",
    "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5",
    "claude-sonnet-4-0", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-sonnet-5",
  ],
  codex: ["gpt-6.1-terra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
};

const CLAUDE_ENTRY = /\{id:"(claude-[a-z0-9-]+)",family:"([a-z]+)",display_name:"([^"]+)"/g;

/** The models of the table embedded in the claude executable: `{id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5",…}`, once each. */
export function claudeCatalog(text: string): ModelOption[] {
  const seen = new Map<string, ModelOption>();
  for (const m of text.matchAll(CLAUDE_ENTRY)) if (!seen.has(m[1]!)) seen.set(m[1]!, { value: m[1]!, label: m[3]! });
  return [...seen.values()];
}

/**
 * The embedded table's entries, scanned chunk by chunk: the executable is about 240 MB, and one string of it got the
 * script OOM-killed on a 3.8 GB host. The tail of each chunk is carried into the next so an entry cut in two is found.
 */
export async function claudeTableText(file: string): Promise<string> {
  const found: string[] = [];
  let carry = "";
  for await (const chunk of Bun.file(file).stream()) {
    const text = carry + Buffer.from(chunk).toString("latin1");
    for (const m of text.matchAll(CLAUDE_ENTRY)) found.push(m[0]);
    carry = text.slice(-512);
  }
  return found.join("\n");
}

/** The models of `codex debug models --bundled` the CLI offers (`visibility: "list"`; `"hide"` is internal). */
export function codexCatalog(json: string): ModelOption[] {
  const models = (JSON.parse(json) as { models?: { slug?: unknown; display_name?: unknown; visibility?: unknown }[] }).models ?? [];
  return models
    .filter((m) => m.visibility === "list" && typeof m.slug === "string")
    .map((m) => ({ value: m.slug as string, label: typeof m.display_name === "string" && m.display_name ? m.display_name : (m.slug as string) }));
}

/** The CLI's models that are neither listed nor hidden, in the table's order. */
export function modelCandidates(catalog: ModelOption[], listed: string[], hidden: string[]): ModelOption[] {
  return catalog.filter((m) => !listed.includes(m.value) && !hidden.includes(m.value));
}

/** Where each CLI's table comes from. null = the CLI is not installed. */
export interface Readers {
  claude(): Promise<string | null>;
  codex(): Promise<string | null>;
}

/** The installed CLIs found on `path` (the process's PATH unless given). */
export function hostReaders(path = process.env.PATH ?? ""): Readers {
  return {
    async claude() {
      const bin = Bun.which("claude", { PATH: path });
      return bin ? claudeTableText(realpathSync(bin)) : null;
    },
    async codex() {
      const bin = Bun.which("codex", { PATH: path });
      if (!bin) return null;
      const p = Bun.spawn([bin, "debug", "models", "--bundled"], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code !== 0) throw new Error(`codex debug models --bundled exited ${code}: ${err.trim()}`);
      return out;
    },
  };
}
