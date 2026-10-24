import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { KnowledgeDoc, KnowledgeFrontmatter, KnowledgeSearchHit } from "@switchboard/protocol";
import { KnowledgeFrontmatter as FrontmatterSchema } from "@switchboard/protocol";
import type { Db } from "./db.ts";

/**
 * Knowledge Store (proposal Screen C, issue #7).
 * The source of truth is ONE Markdown folder the user owns (default ~/Knowledge, ideally a git repo).
 * sqlite (FTS5) is only an index: it can be dropped and rebuilt from the folder at any time.
 *
 * Layout (by convention, not enforced):  rules/  commands/  notes/  docs/
 * Frontmatter: targets, repo(s), approval, title, tags — see KnowledgeFrontmatter in the protocol.
 */
export const KNOWLEDGE_README = `# Knowledge

Switchboard の正本フォルダ。Markdown + frontmatter だけを置く。sqlite の索引は派生物なので、このフォルダを git で管理すれば十分。

- rules/     エージェント向けの規約。frontmatter の targets で CLAUDE.md / AGENTS.md / .claude/commands に書き出す先を決める
- commands/  スラッシュコマンド（.claude/commands/*.md に書き出される）
- notes/     Inbox。リポジトリに紐づかないメモ。後から Task に昇格できる
- docs/      まだリポジトリに置いていないドキュメント

frontmatter 例:
\`\`\`
---
title: DAK の規約
targets: [claude, codex, agents-md]
repo: /path/to/repo
approval: { confirm: ["docker-compose*.yml", ".github/**"], allow: ["*.md"] }
tags: [dak]
---
\`\`\`
`;

const IGNORE = new Set([".git", "node_modules", ".obsidian", ".DS_Store"]);
/** A safety net for platforms where recursive fs.watch misses events (new subdirectories on Linux). */
const SAFETY_RESCAN_MS = 5 * 60_000;

export interface ScanResult {
  indexed: number;
  removed: number;
  /** Files that could not be indexed this pass (unreadable, vanished mid-scan). */
  errors: string[];
}

export class KnowledgeStore {
  private watcher: FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private safety: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(r: ScanResult) => void>();
  /** True when the folder could not be prepared; the store then serves an empty index instead of failing the daemon. */
  readonly disabled: string | null;

  constructor(
    readonly dir: string,
    private db: Db,
  ) {
    this.disabled = ensureLayout(dir);
  }

  /* ---------- paths ---------- */

  /**
   * Canonicalize a store-relative path ("/"-separated, no ".", "..", empty segments, backslashes, dotfiles or ignored
   * dirs) and resolve it inside the folder. Existing paths are also checked after realpath so a symlink cannot point
   * out of the folder.
   */
  canonical(rel: string): string {
    if (typeof rel !== "string" || rel.includes("\\") || rel.startsWith("/") || rel.includes("\0")) throw new Error(`invalid knowledge path: ${rel}`);
    const norm = posix.normalize(rel);
    const parts = norm.split("/");
    if (!norm || norm === "." || parts.some((p) => p === ".." || p === "." || p === "" || p.startsWith(".") || IGNORE.has(p))) throw new Error(`invalid knowledge path: ${rel}`);
    return norm;
  }

  resolve(rel: string): string {
    const norm = this.canonical(rel);
    const abs = resolve(this.dir, norm);
    if (!(abs === this.dir || abs.startsWith(this.dir + sep))) throw new Error(`path escapes the knowledge folder: ${rel}`);
    if (existsSync(abs)) {
      const real = realpathSync(abs);
      const root = realpathSync(this.dir);
      if (!(real === root || real.startsWith(root + sep))) throw new Error(`path escapes the knowledge folder: ${rel}`);
    }
    return abs;
  }

  /* ---------- index ---------- */

  /** Full scan: (re)index every *.md under the folder, drop rows whose file is gone. One bad file never aborts the pass. */
  scan(): ScanResult {
    const files = new Map<string, { mtime: number; size: number }>();
    if (!this.disabled) walk(this.dir, this.dir, files);
    const known = new Map(this.db.knowledgeList().map((d) => [d.path, d] as const));
    let indexed = 0;
    let removed = 0;
    const errors: string[] = [];
    for (const [rel, st] of files) {
      const prev = known.get(rel);
      if (prev && prev.mtime === st.mtime && prev.size === st.size) continue;
      try {
        this.indexFile(rel, st);
        indexed++;
      } catch (e) {
        errors.push(`${rel}: ${String((e as Error).message ?? e)}`);
      }
    }
    for (const rel of known.keys()) {
      if (!files.has(rel)) {
        this.db.knowledgeDelete(rel);
        removed++;
      }
    }
    const r = { indexed, removed, errors };
    if (indexed || removed) for (const l of this.listeners) l(r);
    return r;
  }

  private indexFile(rel: string, st?: { mtime: number; size: number }) {
    const abs = this.resolve(rel);
    const s = st ?? statOf(abs);
    const raw = readFileSync(abs, "utf8");
    const { frontmatter, body, title } = parseDocument(raw, rel);
    const doc: KnowledgeDoc = { path: rel, title, kind: kindOf(rel), frontmatter, mtime: s.mtime, size: s.size };
    this.db.knowledgeUpsert(doc, body);
  }

  list(): KnowledgeDoc[] {
    return this.db.knowledgeList();
  }

  search(q: string, limit = 30): KnowledgeSearchHit[] {
    const { fts, like } = toFtsQuery(q);
    if (!fts && like.length === 0) return [];
    return this.db.knowledgeSearch(fts, like, limit);
  }

  read(rel: string): { doc: KnowledgeDoc; content: string; body: string } {
    const norm = this.canonical(rel);
    if (!norm.endsWith(".md")) throw new Error("not found");
    const abs = this.resolve(norm);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error("not found");
    const content = readFileSync(abs, "utf8");
    const { frontmatter, body, title } = parseDocument(content, norm);
    const s = statOf(abs);
    return { doc: { path: norm, title, kind: kindOf(norm), frontmatter, mtime: s.mtime, size: s.size }, content, body };
  }

  /** Write a document (creating folders) and index it immediately. Text stays text: the file is the truth. */
  write(rel: string, content: string): KnowledgeDoc {
    const norm = this.canonical(rel);
    if (!norm.endsWith(".md")) throw new Error("only .md files belong in the knowledge folder");
    if (this.disabled) throw new Error(`knowledge folder unavailable: ${this.disabled}`);
    const abs = this.resolve(norm);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.indexFile(norm);
    const doc = this.db.knowledgeGet(norm);
    if (!doc) throw new Error("index failed");
    // API writes are indexed here with the same mtime/size the watcher will see, so tell listeners ourselves.
    const r = { indexed: 1, removed: 0, errors: [] };
    for (const l of this.listeners) l(r);
    return doc;
  }

  exists(rel: string): boolean {
    try {
      return existsSync(this.resolve(rel));
    } catch {
      return false;
    }
  }

  /* ---------- watching ---------- */

  onChange(l: (r: ScanResult) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /**
   * Watch the folder (recursive; falls back to a 30 s rescan where recursive watch is unsupported). Debounced.
   * Independently, a 5-minute safety rescan covers watch implementations that miss events silently.
   */
  watch(debounceMs = 300): void {
    if (this.watcher || this.disabled) return;
    const schedule = () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        try {
          this.scan();
        } catch {
          /* transient fs state; next change rescans */
        }
      }, debounceMs);
    };
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_ev, name) => {
        // .git churn (index.lock etc.) is not knowledge; skip it to avoid rescans on every git command.
        if (typeof name === "string" && name.split(/[\\/]/).some((p) => IGNORE.has(p))) return;
        schedule();
      });
      this.watcher.on("error", () => this.fallbackPolling(schedule));
    } catch {
      this.fallbackPolling(schedule);
    }
    this.safety = setInterval(schedule, SAFETY_RESCAN_MS);
    this.safety.unref?.();
  }

  private fallbackPolling(schedule: () => void) {
    this.watcher?.close();
    this.watcher = null;
    const iv = setInterval(schedule, 30_000);
    iv.unref?.();
    this.watcher = { close: () => clearInterval(iv) } as unknown as FSWatcher;
  }

  close() {
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.safety) clearInterval(this.safety);
  }

  /* ---------- git (informational only) ---------- */

  async gitStatus(): Promise<{ isRepo: boolean; clean: boolean | null }> {
    if (this.disabled || !existsSync(join(this.dir, ".git"))) return { isRepo: false, clean: null };
    try {
      const p = Bun.spawn(["git", "status", "--porcelain"], { cwd: this.dir, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(p.stdout).text();
      const code = await p.exited;
      return { isRepo: true, clean: code === 0 ? out.trim() === "" : null };
    } catch {
      return { isRepo: true, clean: null };
    }
  }
}

/* ---------- helpers ---------- */

/** Create the folder layout; returns an error message instead of throwing when the folder cannot be prepared. */
export function ensureLayout(dir: string): string | null {
  try {
    const fresh = !existsSync(dir);
    for (const d of ["", "rules", "commands", "notes", "docs"]) mkdirSync(join(dir, d), { recursive: true });
    if (fresh) writeFileSync(join(dir, "README.md"), KNOWLEDGE_README);
    return null;
  } catch (e) {
    return String((e as Error).message ?? e);
  }
}

function statOf(abs: string): { mtime: number; size: number } {
  const st = statSync(abs);
  return { mtime: Math.round(st.mtimeMs), size: st.size };
}

function walk(root: string, dir: string, out: Map<string, { mtime: number; size: number }>) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (IGNORE.has(e.name) || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    // Symlinks are skipped on purpose: the index only ever reflects files that physically live in the folder.
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(root, p, out);
    else if (e.isFile() && e.name.endsWith(".md")) {
      try {
        const st = lstatSync(p);
        out.set(relative(root, p).split(sep).join("/"), { mtime: Math.round(st.mtimeMs), size: st.size });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }
}

export function kindOf(rel: string): KnowledgeDoc["kind"] {
  const top = rel.split("/")[0];
  return top === "rules" || top === "commands" || top === "notes" || top === "docs" ? top : "other";
}

/**
 * Split YAML frontmatter from the body. The frontmatter must be a mapping; unknown keys pass through, known keys are
 * validated. Handles a BOM, CRLF and an empty `---\n---` block.
 */
export function parseDocument(raw: string, rel = "doc.md"): { frontmatter: KnowledgeFrontmatter; body: string; title: string } {
  let frontmatter: KnowledgeFrontmatter = {};
  let body = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const m = body.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?\n?/m);
  if (m) {
    body = body.slice(m[0].length);
    try {
      const y = m[1]!.trim() ? parseYaml(m[1]!) : {};
      if (y === null || typeof y !== "object" || Array.isArray(y)) {
        frontmatter = { _invalid: "frontmatter must be a mapping (key: value)" };
      } else {
        const parsed = FrontmatterSchema.safeParse(y);
        frontmatter = parsed.success ? parsed.data : { ...(y as Record<string, unknown>), _invalid: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
      }
    } catch (e) {
      frontmatter = { _invalid: `yaml: ${String((e as Error).message ?? e)}` };
    }
  }
  const h1 = body.match(/^#\s+(.+?)\s*$/m)?.[1];
  const fmTitle = frontmatter.title;
  const title = (typeof fmTitle === "string" && fmTitle.trim()) || h1 || rel.split("/").pop()!.replace(/\.md$/, "");
  return { frontmatter, body, title };
}

/**
 * Turn free text into an FTS5 query for the trigram index plus LIKE filters. Trigram needs ≥ 3 characters per term
 * (code points, not UTF-16 units); shorter terms — common two-kanji words — become substring `LIKE` filters so they
 * still narrow the result instead of silently vanishing.
 */
export function toFtsQuery(q: string): { fts: string; like: string[] } {
  const words = q
    .split(/\s+/)
    .map((w) => w.replace(/["*]/g, "").trim())
    .filter(Boolean);
  const long = words.filter((w) => [...w].length >= 3);
  const short = words.filter((w) => [...w].length < 3);
  return { fts: long.map((w) => `"${w}"`).join(" AND "), like: short };
}
