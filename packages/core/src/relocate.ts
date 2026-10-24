import { Database } from "bun:sqlite";
import { existsSync, readdirSync, renameSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { claudeProjectDirName } from "@switchboard/adapter-claude";
import type { CoreConfig } from "./config.ts";

/**
 * Moving the history to other paths (#427): after an import from a Mac, the database still holds the Mac's HOME and
 * repository folder, and Claude Code's session folders are named after them. This rewrites both once, from the old
 * prefix to the new one (run it once per prefix: the repository folder, then HOME). Session logs' contents are not
 * touched — resuming needs only the file's place and the cwd Switchboard passes (docs/design/cloud-hosting.md §5).
 * Everything is checked before anything is written; on any failure nothing is changed.
 */
export interface RelocateReport {
  /** Changed rows per `table.column`. */
  rows: Record<string, number>;
  /** Claude session folders renamed. */
  folders: number;
}

/** Columns holding one absolute path. */
const PATH_COLUMNS = [
  ["workspaces", "path"],
  ["tasks", "cwd"],
  ["routing_log", "cwd"],
  ["staging", "path"],
  ["attachments", "path"],
] as const;

export async function relocate(cfg: CoreConfig, fromArg: string, toArg: string): Promise<RelocateReport> {
  if (!isAbsolute(fromArg) || !isAbsolute(toArg)) throw new Error("--from and --to must be absolute paths");
  const from = trimSlash(fromArg);
  const to = trimSlash(toArg);
  if (from === to) throw new Error("--from and --to are the same path");
  await assertDaemonStopped(cfg);

  // At a path boundary: /home/dev must not match /home/devx.
  const mapPath = (v: string) => (v === from || v.startsWith(`${from}/`) ? to + v.slice(from.length) : v);
  const fromName = claudeProjectDirName(from);
  const toName = claudeProjectDirName(to);
  const mapName = (name: string) => (name === fromName || name.startsWith(`${fromName}-`) ? toName + name.slice(fromName.length) : name);
  const projects = cfg.claudeProjectsDir;
  // The folder name after Claude's projects folder: this machine's, or the one an imported row still carries under
  // the old HOME — found by the last two segments of this machine's (`…/<.claude>/<projects>/`).
  const tail = `/${projects.split("/").slice(-2).join("/")}/`;
  const mapHistory = (v: string) => {
    const at = v.startsWith(`${projects}/`) ? projects.length + 1 : v.includes(tail) ? v.indexOf(tail) + tail.length : -1;
    if (at < 0) return mapPath(v);
    const [name, ...rest] = v.slice(at).split("/");
    return mapPath([v.slice(0, at - 1), mapName(name ?? ""), ...rest].join("/"));
  };

  const renames = existsSync(projects)
    ? readdirSync(projects)
        .filter((n) => mapName(n) !== n)
        .map((n) => ({ from: join(projects, n), to: join(projects, mapName(n)) }))
    : [];
  for (const r of renames) if (existsSync(r.to)) throw new Error(`${r.to} already exists; nothing was changed`);

  const rows: Record<string, number> = {};
  const sql = existsSync(cfg.dbPath) ? new Database(cfg.dbPath) : null;
  try {
    if (sql) {
      // knowledge_docs.path is relative to the Knowledge folder and moves with it; an absolute one would be left behind.
      const abs = sql.query("SELECT path FROM knowledge_docs WHERE path LIKE '/%' LIMIT 1").get() as { path: string } | null;
      if (abs) throw new Error(`knowledge_docs holds an absolute path (${abs.path}); relocate does not handle it`);
    }
    const write = () => {
      if (sql) {
        const rewrite = (table: string, column: string, map: (v: string) => string) => {
          let n = 0;
          for (const r of sql.query(`SELECT rowid AS id, ${column} AS v FROM ${table}`).all() as Array<{ id: number; v: string }>) {
            const next = map(r.v);
            if (next === r.v) continue;
            sql.query(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`).run(next, r.id);
            n++;
          }
          rows[`${table}.${column}`] = n;
        };
        for (const [table, column] of PATH_COLUMNS) rewrite(table, column, mapPath);
        // A JSON array of roots (the cwd, attachment folders): approval and MCP check writes against them.
        rewrite("tasks", "scope", (v) => {
          const roots = JSON.parse(v) as string[];
          const next = roots.map(mapPath);
          return next.some((p, i) => p !== roots[i]) ? JSON.stringify(next) : v;
        });
        rewrite("history_imports", "path", mapHistory);
      }
    };
    // One transaction around the rows and the renames: a failure anywhere (a rename, the COMMIT) undoes the renames
    // already done and rolls the database back.
    const done: typeof renames = [];
    sql?.run("BEGIN IMMEDIATE");
    try {
      write();
      for (const r of renames) {
        renameSync(r.from, r.to);
        done.push(r);
      }
      sql?.run("COMMIT");
    } catch (e) {
      if (sql?.inTransaction) sql.run("ROLLBACK");
      for (const r of done.reverse()) renameSync(r.to, r.from);
      throw e;
    }
  } finally {
    sql?.close();
  }
  return { rows, folders: renames.length };
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** The daemon rewrites these rows while it runs; only a refused connection means it is stopped. */
async function assertDaemonStopped(cfg: CoreConfig): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${cfg.port}/api/health`, { signal: AbortSignal.timeout(2000) });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ConnectionRefused" || code === "ECONNREFUSED") return; // Bun 1.4.2 says the first, 1.4.3 the second
    throw new Error(`could not tell whether the daemon is running on port ${cfg.port} (${(e as Error).message})`);
  }
  throw new Error("the daemon is running; stop it first");
}
