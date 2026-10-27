import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bodiesOf, GUARD_MARK, realCommand } from "./gh-guard.ts";

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

function run(argv: string[], stdin = "", awsConfigFile = awsConfig) {
  if (existsSync(log)) rmSync(log);
  const p = Bun.spawnSync([GUARD, ...argv], { env: { ...process.env, AWS_CONFIG_FILE: awsConfigFile, PATH: `${dirname(GUARD)}:${dir}:${process.env.PATH}` }, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
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
  });

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
    const p = Bun.spawnSync(["bash", "-c", `"$0" issue comment 1 --body-file <(printf 'hello body\\n'); echo "exit=$?"`, GUARD], { env: { ...process.env, PATH: `${dirname(GUARD)}:${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
    expect(p.stdout.toString()).toContain("exit=3");
    const called = JSON.parse(readFileSync(log, "utf8")) as { argv: string[] };
    expect(called.argv.slice(0, 4)).toEqual(["issue", "comment", "1", "--body-file"]);
    expect(called.argv[4]).not.toMatch(/^\/dev\/fd\//);
    // the copy is gone once gh has returned
    expect(existsSync(called.argv[4]!)).toBe(false);
    const stopped = Bun.spawnSync(["bash", "-c", `"$0" issue comment 1 --body-file <(printf '%s\\n' "$1"); echo "exit=$?"`, GUARD, secret], { env: { ...process.env, PATH: `${dirname(GUARD)}:${dir}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
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
