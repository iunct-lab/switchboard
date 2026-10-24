import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { KnowledgeDoc, KnowledgeTarget, Workspace } from "@switchboard/protocol";
import { unifiedDiff } from "./diff.ts";
import { type KnowledgeStore } from "./knowledge.ts";

/**
 * Materializer (proposal Screen C, right half; issue #8).
 * Knowledge documents declare `targets` in frontmatter; the materializer writes them into the files each tool reads:
 *   claude     → ~/.claude/CLAUDE.md
 *   agents-md  → ~/.codex/AGENTS.md    (codex is an alias)
 * https://learn.chatgpt.com/docs/agent-configuration/agents-md
 *   commands   → ~/.claude/commands/<path under commands/>.md   (docs under commands/ default to this)
 * Generated text lives inside managed blocks; anything outside the blocks is the user's and is preserved verbatim.
 *
 *   <!-- switchboard:managed rules/dak.md @ 9f2c1a -->
 *   …body…
 *   <!-- /switchboard:managed -->
 *
 * Markers are recognized only as whole lines, and never inside a fenced code block of the handwritten text, so a
 * document *about* managed blocks does not lose its examples.
 */
const OPEN_LINE = /^<!-- switchboard:managed (\S+) @ (\S+) -->\s*$/;
const CLOSE_LINE = /^<!-- \/switchboard:managed -->\s*$/;
const FENCE = /^(```|~~~)/;

export interface ManagedBlock {
  source: string; // knowledge path
  hash: string;
  body: string;
}

/** Source paths are encoded so a path with spaces still round-trips through the single-token marker. */
export function encodeSource(s: string): string {
  return encodeURIComponent(s).replace(/%2F/g, "/");
}
export function decodeSource(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function renderBlock(b: ManagedBlock): string {
  return `<!-- switchboard:managed ${encodeSource(b.source)} @ ${b.hash} -->\n${b.body}\n<!-- /switchboard:managed -->\n`;
}

type Segment = { kind: "text"; text: string } | { kind: "block"; block: ManagedBlock; raw: string };

/** Split a file into handwritten text and managed blocks, line by line, fence-aware for the handwritten parts. */
export function segment(content: string): Segment[] {
  const lines = content.split("\n");
  // A trailing "" after the final newline is an artifact of split; remember whether the file ended with "\n".
  const endsWithNl = content.endsWith("\n");
  if (endsWithNl) lines.pop();
  const out: Segment[] = [];
  let text: string[] = [];
  let inFence: string | null = null;
  const flushText = () => {
    if (text.length) out.push({ kind: "text", text: text.join("\n") + "\n" });
    text = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = line.match(FENCE)?.[1];
    if (fence) inFence = inFence === null ? fence : inFence === fence ? null : inFence;
    const open = inFence === null ? line.match(OPEN_LINE) : null;
    if (!open) {
      text.push(line);
      continue;
    }
    let j = i + 1;
    while (j < lines.length && !CLOSE_LINE.test(lines[j]!)) j++;
    if (j >= lines.length) {
      // No close marker: not a block, keep as text.
      text.push(line);
      continue;
    }
    flushText();
    const body = lines.slice(i + 1, j).join("\n");
    out.push({ kind: "block", block: { source: decodeSource(open[1]!), hash: open[2]!, body }, raw: lines.slice(i, j + 1).join("\n") + "\n" });
    i = j;
  }
  if (text.length) out.push({ kind: "text", text: text.join("\n") + (endsWithNl || out.length ? "\n" : "") });
  return out;
}

export interface Split {
  /** Content with every managed block removed (the user's own text). */
  handwritten: string;
  blocks: ManagedBlock[];
}

export function splitManaged(content: string): Split {
  const segs = segment(content);
  return { handwritten: segs.filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text").map((s) => s.text).join(""), blocks: segs.filter((s): s is Extract<Segment, { kind: "block" }> => s.kind === "block").map((s) => s.block) };
}

/**
 * Rebuild a target file: keep the handwritten text, replace each existing managed block in place, drop blocks whose
 * source no longer targets this file, append new blocks at the end. Rendering the same input twice is a no-op.
 */
export function renderFile(current: string | null, blocks: ManagedBlock[]): string {
  const bySource = new Map(blocks.map((b) => [b.source, b] as const));
  const seen = new Set<string>();
  let out = "";
  for (const seg of segment(current ?? "")) {
    if (seg.kind === "text") {
      out += seg.text;
      continue;
    }
    const next = bySource.get(seg.block.source);
    if (next && !seen.has(seg.block.source)) {
      out += renderBlock(next);
      seen.add(seg.block.source);
    }
  }
  const rest = blocks.filter((b) => !seen.has(b.source));
  if (rest.length) {
    if (out.length && !out.endsWith("\n")) out += "\n";
    if (out.trim().length && !out.endsWith("\n\n")) out += "\n";
    out += rest.map(renderBlock).join("\n");
  }
  return out;
}

export function contentHash(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 8);
}

/** Which user-level files a document feeds, given its frontmatter and location. */
export function targetsOf(doc: KnowledgeDoc): Array<{ target: KnowledgeTarget; relPath: string }> {
  const declared = doc.frontmatter.targets ?? (doc.kind === "commands" ? (["commands"] as KnowledgeTarget[]) : []);
  const out = new Map<string, { target: KnowledgeTarget; relPath: string }>();
  for (const t of declared) {
    if (t === "claude") out.set(".claude/CLAUDE.md", { target: t, relPath: ".claude/CLAUDE.md" });
    else if (t === "agents-md" || t === "codex") out.set(".codex/AGENTS.md", { target: "agents-md", relPath: ".codex/AGENTS.md" });
    else if (t === "commands") {
      // commands/review.md → .claude/commands/review.md; commands/dak/triage.md → .claude/commands/dak/triage.md (namespaced)
      const under = doc.path.startsWith("commands/") ? doc.path.slice("commands/".length) : doc.path.split("/").pop()!;
      const rel = `.claude/commands/${under}`;
      out.set(rel, { target: t, relPath: rel });
    }
  }
  return [...out.values()];
}

/** Does this document apply to the workspace? No repo(s) in frontmatter = global. Paths must match exactly (after normalization). */
export function appliesTo(doc: KnowledgeDoc, ws: Workspace): boolean {
  const repos = [...(doc.frontmatter.repo ? [doc.frontmatter.repo] : []), ...(doc.frontmatter.repos ?? [])];
  if (repos.length === 0) return true;
  const target = canonicalDir(ws.path);
  return repos.some((r) => canonicalDir(r) === target);
}

function canonicalDir(p: string): string {
  const abs = resolve(p).replace(/[\\/]+$/, "") || sep;
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

export interface TargetPlan {
  relPath: string;
  abs: string;
  target: KnowledgeTarget;
  sources: string[];
  exists: boolean;
  current: string | null;
  next: string;
  /** new: file will be created · changed · unchanged · removed: nothing targets it any more and no handwritten text remains */
  status: "new" | "changed" | "unchanged" | "removed";
  /** Sources whose managed block was edited by hand in the repo file (hash in the marker ≠ hash of the body). */
  conflicts: string[];
  handwrittenBytes: number;
  diff: string;
  /** Hash of `next`; apply() can be told to expect it so it never writes something the user did not preview. */
  hash: string;
}

export interface MaterializePlan {
  files: TargetPlan[];
  warnings: Array<{ path: string; message: string }>;
}

export function scopedWarnings(store: KnowledgeStore): MaterializePlan["warnings"] {
  return store.list().filter((d) => !d.frontmatter._invalid && isRepoScoped(d) && targetsOf(d).length > 0)
    .map((d) => ({ path: d.path, message: "リポジトリ指定のルールは書き出さない" }));
}

export function plan(store: KnowledgeStore, opts: { home: string; workspace?: Workspace }): MaterializePlan {
  const root = opts.workspace?.path ?? opts.home;
  if (opts.workspace && !existsSync(root)) throw new Error("workspace directory does not exist");
  const docs = opts.workspace ? [] : store.list()
    .filter((d) => !d.frontmatter._invalid && !isRepoScoped(d))
    .sort((a, b) => a.path.localeCompare(b.path));
  const byFile = new Map<string, { target: KnowledgeTarget; blocks: ManagedBlock[] }>();
  for (const d of docs) {
    for (const t of targetsOf(d)) {
      const body = store.read(d.path).body.replace(/\s+$/, "");
      if (body.split("\n").some((l) => CLOSE_LINE.test(l) || OPEN_LINE.test(l))) throw new Error(`${d.path}: a line of the body is itself a managed-block marker`);
      const entry = byFile.get(t.relPath) ?? { target: t.target, blocks: [] };
      entry.blocks.push({ source: d.path, hash: contentHash(body), body });
      byFile.set(t.relPath, entry);
    }
  }
  // Files that carry managed blocks today but are no longer targeted must be cleaned up too.
  const candidates = opts.workspace ? ["CLAUDE.md", "AGENTS.md"] : [".claude/CLAUDE.md", ".codex/AGENTS.md"];
  for (const rel of [...candidates, ...listCommandFiles(root)]) {
    if (byFile.has(rel)) continue;
    const abs = join(root, rel);
    if (existsSync(abs) && segment(readFileSync(abs, "utf8")).some((s) => s.kind === "block")) {
      byFile.set(rel, { target: rel.endsWith("AGENTS.md") ? "agents-md" : rel.endsWith("CLAUDE.md") ? "claude" : "commands", blocks: [] });
    }
  }
  const out: TargetPlan[] = [];
  for (const [relPath, { target, blocks }] of byFile) {
    const abs = join(root, relPath);
    const exists = existsSync(abs);
    const current = exists ? readFileSync(abs, "utf8") : null;
    const next = renderFile(current, blocks);
    const existing = current ? splitManaged(current) : { handwritten: "", blocks: [] };
    const conflicts = existing.blocks.filter((b) => b.hash !== contentHash(b.body) && blocks.some((n) => n.source === b.source && n.hash !== contentHash(b.body))).map((b) => b.source);
    const status: TargetPlan["status"] = !exists ? "new" : next === current ? "unchanged" : next.trim() === "" ? "removed" : "changed";
    out.push({
      relPath,
      abs,
      target,
      sources: blocks.map((b) => b.source),
      exists,
      current,
      next,
      status,
      conflicts,
      handwrittenBytes: Buffer.byteLength(existing.handwritten.trim(), "utf8"),
      diff: status === "unchanged" ? "" : unifiedDiff(current ?? "", next, relPath),
      hash: contentHash(next),
    });
  }
  return { files: out.sort((a, b) => a.relPath.localeCompare(b.relPath)), warnings: opts.workspace ? [] : scopedWarnings(store) };
}

function isRepoScoped(d: KnowledgeDoc): boolean {
  return !!d.frontmatter.repo || !!d.frontmatter.repos?.length;
}

function listCommandFiles(root: string): string[] {
  const dir = join(root, ".claude", "commands");
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith(".md")) out.push(relative(root, p).split(sep).join("/"));
    }
  }
  return out;
}

export interface ApplyOptions {
  /** Only these files. */
  paths?: string[];
  /** relPath → hash of the `next` the caller previewed; a mismatch (the plan moved) is refused. */
  expected?: Record<string, string>;
  /** Also overwrite blocks that were edited by hand in the repo file. */
  force?: boolean;
}

export interface ApplyResult {
  written: string[];
  removed: string[];
  /** Skipped because of a hand-edited block (needs force) or a stale preview (hash mismatch). */
  skipped: Array<{ relPath: string; reason: "conflict" | "stale" }>;
}

export function apply(plans: TargetPlan[], opts: ApplyOptions = {}): ApplyResult {
  const res: ApplyResult = { written: [], removed: [], skipped: [] };
  for (const p of plans) {
    if (p.status === "unchanged") continue;
    if (opts.paths && !opts.paths.includes(p.relPath)) continue;
    if (opts.expected && opts.expected[p.relPath] !== undefined && opts.expected[p.relPath] !== p.hash) {
      res.skipped.push({ relPath: p.relPath, reason: "stale" });
      continue;
    }
    if (p.conflicts.length && !opts.force) {
      res.skipped.push({ relPath: p.relPath, reason: "conflict" });
      continue;
    }
    if (p.status === "removed") {
      rmSync(p.abs, { force: true });
      res.removed.push(p.relPath);
      continue;
    }
    mkdirSync(dirname(p.abs), { recursive: true });
    writeFileSync(p.abs, p.next);
    res.written.push(p.relPath);
  }
  return res;
}

export { unifiedDiff };
