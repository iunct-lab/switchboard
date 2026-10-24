import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

/**
 * Files DAK made (#124): `content.parts[].inlineData` in a finished (non-partial) event, and the artifacts an event
 * names in `actions.artifactDelta` ({ name: version }), fetched from ADK's REST API. Each is written into the task's
 * attachment directory under a name that is not taken yet (a file there is never overwritten) and returned by path;
 * the adapter emits `artifact(file)` and the daemon registers it as an attachment. Only the version the event names
 * is fetched (no history, no streaming). A `tool_output_*` artifact is DAK's own spill of a long tool output (its
 * harness saves it, no tool hands one to the person), so it is not fetched. Without `attachmentDir` nothing is written. One file that cannot be had
 * (fetch refused, no bytes in the reply, the write failed) is an `error` entry; the others still come. `signal` (the
 * turn's abort) stops a fetch in flight.
 */
export async function collectArtifacts(ev: unknown, ctx: { sessionUrl: string; attachmentDir?: string; timeoutMs: number; signal?: AbortSignal }): Promise<Array<{ path: string } | { error: string }>> {
  const dir = ctx.attachmentDir;
  if (!dir || !ev || typeof ev !== "object") return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = ev as any;
  const out: Array<{ path: string } | { error: string }> = [];
  // Partial events repeat in the final one: only the final event's parts are files.
  const parts: unknown[] = e.partial === true || !Array.isArray(e.content?.parts) ? [] : e.content.parts;
  for (const p of parts) {
    const bytes = (p as { inlineData?: unknown }).inlineData ? partBytes(p) : undefined;
    if (!bytes) continue;
    const name = `inline${EXT[bytes.mime] ?? ".bin"}`;
    try {
      out.push({ path: write(dir, name, bytes.data) });
    } catch (err) {
      out.push({ error: `${name}: ${String((err as Error).message ?? err)}` });
    }
  }
  const delta = e.actions?.artifactDelta;
  if (delta && typeof delta === "object") {
    for (const [name, version] of Object.entries(delta as Record<string, unknown>)) {
      if (name.startsWith(SPILL_PREFIX)) continue;
      try {
        const q = typeof version === "number" ? `?version=${version}` : "";
        const r = await fetch(`${ctx.sessionUrl}/artifacts/${encodeURIComponent(name)}${q}`, { signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]) : AbortSignal.timeout(ctx.timeoutMs) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const bytes = partBytes(await r.json());
        if (!bytes) throw new Error("the reply has no inlineData or text");
        out.push({ path: write(dir, name, bytes.data) });
      } catch (err) {
        out.push({ error: `${name}: ${String((err as Error).message ?? err)}` });
      }
    }
  }
  return out;
}

/** The name DAK's harness gives the artifact it saves for a long tool output (#124: the only artifacts DAK makes today). */
const SPILL_PREFIX = "tool_output_";

/** A Part's bytes: `inlineData { mimeType, data: base64 }` or a text part. */
function partBytes(p: unknown): { mime: string; data: Buffer } | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const x = p as any;
  if (x?.inlineData && typeof x.inlineData.data === "string") return { mime: String(x.inlineData.mimeType ?? ""), data: Buffer.from(x.inlineData.data, "base64") };
  if (typeof x?.text === "string" && !x.thought) return { mime: "text/plain", data: Buffer.from(x.text, "utf8") };
  return undefined;
}

/**
 * Write under `dir` as the artifact's own file name — its last path segment, without leading dots (an ADK name such
 * as `user:report.txt` or `../x` cannot leave the directory) — or, when that is taken, `<stem>-2<ext>`, `-3`, ….
 */
function write(dir: string, name: string, data: Buffer): string {
  const base = basename(name.replace(/\\/g, "/")).replace(/^[.:]+/, "").replace(/^user:/, "") || "artifact";
  const ext = extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  mkdirSync(dir, { recursive: true });
  let path = join(dir, base);
  for (let n = 2; existsSync(path); n++) path = join(dir, `${stem}-${n}${ext}`);
  writeFileSync(path, data, { flag: "wx" });
  return path;
}

const EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "application/json": ".json",
};
