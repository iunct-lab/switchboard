// test-reads: ops-kit/skills/
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, RunnerAdapter, RunnerSession, StartOptions } from "@switchboard/protocol";
import { Db } from "./db.ts";
import { type Conditions, renderConditions } from "../../../ops-kit/src/conditions.ts";
import { SKILL_INCOMPLETE, SKILL_MARKER, SKILL_SOURCE, SKILL_TARGETS, setupScripts, skillHeader, skillPathsFor, syncSkills } from "./skillsync.ts";
import { stopArmedQueues } from "./tasks/state.ts";
import { TaskManager } from "./tasks/manager.ts";

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

/** What a placed SKILL.md holds for a source without a frontmatter: the line that names the source, then the body. */
const placed = (name: string, body = `# ${name}\n`) => `${skillHeader(join(meta, SKILL_SOURCE, name, "SKILL.md"))}\n\n${body}`;

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
  // a manager a test made and did not shut down would tick on this test's closed database
  stopArmedQueues();
  rmSync(root, { recursive: true, force: true });
});

describe("syncSkills", () => {
  test("syncSkills: コピー — copies the standard skills into both targets as real folders and excludes them", () => {
    const r = syncSkills({ metaPath: meta, cwd: repo });
    expect(r.linked.sort()).toEqual(["issue-workflow", "task-to-pr"]);
    for (const target of SKILL_TARGETS) {
      for (const name of ["issue-workflow", "task-to-pr"]) {
        const p = join(repo, target, name);
        expect(lstatSync(p).isDirectory()).toBe(true);
        expect(readFileSync(join(p, "SKILL.md"), "utf8")).toBe(placed(name));
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
    expect(readFileSync(join(repo, ".claude/skills/issue-workflow/SKILL.md"), "utf8")).toBe(placed("issue-workflow", "# changed\n"));
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
    for (const target of SKILL_TARGETS) expect(readFileSync(join(meta, target, "task-to-pr/SKILL.md"), "utf8")).toBe(placed("task-to-pr"));
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

describe("setupScripts", () => {
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

  test("the settings kept on Switchboard's side count only for a repository with no ops.config.json of its own", () => {
    const saved = join(root, "kept.json");
    writeFileSync(saved, '{"mergeGate":"scripts/gate.ts"}\n');
    expect(setupScripts({ metaPath: meta, cwd: repo, saved })).toEqual({ config: false, kit: [], copies: [], saved: true });
    // a file that is named but gone is none; and none named is none
    expect(setupScripts({ metaPath: meta, cwd: repo, saved: join(root, "gone.json") })).toEqual({ config: false, kit: [], copies: [] });
    expect(setupScripts({ metaPath: meta, cwd: repo })).toEqual({ config: false, kit: [], copies: [] });
    put(repo, "ops.config.json", "{}\n");
    expect(setupScripts({ metaPath: meta, cwd: repo, saved })).toEqual({ config: true, kit: [], copies: [] });
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
  expect(seen).toEqual([[".claude/skills"]]); // the Task's runner's place only
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

test("startSession: when the skills cannot be placed again, the runner is not started on a copy rendered for another review setting — the start is refused with the reason; with the copies verified to be the current setting's it still starts", async () => {
  if (process.getuid?.() === 0) return; // root writes through the modes this test sets
  writeSkill("cross-runner-review", ["# review", "<!-- when review=other -->", "別のランナーに頼む", "<!-- end when -->", "<!-- when review=same -->", "同じランナーに頼む", "<!-- end when -->", ""].join("\n"));
  const db = new Db(join(root, "db.sqlite"));
  db.upsertWorkspace({ name: "switchboard", path: meta, kind: "meta" });
  db.upsertWorkspace({ name: "repo", path: repo, kind: "repo" });
  let review: "other" | "same" = "other";
  const seen: string[] = [];
  const base = fakeAdapter([]);
  // what the runner would read of the review setting at the moment it starts
  const adapter: RunnerAdapter = { ...base, start: (opts, emit) => (seen.push(readFileSync(join(opts.cwd, ".claude/skills/cross-runner-review/SKILL.md"), "utf8").includes("同じランナーに頼む") ? "same" : "other"), base.start(opts, emit)) };
  const tasks = new TaskManager(db, new Map([["claude", adapter]]), () => undefined, { idleMs: 0, reviewRunner: () => review });
  const notesOf = (id: string) => db.listEvents(id).flatMap((e) => (e.ev.t === "status" ? [e.ev.text] : []));
  const skills = join(repo, ".claude/skills");
  const lock = (mode: number) => { for (const d of [skills, ...readdirSync(skills).map((n) => join(skills, n))]) chmodSync(d, mode); };
  try {
    tasks.create({ cwd: repo, title: "first", prompt: "go", runner: "claude" });
    expect(seen).toEqual(["other"]);
    // the setting changes, and the copies cannot be written again
    review = "same";
    lock(0o555);
    let refused: unknown;
    let second: string | undefined;
    try {
      second = tasks.create({ cwd: repo, title: "second", prompt: "go", runner: "claude" }).id;
    } catch (e) {
      refused = e;
    }
    // the runner was not started with the copy of the other setting
    expect(seen).toEqual(["other"]);
    const stopped = db.listTasks().find((t) => t.title === "second")!;
    expect(second === undefined || second === stopped.id).toBe(true);
    expect(stopped.status).toBe("error");
    expect(notesOf(stopped.id).some((n) => n.startsWith("スキルを今の設定（レビューするランナーなど）で置き直せず、置いてある写しが今の設定のものと確かめられないため、Task を始めません: "))).toBe(true);
    expect(refused === undefined || String((refused as Error).message).includes("Task を始めません")).toBe(true);
    // writable again: the copies are placed for the setting now, and the runner reads that
    lock(0o755);
    tasks.create({ cwd: repo, title: "third", prompt: "go", runner: "claude" });
    expect(seen).toEqual(["other", "same"]);
    // a failure that leaves the copies as they should be (the exclude file cannot be written): verified, noted, started
    const exclude = join(repo, ".git/info/exclude");
    writeFileSync(exclude, "");
    chmodSync(exclude, 0o444);
    const fourth = tasks.create({ cwd: repo, title: "fourth", prompt: "go", runner: "claude" });
    expect(seen).toEqual(["other", "same", "same"]);
    expect(notesOf(fourth.id).some((n) => n.startsWith("スキルを置けませんでした: "))).toBe(true);
    expect(db.getTask(fourth.id)!.status).not.toBe("error");
    chmodSync(exclude, 0o644);
  } finally {
    lock(0o755);
    await tasks.shutdown();
    db.close();
  }
});

test("startSession: a copy that stopped part-way is not the repository's own skill — the start is refused until it can be placed whole, and a later start does not run on what was left", async () => {
  if (process.getuid?.() === 0) return; // root writes through the modes this test sets
  writeSkill("cross-runner-review", ["# review", "<!-- when review=other -->", "別のランナーに頼む", "<!-- end when -->", "<!-- when review=same -->", "同じランナーに頼む", "<!-- end when -->", ""].join("\n"));
  // the source file cannot be written, and the copy takes its mode: the files arrive, then writing the rendered text fails
  const source = join(meta, SKILL_SOURCE, "cross-runner-review/SKILL.md");
  chmodSync(source, 0o444);
  const db = new Db(join(root, "db.sqlite"));
  db.upsertWorkspace({ name: "switchboard", path: meta, kind: "meta" });
  // the Task works in the meta checkout: its own place is the only one this start writes
  const copy = join(meta, ".claude/skills/cross-runner-review");
  const seen: string[] = [];
  const base = fakeAdapter([]);
  const adapter: RunnerAdapter = { ...base, start: (opts, emit) => (seen.push(readFileSync(join(opts.cwd, ".claude/skills/cross-runner-review/SKILL.md"), "utf8")), base.start(opts, emit)) };
  const tasks = new TaskManager(db, new Map([["claude", adapter]]), () => undefined, { idleMs: 0 });
  const refusedStart = (title: string) => {
    try {
      tasks.create({ cwd: meta, title, prompt: "go", runner: "claude" });
    } catch {
      // the refusal may reach the caller as an error too
    }
    const t = db.listTasks().find((x) => x.title === title)!;
    return { status: t.status, refused: db.listEvents(t.id).some((e) => e.ev.t === "status" && e.ev.text.startsWith("スキルを今の設定（レビューするランナーなど）で置き直せず、置いてある写しが今の設定のものと確かめられないため、Task を始めません: ")) };
  };
  try {
    expect(refusedStart("first")).toEqual({ status: "error", refused: true });
    // what the failed placing left: the text of every condition at once, in a folder marked as Switchboard's and not complete
    expect(readFileSync(join(copy, "SKILL.md"), "utf8")).toContain("同じランナーに頼む");
    expect(readFileSync(join(copy, SKILL_MARKER), "utf8").trim()).toBe(SKILL_INCOMPLETE);
    // the next start (a resumed Task takes the same path) tries again and is refused again: nothing ran on the part-way copy
    expect(refusedStart("second")).toEqual({ status: "error", refused: true });
    expect(seen).toEqual([]);
    // a marker lost on the way is not needed to tell: an empty folder left before the first write is placed like a missing one
    chmodSync(source, 0o644);
    rmSync(copy, { recursive: true, force: true });
    mkdirSync(copy);
    const third = tasks.create({ cwd: meta, title: "third", prompt: "go", runner: "claude" });
    expect(db.getTask(third.id)!.status).not.toBe("error");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("別のランナーに頼む");
    expect(seen[0]).not.toContain("同じランナーに頼む");
    expect(readFileSync(join(copy, SKILL_MARKER), "utf8").trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(db.listEvents(third.id).some((e) => e.ev.t === "status" && e.ev.text.includes("リポジトリにあるもの"))).toBe(false);
  } finally {
    chmodSync(source, 0o644);
    await tasks.shutdown();
    db.close();
  }
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

describe("skills by runner and review setting", () => {
  const MARKED = ["---", "name: demo", "<!-- when review=other -->", "description: 別のランナーに頼む", "<!-- end when -->", "<!-- when review=same -->", "description: 同じランナーに頼む", "<!-- end when -->", "---", "", "<!-- when runner=claude -->", "claude の Task", "<!-- end when -->", "<!-- when runner=codex -->", "codex の Task", "<!-- end when -->", ""].join("\n");
  const read = (target: string) => readFileSync(join(repo, target, "demo/SKILL.md"), "utf8");

  test("a runner's Task writes only that runner's place; a runner that reads neither place writes nothing", () => {
    writeSkill("demo", MARKED);
    syncSkills({ metaPath: meta, cwd: repo, runner: "adk" });
    for (const dir of [repo, meta]) for (const target of SKILL_TARGETS) expect(existsSync(join(dir, target))).toBe(false);
    syncSkills({ metaPath: meta, cwd: repo, runner: "claude" });
    expect(read(".claude/skills")).toContain("claude の Task");
    expect(read(".claude/skills")).not.toContain("codex の Task");
    expect(read(".claude/skills")).not.toContain("<!-- when");
    expect(existsSync(join(repo, ".agents/skills"))).toBe(false);
    syncSkills({ metaPath: meta, cwd: repo, runner: "codex" });
    expect(read(".agents/skills")).toContain("codex の Task");
  });

  test("a changed setting renders the copy again; the same setting leaves it", () => {
    writeSkill("demo", MARKED);
    expect(syncSkills({ metaPath: meta, cwd: repo, runner: "claude", review: "other" }).linked).toContain("demo");
    expect(read(".claude/skills")).toContain("description: 別のランナーに頼む");
    expect(syncSkills({ metaPath: meta, cwd: repo, runner: "claude", review: "other" }).unchanged).toContain("demo");
    expect(syncSkills({ metaPath: meta, cwd: repo, runner: "claude", review: "same" }).linked).toContain("demo");
    expect(read(".claude/skills")).toContain("description: 同じランナーに頼む");
    expect(read(".claude/skills")).not.toContain("別のランナー");
    // the copy of the other runner's place is not this Task's to rewrite
    syncSkills({ metaPath: meta, cwd: repo, runner: "codex", review: "other" });
    expect(read(".claude/skills")).toContain("description: 同じランナーに頼む");
  });

  test("the line that names the source comes right after the frontmatter", () => {
    writeSkill("demo", MARKED);
    syncSkills({ metaPath: meta, cwd: repo, runner: "claude" });
    const lines = read(".claude/skills").split("\n");
    expect(lines.slice(0, 6)).toEqual(["---", "name: demo", "description: 別のランナーに頼む", "---", "", skillHeader(join(meta, SKILL_SOURCE, "demo/SKILL.md"))]);
  });
});

describe("skills by repository conditions", () => {
  const MARKED = ["# demo", "<!-- when backlog=github -->", "Issue に書く", "<!-- end when -->", "<!-- when backlog=app -->", "アプリのバックログに書く", "<!-- end when -->", "<!-- when mergeGate=on -->", "判定を回す", "<!-- end when -->", "<!-- when extra=on -->", "追加のレビュアーを呼ぶ", "<!-- end when -->", "<!-- when task=out -->", "直接走らせる", "<!-- end when -->", ""].join("\n");
  const read = () => readFileSync(join(repo, ".claude/skills/demo/SKILL.md"), "utf8");

  test("the backlog, the merge gate and the extra reviewer of the repository choose the side; a session outside a Task is never the reader", () => {
    writeSkill("demo", MARKED);
    syncSkills({ metaPath: meta, cwd: repo, runner: "claude", backlog: () => "switchboard" });
    expect(read()).toContain("アプリのバックログに書く");
    expect(read()).not.toContain("Issue に書く");
    expect(read()).not.toContain("判定を回す");
    expect(read()).not.toContain("追加のレビュアー");
    expect(read()).not.toContain("直接走らせる");
    expect(syncSkills({ metaPath: meta, cwd: repo, runner: "claude", backlog: () => "github" }).linked).toContain("demo");
    expect(read()).toContain("Issue に書く");
    // the repository's ops.config.json: naming a merge gate and an extra reviewer renders the copy again
    writeFileSync(join(repo, "ops.config.json"), JSON.stringify({ mergeGate: "scripts/merge-gate.ts", extraReviewer: "local" }));
    expect(syncSkills({ metaPath: meta, cwd: repo, runner: "claude" }).linked).toContain("demo");
    expect(read()).toContain("判定を回す");
    expect(read()).toContain("追加のレビュアーを呼ぶ");
    expect(syncSkills({ metaPath: meta, cwd: repo, runner: "claude" }).unchanged).toContain("demo");
  });

  test("a repository with no ops.config.json takes the merge gate and the extra reviewer from the settings kept on Switchboard's side; its own file, once there, is read alone", () => {
    writeSkill("demo", MARKED);
    const saved = join(root, "kept-conditions.json");
    writeFileSync(saved, JSON.stringify({ mergeGate: "scripts/merge-gate.ts", extraReviewer: "local" }));
    syncSkills({ metaPath: meta, cwd: repo, runner: "claude", savedConfig: (r) => (r === realpathSync(repo) ? saved : "") });
    expect(read()).toContain("判定を回す");
    expect(read()).toContain("追加のレビュアーを呼ぶ");
    // none handed over: neither
    syncSkills({ metaPath: meta, cwd: repo, runner: "claude" });
    expect(read()).not.toContain("判定を回す");
    // the repository's own file wins as a whole: it names no merge gate, so there is none
    writeFileSync(join(repo, "ops.config.json"), "{}");
    syncSkills({ metaPath: meta, cwd: repo, runner: "claude", savedConfig: () => saved });
    expect(read()).not.toContain("判定を回す");
    expect(read()).not.toContain("追加のレビュアー");
  });

  test("the meta checkout is rendered with its own backlog, not the Task's repository's", () => {
    writeSkill("demo", MARKED);
    syncSkills({ metaPath: meta, cwd: repo, runner: "claude", backlog: (r) => (r === repo ? "switchboard" : "github") });
    expect(read()).toContain("アプリのバックログに書く");
    expect(readFileSync(join(meta, ".claude/skills/demo/SKILL.md"), "utf8")).toContain("Issue に書く");
  });
});

describe("the kit's skills as a Task reads them", () => {
  const kit = join(import.meta.dir, "../../../ops-kit/skills");
  const names = readdirSync(kit);
  const BASE: Conditions = { runner: "claude", review: "other", reviewer: "codex", task: "in", backlog: "github", mergeGate: "on", extra: "off" };
  const render = (name: string, conds: Conditions = {}) => renderConditions(readFileSync(join(kit, name, "SKILL.md"), "utf8"), { ...BASE, ...conds }, name);
  const PAIRS = [
    { review: "same", runner: "claude", reviewer: "claude" },
    { review: "same", runner: "codex", reviewer: "codex" },
    { review: "other", runner: "claude", reviewer: "codex" },
    { review: "other", runner: "codex", reviewer: "claude" },
  ] as const;
  /** The lines that name `--runner <r>` without being the usage-limit fallback. */
  const asksFor = (text: string, r: string) => text.split("\n").filter((l) => l.includes(`--runner ${r}`) && !l.includes("--as fallback"));

  describe("cross-runner-review and pbi-complete by condition", () => {
    test("same: only the steps for a new session of the same runner, description included", () => {
      const text = render("cross-runner-review", PAIRS[0]);
      for (const gone of ["--runner codex", "codex exec", "exec --sandbox", "Claude Code が実装したら Codex", "Codex", "codex", "OPS_KIT_REVIEW_RUNNER", "<!-- when"]) expect({ gone, has: text.includes(gone) }).toEqual({ gone, has: false });
      expect(text.split("\n").find((l) => l.startsWith("description: "))).toContain("実装したのと同じランナーの新しいセッション");
      expect(asksFor(text, "claude").length).toBeGreaterThan(0);
      expect(text).toContain("（同じランナーの別セッション。設定による選択）");
      const codex = render("cross-runner-review", PAIRS[1]);
      expect(asksFor(codex, "codex").length).toBeGreaterThan(0);
      expect(codex).not.toContain("--runner claude");
    });

    test("other: only the steps for the other runner; the Task's own runner is named only as the usage-limit fallback", () => {
      const claude = render("cross-runner-review", PAIRS[2]);
      for (const gone of ["OPS_KIT_REVIEW_RUNNER", "設定で同じランナーを選ぶ", "設定による選択"]) expect({ gone, has: claude.includes(gone) }).toEqual({ gone, has: false });
      expect(claude.split("\n").find((l) => l.startsWith("description: "))).toContain("Claude Code が実装したので Codex");
      expect(asksFor(claude, "codex").length).toBeGreaterThan(0);
      expect(asksFor(claude, "claude")).toEqual([]);
      expect(claude).toContain("--runner claude --as fallback");
      const codex = render("cross-runner-review", PAIRS[3]);
      expect(asksFor(codex, "claude").length).toBeGreaterThan(0);
      expect(asksFor(codex, "codex")).toEqual([]);
      expect(codex).toContain("--runner codex --as fallback");
    });

    test("every combination keeps the section on usage limits", () => {
      for (const pair of PAIRS) {
        const text = render("cross-runner-review", pair);
        const section = text.slice(text.indexOf("## 0. 枠を見る"), text.indexOf("## 1. 材料を用意する"));
        expect({ pair, says: section.includes("代替") && section.includes("未レビューのままマージせず") }).toEqual({ pair, says: true });
      }
    });

    test("pbi-complete names the main reviewer of the Task's own setting", () => {
      const same = render("pbi-complete", PAIRS[0]);
      expect(same).not.toContain("レビュー（codex");
      expect(same).toContain("レビュー（claude）");
      expect(same).not.toContain("Codex の 5 時間枠");
      expect(same).not.toContain("別のランナー");
      const other = render("pbi-complete", PAIRS[2]);
      expect(other).toContain("レビュー（codex）");
      expect(other).toContain("Codex の 5 時間枠");
    });
  });

  test("skills for a Task (task=in): nothing a session outside the app does", () => {
    for (const pair of PAIRS) {
      for (const name of names) {
        const text = render(name, pair);
        for (const gone of ["アプリの Task の外では", "Task の外では Bash の background", "バックグラウンドで始めてよい", "<!-- when", "<!-- end when"]) expect({ name, gone, has: text.includes(gone) }).toEqual({ name, gone, has: false });
      }
      // the reviewer is started by the app, not by the Task's shell
      const review = render("cross-runner-review", pair);
      for (const gone of ["exec --sandbox", "claude -p --permission-mode", "ops-kit review-note codex;", "CODEX=$(command -v codex)"]) expect({ gone, has: review.includes(gone) }).toEqual({ gone, has: false });
      expect(review).toContain("ops-kit job request review");
    }
    expect(render("task-to-pr")).toContain("ops-kit job request local-ci");
    expect(render("task-to-pr")).not.toContain("CLAUDE.md のコマンドを直接回す");
    // the source keeps the outside side for whoever reads it there
    expect(render("cross-runner-review", { task: "out" })).toContain("exec --sandbox read-only");
    expect(render("task-to-pr", { task: "out" })).toContain("CLAUDE.md のコマンドを直接回す");
  });

  test("skills by backlog: issues on GitHub or only in the app", () => {
    const github = (name: string) => render(name, { backlog: "github" });
    const local = (name: string) => render(name, { backlog: "app" });
    expect(github("request-to-backlog")).toContain("GitHub Project に載せるまでの型");
    expect(github("request-to-backlog")).not.toContain("アプリのバックログに載せる");
    expect(local("request-to-backlog")).toContain("アプリのバックログに載せるまでの型");
    expect(local("request-to-backlog")).not.toContain("GitHub Project に載せる");
    expect(local("request-to-backlog")).not.toContain("番号が付くまで `localId` で読む");
    for (const name of ["task-to-pr", "stacked-pr-delivery", "request-to-backlog"]) expect({ name, has: github(name).includes("GitHub 連携の無い workspace") }).toEqual({ name, has: false });
    expect(github("task-to-pr")).toContain("Closes #<Task>。<何を・なぜ");
    expect(github("task-to-pr")).not.toContain("ローカルのバックログ");
    expect(local("task-to-pr")).not.toContain("Closes #<Task>。<何を・なぜ");
    expect(local("task-to-pr")).toContain("Backlog-Task: <Task>\n（上の 1 行はこの節の先頭に");
    expect(local("issue-workflow")).toContain("作成で番号が付き、編集はその場で確定する");
    expect(github("issue-workflow")).not.toContain("作成で番号が付き、編集はその場で確定する");
  });

  test("skills by merge gate and extra reviewer", () => {
    for (const name of ["pbi-complete", "review-triage-and-merge"]) {
      const off = render(name, { mergeGate: "off" });
      const on = render(name, { mergeGate: "on" });
      expect({ name, off: off.includes("`mergeGate`") || off.includes("`gh` の前段"), on: on.includes("`mergeGate`") && on.includes("`gh` の前段") }).toEqual({ name, off: false, on: true });
    }
    for (const name of names) expect({ name, has: render(name, { extra: "off" }).includes("<extra>") }).toEqual({ name, has: false });
    for (const name of ["cross-runner-review", "pbi-complete", "review-triage-and-merge", "task-to-pr", "review-with-subagent"]) expect({ name, has: render(name, { extra: "off" }).includes("追加のレビュアー") }).toEqual({ name, has: false });
    const withExtra = render("cross-runner-review", { extra: "on" });
    expect(withExtra).toContain('post_review $N <extra> "$M/<extra>.md"');
    expect(withExtra).toContain("`ops.config.json` の `extraReviewer`");
    expect(render("pbi-complete", { extra: "on" })).toContain("レビュー（codex/<extra>）");
  });

  test("a Task's copies of the 11 skills stay under the measured ceiling, and are smaller than their sources", () => {
    const bytes = names.reduce((n, name) => n + Buffer.byteLength(render(name)), 0);
    const sources = names.reduce((n, name) => n + Buffer.byteLength(readFileSync(join(kit, name, "SKILL.md"))), 0);
    expect(names.length).toBe(11);
    // A ratchet: the bytes a Task is handed, as measured when the ceiling was last set. The texts were 264,343 before
    // they were split by condition and 257,417 after; rules added since took the copy to 279,325, and stating each of
    // them once (in the skill that owns it, or behind its condition) brought it to this number. A text that makes it
    // grow fails here: shorten it (or move it behind a condition), and raise the number only with the reason.
    // Raised to 257,354 (+439 bytes, the copy measured 256,913 before and 257,352 after): what a claim stopped by another
    // machine's lease means and what its exit codes ask for, in pbi-complete (the only skill that owns the claim).
    // Raised to 262,601 (+5,247 bytes over 257,354): the comparison with main when review findings do not converge, once in
    // cross-runner-review (how to run and post it) and once in review-triage-and-merge (when to run it and how to sort its output).
    // Raised to 263,961 (+1,360 bytes over 262,601): a PBI that raises or lowers a review rule carries the row of the repository's rounds table,
    // said in request-to-backlog (how to write it), pbi-to-tasks (the design check that stops it) and issue-workflow (what the repository holds).
    expect(bytes).toBeLessThanOrEqual(263_961);
    // the other sides of the conditions are not carried: a rule written on both sides without marks would not shrink the copy
    expect(bytes).toBeLessThan(sources);
  });
});

describe("skillPathsFor", () => {
  const text = "スキル（`.claude/skills/…`）を使う。.claude/skills/pbi-complete/SKILL.md に従い、.claude/skills/new-repo/SKILL.md も読む。";
  test("a Codex Task's text names the kit's skills in its own place; a skill the repository tracks stays where Git has it", () => {
    expect(skillPathsFor(text, "codex")).toBe("スキル（`.agents/skills/…`）を使う。.agents/skills/pbi-complete/SKILL.md に従い、.claude/skills/new-repo/SKILL.md も読む。");
    // by the kit's own list when none is given: pbi-complete is the kit's, new-repo is this repository's
    expect(skillPathsFor(text, "codex", new Set(["new-repo"]))).toContain(".agents/skills/new-repo/SKILL.md");
  });
  test("Claude Code's text, and a runner that reads neither place, are left as written", () => {
    expect(skillPathsFor(text, "claude")).toBe(text);
    expect(skillPathsFor(text, "custom:adk")).toBe(text);
  });
});
