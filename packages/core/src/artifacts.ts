import { createHmac, timingSafeEqual } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Artifact, Task } from "@switchboard/protocol";
import { z } from "zod";
import { mimeFor, safeName } from "./attachments.ts";
import { Db, newId } from "./db.ts";

/** One file at most this big; a folder at most this much in total and this many files. Over → 413, nothing is kept. */
export const MAX_ARTIFACT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ARTIFACT_DIR_BYTES = 50 * 1024 * 1024;
export const MAX_ARTIFACT_DIR_FILES = 1000;
/** A removed artifact stays this long so "undo" works; the boot sweep deletes it after. */
export const ARTIFACT_UNDO_MS = 24 * 60 * 60 * 1000;

/** How long a view key opens a report. The page asks for a new one each time it opens one. */
export const VIEW_KEY_MS = 60 * 60 * 1000;
/** Lives in this process only: a key does not survive a restart (the page asks again), and nothing on disk can mint one. */
const VIEW_SECRET = crypto.getRandomValues(new Uint8Array(32));

const sign = (body: string) => createHmac("sha256", VIEW_SECRET).update(body).digest("base64url");

/**
 * The key in `/artifacts/<key>/…`: `<artifactId>.<expiresMs>.<HMAC-SHA256 of the first two>`. It is the only
 * authorization that route has (it is outside `/api`, whose token never goes in a URL), so it names one artifact
 * and expires; it is not a login.
 */
export function viewKey(artifactId: string, expiresMs: number): string {
  const body = `${artifactId}.${expiresMs}`;
  return `${body}.${sign(body)}`;
}

/** The artifact id a key opens, or why not: 403 forged / malformed, 410 expired. */
export function checkViewKey(key: string, now = Date.now()): { ok: true; id: string } | { ok: false; status: 403 | 410 } {
  const m = /^([A-Za-z0-9_-]+)\.(\d{1,16})\.([A-Za-z0-9_-]{43})$/.exec(key);
  if (!m) return { ok: false, status: 403 };
  const want = Buffer.from(sign(`${m[1]}.${m[2]}`));
  const got = Buffer.from(m[3]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, status: 403 };
  return Number(m[2]) < now ? { ok: false, status: 410 } : { ok: true, id: m[1]! };
}

/** A refusal with the HTTP status it maps to (400 bad input, 403 outside the task, 404 unknown id, 410 source gone, 413 too big). */
export class ArtifactError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Source = { kind: "url"; url: string } | { kind: "file" | "dir"; path: string };

/**
 * Reports a person registered on the Task screen (#1777). A file or folder is copied to
 * `<dir>/<taskId>/<artifactId>/` when registered, so it still opens after the original is deleted or the
 * working copy / temp directory is cleaned up; a URL is only remembered. Only what is inside the task's scope, its
 * working directory or a temp directory can be registered: this is a read of the person's files on their request,
 * not a way to reach `~/.ssh` or the daemon's token. Nothing watches the original; "refresh" copies it again.
 */
export class ArtifactStore {
  constructor(
    private db: Db,
    readonly dir: string,
    private opts: { /** The task's own temp directory (outside `os.tmpdir()` for Codex). */ privateTmp: (taskId: string) => string; /** Paths never registrable, whatever the scope says (the daemon's token and database). */ deny: string[]; tmpRoots: string[] },
  ) {
    mkdirSync(dir, { recursive: true });
    this.recover();
  }

  /** The folder an artifact's copy lives in; the id is a path segment, so one that is not a plain name is refused. */
  folderOf(a: Pick<Artifact, "id" | "taskId">): string {
    for (const seg of [a.taskId, a.id]) if (!seg || seg === "." || seg === ".." || basename(seg) !== seg) throw new ArtifactError(`"${seg}" is not a directory name`, 400);
    return join(this.dir, a.taskId, a.id);
  }

  get(id: string): Artifact | null {
    return this.db.getArtifact(id);
  }

  list(taskId: string): Artifact[] {
    return this.db.listArtifacts(taskId);
  }

  /** Register `source` (an absolute path, a path relative to the task's cwd, or an http(s) URL). The same source again replaces the copy. */
  add(task: Pick<Task, "id" | "cwd" | "scope">, input: { source: string; title?: string }): Artifact {
    const raw = input.source.trim();
    if (!raw) throw new ArtifactError("source is empty", 400);
    const src = this.resolveSource(task, raw);
    const key = src.kind === "url" ? src.url : src.path;
    const same = this.db.listArtifacts(task.id).find((a) => a.source === key);
    const now = Date.now();
    if (src.kind === "url") {
      if (same) return same;
      const a: Artifact = { id: newId("art"), taskId: task.id, title: input.title?.trim() || urlTitle(src.url), kind: "url", source: src.url, entry: null, mime: "text/uri-list", size: 0, removedAt: null, createdAt: now, updatedAt: now };
      this.db.insertArtifact(a);
      return a;
    }
    return this.store(task, src.path, input.title);
  }

  /**
   * The daemon's own copy of one file it knows the path of (the insights report, #1838) — outside the task's scope,
   * so without the scope check; the deny list, the store itself and the size limits apply as always.
   */
  addCopy(task: Pick<Task, "id" | "cwd" | "scope">, path: string, title: string): Artifact {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw new ArtifactError(`${path} does not exist`, 404);
    }
    if (this.opts.deny.flatMap(realOrNone).some((d) => inside(d, real) || inside(real, d))) throw new ArtifactError(`${path} cannot be registered`, 403);
    if (inside(realOrNone(this.dir)[0] ?? this.dir, real)) throw new ArtifactError("the artifacts store itself cannot be registered", 403);
    if (!statSync(real).isFile()) throw new ArtifactError(`${path} is not a file`, 400);
    return this.store(task, real, title);
  }

  /** Copy `path` into the store as the task's artifact; the same path again replaces that artifact's copy and keeps its id. */
  private store(task: Pick<Task, "id">, path: string, title?: string): Artifact {
    const same = this.db.listArtifacts(task.id).find((a) => a.source === path);
    const now = Date.now();
    const id = same?.id ?? newId("art");
    const copied = this.copyInto({ id, taskId: task.id }, path);
    const a: Artifact = {
      id,
      taskId: task.id,
      title: title?.trim() || same?.title || basename(path),
      kind: copied.kind,
      source: path,
      entry: copied.entry,
      mime: artifactMime(copied.entry),
      size: copied.size,
      removedAt: null,
      createdAt: same?.createdAt ?? now,
      updatedAt: now,
    };
    if (same) this.db.updateArtifact(a);
    else this.db.insertArtifact(a);
    return a;
  }

  /**
   * The file `rel` (a URL path below the artifact's folder, still percent-encoded) names, or null if there is none or
   * it is not inside the folder: `..`, an absolute path, a NUL and a symlink (the copy has none, but this does not rely on it) all give null.
   */
  fileOf(a: Artifact, rel: string): string | null {
    if (a.kind === "url") return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rel);
    } catch {
      return null;
    }
    if (decoded.includes("\0") || decoded.includes("\\") || decoded.split("/").includes("..")) return null;
    const root = this.folderOf(a);
    const file = resolve(root, decoded || a.entry || "");
    try {
      const real = realpathSync(file);
      if (!inside(realpathSync(root), real) || !statSync(real).isFile()) return null;
      return real;
    } catch {
      return null;
    }
  }

  /** Hide it; the copy stays for the undo window. */
  remove(id: string): Artifact {
    const a = this.mustGet(id);
    if (a.removedAt !== null) return a; // a repeated remove does not extend the undo window
    const next = { ...a, removedAt: Date.now() };
    this.db.updateArtifact(next);
    return next;
  }

  restore(id: string): Artifact {
    const a = this.mustGet(id);
    const next = { ...a, removedAt: null };
    this.db.updateArtifact(next);
    return next;
  }

  /** Copy the original again. A gone original (410) or one that moved out of scope (403) leaves the old copy untouched. */
  refresh(id: string, task: Pick<Task, "id" | "cwd" | "scope">): Artifact {
    const a = this.mustGet(id);
    if (a.kind === "url") throw new ArtifactError("a URL has no copy to refresh", 400);
    const src = this.resolveSource(task, a.source, true);
    if (src.kind === "url") throw new ArtifactError("a URL has no copy to refresh", 400);
    const copied = this.copyInto(a, src.path);
    const next: Artifact = { ...a, kind: copied.kind, entry: copied.entry, mime: artifactMime(copied.entry), size: copied.size, updatedAt: Date.now() };
    this.db.updateArtifact(next);
    return next;
  }

  /**
   * Boot: finish what a stopped daemon left half done in a task's folder. A copy set aside (`<id>.old`) before its
   * replacement was installed comes back; one whose replacement is in place goes, and so do unfinished temp copies.
   */
  private recover(): void {
    for (const t of readdirSync(this.dir, { withFileTypes: true })) {
      if (!t.isDirectory()) continue;
      const taskDir = join(this.dir, t.name);
      for (const e of readdirSync(taskDir)) {
        const p = join(taskDir, e);
        if (e.startsWith(".tmp-")) rmSync(p, { recursive: true, force: true });
        else if (e.endsWith(".old")) {
          if (existsSync(join(taskDir, e.slice(0, -".old".length)))) rmSync(p, { recursive: true, force: true });
          else renameSync(p, join(taskDir, e.slice(0, -".old".length)));
        }
      }
    }
  }

  /** Delete copies whose undo window ran out (boot). Returns how many went. */
  sweep(now = Date.now()): number {
    let n = 0;
    for (const a of this.db.listArtifactsRemovedBefore(now - ARTIFACT_UNDO_MS)) {
      rmSync(this.folderOf(a), { recursive: true, force: true });
      this.db.deleteArtifact(a.id);
      n++;
    }
    return n;
  }

  private mustGet(id: string): Artifact {
    const a = this.db.getArtifact(id);
    if (!a) throw new ArtifactError(`artifact ${id} not found`, 404);
    return a;
  }

  /** Where `raw` points, and that it is a place a task may register from. `strictGone`: a missing original is 410, not 400. */
  private resolveSource(task: Pick<Task, "id" | "cwd" | "scope">, raw: string, strictGone = false): Source {
    if (/^https?:\/\//i.test(raw)) {
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        throw new ArtifactError(`not a URL: ${raw}`, 400);
      }
      return { kind: "url", url: u.toString() };
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw new ArtifactError("only http(s) URLs and local paths can be registered", 400);
    const abs = isAbsolute(raw) ? resolve(raw) : resolve(task.cwd, raw);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw new ArtifactError(`${abs} does not exist`, strictGone ? 410 : 400);
    }
    const allowed = [task.cwd, ...task.scope, ...this.opts.tmpRoots, this.opts.privateTmp(task.id)].flatMap(realOrNone);
    if (!allowed.some((root) => inside(root, real))) throw new ArtifactError(`${abs} is outside this task's scope, working directory and temp directories`, 403);
    if (this.opts.deny.flatMap(realOrNone).some((d) => inside(d, real) || inside(real, d))) throw new ArtifactError(`${abs} cannot be registered`, 403);
    if (inside(realOrNone(this.dir)[0] ?? this.dir, real)) throw new ArtifactError("the artifacts store itself cannot be registered", 403);
    const st = statSync(real);
    if (st.isFile()) return { kind: "file", path: abs };
    if (st.isDirectory()) return { kind: "dir", path: abs };
    throw new ArtifactError(`${abs} is neither a file nor a folder`, 400);
  }

  /**
   * Copy the file / folder at `path` to the artifact's folder: into a sibling temp folder first and renamed over, so a
   * refusal (too big, no entry page) or a crash leaves the previous copy, or nothing, and never half of one.
   */
  private copyInto(a: Pick<Artifact, "id" | "taskId">, path: string): { kind: "file" | "dir"; entry: string; size: number } {
    const real = realpathSync(path);
    const st = statSync(real);
    const final = this.folderOf(a);
    const tmp = join(this.dir, a.taskId, `.tmp-${newId("t")}`);
    const prepared = st.isFile() ? this.planFile(real, st.size, basename(path)) : this.planDir(real);
    try {
      mkdirSync(tmp, { recursive: true });
      let size = 0;
      for (const f of prepared.files) {
        const to = join(tmp, f.rel);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(f.from, to);
        size += f.size;
      }
      const old = `${final}.old`;
      rmSync(old, { recursive: true, force: true }); // a leftover from an earlier failure
      if (existsSync(final)) renameSync(final, old);
      try {
        renameSync(tmp, final);
      } catch (e) {
        if (existsSync(old) && !existsSync(final)) renameSync(old, final); // the previous copy stays what it was
        throw e;
      }
      try {
        rmSync(old, { recursive: true, force: true });
      } catch {
        /* the replacement is in place; boot removes a leftover set-aside copy */
      }
      return { kind: st.isFile() ? "file" : "dir", entry: prepared.entry, size };
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      if (e instanceof ArtifactError) throw e;
      throw new ArtifactError(`copy failed: ${(e as Error).message}`, 500);
    }
  }

  private planFile(from: string, size: number, rawName: string): { files: Array<{ from: string; rel: string; size: number }>; entry: string } {
    if (size > MAX_ARTIFACT_FILE_BYTES) throw new ArtifactError(`${rawName} is ${size} bytes; max ${MAX_ARTIFACT_FILE_BYTES} per file`, 413);
    const name = safeName(rawName);
    return { files: [{ from, rel: name, size }], entry: name };
  }

  private planDir(root: string): { files: Array<{ from: string; rel: string; size: number }>; entry: string } {
    const files: Array<{ from: string; rel: string; size: number }> = [];
    let total = 0;
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
        const p = join(d, e.name);
        const st = lstatSync(p);
        if (st.isSymbolicLink()) continue; // never followed, never copied: it could point anywhere
        if (st.isDirectory()) walk(p);
        else if (st.isFile()) {
          if (st.size > MAX_ARTIFACT_FILE_BYTES) throw new ArtifactError(`${relative(root, p)} is ${st.size} bytes; max ${MAX_ARTIFACT_FILE_BYTES} per file`, 413);
          total += st.size;
          if (files.length + 1 > MAX_ARTIFACT_DIR_FILES) throw new ArtifactError(`the folder has more than ${MAX_ARTIFACT_DIR_FILES} files`, 413);
          if (total > MAX_ARTIFACT_DIR_BYTES) throw new ArtifactError(`the folder is over ${MAX_ARTIFACT_DIR_BYTES} bytes`, 413);
          files.push({ from: p, rel: relative(root, p), size: st.size });
        }
      }
    };
    walk(root);
    const top = files.map((f) => f.rel).filter((r) => !r.includes(sep));
    const htmls = top.filter((r) => /\.html?$/i.test(extname(r)));
    const entry = top.includes("index.html") ? "index.html" : htmls.length === 1 ? htmls[0]! : undefined;
    if (!entry) throw new ArtifactError(htmls.length ? `which page opens? the folder has several: ${htmls.join(", ")} (rename one to index.html)` : "the folder has no index.html and no single .html file at its top", 400);
    return { files, entry };
  }
}

/** What a report is made of: the attachment types plus the web ones (a page and what it loads). */
const WEB_TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  xhtml: "application/xhtml+xml",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  xml: "application/xml",
  ico: "image/x-icon",
  avif: "image/avif",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp4: "video/mp4",
  webm: "video/webm",
  tsv: "text/tab-separated-values",
  toml: "text/plain",
  ts: "text/plain",
  tsx: "text/plain",
  diff: "text/plain",
  patch: "text/plain",
};

export function artifactMime(name: string): string {
  return WEB_TYPES[extname(name).toLowerCase().slice(1)] ?? mimeFor(name);
}

/** A page with no charset of its own is read as Latin-1 by a browser: reports are written in UTF-8, so say so for text types. */
export function withCharset(mime: string): string {
  return mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime === "application/xhtml+xml" || mime === "image/svg+xml" ? `${mime}; charset=utf-8` : mime;
}

function realOrNone(p: string): string[] {
  try {
    return [realpathSync(p)];
  } catch {
    return [];
  }
}

/** `child` is `root` or below it (compared on whole path segments). */
function inside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function urlTitle(url: string): string {
  const u = new URL(url);
  const last = u.pathname.split("/").filter(Boolean).pop();
  return last ? `${u.host}/${last}` : u.host;
}

/** What an agent's `switchboard-artifact` fence carries (#1778): the file or folder to register (absolute, or relative to the task's working directory) and an optional title. */
export const ArtifactReport = z.object({ path: z.string().min(1).max(4096), title: z.string().max(200).optional() });
export type ArtifactReport = z.infer<typeof ArtifactReport>;

/** One fence read: the report, or why its body is not one — a broken fence is told on the Task, not dropped (#1778). */
export type ArtifactFence = { ok: true; report: ArtifactReport } | { ok: false; why: string };

export function parseArtifactFence(json: string): ArtifactFence {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, why: "JSON として読めません" };
  }
  const r = ArtifactReport.safeParse(value);
  return r.success ? { ok: true, report: r.data } : { ok: false, why: `path と title の形ではありません（${r.error.issues.map((i) => `${i.path.join(".") || "本文"}: ${i.message}`).join("; ").slice(0, 200)}）` };
}

/** What every runner start is told (#1778): how to hand a report over. Short: it goes before the prompt, after the stop report's paragraph. */
export function artifactPrompt(): string {
  return [
    "[Switchboard: 成果物の登録]",
    "レポートや図など利用者に見せたいファイルを作ったら、返答の中に次のフェンスを書いてください。Switchboard がその Task の成果物として写し、画面で開けるようにします（パスは絶対パスか作業ディレクトリからの相対パス。題は任意。HTML が画像や CSS を相対パスで参照するならフォルダを登録する。同じパスをもう一度登録すると中身が新しくなる）:",
    "```switchboard-artifact",
    '{"path":"<ファイルかフォルダ>","title":"<題>"}',
    "```",
  ].join("\n");
}
