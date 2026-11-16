// test-reads: packages/core/src/
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A host that has no git at all (an install from a release tarball): each of these reads git and must answer
// "nothing" instead of throwing, so a screen that asks stays up. Run in a child, because a running Bun reads PATH once.
const SCRIPT = `
import { prRepoOf } from ${JSON.stringify(join(import.meta.dir, "flow.ts"))};
import { mainCommits } from ${JSON.stringify(join(import.meta.dir, "sources.ts"))};
import { syncSkills } from ${JSON.stringify(join(import.meta.dir, "skillsync.ts"))};
import { collectTaskDiff } from ${JSON.stringify(join(import.meta.dir, "taskdiff.ts"))};
const dir = process.argv[1];
const out = { git: Bun.which("git"), repo: prRepoOf({ service: "switchboard", repository: null }, dir), commits: await mainCommits(dir, 0), diff: await collectTaskDiff({ id: "t", cwd: dir, scope: [] }, [], [], []).then((d) => d.length, (e) => String(e)) };
syncSkills({ metaPath: dir, cwd: dir });
console.log(JSON.stringify(out));
`;

test("git readers answer 'nothing' when there is no git on PATH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-nogit-"));
  try {
    const p = Bun.spawn([process.execPath, "-e", SCRIPT, dir], { env: { PATH: join(dir, "empty-bin"), HOME: dir }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(JSON.parse(out.trim().split("\n").at(-1)!)).toEqual({ git: null, repo: null, commits: null, diff: 0 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
