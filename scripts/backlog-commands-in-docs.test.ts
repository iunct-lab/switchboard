// test-reads: CLAUDE.md docs/merge-gate.md private/CLAUDE.md .claude/skills/ .github/ISSUE_TEMPLATE/
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The kit's half of this check is in ops-kit/src/skills.test.ts; it stays there because the kit goes to other repositories
 * and cannot read this one's CLAUDE.md. The pattern is the same one. Only the skills and Issue templates Git holds: the
 * kit's copies under .claude/skills are outside Git. A tree without Git (a ZIP) cannot tell them apart, so the check skips there.
 */
const root = join(import.meta.dir, "..");
const BACKLOG_BY_GH = /gh issue (create|edit|comment|close|reopen|view|list|delete|transfer)|gh api [^\n]*\/issues|addSubIssue|removeSubIssue|updateProjectV2|gh project (item-|field-)|scripts\/setup\/(triage_issue|set_project_field|lint_backlog)/;
/** new-repo checks the entry of a repository that has no workspace yet, so it is not the backlog of a synced repository. */
const ALLOWED = [{ file: ".claude/skills/new-repo/SKILL.md", has: "scripts/setup/lint_backlog.sh" }];
const read = (file: string) => readFileSync(join(root, file), "utf8");
const privateRules = "private/CLAUDE.md"; // the public copy has no private/
const ls = spawnSync("git", ["ls-files", ".claude/skills", ".github/ISSUE_TEMPLATE"], { cwd: root, encoding: "utf8" });

test.skipIf(ls.status !== 0)("docs: this repository's instructions and Issue templates use ops-kit backlog for the backlog (#3072)", () => {
  const listed = ls.stdout.split("\n");
  const skills = listed.filter((file) => file.endsWith("/SKILL.md"));
  expect(skills).toContain(".claude/skills/flow-loop/SKILL.md");
  const templates = listed.filter((file) => file.startsWith(".github/ISSUE_TEMPLATE/") && file.endsWith(".yml"));
  expect(templates).toContain(".github/ISSUE_TEMPLATE/task.yml");
  const files = ["CLAUDE.md", "docs/merge-gate.md", ...(existsSync(join(root, privateRules)) ? [privateRules] : []), ...skills, ...templates];
  const hits = files.flatMap((file) =>
    read(file)
      .split("\n")
      .flatMap((line, i) => (BACKLOG_BY_GH.test(line) && !ALLOWED.some((allowed) => allowed.file === file && line.includes(allowed.has)) ? [`${file}:${i + 1}: ${line.trim().slice(0, 100)}`] : [])),
  );
  expect(hits).toEqual([]);
});

test("docs: the parallel guard needs no --repo in CLAUDE.md (#3072)", () => {
  const guard = read("CLAUDE.md")
    .split("\n")
    .filter((line) => line.startsWith("- 並列ガード:"));
  expect(guard).toHaveLength(1);
  expect(guard[0]).not.toContain("--repo <owner/name>");
  expect(guard[0]).toContain("`--repo` を付けなくてよい");
});

test.skipIf(!existsSync(join(root, privateRules)))("docs: private/CLAUDE.md adds Issues to the Project by the current route (#3072)", () => {
  const text = read(privateRules);
  expect(text).not.toContain("project-autoadd");
  expect(text).toContain("ops-kit backlog create");
});
