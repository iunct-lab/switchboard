// test-reads: ops-kit/bin/gh
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { backlogWrite, bodiesOf, GUARD_MARK, realCommand, writeTargetOf } from "./gh-guard.ts";

const GUARD = join(import.meta.dir, "../bin/gh");
const code = ["QWJK", "ZRTP"].join("-");
const secret = `承認をお願いします: https://d.example/?user_code=${code}`;
let dir: string;
let log: string;
let awsConfig: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ops-kit.gh-guard."));
  log = join(dir, "called.json");
  // a made-up AWS config, so that the host's own is never read
  awsConfig = join(dir, "aws-config");
  writeFileSync(awsConfig, "[default]\n[profile x-admin]\n[sso-session y-session]\n");
  // the gh behind the guard: records what it was given and answers with its own exit code
  writeFileSync(join(dir, "gh"), `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin: await Bun.stdin.text() }));\nconsole.log("from gh");\nprocess.exit(3);\n`);
  chmodSync(join(dir, "gh"), 0o755);
});
afterAll(() => rmSync(dir, { recursive: true }));

// outside the app's Task unless `env` says otherwise: a Task running these tests has BACKLOG_URL
function run(argv: string[], stdin = "", awsConfigFile = awsConfig, env: Record<string, string | undefined> = { BACKLOG_URL: undefined }) {
  if (existsSync(log)) rmSync(log);
  // cwd: a directory with no ops.config.json above it, so that this checkout's publicSync plays no part
  const p = Bun.spawnSync([GUARD, ...argv], { cwd: dir, env: { ...process.env, ...env, AWS_CONFIG_FILE: awsConfigFile, PATH: `${dirname(GUARD)}:${dir}:${process.env.PATH}` }, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString(), called: existsSync(log) ? (JSON.parse(readFileSync(log, "utf8")) as { argv: string[]; stdin: string }) : null };
}

describe("ops-kit/bin/gh", () => {
  test("a write whose text holds a value stops before gh: exit 1, the kind and the line, never the value", () => {
    const file = join(dir, "body.md");
    writeFileSync(file, `## 判断待ち\n${secret}\n`);
    const writes = [
      ["issue", "comment", "1", "-R", "o/r", "--body", secret],
      ["issue", "comment", "1", `--body=${secret}`],
      ["issue", "create", "-t", `コード ${code}`, "-b", "本文"],
      ["issue", "edit", "1", "--body-file", file],
      ["pr", "create", "--title", "題", "-F", file],
      ["pr", "comment", "1", "-b", secret],
      ["pr", "edit", "1", "-F", file],
      ["pr", "review", "1", "--comment", "-b", secret],
      ["api", "repos/o/r/issues/1/comments", "-f", `body=${secret}`],
      ["api", "repos/o/r/issues/1/comments", "-F", `body=@${file}`],
      ["api", "-X", "PATCH", "repos/o/r/issues/comments/1", "--input", file],
    ];
    for (const argv of writes) {
      const r = run(argv);
      expect({ argv, code: r.code, called: r.called }).toEqual({ argv, code: 1, called: null });
      expect(r.err).toMatch(/approval-url|device-code/);
      expect(r.err + r.out).not.toContain("QWJK");
    }
  });

  test("a name of the host's AWS config stops a write, by kind and line only; without the name it passes", () => {
    const file = join(dir, "named.md");
    writeFileSync(file, "一行目\naws sso login --profile x-admin\n");
    for (const argv of [["issue", "comment", "1", "--body", "セッション y-session"], ["issue", "comment", "1", "--body-file", file]]) {
      const r = run(argv);
      expect({ argv, code: r.code, called: r.called }).toEqual({ argv, code: 1, called: null });
      expect(r.err).toContain("aws-profile");
      expect(r.err + r.out).not.toMatch(/x-admin|y-session/);
    }
    expect(run(["issue", "comment", "1", "--body-file", file]).err).toContain("aws-profile、2 行目");
    expect(run(["issue", "comment", "1", "--body", "名前の無い本文"])).toMatchObject({ code: 3, called: { argv: ["issue", "comment", "1", "--body", "名前の無い本文"] } });
    // a host without the config does not know the name
    expect(run(["issue", "comment", "1", "--body", "セッション y-session"], "", join(dir, "none"))).toMatchObject({ code: 3 });
  });

  test("an account id of the host's AWS config stops a write written bare, by kind only; without the config it passes", () => {
    const id = ["8642", "9753", "1086"].join("");
    const config = join(dir, "aws-config-account");
    writeFileSync(config, `[profile x-admin]\nsso_account_id = ${id}\n`);
    const r = run(["issue", "comment", "1", "--body", `メモ ${id}`], "", config);
    expect(r).toMatchObject({ code: 1, called: null });
    expect(r.err).toContain("account-id");
    expect(r.err + r.out).not.toContain(id);
    expect(run(["issue", "comment", "1", "--body", `メモ ${id}`])).toMatchObject({ code: 3 });
  });

  test("the standard input is read as the text too", () => {
    for (const argv of [["issue", "comment", "1", "--body-file", "-"], ["api", "graphql", "--input", "-"], ["api", "x", "-F", "body=@-"]]) {
      expect(run(argv, secret)).toMatchObject({ code: 1, called: null });
    }
  });

  test("a write without a value, and a read, reach gh unchanged: arguments, standard input, exit code, output", () => {
    const file = join(dir, "fine.md");
    writeFileSync(file, "着手: 枝 `sb/1-x`\n承認 URL `?user_code=…` は書かない\n");
    for (const argv of [["issue", "comment", "1", "-R", "o/r", "--body-file", file], ["issue", "view", "1", "--json", "body"], ["pr", "list"], ["api", "repos/o/r/issues/1"], ["stack", "submit", "--auto"], ["issue", "comment", "1"]]) {
      expect({ argv, r: run(argv) }).toEqual({ argv, r: { code: 3, out: "from gh\n", err: "", called: { argv, stdin: "" } } });
    }
    const piped = "レビュー: codex 2 件\n";
    expect(run(["pr", "comment", "1", "--body-file", "-"], piped)).toMatchObject({ code: 3, called: { argv: ["pr", "comment", "1", "--body-file", "-"], stdin: piped } });
    // a read that names a value on its command line is not a write
    expect(run(["issue", "list", "--search", `コード ${code}`]).code).toBe(3);
    // a body file that is not there: gh says so
    expect(run(["issue", "comment", "1", "--body-file", join(dir, "none.md")]).code).toBe(3);
  });

  test("close merge release gist: the closing comment, the merge body and subject, the release title and notes stop before gh", () => {
    const file = join(dir, "notes.md");
    writeFileSync(file, `## 変更\n${secret}\n`);
    const writes: [string[], string?][] = [];
    for (const close of [["issue", "close", "1"], ["pr", "close", "1"]]) {
      writes.push([[...close, "--comment", secret]], [[...close, `--comment=${secret}`]], [[...close, "-c", secret]], [[...close, `-c${secret}`]]);
    }
    writes.push(
      [["pr", "close", "1", "-dc", secret]],
      [["pr", "merge", "1", "-sb", secret]],
      [["pr", "merge", "1", "-F", file]],
      [["pr", "merge", "1", "-F", "-"], secret],
      [["pr", "merge", "1", "-t", `コード ${code}`]],
      [["release", "create", "v1", "-n", secret]],
      [["release", "new", "v1", "--notes-file", file]],
      [["release", "create", "v1", "-dp", "-F", "-"], secret],
      [["release", "edit", "v1", "-t", `コード ${code}`]],
      [["release", "edit", "v1", "--tag", "v2", "--notes", secret]],
      [["issue", "--body", "close", "create", "--title", secret]],
      [["pr", "-R", "o/r", "--body", "close", "merge", "1", "--subject", secret]],
    );
    for (const [argv, stdin] of writes) {
      const r = run(argv, stdin);
      expect({ argv, code: r.code, called: r.called }).toEqual({ argv, code: 1, called: null });
      expect(r.err + r.out).not.toContain("QWJK");
    }
  });

  test("close merge release gist: without a value the command reaches gh unchanged", () => {
    const piped = "マージ: 2 件の Task\n";
    for (const [argv, stdin] of [
      [["pr", "close", "1", "-d", "-c", "ok"], ""],
      [["issue", "close", "1", "-r", "not planned"], ""],
      [["issue", "close", "1", "--duplicate-of", "2", "-c", "重複"], ""],
      [["pr", "merge", "1", "-F", "-"], piped],
      [["pr", "merge", "1", "--rebase", "--match-head-commit", "abc", "-t", "題"], ""],
      [["release", "create", "v1", "--notes-start-tag", "v0", "-n", "ok"], ""],
      [["release", "edit", "v1", "--draft=false", "-F", "-"], piped],
    ] as [string[], string][]) {
      expect({ argv, r: run(argv, stdin) }).toEqual({ argv, r: { code: 3, out: "from gh\n", err: "", called: { argv, stdin } } });
    }
  });

  test("close merge release gist: gist files, a piped standard input and the description stop before gh", () => {
    const gists = join(dir, "gists");
    mkdirSync(gists, { recursive: true });
    const bad = join(gists, "bad.md");
    mkdirSync(join(dir, "hidden"), { recursive: true });
    writeFileSync(join(dir, "hidden", ".note.md"), `${secret}\n`);
    const ok = join(dir, "ok.txt");
    writeFileSync(bad, `メモ\n${secret}\n`);
    writeFileSync(ok, "hello\n");
    for (const [argv, stdin] of [
      [["gist", "create", bad], ""],
      [["gist", "create", "-p", ok, bad], ""],
      [["gist", "new", "-"], secret],
      [["gist", "create"], secret],
      [["gist", "create", "-f", "x.md"], secret],
      [["gist", "create", join(gists, "*.md")], ""],
      [["gist", "create", join(dir, "hidden", "*.md")], ""],
      [["gist", "create", ok, "-d", secret], ""],
      [["gist", "edit", "abc", bad], ""],
      [["gist", "edit", "abc", "--add", bad], ""],
      [["gist", "edit", "abc", "-d", secret], ""],
    ] as [string[], string][]) {
      const r = run(argv, stdin);
      expect({ argv, code: r.code, called: r.called }).toEqual({ argv, code: 1, called: null });
      expect(r.err + r.out).not.toContain("QWJK");
    }
  });

  test("close merge release gist: a gist without a value reaches gh unchanged", () => {
    const ok = join(dir, "ok.txt");
    writeFileSync(ok, "hello\n");
    for (const [argv, stdin] of [
      [["gist", "create", ok, "-d", "ok"], ""],
      [["gist", "create"], "print('hi')\n"],
      [["gist", "edit", "abc", "-f", "hello.py", ok], ""],
    ] as [string[], string][]) {
      expect({ argv, r: run(argv, stdin) }).toEqual({ argv, r: { code: 3, out: "from gh\n", err: "", called: { argv, stdin } } });
    }
  });

  test("no gh behind the guard: exit 127", () => {
    const p = Bun.spawnSync([process.execPath, GUARD, "issue", "list"], { env: { PATH: dirname(GUARD) }, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(127);
  });
});

describe("backlog (#2694): in the app's Task an Issue of the workspace is not written with gh", () => {
  const task = { BACKLOG_URL: "http://127.0.0.1:1/api/backlog", GH_REPO: "acme/app" };

  test("an Issue write of the workspace stops before gh: exit 1, and the ops-kit backlog command to use", () => {
    for (const [argv, instead] of [
      [["issue", "edit", "5", "--body", "x"], "edit"],
      [["issue", "comment", "5", "-R", "acme/app", "--body", "x"], "comment"],
      [["issue", "close", "5", "--repo=ACME/App"], "edit --state closed"],
      [["issue", "reopen", "https://github.com/acme/app/issues/5"], "edit --state open"],
      [["issue", "-R", "github.com/acme/app", "create", "-t", "t", "-b", "b"], "create"],
      [["-R", "acme/app", "issue", "edit", "5", "--body", "x"], "edit"],
    ] as const) {
      const r = run([...argv], "", awsConfig, task);
      expect([argv, r.code, r.called]).toEqual([argv, 1, null]);
      expect(r.err).toContain(`acme/app のバックログ（Issue・コメント・ラベル・Project）に直接書きません。ops-kit backlog ${instead} を使ってください`);
    }
  });

  test("another repository's Issue, a pull request, a read and gh api reach gh", () => {
    for (const argv of [
      ["issue", "comment", "5", "-R", "acme/public", "--body", "x"],
      ["issue", "close", "https://github.com/acme/public/issues/5", "--reason", "completed"],
      ["issue", "edit", "--add-label", "bug", "https://github.com/acme/public/issues/5"],
      ["issue", "close", "--", "https://github.com/acme/public/issues/5"],
      ["-R", "acme/public", "issue", "comment", "5", "--body", "x"],
      ["pr", "comment", "5", "--body", "x"],
      ["issue", "view", "5"],
    ]) expect([argv, run(argv, "", awsConfig, task).called?.argv]).toEqual([argv, argv]);
  });

  test("a body that is the URL of another repository's Issue does not name the repository written to", () => {
    expect(run(["issue", "comment", "5", "--body", "https://github.com/acme/public/issues/9"], "", awsConfig, task)).toMatchObject({ code: 1, called: null });
    expect(backlogWrite(["issue", "comment", "5", "-b", "-Racme/public"])).toEqual({ instead: "ops-kit backlog comment", repo: null });
    expect(backlogWrite(["issue", "edit", "5", "--add-label", "https://github.com/acme/public/issues/9"])).toEqual({ instead: "ops-kit backlog edit", repo: null });
  });

  test("without GH_REPO the workspace is the checkout's origin, as ops-kit backlog reads it", () => {
    const repo = mkdtempSync(join(tmpdir(), "ops-kit.gh-guard.origin."));
    try {
      Bun.spawnSync(["git", "init", "-q", repo]);
      Bun.spawnSync(["git", "-C", repo, "remote", "add", "origin", "https://github.com/acme/app.git"]);
      const at = (argv: string[]) => Bun.spawnSync([GUARD, ...argv], { cwd: repo, env: { ...process.env, BACKLOG_URL: task.BACKLOG_URL, GH_REPO: undefined, AWS_CONFIG_FILE: awsConfig, PATH: `${dirname(GUARD)}:${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
      const stopped = at(["issue", "comment", "5", "--body", "x"]);
      expect([stopped.exitCode, stopped.stderr.toString()]).toEqual([1, expect.stringContaining("acme/app のバックログ（Issue・コメント・ラベル・Project）に直接書きません")]);
      expect(at(["issue", "comment", "5", "-R", "acme/public", "--body", "x"]).exitCode).toBe(3);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("without BACKLOG_URL an Issue write reaches gh as before", () => {
    expect(run(["issue", "edit", "5", "--body", "x"], "", awsConfig, { BACKLOG_URL: undefined, GH_REPO: "acme/app" }).called?.argv).toEqual(["issue", "edit", "5", "--body", "x"]);
  });

  describe("#3073: whatever form the write takes", () => {
    const file = (name: string, text: string) => {
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    };
    // each write of the backlog, and the ops-kit command the stop names
    const stops = (): Array<[string[], string]> => [
      [["api", "repos/acme/app/issues", "-f", "title=t"], "ops-kit backlog create"],
      [["api", "-X", "PATCH", "repos/acme/app/issues/5", "-f", "state=closed"], "ops-kit backlog edit"],
      [["api", "repos/acme/app/issues/5/comments", "-f", "body=x"], "ops-kit backlog comment"],
      [["api", "-X", "DELETE", "repos/acme/app/issues/comments/9"], "ops-kit backlog comment（コメントの編集・削除は無いので"],
      [["api", "-X", "POST", "repos/acme/app/issues/5/labels", "-f", "labels[]=bug"], "ops-kit backlog edit --add-label / --remove-label"],
      [["api", "-X", "DELETE", "repos/acme/app/issues/5/labels/bug"], "ops-kit backlog edit --add-label / --remove-label"],
      [["api", "repos/acme/app/labels", "-f", "name=x"], "ops-kit sync-labels"],
      [["api", "--method=patch", "/repos/acme/app/issues/5", "--input", file("patch.json", '{"body":"x"}')], "ops-kit backlog edit"],
      [["api", "-X", "POST", "repos/{owner}/{repo}/issues/5/comments", "-f", "body=x"], "ops-kit backlog comment"],
      [["api", "graphql", "-f", 'query=mutation{addProjectV2ItemById(input:{projectId:"P",contentId:"I"}){item{id}}}'], "ops-kit backlog set / triage"],
      [["api", "graphql", "-f", "query=mutation($p:ID!){updateProjectV2ItemFieldValue(input:{projectId:$p}){clientMutationId}}", "-f", "p=P"], "ops-kit backlog set / triage"],
      [["api", "graphql", "-f", 'query=mutation { addSubIssue(input:{issueId:"A",subIssueId:"B"}) { issue { id } } }'], "ops-kit backlog edit --parent / --no-parent"],
      [["api", "graphql", "--input", file("mutation.json", JSON.stringify({ query: 'mutation { addComment(input:{subjectId:"I",body:"x"}) { clientMutationId } }' }))], "ops-kit backlog comment"],
      [["project", "item-edit", "--id", "x", "--project-id", "y", "--field-id", "z", "--text", "v"], "ops-kit backlog set / triage"],
      [["project", "item-add", "1", "--owner", "acme", "--url", "https://github.com/acme/app/issues/5"], "ops-kit backlog set / triage"],
      [["project", "item-delete", "1", "--owner", "acme", "--id", "x"], "ops-kit backlog set / triage"],
      [["api", "-X", "POST", "repos/acme/app/issues/5/sub_issues", "-F", "sub_issue_id=1"], "ops-kit backlog edit --parent / --no-parent"],
      [["api", "-X", "POST", "repos/:owner/:repo/issues/5/comments", "-f", "body=x"], "ops-kit backlog comment"],
      // #3559: a label's definition, in every form
      [["label", "create", "x", "--color", "fff"], "ops-kit sync-labels"],
      [["label", "edit", "x", "--name", "y", "-R", "acme/app"], "ops-kit sync-labels"],
      [["label", "delete", "x", "--yes"], "ops-kit sync-labels"],
      [["label", "clone", "acme/public", "--repo", "acme/app"], "ops-kit sync-labels"],
      [["api", "graphql", "-f", 'query=mutation{createLabel(input:{repositoryId:"R",name:"x",color:"fff"}){label{id}}}'], "ops-kit sync-labels"],
      [["api", "graphql", "-f", 'query=mutation{updateLabel(input:{id:"L",name:"y"}){label{id}}}'], "ops-kit sync-labels"],
      [["api", "graphql", "-f", 'query=mutation{deleteLabel(input:{id:"L"}){clientMutationId}}'], "ops-kit sync-labels"],
    ];
    // #3559: deleting or moving an Issue, which ops-kit backlog has no command for, in every form
    const removals = (): string[][] => [
      ["issue", "delete", "5", "--yes"],
      ["issue", "delete", "https://github.com/acme/app/issues/5", "--yes"],
      ["issue", "transfer", "5", "acme/public"],
      ["issue", "transfer", "https://github.com/acme/app/issues/5", "acme/public"],
      ["api", "-X", "POST", "repos/acme/app/issues/5/transfer", "-f", "new_owner=acme"],
      ["api", "graphql", "-f", 'query=mutation{transferIssue(input:{issueId:"I",repositoryId:"R"}){issue{id}}}'],
      ["api", "graphql", "-f", 'query=mutation{deleteIssue(input:{issueId:"I"}){clientMutationId}}'],
    ];

    test("gh api's REST, a graphql mutation and gh project item-* on the workspace stop before gh, with the command to use and the one-time way out", () => {
      for (const [argv, instead] of stops()) {
        const r = run(argv, "", awsConfig, task);
        expect([argv, r.code, r.called]).toEqual([argv, 1, null]);
        expect(r.err).toContain("acme/app のバックログ（Issue・コメント・ラベル・Project）に直接書きません。");
        expect(r.err).toContain(instead);
        expect(r.err).toContain("その 1 回だけ env -u BACKLOG_URL gh … で書けます");
        expect(r.err).not.toContain("で書いてよい");
      }
    });

    test("deleting or moving an Issue stops before gh, and says the write is to be made with env -u BACKLOG_URL gh, without the broken-only way out", () => {
      for (const argv of removals()) {
        const r = run(argv, "", awsConfig, task);
        expect([argv, r.code, r.called]).toEqual([argv, 1, null]);
        expect(r.err).toContain("acme/app のバックログ（Issue・コメント・ラベル・Project）に直接書きません。");
        expect(r.err).toContain("その操作は ops-kit backlog に無いので、env -u BACKLOG_URL gh … で書いてよい");
        expect([argv, r.err.includes("壊れている")]).toEqual([argv, false]);
      }
    });

    test("locking and pinning an Issue reach gh in every form (#3559: the app does not sync them)", () => {
      for (const argv of [
        ["issue", "lock", "5", "--reason", "resolved"],
        ["issue", "unlock", "5"],
        ["issue", "pin", "5"],
        ["issue", "unpin", "https://github.com/acme/app/issues/5"],
        ["api", "-X", "PUT", "repos/acme/app/issues/5/lock", "-f", "lock_reason=resolved"],
        ["api", "-X", "DELETE", "repos/acme/app/issues/5/lock"],
        ["api", "graphql", "-f", 'query=mutation{lockLockable(input:{lockableId:"I"}){clientMutationId}}'],
        ["api", "graphql", "-f", 'query=mutation{unlockLockable(input:{lockableId:"I"}){clientMutationId}}'],
        ["api", "graphql", "-f", 'query=mutation{pinIssue(input:{issueId:"I"}){issue{id}}}'],
        ["api", "graphql", "-f", 'query=mutation{unpinIssue(input:{issueId:"I"}){issue{id}}}'],
      ]) expect([argv, run(argv, "", awsConfig, task).called?.argv]).toEqual([argv, argv]);
    });

    test("the repository of a removal is the Issue's, and of a label's definition only -R / --repo", () => {
      expect(backlogWrite(["issue", "transfer", "5", "https://github.com/acme/public/issues/1"])?.repo).toBeNull();
      expect(backlogWrite(["issue", "transfer", "https://github.com/acme/app/issues/5", "acme/public"])?.repo).toBe("acme/app");
      expect(backlogWrite(["label", "clone", "acme/app"])).toEqual({ instead: expect.stringContaining("ops-kit sync-labels"), repo: null });
      // a label's description that starts with -R names no repository (#4051's review)
      for (const flag of ["--description", "-d", "--name", "-n", "--color", "-c"]) expect([flag, backlogWrite(["label", "create", "x", flag, "-Racme/public"])?.repo]).toEqual([flag, null]);
      expect(run(["label", "create", "x", "--description", "-Racme/public"], "", awsConfig, task)).toMatchObject({ code: 1, called: null });
      expect(backlogWrite(["label", "list", "-R", "acme/app"])).toBeNull();
    });

    test("a query, a read, a pull request, git, contents, a release, creating a Project and another repository's Issue reach gh", () => {
      for (const argv of [
        ["api", "graphql", "-f", "query=query{viewer{login}}"],
        ["api", "repos/acme/app/issues/5"],
        ["api", "-X", "GET", "repos/acme/app/issues/comments", "-f", "since=x"],
        ["pr", "comment", "5", "--body", "x"],
        ["api", "-X", "POST", "repos/acme/app/git/refs", "-f", "ref=x", "-f", "sha=y"],
        ["api", "-X", "PUT", "repos/acme/app/contents/a.png", "--input", file("upload.json", '{"content":"eA=="}')],
        ["api", "-X", "POST", "repos/acme/app/releases", "-f", "tag_name=v1"],
        ["api", "-X", "POST", "repos/acme/app/pulls/5/comments", "-f", "body=x"],
        ["api", "graphql", "-f", 'query=mutation{createProjectV2(input:{ownerId:"O",title:"t"}){projectV2{id}}}'],
        ["api", "repos/acme/public/issues/5/comments", "-f", "body=x"],
        ["project", "field-list", "1", "--owner", "acme"],
        ["label", "list"],
        ["label", "create", "x", "-R", "acme/public"],
        ["issue", "delete", "5", "-R", "acme/public", "--yes"],
      ]) expect([argv, run(argv, "", awsConfig, task).called?.argv]).toEqual([argv, argv]);
    });

    test("without BACKLOG_URL every one of them reaches gh", () => {
      for (const argv of [...stops().map(([a]) => a), ...removals()]) expect([argv, run(argv, "", awsConfig, { BACKLOG_URL: undefined, GH_REPO: "acme/app" }).called?.argv]).toEqual([argv, argv]);
    });

    test("the way out: with BACKLOG_URL taken away the write reaches gh, and a secret in it still stops", () => {
      const argv = ["api", "repos/acme/app/issues/5/comments", "-f", "body=x"];
      expect(run(argv, "", awsConfig, { BACKLOG_URL: undefined, GH_REPO: "acme/app" }).called?.argv).toEqual(argv);
      const secretWrite = run(["api", "repos/acme/app/issues/5/comments", "-f", `body=${secret}`], "", awsConfig, { BACKLOG_URL: undefined, GH_REPO: "acme/app" });
      expect([secretWrite.code, secretWrite.called]).toEqual([1, null]);
      expect(secretWrite.err).toContain("投稿を止めました");
    });

    test("backlogWrite names the repository of a REST path, none for {owner}/{repo}, graphql and gh project", () => {
      expect(backlogWrite(["api", "-X", "PATCH", "repos/Acme/App/issues/5", "-f", "state=closed"])?.repo).toBe("Acme/App");
      expect(backlogWrite(["api", "repos/{owner}/{repo}/issues", "-f", "title=t"])?.repo).toBeNull();
      expect(backlogWrite(["api", "graphql", "-f", "query=mutation{closeIssue(input:{issueId:\"I\"}){clientMutationId}}"], ["mutation{closeIssue(input:{issueId:\"I\"}){clientMutationId}}"])).toEqual({ instead: "ops-kit backlog edit --state closed / open", repo: null });
      // the mutation is read from the texts gh-guard read, not from argv: an unread file says nothing
      expect(backlogWrite(["api", "graphql", "--input", "unread.json"], [])).toBeNull();
      expect(backlogWrite(["api", "repos/acme/app/issues/5/comments"])).toBeNull();
    });
  });
});

describe("backlog (#3073): the repositories the app syncs", () => {
  // the fake app runs in its own process: the guard is run with spawnSync, which holds this one's event loop
  let server: ReturnType<typeof Bun.spawn>;
  let port = 0;
  let askedLog: string;
  const asked = () => (existsSync(askedLog) ? readFileSync(askedLog, "utf8").length : 0);
  beforeAll(async () => {
    askedLog = join(dir, "asked.log");
    const syncs = [{ workspaceId: "ws_a", backlog: "github", repository: "acme/app" }, { workspaceId: "ws_o", backlog: "github", repository: "acme/other" }, { workspaceId: "ws_l", backlog: "local", repository: null }];
    const code = `const { appendFileSync } = require("node:fs"); const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { appendFileSync(${JSON.stringify(askedLog)}, "."); return Response.json({ syncs: ${JSON.stringify(syncs)}, items: [] }); } }); console.log(s.port);`;
    server = Bun.spawn([process.execPath, "-e", code], { stdout: "pipe", stderr: "inherit" });
    const reader = (server.stdout as ReadableStream<Uint8Array>).getReader();
    port = Number(new TextDecoder().decode((await reader.read()).value).trim());
    reader.releaseLock();
  });
  afterAll(() => server.kill());
  const task = () => ({ BACKLOG_URL: `http://127.0.0.1:${port}/api/backlog`, BACKLOG_TOKEN_FILE: undefined, GH_REPO: "acme/app" });

  test("a backlog write to another repository the app syncs stops, naming it and its workspace", () => {
    for (const argv of [
      ["issue", "comment", "5", "-R", "acme/other", "--body", "x"],
      ["api", "repos/ACME/Other/issues/5/comments", "-f", "body=x"],
    ]) {
      const r = run(argv, "", awsConfig, task());
      expect([argv, r.code, r.called]).toEqual([argv, 1, null]);
      expect(r.err).toContain(`${argv[0] === "api" ? "ACME/Other" : "acme/other"} のバックログ（Issue・コメント・ラベル・Project）に直接書きません`);
      expect(r.err).toContain("--workspace ws_o");
    }
    // a write ops-kit backlog has no command for names no --workspace
    const labels = run(["api", "repos/acme/other/labels", "-f", "name=x"], "", awsConfig, task());
    expect([labels.code, labels.err.includes("ops-kit sync-labels"), labels.err.includes("--workspace")]).toEqual([1, true, false]);
  });

  test("a repository the app does not know reaches gh; a read and a pull request do not ask the app", () => {
    for (const argv of [
      ["issue", "comment", "5", "-R", "acme/unknown", "--body", "x"],
      ["api", "repos/acme/unknown/issues/5/comments", "-f", "body=x"],
    ]) expect([argv, run(argv, "", awsConfig, task()).called?.argv]).toEqual([argv, argv]);
    const before = asked();
    for (const argv of [["issue", "view", "5", "-R", "acme/other"], ["pr", "comment", "5", "-R", "acme/other", "--body", "x"], ["issue", "edit", "5", "--body", "x"]]) run(argv, "", awsConfig, task());
    expect(asked()).toBe(before);
  });

  test("the app out of reach: the workspace still stops, another repository goes on with one line saying it was not judged", () => {
    const down = { BACKLOG_URL: "http://127.0.0.1:1/api/backlog", BACKLOG_TOKEN_FILE: undefined, GH_REPO: "acme/app" };
    const other = run(["issue", "comment", "5", "-R", "acme/other", "--body", "x"], "", awsConfig, down);
    expect(other.called?.argv).toEqual(["issue", "comment", "5", "-R", "acme/other", "--body", "x"]);
    expect(other.err).toContain("gh-guard: アプリに届かない（か 5 秒で答えない）ので、同期しているほかのリポジトリは判定していません");
    expect(run(["issue", "comment", "5", "--body", "x"], "", awsConfig, down)).toMatchObject({ code: 1, called: null });
  });

  test("without BACKLOG_URL another synced repository and the workspace reach gh", () => {
    for (const argv of [["issue", "comment", "5", "-R", "acme/other", "--body", "x"], ["issue", "comment", "5", "--body", "x"]]) expect(run(argv, "", awsConfig, { ...task(), BACKLOG_URL: undefined }).called?.argv).toEqual(argv);
  });
});

// Synthetic names only (#2466): acme/widget is published, acme/widget-dev is its development repository, someone/widget a fork.
describe("public copy (#2466): a write from a clone that still writes to its public copy stops before gh", () => {
  let tree: string;
  let fake: string;
  let calls: string;
  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), "ops-kit.gh-guard.public."));
    writeFileSync(join(tree, "ops.config.json"), JSON.stringify({ publicSync: { target: "acme/widget" } }));
    mkdirSync(join(tree, "sub"));
    // the gh behind the guard: records every call, answers `repo view` with FAKE_DEFAULT
    fake = join(tree, "bin");
    mkdirSync(fake);
    calls = join(tree, "calls.jsonl");
    writeFileSync(join(fake, "gh"), `#!/usr/bin/env bun\nconst fs = require("node:fs");\nconst argv = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(argv) + "\\n");\nif (argv[0] === "repo" && argv[1] === "view") console.log(process.env.FAKE_DEFAULT ?? "");\n`);
    chmodSync(join(fake, "gh"), 0o755);
  });
  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  function gh(argv: string[], env: Record<string, string | undefined> = {}, cwd = join(tree, "sub")) {
    if (existsSync(calls)) rmSync(calls);
    const p = Bun.spawnSync([GUARD, ...argv], { cwd, env: { ...process.env, BACKLOG_URL: undefined, GH_REPO: undefined, ...env, AWS_CONFIG_FILE: awsConfig, PATH: `${dirname(GUARD)}:${fake}:${process.env.PATH}` }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const called = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
    return { code: p.exitCode, err: p.stderr.toString(), called };
  }
  const VIEW = ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"];
  const WRITES = [
    ["issue", "create", "-t", "x", "-b", "x"],
    ["issue", "comment", "1", "-b", "x"],
    ["issue", "edit", "1", "--add-label", "bug"],
    ["issue", "close", "1"],
    ["pr", "create", "-t", "x", "-b", "x"],
    ["pr", "comment", "1", "-b", "x"],
    ["label", "create", "x"],
    ["api", "-X", "POST", "repos/{owner}/{repo}/issues", "-f", "title=x"],
    ["api", "repos/{owner}/{repo}/issues", "-f", "title=x"],
    ["api", "graphql", "-f", "query=mutation { addComment(input: {}) { clientMutationId } }"],
  ];

  test("the default is the public copy: every write stops, named or not; only repo view reaches gh", () => {
    for (const argv of [...WRITES, ...WRITES.filter((a) => a[0] !== "api").map((a) => [...a, "-R", "acme/widget"]), ["api", "-X", "PATCH", "repos/acme/widget/issues/1", "-f", "state=closed"], ["issue", "close", "https://github.com/acme/widget/issues/1"]]) {
      const r = gh(argv, { FAKE_DEFAULT: "acme/widget" });
      expect([argv, r.code, r.called]).toEqual([argv, 1, [VIEW]]);
      expect(r.err).toContain("gh-guard: 投稿を止めました");
      expect(r.err).toContain("gh repo set-default");
      expect(r.err).toContain("GH_REPO");
    }
  });

  test("the default is the public copy: a write named elsewhere and a read reach gh; a read asks nothing", () => {
    for (const argv of [["issue", "comment", "1", "-R", "someone/widget", "-b", "x"], ["api", "-X", "POST", "repos/someone/widget/issues", "-f", "title=x"]]) {
      expect([argv, gh(argv, { FAKE_DEFAULT: "acme/widget" }).called]).toEqual([argv, [argv]]);
    }
    for (const argv of [["issue", "view", "1"], ["pr", "list"], ["api", "repos/acme/widget/issues"], ["api", "-X", "GET", "repos/acme/widget/issues", "-f", "state=open"], ["api", "graphql", "-f", "query={ viewer { login } }"], ["label", "list"]]) {
      const r = gh(argv, { FAKE_DEFAULT: "acme/widget" });
      expect([argv, r.code, r.called]).toEqual([argv, 0, [argv]]);
    }
  });

  test("the development repository writes to the public copy by name: the sync PR, the reply and the close reach gh", () => {
    for (const argv of [["pr", "create", "-R", "acme/widget", "-t", "x", "-b", "x"], ["issue", "comment", "3", "-R", "acme/widget", "-b", "受け取った"], ["issue", "close", "3", "-R", "acme/widget", "--reason", "completed"]]) {
      expect([argv, gh(argv, { FAKE_DEFAULT: "acme/widget-dev" }).called]).toEqual([argv, [VIEW, argv]]);
    }
  });

  test("GH_REPO: the public copy stops without asking gh; elsewhere, a write not named goes there without asking", () => {
    const stopped = gh(["issue", "comment", "1", "-b", "x"], { GH_REPO: "acme/widget" });
    expect([stopped.code, stopped.called]).toEqual([1, []]);
    expect(gh(["issue", "comment", "1", "-b", "x"], { GH_REPO: "someone/widget", FAKE_DEFAULT: "acme/widget" }).called).toEqual([["issue", "comment", "1", "-b", "x"]]);
  });

  test("GH_REPO elsewhere does not change gh repo view: -R naming the public copy still asks it", () => {
    // a clone as taken (origin = the public copy) with GH_REPO set: `-R "$(gh repo view …)"` names the public copy
    const named = ["issue", "create", "-R", "acme/widget", "-t", "x", "-b", "x"];
    const stopped = gh(named, { GH_REPO: "someone/widget", FAKE_DEFAULT: "acme/widget" });
    expect([stopped.code, stopped.called]).toEqual([1, [VIEW]]);
    const before = gh(["issue", "-R", "acme/widget", "create", "-t", "x", "-b", "x"], { GH_REPO: "someone/widget", FAKE_DEFAULT: "acme/widget" });
    expect([before.code, before.called]).toEqual([1, [VIEW]]);
    expect(stopped.err).toContain("git remote add");
    expect(gh(named, { GH_REPO: "acme/widget-dev", FAKE_DEFAULT: "acme/widget-dev" }).called).toEqual([VIEW, named]);
  });

  test("a tree without publicSync: every write reaches gh without repo view", () => {
    for (const argv of WRITES) expect([argv, gh(argv, { FAKE_DEFAULT: "acme/widget" }, dir).called]).toEqual([argv, [argv]]);
  });

  describe("noWrite: a clone marked ops-kit.noWrite (#2576)", () => {
    let foreign: string;
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: foreign, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
    beforeAll(() => {
      foreign = mkdtempSync(join(tmpdir(), "ops-kit.gh-guard.foreign."));
      git("init", "-q");
      git("remote", "add", "upstream", "https://github.com/someone/widget.git");
      git("config", "--add", "ops-kit.noWrite", "someone/widget");
    });
    afterAll(() => rmSync(foreign, { recursive: true, force: true }));
    const stops = (argv: string[], env: Record<string, string> = {}) => {
      const r = gh(argv, env, foreign);
      expect([argv, r.code, r.called.filter((c) => c[0] !== "repo")]).toEqual([argv, 1, []]);
      expect(r.err).toContain("gh-guard: 投稿を止めました");
      expect(r.err).toContain("ops-kit.noWrite");
    };

    test("noWrite: every write to the default stops", () => {
      for (const argv of WRITES) stops(argv, { FAKE_DEFAULT: "someone/widget" });
    });

    test("noWrite: a write naming nothing stops when gh cannot say the default", () => {
      for (const argv of WRITES) stops(argv, { FAKE_DEFAULT: "" });
    });

    test("noWrite: a write naming the mark stops, even when the default is elsewhere or gh repo view answers nothing", () => {
      for (const argv of [["issue", "create", "-R", "someone/widget", "-t", "x", "-b", "x"], ["issue", "comment", "https://github.com/someone/widget/issues/1", "-b", "x"], ["api", "-X", "POST", "repos/Someone/Widget/issues", "-f", "title=x"]]) {
        stops(argv, { FAKE_DEFAULT: "me/widget" });
        stops(argv, { FAKE_DEFAULT: "" });
      }
      stops(["issue", "comment", "1", "-b", "x"], { GH_REPO: "someone/widget" });
      // a switch (`pr close -d`: delete the branch) takes no value: the -R after it still names the mark (#3717's review)
      stops(["pr", "close", "5", "-d", "-R", "someone/widget"], { GH_REPO: "me/widget", FAKE_DEFAULT: "me/widget" });
    });

    test("noWrite: a write naming nothing reaches gh when the default is elsewhere", () => {
      for (const argv of WRITES) expect([argv, gh(argv, { FAKE_DEFAULT: "me/widget" }, foreign).called]).toEqual([argv, [VIEW, argv]]);
    });

    test("noWrite: gh api with a full URL names the mark too", () => {
      stops(["api", "https://api.github.com/repos/someone/widget/issues/1/comments", "-f", "body=x"], { FAKE_DEFAULT: "me/widget" });
      stops(["api", "-X", "PATCH", "repos/someone/widget?x=1", "-f", "description=x"], { FAKE_DEFAULT: "me/widget" });
    });

    test("noWrite: a write named elsewhere and a read reach gh", () => {
      const own = ["issue", "create", "-R", "me/widget", "-t", "x", "-b", "x"];
      expect(gh(own, { FAKE_DEFAULT: "someone/widget" }, foreign).called).toEqual([own]);
      for (const argv of [["issue", "view", "1"], ["pr", "list"], ["api", "repos/someone/widget/issues"]]) expect(gh(argv, { FAKE_DEFAULT: "someone/widget" }, foreign).called).toEqual([argv]);
    });

    test("noWrite: the mark is on the clone; the same write from an unmarked tree reaches gh", () => {
      const argv = ["issue", "create", "-R", "someone/widget", "-t", "x", "-b", "x"];
      expect(gh(argv, { FAKE_DEFAULT: "someone/widget" }, dir).called).toEqual([argv]);
    });
  });

  test("writeTargetOf: the named repository, GH_REPO, or null; null for a read", () => {
    expect(writeTargetOf(["-R", "acme/widget", "issue", "comment", "1", "-b", "x"], {})).toEqual({ repo: "acme/widget" });
    expect(writeTargetOf(["issue", "comment", "1", "--repo=acme/widget"], { GH_REPO: "x/y" })).toEqual({ repo: "acme/widget" });
    expect(writeTargetOf(["issue", "-R", "acme/widget", "create", "-t", "x"], { GH_REPO: "x/y" })).toEqual({ repo: "acme/widget" });
    expect(writeTargetOf(["pr", "--repo=acme/widget", "comment", "1", "-b", "x"], {})).toEqual({ repo: "acme/widget" });
    expect(writeTargetOf(["pr", "merge", "https://github.com/acme/widget/pull/4"], {})).toEqual({ repo: "acme/widget" });
    expect(writeTargetOf(["issue", "edit", "1", "-b", "https://github.com/acme/widget/issues/9"], {})).toEqual({ repo: null });
    expect(writeTargetOf(["release", "create", "v1"], { GH_REPO: "acme/widget" })).toEqual({ repo: "acme/widget" });
    expect(writeTargetOf(["api", "--method=DELETE", "/repos/acme/widget/labels/x"], {})).toEqual({ repo: "acme/widget" });
    expect(writeTargetOf(["api", "graphql", "-F", "query=@q.graphql"], {})).toEqual({ repo: null });
    expect(writeTargetOf(["api", "repos/{owner}/{repo}/issues", "-f", "title=x"], { GH_REPO: "someone/widget" })).toEqual({ repo: "someone/widget" });
    for (const argv of [["issue", "list"], ["pr", "checks", "1"], ["release", "download", "v1"], ["api", "repos/acme/widget"], ["api", "-XHEAD", "repos/acme/widget"], ["repo", "view"], ["issue"], []]) {
      expect([argv, writeTargetOf(argv, {})]).toEqual([argv, null]);
    }
  });
});

describe("merge: no judgement in front of gh (2026-11-02, the user allows a merge outside merge-gate)", () => {
  test("gh pr merge and gh stack merge reach gh unchanged, with or without mergeGate in ops.config.json", () => {
    const tree = mkdtempSync(join(tmpdir(), "ops-kit.gh-guard.merge."));
    try {
      const fake = join(tree, "bin");
      mkdirSync(fake);
      const calls = join(tree, "calls.jsonl");
      writeFileSync(join(fake, "gh"), `#!/usr/bin/env bun\nrequire("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
      chmodSync(join(fake, "gh"), 0o755);
      // the guard no longer reads mergeGate
      writeFileSync(join(tree, "ops.config.json"), JSON.stringify({ mergeGate: { command: ["false"] } }));
      const argvs = [["pr", "merge", "12", "--rebase"], ["stack", "merge", "12", "--rebase", "-y"]];
      for (const argv of argvs) {
        const p = Bun.spawnSync([GUARD, ...argv], { cwd: tree, env: { ...process.env, BACKLOG_URL: undefined, GH_REPO: undefined, AWS_CONFIG_FILE: awsConfig, PATH: `${dirname(GUARD)}:${fake}:${process.env.PATH}` }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        expect(p.exitCode).toBe(0);
      }
      expect(readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual(argvs);
    } finally {
      rmSync(tree, { recursive: true, force: true });
    }
  });
});

describe("the forms gh accepts", () => {
  test("the alias new, a flag before the subcommand, a value attached to its flag, a body that starts like a flag", () => {
    for (const argv of [
      ["issue", "new", "-b", secret],
      ["pr", "new", "--title", "題", "--body", secret],
      ["issue", "-R", "o/r", "comment", "1", "--body", secret],
      ["issue", "--label", "bug", "create", "--body", secret],
      ["issue", "comment", "1", `-b=${secret}`],
      ["issue", "comment", "1", `-b${secret}`],
      ["api", "repos/o/r/issues/1/comments", `-fbody=${secret}`],
      ["api", "repos/o/r/issues/1/comments", `--raw-field=body=${secret}`],
      ["issue", "comment", "1", "--body", `--note=${secret}`],
      ["pr", "review", "1", "-cb", secret],
      ["pr", "create", "-db", secret, "-t", "x"],
      ["pr", "create", "-eb", secret, "-t", "x"],
      ["api", "repos/o/r/issues/1/comments", "-if", `body=${secret}`],
      // the value of a flag this guard does not list is not read as more flags
      ["pr", "create", "-Hfeat", "--body", secret],
      ["pr", "create", "-Bdevelopment", "-b", secret],
      ["issue", "create", "-lb", "-b", secret],
    ]) {
      expect({ argv, r: run(argv) }).toMatchObject({ argv, r: { code: 1, called: null } });
    }
  }, 30_000); // time assumption (the flake of #2939): a bun process per form, over the 5 s default under load (5039 ms failed; docs/design/perf.md "テストの揺れ")

  test("a body sent as JSON is read string by string, with its own line breaks", () => {
    const file = join(dir, "input.json");
    writeFileSync(file, JSON.stringify({ body: `device code:\n${code}`, labels: ["x"] }));
    const r = run(["api", "repos/o/r/issues", "--input", file]);
    expect(r).toMatchObject({ code: 1, called: null });
    expect(r.err).toContain("device-code、2 行目");
  });

  test("a file that cannot be read does not drop the check of the other texts", () => {
    expect(run(["issue", "create", "--title", "x", "--body", secret, "--body-file", join(dir, "none.md")])).toMatchObject({ code: 1, called: null });
  });

  test("the standard input reaches gh byte for byte", () => {
    if (existsSync(log)) rmSync(log);
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0x61]);
    const raw = join(dir, "raw.bin");
    writeFileSync(join(dir, "gh-bytes"), `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(raw)}, await Bun.stdin.bytes());\n`);
    chmodSync(join(dir, "gh-bytes"), 0o755);
    const bin = join(dir, "bytes");
    mkdirSync(bin, { recursive: true });
    copyFileSync(join(dir, "gh-bytes"), join(bin, "gh"));
    chmodSync(join(bin, "gh"), 0o755);
    const p = Bun.spawnSync([GUARD, "api", "x", "--input", "-"], { env: { ...process.env, PATH: `${dirname(GUARD)}:${bin}:${process.env.PATH}` }, stdin: bytes, stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(0);
    expect([...readFileSync(raw)]).toEqual([...bytes]);
  });

  test("a body file that is a pipe is read once and handed on as a file with the same text", () => {
    const p = Bun.spawnSync(["bash", "-c", `"$0" issue comment 1 --body-file <(printf 'hello body\\n'); echo "exit=$?"`, GUARD], { env: { ...process.env, BACKLOG_URL: undefined, PATH: `${dirname(GUARD)}:${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(p.stdout.toString()).toContain("exit=3");
    const called = JSON.parse(readFileSync(log, "utf8")) as { argv: string[] };
    expect(called.argv.slice(0, 4)).toEqual(["issue", "comment", "1", "--body-file"]);
    expect(called.argv[4]).not.toMatch(/^\/dev\/fd\//);
    // the copy is gone once gh has returned
    expect(existsSync(called.argv[4]!)).toBe(false);
    const stopped = Bun.spawnSync(["bash", "-c", `"$0" issue comment 1 --body-file <(printf '%s\\n' "$1"); echo "exit=$?"`, GUARD, secret], { env: { ...process.env, BACKLOG_URL: undefined, PATH: `${dirname(GUARD)}:${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(stopped.stdout.toString()).toContain("exit=1");
  });

  test("two checkouts' guards in one PATH: the second is skipped, gh is reached", () => {
    const other = join(dir, "other-kit");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "gh"), readFileSync(GUARD, "utf8"));
    chmodSync(join(other, "gh"), 0o755);
    if (existsSync(log)) rmSync(log);
    const p = Bun.spawnSync([GUARD, "issue", "list"], { env: { ...process.env, PATH: `${dirname(GUARD)}:${other}:${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    expect(p.exitCode).toBe(3);
    expect(realCommand("gh", `${dirname(GUARD)}:${other}:${dir}`, GUARD, GUARD_MARK)).toBe(join(dir, "gh"));
  });
});

describe("bodiesOf / realCommand", () => {
  test("the texts of a write; null for what is let through unread", () => {
    const read = (p: string) => (p === "-" ? "in" : p === "none.md" ? null : `file:${p}`);
    const texts = (argv: string[]) => bodiesOf(argv, read)?.map((r) => r.text) ?? null;
    expect(texts(["issue", "create", "-t", "題", "--body-file", "b.md"])).toEqual(["題", "file:b.md"]);
    expect(texts(["issue", "create", "-t", "題", "--body-file", "none.md"])).toEqual(["題"]);
    expect(texts(["api", "x", "-f", "body=a=b", "-F", "n=1", "--field", "t=@-", "-H", "Accept: x", "--jq", ".id"])).toEqual(["a=b", "1", "in"]);
    expect(bodiesOf(["api", "x", "-F", "body=@b.md"], read)).toEqual([{ text: "file:b.md", from: { index: 3, path: "b.md", prefix: "body=@" } }]);
    expect(bodiesOf(["api", "x", "-Fbody=@b.md"], read)).toEqual([{ text: "file:b.md", from: { index: 2, path: "b.md", prefix: "-Fbody=@" } }]);
    expect(texts(["issue", "close", "1", "--comment", "x"])).toEqual(["x"]);
    // one letter means another thing in another subcommand
    expect(texts(["pr", "review", "1", "-c", "-b", "x"])).toEqual(["x"]);
    expect(texts(["pr", "close", "1", "-c", "x"])).toEqual(["x"]);
    expect(texts(["pr", "merge", "1", "-t", "題", "--match-head-commit", "abc", "-A", "a@b"])).toEqual(["題"]);
    expect(texts(["release", "create", "v1", "--notes-start-tag", "v0", "--target", "main", "--generate-notes"])).toBeNull();
    expect(texts(["release", "view", "v1", "-t", "{{.}}"])).toBeNull();
    // the subcommand is found as gh finds it: a name in the value of a flag before it is not the subcommand
    expect(texts(["issue", "--body", "close", "create", "--title", "x"])).toEqual(["close", "x"]);
    expect(texts(["pr", "--body", "close", "merge", "1", "--subject", "x"])).toEqual(["close", "x"]);
    expect(texts(["issue", "list", "--search", "comment", "-t", "x"])).toBeNull();
    // the files of a gist: every argument after create, the one after the id for edit; the standard input only when piped
    expect(texts(["gist", "create", "-p", "a.md", "b.md", "-d", "説明"])).toEqual(["file:a.md", "file:b.md", "説明"]);
    expect(texts(["gist", "edit", "abc", "-r", "x.md", "-f", "y.md", "c.md"])).toEqual(["file:c.md"]);
    expect(texts(["gist", "edit", "abc", "-r", "x.md"])).toBeNull();
    // after `--` an argument that starts with `-` is a file
    expect(texts(["gist", "edit", "abc", "--", "-secret.md"])).toEqual(["file:-secret.md"]);
    expect(texts(["gist", "create", "-d", "x", "--", "-a.md", "--b.md"])).toEqual(["x", "file:-a.md", "file:--b.md"]);
    expect(bodiesOf(["gist", "create"], read, true)).toEqual([{ text: "in" }]);
    expect(bodiesOf(["gist", "create"], read)).toBeNull();
    expect(bodiesOf(["gist", "create", "a.md"], read, true)).toEqual([{ text: "file:a.md", from: { index: 2, path: "a.md", prefix: "" } }]);
    expect(texts(["gist", "list"])).toBeNull();
    expect(texts(["issue", "list", "--search", "x", "-t", "{{.}}"])).toBeNull();
    expect(texts(["repo", "view"])).toBeNull();
    expect(texts([])).toBeNull();
  });

  test("realCommand skips the guard and what cannot be run", () => {
    expect(realCommand("gh", `${dirname(GUARD)}:${dir}`, GUARD, GUARD_MARK)).toBe(join(dir, "gh"));
    expect(realCommand("gh", `${dirname(GUARD)}::/nonexistent`, GUARD, GUARD_MARK)).toBeNull();
  });
});
