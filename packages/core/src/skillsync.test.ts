import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerSession, StartOptions } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { SKILL_MARKER, SKILL_SOURCE, SKILL_TARGETS, setupScripts, syncSkills } from "./skillsync.ts";
import { TaskManager } from "./tasks.ts";

let root: string;
let meta: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

function initRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "dev@example.com");
  git(dir, "config", "user.name", "dev");
}

function writeSkill(name: string, body = `# ${name}\n`) {
  mkdirSync(join(meta, SKILL_SOURCE, name), { recursive: true });
  writeFileSync(join(meta, SKILL_SOURCE, name, "SKILL.md"), body);
}

const exclude = () => readFileSync(join(repo, ".git/info/exclude"), "utf8");

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sb-skillsync-")));
  meta = join(root, "meta");
  repo = join(root, "repo");
  initRepo(meta);
  initRepo(repo);
  writeSkill("issue-workflow");
  writeSkill("task-to-pr");
  writeFileSync(join(repo, "README.md"), "repo\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("syncSkills (#469)", () => {
  test("syncSkills: コピー — copies the standard skills into both targets as real folders and excludes them", () => {
    const r = syncSkills({ metaPath: meta, cwd: repo });
    expect(r.linked.sort()).toEqual(["issue-workflow", "task-to-pr"]);
    for (const target of SKILL_TARGETS) {
      for (const name of ["issue-workflow", "task-to-pr"]) {
        const p = join(repo, target, name);
        expect(lstatSync(p).isDirectory()).toBe(true);
        expect(readFileSync(join(p, "SKILL.md"), "utf8")).toBe(`# ${name}\n`);
        expect(readdirSync(p).sort()).toEqual([SKILL_MARKER, "SKILL.md"].sort());
      }
    }
    expect(git(repo, "status", "--short")).toBe("");
    expect(readFileSync(join(repo, ".gitignore"), "utf8")).toBe("node_modules\n");
    expect(exclude()).toContain("/.claude/skills/issue-workflow\n");
    expect(exclude()).toContain("/.agents/skills/task-to-pr\n");
    // A second run with nothing changed touches nothing.
    const before = statSync(join(repo, ".claude/skills/issue-workflow/SKILL.md")).mtimeMs;
    const again = syncSkills({ metaPath: meta, cwd: repo });
    expect(statSync(join(repo, ".claude/skills/issue-workflow/SKILL.md")).mtimeMs).toBe(before);
    expect(again.linked).toEqual([]);
    expect(again.unchanged.sort()).toEqual(["issue-workflow", "task-to-pr"]);
  });

  test("syncSkills: a source skill with a link to a folder is copied as real files", () => {
    mkdirSync(join(meta, "shared-refs"));
    writeFileSync(join(meta, "shared-refs/ref.md"), "ref\n");
    symlinkSync(join(meta, "shared-refs"), join(meta, SKILL_SOURCE, "task-to-pr/refs"), "dir");
    syncSkills({ metaPath: meta, cwd: repo });
    expect(lstatSync(join(repo, ".claude/skills/task-to-pr/refs")).isDirectory()).toBe(true);
    expect(readFileSync(join(repo, ".claude/skills/task-to-pr/refs/ref.md"), "utf8")).toBe("ref\n");
    expect(syncSkills({ metaPath: meta, cwd: repo }).unchanged.sort()).toEqual(["issue-workflow", "task-to-pr"]);
  });

  test("syncSkills: a changed or removed source skill is reflected on the next run", () => {
    syncSkills({ metaPath: meta, cwd: repo });
    writeSkill("issue-workflow", "# changed\n");
    writeFileSync(join(meta, SKILL_SOURCE, "issue-workflow/extra.md"), "x\n");
    rmSync(join(meta, SKILL_SOURCE, "task-to-pr"), { recursive: true });
    const r = syncSkills({ metaPath: meta, cwd: repo });
    expect(r.linked).toEqual(["issue-workflow"]);
    expect(readFileSync(join(repo, ".claude/skills/issue-workflow/SKILL.md"), "utf8")).toBe("# changed\n");
    expect(existsSync(join(repo, ".agents/skills/issue-workflow/extra.md"))).toBe(true);
    // A file that left the source leaves the copy too.
    rmSync(join(meta, SKILL_SOURCE, "issue-workflow/extra.md"));
    syncSkills({ metaPath: meta, cwd: repo });
    expect(existsSync(join(repo, ".claude/skills/issue-workflow/extra.md"))).toBe(false);
    expect(r.removed).toEqual(["task-to-pr"]);
    for (const target of SKILL_TARGETS) expect(existsSync(join(repo, target, "task-to-pr"))).toBe(false);
    expect(exclude()).not.toContain("task-to-pr");
    expect(exclude()).toContain("/.claude/skills/issue-workflow\n");
    expect(git(repo, "status", "--short")).toBe("");
  });

  test("syncSkills: a repository's own skill of the same name is left alone", () => {
    // Tracked in the repository.
    mkdirSync(join(repo, ".claude/skills/issue-workflow"), { recursive: true });
    writeFileSync(join(repo, ".claude/skills/issue-workflow/SKILL.md"), "# own\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "own skill");
    // Untracked real directory.
    mkdirSync(join(repo, ".agents/skills/task-to-pr"), { recursive: true });
    writeFileSync(join(repo, ".agents/skills/task-to-pr/SKILL.md"), "# mine\n");
    const r = syncSkills({ metaPath: meta, cwd: repo });
    expect(r.skipped).toEqual([
      { name: "issue-workflow", path: join(repo, ".claude/skills/issue-workflow") },
      { name: "task-to-pr", path: join(repo, ".agents/skills/task-to-pr") },
    ]);
    expect(readFileSync(join(repo, ".claude/skills/issue-workflow/SKILL.md"), "utf8")).toBe("# own\n");
    expect(readFileSync(join(repo, ".agents/skills/task-to-pr/SKILL.md"), "utf8")).toBe("# mine\n");
    // A real folder without the marker is not Switchboard's: neither rewritten nor removed when the source drops the skill.
    rmSync(join(meta, SKILL_SOURCE, "task-to-pr"), { recursive: true });
    expect(syncSkills({ metaPath: meta, cwd: repo }).removed).toEqual(["task-to-pr"]); // only the .claude copy
    expect(existsSync(join(repo, ".claude/skills/task-to-pr"))).toBe(false);
    expect(readFileSync(join(repo, ".agents/skills/task-to-pr/SKILL.md"), "utf8")).toBe("# mine\n");
    expect(exclude()).not.toContain("/.claude/skills/issue-workflow\n");
    expect(exclude()).toContain("/.agents/skills/issue-workflow\n");
  });

  test("syncSkills: the managed exclude block keeps the user's lines, is written once, and goes away when nothing is placed", () => {
    const file = join(repo, ".git/info/exclude");
    // A block cut short by a hand edit (no end marker) ends at the first line that is not a managed path.
    writeFileSync(file, "user1\n# >>> switchboard skills (managed)\n/.claude/skills/old\nuser2\n");
    syncSkills({ metaPath: meta, cwd: repo });
    syncSkills({ metaPath: meta, cwd: repo });
    const text = exclude();
    expect(text.startsWith("user1\nuser2\n# >>> switchboard skills (managed)\n")).toBe(true);
    expect(text.split("# >>> switchboard skills").length).toBe(2);
    expect(text).not.toContain("/.claude/skills/old");
    rmSync(join(meta, SKILL_SOURCE), { recursive: true });
    syncSkills({ metaPath: meta, cwd: repo });
    expect(exclude()).toBe("user1\nuser2\n");
  });

  test("syncSkills: a skill skipped in one worktree stays excluded for another worktree of the same repository", () => {
    syncSkills({ metaPath: meta, cwd: repo });
    // The branch checked out in the worktree tracks its own issue-workflow; exclude is shared by all worktrees.
    const wt = join(root, "repo-wt");
    git(repo, "worktree", "add", "-q", "-b", "own", wt);
    mkdirSync(join(wt, ".claude/skills/issue-workflow"), { recursive: true });
    writeFileSync(join(wt, ".claude/skills/issue-workflow/SKILL.md"), "# own\n");
    git(wt, "add", "-f", ".claude/skills/issue-workflow"); // -f: the shared exclude already lists that path
    git(wt, "commit", "-qm", "own skill");
    const r = syncSkills({ metaPath: meta, cwd: wt });
    expect(r.skipped.map((s) => s.name)).toEqual(["issue-workflow"]);
    expect(git(repo, "status", "--short")).toBe("");
    expect(git(wt, "status", "--short")).toBe("");
    // The line stays because the main checkout still has the link; once no worktree has it, it goes.
    expect(exclude()).toContain("/.claude/skills/issue-workflow\n");
    rmSync(join(repo, ".claude/skills/issue-workflow"), { recursive: true });
    syncSkills({ metaPath: meta, cwd: wt });
    expect(exclude()).not.toContain("/.claude/skills/issue-workflow\n");
  });

  test("syncSkills: a copy the user replaced with their own folder is no longer excluded", () => {
    syncSkills({ metaPath: meta, cwd: repo });
    rmSync(join(repo, ".claude/skills/issue-workflow"), { recursive: true });
    mkdirSync(join(repo, ".claude/skills/issue-workflow"));
    writeFileSync(join(repo, ".claude/skills/issue-workflow/SKILL.md"), "# mine\n");
    const r = syncSkills({ metaPath: meta, cwd: repo });
    expect(r.skipped.map((s) => s.name)).toEqual(["issue-workflow"]);
    expect(exclude()).not.toContain("/.claude/skills/issue-workflow\n");
    expect(git(repo, "status", "--short", "--untracked-files=all")).toBe("?? .claude/skills/issue-workflow/SKILL.md\n");
  });

  test("syncSkills: a line the user put inside an intact block is kept outside it, and the block stays one", () => {
    const file = join(repo, ".git/info/exclude");
    writeFileSync(file, "# >>> switchboard skills (managed)\n/.claude/skills/old\n# mine\n/build\n# <<< switchboard skills\n");
    syncSkills({ metaPath: meta, cwd: repo });
    const text = exclude();
    expect(text.startsWith("# mine\n/build\n# >>> switchboard skills (managed)\n")).toBe(true);
    expect(text.split("# >>> switchboard skills").length).toBe(2);
    expect(text.split("# <<< switchboard skills").length).toBe(2);
  });

  test("syncSkills: a link another worktree still has to a removed skill stays excluded until that worktree drops it", () => {
    git(repo, "worktree", "add", "-q", "--detach", join(root, "repo-wt2"));
    const wt = join(root, "repo-wt2");
    syncSkills({ metaPath: meta, cwd: repo });
    syncSkills({ metaPath: meta, cwd: wt });
    rmSync(join(meta, SKILL_SOURCE, "task-to-pr"), { recursive: true });
    syncSkills({ metaPath: meta, cwd: repo });
    expect(existsSync(join(repo, ".claude/skills/task-to-pr"))).toBe(false);
    expect(git(wt, "status", "--short")).toBe(""); // wt's dangling link is still listed
    syncSkills({ metaPath: meta, cwd: wt });
    expect(exclude()).not.toContain("task-to-pr");
  });

  test("syncSkills: an old link into the source or through the meta's folder is replaced by a copy; a link elsewhere is the user's", () => {
    mkdirSync(join(repo, ".claude/skills"), { recursive: true });
    mkdirSync(join(repo, ".agents/skills"), { recursive: true });
    symlinkSync(join(meta, SKILL_SOURCE, "task-to-pr"), join(repo, ".claude/skills/task-to-pr")); // direct
    // Placed while the source was the meta's .claude/skills: leads there through the meta's own folder, which this run makes a copy.
    mkdirSync(join(meta, ".claude/skills"), { recursive: true });
    symlinkSync(join(meta, SKILL_SOURCE, "issue-workflow"), join(meta, ".claude/skills/issue-workflow"), "dir");
    symlinkSync(join(meta, ".claude/skills/issue-workflow"), join(repo, ".claude/skills/issue-workflow"));
    // A link to another repository's copy of the same skill is not Switchboard's: left alone, and not removed with the source.
    const other = join(root, "other");
    initRepo(other);
    syncSkills({ metaPath: meta, cwd: other });
    symlinkSync(join(other, ".agents/skills/issue-workflow"), join(repo, ".agents/skills/issue-workflow"));
    // Also a repository nested under the meta checkout.
    const nested = join(meta, "nested");
    initRepo(nested);
    syncSkills({ metaPath: meta, cwd: nested });
    symlinkSync(join(nested, ".agents/skills/task-to-pr"), join(repo, ".agents/skills/task-to-pr"));
    const r = syncSkills({ metaPath: meta, cwd: repo });
    expect(r.skipped).toEqual([
      { name: "issue-workflow", path: join(repo, ".agents/skills/issue-workflow") },
      { name: "task-to-pr", path: join(repo, ".agents/skills/task-to-pr") },
    ]);
    for (const p of [".claude/skills/task-to-pr", ".claude/skills/issue-workflow"]) {
      expect(lstatSync(join(repo, p)).isDirectory()).toBe(true);
      expect(existsSync(join(repo, p, SKILL_MARKER))).toBe(true);
    }
    expect(lstatSync(join(repo, ".agents/skills/issue-workflow")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(meta, SKILL_SOURCE, "task-to-pr/SKILL.md"), "utf8")).toBe("# task-to-pr\n");
    expect(exclude()).toContain("/.claude/skills/task-to-pr\n");
    expect(exclude()).toContain("/.claude/skills/issue-workflow\n");
    expect(exclude()).not.toContain("/.agents/skills/issue-workflow\n");
    rmSync(join(meta, SKILL_SOURCE, "issue-workflow"), { recursive: true });
    expect(syncSkills({ metaPath: meta, cwd: repo }).removed).toEqual(["issue-workflow"]); // the .claude copy only
    expect(lstatSync(join(repo, ".agents/skills/issue-workflow")).isSymbolicLink()).toBe(true);
  });

  test("syncSkills: the meta repository gets copies next to its own tracked skills", () => {
    // The meta repository keeps its own skills tracked in .claude/skills; the shared ones come from SKILL_SOURCE.
    mkdirSync(join(meta, ".claude/skills/own-notes"), { recursive: true });
    writeFileSync(join(meta, ".claude/skills/own-notes/SKILL.md"), "# own\n");
    git(meta, "add", ".");
    git(meta, "commit", "-qm", "skills");
    const r = syncSkills({ metaPath: meta, cwd: meta });
    expect(r.linked.sort()).toEqual(["issue-workflow", "task-to-pr"]);
    for (const target of SKILL_TARGETS) expect(readFileSync(join(meta, target, "task-to-pr/SKILL.md"), "utf8")).toBe("# task-to-pr\n");
    expect(readFileSync(join(meta, ".claude/skills/own-notes/SKILL.md"), "utf8")).toBe("# own\n");
    expect(git(meta, "status", "--short")).toBe("");
    // A worktree of the meta repository gets the same copies (copied from the meta checkout's source).
    const wt = join(root, "meta-wt");
    git(meta, "worktree", "add", "-q", "--detach", wt);
    expect(syncSkills({ metaPath: meta, cwd: wt }).linked.sort()).toEqual(["issue-workflow", "task-to-pr"]);
    expect(git(wt, "status", "--short")).toBe("");
  });

  test("syncSkills: a target that is the source directory itself is left alone, and a non-git folder is untouched", () => {
    mkdirSync(join(meta, ".agents"));
    symlinkSync(join(meta, SKILL_SOURCE), join(meta, ".agents/skills"), "dir"); // Codex's folder is the source itself
    const r = syncSkills({ metaPath: meta, cwd: meta });
    expect(r.skipped).toEqual([]);
    expect(r.removed).toEqual([]);
    expect(readFileSync(join(meta, SKILL_SOURCE, "task-to-pr/SKILL.md"), "utf8")).toBe("# task-to-pr\n");
    expect(lstatSync(join(meta, SKILL_SOURCE, "task-to-pr")).isDirectory()).toBe(true);
    expect(lstatSync(join(meta, ".claude/skills/task-to-pr")).isDirectory()).toBe(true);
    const plain = join(root, "plain");
    mkdirSync(plain);
    expect(syncSkills({ metaPath: meta, cwd: plain })).toEqual({ linked: [], unchanged: [], removed: [], skipped: [] });
    expect(existsSync(join(plain, ".claude"))).toBe(false);
  });
});

describe("setupScripts (#557)", () => {
  const put = (dir: string, rel: string, body: string) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  };
  beforeEach(() => {
    for (const f of ["bootstrap_project.sh", "lint_backlog.sh", "request_issue.sh", "scan_issues.sh", "set_project_field.sh", "triage_issue.sh"]) {
      put(meta, `scripts/setup/${f}`, 'exec bun "$R/ops-kit/src/cli.ts"\n');
    }
  });

  test("写し — an entry named like the meta's that does not call the kit is a copy", () => {
    put(repo, "scripts/setup/lint_backlog.sh", "#!/usr/bin/env bash\ngh issue list\n");
    expect(setupScripts({ metaPath: meta, cwd: repo })).toEqual({ config: false, kit: [], copies: ["lint_backlog.sh"] });
  });

  test("写し — an entry that only calls the kit is not a copy", () => {
    put(repo, "scripts/setup/lint_backlog.sh", 'exec bun "$K/src/cli.ts" lint "$@"\n');
    expect(setupScripts({ metaPath: meta, cwd: repo })).toEqual({ config: false, kit: ["lint_backlog.sh"], copies: [] });
  });

  test("写し — a repository without scripts/setup has none, and the meta itself has none", () => {
    expect(setupScripts({ metaPath: meta, cwd: repo })).toEqual({ config: false, kit: [], copies: [] });
    expect(setupScripts({ metaPath: meta, cwd: meta }).copies).toEqual([]);
  });

  test("写し — an entry that calls a bundled copy of the kit is not a copy", () => {
    put(repo, "scripts/setup/lint_backlog.sh", 'exec bun "$R/vendor/ops-kit/src/cli.ts" lint "$@"\n');
    expect(setupScripts({ metaPath: meta, cwd: repo }).copies).toEqual([]);
  });

  test("写し — names the meta does not have are the repository's own; another extension still counts; config is reported", () => {
    put(repo, "scripts/setup/install_hooks.sh", "echo hi\n");
    put(repo, "scripts/setup/request_issue.py", "print('hi')\n");
    put(repo, "ops.config.json", "{}\n");
    expect(setupScripts({ metaPath: meta, cwd: repo })).toEqual({ config: true, kit: [], copies: ["request_issue.py"] });
  });
});

function fakeAdapter(seen: string[][]): RunnerAdapter {
  return {
    id: "claude",
    async detect() {
      return { available: true };
    },
    start(opts: StartOptions, emit: (ev: AgentEvent) => void) {
      // What the runner would find in its working folder at the moment it starts.
      seen.push(SKILL_TARGETS.flatMap((t) => (existsSync(join(opts.cwd, t, "task-to-pr", "SKILL.md")) ? [t] : [])));
      let resolveExit!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (resolveExit = r));
      queueMicrotask(() => {
        emit({ t: "session.end", status: "ok" });
        resolveExit(0);
      });
      const session: RunnerSession = { send: () => undefined, respondPermission: () => undefined, abort: async () => resolveExit(null), close: async () => resolveExit(0), exited };
      return session;
    },
  };
}

test("startSession: skills are in place before the runner starts, and a skipped one is noted on the task", () => {
  mkdirSync(join(repo, ".claude/skills/issue-workflow"), { recursive: true });
  writeFileSync(join(repo, ".claude/skills/issue-workflow/SKILL.md"), "# own\n");
  const db = new Db(join(root, "db.sqlite"));
  db.upsertWorkspace({ name: "switchboard", path: meta, kind: "meta" });
  db.upsertWorkspace({ name: "repo", path: repo, kind: "repo" });
  const seen: string[][] = [];
  const tasks = new TaskManager(db, new Map([["claude", fakeAdapter(seen)]]), () => undefined, { idleMs: 0 });
  const t = tasks.create({ cwd: repo, title: "t", prompt: "go", runner: "claude" });
  expect(seen).toEqual([[...SKILL_TARGETS]]);
  const notes = db.listEvents(t.id).flatMap((e) => (e.ev.t === "status" ? [e.ev.text] : []));
  expect(notes).toContain(`スキル issue-workflow はリポジトリにあるもの（${join(repo, ".claude/skills/issue-workflow")}）を使います。Switchboard の正本は置いていません`);
});

test("startSession: a skill that cannot be placed is noted and the runner still starts", () => {
  writeFileSync(join(repo, ".claude"), "not a folder\n");
  const db = new Db(join(root, "db.sqlite"));
  db.upsertWorkspace({ name: "switchboard", path: meta, kind: "meta" });
  const seen: string[][] = [];
  const tasks = new TaskManager(db, new Map([["claude", fakeAdapter(seen)]]), () => undefined, { idleMs: 0 });
  const t = tasks.create({ cwd: repo, title: "t", prompt: "go", runner: "claude" });
  expect(seen).toHaveLength(1);
  const notes = db.listEvents(t.id).flatMap((e) => (e.ev.t === "status" ? [e.ev.text] : []));
  expect(notes.some((n) => n.startsWith("スキルを置けませんでした: "))).toBe(true);
});

test("startSession: 写し — a copy of a tool is noted once and the runner still starts", () => {
  mkdirSync(join(meta, "scripts/setup"), { recursive: true });
  writeFileSync(join(meta, "scripts/setup/lint_backlog.sh"), 'exec bun "$R/ops-kit/src/cli.ts"\n');
  mkdirSync(join(repo, "scripts/setup"), { recursive: true });
  writeFileSync(join(repo, "scripts/setup/lint_backlog.sh"), "gh issue list\n");
  const db = new Db(join(root, "db.sqlite"));
  db.upsertWorkspace({ name: "switchboard", path: meta, kind: "meta" });
  const seen: string[][] = [];
  const tasks = new TaskManager(db, new Map([["claude", fakeAdapter(seen)]]), () => undefined, { idleMs: 0 });
  const t = tasks.create({ cwd: repo, title: "t", prompt: "go", runner: "claude" });
  expect(seen).toHaveLength(1);
  const notes = db.listEvents(t.id).flatMap((e) => (e.ev.t === "status" ? [e.ev.text] : []));
  expect(notes.filter((n) => n.startsWith("scripts/setup/lint_backlog.sh は共通キットを呼ばない写しです。"))).toHaveLength(1);
});

test("startSession: 写し — scripts/setup that cannot be read is noted and the runner still starts", () => {
  mkdirSync(join(meta, "scripts/setup"), { recursive: true });
  writeFileSync(join(meta, "scripts/setup/lint_backlog.sh"), 'exec bun "$R/ops-kit/src/cli.ts"\n');
  mkdirSync(join(repo, "scripts/setup/lint_backlog.sh"), { recursive: true }); // a folder: reading it throws EISDIR
  const db = new Db(join(root, "db.sqlite"));
  db.upsertWorkspace({ name: "switchboard", path: meta, kind: "meta" });
  const seen: string[][] = [];
  const tasks = new TaskManager(db, new Map([["claude", fakeAdapter(seen)]]), () => undefined, { idleMs: 0 });
  const t = tasks.create({ cwd: repo, title: "t", prompt: "go", runner: "claude" });
  expect(seen).toHaveLength(1);
  const notes = db.listEvents(t.id).flatMap((e) => (e.ev.t === "status" ? [e.ev.text] : []));
  expect(notes.some((n) => n.startsWith("scripts/setup を調べられませんでした: "))).toBe(true);
});
