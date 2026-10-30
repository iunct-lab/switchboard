import { Database } from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { relocate } from "./relocate.ts";

const tmp = mkdtempSync(join(tmpdir(), "sb-relocate-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A port nothing listens on: bound once, then released. */
function closedPort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port as number;
  void s.stop(true);
  return port;
}

function task(id: string, cwd: string, scope = [cwd]): Task {
  return { id, workspaceId: null, title: id, runner: "claude", cwd, scope, status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, resumeWindow: null, resumeSince: null, resumePlannedAt: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, titlePending: false, stage: null, statusAt: 1_000, createdAt: 1_000, updatedAt: 1_000 };
}

/** A HOME whose database and Claude folders hold the old paths, plus rows that must not change. */
function fakeHome(root: string, port = closedPort()) {
  const cfg = loadConfig({
    SWITCHBOARD_HOME: join(root, "sb"),
    SWITCHBOARD_CLAUDE_PROJECTS: join(root, ".claude", "projects"),
    SWITCHBOARD_CODEX_HOME: join(root, "codex"),
    SWITCHBOARD_KNOWLEDGE: join(root, "Knowledge"),
    SWITCHBOARD_PORT: String(port),
  });
  const db = new Db(cfg.dbPath);
  db.insertTask(task("t-old", "/home/dev/repo", ["/home/dev/repo", "/home/dev/.switchboard/attachments/t-old"]));
  db.insertTask(task("t-root", "/home/dev"));
  db.insertTask(task("t-near", "/home/devx/repo"));
  db.insertTask(task("t-other", "/opt/elsewhere"));
  db.close();
  const sql = new Database(cfg.dbPath);
  sql.run("INSERT INTO workspaces (id, name, path, kind, created_at) VALUES ('w1', 'repo', '/home/dev/repo', 'repo', 1), ('w2', 'near', '/home/devx/repo', 'repo', 1)");
  sql.run("INSERT INTO routing_log (task_id, cwd, suggested, rule_id, reason, chosen, ts) VALUES ('t-old', '/home/dev/repo', 'claude', 'r', 'x', 'claude', 1), ('t-near', '/home/devx/repo', 'claude', 'r', 'x', 'claude', 1)");
  sql.run("INSERT INTO staging (id, task_id, path, rel, kind, after_text, status, ts) VALUES ('s1', 't-old', '/home/dev/repo/a.ts', 'a.ts', 'write', '', 'pending', 1)");
  sql.run(`INSERT INTO attachments (id, task_id, name, mime, size, path, created_at) VALUES ('a1', 't-old', 'shot.png', 'image/png', 4, '/home/dev/.switchboard/attachments/t-old/shot.png', 1)`);
  const projects = cfg.claudeProjectsDir;
  sql.run(
    "INSERT INTO history_imports (session_id, task_id, path, offset, imported_at) VALUES ('s-repo', 't-old', ?, 0, 1), ('s-root', 't-root', ?, 0, 1), ('s-near', 't-near', ?, 0, 1)",
    [join(projects, "-home-dev-repo", "s-repo.jsonl"), join(projects, "-home-dev", "s-root.jsonl"), join(projects, "-home-devx-repo", "s-near.jsonl")],
  );
  sql.run("INSERT INTO knowledge_docs (path, title, kind, frontmatter, mtime, size) VALUES ('notes/a.md', 'a', 'note', '{}', 1, 1)");
  sql.close();
  for (const [dir, file] of [["-home-dev-repo", "s-repo.jsonl"], ["-home-dev", "s-root.jsonl"], ["-home-devx-repo", "s-near.jsonl"]] as const) {
    mkdirSync(join(projects, dir, "memory"), { recursive: true });
    writeFileSync(join(projects, dir, file), '{"type":"user"}\n');
  }
  return cfg;
}

/** Every path-holding value, so a test can compare before and after. */
function dump(dbPath: string) {
  const sql = new Database(dbPath, { readonly: true });
  try {
    const col = (q: string) => (sql.query(q).all() as Array<{ v: string }>).map((r) => r.v);
    return {
      workspaces: col("SELECT path AS v FROM workspaces ORDER BY id"),
      tasksCwd: col("SELECT cwd AS v FROM tasks ORDER BY id"),
      tasksScope: col("SELECT scope AS v FROM tasks ORDER BY id"),
      routing: col("SELECT cwd AS v FROM routing_log ORDER BY id"),
      staging: col("SELECT path AS v FROM staging ORDER BY id"),
      attachments: col("SELECT path AS v FROM attachments ORDER BY id"),
      history: col("SELECT path AS v FROM history_imports ORDER BY session_id"),
      knowledge: col("SELECT path AS v FROM knowledge_docs ORDER BY path"),
    };
  } finally {
    sql.close();
  }
}

describe("relocate", () => {
  test("replaces the old prefix at a path boundary in every path column and leaves other values alone", async () => {
    const cfg = fakeHome(join(tmp, "a"));
    const p = cfg.claudeProjectsDir;
    const report = await relocate(cfg, "/home/dev/", "/srv/sb");
    expect(dump(cfg.dbPath)).toEqual({
      workspaces: ["/srv/sb/repo", "/home/devx/repo"],
      // t-near, t-old, t-other, t-root
      tasksCwd: ["/home/devx/repo", "/srv/sb/repo", "/opt/elsewhere", "/srv/sb"],
      tasksScope: [JSON.stringify(["/home/devx/repo"]), JSON.stringify(["/srv/sb/repo", "/srv/sb/.switchboard/attachments/t-old"]), JSON.stringify(["/opt/elsewhere"]), JSON.stringify(["/srv/sb"])],
      routing: ["/srv/sb/repo", "/home/devx/repo"],
      staging: ["/srv/sb/repo/a.ts"],
      attachments: ["/srv/sb/.switchboard/attachments/t-old/shot.png"],
      history: [join(p, "-home-devx-repo", "s-near.jsonl"), join(p, "-srv-sb-repo", "s-repo.jsonl"), join(p, "-srv-sb", "s-root.jsonl")],
      knowledge: ["notes/a.md"],
    });
    expect(report.rows).toEqual({ "workspaces.path": 1, "tasks.cwd": 2, "tasks.scope": 2, "routing_log.cwd": 1, "staging.path": 1, "attachments.path": 1, "history_imports.path": 2 });
    expect(report.folders).toBe(2);
  });

  test("renames the Claude session folders and history_imports points at the new place", async () => {
    const cfg = fakeHome(join(tmp, "b"));
    const p = cfg.claudeProjectsDir;
    await relocate(cfg, "/home/dev", "/srv/sb");
    expect(readdirSync(p).sort()).toEqual(["-home-devx-repo", "-srv-sb", "-srv-sb-repo"]);
    expect(readFileSync(join(p, "-srv-sb-repo", "s-repo.jsonl"), "utf8")).toBe('{"type":"user"}\n');
    expect(existsSync(join(p, "-srv-sb-repo", "memory"))).toBe(true);
    for (const h of dump(cfg.dbPath).history) expect(existsSync(h)).toBe(true);
  });

  test("imported rows that still carry the old HOME's projects folder point at the renamed folder (repos, then HOME)", async () => {
    const cfg = fakeHome(join(tmp, "imported"));
    const p = cfg.claudeProjectsDir;
    const sql = new Database(cfg.dbPath);
    sql.run("DELETE FROM history_imports");
    sql.run("INSERT INTO history_imports (session_id, task_id, path, offset, imported_at) VALUES ('s-repo', 't-old', '/home/dev/.claude/projects/-home-dev-repo/s-repo.jsonl', 0, 1)");
    sql.close();
    await relocate(cfg, "/home/dev/repo", "/srv/sb/repos/repo");
    expect(dump(cfg.dbPath).history).toEqual(["/home/dev/.claude/projects/-srv-sb-repos-repo/s-repo.jsonl"]);
    await relocate(cfg, "/home/dev", "/srv/sb");
    expect(dump(cfg.dbPath).history).toEqual(["/srv/sb/.claude/projects/-srv-sb-repos-repo/s-repo.jsonl"]);
    expect(existsSync(join(p, "-srv-sb-repos-repo", "s-repo.jsonl"))).toBe(true);
  });

  test("an existing target folder stops it before anything is written", async () => {
    const cfg = fakeHome(join(tmp, "c"));
    mkdirSync(join(cfg.claudeProjectsDir, "-srv-sb-repo"));
    const before = dump(cfg.dbPath);
    await expect(relocate(cfg, "/home/dev", "/srv/sb")).rejects.toThrow(/-srv-sb-repo already exists/);
    expect(dump(cfg.dbPath)).toEqual(before);
    expect(readdirSync(cfg.claudeProjectsDir).sort()).toEqual(["-home-dev", "-home-dev-repo", "-home-devx-repo", "-srv-sb-repo"]);
  });

  test("a running daemon stops it before anything is written", async () => {
    const daemon = Bun.serve({ port: 0, fetch: (req) => (new URL(req.url).pathname === "/api/health" ? Response.json({ ok: true }) : new Response("", { status: 404 })) });
    try {
      const cfg = fakeHome(join(tmp, "d"), daemon.port);
      const before = dump(cfg.dbPath);
      await expect(relocate(cfg, "/home/dev", "/srv/sb")).rejects.toThrow(/daemon is running/);
      expect(dump(cfg.dbPath)).toEqual(before);
      expect(readdirSync(cfg.claudeProjectsDir).sort()).toEqual(["-home-dev", "-home-dev-repo", "-home-devx-repo"]);
    } finally {
      await daemon.stop(true);
    }
  });

  test("relative or equal paths are refused", async () => {
    const cfg = fakeHome(join(tmp, "e"));
    await expect(relocate(cfg, "Users/dev", "/srv/sb")).rejects.toThrow(/absolute/);
    await expect(relocate(cfg, "/home/dev", "/home/dev/")).rejects.toThrow(/same/);
  });
});
