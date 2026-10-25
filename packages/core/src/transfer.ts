import { Database } from "bun:sqlite";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, closeSync, cpSync, createWriteStream, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdCompress, type ZstdCompress } from "node:zlib";
import type { CoreConfig } from "./config.ts";

/**
 * Moving the history to another machine (#179): one tar.zst with the database snapshot, Claude Code's and Codex's
 * session logs, attachments and the Knowledge folder. Absolute paths are not rewritten here; `relocate` (relocate.ts)
 * matches them to the target's HOME and repository folder after the import (docs/design/cloud-hosting.md §5).
 */
export interface Manifest {
  version: 1;
  host: string;
  home: string;
  createdAt: string;
  /** Tasks in the snapshot; for the folders, files under them. Null when the source did not exist and was skipped. */
  counts: { tasks: number | null; claudeSessions: number | null; codexSessions: number | null; attachments: number | null; knowledge: number | null };
  /** Every regular file in the package except manifest.json, by path relative to the package root. */
  files: Record<string, string>;
  /** Permission bits of each file in `files` (the archive stores every entry as 0644; transcripts may be 0600, hooks 0755). */
  modes: Record<string, number>;
  /** Folders with nothing in them (the archive holds files only; an empty `.git/refs` still makes a repository). */
  emptyDirs: string[];
}

/** Package layout: the database, then folder → where it comes from. */
const DB_ENTRY = "switchboard.db";
function packageDirs(cfg: CoreConfig) {
  return {
    claudeSessions: { entry: "claude/projects", source: cfg.claudeProjectsDir },
    codexSessions: { entry: "codex/sessions", source: join(cfg.codexHome, "sessions") },
    attachments: { entry: "attachments", source: cfg.attachmentsDir },
    knowledge: { entry: "knowledge", source: cfg.knowledgeDir },
  } as const;
}

/**
 * `encryptTo`: an age recipient (public key); the package is then readable only with the matching identity.
 * Files go into the package one at a time, straight from their sources: tar → zstd → (age) → `out`. Only the database
 * snapshot is staged, and no more than one read chunk is held at once, so the history never sits in memory or in a
 * copy as a whole (a 3.8 GB host was oom-killed doing that, #1201).
 */
export async function exportHistory(cfg: CoreConfig, out: string, opts: { encryptTo?: string } = {}): Promise<Manifest> {
  const ageBin = opts.encryptTo ? ageBinary() : null;
  // wx: never overwrite (a mistyped <out> must not replace the database or a previous export); 0600: transcripts are private.
  const fd = openSync(out, "wx", 0o600);
  const written = fstatSync(fd); // the package itself, when <out> is inside a folder being exported
  // On the disk next to the database, not in tmpdir (RAM on the cloud host); named by pid so the next export can tell
  // a stage whose export was killed (oom-kill and SIGKILL skip the finally below) from one still running.
  const stage = join(cfg.home, `export-${process.pid}`);
  let zstd: ZstdCompress | undefined;
  let child: ChildProcess | null = null;
  try {
    sweepExportStages(cfg.home);
    rmSync(stage, { recursive: true, force: true }); // this pid's own leftover from an earlier, killed process
    mkdirSync(stage, { recursive: true, mode: 0o700 }); // the snapshot is as private as the database
    const z = (zstd = createZstdCompress());
    const age = (child = ageBin && opts.encryptTo ? spawn(ageBin, ["-r", opts.encryptTo], { stdio: ["pipe", fd, "pipe"] }) : null);
    let ageErr = "";
    age?.stderr?.on("data", (b: Buffer) => (ageErr += b.toString()));
    const exited = age ? new Promise<number | null>((ok) => age.on("close", ok)) : null;
    const done = pipeline(z, age?.stdin ?? createWriteStream("", { fd, autoClose: false }));
    done.catch(() => undefined); // awaited below; this only keeps an early failure from being reported as unhandled
    const write = async (b: Uint8Array) => {
      if (!z.write(b)) await Promise.race([once(z, "drain"), done]);
    };
    const counts: Manifest["counts"] = { tasks: null, claudeSessions: null, codexSessions: null, attachments: null, knowledge: null };
    const files: Manifest["files"] = {};
    const modes: Manifest["modes"] = {};
    const emptyDirs: string[] = [];
    /** One file into the tar: its size and mode from the open file, then its bytes, hashed as they are written. */
    const pack = async (name: string, path: string) => {
      const f = openSync(path, "r");
      try {
        const st = fstatSync(f);
        await write(tarHeader(name, st.size));
        const hash = new Bun.CryptoHasher("sha256");
        // Exactly st.size bytes: a log appended to meanwhile is cut at the size in the header, and its hash is of
        // the bytes in the package.
        for (let at = 0; at < st.size; ) {
          const chunk = Buffer.allocUnsafe(Math.min(CHUNK, st.size - at));
          const n = readSync(f, chunk, 0, chunk.length, at);
          if (n === 0) throw new Error(`${path} shrank while it was being exported`);
          hash.update(chunk.subarray(0, n));
          await write(chunk.subarray(0, n));
          at += n;
        }
        await write(new Uint8Array(tarPad(st.size)));
        files[name] = hash.digest("hex");
        modes[name] = st.mode & 0o777;
      } finally {
        closeSync(f);
      }
    };
    if (existsSync(cfg.dbPath)) {
      // Read-only, not `new Db`: opening a Db runs the schema and the migrations, which take the write lock. The daemon holding
      // it past busy_timeout failed the 2026-10-24 00:00 archive with "database is locked"; a snapshot read waits for no writer.
      const db = new Database(cfg.dbPath, { readonly: true });
      try {
        db.exec(`PRAGMA busy_timeout = ${SNAPSHOT_BUSY_TIMEOUT_MS}`); // Bun's default is 0: a checkpoint in progress would fail at once
        db.exec(`VACUUM INTO '${join(stage, DB_ENTRY).replace(/'/g, "''")}'`);
      } finally {
        db.close();
      }
      counts.tasks = countTasks(join(stage, DB_ENTRY));
      await pack(DB_ENTRY, join(stage, DB_ENTRY));
    }
    for (const [key, { entry, source }] of Object.entries(packageDirs(cfg)) as Array<[keyof typeof counts, { entry: string; source: string }]>) {
      if (!existsSync(source)) continue;
      const found = walk(source, entry, written);
      for (const [name, path] of found.files) await pack(name, path);
      emptyDirs.push(...found.emptyDirs);
      counts[key] = found.files.length;
    }
    const manifest: Manifest = { version: 1, host: hostname(), home: homedir(), createdAt: new Date().toISOString(), counts, files, modes, emptyDirs };
    const json = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    await write(tarHeader("manifest.json", json.length));
    await write(json);
    await write(new Uint8Array(tarPad(json.length) + 1024)); // padding, then the two empty blocks that end a tar
    z.end();
    await done;
    if (exited) {
      const code = await exited;
      if (code !== 0) throw new Error(`age failed (${code}): ${ageErr.trim()}`);
    }
    return manifest;
  } catch (e) {
    zstd?.destroy();
    child?.kill();
    rmSync(out, { force: true }); // never leave a partial package that looks like a finished one
    throw e;
  } finally {
    // EBADF: a pipeline that failed has already closed the fd, and that error is the one to report. Without this guard the
    // close threw in its place and the stage (a database copy, hundreds of MB) was never removed.
    try {
      try {
        closeSync(fd);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EBADF") throw e;
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

/** How long the snapshot waits for a writer's lock (the Db default, which this read-only connection does not get from Db). */
const SNAPSHOT_BUSY_TIMEOUT_MS = 5000;

const CHUNK = 1 << 20;

/** Remove `export-<pid>` stages under `home` whose process is gone; returns what was removed. */
export function sweepExportStages(home: string): string[] {
  if (!existsSync(home)) return [];
  const removed: string[] = [];
  for (const name of readdirSync(home)) {
    const pid = /^export-(\d+)$/.exec(name)?.[1];
    if (!pid) continue;
    try {
      process.kill(Number(pid), 0);
      continue; // alive (another export running at the same time)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") continue; // EPERM: alive, another user's
    }
    rmSync(join(home, name), { recursive: true, force: true });
    removed.push(join(home, name));
  }
  return removed;
}

/**
 * Regular files (package name → source path) and empty folders under `source`, named under `entry`. Links are
 * followed: a linked folder (or a link inside one) is carried as its contents, so every file is in the manifest.
 * `skip` (the package being written) is left out.
 */
function walk(source: string, entry: string, skip: { dev: number; ino: number }): { files: Array<[string, string]>; emptyDirs: string[] } {
  const out: { files: Array<[string, string]>; emptyDirs: string[] } = { files: [], emptyDirs: [] };
  const visit = (path: string, name: string) => {
    const st = statSync(path);
    if (st.isFile()) {
      if (st.dev !== skip.dev || st.ino !== skip.ino) out.files.push([name, path]);
    } else if (st.isDirectory()) {
      const before = out.files.length + out.emptyDirs.length;
      for (const c of readdirSync(path)) visit(join(path, c), `${name}/${c}`);
      if (out.files.length + out.emptyDirs.length === before) out.emptyDirs.push(name); // empty, or holding only `skip`
    } else throw new Error(`${path} is not a regular file or folder`);
  };
  visit(source, entry);
  return out;
}

/**
 * The ustar header for a regular file (0644; import restores modes from the manifest). A name over 100 bytes or
 * outside ASCII goes in a PAX extended header before it, as UTF-8 exactly as given — Bun.Archive (and /usr/bin/tar,
 * not used: macOS writes names with dakuten as NFD, #256) read it back as is. A size past the 11 octal digits does too.
 */
function tarHeader(name: string, size: number): Uint8Array {
  const bytes = Buffer.from(name);
  const big = size > 0o77777777777;
  if (bytes.length <= 100 && /^[\x20-\x7e]*$/.test(name) && !big) return ustar(name, size, "0");
  const pax = Buffer.from(paxRecord("path", name) + (big ? paxRecord("size", String(size)) : ""));
  return Buffer.concat([ustar("PaxHeader", pax.length, "x"), pax, new Uint8Array(tarPad(pax.length)), ustar("PaxFallback", big ? 0 : size, "0")]);
}

function ustar(name: string, size: number, type: "0" | "x"): Uint8Array {
  const h = Buffer.alloc(512);
  const put = (at: number, s: string) => h.write(s, at, "ascii");
  put(0, name);
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, `${Math.floor(Date.now() / 1000).toString(8).padStart(11, "0")}\0`);
  put(148, "        "); // the checksum counts its own field as spaces
  put(156, type);
  put(257, "ustar\0");
  put(263, "00");
  let sum = 0;
  for (const b of h) sum += b;
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

/** "<length> <key>=<value>\n", where the length counts its own digits. */
function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  const n = Buffer.byteLength(body);
  let len = n + String(n).length;
  if (String(len).length !== String(n).length) len = n + String(len).length;
  return `${len}${body}`;
}

/** Zero bytes after `size` to the next 512-byte block. */
function tarPad(size: number): number {
  return (512 - (size % 512)) % 512;
}

/**
 * Unpack a package made by exportHistory into this machine's HOME. Everything is checked before anything is placed:
 * every sha256 and count in the manifest, and that this HOME has no history of its own (a migration goes into an
 * empty HOME; nothing is merged or overwritten). On any mismatch the staging folder is removed and nothing is written.
 */
export async function importHistory(cfg: CoreConfig, file: string, opts: { identity?: string } = {}): Promise<Manifest> {
  const dirs = packageDirs(cfg);
  if (existsSync(cfg.dbPath) && countTasks(cfg.dbPath) > 0) throw new Error(`${cfg.dbPath} already has tasks; import goes into an empty HOME`);
  for (const { source } of Object.values(dirs)) {
    if (existsSync(source) && readdirSync(source).length > 0) throw new Error(`${source} is not empty; import goes into an empty HOME`);
  }

  let bytes: Uint8Array = readFileSync(file);
  if (Buffer.from(bytes.subarray(0, AGE_MAGIC.length)).toString() === AGE_MAGIC) {
    if (!opts.identity) throw new Error(`${file} is encrypted; pass --identity <age key file>`);
    bytes = await age(["-d", "-i", opts.identity], bytes);
  }
  const stage = join(cfg.home, `import-${Date.now()}`);
  mkdirSync(stage);
  try {
    let tarBytes: Uint8Array;
    try {
      tarBytes = Bun.zstdDecompressSync(bytes);
    } catch (e) {
      throw new Error(`manifest mismatch: ${file} is not a readable zstd package (${(e as Error).message})`);
    }
    // Bun.Archive drops `..` and leading `/` from entry names and does not follow or create symlinks.
    try {
      await new Bun.Archive(tarBytes).extract(stage);
    } catch (e) {
      throw new Error(`manifest mismatch: ${file} could not be unpacked (${(e as Error).message})`);
    }
    const manifest = verify(stage, dirs);
    // What the archive cannot carry, from the (verified) manifest: permission bits of listed files, and empty folders
    // — only inside the staging folder.
    for (const [f, mode] of Object.entries(manifest.modes)) {
      if (Object.hasOwn(manifest.files, f)) chmodSync(join(stage, f), mode & 0o777);
    }
    for (const d of manifest.emptyDirs) {
      const at = resolve(stage, d);
      if (!at.startsWith(stage + sep)) throw new Error(`manifest mismatch: empty folder ${d} is outside the package`);
      mkdirSync(at, { recursive: true });
    }

    if (existsSync(join(stage, DB_ENTRY))) {
      // Same as sb-rescue's restore: a stale -wal / -shm next to the new file would be replayed onto it.
      for (const f of [cfg.dbPath, `${cfg.dbPath}-wal`, `${cfg.dbPath}-shm`]) rmSync(f, { force: true });
      move(join(stage, DB_ENTRY), cfg.dbPath);
    }
    for (const { entry, source } of Object.values(dirs)) {
      if (!existsSync(join(stage, entry))) continue;
      rmSync(source, { recursive: true, force: true }); // empty (checked above)
      move(join(stage, entry), source);
    }
    return manifest;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** The manifest, after checking that it describes exactly the files in `stage` and the counts in them. */
function verify(stage: string, dirs: ReturnType<typeof packageDirs>): Manifest {
  const mismatch = (what: string) => new Error(`manifest mismatch: ${what}`);
  if (!existsSync(join(stage, "manifest.json"))) throw mismatch("no manifest.json");
  let m: Manifest;
  try {
    m = JSON.parse(readFileSync(join(stage, "manifest.json"), "utf8")) as Manifest;
  } catch {
    throw mismatch("manifest.json is not JSON");
  }
  if (m.version !== 1) throw mismatch(`version ${String(m.version)}`);
  if (typeof m.modes !== "object" || m.modes === null || !Array.isArray(m.emptyDirs)) throw mismatch("no modes / emptyDirs");
  let present: string[];
  try {
    present = listFiles(stage).map((f) => relative(stage, f)).filter((f) => f !== "manifest.json");
  } catch (e) {
    throw mismatch((e as Error).message.replace(`${stage}/`, ""));
  }
  for (const f of present) if (!Object.hasOwn(m.files, f)) throw mismatch(`${f} is not in the manifest`);
  for (const [f, sum] of Object.entries(m.files)) {
    if (!existsSync(join(stage, f))) throw mismatch(`${f} is missing`);
    if (sha256File(join(stage, f)) !== sum) throw mismatch(`${f} sha256 differs`);
  }
  const tasks = existsSync(join(stage, DB_ENTRY)) ? countTasks(join(stage, DB_ENTRY)) : null;
  if (tasks !== m.counts.tasks) throw mismatch(`tasks ${String(tasks)} ≠ ${String(m.counts.tasks)}`);
  for (const [key, { entry }] of Object.entries(dirs) as Array<[keyof Manifest["counts"], { entry: string }]>) {
    // The archive holds files only, so a folder that was empty (count 0) or absent (null) both arrive as nothing.
    const n = existsSync(join(stage, entry)) ? listFiles(join(stage, entry)).length : 0;
    if (n !== (m.counts[key] ?? 0)) throw mismatch(`${key} ${n} ≠ ${String(m.counts[key])}`);
  }
  return m;
}

/** rename, or copy + remove when the target is on another filesystem. */
function move(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    rmSync(from, { recursive: true, force: true });
  }
}

const AGE_MAGIC = "age-encryption.org/";

export function ageBinary(): string {
  const bin = Bun.which("age");
  if (!bin) throw new Error("age is not installed (brew install age / apt install age)");
  return bin;
}

/** Run the age binary on `input`; the keys stay with the user, Switchboard only passes the flags through. */
async function age(args: string[], input: Uint8Array): Promise<Uint8Array> {
  const p = Bun.spawn([ageBinary(), ...args], { stdin: input, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).arrayBuffer(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`age failed (${code}): ${err.trim()}`);
  return new Uint8Array(out);
}

function countTasks(dbFile: string): number {
  const db = new Database(dbFile, { readonly: true });
  try {
    return (db.query("SELECT count(*) AS n FROM tasks").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Regular files under `dir`, recursively. Anything else (a symlink in an unpacked package) is refused: it could not be verified. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) out.push(...listFiles(p));
    else if (st.isFile()) out.push(p);
    else throw new Error(`${p} is not a regular file or folder`);
  }
  return out;
}

function sha256File(p: string): string {
  return new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");
}
