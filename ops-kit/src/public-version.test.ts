import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sync, type Run } from "./public-sync.ts";

// These integration tests launch real Git processes and can share a host with CI.
setDefaultTimeout(30_000);

let dir: string, priv: string, pub: string, origin: string;
let calls: string[][], releases: Set<string>, fail: string, openPr: boolean;
const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (p.exitCode) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
};
const commit = (version: string, visible = true) => {
  writeFileSync(join(priv, visible ? "README.md" : "hidden"), version + "\n");
  git(priv, "add", "."); git(priv, "commit", "-qm", "change"); git(priv, "tag", version);
  git(priv, "push", "-q", "origin", "main", "--tags");
};
const opts = (source: string, dryRun = false) => ({ privateRepo: "example/app-dev", target: "example/app", source, versioning: "independent" as const, exclude: ["hidden"], user: "", dryRun });
const run: Run = (cmd, options) => {
  calls.push(cmd);
  if (cmd[0] === "gh") {
    if (fail && cmd.slice(1, 3).join(" ") === fail) return { code: 1, out: "", err: "injected failure" };
    if (cmd[1] === "pr" && cmd[2] === "list") {
      const branch = git(pub, "for-each-ref", "--format=%(refname:short)", "refs/heads/sync/");
      return { code: 0, out: openPr && branch ? `1 ${branch}` : "" };
    }
    if (cmd[1] === "pr" && cmd[2] === "create") openPr = true;
    if (cmd[1] === "pr" && cmd[2] === "merge") {
      openPr = false;
      // by branch name, or by the number of the open PR (the one sync branch then; a replaced plan's branch is left behind)
      const branch = cmd[3]!.startsWith("sync/") ? cmd[3]! : git(pub, "for-each-ref", "--format=%(refname:short)", "refs/heads/sync/");
      git(pub, "update-ref", "refs/heads/main", git(pub, "rev-parse", branch));
      git(pub, "update-ref", "-d", `refs/heads/${branch}`);
    }
    if (cmd[1] === "api") return { code: 0, out: [...releases].join("\n") };
    if (cmd[1] === "release") {
      if (cmd[2] === "view") return { code: releases.has(cmd[3]!) ? 0 : 1, out: "" };
      const version = cmd[3]!, target = cmd[cmd.indexOf("--target") + 1]!;
      if (!git(pub, "tag", "-l", version)) git(pub, "tag", version, target); releases.add(version);
    }
    return { code: 0, out: "" };
  }
  const mapped = cmd.map((s) => s === "https://github.com/example/app.git" ? pub : s);
  const p = Bun.spawnSync(mapped, { cwd: priv, stdin: options?.input === undefined ? "ignore" : new TextEncoder().encode(options.input), env: { ...process.env, ...options?.env }, stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString().trimEnd(), err: p.stderr.toString().split("\n")[0] };
};
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "public-version.test."));
  priv = join(dir, "private"); pub = join(dir, "public.git"); origin = join(dir, "origin.git");
  mkdirSync(priv); git(priv, "init", "-q", "-b", "main");
  git(priv, "config", "user.name", "dev"); git(priv, "config", "user.email", "dev@example.com");
  git(dir, "init", "-q", "--bare", "-b", "main", pub); git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(priv, "remote", "add", "origin", origin);
  calls = []; releases = new Set(); fail = ""; openPr = false;
  commit("v4.2.0");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("independent: first v0.1.0, three patches once, two minors once, then major", () => {
  expect(sync(opts("v4.2.0"), run)).toContain("v0.1.0");
  expect(git(pub, "rev-list", "--count", "main")).toBe("1");
  for (const v of ["v4.2.1", "v4.2.2", "v4.2.3"]) commit(v);
  sync(opts("v4.2.3"), run);
  expect(releases.has("v0.1.1")).toBe(true);
  for (const v of ["v4.2.4", "v4.2.5", "v4.2.6", "v4.3.0", "v4.4.0"]) commit(v);
  sync(opts("v4.4.0"), run);
  expect(releases.has("v0.2.0")).toBe(true);
  commit("v5.0.0"); sync(opts("v5.0.0"), run);
  expect(releases.has("v1.0.0")).toBe(true);
  expect(git(pub, "log", "--format=%s")).not.toContain("v4.");
});

test("independent: unchanged public tree keeps the original baseline", () => {
  sync(opts("v4.2.0"), run); commit("v5.0.0", false);
  expect(sync(opts("v5.0.0"), run)).toContain("nothing to sync");
  expect(releases.size).toBe(1);
  commit("v5.0.1"); sync(opts("v5.0.1"), run);
  expect(releases.has("v1.0.0")).toBe(true);
});

test("independent: dry-run reports plan, source, tree and baseline without pushing", () => {
  const out = sync(opts("v4.2.0", true), run);
  for (const word of ["v0.1.0", "v4.2.0", "tree", "initial"]) expect(out).toContain(word);
  expect(calls.some((c) => c.includes("push") || c[2] === "create")).toBe(false);
});

for (const operation of ["release create", "pr merge", "pr create"]) test(`independent: resumes ${operation} failure with the same version`, () => {
  if (operation !== "release create") { sync(opts("v4.2.0"), run); commit("v4.2.1"); }
  const source = operation === "release create" ? "v4.2.0" : "v4.2.1";
  fail = operation;
  expect(() => sync(opts(source), run)).toThrow();
  fail = ""; sync(opts(source), run);
  const tags = git(pub, "tag").split("\n");
  expect(tags).toEqual(operation === "release create" ? ["v0.1.0"] : ["v0.1.0", "v0.1.1"]);
  const count = git(pub, "rev-list", "--count", "main");
  sync(opts(source), run);
  expect(git(pub, "rev-list", "--count", "main")).toBe(count);
});

test("independent: rejects a moved baseline tag before public writes", () => {
  sync(opts("v4.2.0"), run); commit("v4.2.1");
  git(priv, "tag", "-f", "v4.2.0");
  calls = [];
  expect(() => sync(opts("v4.2.1"), run)).toThrow();
  expect(calls.some((c) => c[0] === "gh" && ["create", "merge"].includes(c[2]!))).toBe(false);
});

test("independent: rejects divergent source, missing ledger, and wrong public tag target", () => {
  sync(opts("v4.2.0"), run);
  git(priv, "checkout", "-q", "--orphan", "other"); git(priv, "rm", "-rfq", ".");
  writeFileSync(join(priv, "README.md"), "other"); git(priv, "add", "."); git(priv, "commit", "-qm", "other"); git(priv, "tag", "v5.0.0");
  expect(() => sync(opts("v5.0.0"), run)).toThrow();
  git(priv, "checkout", "-q", "main"); commit("v4.2.1");
  git(pub, "tag", "-f", "v0.1.1", "main");
  expect(() => sync(opts("v4.2.1"), run)).toThrow();
});

test("independent: remote lock prevents overlapping publication", () => {
  let nested = false;
  const concurrent: Run = (cmd, o) => {
    if (!nested && cmd[0] === "gh" && cmd[1] === "release" && cmd[2] === "create") {
      nested = true;
      expect(() => sync(opts("v4.2.0"), run)).toThrow("lock");
    }
    return run(cmd, o);
  };
  sync(opts("v4.2.0"), concurrent);
  expect(nested).toBe(true);
  expect(releases.size).toBe(1);
});

test("independent: missing private baseline stops instead of reinitializing", () => {
  sync(opts("v4.2.0"), run);
  const ref = git(origin, "for-each-ref", "--format=%(refname)", "refs/public-sync/versions/");
  git(origin, "update-ref", "-d", ref);
  expect(() => sync(opts("v4.2.0"), run)).toThrow("baseline missing");
});

const thrown = (f: () => unknown) => { try { f(); } catch (e) { return (e as Error).message; } return ""; };

test("independent: a pending plan that reached nothing is replaced by another source, its version from that source", () => {
  sync(opts("v4.2.0"), run); commit("v4.2.1");
  fail = "pr create"; // the sync branch is pushed, no PR opens: nothing public moved
  expect(() => sync(opts("v4.2.1"), run)).toThrow("failed: gh pr create");
  expect(ledger().pending.version).toBe("v0.1.1");
  fail = ""; commit("v4.3.0");
  const before = refs();
  expect(sync(opts("v4.3.0", true), run)).toStartWith("version: would replace unfinished plan v0.1.1 (--source v4.2.1): nothing reached example/app\n");
  expect(refs()).toEqual(before); // dry-run writes no record
  const out = sync(opts("v4.3.0"), run);
  expect(out).toStartWith("version: replaced unfinished plan v0.1.1 (--source v4.2.1): nothing reached example/app\n");
  expect(git(pub, "log", "-1", "--format=%s", "main")).toBe("v0.2.0");
  const state = ledger();
  expect(state.pending).toBeUndefined();
  expect(state.completed).toMatchObject({ tag: "v4.3.0", version: "v0.2.0" });
  expect([...releases]).toEqual(["v0.1.0", "v0.2.0"]);
});

test("independent: the tags of a replaced plan are not verified; the completed ones still are", () => {
  sync(opts("v4.2.0"), run); commit("v4.2.1");
  fail = "pr create";
  expect(() => sync(opts("v4.2.1"), run)).toThrow("failed: gh pr create");
  fail = "";
  git(priv, "tag", "-d", "v4.2.1"); git(priv, "push", "-q", "origin", ":refs/tags/v4.2.1"); // the given-up plan's tag is gone
  commit("v4.3.0");
  expect(() => sync(opts("v4.2.1"), run)).toThrow(); // resuming it needs the tag
  git(origin, "update-ref", "refs/tags/v4.2.0", git(priv, "rev-parse", "v4.3.0")); // a moved completed tag still stops
  expect(() => sync(opts("v4.3.0"), run)).toThrow("source tag missing or changed");
  git(origin, "update-ref", "refs/tags/v4.2.0", git(priv, "rev-parse", "v4.2.0"));
  expect(sync(opts("v4.3.0"), run)).toStartWith("version: replaced unfinished plan v0.1.1 (--source v4.2.1)");
  expect(ledger().completed).toMatchObject({ tag: "v4.3.0", version: "v0.2.0" });
});

test("independent: a pending plan with an open sync PR stops another source, naming the PR", () => {
  sync(opts("v4.2.0"), run); commit("v4.2.1");
  fail = "pr merge";
  expect(() => sync(opts("v4.2.1"), run)).toThrow("could not merge sync PR");
  fail = ""; commit("v4.3.0");
  const before = refs();
  const first = thrown(() => sync(opts("v4.3.0"), run)).split("\n")[0]!;
  expect(first).toContain("unfinished publication: resume with --source v4.2.1");
  expect(first).toContain("sync PR #1");
  expect(refs()).toEqual(before);
  expect(sync(opts("v4.2.1"), run)).toContain("public v0.1.1");
});

test("independent: a pending plan whose public main moved stops another source, naming the move and the tag", () => {
  sync(opts("v4.2.0"), run); commit("v4.2.1");
  fail = "release create";
  expect(() => sync(opts("v4.2.1"), run)).toThrow("failed: gh release create");
  git(pub, "tag", "v0.1.1", "main"); // a tag made before the Release failed
  fail = ""; commit("v4.3.0");
  const first = thrown(() => sync(opts("v4.3.0"), run)).split("\n")[0]!;
  expect(first).toContain("resume with --source v4.2.1");
  expect(first).toContain("public main moved");
  expect(first).toContain("tag v0.1.1");
});

test("independent: a pending version refuses a newer source and a changed output tree", () => {
  fail = "release create";
  expect(() => sync(opts("v4.2.0"), run)).toThrow();
  fail = ""; commit("v4.2.1");
  expect(() => sync(opts("v4.2.1"), run)).toThrow("resume with --source v4.2.0 (reached example/app: public main moved)");
  expect(() => sync({ ...opts("v4.2.0"), exclude: ["README.md"] }, run)).toThrow();
  sync(opts("v4.2.0"), run);
  expect(releases.has("v0.1.0")).toBe(true);
});

test("independent: remote tag deletion and remote movement are rejected", () => {
  sync(opts("v4.2.0"), run); commit("v4.2.1");
  git(origin, "update-ref", "refs/tags/v4.2.0", git(priv, "rev-parse", "v4.2.1"));
  expect(() => sync(opts("v4.2.1"), run)).toThrow("source tag missing or changed");
  git(origin, "update-ref", "-d", "refs/tags/v4.2.0");
  expect(() => sync(opts("v4.2.1"), run)).toThrow("source tag missing or changed");
});

test("independent: failed Release after a later merge is completed before another bump", () => {
  sync(opts("v4.2.0"), run); commit("v4.3.0");
  fail = "release create";
  expect(() => sync(opts("v4.3.0"), run)).toThrow();
  expect(git(pub, "log", "-1", "--format=%s")).toBe("v0.2.0");
  fail = ""; sync(opts("v4.3.0"), run);
  expect([...releases]).toEqual(["v0.1.0", "v0.2.0"]);
});

test("independent: a tag created before Release failure is reused and verified", () => {
  fail = "release create";
  expect(() => sync(opts("v4.2.0"), run)).toThrow();
  git(pub, "tag", "v0.1.0", "main");
  fail = ""; sync(opts("v4.2.0"), run);
  expect([...releases]).toEqual(["v0.1.0"]);
  expect(git(pub, "tag")).toBe("v0.1.0");
});

test("independent: changed publishing rules are rejected before merging a pending PR", () => {
  sync(opts("v4.2.0"), run); commit("v4.2.1");
  fail = "pr merge";
  expect(() => sync(opts("v4.2.1"), run)).toThrow();
  const before = git(pub, "rev-parse", "main");
  fail = "";
  expect(() => sync({ ...opts("v4.2.1"), include: ["README.md"], rewrite: ["README.md"] }, (cmd, o) => {
    if (cmd[0] === "git" && cmd.includes("write-tree")) return { code: 0, out: git(priv, "rev-parse", "v4.2.0^{tree}") };
    return run(cmd, o);
  })).toThrow("pending public tree changed");
  expect(git(pub, "rev-parse", "main")).toBe(before);
});

test("independent: bare target-url does not create a GitHub Release", () => {
  sync({ ...opts("v4.2.0"), targetUrl: pub }, run);
  expect(releases.size).toBe(0);
  expect(git(pub, "log", "-1", "--format=%s")).toBe("v0.1.0");
});

test("independent: verifies interval tags on origin before first publishing them", () => {
  sync(opts("v4.2.0"), run); commit("v4.2.1"); commit("v4.2.2");
  git(origin, "update-ref", "-d", "refs/tags/v4.2.1");
  const before = git(pub, "rev-parse", "main");
  expect(() => sync(opts("v4.2.2"), run)).toThrow("source tag missing or changed");
  expect(git(pub, "rev-parse", "main")).toBe(before);
});

test("independent: tag verification is batched and git cannot prompt", () => {
  sync(opts("v4.2.0"), run); commit("v4.2.1"); sync(opts("v4.2.1"), run);
  const requests: string[][] = [];
  sync(opts("v4.2.1", true), (cmd, o) => {
    if (cmd[0] === "git" && ["ls-remote", "fetch", "push"].some((s) => cmd.includes(s))) expect(o?.env?.GIT_TERMINAL_PROMPT).toBe("0");
    if (cmd.includes("ls-remote") && cmd.includes("origin") && cmd.some((s) => s.startsWith("refs/tags/"))) requests.push(cmd);
    return run(cmd, o);
  });
  expect(requests.length).toBe(1);
});

test("independent: a failed lock release preserves the publication failure", () => {
  fail = "release create";
  expect(() => sync(opts("v4.2.0"), (cmd, o) => {
    if (cmd.includes("push") && cmd.some((s) => s.startsWith(":refs/public-sync/versions/"))) return { code: 1, out: "" };
    return run(cmd, o);
  })).toThrow("failed: gh release create");
});

test("independent: completed ledger identifies the exact public commit", () => {
  sync(opts("v4.2.0"), run);
  const tree = git(pub, "rev-parse", "main^{tree}");
  const p = Bun.spawnSync(["git", "-C", pub, "-c", "user.name=dev", "-c", "user.email=dev@example.com", "commit-tree", tree, "-p", "main", "-m", "v0.1.0"]);
  const replacement = p.stdout.toString().trim();
  git(pub, "update-ref", "refs/heads/main", replacement);
  git(pub, "tag", "-f", "v0.1.0", replacement);
  expect(() => sync(opts("v4.2.0"), run)).toThrow("public main differs");
});

test("independent: pre-baseline tags are outside the publication interval", () => {
  commit("v4.2.1"); sync(opts("v4.2.1"), run); commit("v4.2.2");
  git(origin, "update-ref", "-d", "refs/tags/v4.2.0");
  sync(opts("v4.2.2"), run);
  expect(releases.has("v0.1.1")).toBe(true);
});

test("independent: unreadable target stops with preparation guidance", () => {
  expect(() => sync({ ...opts("v4.2.0", true), targetUrl: join(dir, "missing.git") }, run)).toThrow("empty Private repository");
  expect(calls.some((c) => c.includes("push") || c[2] === "create")).toBe(false);
});

test("independent: prepublication dry-run with an empty bare writes no refs", () => {
  const before = git(origin, "show-ref");
  const out = sync({ ...opts("v4.2.0", true), targetUrl: pub }, run);
  expect(out).toContain("v0.1.0");
  expect(git(pub, "for-each-ref")).toBe("");
  expect(git(origin, "show-ref")).toBe(before);
});

test("independent: missing baseline names --adopt-baseline", () => {
  sync({ ...opts("main"), versioning: undefined }, run);
  expect(() => sync(opts("v4.2.0"), run)).toThrow("--adopt-baseline --source");
});

// A target published by plain syncs (titled `sync`, no version tags or Releases) and no ledger, now at v4.2.1's tree.
const published = () => {
  const plain = { ...opts("main"), versioning: undefined };
  sync(plain, run); commit("v4.2.1"); sync(plain, run);
  for (const ref of git(origin, "for-each-ref", "--format=%(refname)", "refs/public-sync/versions/").split("\n").filter(Boolean)) git(origin, "update-ref", "-d", ref);
  expect(git(pub, "log", "--format=%s", "main").split("\n")).toEqual(["sync", "sync"]);
  return git(pub, "rev-parse", "main");
};
const adopt = (source: string, dryRun = false) => ({ ...opts(source, dryRun), adoptBaseline: true });
const ledger = () => {
  const ref = git(origin, "for-each-ref", "--format=%(refname)", "refs/public-sync/versions/").split("\n").find((r) => r && !r.endsWith("-lock"))!;
  return JSON.parse(git(origin, "show", `${ref}:state.json`));
};
const refs = () => [git(pub, "for-each-ref"), git(origin, "for-each-ref")];

test("adopt: baseline v0.1.0 on the existing public main, tag, Release and ledger", () => {
  const before = published();
  const tree = git(pub, "rev-parse", "main^{tree}");
  expect(sync(adopt("v4.2.1"), run)).toContain("public v0.1.0");
  expect(git(pub, "rev-parse", "main")).toBe(before);
  expect(git(pub, "rev-parse", "v0.1.0^{commit}")).toBe(before);
  expect([...releases]).toEqual(["v0.1.0"]);
  expect(ledger()).toEqual({ completed: { version: "v0.1.0", source: git(priv, "rev-parse", "v4.2.1"), tag: "v4.2.1", tree, tags: { "v4.2.1": git(priv, "rev-parse", "v4.2.1") }, commit: before } });
});

test("adopt: next sync bumps from v0.1.0", () => {
  published(); sync(adopt("v4.2.1"), run);
  commit("v4.2.2"); sync(opts("v4.2.2"), run);
  expect(git(pub, "log", "-1", "--format=%s", "main")).toBe("v0.1.1");
  expect([...releases]).toEqual(["v0.1.0", "v0.1.1"]);
  commit("v5.0.0", false);
  expect(sync(opts("v5.0.0"), run)).toContain("nothing to sync");
});

test("adopt: keeps the old public main as an ancestor", () => {
  const before = published();
  sync(adopt("v4.2.1"), run); commit("v4.2.2"); sync(opts("v4.2.2"), run);
  expect(Bun.spawnSync(["git", "-C", pub, "merge-base", "--is-ancestor", before, "main"]).exitCode).toBe(0);
});

test("adopt: refuses ledger, missing main, missing record, other source, public version tags, open sync PR without writing", () => {
  const refuses = (source: string, message: string) => {
    const was = refs();
    calls = [];
    expect(() => sync(adopt(source), run)).toThrow(message);
    expect(refs()).toEqual(was);
    expect(calls.some((c) => c[0] === "gh" && ["create", "merge"].includes(c[2]!))).toBe(false);
  };
  refuses("v4.2.0", "public main missing");
  published();
  refuses("v4.2.0", "was not sent from v4.2.0");
  git(pub, "tag", "v9.9.9", "main"); refuses("v4.2.1", "public version tag already exists: v9.9.9"); git(pub, "tag", "-d", "v9.9.9");
  releases.add("v1.0.0"); refuses("v4.2.1", "public Release already exists: v1.0.0"); releases.clear();
  git(pub, "branch", "sync/other", "main"); openPr = true;
  refuses("v4.2.1", "sync PR #1 is open"); openPr = false; git(pub, "branch", "-D", "sync/other");
  const records = git(origin, "for-each-ref", "--format=%(refname)", "refs/public-sync/trees/").split("\n");
  const kept = records.map((r) => [r, git(origin, "rev-parse", r)] as const);
  for (const r of records) git(origin, "update-ref", "-d", r);
  refuses("v4.2.1", "no sync record");
  for (const [r, sha] of kept) git(origin, "update-ref", r, sha);
  sync(adopt("v4.2.1"), run);
  refuses("v4.2.1", "already has an independent version record");
});

test("adopt: dry-run writes no refs", () => {
  const before = published();
  const was = refs();
  calls = [];
  const out = sync(adopt("v4.2.1", true), run);
  for (const word of ["v4.2.1", git(priv, "rev-parse", "v4.2.1"), before, git(pub, "rev-parse", "main^{tree}"), "public v0.1.0", "would release v0.1.0"]) expect(out).toContain(word);
  expect(refs()).toEqual(was);
  expect(calls.some((c) => c.includes("push") || c[2] === "create")).toBe(false);
});

test("adopt: resumes a release create failure with v0.1.0", () => {
  const before = published();
  fail = "release create";
  expect(() => sync(adopt("v4.2.1"), run)).toThrow();
  expect(ledger().pending.version).toBe("v0.1.0");
  fail = "";
  expect(() => sync(opts("v4.2.1"), run)).toThrow("resume with --adopt-baseline --source v4.2.1");
  sync(adopt("v4.2.1"), run);
  expect(git(pub, "rev-parse", "main")).toBe(before);
  expect([...releases]).toEqual(["v0.1.0"]);
  expect(ledger().completed).toMatchObject({ version: "v0.1.0", commit: before });
  expect(ledger().pending).toBeUndefined();
});

test("adopt: public title and Release body carry only the version", () => {
  published();
  calls = [];
  sync(adopt("v4.2.1"), run);
  expect(calls.some((c) => c[0] === "gh" && c[1] === "pr" && c[2] !== "list")).toBe(false);
  const release = calls.find((c) => c[0] === "gh" && c[1] === "release" && c[2] === "create")!;
  expect([release[3], release[release.indexOf("--title") + 1], release[release.indexOf("--notes") + 1]]).toEqual(["v0.1.0", "v0.1.0", ""]);
  expect(git(pub, "log", "--format=%B", "main")).not.toMatch(/v4\.|[0-9a-f]{40}/);
  expect(git(pub, "for-each-ref", "--format=%(refname)")).not.toContain("v4.");
});
