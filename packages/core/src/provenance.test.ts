// test-reads: none
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectProvenance } from "./provenance.ts";

const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });

test("collectProvenance hashes the bundle, reads the head and sizes the instruction files; what is missing is null", () => {
  const root = mkdtempSync(join(tmpdir(), "switchboard-prov-"));
  try {
    const meta = join(root, "meta");
    const cwd = join(root, "repo");
    mkdirSync(join(meta, "ops-kit/skills/a"), { recursive: true });
    mkdirSync(join(meta, "ops-kit/processes"), { recursive: true });
    writeFileSync(join(meta, "ops-kit/skills/a/SKILL.md"), "skill a");
    writeFileSync(join(meta, "ops-kit/processes/p.md"), "---\nid: p\nversion: 1\ntitle: P\n---\n");
    mkdirSync(join(cwd, ".claude/skills/own"), { recursive: true });
    writeFileSync(join(cwd, ".claude/skills/own/SKILL.md"), "0123456789"); // 10 bytes
    writeFileSync(join(cwd, "CLAUDE.md"), "rules\n"); // 6 bytes
    writeFileSync(join(cwd, "AGENTS.md"), "see\n"); // 4 bytes
    git(cwd, "init", "-q"); git(cwd, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const head = git(cwd, "rev-parse", "HEAD").stdout.toString().trim();

    const p = collectProvenance({ cwd, metaPath: meta, runner: "claude", model: "m", effort: null, permissionMode: "auto", process: { id: "p", version: 1 }, processReason: "test", now: 5 });
    expect(p).toMatchObject({ v: 1, process: { id: "p", version: 1 }, processReason: "test", runner: "claude", model: "m", effort: null, permissionMode: "auto", instructionBytes: 20, recordedAt: 5, repo: { head } });
    for (const h of [p.bundle.skills, p.bundle.repoSkills, p.bundle.claudeMd, p.bundle.processes]) expect(h).toMatch(/^[0-9a-f]{64}$/);
    // the hashes follow the contents
    writeFileSync(join(meta, "ops-kit/skills/a/SKILL.md"), "skill a v2");
    const p2 = collectProvenance({ cwd, metaPath: meta, runner: "claude", model: "m", effort: null, permissionMode: "auto" });
    expect(p2.bundle.skills).not.toBe(p.bundle.skills);
    expect(p2.bundle.repoSkills).toBe(p.bundle.repoSkills);
    expect(p2.process).toBeNull();
    expect(p2.processReason).toBeNull();

    // a dangling link under the project skills (a copy the sync has not cleaned yet): that part is null, the rest stays
    symlinkSync(join(root, "gone"), join(cwd, ".claude/skills/own/dangling"));
    const p4 = collectProvenance({ cwd, metaPath: meta, runner: "claude", model: null, effort: null, permissionMode: null });
    expect(p4.bundle.repoSkills).toBeNull();
    expect(p4.instructionBytes).toBeNull();
    expect(p4.bundle.skills).toBe(p2.bundle.skills);
    expect(p4.bundle.claudeMd).toBe(p.bundle.claudeMd);
    expect(p4.repo.head).toBe(head);
    rmSync(join(cwd, ".claude/skills/own/dangling"));

    // nothing registered, nothing in the working directory: nulls and 0 bytes, never a throw
    const bare = join(root, "bare");
    mkdirSync(bare);
    const p3 = collectProvenance({ cwd: bare, metaPath: null, runner: "codex", model: null, effort: "high", permissionMode: null });
    expect(p3).toMatchObject({ bundle: { skills: null, repoSkills: null, claudeMd: null, processes: null }, repo: { head: null }, instructionBytes: 0, runner: "codex", effort: "high" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
