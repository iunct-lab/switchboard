import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { readCloudPreparation } from "./claude-cloud.ts";
import { cloudTrustGuidance } from "@switchboard/adapter-claude";
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function repo(commit = true) {
  const d = mkdtempSync(join(tmpdir(), "switchboard-cloud-git-")); dirs.push(d);
  git(d, "init", "-q", "-b", "main"); git(d, "config", "user.name", "Fixture"); git(d, "config", "user.email", "fixture@example.invalid");
  if (commit) { writeFileSync(join(d, "tracked"), "one"); git(d, "add", "tracked"); git(d, "commit", "-qm", "initial"); }
  return d;
}
function git(cwd: string, ...args: string[]) { const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }); if (p.exitCode) throw new Error("fixture git failed"); return p.stdout.toString().trim(); }

test("clean/dirty/untracked/unpushed and uncertain upstream; all Git state stays unchanged", () => {
  const d = repo(); git(d, "remote", "add", "origin", "https://github.com/acme/app.git");
  git(d, "update-ref", "refs/remotes/origin/main", "HEAD"); git(d, "branch", "--set-upstream-to", "origin/main");
  expect(readCloudPreparation(d)).toMatchObject({ repository: "acme/app", branch: "main", dirty: false, unpushed: false });
  writeFileSync(join(d, "tracked"), "two"); writeFileSync(join(d, "untracked"), "local only");
  const snapshot = () => [git(d, "rev-parse", "HEAD"), git(d, "status", "--porcelain"), readFileSync(join(d, ".git/index")).toString("hex"), readFileSync(join(d, ".git/config"), "utf8")];
  const before = snapshot(); expect(readCloudPreparation(d).dirty).toBe(true); expect(snapshot()).toEqual(before);
  git(d, "add", "tracked"); git(d, "commit", "-qm", "local"); expect(readCloudPreparation(d).unpushed).toBe(true);
  git(d, "branch", "--unset-upstream"); expect(readCloudPreparation(d).unpushed).toBeNull();
});

test("credentials never appear; SSH supported; unknown remote, unborn and detached are explicit", () => {
  const d = repo(); git(d, "remote", "add", "origin", "https://user:fixture-secret@github.com/acme/app.git");
  const got = readCloudPreparation(d); expect(got.repository).toBe("acme/app"); expect(JSON.stringify(got)).not.toContain("fixture-secret");
  git(d, "remote", "set-url", "origin", "git@github.com:acme/app.git"); expect(readCloudPreparation(d).repository).toBe("acme/app");
  git(d, "checkout", "--detach", "-q"); expect(readCloudPreparation(d).branch).toBeNull();
  git(d, "remote", "remove", "origin"); expect(readCloudPreparation(d).repository).toBeNull();
  expect(readCloudPreparation(repo(false)).warnings.join(" ")).toContain("コミット");
  expect(readCloudPreparation("/directory-that-does-not-exist")).toMatchObject({ dirty: null, unpushed: null });
  expect(got.warnings.join(" ")).toContain("未追跡"); expect(got.warnings.join(" ")).toContain("履歴");
});

test("folder trust: only a known-untrusted folder gets the guidance warning", () => {
  const d = repo(); const cfg = mkdtempSync(join(tmpdir(), "switchboard-cloud-cfg-")); dirs.push(cfg);
  const old = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const warned = () => readCloudPreparation(d).warnings.includes(cloudTrustGuidance(d));
    expect(warned()).toBe(false);                                   // no config: unknown
    writeFileSync(join(cfg, ".claude.json"), JSON.stringify({ projects: { "/elsewhere": { hasTrustDialogAccepted: true } } }));
    expect(warned()).toBe(true);                                    // config readable, no record
    writeFileSync(join(cfg, ".claude.json"), JSON.stringify({ projects: { [realpathSync(d)]: { hasTrustDialogAccepted: true } } }));
    expect(warned()).toBe(false);                                   // trusted
    writeFileSync(join(cfg, ".claude.json"), JSON.stringify({ projects: { [dirname(realpathSync(d))]: { hasTrustDialogAccepted: true } } }));
    expect(warned()).toBe(false);                                   // ancestor only: unknown, no warning
  } finally { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; }
});
