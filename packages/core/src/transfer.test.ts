import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerAdapter, StartOptions, Task } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { Db } from "./db.ts";
import { startServer as startDaemon } from "./server.ts";

/**
 * The judge (#493) is on by default and would ask these daemons' fake runners to judge every finished turn, adding
 * sessions the tests count. Here it never answers, unless a test passes its own.
 */
const startServer: typeof startDaemon = (cfg, adapters, opts = {}) => startDaemon(cfg, adapters, { judge: () => new Promise(() => undefined), rubricJudge: () => new Promise(() => undefined), ...opts });
import { exportHistory, importHistory, type Manifest } from "./transfer.ts";

const tmp = mkdtempSync(join(tmpdir(), "sb-transfer-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function task(id: string, cwd: string): Task {
  return { id, workspaceId: null, title: id, runner: "claude", cwd, scope: [cwd], status: "done", runnerSessionId: null, executionMode: "local" as const, cloudSession: null, sourceCloudTaskId: null, model: null, routing: null, budgetUsd: null, scheduleId: null, permissionMode: null, effort: null, origin: "switchboard", resumeAt: null, resumeReason: null, shadowOf: null, shadowStopped: false, workspaceReason: null, outcome: "unknown", reviewedAt: null, archivedAt: null, judgedResult: null, judgedReason: null, judgedBy: null, judgingAt: null, stage: null, statusAt: 1_000, createdAt: 1_000, updatedAt: 1_000 };
}

/** A HOME with a little of everything the package carries. */
function fakeHistory(root: string) {
  const env = {
    SWITCHBOARD_HOME: join(root, "sb"),
    SWITCHBOARD_CLAUDE_PROJECTS: join(root, "claude", "projects"),
    SWITCHBOARD_CODEX_HOME: join(root, "codex"),
    SWITCHBOARD_KNOWLEDGE: join(root, "Knowledge"),
    SWITCHBOARD_PORT: "0",
  };
  const cfg = loadConfig(env);
  const db = new Db(cfg.dbPath);
  db.insertTask(task("t1", "/Users/dev/repo"));
  db.insertTask(task("t2", "/Users/dev/repo"));
  db.close();
  mkdirSync(join(cfg.claudeProjectsDir, "-Users-dev-repo"), { recursive: true });
  writeFileSync(join(cfg.claudeProjectsDir, "-Users-dev-repo", "a.jsonl"), '{"type":"user"}\n');
  mkdirSync(join(cfg.codexHome, "sessions", "2026"), { recursive: true });
  writeFileSync(join(cfg.codexHome, "sessions", "2026", "x.jsonl"), '{"type":"session_meta"}\n');
  mkdirSync(cfg.attachmentsDir, { recursive: true });
  writeFileSync(join(cfg.attachmentsDir, "shot.png"), new Uint8Array([137, 80, 78, 71]));
  mkdirSync(cfg.knowledgeDir, { recursive: true });
  writeFileSync(join(cfg.knowledgeDir, "README.md"), "# notes\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: cfg.knowledgeDir });
  Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "init", "--allow-empty"], { cwd: cfg.knowledgeDir });
  return { env, cfg };
}

function unpack(file: string, into: string) {
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, "..", "pkg.tar"), Bun.zstdDecompressSync(readFileSync(file)));
  const r = Bun.spawnSync(["tar", "-xf", join(into, "..", "pkg.tar"), "-C", into]);
  expect(r.exitCode).toBe(0);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((p) => statSync(join(dir, p)).isFile());
}

describe("export", () => {
  test("export packs the database snapshot, both runners' logs, attachments and Knowledge with a manifest that matches", async () => {
    const { cfg } = fakeHistory(join(tmp, "a"));
    const out = join(tmp, "a.tar.zst");
    const m = await exportHistory(cfg, out);

    const dir = join(tmp, "a-unpacked", "x");
    unpack(out, dir);
    const onDisk = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    expect(onDisk).toEqual(m);
    expect(m.version).toBe(1);
    expect(m.counts).toEqual({ tasks: 2, claudeSessions: 1, codexSessions: 1, attachments: 1, knowledge: walk(cfg.knowledgeDir).length });

    const files = walk(dir).filter((f) => f !== "manifest.json");
    expect(Object.keys(m.files).sort()).toEqual(files.sort());
    for (const f of files) expect(m.files[f]).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, f))).digest("hex"));
    expect(files).toContain("switchboard.db");
    expect(files).toContain("claude/projects/-Users-dev-repo/a.jsonl");
    expect(files).toContain("codex/sessions/2026/x.jsonl");
    expect(files).toContain("attachments/shot.png");
    expect(files).toContain("knowledge/README.md");
    expect(files.some((f) => f.startsWith("knowledge/.git/"))).toBe(true);
    expect(files.some((f) => f.split("/").some((s) => s.startsWith("._")))).toBe(false);

    expect(statSync(out).mode & 0o777).toBe(0o600);
    const snap = new Db(join(dir, "switchboard.db"));
    expect(snap.listTasks().map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    snap.close();
  });

  test("export records a source that does not exist as null and skips it", async () => {
    const { cfg } = fakeHistory(join(tmp, "b"));
    rmSync(join(cfg.codexHome, "sessions"), { recursive: true });
    rmSync(cfg.knowledgeDir, { recursive: true });
    const m = await exportHistory(cfg, join(tmp, "b.tar.zst"));
    expect(m.counts.codexSessions).toBeNull();
    expect(m.counts.knowledge).toBeNull();
    expect(m.counts.tasks).toBe(2);
    expect(Object.keys(m.files).some((f) => f.startsWith("codex/") || f.startsWith("knowledge/"))).toBe(false);

    // An empty folder (count 0) carries no entries; import must accept it as 0, not as missing.
    rmSync(join(cfg.attachmentsDir, "shot.png"));
    const out = join(tmp, "b-empty.tar.zst");
    expect((await exportHistory(cfg, out)).counts.attachments).toBe(0);
    expect((await importHistory(emptyHome(join(tmp, "b-into")), out)).counts.tasks).toBe(2);
  });

  test("export carries a symlinked folder as its contents and never overwrites an existing file", async () => {
    const { cfg } = fakeHistory(join(tmp, "c"));
    renameSync(cfg.claudeProjectsDir, join(tmp, "c", "real-projects"));
    symlinkSync(join(tmp, "c", "real-projects"), cfg.claudeProjectsDir);
    const m = await exportHistory(cfg, join(tmp, "c.tar.zst"));
    expect(m.counts.claudeSessions).toBe(1);
    expect(Object.keys(m.files)).toContain("claude/projects/-Users-dev-repo/a.jsonl");

    const before = readFileSync(cfg.dbPath);
    await expect(exportHistory(cfg, cfg.dbPath)).rejects.toThrow(/EEXIST/);
    expect(readFileSync(cfg.dbPath).equals(before)).toBe(true);
  });
});

describe("export streams", () => {
  test("export streams files one at a time: a 150-byte-plus non-ASCII path and a file appended between runs round-trip", async () => {
    const { cfg } = fakeHistory(join(tmp, "sa"));
    const dir = join(cfg.knowledgeDir, "長い名前のフォルダ".normalize("NFC"));
    const name = `${"が".repeat(40)}.md`.normalize("NFC"); // 120 bytes of UTF-8: past ustar's 100 and not ASCII
    mkdirSync(dir);
    writeFileSync(join(dir, name), "が\n");
    const log = join(cfg.claudeProjectsDir, "-Users-dev-repo", "a.jsonl");
    for (const run of ["1", "2"]) {
      const out = join(tmp, `sa-${run}.tar.zst`);
      const m = await exportHistory(cfg, out);
      const rel = `knowledge/長い名前のフォルダ/${name}`.normalize("NFC");
      expect(Buffer.byteLength(rel)).toBeGreaterThan(150);
      expect(Object.keys(m.files)).toContain(rel);
      const b = emptyHome(join(tmp, `sb-${run}`));
      await importHistory(b, out);
      expect(readdirSync(join(b.knowledgeDir, "長い名前のフォルダ".normalize("NFC")))).toEqual([name]);
      expect(readFileSync(join(b.claudeProjectsDir, "-Users-dev-repo", "a.jsonl"))).toEqual(readFileSync(log));
      writeFileSync(log, '{"type":"assistant"}\n', { flag: "a" });
    }
  });

  test("export leaves its own package out when <out> is inside a folder it exports, and removes it when it cannot start", async () => {
    const { cfg } = fakeHistory(join(tmp, "oa"));
    mkdirSync(join(cfg.knowledgeDir, "backups"));
    const out = join(cfg.knowledgeDir, "backups", "backup.tar.zst");
    const m = await exportHistory(cfg, out);
    expect(Object.keys(m.files)).not.toContain("knowledge/backups/backup.tar.zst");
    expect(m.emptyDirs).toContain("knowledge/backups"); // the folder still arrives, as it was before the export
    const b = emptyHome(join(tmp, "ob"));
    await importHistory(b, out);
    expect(readdirSync(join(b.knowledgeDir, "backups"))).toEqual([]);

    const failing = join(tmp, "oa-failed.tar.zst");
    chmodSync(cfg.home, 0o500); // the stage cannot be made
    try {
      await expect(exportHistory(cfg, failing)).rejects.toThrow(/EACCES/);
    } finally {
      chmodSync(cfg.home, 0o700);
    }
    expect(existsSync(failing)).toBe(false);
  });

  test("export packs a file that changes after the walk with the sha256 of the bytes it wrote", async () => {
    const { cfg } = fakeHistory(join(tmp, "wa"));
    const log = join(cfg.claudeProjectsDir, "-Users-dev-repo", "a.jsonl");
    for (let i = 0; i < 64; i++) writeFileSync(join(cfg.claudeProjectsDir, "-Users-dev-repo", `pad-${i}.jsonl`), Buffer.alloc(256 * 1024, 120));
    // A runner still writing its log while the export reads it: another process appends the whole time.
    const writer = Bun.spawn(["sh", "-c", `while :; do echo '{"type":"assistant"}' >> '${log}'; done`]);
    try {
      const out = join(tmp, "wa.tar.zst");
      await exportHistory(cfg, out);
      writer.kill();
      await writer.exited;
      const m = await importHistory(emptyHome(join(tmp, "wb")), out); // checks every sha256 against the bytes unpacked
      expect(m.counts.claudeSessions).toBe(65);
    } finally {
      writer.kill();
    }
  });
});

describe("export stage", () => {
  const sbExports = () => readdirSync(tmpdir()).filter((f) => f.startsWith("sb-export-")).length;

  test("export stages under the Switchboard home, not tmpdir", async () => {
    const { cfg } = fakeHistory(join(tmp, "ga"));
    const before = sbExports();
    const running = exportHistory(cfg, join(tmp, "ga.tar.zst"));
    // The database snapshot is staged before the first file is written, i.e. before exportHistory first yields.
    expect(readdirSync(join(cfg.home, `export-${process.pid}`))).toEqual(["switchboard.db"]);
    expect(statSync(join(cfg.home, `export-${process.pid}`)).mode & 0o777).toBe(0o700);
    expect(sbExports()).toBe(before);
    await running;
    expect(readdirSync(cfg.home).filter((f) => f.startsWith("export-"))).toEqual([]);
    expect(sbExports()).toBe(before);
  });

  test("a stage left by a killed export is removed at the next export", async () => {
    const { cfg, env } = fakeHistory(join(tmp, "ka2"));
    // Enough to keep the child exporting for a while after it has staged the database.
    for (let i = 0; i < 48; i++) writeFileSync(join(cfg.claudeProjectsDir, "-Users-dev-repo", `big-${i}.jsonl`), crypto.getRandomValues(new Uint8Array(1 << 20)));
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts"), "export", join(tmp, "ka2-killed.tar.zst")], { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" });
    const stage = join(cfg.home, `export-${child.pid}`);
    const until = Date.now() + 20_000;
    while (!existsSync(stage) && Date.now() < until) await Bun.sleep(5);
    child.kill("SIGKILL");
    await child.exited;
    expect(existsSync(stage)).toBe(true); // SIGKILL skips the finally

    await exportHistory(cfg, join(tmp, "ka2.tar.zst"));
    expect(existsSync(stage)).toBe(false);
    expect(readdirSync(cfg.home).filter((f) => f.startsWith("export-"))).toEqual([]);
  }, 30_000);

  test("a stage whose process is alive is kept", async () => {
    const { cfg } = fakeHistory(join(tmp, "la"));
    const alive = join(cfg.home, `export-${process.ppid}`); // another export, still running
    mkdirSync(alive);
    writeFileSync(join(alive, "switchboard.db"), "");
    await exportHistory(cfg, join(tmp, "la.tar.zst"));
    expect(readdirSync(alive)).toEqual(["switchboard.db"]);
  });
});

/** An empty HOME on the "other machine": same env keys, another root. */
function emptyHome(root: string) {
  return loadConfig({
    SWITCHBOARD_HOME: join(root, "sb"),
    SWITCHBOARD_CLAUDE_PROJECTS: join(root, "claude", "projects"),
    SWITCHBOARD_CODEX_HOME: join(root, "codex"),
    SWITCHBOARD_KNOWLEDGE: join(root, "Knowledge"),
    SWITCHBOARD_PORT: "0",
  });
}

/**
 * Every file under `root` with its bytes' sha256 — to see that a failed import wrote nothing. SQLite's -wal / -shm
 * sidecars are left out: any read of a WAL database may create or touch them (an empty -wal appears on Linux).
 */
function snapshot(root: string): Record<string, string> {
  return Object.fromEntries(walk(root).filter((f) => !f.endsWith("-shm") && !f.endsWith("-wal")).map((f) => [f, new Bun.CryptoHasher("sha256").update(readFileSync(join(root, f))).digest("hex")]));
}

describe("import", () => {
  test("import round-trips an export into an empty HOME", async () => {
    const { cfg } = fakeHistory(join(tmp, "ra"));
    const out = join(tmp, "ra.tar.zst");
    await exportHistory(cfg, out);
    const b = emptyHome(join(tmp, "rb"));
    const m = await importHistory(b, out);
    expect(m.counts.tasks).toBe(2);
    for (const [from, to] of [[cfg.claudeProjectsDir, b.claudeProjectsDir], [join(cfg.codexHome, "sessions"), join(b.codexHome, "sessions")], [cfg.attachmentsDir, b.attachmentsDir], [cfg.knowledgeDir, b.knowledgeDir]] as const) {
      expect(snapshot(to)).toEqual(snapshot(from));
    }
    const db = new Db(b.dbPath);
    expect(db.listTasks().map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    db.close();
    expect(readdirSync(b.home).some((f) => f.startsWith("import-"))).toBe(false);
  });

  test("import of a damaged package throws and writes nothing", async () => {
    const { cfg } = fakeHistory(join(tmp, "da"));
    const out = join(tmp, "da.tar.zst");
    await exportHistory(cfg, out);
    const bytes = readFileSync(out);
    const at = bytes.length - 20;
    bytes[at] = (bytes[at] ?? 0) ^ 0xff;
    const broken = join(tmp, "da-broken.tar.zst");
    writeFileSync(broken, bytes);
    const b = emptyHome(join(tmp, "db"));
    const before = snapshot(join(tmp, "db"));
    await expect(importHistory(b, broken)).rejects.toThrow(/manifest mismatch/);
    expect(snapshot(join(tmp, "db"))).toEqual(before);
    expect(readdirSync(b.home)).toEqual([]);
  });

  test("import round-trips file names with dakuten as they are (NFC), which macOS tar would have written as NFD", async () => {
    const { cfg } = fakeHistory(join(tmp, "na"));
    const name = "タスクに添付ができない.md".normalize("NFC");
    mkdirSync(join(cfg.knowledgeDir, "notes"));
    writeFileSync(join(cfg.knowledgeDir, "notes", name), "が\n");
    const out = join(tmp, "na.tar.zst");
    const m = await exportHistory(cfg, out);
    expect(Object.keys(m.files)).toContain(`knowledge/notes/${name}`);
    const b = emptyHome(join(tmp, "nb"));
    await importHistory(b, out);
    const placed = readdirSync(join(b.knowledgeDir, "notes"));
    expect(placed).toEqual([name]);
    expect(placed[0]?.normalize("NFC")).toBe(placed[0]); // not only equal on a normalization-insensitive disk
  });

  test("import restores permission bits and empty folders, so a Knowledge git repository still works", async () => {
    const { cfg } = fakeHistory(join(tmp, "pa"));
    const transcript = join(cfg.claudeProjectsDir, "-Users-dev-repo", "a.jsonl");
    chmodSync(transcript, 0o600);
    writeFileSync(join(cfg.knowledgeDir, ".git", "hooks", "pre-commit"), "#!/bin/sh\n");
    chmodSync(join(cfg.knowledgeDir, ".git", "hooks", "pre-commit"), 0o755);
    const out = join(tmp, "pa.tar.zst");
    const m = await exportHistory(cfg, out);
    const b = emptyHome(join(tmp, "pb"));
    await importHistory(b, out);
    expect(statSync(join(b.claudeProjectsDir, "-Users-dev-repo", "a.jsonl")).mode & 0o777).toBe(0o600);
    expect(statSync(join(b.knowledgeDir, ".git", "hooks", "pre-commit")).mode & 0o777).toBe(0o755);
    const knowledgeEmpty = m.emptyDirs.filter((d) => d.startsWith("knowledge/"));
    expect(knowledgeEmpty.length).toBeGreaterThan(0);
    for (const d of knowledgeEmpty) expect(readdirSync(join(b.knowledgeDir, d.slice("knowledge/".length)))).toEqual([]);
    expect(Bun.spawnSync(["git", "-C", b.knowledgeDir, "rev-parse", "--git-dir"]).exitCode).toBe(0);
  });

  test("import checks every file, sha256 and count in the manifest on its own", async () => {
    const { cfg } = fakeHistory(join(tmp, "va"));
    const out = join(tmp, "va.tar.zst");
    await exportHistory(cfg, out);
    /** Unpack, change one thing, pack again (a readable package whose contents disagree with its manifest). */
    const tamper = (name: string, edit: (dir: string) => void) => {
      const dir = join(tmp, `va-${name}`, "x");
      unpack(out, dir);
      edit(dir);
      const r = Bun.spawnSync(["tar", "-cf", "-", "-C", dir, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
      const file = join(tmp, `va-${name}.tar.zst`);
      writeFileSync(file, Bun.zstdCompressSync(r.stdout));
      return file;
    };
    const manifestOf = (dir: string) => JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    const cases: Array<[string, (dir: string) => void, RegExp]> = [
      ["sha", (d) => writeFileSync(join(d, "claude/projects/-Users-dev-repo/a.jsonl"), '{"type":"changed"}\n'), /a\.jsonl sha256 differs/],
      ["extra", (d) => writeFileSync(join(d, "attachments/extra.txt"), "x"), /extra\.txt is not in the manifest/],
      ["missing", (d) => unlinkSync(join(d, "codex/sessions/2026/x.jsonl")), /x\.jsonl is missing/],
      ["emptydir", (d) => writeFileSync(join(d, "manifest.json"), JSON.stringify({ ...manifestOf(d), emptyDirs: ["../outside"] })), /outside the package/],
      ["count", (d) => writeFileSync(join(d, "manifest.json"), JSON.stringify({ ...manifestOf(d), counts: { ...manifestOf(d).counts, tasks: 3 } })), /tasks 2 ≠ 3/],
    ];
    for (const [name, edit, message] of cases) {
      const b = emptyHome(join(tmp, `vb-${name}`));
      await expect(importHistory(b, tamper(name, edit))).rejects.toThrow(message);
      expect(readdirSync(b.home)).toEqual([]);
      expect(existsSync(b.claudeProjectsDir)).toBe(false);
    }
    // A symlink entry is not unpacked at all (Bun.Archive neither creates nor follows links), so nothing unverified is placed.
    const b = emptyHome(join(tmp, "vb-symlink"));
    await importHistory(b, tamper("symlink", (d) => symlinkSync("/etc/hosts", join(d, "attachments/link"))));
    expect(readdirSync(b.attachmentsDir)).toEqual(["shot.png"]);
  });

  test("import refuses a HOME that already has history", async () => {
    const { cfg } = fakeHistory(join(tmp, "ea"));
    const out = join(tmp, "ea.tar.zst");
    await exportHistory(cfg, out);
    const { cfg: other } = fakeHistory(join(tmp, "eb"));
    const before = snapshot(join(tmp, "eb"));
    await expect(importHistory(other, out)).rejects.toThrow(/already has tasks/);
    expect(snapshot(join(tmp, "eb"))).toEqual(before);

    const c = emptyHome(join(tmp, "ec"));
    mkdirSync(join(c.codexHome, "sessions"), { recursive: true });
    writeFileSync(join(c.codexHome, "sessions", "mine.jsonl"), "{}\n");
    await expect(importHistory(c, out)).rejects.toThrow(/is not empty/);
    expect(existsSync(c.dbPath)).toBe(false);
  });

  test.skipIf(!Bun.which("age"))("export --encrypt needs the identity to import", async () => {
    const key = join(tmp, "age-key.txt");
    expect(Bun.spawnSync(["age-keygen", "-o", key]).exitCode).toBe(0);
    const recipient = Bun.spawnSync(["age-keygen", "-y", key]).stdout.toString().trim();
    const { cfg } = fakeHistory(join(tmp, "ka"));
    const out = join(tmp, "ka.tar.zst.age");
    await exportHistory(cfg, out, { encryptTo: recipient });
    expect(() => Bun.zstdDecompressSync(readFileSync(out))).toThrow();

    const b = emptyHome(join(tmp, "kb"));
    await expect(importHistory(b, out)).rejects.toThrow(/--identity/);
    const wrong = join(tmp, "age-wrong.txt");
    Bun.spawnSync(["age-keygen", "-o", wrong]);
    await expect(importHistory(b, out, { identity: wrong })).rejects.toThrow(/age failed/);
    expect(existsSync(b.dbPath)).toBe(false);
    const m = await importHistory(b, out, { identity: key });
    expect(m.counts.tasks).toBe(2);
  });

  test("the CLI stops when --encrypt or --identity has no value instead of writing a plaintext package", () => {
    const { env } = fakeHistory(join(tmp, "cli"));
    const main = join(import.meta.dir, "main.ts");
    const out = join(tmp, "cli.tar.zst");
    for (const argv of [["export", out, "--encrypt"], ["export", out, "--encrypt", "--x"], ["import", out, "--identity"]]) {
      const r = Bun.spawnSync([process.execPath, main, ...argv], { env: { ...process.env, ...env } });
      expect(r.exitCode).toBe(2);
    }
    expect(existsSync(out)).toBe(false);
  }, 30_000); // three `bun main.ts` processes: over the 5 s default on a loaded machine
});

/** A runner that records how it was started and finishes each turn at once. */
function recordingAdapter(starts: StartOptions[]): RunnerAdapter {
  return {
    id: "claude",
    async detect() {
      return { available: true, version: "fake" };
    },
    start(opts, emit) {
      starts.push(opts);
      queueMicrotask(() => {
        emit({ t: "session.start", runner: "claude", runnerSessionId: opts.resumeSessionId ?? "new-session", cwd: opts.cwd });
        emit({ t: "session.end", status: "ok", summary: "ok" });
      });
      return { send() {}, respondPermission() {}, abort: async () => {}, close: async () => {}, exited: Promise.resolve(0) };
    },
  };
}

describe("after a migration", () => {
  test("a migrated task resumes the runner session; a task whose cwd is gone lists but fails to send", async () => {
    const { cfg } = fakeHistory(join(tmp, "ma"));
    const repo = join(tmp, "ma-repo"); // stands in for the same absolute path cloned on the new machine
    mkdirSync(repo);
    const db = new Db(cfg.dbPath);
    db.insertTask({ ...task("ok", repo), runnerSessionId: "sess-1" });
    db.insertTask(task("gone", "/nonexistent/repo"));
    db.appendEvent("ok", { t: "message.delta", role: "assistant", text: "earlier answer" });
    db.appendEvent("gone", { t: "message.delta", role: "assistant", text: "answer from a worktree" });
    db.close();
    const out = join(tmp, "ma.tar.zst");
    await exportHistory(cfg, out);
    const b = emptyHome(join(tmp, "mb"));
    await importHistory(b, out);

    const starts: StartOptions[] = [];
    const core = await startServer({ ...b, historyPollMs: 0 }, [recordingAdapter(starts)], { port: 0, selfdevChecks: false });
    const base = `http://127.0.0.1:${core.server.port}`;
    const send = (id: string) => fetch(`${base}/api/tasks/${id}/send`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "続けて" }) });
    try {
      const listed = (await fetch(`${base}/api/tasks`).then((r) => r.json())) as Task[];
      expect(listed.map((t) => t.id).sort()).toEqual(["gone", "ok", "t1", "t2"]);
      type Detail = { task: Task; events: Array<{ ev: { t: string; text?: string } }> };
      const texts = async (id: string) => ((await fetch(`${base}/api/tasks/${id}`).then((r) => r.json())) as Detail).events.map((e) => e.ev.text);
      expect(await texts("gone")).toContain("answer from a worktree");
      expect(await texts("ok")).toContain("earlier answer");
      const diff = await fetch(`${base}/api/tasks/gone/diff`);
      expect(diff.status).toBe(200);
      expect(await diff.json()).toEqual([]);

      expect((await send("ok")).status).toBe(200);
      expect(starts.length).toBe(1);
      expect(starts[0]?.resumeSessionId).toBe("sess-1");
      expect(starts[0]?.cwd).toBe(repo);

      const refused = await send("gone");
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { error: string }).error).toContain("/nonexistent/repo");
      expect(starts.length).toBe(1); // no runner is started in a folder that does not exist
      const gone = (await fetch(`${base}/api/tasks/gone`).then((r) => r.json())) as Detail;
      expect(gone.task.status).toBe("error");
      expect(gone.events.some((e) => e.ev.t === "status" && e.ev.text?.includes("/nonexistent/repo"))).toBe(true);
      expect((await fetch(`${base}/api/health`)).status).toBe(200);
    } finally {
      await core.stop();
    }
  });
});
