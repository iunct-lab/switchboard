import { currentRepo } from "./repo.ts";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bumpType, latestSemver, nextVersion, releaseNotes, run, verifiedBy, withReleaseLock, type Sh } from "./release-tag";

describe("release-tag bumpType", () => {
  test("feat only → minor", () => expect(bumpType(["feat(web): a"])).toBe("minor"));
  test("fix! anywhere → major", () => expect(bumpType(["docs: x", "fix(core)!: drop y"])).toBe("major"));
  test("feat! without scope → major", () => expect(bumpType(["feat!: z"])).toBe("major"));
  test("fix, test, docs only → patch", () => expect(bumpType(["fix(core): a", "test: b", "docs(skills): c"])).toBe("patch"));
  test("fix and feat → minor", () => expect(bumpType(["fix: a", "feat(core): b"])).toBe("minor"));
  test("feat and breaking → major", () => expect(bumpType(["feat: a", "refactor(db)!: b"])).toBe("major"));
  test("a subject that only mentions feat is not a feat", () => expect(bumpType(["docs: explain feat(x): usage"])).toBe("patch"));
  test("a ! in the description is not breaking", () => expect(bumpType(["fix: stop! now"])).toBe("patch"));
});

describe("release-tag nextVersion", () => {
  test("no tag yet → v0.1.0", () => expect(nextVersion(null, "major")).toBe("v0.1.0"));
  test("patch", () => expect(nextVersion("v1.2.3", "patch")).toBe("v1.2.4"));
  test("minor resets patch", () => expect(nextVersion("v1.2.3", "minor")).toBe("v1.3.0"));
  test("major resets minor and patch", () => expect(nextVersion("v1.2.3", "major")).toBe("v2.0.0"));
  test("a non-semver tag throws", () => expect(() => nextVersion("r20260924.1", "patch")).toThrow());
});

describe("release-tag releaseNotes", () => {
  const commits = [
    { sha: "a1", subject: "feat(web): backlog screen (#273)" },
    { sha: "b2", subject: "test(core): the CLI flag test gets 30 s" },
  ];
  test("the trailing (#n) becomes the reference; subjects without one stay as they are; compare URL from the previous tag", () => {
    expect(releaseNotes(commits, "v0.1.0", "v0.2.0")).toBe(
      `- #273 feat(web): backlog screen\n- test(core): the CLI flag test gets 30 s\n\nhttps://github.com/${currentRepo()}/compare/v0.1.0...v0.2.0\n`,
    );
  });
  test("no previous tag → no compare URL", () => {
    expect(releaseNotes(commits.slice(0, 1), null, "v0.1.0")).toBe("- #273 feat(web): backlog screen\n");
  });
});

/** c1 is on origin/main and the CI workflow passed on its push. */
const onMainAndCi = { "git merge-base --is-ancestor c1 origin/main": { ok: true }, "gh api repos/": { out: "1" } };

describe("release-tag run", () => {
  /** A fake git / gh: answers by command prefix, records every call. */
  function fake(answers: Record<string, { ok?: boolean; out?: string }>) {
    const calls: string[] = [];
    const sh: Sh = (cmd) => {
      const c = cmd.join(" ");
      calls.push(c);
      const key = Object.keys(answers).find((k) => c.startsWith(k));
      const a = key ? answers[key]! : {};
      return { ok: a.ok ?? true, out: a.out ?? "" };
    };
    return { sh, calls };
  }

  test("a hand-made tag that is not strict semver is skipped when picking the latest", () => {
    expect(latestSemver(["v1.0", "v1.0.0-rc1", "v0.3.0", "v0.2.0"])).toBe("v0.3.0");
    expect(latestSemver(["v1.0"])).toBeNull();
  });

  test("a new commit gets the next tag, a push and a release", () => {
    const f = fake({ "git tag -l": { out: "v1.0\nv0.3.0" }, "git tag --points-at": { out: "" }, ...onMainAndCi, "git merge-base": { ok: false }, "git log": { out: "c1\tfeat(web): x (#9)" } });
    expect(run("c1", f.sh)).toBe("tagged c1 as v0.4.0 (verified by CI)");
    expect(f.calls).toContain("git tag v0.4.0 c1");
    expect(f.calls).toContain("git push origin v0.4.0");
    expect(f.calls.some((c) => c.startsWith("gh release create v0.4.0"))).toBe(true);
  });

  test("a tag already on the commit whose release is missing gets its release, not a second tag", () => {
    const f = fake({ "git tag -l": { out: "v0.4.0\nv0.3.0" }, "git tag --points-at": { out: "v0.4.0" }, "gh release view": { ok: false }, "git merge-base": { ok: false }, "git log": { out: "c1\tfix: y" } });
    expect(run("c1", f.sh)).toBe("created the missing release for v0.4.0");
    expect(f.calls).toContain("git log --format=%H%x09%s v0.3.0..c1");
    expect(f.calls.some((c) => c.startsWith("git tag v") || c.startsWith("git push"))).toBe(false);
    expect(f.calls.some((c) => c.startsWith("gh release create v0.4.0"))).toBe(true);
  });

  test("a tag with its release already there: nothing to do", () => {
    const f = fake({ "git tag -l": { out: "v0.4.0" }, "git tag --points-at": { out: "v0.4.0" } });
    expect(run("c1", f.sh)).toBe("c1 already has v0.4.0 and its release");
    expect(f.calls.some((c) => c.startsWith("gh release create"))).toBe(false);
  });
});

describe("release-tag repo", () => {
  function fake(answers: Record<string, { ok?: boolean; out?: string }>) {
    const calls: string[] = [];
    const inputs: (string | undefined)[] = [];
    const sh: Sh = (cmd, input) => {
      const c = cmd.join(" ");
      calls.push(c);
      inputs.push(input);
      const key = Object.keys(answers).find((k) => c.startsWith(k));
      const a = key ? answers[key]! : {};
      return { ok: a.ok ?? true, out: a.out ?? "" };
    };
    return { sh, calls, inputs };
  }
  const newCommit = { "git tag -l": { out: "v0.2.0" }, "git tag --points-at": { out: "" }, ...onMainAndCi, "git merge-base": { ok: false }, "git log": { out: "c1\tfix: y (#4)" } };

  test("the compare URL points at the given repository", () => {
    expect(releaseNotes([{ sha: "a1", subject: "fix: y" }], "v0.1.0", "v0.1.1", "x/y")).toBe("- fix: y\n\nhttps://github.com/x/y/compare/v0.1.0...v0.1.1\n");
  });

  test("--repo fetches the tags first and creates the release in that repository", () => {
    const f = fake({ "git remote get-url": { out: "git@github.com:x/y.git" }, ...newCommit });
    expect(run("c1", f.sh, "x/y")).toBe("tagged c1 as v0.2.1 (verified by CI)");
    expect(f.calls.indexOf("git fetch origin --tags --force +refs/heads/main:refs/remotes/origin/main")).toBeLessThan(f.calls.findIndex((c) => c.startsWith("git tag -l")));
    expect(f.calls).toContain("git push origin v0.2.1");
    const create = f.calls.findIndex((c) => c.startsWith("gh release create v0.2.1"));
    expect(f.calls[create]).toEndWith("-R x/y");
    expect(f.inputs[create]).toContain("https://github.com/x/y/compare/v0.2.0...v0.2.1");
  });

  test("--repo: an existing release is looked up in that repository", () => {
    const f = fake({ "git remote get-url": { out: "https://github.com/x/y" }, "git tag -l": { out: "v0.4.0" }, "git tag --points-at": { out: "v0.4.0" } });
    expect(run("c1", f.sh, "x/y")).toBe("c1 already has v0.4.0 and its release");
    expect(f.calls).toContain("gh release view v0.4.0 -R x/y");
  });

  test("--repo: a tag already on the commit gets its missing release in that repository", () => {
    const f = fake({ "git remote get-url": { out: "https://github.com/x/y.git" }, "git tag -l": { out: "v0.4.0\nv0.3.0" }, "git tag --points-at": { out: "v0.4.0" }, "gh release view": { ok: false }, "git merge-base": { ok: false }, "git log": { out: "c1\tfix: y" } });
    expect(run("c1", f.sh, "x/y")).toBe("created the missing release for v0.4.0");
    const create = f.calls.findIndex((c) => c.startsWith("gh release create v0.4.0"));
    expect(f.calls[create]).toEndWith("-R x/y");
    expect(f.inputs[create]).toContain("https://github.com/x/y/compare/v0.3.0...v0.4.0");
  });

  test("--repo naming another repository than the clone's origin throws before tagging", () => {
    for (const url of ["https://github.com/example/development.git", "https://github.com/x/yz", "/tmp/x/y"]) {
      const f = fake({ "git remote get-url": { out: url }, ...newCommit });
      expect(() => run("c1", f.sh, "x/y")).toThrow("x/y");
      expect(f.calls.some((c) => c.startsWith("git tag") || c.startsWith("git push") || c.startsWith("gh release"))).toBe(false);
    }
  });

  test("a push rejected 3 times deletes the local tag each time and makes no release", () => {
    const f = fake({ "git remote get-url": { out: "git@github.com:x/y.git" }, ...newCommit, "git push": { ok: false } });
    expect(() => run("c1", f.sh, "x/y")).toThrow("rejected 3 times");
    expect(f.calls.filter((c) => c === "git tag -d v0.2.1")).toHaveLength(3);
    expect(f.calls.some((c) => c.startsWith("gh release create"))).toBe(false);
  });

  test("without --repo: no origin check and no -R, the tags are still fetched first, the compare URL of the current repository", () => {
    const f = fake(newCommit);
    run("c1", f.sh);
    expect(f.calls.some((c) => c.startsWith("git remote") || c.includes("-R"))).toBe(false);
    expect(f.calls[0]).toStartWith("git fetch origin --tags");
    expect(f.inputs[f.calls.findIndex((c) => c.startsWith("gh release create"))]).toContain(`https://github.com/${currentRepo()}/compare/`);
  });
});

describe("release-tag verified main only (#915)", () => {
  /** A fake whose answers may change per call (a list is used in order, the last one repeats). */
  function seq(answers: Record<string, Array<{ ok?: boolean; out?: string }>>) {
    const calls: string[] = [];
    const used: Record<string, number> = {};
    const sh: Sh = (cmd) => {
      const c = cmd.join(" ");
      calls.push(c);
      const key = Object.keys(answers).find((k) => c.startsWith(k));
      if (!key) return { ok: true, out: "" };
      const list = answers[key]!;
      const a = list[Math.min(used[key] ?? 0, list.length - 1)]!;
      used[key] = (used[key] ?? 0) + 1;
      return { ok: a.ok ?? true, out: a.out ?? "" };
    };
    return { sh, calls };
  }
  const H = "a".repeat(40);
  const B = "b".repeat(40);
  const OLD = "c".repeat(40);
  const pr = (comments: Array<{ body: string; at?: string; who?: string }>) =>
    JSON.stringify({ headRefOid: H, comments: comments.map((c, i) => ({ body: c.body, createdAt: c.at ?? `2026-10-23T00:0${i}:00Z`, authorAssociation: c.who ?? "OWNER" })) });
  const local = (comments: Array<{ body: string; at?: string; who?: string }>, mergedTree = "T1") => ({
    "gh api repos/o/r/actions/runs": [{ out: "0" }],
    "gh api repos/o/r/commits/c1/pulls": [{ out: "12" }],
    "git rev-parse c1^{tree}": [{ out: "T1" }],
    "gh pr view 12": [{ out: pr(comments) }],
    [`git merge-tree --write-tree ${B} ${H}`]: [{ out: `${mergedTree}\n` }],
  });

  test("the CI workflow's success on the push verifies it", () => {
    expect(verifiedBy("c1", seq({ "gh api repos/o/r/actions/runs": [{ out: "1" }] }).sh, "o/r")).toBe("CI");
  });

  test("Actions not starting: the merged PR's local-ci pass whose head on that base is the commit's tree verifies it", () => {
    expect(verifiedBy("c1", seq(local([{ body: `[local-ci] pass ${H} base=${B}` }])).sh, "o/r")).toBe("local-ci of PR #12");
  });

  test("a pass of another tree, of an older head, a later fail of the same base, or a non-member's mark does not", () => {
    expect(verifiedBy("c1", seq(local([{ body: `[local-ci] pass ${H} base=${B}` }], "T2")).sh, "o/r")).toBeNull();
    expect(verifiedBy("c1", seq(local([{ body: `[local-ci] pass ${OLD} base=${B}` }])).sh, "o/r")).toBeNull();
    expect(verifiedBy("c1", seq(local([{ body: `[local-ci] pass ${H} base=${B}` }, { body: `[local-ci] fail ${H} base=${B}` }])).sh, "o/r")).toBeNull();
    expect(verifiedBy("c1", seq(local([{ body: `[local-ci] pass ${H} base=${B}`, who: "NONE" }])).sh, "o/r")).toBeNull();
    expect(verifiedBy("c1", seq({ "gh api repos/o/r/actions/runs": [{ out: "0" }], "gh api repos/o/r/commits/c1/pulls": [{ out: "" }] }).sh, "o/r")).toBeNull();
  });

  test("an unverified commit, or one not on origin/main, is refused before any tag", () => {
    const base = { "git tag -l": [{ out: "v0.2.0" }], "git tag --points-at": [{ out: "" }] };
    const unverified = seq({ ...base, "git merge-base --is-ancestor c1 origin/main": [{ ok: true }], "git merge-base": [{ ok: false }], "gh api": [{ out: "" }] });
    expect(() => run("c1", unverified.sh)).toThrow("c1 is not verified");
    const offMain = seq({ ...base, "git merge-base --is-ancestor c1 origin/main": [{ ok: false }], "git merge-base": [{ ok: false }], "gh api": [{ out: "1" }] });
    expect(() => run("c1", offMain.sh)).toThrow("not on origin/main");
    for (const f of [unverified, offMain]) expect(f.calls.some((c) => c.startsWith("git tag v") || c.startsWith("git push") || c.startsWith("gh release create"))).toBe(false);
  });

  test("two clones at once: the push that loses reads the tags again and finds the winner's tag on the commit — no second tag", () => {
    const f = seq({
      "git tag -l": [{ out: "v0.2.0" }, { out: "v0.2.1\nv0.2.0" }],
      "git tag --points-at": [{ out: "" }, { out: "v0.2.1" }],
      "gh release view": [{ ok: true }],
      "git merge-base --is-ancestor c1 origin/main": [{ ok: true }],
      "git merge-base": [{ ok: false }],
      "gh api": [{ out: "1" }],
      "git log": [{ out: "c1\tfix: y" }],
      "git push": [{ ok: false }],
    });
    expect(run("c1", f.sh)).toBe("c1 already has v0.2.1 and its release");
    expect(f.calls.filter((c) => c.startsWith("git fetch origin --tags"))).toHaveLength(2);
    expect(f.calls.filter((c) => c.startsWith("git tag v"))).toEqual(["git tag v0.2.1 c1"]);
    expect(f.calls.some((c) => c.startsWith("gh release create"))).toBe(false);
  });

  test("a descendant tagged under another name before our push landed: ours is taken back, no Release", () => {
    const f = seq({
      "git tag -l": [{ out: "v1.0.0" }, { out: "v1.1.0\nv1.0.1\nv1.0.0" }],
      "git tag --points-at": [{ out: "" }],
      "git merge-base --is-ancestor c1 origin/main": [{ ok: true }],
      "git merge-base --is-ancestor c1 v1.0.0": [{ ok: false }],
      "git merge-base --is-ancestor c1 v1.1.0": [{ ok: true }],
      "gh api": [{ out: "1" }],
      "git log": [{ out: "c1\tfix: y" }],
    });
    expect(run("c1", f.sh)).toBe("c1 is already contained in v1.1.0 (tagged by another run meanwhile; v1.0.1 taken back)");
    expect(f.calls).toContain("git push origin :refs/tags/v1.0.1");
    expect(f.calls.some((c) => c.startsWith("gh release create"))).toBe(false);
  });

  test("rerun after a run cut off before taking its tag back: the older tag gets its Release (the order is still consistent)", () => {
    const f = seq({
      "git tag -l": [{ out: "v1.1.0\nv1.0.1\nv1.0.0" }],
      "git tag --points-at": [{ out: "v1.0.1" }],
      "gh release view": [{ ok: false }],
      "git merge-base": [{ ok: true }],
      "git log": [{ out: "c1\tfix: y" }],
    });
    expect(run("c1", f.sh)).toBe("created the missing release for v1.0.1");
  });

  test("no other tag on a descendant after the push: ours stays and gets its Release", () => {
    const f = seq({
      "git tag -l": [{ out: "v1.0.0" }, { out: "v1.0.1\nv1.0.0" }],
      "git tag --points-at": [{ out: "" }],
      "git merge-base --is-ancestor c1 origin/main": [{ ok: true }],
      "git merge-base": [{ ok: false }],
      "gh api": [{ out: "1" }],
      "git log": [{ out: "c1\tfix: y" }],
    });
    expect(run("c1", f.sh)).toBe("tagged c1 as v1.0.1 (verified by CI)");
    expect(f.calls.some((c) => c.startsWith("git push origin :refs/tags"))).toBe(false);
    expect(f.calls.some((c) => c.startsWith("gh release create v1.0.1"))).toBe(true);
  });

  test("a newer commit tagged by the other clone meanwhile: ours is contained in it, not tagged backwards", () => {
    const f = seq({
      "git tag -l": [{ out: "v0.2.0" }, { out: "v0.3.0\nv0.2.0" }],
      "git tag --points-at": [{ out: "" }],
      "git merge-base --is-ancestor c1 origin/main": [{ ok: true }],
      "git merge-base --is-ancestor c1 v0.2.0": [{ ok: false }],
      "git merge-base --is-ancestor c1 v0.3.0": [{ ok: true }],
      "gh api": [{ out: "1" }],
      "git log": [{ out: "c1\tfix: y" }],
      "git push": [{ ok: false }],
    });
    expect(run("c1", f.sh)).toBe("c1 is already contained in v0.3.0");
  });
});

test("same tags as in turn: two clones from one latest tag that pick different names make the versions one after the other would", () => {
  for (const a of [["fix: a"], ["feat: a"], ["fix: a", "feat: b"]]) {
    for (const rest of [["fix: c"], ["feat: c"], ["feat!: c"]]) {
      const ancestor = nextVersion("v1.0.0", bumpType(a));
      const raced = nextVersion("v1.0.0", bumpType([...a, ...rest]));
      if (raced === ancestor) continue; // the same name: the push decides (the test above)
      expect(raced).toBe(nextVersion(ancestor, bumpType(rest)));
    }
  }
});

test("a descendant never gets a smaller version than its ancestor from the same latest tag (two clones, different names)", () => {
  const ancestor = ["fix: a", "feat: b"];
  for (const extra of [[], ["fix: c"], ["feat!: d"]]) {
    for (const own of [ancestor.slice(0, 1), ancestor]) {
      const mine = nextVersion("v1.0.0", bumpType(own));
      const theirs = nextVersion("v1.0.0", bumpType([...own, ...extra]));
      expect(Bun.semver.order(theirs.slice(1), mine.slice(1))).toBeGreaterThanOrEqual(0);
    }
  }
});

describe("release-tag lock", () => {
  test("one run at a time on a clone; a crashed run's old lock is taken; the lock goes after the run, also on a throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.release-lock."));
    expect(() => withReleaseLock(dir, () => withReleaseLock(dir, () => "inner"))).toThrow("another release-tag is running");
    expect(existsSync(join(dir, "switchboard-release-tag.lock"))).toBe(false);
    writeFileSync(join(dir, "switchboard-release-tag.lock"), "");
    const old = (Date.now() - 31 * 60_000) / 1000;
    utimesSync(join(dir, "switchboard-release-tag.lock"), old, old);
    expect(withReleaseLock(dir, () => "taken")).toBe("taken");
    expect(() => withReleaseLock(dir, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(join(dir, "switchboard-release-tag.lock"))).toBe(false);
    rmSync(dir, { recursive: true });
  });
});
