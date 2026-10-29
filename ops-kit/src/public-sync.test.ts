import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check, personalEmails, policySectionAt, sync, spawnRun, withPolicySection, withStaleNote, type Run } from "./public-sync.ts";
import { loadPublicSync } from "./config.ts";
import { main } from "./cli.ts";

const PRIVATE = "example-org/app";
const TARGET = "example-org/app-public";
// Built at run time: written out, they would trip CI's home-path step and this script's own check on its tree.
const HOME = ["", "Users", "alice", "x"].join("/");
const MAIL = (local: string) => `${local}@${"gmail"}.com`;
let root: string, priv: string, pub: string;
let ghCalls: string[][];

const sh = (cwd: string, ...cmd: string[]) => {
  const p = Bun.spawnSync(cmd, { cwd, stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
};
const write = (rel: string, body: string) => {
  mkdirSync(dirname(join(priv, rel)), { recursive: true });
  writeFileSync(join(priv, rel), body);
};
const commit = (msg: string) => {
  sh(priv, "git", "add", "-A");
  sh(priv, "git", "commit", "-qm", msg);
  return sh(priv, "git", "rev-parse", "HEAD");
};
/** What `gh pr merge --rebase` does on the bare public repository: the head commit again on main, same tree and message. */
const rebaseMerge = (pr: string) => {
  const branch = pr.startsWith("sync/") ? pr : sh(pub, "git", "for-each-ref", "--format=%(refname:short)", "refs/heads/sync/").split("\n")[0]!;
  const merged = sh(pub, "sh", "-c", `git log -1 --format=%B ${branch} | git -c user.name=dev -c user.email=dev@example.com commit-tree ${branch}^{tree} -p main -F -`);
  sh(pub, "git", "update-ref", "refs/heads/main", merged);
  sh(pub, "git", "update-ref", "-d", `refs/heads/${branch}`);
};
/** git runs in the private clone; gh is recorded and answers like an empty PR list / a created PR / a merge. */
const run: Run = (cmd, o) => {
  if (cmd[0] === "gh") {
    ghCalls.push(cmd);
    if (cmd[1] === "pr" && cmd[2] === "merge") rebaseMerge(cmd[3]!);
    return { code: 0, out: cmd[2] === "create" ? "https://github.com/example-org/app-public/pull/1" : "" };
  }
  const p = Bun.spawnSync(cmd, { cwd: priv, stdin: o?.input === undefined ? "ignore" : new TextEncoder().encode(o.input), env: { ...process.env, ...o?.env }, stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout.toString().replace(/\n$/, "") };
};
const opts = (extra: object = {}) => ({ privateRepo: PRIVATE, target: TARGET, exclude: [".github/workflows/host.yml"], rewrite: ["SECURITY.md"],  source: "main", targetUrl: pub, user: "", ...extra }); // user: the tests do not depend on who runs them
const pubGit = (...args: string[]) => sh(pub, "git", ...args);
/** The branch of the last sync PR opened (`gh pr create --head`). */
const opened = () => { const c = ghCalls.filter((g) => g[2] === "create").at(-1)!; return c[c.indexOf("--head") + 1]!; };
/** The private commit the private record of a public tree points at. */
const record = (tree: string) => sh(root, "git", "--git-dir", join(root, "private-origin.git"), "rev-parse", `refs/public-sync/trees/${tree}`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "public-sync.test."));
  priv = join(root, "private");
  pub = join(root, "public.git");
  mkdirSync(priv);
  sh(priv, "git", "init", "-q", "-b", "main");
  sh(priv, "git", "config", "user.email", "dev@example.com");
  sh(priv, "git", "config", "user.name", "dev");
  sh(root, "git", "init", "-q", "--bare", "-b", "main", pub);
  sh(root, "git", "init", "-q", "--bare", "-b", "main", join(root, "private-origin.git")); // where the private records of the syncs go
  sh(priv, "git", "remote", "add", "origin", join(root, "private-origin.git"));
  ghCalls = [];
  write("README.md", "hello\n");
  write("SECURITY.md", "Report: https://github.com/example-org/app/security/advisories/new\n");
  write(".github/workflows/host.yml", "on: workflow_dispatch\n");
  write(".github/workflows/ci.yml", `# ${HOME} stands in for the rule itself\n`);
  commit("feat: first (#1)");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("public-sync", () => {
  test("private names in files or the message stop before push; rewrites happen first", () => {
    for (const leak of [PRIVATE.toUpperCase(), `https://github.com/${PRIVATE}.git`, `see ${PRIVATE}.`]) {
      write("leak.txt", leak);
      commit("fix: leak");
      expect(() => sync(opts(), run)).toThrow("leak.txt");
    }
    sh(priv, "git", "rm", "-q", "leak.txt");
    write(`notes/${PRIVATE}/clean.txt`, "nothing here\n"); // the name as a path
    commit("docs: notes");
    expect(() => sync(opts(), run)).toThrow(`(path) notes/${PRIVATE}/clean.txt`);
    sh(priv, "git", "rm", "-rq", "notes");
    write(`notes/\t${PRIVATE}/clean.txt`, "nothing here\n"); // a path git would quote (\t) without -z
    commit("docs: notes again");
    expect(() => sync(opts(), run)).toThrow(`(path) notes/\t${PRIVATE}/clean.txt`);
    sh(priv, "git", "rm", "-rq", "notes");
    write("leak.txt", "clean\n");
    commit("docs: clean");
    expect(Bun.spawnSync(["git", "rev-parse", "--verify", "main"], { cwd: pub, stderr: "pipe" }).exitCode).not.toBe(0);
    sh(priv, "git", "rm", "leak.txt");
    commit(`fix: mentions ${PRIVATE.toUpperCase()}`); // a private commit subject does not go out: the message is the title only
    expect(sync(opts(), run)).toContain("pushed the first sync");
    expect(pubGit("log", "-1", "--format=%B", "main")).toBe("sync");
    expect(pubGit("show", "main:SECURITY.md")).toContain(TARGET);
  });

  test("a longer name that holds the private one (the public name here) is another repository: it passes and is not rewritten", () => {
    write("SECURITY.md", `Report: https://github.com/${PRIVATE}/security/advisories/new, or see https://github.com/${TARGET}/security\n`);
    write("NOTES.md", `${TARGET}, ${PRIVATE}2, ${PRIVATE}.js, x${PRIVATE}\n`);
    commit(`docs: ${TARGET} (#2)`);
    expect(sync(opts(), run)).toContain("pushed the first sync");
    expect(pubGit("show", "main:SECURITY.md")).toBe(`Report: https://github.com/${TARGET}/security/advisories/new, or see https://github.com/${TARGET}/security`);
    expect(pubGit("show", "main:NOTES.md")).toBe(`${TARGET}, ${PRIVATE}2, ${PRIVATE}.js, x${PRIVATE}`);
  });

  test("the first sync is one root commit on main: no private commit reaches the public repository", () => {
    write("README.md", "hello again\n");
    const src = commit("fix: second (#2)");
    expect(sync(opts(), run)).toContain("pushed the first sync");
    expect(pubGit("rev-list", "--count", "main")).toBe("1");
    expect(Bun.spawnSync(["git", "cat-file", "-e", src], { cwd: pub, stderr: "pipe" }).exitCode).not.toBe(0);
  });

  test("excluded files are absent, rewritten files name the public repository, the rest is the private tree", () => {
    const src = sh(priv, "git", "rev-parse", "HEAD");
    sync(opts(), run);
    // the private tree, minus the excluded file, plus the public kit (the forms, the workflow; SECURITY.md is the repository's own, rewritten)
    expect(pubGit("ls-tree", "-r", "--name-only", "main").split("\n").sort()).toEqual([".github/ISSUE_TEMPLATE/config.yml", ".github/ISSUE_TEMPLATE/request.yml", ".github/workflows/ci.yml", ".github/workflows/close-pull-requests.yml", "README.md", "SECURITY.md"]);
    expect(pubGit("show", "main:SECURITY.md")).toBe("Report: https://github.com/example-org/app-public/security/advisories/new");
    expect(pubGit("show", "main:README.md")).toStartWith("hello\n\n## How this repository works\n");
    // nothing private in the public commit: the record of where the tree came from is a ref on the private origin
    expect(pubGit("log", "-1", "--format=%B", "main")).toBe("sync");
    expect(record(pubGit("rev-parse", "main^{tree}"))).toBe(src);
  });

  test("the next sync is a PR that the script merges itself (Rebase and merge): its commit lands on public main, titled only, with no private subject in it", () => {
    sync(opts(), run);
    const before = pubGit("rev-parse", "main");
    write("README.md", "v2\n");
    commit("feat: two (#3)");
    write("README.md", "v3\n");
    commit("fix: three (#4)");
    const out = sync(opts(), run);
    expect(out).toContain("opened https://github.com/example-org/app-public/pull/1");
    expect(out).toContain(`merged sync PR ${opened()} on ${TARGET}`);
    expect(pubGit("rev-parse", "main^")).toBe(before);
    expect(pubGit("show", "main:README.md")).toStartWith("v3\n");
    expect(pubGit("log", "-1", "--format=%B", "main")).toBe("sync");
    const create = ghCalls.find((c) => c[2] === "create")!;
    expect(create[create.indexOf("--body-file") + 1]).toBe("-"); // with an empty body
    expect(ghCalls.map((c) => c.slice(0, 3).join(" "))).toEqual(["gh pr list", "gh pr create", "gh pr merge"]); // the first sync, onto an empty main, asks gh nothing
    expect(pubGit("for-each-ref", "refs/heads/sync/")).toBe(""); // the branch went with the merge
  });

  test("a sync PR a failed merge left open is merged by the next run; with a change only on the public main it is not merged", () => {
    sync(opts(), run);
    write("README.md", "v2\n");
    commit("feat: two (#3)");
    const failing: Run = (cmd, o) => (cmd[0] === "gh" && cmd[2] === "merge" ? { code: 1, out: "", err: "Pull request is not mergeable" } : run(cmd, o));
    expect(() => sync(opts(), failing)).toThrow("(it stays open; the next run merges it): Pull request is not mergeable"); // GitHub's reason is kept
    expect(pubGit("show", "main:README.md")).toStartWith("hello\n"); // the PR stays open, main as it was
    const branch = opened();
    const open: Run = (cmd, o) => (cmd[0] === "gh" && cmd[2] === "list" ? { code: 0, out: `7 ${branch}` } : run(cmd, o));
    const out = sync(opts(), open);
    expect(out).toContain(`merged sync PR 7 on ${TARGET}`);
    expect(out).toContain("nothing to sync");
    expect(pubGit("show", "main:README.md")).toStartWith("v2\n");
    // a commit made only on the public main: the open PR is left alone
    const tip = pubGit("rev-parse", "main");
    const tree = sh(pub, "sh", "-c", `printf '100644 blob %s\tX\n' $(echo x | git hash-object -w --stdin) | git mktree`);
    pubGit("update-ref", "refs/heads/main", sh(pub, "git", "-c", "user.name=dev", "-c", "user.email=dev@example.com", "commit-tree", tree, "-p", tip, "-m", "settings"));
    expect(() => sync(opts(), open)).toThrow("main changed after the last sync");
  });

  test("an open sync/ PR whose tree this script did not send (pushed by someone else) is not merged", () => {
    sync(opts(), run);
    const tip = pubGit("rev-parse", "main");
    const tree = sh(pub, "sh", "-c", `printf '100644 blob %s\tX\n' $(echo x | git hash-object -w --stdin) | git mktree`);
    pubGit("update-ref", "refs/heads/sync/v9.0.0", sh(pub, "git", "-c", "user.name=dev", "-c", "user.email=dev@example.com", "commit-tree", tree, "-p", tip, "-m", "v9.0.0"));
    const open: Run = (cmd, o) => (cmd[0] === "gh" && cmd[2] === "list" ? (ghCalls.push(cmd), { code: 0, out: "8 sync/v9.0.0" }) : run(cmd, o));
    expect(() => sync(opts(), open)).toThrow("sync PR #8 on example-org/app-public has a tree this script did not send: close it");
    expect(pubGit("rev-parse", "main")).toBe(tip);
    // what gh is asked for: only PRs from the public repository's own branches (a fork's sync/ branch is not this script's)
    expect(ghCalls.find((c) => c[2] === "list")!.join(" ")).toContain("isCrossRepository | not");
    expect(ghCalls.find((c) => c[2] === "list")!.at(-1)).toEndWith(String.raw` | "\(.number) \(.headRefName)"`); // jq's interpolation, as gh receives it
  });

  test("a change merged only on the public main stops the sync instead of overwriting it", () => {
    sync(opts(), run);
    const work = join(root, "pubwork");
    sh(root, "git", "clone", "-q", pub, work);
    sh(work, "git", "-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-q", "--allow-empty", "-m", "outside");
    writeFileSync(join(work, "README.md"), "outside\n");
    sh(work, "git", "-c", "user.email=dev@example.com", "-c", "user.name=dev", "commit", "-qam", "outside change");
    sh(work, "git", "push", "-q", "origin", "main");
    expect(() => sync(opts(), run)).toThrow("main changed after the last sync");
    write("README.md", "outside\n");
    commit("docs: bring in the outside change");
    expect(sync(opts({ adopted: true }), run)).toContain("replaced (--adopted)");
  });

  test("a personal home path or e-mail address in the tree stops before anything is pushed", () => {
    write("docs/a.md", `see ${HOME}\n`);
    commit("docs: a");
    expect(() => sync(opts(), run)).toThrow("personal home path");
    write("docs/a.md", `mail ${MAIL("alice")}\n`);
    commit("docs: b");
    expect(() => sync(opts(), run)).toThrow("personal e-mail address");
    expect(pubGit("for-each-ref").length).toBe(0);
    expect(sh(root, "git", "--git-dir", join(root, "private-origin.git"), "for-each-ref").length).toBe(0); // no private record either
  });

  test("the private record is pushed before the public side: a failed record push sends nothing public", () => {
    sh(priv, "git", "remote", "set-url", "origin", join(root, "missing.git"));
    expect(() => sync(opts(), run)).toThrow("git push -q origin");
    expect(pubGit("for-each-ref").length).toBe(0);
  });

  test("nothing is sent backwards: a source older than the last sync stops before anything is pushed", () => {
    sh(priv, "git", "tag", "v1.0.0");
    write("README.md", "v2\n");
    commit("feat: two (#3)");
    sh(priv, "git", "tag", "v1.1.0");
    sync(opts({ source: "v1.1.0" }), run);
    const before = pubGit("for-each-ref");
    expect(() => sync(opts({ source: "v1.0.0" }), run)).toThrow("v1.0.0 is older than what example-org/app-public has");
    expect(pubGit("for-each-ref")).toBe(before);
  });

  test("a secret-shaped value stops before anything is pushed: by the shapes in the whole tree, with the line; by the host's names and accounts in the change", () => {
    const host = { names: ["corp-admin"], accountIds: ["2109" + "87654321"] };
    write("docs/ops.md", "token: ghp_" + "a".repeat(36) + "\n");
    commit("docs: ops");
    expect(() => sync(opts({ host }), run)).toThrow("a secret-shaped value in the tree:\ndocs/ops.md:1 (github-token)");
    write("docs/ops.md", `build ${"2109" + "87654321"}\n`); // no context: only the host's account makes it one
    commit("docs: ops");
    expect(() => sync(opts({ host }), run)).toThrow("a secret-shaped value in what would go public:\ndocs/ops.md (account-id)");
    write("docs/ops.md", "profile corp-admin\n");
    commit("docs: ops");
    expect(() => sync(opts({ host }), run)).toThrow("docs/ops.md (aws-profile)");
    write("docs/ops.md", "Device code:\n" + "ABCD" + "-EFGH\n"); // the label on the added line above: the added lines are read together
    commit("docs: ops");
    expect(() => sync(opts({ host }), run)).toThrow("docs/ops.md:2 (device-code)");
    write("docs/ops.md", "x\n++ token: ghp_" + "c".repeat(36) + "\n"); // an added line that begins with "++ " is content, not a header
    commit("docs: ops");
    expect(() => sync(opts({ host }), run)).toThrow("docs/ops.md:2 (github-token)");
    write("docs/ops.md", "x\n");
    writeFileSync(join(priv, "docs/blob.bin"), "\0\0token: ghp_" + "b".repeat(36) + "\n"); // a file git calls binary
    commit("docs: blob");
    expect(() => sync(opts({ host }), run)).toThrow("docs/blob.bin:1 (github-token)");
    sh(priv, "git", "rm", "-q", "docs/blob.bin");
    expect(pubGit("for-each-ref").length).toBe(0);
    write("src/auth.test.ts", "const url = `https://d.example/?user_code=" + "WDJB" + "-MJHT`;\n"); // a test file is looked at too
    commit("test: auth");
    expect(() => sync(opts({ host }), run)).toThrow("src/auth.test.ts:1 (approval-url)");
    // an ARN carries an account by its shape, the host's or not
    write("docs/ops.md", `fixture: arn:aws:cloudformation:ap-northeast-1:${"1".repeat(12)}:stack/x\n`);
    commit("docs: ops");
    expect(() => sync(opts({ host }), run)).toThrow("docs/ops.md:1 (account-id)");
    // a template placeholder is not a value; nor is the example account
    write("src/auth.test.ts", "const url = `https://d.example/?user_code=${code}`;\n");
    write("docs/ops.md", "fixture: arn:aws:cloudformation:ap-northeast-1:123456789012:stack/x\n");
    commit("docs: ops");
    expect(sync(opts({ host }), run)).toContain("no secret-shaped value in the change");
  });

  test("the name of the OS user running the sync in a path stops it: in a file (/home, pytest-of-, C:\\Users, also as JSON writes it), in a file's path", () => {
    const user = "bob"; // not alice: beforeEach's ci.yml, which the home-path rule skips, holds alice's HOME
    for (const leak of [`/home/${user}/x`, `/tmp/pytest-of-${user}/t0`, `C:\\Users\\${user}\\x`, JSON.stringify(`C:\\Users\\${user}\\x`), `C:\\Users\\Bob\\x`]) { // the last: a Windows path in another case
      write("docs/a.md", `see ${leak}\n`);
      commit("docs: a");
      expect(() => sync(opts({ user }), run)).toThrow("the OS user's name in a path");
    }
    sh(priv, "git", "rm", "-q", "docs/a.md");
    const path = ["fixtures", "Users", user, "a.txt"].join("/"); // in a path only: the home-path rule reads file contents
    write(path, "x\n");
    commit("test: a fixture");
    expect(() => sync(opts({ user }), run)).toThrow(`(path) ${path}`);
    sh(priv, "git", "rm", "-rq", "fixtures");
    const mixed = ["fixtures", "Users", "Bob", "a.txt"].join("/"); // the path and the message in another case too
    write(mixed, "x\n");
    commit("test: a fixture");
    expect(() => sync(opts({ user }), run)).toThrow(`(path) ${mixed}`);
    expect(pubGit("for-each-ref").length).toBe(0);
  });

  test("a placeholder user name (one the home-path rule lets pass), a service user (publicSync.serviceUsers) or none is not looked for; a longer name is someone else's", () => {
    write("docs/a.md", "see /home/dev/x, /tmp/pytest-of-dev/t0, C:\\Users\\dev\\x, /home/svc/repos\n");
    commit("docs: a");
    for (const user of ["dev", ""]) expect(sync(opts({ user, dryRun: true }), run)).not.toContain("OS user's name");
    expect(sync(opts({ user: "svc", serviceUsers: ["svc"], dryRun: true }), run)).not.toContain("OS user's name");
    // compared ignoring case, as the search finds /home/svc for a user Svc
    expect(sync(opts({ user: "Dev", dryRun: true }), run)).not.toContain("OS user's name");
    expect(sync(opts({ user: "Svc", serviceUsers: ["svc"], dryRun: true }), run)).not.toContain("OS user's name");
    expect(sync(opts({ user: "svc", serviceUsers: ["SVC"], dryRun: true }), run)).not.toContain("OS user's name");
    expect(() => sync(opts({ user: "svc", dryRun: true }), run)).toThrow("publicSync.serviceUsers");
    expect(sync(opts({ user: "de", dryRun: true }), run)).toContain("no path with the OS user's name");
  });

  test("an address in a binary file, or in the author the environment sets, stops the sync", () => {
    write("assets/a.bin", `\0${MAIL("alice")}\0`);
    commit("chore: a binary");
    expect(() => sync(opts(), run)).toThrow("personal e-mail address");
    sh(priv, "git", "rm", "-q", "assets/a.bin");
    commit("chore: drop it");
    const asAlice: Run = (cmd, o) => run(cmd, { ...o, env: { ...o?.env, GIT_AUTHOR_EMAIL: MAIL("alice") } });
    expect(() => sync(opts(), asAlice)).toThrow("author / committer");
    expect(pubGit("for-each-ref").length).toBe(0);
  });

  test("an unchanged tree sends nothing; a sync PR closed unmerged is opened again for the same tag, its branch replaced", () => {
    sync(opts(), run);
    expect(sync(opts(), run)).toContain("nothing to sync");
    write("README.md", "v2\n");
    commit("feat: two (#3)");
    sh(priv, "git", "tag", "v1.1.0");
    const failing: Run = (cmd, o) => (cmd[0] === "gh" && cmd[2] === "merge" ? { code: 1, out: "" } : run(cmd, o));
    expect(() => sync(opts({ source: "v1.1.0" }), failing)).toThrow("could not merge sync PR");
    // the PR was closed by hand (no open PR in the list); a new commit, not the same sha, goes to the same branch
    const later: Run = (cmd, o) => run(cmd, { ...o, env: { ...o?.env, GIT_COMMITTER_DATE: "2030-01-01T00:00:00Z" } });
    expect(sync(opts({ source: "v1.1.0" }), later)).toContain("merged sync PR sync/v1.1.0");
    expect(pubGit("show", "main:README.md")).toStartWith("v2\n");
    expect(sync(opts({ source: "v1.1.0" }), run)).toContain("nothing to sync");
  });

  test("dry-run reports and pushes nothing", () => {
    const out = sync(opts({ dryRun: true }), run);
    expect(out).toContain("excluded .github/workflows/host.yml");
    expect(out).toContain("dry-run: would push a root commit to main");
    expect(pubGit("for-each-ref").length).toBe(0);
  });

  test("a public repository that is the private one stops before anything is read or pushed", () => {
    expect(() => sync(opts({ target: PRIVATE.toUpperCase() }), run)).toThrow("is the private one");
    expect(pubGit("for-each-ref").length).toBe(0);
  });

  test("loadPublicSync reads publicSync only: a config that is not in the kit's shape works, a missing or malformed one stops", () => {
    const f = (json: unknown) => {
      const p = join(root, "ops.config.json");
      writeFileSync(p, JSON.stringify(json));
      return p;
    };
    expect(loadPublicSync(f({ projectUrl: "https://github.com/orgs/example-org/projects/1", publicSync: { target: TARGET, rewrite: ["SECURITY.md"] } }))).toEqual({ target: TARGET, exclude: [], rewrite: ["SECURITY.md"] });
    expect(() => loadPublicSync(f({ projectUrl: "x" }))).toThrow("publicSync がありません");
    expect(() => loadPublicSync(f({ publicSync: { target: "no-slash" } }))).toThrow("publicSync.target");
    expect(loadPublicSync(f({ publicSync: { target: TARGET, versioning: "independent" } })).versioning).toBe("independent");
    expect(() => loadPublicSync(f({ publicSync: { target: TARGET, versioning: "unknown" } }))).toThrow("publicSync.versioning");
    expect(() => loadPublicSync(f({ publicSync: { target: TARGET, other: 1 } }))).toThrow("publicSync");
    expect(loadPublicSync(f({ publicSync: { target: TARGET, include: ["src/", "README.md"], exclude: ["src/internal/"] } }))).toEqual({ target: TARGET, include: ["src/", "README.md"], exclude: ["src/internal/"], rewrite: [] });
    for (const bad of [{ include: [] }, { include: ["../up"] }, { include: ["/abs"] }, { exclude: ["a/../b"] }]) expect(() => loadPublicSync(f({ publicSync: { target: TARGET, ...bad } }))).toThrow("publicSync.");
  });

  test("loadPublicSync with a commit reads the config of that commit, not the working tree's (public-sync reads the tree it sends)", () => {
    const p = join(priv, "ops.config.json");
    writeFileSync(p, JSON.stringify({ publicSync: { target: TARGET, exclude: ["old/"] } }));
    commit("chore: config");
    sh(priv, "git", "tag", "v1.0.0");
    writeFileSync(p, JSON.stringify({ publicSync: { target: TARGET, exclude: ["new/"] } }));
    commit("chore: config");
    writeFileSync(p, "{}"); // the working tree: neither
    expect(loadPublicSync(p, priv, "v1.0.0").exclude).toEqual(["old/"]);
    expect(loadPublicSync(p, priv, "HEAD").exclude).toEqual(["new/"]);
    expect(() => loadPublicSync(p, priv)).toThrow("publicSync がありません");
    expect(() => loadPublicSync(join(priv, "sub", "ops.config.json"), priv, "HEAD")).toThrow();
  });

  test("include names what goes: other top-level entries, and files added there later, stay private; exclude takes files and directories inside it; the public kit comes anyway", () => {
    write("src/app.ts", "export {};\n");
    write("src/internal/notes.md", "the owner's notes\n");
    write("src/secret.txt", "x\n");
    write("private/plan.md", "plan\n");
    write("CLAUDE.md", "rules\n");
    commit("feat: layout (#2)");
    const named = { include: ["README.md", "SECURITY.md", "src/", "docs/missing/"], exclude: ["src/secret.txt", "src/internal/"] };
    const out = sync(opts(named), run);
    expect(out).toContain("included README.md, SECURITY.md, src/, docs/missing/: 5 of 9 files (not in the tree: docs/missing/)");
    expect(out).toContain("excluded src/secret.txt\n");
    expect(out).toContain("excluded src/internal/ (1 files)");
    // .github/ is not named: the repository's workflows stay private, the public kit's forms and workflow come all the same
    expect(pubGit("ls-tree", "-r", "--name-only", "main").split("\n").sort()).toEqual([".github/ISSUE_TEMPLATE/config.yml", ".github/ISSUE_TEMPLATE/request.yml", ".github/workflows/close-pull-requests.yml", "README.md", "SECURITY.md", "src/app.ts"]);
    expect(pubGit("show", "main:SECURITY.md")).toContain(TARGET);
    // later: a file under a named directory goes, one beside it at the top does not
    write("src/later.ts", "export {};\n");
    write("later.md", "not named\n");
    const src = commit("feat: later (#3)");
    sync(opts(named), run);
    const sent = pubGit("ls-tree", "-r", "--name-only", "main").split("\n");
    expect(sent).toContain("src/later.ts");
    expect(sent).not.toContain("later.md");
    expect(sent).not.toContain("CLAUDE.md");
  });

  test("an entry that names a directory without the trailing slash stops the sync, instead of matching nothing", () => {
    write("src/app.ts", "export {};\n");
    write("src/internal/notes.md", "the owner's notes\n");
    commit("feat: layout (#2)");
    expect(() => sync(opts({ include: ["README.md", "src"] }), run)).toThrow("src is a directory: write it as src/");
    expect(() => sync(opts({ include: ["README.md", "src/"], exclude: ["src/internal"] }), run)).toThrow("src/internal is a directory: write it as src/internal/");
    expect(Bun.spawnSync(["git", "rev-parse", "--verify", "main"], { cwd: pub, stderr: "pipe" }).exitCode).not.toBe(0);
  });

  test("what include and exclude leave out is checked in the tree once more: a path git spells in bytes that are not UTF-8 is not let through", () => {
    // a top-level file named in Latin-1 (caf\xe9.txt): its name, read back as text, is not the bytes git holds
    const made = Bun.spawnSync(["sh", "-c", "printf x > \"$(printf 'caf\\351.txt')\""], { cwd: priv });
    expect(made.exitCode).toBe(0);
    commit("chore: a latin-1 name");
    expect(() => sync(opts({ include: ["README.md", "SECURITY.md"] }), run)).toThrow("left in the tree although include / exclude leave it out");
    expect(Bun.spawnSync(["git", "rev-parse", "--verify", "main"], { cwd: pub, stderr: "pipe" }).exitCode).not.toBe(0);
  });

  test("a rewrite file that include or exclude left out is not rewritten back in: the sync goes on, and the public kit's SECURITY.md takes its place", () => {
    // SECURITY.md names the private repository (beforeEach) and is in rewrite (opts), but include does not name it
    const out = sync(opts({ include: ["README.md"] }), run);
    expect(out).not.toContain("rewrote");
    expect(out).toContain("public kit: added SECURITY.md");
    expect(pubGit("show", "main:SECURITY.md")).not.toContain(PRIVATE + "/");
    expect(pubGit("ls-tree", "-r", "--name-only", "main").split("\n")).not.toContain(".github/workflows/ci.yml");
  });

  test("the command runs dry from the config, and stops with 1 without publicSync and 2 on a wrong flag", async () => {
    // the config is read from the tree that is sent (--source), not from the working tree
    const cfg = join(priv, "ops.config.json");
    writeFileSync(cfg, JSON.stringify({ publicSync: { target: TARGET, include: ["README.md", "SECURITY.md", ".github/"], exclude: [".github/workflows/host.yml"], rewrite: ["SECURITY.md"] } }));
    commit("chore: config");
    writeFileSync(cfg, "{}"); // only in the working tree: not what is read
    const lines: string[] = [];
    const errs: string[] = [];
    const gh = { run: async () => "" } as never;
    const prev = process.cwd();
    const prevRepo = process.env.GH_REPO;
    process.env.GH_REPO = PRIVATE;
    process.chdir(priv);
    try {
      expect(await main(["public-sync", "--config", cfg, "--source", "main", "--dry-run"], gh, (s) => lines.push(s), (s) => errs.push(s))).toBe(0);
      expect(lines.join("\n")).toContain("excluded .github/workflows/host.yml");
      expect(lines.join("\n")).toContain("included README.md, SECURITY.md, .github/: 4 of 5 files");
      writeFileSync(cfg, JSON.stringify({ publicSync: { target: TARGET, versioning: "independent" } }));
      commit("chore: independent config");
      expect(await main(["public-sync", "--config", cfg, "--source", "main", "--dry-run"], gh, () => {}, (s) => errs.push(s))).toBe(1);
      expect(errs.join("\n")).toContain("independent version requires --source");
      writeFileSync(cfg, "{}");
      commit("chore: empty config");
      expect(await main(["public-sync", "--config", cfg, "--source", "main", "--dry-run"], gh, () => {}, (s) => errs.push(s))).toBe(1);
      expect(await main(["public-sync", "--config", cfg, "--bogus"], gh, () => {}, (s) => errs.push(s))).toBe(2);
    } finally {
      process.chdir(prev);
      if (prevRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = prevRepo;
    }
    expect(errs.join("\n")).toContain("publicSync がありません");
  });

  test("dry-run against a public repository that already has a sync pushes nothing", () => {
    sync(opts(), run);
    write("README.md", "v2\n");
    commit("feat: two (#3)");
    const before = pubGit("for-each-ref");
    expect(sync(opts({ dryRun: true }), run)).toContain("dry-run: would open a PR from sync/");
    expect(pubGit("for-each-ref")).toBe(before);
    expect(ghCalls.map((c) => c.slice(0, 3).join(" "))).toEqual(["gh pr list"]); // reads only
  });

  test("a rewritten file keeps its mode", () => {
    write("SECURITY.md", "Report: https://github.com/example-org/app/security\n");
    sh(priv, "chmod", "+x", "SECURITY.md");
    commit("chore: executable");
    sync(opts(), run);
    expect(pubGit("ls-tree", "main", "--", "SECURITY.md")).toStartWith("100755 ");
    expect(pubGit("show", "main:SECURITY.md")).toContain("app-public");
  });

  test("the public kit goes into the tree: the one request form, the close-pull-requests workflow, SECURITY.md where there is none, the policy section before the first heading — and no PBI / Task form (#1742)", () => {
    for (const f of ["pbi.yml", "task.yml", "feature_request.yml"]) write(`.github/ISSUE_TEMPLATE/${f}`, `name: ${f}\n`);
    write(".github/ISSUE_TEMPLATE/config.yml", "blank_issues_enabled: true\n");
    write(".github/workflows/project-autoadd.yml", "on: issues\n");
    sh(priv, "git", "rm", "-q", "SECURITY.md");
    write("README.md", "# App\n\nintro\n\n## Status\n\nalpha\n\n## Run\n\nbun start\n");
    commit("feat: forms (#2)");
    const out = sync(opts({ dryRun: true, exclude: [".github/workflows/host.yml", ".github/workflows/project-autoadd.yml"] }), run);
    const tree = /with tree ([0-9a-f]{40})/.exec(out)![1]!;
    const ls = (p: string) => sh(priv, "git", "ls-tree", "-r", "--name-only", tree, "--", p).split("\n").filter(Boolean).sort();
    const show = (p: string) => sh(priv, "git", "cat-file", "-p", `${tree}:${p}`);
    expect(ls(".github/ISSUE_TEMPLATE")).toEqual([".github/ISSUE_TEMPLATE/config.yml", ".github/ISSUE_TEMPLATE/request.yml"]);
    expect(ls(".github/workflows")).toEqual([".github/workflows/ci.yml", ".github/workflows/close-pull-requests.yml"]);
    expect(show(".github/ISSUE_TEMPLATE/config.yml")).toContain("url: https://github.com/example-org/app-public/discussions");
    expect(show("SECURITY.md")).toContain("https://github.com/example-org/app-public/security/advisories/new");
    const readme = show("README.md");
    expect(readme.split("\n").filter((l) => l.startsWith("## "))).toEqual(["## How this repository works", "## Status", "## Run"]);
    expect(readme).toContain("# App\n\nintro\n\n## How this repository works\n\n");
    expect(readme).toContain("https://github.com/example-org/app-public/discussions\n\n## Status\n\nalpha\n");
    // the report follows the fence rule too: a copy of the heading inside an example is not "replaced"
    write("README.md", "# App\n\n```\n## How this repository works\n```\n\n## Status\n");
    commit("docs: example (#3)");
    expect(sync(opts({ dryRun: true }), run)).toContain("public kit: README.md — inserted ## How this repository works before ## Status");
    expect(Bun.spawnSync(["git", "grep", "-q", "__PUBLIC_REPO__", tree], { cwd: priv, stderr: "pipe" }).exitCode).toBe(1);
    for (const line of [
      "public kit: .github/ISSUE_TEMPLATE/ is config.yml, request.yml (removed config.yml, feature_request.yml, pbi.yml, task.yml)",
      "public kit: added .github/workflows/close-pull-requests.yml",
      "public kit: added SECURITY.md",
      "public kit: README.md — inserted ## How this repository works before ## Status",
    ]) expect(out).toContain(line);
    expect(pubGit("for-each-ref").length).toBe(0);
  });

  test("the policy section is replaced, not doubled, on the next sync; a repository's own SECURITY.md is kept", () => {
    write("README.md", "# App\n\n## Status\n\nalpha\n");
    commit("docs: readme (#2)");
    sync(opts(), run);
    const first = pubGit("show", "main:README.md");
    expect(first.split("\n").filter((l) => l === "## How this repository works").length).toBe(1);
    // the public README, section and all, is brought into the private one and synced again: the section is the same, once
    write("README.md", `${first}\n`);
    write("docs/a.md", "a\n");
    const src = commit("docs: adopt the section (#3)");
    const out = sync(opts(), run);
    expect(out).toContain("public kit: README.md — replaced ## How this repository works");
    expect(out).toContain("public kit: kept the repository's SECURITY.md");
    expect(pubGit("show", "main:README.md")).toBe(first);
    expect(pubGit("show", "main:SECURITY.md")).toBe("Report: https://github.com/example-org/app-public/security/advisories/new");
  });

  test("a --source behind HEAD whose forms and excluded files differ from the working tree still syncs: the removals are index-only", () => {
    write(".github/ISSUE_TEMPLATE/pbi.yml", "name: PBI v1\n");
    write(".github/workflows/host.yml", "on: push\n");
    write("README.md", "## Status\n\nv1\n");
    commit("feat: v1 (#2)");
    sh(priv, "git", "tag", "v1");
    write(".github/ISSUE_TEMPLATE/pbi.yml", "name: PBI v2\n");
    write(".github/workflows/host.yml", "on: pull_request\n");
    write("README.md", "## Status\n\nv2\n");
    commit("feat: v2 (#3)");
    const out = sync(opts({ source: "v1" }), run);
    expect(out).toContain("excluded .github/workflows/host.yml");
    expect(out).toContain("(removed pbi.yml)");
    expect(pubGit("ls-tree", "-r", "--name-only", "main").split("\n")).not.toContain(".github/ISSUE_TEMPLATE/pbi.yml");
    expect(pubGit("show", "main:README.md")).toContain("v1");
    expect(sh(priv, "git", "show", "HEAD:.github/ISSUE_TEMPLATE/pbi.yml")).toBe("name: PBI v2"); // the working tree and HEAD are untouched
  });

  test("a --source tag is the title of the commit and the PR and names the branch; a branch or a sha gives the plain title \"sync\"; no private sha or issue number goes out", () => {
    const first = sh(priv, "git", "rev-parse", "HEAD");
    sh(priv, "git", "tag", "v1.0.0");
    sync(opts({ source: "v1.0.0" }), run);
    expect(pubGit("log", "-1", "--format=%s", "main")).toBe("v1.0.0");
    expect(record(pubGit("rev-parse", "main^{tree}"))).toBe(first);
    write("README.md", "v2\n");
    commit("feat: two (#3)");
    write("NOTES.md", "n\n");
    const two = commit("fix: follow-ups for #2 and #12 (review #3)");
    sh(priv, "git", "tag", "v1.1.0");
    sync(opts({ source: "v1.1.0" }), run);
    expect(opened()).toBe("sync/v1.1.0");
    // the title is the version only, and there is no body (no private subject, sha or issue number)
    expect(pubGit("log", "-1", "--format=%B", "main")).toBe("v1.1.0");
    const create = ghCalls.find((c) => c[2] === "create")!;
    expect(create[create.indexOf("--title") + 1]).toBe("v1.1.0");
    expect(record(pubGit("rev-parse", "main^{tree}"))).toBe(two);
    write("README.md", "v3\n");
    const three = commit("feat: three (#4)");
    sync(opts({ source: three }), run);
    expect(pubGit("log", "-1", "--format=%s", "main")).toBe("sync");
    expect(opened()).toBe(`sync/${pubGit("rev-parse", "main^{tree}").slice(0, 7)}`); // named after the public tree, not the private sha
  });

  test("the release: a versioned sync gets its public tag and Release through gh in the same run, once; a run that merges a left-open sync PR releases it too; never for a plain sync or a bare --target-url", () => {
    // without --target-url the URL is GitHub's: git is pointed at the bare here, gh answers from `released`
    const github = `https://github.com/${TARGET}.git`;
    const released = new Set<string>();
    let failMerge = false;
    const gh: Run = (cmd, o) => {
      if (cmd[0] === "git") return run(cmd.map((a) => (a === github ? pub : a)), o);
      if (cmd[2] === "merge" && failMerge) return { code: 1, out: "" };
      if (cmd[1] !== "release") return run(cmd, o);
      ghCalls.push(cmd);
      if (cmd[2] === "create") released.add(cmd[3]!);
      return { code: cmd[2] === "view" && !released.has(cmd[3]!) ? 1 : 0, out: "" };
    };
    const calls = () => ghCalls.splice(0).map((c) => c.slice(0, 3).join(" "));
    sync(opts({ targetUrl: undefined }), gh); // a plain first sync: no version, no release
    expect(calls()).toEqual([]);
    write("README.md", "v2\n");
    commit("feat: two (#3)");
    sh(priv, "git", "tag", "v1.0.0");
    const out = sync(opts({ targetUrl: undefined, source: "v1.0.0" }), gh);
    const merged = pubGit("rev-parse", "main");
    expect(out).toContain(`released v1.0.0 on ${TARGET} at ${merged.slice(0, 7)}`);
    expect(calls()).toEqual(["gh pr list", "gh pr create", "gh pr merge", "gh release view", "gh release create"]);
    sync(opts({ targetUrl: undefined, source: "v1.0.0" }), gh); // already released: view only
    expect(calls()).toEqual(["gh pr list", "gh release view"]);
    // a merge that fails leaves the PR open; the next run merges it and releases it
    write("README.md", "v3\n");
    commit("feat: three (#4)");
    sh(priv, "git", "tag", "v1.1.0");
    failMerge = true;
    expect(() => sync(opts({ targetUrl: undefined, source: "v1.1.0" }), gh)).toThrow("could not merge sync PR");
    failMerge = false;
    calls();
    const open: Run = (cmd, o) => (cmd[0] === "gh" && cmd[2] === "list" ? (ghCalls.push(cmd), { code: 0, out: "9 sync/v1.1.0" }) : gh(cmd, o));
    expect(sync(opts({ targetUrl: undefined, source: "v1.1.0" }), open)).toContain(`released v1.1.0 on ${TARGET} at ${pubGit("rev-parse", "main").slice(0, 7)}`);
    expect(calls()).toEqual(["gh pr list", "gh pr merge", "gh release view", "gh release create"]);
    expect(sync(opts({ source: "v1.1.0" }), gh)).toContain("release: skipped (--target-url)");
  });

  test("a repository's own security policy under .github/ or docs/ is kept too: the kit's SECURITY.md is not added beside it", () => {
    sh(priv, "git", "rm", "-q", "SECURITY.md");
    for (const own of [".github/SECURITY.md", "docs/SECURITY.md"]) {
      write(own, "ours\n");
      commit(`docs: policy at ${own}`);
      const out = sync(opts({ dryRun: true }), run);
      expect(out).toContain(`public kit: kept the repository's ${own}`);
      const tree = /with tree ([0-9a-f]{40})/.exec(out)![1]!;
      expect(sh(priv, "git", "ls-tree", "-r", "--name-only", tree).split("\n")).not.toContain("SECURITY.md");
      sh(priv, "git", "rm", "-q", own);
    }
  });

  test("run from a subdirectory of the repository, the same tree is built: every path is taken from the top", () => {
    write(".github/ISSUE_TEMPLATE/pbi.yml", "name: PBI\n");
    write("sub/README.md", "# a package\n\n## Use\n\nx\n");
    write("sub/SECURITY.md", "not the repository's\n");
    commit("feat: a subdirectory with its own README and policy (#2)");
    const atTop = /with tree ([0-9a-f]{40})/.exec(sync(opts({ dryRun: true }), run))![1]!;
    const inSub: Run = (cmd, o) => {
      if (cmd[0] === "gh") return run(cmd, o);
      const p = Bun.spawnSync(cmd, { cwd: join(priv, "sub"), stdin: o?.input === undefined ? "ignore" : new TextEncoder().encode(o.input), env: { ...process.env, ...o?.env }, stderr: "pipe" });
      return { code: p.exitCode ?? 1, out: p.stdout.toString().replace(/\n$/, "") };
    };
    const out = sync(opts({ dryRun: true }), inSub);
    expect(/with tree ([0-9a-f]{40})/.exec(out)![1]).toBe(atTop);
    expect(out).toContain("(removed pbi.yml)");
    expect(out).toContain("public kit: kept the repository's SECURITY.md");
    expect(sh(priv, "git", "cat-file", "-p", `${atTop}:README.md`)).toStartWith("hello\n\n## How this repository works");
    // the checks cover the whole tree from there too (`git grep` on a tree is limited to the directory git runs in)
    write("docs/a.md", `mail ${MAIL("alice")}\n`);
    commit("docs: an address at the top (#3)");
    expect(() => sync(opts(), inSub)).toThrow("personal e-mail address");
    expect(pubGit("for-each-ref").length).toBe(0);
  });

  test("a tree without README.md stops before anything is pushed", () => {
    sh(priv, "git", "rm", "-q", "README.md");
    commit("chore: no readme (#2)");
    expect(() => sync(opts(), run)).toThrow("README.md is not in the tree");
    expect(pubGit("for-each-ref").length).toBe(0);
  });

  test("withPolicySection: before the first heading, in place of its own section, at the end without a heading; the same text again changes nothing", () => {
    const section = "## How this repository works\n\nread-only.\n";
    expect(withPolicySection("# T\n\nintro\n\n## A\n\na\n", section)).toBe("# T\n\nintro\n\n## How this repository works\n\nread-only.\n\n## A\n\na\n");
    expect(withPolicySection("## How this repository works\n\nold text\n\n## A\n\na\n", section)).toBe("## How this repository works\n\nread-only.\n\n## A\n\na\n");
    expect(withPolicySection("hello\n", section)).toBe("hello\n\n## How this repository works\n\nread-only.\n");
    expect(withPolicySection("# T\n\n## How this repository works\n\nold\n", section)).toBe("# T\n\n## How this repository works\n\nread-only.\n");
    const once = withPolicySection("# T\n\n## A\n\na\n", section);
    expect(withPolicySection(once, section)).toBe(once);
    // a `## ` line inside a fenced example is not a heading: the section goes before the first real one, and its own
    // heading inside a fence does not count as the section
    const fenced = "# T\n\n```markdown\n## Example\n```\n\n~~~\n## How this repository works\n~~~\n\n## A\n\na\n";
    expect(withPolicySection(fenced, section)).toBe("# T\n\n```markdown\n## Example\n```\n\n~~~\n## How this repository works\n~~~\n\n## How this repository works\n\nread-only.\n\n## A\n\na\n");
    expect(withPolicySection("```\n## Example\n```\n", section)).toBe("```\n## Example\n```\n\n## How this repository works\n\nread-only.\n");
    // a fence closes only with the same character, at least as long, and nothing after it: an inner ```js and a
    // shorter ``` stay inside a ```` block, and a `## ` after them is still example text
    const longer = "# T\n\n````markdown\n```js\nx\n```\n## Example\n````\n\n## A\n\na\n";
    expect(withPolicySection(longer, section)).toBe("# T\n\n````markdown\n```js\nx\n```\n## Example\n````\n\n## How this repository works\n\nread-only.\n\n## A\n\na\n");
    expect(withPolicySection("~~~\n``` \n## Example\n~~~ \n\n## A\n", section)).toBe("~~~\n``` \n## Example\n~~~ \n\n## How this repository works\n\nread-only.\n\n## A\n");
    // the report of what was done follows the same rule: a heading of another level or inside a fence is not the section
    expect(policySectionAt("### How this repository works\n\n```\n## How this repository works\n```\n")).toBe(-1);
    expect(policySectionAt("# T\n\n## How this repository works\n")).toBe(2);
  });

  test("personalEmails keeps placeholders and service addresses out", () => {
    expect(personalEmails(`a@example.com b@x.example.invalid git@github.com 1+u@users.noreply.github.com ${MAIL("c")} ${MAIL("c")}`)).toEqual([MAIL("c")]);
  });

  test("check builds the tree as the sync does and stops on the same private name, home path or address, with the file and line; nothing is read from the public side", () => {
    const checked = (extra: object = {}) => check({ ...opts(), source: "HEAD", ...extra }, run);
    expect(checked()).toMatch(/^public check: ok \(\d+ files\)$/);
    write("docs/a.md", `line one\nsee ${PRIVATE}\n`);
    commit("docs: a");
    expect(() => checked()).toThrow(/private repository name in public output:\n[0-9a-f]+:docs\/a\.md:2:/);
    for (const [body, what] of [[`see ${HOME}\n`, "personal home path"], [`mail ${MAIL("alice")}\n`, "personal e-mail address"]] as const) {
      write("docs/a.md", body);
      commit("docs: b");
      expect(() => checked()).toThrow(what);
      expect(() => sync({ ...opts(), dryRun: true }, run)).toThrow(what); // the sync stops on the same tree, with the same words
    }
    expect(pubGit("for-each-ref").length).toBe(0);
    expect(() => checked({ targetUrl: "/nonexistent" })).toThrow("personal e-mail address"); // no public side is reached for
  });

  test("a tree stop gets the stale-source line only when origin/main's tree, by origin/main's own options, passes check", () => {
    const code = "ABCD" + "-EFGH";
    const note = "origin/main's tree has none";
    const toMain = () => {
      sh(priv, "git", "push", "-q", "origin", "main");
      sh(priv, "git", "fetch", "-q", "origin");
    };
    write("src/auth.test.ts", `const auth = { code: "${code}" };\n`);
    commit("test: auth");
    sh(priv, "git", "tag", "v1.0.0");
    toMain();
    let stop = "";
    try {
      sync(opts({ source: "v1.0.0", dryRun: true }), run);
    } catch (e) {
      stop = (e as Error).message;
    }
    expect(stop).toBe("a secret-shaped value in the tree:\nsrc/auth.test.ts:1 (device-code)");
    expect(withStaleNote(stop, () => opts(), run)).toBe(stop); // origin/main still has it
    expect(withStaleNote(stop, () => opts({ exclude: [".github/workflows/host.yml", "src/auth.test.ts"] }), run)).toStartWith(`${stop}\n${note}: `); // main's own exclude fixed it
    expect(withStaleNote(stop, () => { throw new Error("no publicSync at origin/main"); }, run)).toBe(stop);
    expect(withStaleNote("a personal home path in the tree:\nx", () => opts({ exclude: ["src/auth.test.ts"] }), run)).toBe("a personal home path in the tree:\nx");
    write("src/auth.test.ts", `const auth = { code: "XXXX-XXXX" };\n`);
    commit("test: auth placeholder");
    toMain();
    expect(withStaleNote(stop, () => opts(), run)).toStartWith(`${stop}\n${note}: `); // main's tree fixed it
    expect(pubGit("for-each-ref")).toBe("");
  });

  test("check and the sync stop on a secret-shaped value anywhere in the tree with the same words, the file, the line and the kind, never the value; a placeholder passes", () => {
    const code = "ABCD" + "-EFGH";
    write("src/auth.test.ts", `// an old fixture\nconst auth = { code: "${code}" };\n`);
    commit("test: auth");
    const words = "a secret-shaped value in the tree:\nsrc/auth.test.ts:2 (device-code)";
    expect(() => check({ ...opts(), source: "HEAD" }, run)).toThrow(words);
    expect(() => sync({ ...opts(), dryRun: true }, run)).toThrow(words);
    try {
      check({ ...opts(), source: "HEAD" }, run);
    } catch (e) {
      expect(String(e)).not.toContain(code);
    }
    write("src/auth.test.ts", `// an old fixture\nconst auth = { code: "XXXX-XXXX" };\n`);
    commit("test: auth");
    expect(check({ ...opts(), source: "HEAD" }, run)).toContain("public check: ok");
    expect(sync({ ...opts(), dryRun: true }, run)).toContain("dry-run:");
  });

  test("check counts the host's names and accounts in the whole tree, the file last published included, and only where the host has them", () => {
    const host = { names: ["corp-admin"], accountIds: ["2109" + "87654321"] };
    write("docs/ops.md", `profile corp-admin\nbuild ${"2109" + "87654321"}\n`);
    commit("docs: ops");
    expect(check({ ...opts(), source: "HEAD" }, run)).toContain("public check: ok"); // no host (CI): not counted
    sync(opts(), run); // published without the host's values, so the sync did not see them
    write("README.md", "hello again\n");
    commit("docs: readme");
    const words = "a secret-shaped value in the tree:\ndocs/ops.md:1 (aws-profile)\ndocs/ops.md:2 (account-id)";
    expect(() => check({ ...opts(), source: "HEAD", host }, run)).toThrow(words); // unchanged since the last sync: the whole tree
    try {
      check({ ...opts(), source: "HEAD", host }, run);
    } catch (e) {
      expect(String(e)).not.toContain("corp-admin");
      expect(String(e)).not.toContain("2109" + "87654321");
    }
    expect(sync({ ...opts({ host }), dryRun: true }, run)).toContain("dry-run:"); // the sync reads the change only
  });

  test("check passes a tree whose secret-shaped value is only in an excluded file", () => {
    write(".github/workflows/host.yml", "token: ghp_" + "a".repeat(36) + "\n");
    commit("ci: host");
    expect(check({ ...opts(), source: "HEAD" }, run)).toContain("public check: ok");
    expect(() => check({ ...opts(), source: "HEAD", exclude: [] }, run)).toThrow(".github/workflows/host.yml:1 (github-token)");
  });

  test("check passes a tree whose private name is only in a rewritten or an excluded file, as the sync does", () => {
    // SECURITY.md (rewrite) names the private repository from the start; the excluded workflow does now too
    write(".github/workflows/host.yml", `repo: ${PRIVATE}\n`);
    commit("ci: host");
    expect(check({ ...opts(), source: "HEAD" }, run)).toContain("public check: ok");
    expect(sync({ ...opts(), dryRun: true }, run)).toContain("rewrote");
    expect(() => check({ ...opts(), source: "HEAD", rewrite: [] }, run)).toThrow("SECURITY.md");
  });

  test("the command's --check: ok, a private name with 1, skipped in the public copy (GH_REPO, else origin, is publicSync.target — not gh's chosen remote), 2 with a sending flag", async () => {
    const cfg = join(priv, "ops.config.json");
    writeFileSync(cfg, JSON.stringify({ publicSync: { target: TARGET, versioning: "independent", exclude: [".github/workflows/host.yml"], rewrite: ["SECURITY.md"] } }));
    commit("chore: config");
    const lines: string[] = [];
    const errs: string[] = [];
    const gh = { run: async () => "" } as never;
    const prev = process.cwd();
    const prevRepo = process.env.GH_REPO;
    process.chdir(priv);
    try {
      process.env.GH_REPO = PRIVATE;
      expect(await main(["public-sync", "--config", cfg, "--check"], gh, (s) => lines.push(s), (s) => errs.push(s))).toBe(0); // no tag needed for a versioned config
      expect(lines.at(-1)).toContain("public check: ok");
      write("docs/a.md", `see ${PRIVATE}\n`);
      commit("docs: a");
      expect(await main(["public-sync", "--config", cfg, "--check"], gh, () => {}, (s) => errs.push(s))).toBe(1);
      expect(errs.at(-1)).toContain("docs/a.md:1:");
      process.env.GH_REPO = TARGET;
      expect(await main(["public-sync", "--config", cfg, "--check"], gh, (s) => lines.push(s), () => {})).toBe(0);
      expect(lines.at(-1)).toContain("skipped");
      // without GH_REPO: origin decides, not gh's chosen remote (a default pointed at the public copy does not skip it)
      delete process.env.GH_REPO;
      const origin = sh(priv, "git", "remote", "get-url", "origin");
      sh(priv, "git", "remote", "set-url", "origin", `https://github.com/${PRIVATE}.git`);
      sh(priv, "git", "remote", "add", "public", `https://github.com/${TARGET}.git`);
      sh(priv, "git", "config", "remote.public.gh-resolved", "base");
      expect(await main(["public-sync", "--config", cfg, "--check"], gh, () => {}, (s) => errs.push(s))).toBe(1);
      expect(errs.at(-1)).toContain("docs/a.md:1:");
      sh(priv, "git", "remote", "set-url", "origin", `git@github.com:${TARGET}.git`);
      expect(await main(["public-sync", "--config", cfg, "--check"], gh, (s) => lines.push(s), () => {})).toBe(0);
      expect(lines.at(-1)).toContain("skipped");
      sh(priv, "git", "remote", "set-url", "origin", origin);
      for (const flag of ["--dry-run", "--adopted"]) expect(await main(["public-sync", "--config", cfg, "--check", flag], gh, () => {}, () => {})).toBe(2);
    } finally {
      process.chdir(prev);
      if (prevRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = prevRepo;
    }
  });

  test("spawnRun returns stdout without the last newline", () => {
    expect(spawnRun(["printf", "a\\n"]).out).toBe("a");
  });
});
