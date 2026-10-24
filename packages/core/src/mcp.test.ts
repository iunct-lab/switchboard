import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentEvent, RunnerAdapter, RunnerSession, StartOptions } from "@switchboard/protocol";
import { loadConfig } from "./config.ts";
import { absolutePathEntries, classifyCommand, DEFAULT_POLICY, loadMcpPolicy, mcpServersFor, minimalEnv, osResolve, parseArgv, safeRealpath, safeRegExp, Scope, resolveCommand } from "./mcp.ts";
import { startServer } from "./server.ts";

// Test daemons must not read the developer's real ~/.claude/projects (#91): point the importer at a folder that does not exist.
const NO_HISTORY = { SWITCHBOARD_CLAUDE_PROJECTS: join(tmpdir(), "switchboard-test-no-claude-projects"), SWITCHBOARD_HISTORY_POLL_MS: "0" };

/** A runner that just stays alive (like DAK running in a container) so the task keeps a live session. */
function idleAdapter(): RunnerAdapter {
  return {
    id: "claude",
    async detect() {
      return { available: true };
    },
    start(_o: StartOptions, emit) {
      let done!: (c: number | null) => void;
      const exited = new Promise<number | null>((r) => (done = r));
      queueMicrotask(() => emit({ t: "session.start", runner: "claude", runnerSessionId: "s", cwd: "/" }));
      const s: RunnerSession = { send: () => undefined, respondPermission: () => undefined, abort: async () => done(null), close: async () => done(0), exited };
      return s;
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const j = (r: Response) => r.json() as Promise<any>;
let home: string;
let repo: string;
let outside: string;
let core: Awaited<ReturnType<typeof startServer>>;
let base: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "sb-mcp-"));
  repo = join(home, "repo");
  outside = join(home, "outside");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const answer = 42;\nconst b = 1;\n");
  writeFileSync(join(repo, "README.md"), "# repo\n");
  writeFileSync(join(outside, "secret.txt"), "top secret\n");
  symlinkSync(outside, join(repo, "link-out"));
});
afterAll(async () => {
  await core?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("scope + exec policy (pure)", () => {
  test("Scope resolves inside the roots and rejects escapes, including through symlinks", () => {
    const s = new Scope([repo]);
    expect(s.resolve("src/a.ts").endsWith("/repo/src/a.ts")).toBe(true);
    expect(() => s.resolve("../outside/secret.txt")).toThrow(/outside the task scope/);
    expect(() => s.resolve(join(outside, "secret.txt"))).toThrow(/outside/);
    expect(() => s.resolve("link-out/secret.txt")).toThrow(/outside/);
    expect(() => s.resolve("does/not/exist.txt")).not.toThrow(); // non-existent but inside is fine (for future writes)
  });

  test("classifyCommand: only a plain argv of an allow-listed binary without write/exec flags and with in-scope paths is read-only", () => {
    const p = DEFAULT_POLICY.exec;
    const s = new Scope([repo]);
    const v = (c: string) => classifyCommand(c, p, s).verdict;
    expect(v("ls -la src")).toBe("read-only");
    expect(v("cat README.md")).toBe("read-only");
    expect(v("git status")).toBe("read-only");
    expect(v("git log --oneline -5")).toBe("read-only");
    expect(v(`grep -n "hello world" src/a.ts`)).toBe("read-only");
    expect(classifyCommand(`grep -n "hello world" src/a.ts`, p, s).argv).toEqual(["grep", "-n", "hello world", "src/a.ts"]);
    // shell syntax of any kind → approval
    for (const c of ["cat a > b", "ls; rm -rf /", "ls & rm -rf .", "ls\nrm -rf .", "cat $(echo x)", "cat `echo x`", "cat <(echo x)", "ls | tee x", "ls && rm x", "ls || rm x", "echo ${HOME}", "{ ls; }", "(ls)"]) expect(v(c)).toBe("needs-approval");
    // binaries that write or execute through flags, or are not listed
    for (const c of ["find . -exec rm {} \\;", "find . -delete", "find . -fprint out.txt", "sort -o x src/a.ts", "sort --output=x src/a.ts", "git -c core.pager=x log", "git -C /tmp status", "git log --output=/tmp/x", "git branch -D main", "git tag v1", "git remote set-url origin x", "git push", "env cat x", "sed -i s/a/b/ src/a.ts", "awk 'BEGIN{system(\"id\")}'", "xargs rm", "touch x", "FOO=bar ls", ""]) expect(v(c)).toBe("needs-approval");
    // paths outside the scope (absolute, ~, ..) need approval even for cat
    expect(v("cat /etc/passwd")).toBe("needs-approval");
    expect(v("cat ~/.switchboard/token")).toBe("needs-approval");
    expect(v("cat ../outside/secret.txt")).toBe("needs-approval");
    expect(v(`cat ${join(repo, "README.md")}`)).toBe("read-only");
    expect(v("cat link-out/secret.txt")).toBe("needs-approval");
    // the shipped mcp.yaml is what the daemon loads: it must classify the same way
    const shipped = loadMcpPolicy([join(import.meta.dir, "..", "config", "mcp.yaml")]);
    expect(shipped.exec.readOnly).not.toContain("env");
    expect(shipped.exec.readOnly).not.toContain("sed");
    expect(shipped.exec.readOnly).not.toContain("awk");
    expect(shipped.exec.gitReadOnly).not.toContain("branch");
    for (const c of ["find . -exec rm {} \\;", "git branch -D main", "sort -o x y", "cat /etc/passwd"]) expect(classifyCommand(c, shipped.exec, s).verdict).toBe("needs-approval");
    expect(classifyCommand("find src -name *.ts", shipped.exec, s).verdict).toBe("read-only");
  });

  for (const command of [
    "rg --pre sh foo", "rg --pre=sh foo", "rg --pre-glob=*.txt foo",
    "sort --compress-program=sh input", "tree -o output", "uniq input output",
    "uniq -- input -output", "./cat README.md", "/tmp/x/ls",
    "file -C", "file --compile", "file -m magic input", "file --magic-file=magic input",
    "sort -uo output input", "sort -ooutput input", "tree -ao output", "file -zC",
    "sort --compress-prog=sh input", "sort --outp=x input", "file --mag=m input",
    "sort -o./output input", "sort -o/tmp/output input", "sort -uo./output input", "tree -Lo 1 out.txt",
  ]) {
    test(`classifyCommand requires approval: ${command}`, () => {
      for (const policy of [DEFAULT_POLICY, loadMcpPolicy([join(import.meta.dir, "..", "config", "mcp.yaml")])]) {
        expect(classifyCommand(command, policy.exec, new Scope([repo])).verdict).toBe("needs-approval");
      }
    });
  }

  test("classifyCommand: a path riding in an option is checked like an operand, and `--` is not trusted to end the options (#2021)", () => {
    const s = new Scope([repo]);
    for (const policy of [DEFAULT_POLICY, loadMcpPolicy([join(import.meta.dir, "..", "config", "mcp.yaml")])]) {
      const v = (c: string) => ({ c, v: classifyCommand(c, policy.exec, s).verdict });
      for (const c of [
        "diff --from-file=/etc/hosts README.md", "diff --to-file=../outside/secret.txt README.md", "grep -f/etc/hosts README.md",
        "grep -rnf/etc/hosts src", "grep --file=~/.switchboard/token README.md", "git blame --contents=/etc/hosts README.md",
        "sort -T/tmp/x README.md", "grep -flink-out/secret.txt README.md",
        "diff -I -- --from-file=/etc/hosts README.md", // `-I` takes `--` as its value: the next word is still an option
      ]) expect(v(c)).toEqual({ c, v: "needs-approval" });
      for (const c of [
        "grep --color=never -n answer src/a.ts", "git log --format=%H -3", "sort -t. -k2 README.md",
        "diff --from-file=README.md src/a.ts", "grep -fREADME.md src/a.ts", "cat -- README.md", "cat - README.md",
      ]) expect(v(c)).toEqual({ c, v: "read-only" });
    }
    // a word starting with `-` after `--` names a file: a symlink of that name leading outside asks (and a denied flag
    // after `--` still asks, as a file named like it: the safe side)
    const link = join(repo, "-secret-link");
    symlinkSync(join(outside, "secret.txt"), link);
    try {
      expect(classifyCommand("cat -- -secret-link", DEFAULT_POLICY.exec, s).verdict).toBe("needs-approval");
      expect(classifyCommand("sort -- -o", DEFAULT_POLICY.exec, s).verdict).toBe("needs-approval");
    } finally {
      rmSync(link);
    }
  });

  test("classifyCommand: relative words resolve from the cwd the command runs in, and options that read a list of file names ask (#2024)", () => {
    const s = new Scope([repo]);
    mkdirSync(join(repo, "sub"), { recursive: true });
    const link = join(repo, "sub", "link");
    symlinkSync(join(outside, "secret.txt"), link);
    try {
      for (const policy of [DEFAULT_POLICY, loadMcpPolicy([join(import.meta.dir, "..", "config", "mcp.yaml")])]) {
        expect(classifyCommand("cat link", policy.exec, s).verdict).toBe("read-only"); // from the root there is no such file
        expect(classifyCommand("cat link", policy.exec, s, join(repo, "sub")).verdict).toBe("needs-approval");
        expect(classifyCommand("grep -flink README.md", policy.exec, s, join(repo, "sub")).verdict).toBe("needs-approval");
        expect(classifyCommand("cat ../README.md", policy.exec, s, join(repo, "sub")).verdict).toBe("read-only");
        for (const c of ["sort --files0-from=list.txt", "sort --files0=list.txt", "wc --files0-from=list.txt", "du --files0-from=list.txt", "find . -files0-from list.txt", "file -f list.txt", "file --files-from=list.txt", "file -bf list.txt"]) {
          expect({ c, v: classifyCommand(c, policy.exec, s).verdict }).toEqual({ c, v: "needs-approval" });
        }
      }
    } finally {
      rmSync(join(repo, "sub"), { recursive: true, force: true }); // other tests list the repo root exactly
    }
  });

  test("classifyCommand: `..` after a symlink is read the way the OS opens it, recursion that follows symlinks asks, jq is not read-only (#2031)", () => {
    const s = new Scope([repo]);
    // link-out leads to outside: the OS opens link-out/../outside/secret.txt as outside/secret.txt; the spelling says repo/outside/…
    expect(osResolve(`${repo}/link-out/../outside/secret.txt`)).toBe(join(realpathSync(outside), "secret.txt"));
    expect(osResolve(`${repo}/src/../README.md`)).toBe(join(realpathSync(repo), "README.md"));
    // a missing component: the OS cannot pass through it, the rest is joined as spelled
    expect(osResolve(`${repo}/nope/../README.md`)).toBe(join(realpathSync(repo), "README.md"));
    // a relative target is read from the link's own folder; a loop ends (the OS gives up as well)
    symlinkSync("../outside", join(repo, "rel-link"));
    symlinkSync("loop-b", join(repo, "loop-a"));
    symlinkSync("loop-a", join(repo, "loop-b"));
    // diff on a directory reached through `..` after a symlink: the spelling names no directory, the OS opens src/inner
    mkdirSync(join(repo, "src", "inner"), { recursive: true });
    symlinkSync("src/inner", join(repo, "deep"));
    try {
      expect(osResolve(`${repo}/rel-link/secret.txt`)).toBe(join(realpathSync(outside), "secret.txt"));
      expect(typeof osResolve(`${repo}/loop-a/x`)).toBe("string");
      expect(classifyCommand("diff deep/../inner README.md", DEFAULT_POLICY.exec, s).verdict).toBe("needs-approval");
    } finally {
      for (const n of ["rel-link", "loop-a", "loop-b", "deep"]) rmSync(join(repo, n)); // other tests list the repo root exactly
      rmSync(join(repo, "src", "inner"), { recursive: true, force: true });
    }
    for (const policy of [DEFAULT_POLICY, loadMcpPolicy([join(import.meta.dir, "..", "config", "mcp.yaml")])]) {
      const v = (c: string) => ({ c, v: classifyCommand(c, policy.exec, s).verdict });
      for (const c of [
        "cat link-out/../outside/secret.txt", "grep -R secret .", "grep --dereference-recursive secret .", "grep -Rn secret .",
        "rg -L secret", "rg --follow secret", "find -L . -name secret.txt", "find . -follow -name secret.txt", "ls -lL .",
        "du -L .", "du --dereference .", "tree -l", "diff -r src src", "diff --recursive src src", "diff -ru src src", "jq . README.md", "tree -al",
        // a program run or a write: rg's hostname program, tree's per-directory HTML command, sort's temporary files
        "rg --hostname-bin=uname -H x README.md", "tree -R", "tree -H . -L 1 -R", "sort -T src README.md", "sort --temporary-directory=src README.md",
        // diff on a directory compares the files inside it through their symlinks, without -r too, also as an option's value
        "diff src src", "diff src README.md", "diff --from-file=src README.md",
        // decompressors and git's manual viewer are programs too; date can set the clock
        "rg -z x README.md", "rg --search-zip x README.md", "file -z README.md", "file -Z README.md", "file --uncompress README.md",
        "git log --help", "date", "date +%Y",
        // git's subcommand is the first argument: a global option can take the next word as its value
        "git --namespace status config --local probe.x 1", "git --no-pager log", "git -P status",
        // gpg through a signature check or a %G placeholder; diff's paginator; BSD grep's symlink-following -S
        "git log --show-signature -1", "git log --format=%G? -1", "git show --pretty=format:%GK HEAD", "git log --format=%+G? -1", "git log --format=%-GK -1", "git show --pretty=format:%\\ GS HEAD", "diff -l README.md README.md", "diff --paginate README.md README.md", "grep -rS x .",
        // BSD ls takes no value for -w/-T/-I, so a bundled L after them still counts
        "ls -wRL .", "ls -TRL .",
      ]) expect(v(c)).toEqual({ c, v: "needs-approval" });
      // a value attached to a short option is not read as more flags: -d1, -U3, -Iretry, -w80, -fREADME.md
      for (const c of ["cat src/../README.md", "grep -rn answer src", "rg answer", "find . -name a.ts", "ls -la src", "du -sh .", "tree -L 1", "diff -u README.md README.md", "du -d1 .", "diff -U3 README.md README.md", "diff -Iretry README.md README.md", "ls -w80 src", "grep -fREADME.md src/a.ts",
        // git's subcommand options that share a letter with a global option are not asked about
        "git diff -C HEAD", "git log -c", "git ls-files -o", "git rev-parse --git-dir"]) {
        expect(v(c)).toEqual({ c, v: "read-only" });
      }
    }
  });

  test("resolveCommand: only absolute PATH entries, and a program inside the task scope needs the user", () => {
    const own = mkdtempSync(join(tmpdir(), "mcp-resolve."));
    try {
      const bin = join(own, "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "cat"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
      const s = new Scope([own]);
      expect(resolveCommand("cat", `${bin}:/usr/bin:/bin`, s)).toEqual({ reason: "the command resolves inside the task scope" });
      expect(absolutePathEntries(".:bin::/usr/bin:relative/x:/bin")).toBe("/usr/bin:/bin");
      // a relative entry that would reach the planted cat (resolved from "/") must not count
      const relativeToRoot = realpathSync(bin).slice(1);
      const viaRelative = resolveCommand("cat", `${relativeToRoot}:/usr/bin:/bin`, s);
      expect("exe" in viaRelative && !viaRelative.exe.startsWith(realpathSync(own))).toBe(true);
      expect(resolveCommand("no-such-command-1942", "/usr/bin:/bin", s)).toEqual({ missing: "command not found: no-such-command-1942" });
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  test("ordinary read-only commands remain allowed", () => {
    for (const command of ["cat README.md", "rg foo", "git log", "uniq input", "uniq -c input", "sort -u input", "sort -k2 input", "tree -a", "sort -to input", "sort -k2o input", "git log -Sfoo"]) {
      expect(classifyCommand(command, DEFAULT_POLICY.exec, new Scope([repo])).verdict).toBe("read-only");
    }
    expect(classifyCommand("./cat", DEFAULT_POLICY.exec).reason).toBe("a path as the command");
  });

  test("argv parsing handles quotes and escapes; unterminated quotes are refused", () => {
    expect(parseArgv(`echo 'a b' "c d" e\\ f`)).toEqual(["echo", "a b", "c d", "e f"]);
    expect(parseArgv(`echo "unterminated`)).toBeNull();
    expect(parseArgv("ls\nrm")).toBeNull();
  });

  test("safeRegExp refuses nested quantifiers and long patterns", () => {
    expect(() => safeRegExp("(a+)+$")).toThrow(/nested/);
    expect(() => safeRegExp("(.*)*")).toThrow(/nested/);
    expect(() => safeRegExp("a".repeat(201))).toThrow(/too long/);
    expect(safeRegExp("answer|x+").test("the answer")).toBe(true);
  });

  test("safeRealpath keeps the first segment under /", () => {
    expect(safeRealpath("/nonexistent-dir-xyz/file")).toBe("/nonexistent-dir-xyz/file");
  });

  test("minimalEnv carries no daemon or runner secrets", () => {
    process.env.SWITCHBOARD_SECRET_TEST = "leak";
    const env = minimalEnv("/tmp");
    delete process.env.SWITCHBOARD_SECRET_TEST;
    expect(Object.keys(env).sort()).toEqual(["GIT_NO_LAZY_FETCH", "GIT_OPTIONAL_LOCKS", "HOME", "LANG", "PATH", "PWD", "TERM", "TMPDIR", ...(process.env.LC_ALL ? ["LC_ALL"] : [])].sort());
    // no relative PATH entry (a program the task put in its folder), and no place for temporary files (#2031)
    const path = process.env.PATH;
    process.env.PATH = `.:node_modules/.bin:${path ?? "/usr/bin:/bin"}`;
    try {
      expect(minimalEnv("/tmp").PATH!.split(":").every((p) => p.startsWith("/"))).toBe(true);
    } finally {
      process.env.PATH = path;
    }
    expect(existsSync(env.TMPDIR!)).toBe(false);
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(env.GIT_NO_LAZY_FETCH).toBe("1");
    // git looks for a repository only inside the scope: the folder above each root is a ceiling
    expect(new Scope([repo, outside]).gitCeilings).toBe([dirname(realpathSync(repo)), dirname(realpathSync(outside))].join(":"));
  });

  test("a folder above a root with ':' in its name is no ceiling git keeps (it splits there), so git asks in that scope (#2002)", () => {
    const colon = join(home, "a:b", "root");
    mkdirSync(colon, { recursive: true });
    const p = DEFAULT_POLICY.exec;
    expect(new Scope([colon]).gitCeilingsHold).toBe(false);
    expect(classifyCommand("git status", p, new Scope([colon]))).toMatchObject({ verdict: "needs-approval", reason: expect.stringContaining("':'") });
    expect(classifyCommand("git status", p, new Scope([repo, colon])).verdict).toBe("needs-approval");
    expect(classifyCommand("ls", p, new Scope([colon])).verdict).toBe("read-only"); // only git looks above
    expect(new Scope([repo]).gitCeilingsHold).toBe(true);
  });
});

describe("servers a Task gets (#2090)", () => {
  test("mcpServersFor: without workspaces every Task, with workspaces only the named ones, never to a Task without a Workspace", () => {
    const playwright = { command: "npx", args: ["@playwright/mcp@latest", "--headless"] };
    const docs = { type: "http" as const, url: "http://127.0.0.1:9000/mcp" };
    const policy = { ...DEFAULT_POLICY, servers: { playwright: { ...playwright, workspaces: ["switchboard"] }, docs } };
    expect(mcpServersFor(policy, "switchboard")).toEqual({ playwright, docs });
    expect(mcpServersFor(policy, "dak")).toEqual({ docs });
    expect(mcpServersFor(policy, null)).toEqual({ docs });
    expect(mcpServersFor(DEFAULT_POLICY, "switchboard")).toEqual({});
  });

  test("loadMcpPolicy reads servers as written; the shipped mcp.yaml hands none", () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard-test-mcp-servers-"));
    try {
      const file = join(dir, "mcp.yaml");
      writeFileSync(file, "version: 1\nservers:\n  playwright:\n    command: npx\n    args: [\"@playwright/mcp@latest\", \"--headless\"]\n    workspaces: [switchboard]\n");
      expect(loadMcpPolicy([file]).servers).toEqual({ playwright: { command: "npx", args: ["@playwright/mcp@latest", "--headless"], workspaces: ["switchboard"] } });
      expect(loadMcpPolicy([join(import.meta.dir, "..", "config", "mcp.yaml")]).servers).toEqual({});
      expect(loadMcpPolicy([join(dir, "missing.yaml")]).servers).toEqual({});
      // an entry of the wrong shape is left out; the rest still load
      writeFileSync(file, "version: 1\nservers:\n  empty:\n  bare:\n    command: x\n    workspaces: switch\n  docs:\n    url: http://127.0.0.1:9000/mcp\n");
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (m: string) => void warned.push(m);
      try {
        expect(loadMcpPolicy([file]).servers).toEqual({ docs: { url: "http://127.0.0.1:9000/mcp" } });
      } finally {
        console.warn = warn;
      }
      expect(warned).toEqual(["mcp.yaml: servers empty, bare skipped: not an object with workspaces as a list"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Workspace MCP over HTTP", () => {
  beforeAll(async () => {
    core = await startServer(loadConfig({ SWITCHBOARD_HOME: home, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [idleAdapter()], { port: 0 });
    base = `http://127.0.0.1:${core.server.port}`;
  });
  let taskId: string;
  let url: string;
  let token: string;
  const connect = async (t = token) => {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${url}?token=${t}`));
    await client.connect(transport);
    // Real clients that go away without DELETE are reaped by the idle expiry; tests end their sessions explicitly.
    const close = client.close.bind(client);
    client.close = async () => {
      await transport.terminateSession().catch(() => undefined);
      await close();
    };
    return client;
  };
  const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "") as string;

  // Issued here, not in the first test, so a single test can run alone (`-t "fs.read"`).
  beforeAll(async () => {
    const t = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: repo, title: "mcp", prompt: "p", runner: "claude" }) }).then(j);
    taskId = t.id;
    const ep = await fetch(`${base}/api/tasks/${taskId}/mcp`).then(j);
    url = ep.url;
    token = ep.token;
  });

  test("exec.run's read-only git finds no repository above the scope: the ceiling is in the environment the command runs in (#2002)", async () => {
    // a scope that is a subfolder of a repository: git status there, without the ceiling, would read the whole repository
    const outer = join(home, "outer-repo");
    mkdirSync(join(outer, "sub"), { recursive: true });
    writeFileSync(join(outer, "sub", "x.txt"), "x\n");
    const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { cwd: outer, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
    git("init", "-q");
    expect(git("-C", "sub", "status", "--short").exitCode).toBe(0); // git itself finds the repository from sub
    const t = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: join(outer, "sub"), title: "ceiling", prompt: "p", runner: "claude" }) }).then(j);
    const ep = await fetch(`${base}/api/tasks/${t.id}/mcp`).then(j);
    const prev = url;
    url = ep.url;
    const c = await connect(ep.token);
    try {
      const out = JSON.parse(text(await c.callTool({ name: "exec.run", arguments: { command: "git status --short" } })));
      expect(out.exitCode).toBe(128);
      expect(out.stderr).toContain("not a git repository");
    } finally {
      await c.close();
      url = prev;
    }
  });

  test("an endpoint is issued per task and rejects a wrong token", async () => {
    expect(url).toBe(`${base}/mcp/${taskId}`);
    expect(token).toMatch(/^mcp_/);
    expect((await fetch(url, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${url}?token=wrong`, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/api/tasks/${taskId}/mcp`).then(j)).token).toBe(token); // stable for the task
  });

  test("fs.list / fs.read / fs.grep stay inside the scope and are recorded on the task", async () => {
    const c = await connect();
    const tools = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(["exec.run", "fs.grep", "fs.list", "fs.patch", "fs.pending", "fs.read", "fs.write", "task.note"]);
    const list = JSON.parse(text(await c.callTool({ name: "fs.list", arguments: { path: "." } })));
    expect(list.map((e: { name: string }) => e.name).sort()).toEqual(["README.md", "link-out", "src"]);
    expect(text(await c.callTool({ name: "fs.read", arguments: { path: "src/a.ts", limit: 1 } }))).toBe("export const answer = 42;");
    expect(text(await c.callTool({ name: "fs.grep", arguments: { pattern: "answer", path: ".", glob: "*.ts" } }))).toBe("src/a.ts:1:export const answer = 42;");
    const esc = await c.callTool({ name: "fs.read", arguments: { path: "link-out/secret.txt" } });
    expect(esc.isError).toBe(true);
    expect(text(esc)).toContain("outside the task scope");
    const d = await fetch(`${base}/api/tasks/${taskId}`).then(j);
    const calls = d.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "tool.call").map((e: AgentEvent) => (e.t === "tool.call" ? e.name : ""));
    expect(calls).toEqual(["fs.list", "fs.read", "fs.grep", "fs.read"]);
    const results = d.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "tool.result");
    expect(results.at(-1)).toMatchObject({ ok: false });
    await c.close();
  });

  test("task.note records a structured stop (#948) next to a note, refuses an empty call and a retry reserved twice", async () => {
    const c = await connect();
    const stop = { id: "net", op: "exec.run", target: "gh api", reason: "transient", safety: "read-only", evidence: "HTTP 503", state: "retrying", actions: [{ attempt: 1, at: 1, what: "再試行", ok: null }] };
    expect(text(await c.callTool({ name: "task.note", arguments: { text: "503 なので 5 秒後にもう一度", stop } }))).toBe("noted");
    const again = await c.callTool({ name: "task.note", arguments: { stop } });
    expect(again.isError).toBe(true);
    expect(text(again)).toContain("予約済み");
    expect((await c.callTool({ name: "task.note", arguments: {} })).isError).toBe(true);
    expect(text(await c.callTool({ name: "task.note", arguments: { stop: { ...stop, state: "resolved", actions: [{ attempt: 1, at: 1, what: "再試行", ok: true }] } } }))).toBe("noted");
    const d = await fetch(`${base}/api/tasks/${taskId}`).then(j);
    expect(d.stopSummary).toMatchObject([{ op: "exec.run", reason: "transient", count: 1, state: "resolved", next: "none", work: { taskId } }]);
    await c.close();
  });

  test("exec.run retries a run the system could not start for now (#949): 5 s then 30 s at most, recorded as the task's stop; a missing folder is not retried; each retry is approved again, a denied one is not run", async () => {
    const c = await connect();
    const waits: number[] = [];
    let busy = 0; // how many next starts fail with EAGAIN
    core.mcp.sleep = async (ms) => void waits.push(ms);
    core.mcp.spawn = ((...a: Parameters<typeof Bun.spawn>) => {
      if (busy-- > 0) throw Object.assign(new Error("EAGAIN: resource temporarily unavailable, posix_spawn"), { code: "EAGAIN" });
      return Bun.spawn(...a);
    }) as typeof Bun.spawn;
    const stopOf = async (target: string) => ((await fetch(`${base}/api/tasks/${taskId}`).then(j)).stopSummary as Array<{ op: string; target: string }>).find((s) => s.op === "exec.run" && s.target === target);
    const asks = async () => ((await fetch(`${base}/api/tasks/${taskId}`).then(j)).events as Array<{ ev: AgentEvent }>).map((e) => e.ev).filter((e) => e.t === "permission.ask");
    const answerNext = async (seen: number, decision: "allow" | "deny") => {
      for (let i = 0; (await asks()).length <= seen && i < 100; i++) await Bun.sleep(10);
      const ask = (await asks()).at(-1) as { id: string };
      await fetch(`${base}/api/tasks/${taskId}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ask.id, decision }) });
    };
    try {
      // could not start once, then runs
      busy = 1;
      expect(JSON.parse(text(await c.callTool({ name: "exec.run", arguments: { command: "ls src" } })))).toMatchObject({ exitCode: 0, stdout: "a.ts\n" });
      expect(waits).toEqual([5_000]);
      expect(await stopOf("ls src")).toMatchObject({ reason: "transient", safety: "before-effect", state: "resolved", next: "none", actions: [{ attempt: 1, what: "5 秒後に再実行" }, { attempt: 1, ok: true }] });

      // never starts: two retries, then the error with the reason; called again (the tries are in the task's events,
      // as after a restart), it runs once and is not retried
      waits.length = 0;
      busy = 99;
      const gone = await c.callTool({ name: "exec.run", arguments: { command: "ls -la" } });
      expect(gone.isError).toBe(true);
      expect(text(gone)).toContain("使い切りました");
      expect(waits).toEqual([5_000, 30_000]);
      expect(await stopOf("ls -la")).toMatchObject({ state: "exhausted", next: "decide", count: 1 });
      expect((await c.callTool({ name: "exec.run", arguments: { command: "ls -la" } })).isError).toBe(true);
      expect(waits).toEqual([5_000, 30_000]);
      busy = 0;

      // a folder that is not there is the input's: no retry, no stop
      waits.length = 0;
      expect((await c.callTool({ name: "exec.run", arguments: { command: "ls", cwd: "never" } })).isError).toBe(true);
      expect(waits).toEqual([]);
      expect(await stopOf("ls")).toBeUndefined();

      // a command that needs approval: asked again before the retry; denied, it is not run again
      const seen = (await asks()).length;
      busy = 1;
      const pending = c.callTool({ name: "exec.run", arguments: { command: "touch retried.txt" } });
      await answerNext(seen, "allow");
      await answerNext(seen + 1, "deny");
      expect(text(await pending)).toContain("not approved");
      expect(waits).toEqual([5_000]);
      expect((await asks()).length).toBe(seen + 2);
      expect(await stopOf("touch retried.txt")).toMatchObject({ state: "waiting", next: "wait", actions: [{ attempt: 1 }, { attempt: 1, ok: false }] });
    } finally {
      core.mcp.sleep = (ms) => Bun.sleep(ms);
      core.mcp.spawn = Bun.spawn;
      await c.close();
    }
  });

  test("fs.read returns images as image content and other binaries as a blob, text unchanged", async () => {
    const dir = join(repo, "media");
    mkdirSync(dir, { recursive: true });
    // a 1x1 PNG
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
    const bin = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2, 3, 0, 0xff]);
    writeFileSync(join(dir, "dot.png"), png);
    writeFileSync(join(dir, "blob.bin"), bin);
    writeFileSync(join(dir, "notes.md"), "line 1\nline 2\n");
    writeFileSync(join(dir, "a#1 b.bin"), bin);
    writeFileSync(join(dir, "logo.svg"), "<svg/>");
    writeFileSync(join(dir, "doc.pdf"), "%PDF-1.4 no NUL here");
    writeFileSync(join(dir, "Makefile.inc"), "all:\n\ttrue\n");
    const c = await connect();
    const img = (await c.callTool({ name: "fs.read", arguments: { path: "media/dot.png" } })) as { content: Array<Record<string, unknown>> };
    expect(img.content).toEqual([{ type: "image", data: png.toString("base64"), mimeType: "image/png" }]);
    const blob = (await c.callTool({ name: "fs.read", arguments: { path: "media/blob.bin" } })) as { content: Array<{ type: string; resource: { uri: string; mimeType: string; blob: string } }> };
    expect(blob.content[0]!.type).toBe("resource");
    expect(blob.content[0]!.resource).toMatchObject({ uri: `file://${realpathSync(join(dir, "blob.bin"))}`, mimeType: "application/octet-stream" });
    expect(Buffer.from(blob.content[0]!.resource.blob, "base64").equals(bin)).toBe(true);
    expect(text(await c.callTool({ name: "fs.read", arguments: { path: "media/notes.md", offset: 1, limit: 1 } }))).toBe("line 2");
    // the transcript says what was read, never the bytes
    const d = await fetch(`${base}/api/tasks/${taskId}`).then(j);
    const results = d.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "tool.result").slice(-3);
    expect(results.map((e: AgentEvent) => (e.t === "tool.result" ? e.summary : ""))).toEqual([`image/png, ${png.length} bytes`, `application/octet-stream, ${bin.length} bytes`, "line 2"]);
    // too large for one reply: refused, not truncated (half an image is no image)
    writeFileSync(join(dir, "big.png"), Buffer.alloc(DEFAULT_POLICY.fs.maxReadBytes * 4 + 1));
    const big = await c.callTool({ name: "fs.read", arguments: { path: "media/big.png" } });
    expect(big.isError).toBe(true);
    expect(text(big)).toContain("image too large");
    // the URI is a real file: URL (a name with # and a space survives new URL())
    const odd = (await c.callTool({ name: "fs.read", arguments: { path: "media/a#1 b.bin" } })) as { content: Array<{ resource: { uri: string } }> };
    expect(new URL(odd.content[0]!.resource.uri).pathname).toBe(new URL(`file://${realpathSync(dir)}/`).pathname + "a%231%20b.bin");
    // SVG is XML (text); a known binary format is a blob even without a NUL; an unknown extension without one is text
    expect(text(await c.callTool({ name: "fs.read", arguments: { path: "media/logo.svg" } }))).toBe("<svg/>");
    const pdf = (await c.callTool({ name: "fs.read", arguments: { path: "media/doc.pdf" } })) as { content: Array<{ type: string; resource: { mimeType: string } }> };
    expect(pdf.content[0]).toMatchObject({ type: "resource", resource: { mimeType: "application/pdf" } });
    expect(text(await c.callTool({ name: "fs.read", arguments: { path: "media/Makefile.inc" } }))).toBe("all:\n\ttrue\n");
    await c.close();
  });

  test("exec.run: read-only runs immediately; anything else waits for the user's decision (deny → error, allow → runs)", async () => {
    const c = await connect();
    const spawned: string[][] = [];
    const originalSpawn = core.mcp.spawn;
    core.mcp.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      spawned.push(args[0] as string[]);
      return Bun.spawn(...args);
    }) as typeof Bun.spawn;
    let ro;
    try {
      ro = JSON.parse(text(await c.callTool({ name: "exec.run", arguments: { command: "ls src" } })));
    } finally {
      core.mcp.spawn = originalSpawn;
    }
    expect(spawned[0]![0]).toBe(Bun.which("ls", { PATH: minimalEnv(repo).PATH, cwd: repo })!);
    expect(ro).toMatchObject({ exitCode: 0, stdout: "a.ts\n" });
    expect((await fetch(`${base}/api/tasks/${taskId}`).then(j)).task.status).toBe("running");

    let preSpawned = false;
    core.mcp.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
      preSpawned = true;
      return Bun.spawn(...args);
    }) as typeof Bun.spawn;
    const pending = c.callTool({ name: "exec.run", arguments: { command: "rg --pre sh foo" } });
    await new Promise((r) => setTimeout(r, 100));
    let d = await fetch(`${base}/api/tasks/${taskId}`).then(j);
    expect(d.task.status).toBe("waiting");
    const ask = d.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "permission.ask").at(-1);
    expect(ask).toMatchObject({ kind: "exec", tool: "exec.run", detail: "rg --pre sh foo" });
    await fetch(`${base}/api/tasks/${taskId}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ask.id, decision: "deny" }) });
    let denied;
    try {
      denied = await pending;
    } finally {
      core.mcp.spawn = originalSpawn;
    }
    expect(preSpawned).toBe(false);
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("not approved");
    d = await fetch(`${base}/api/tasks/${taskId}`).then(j);
    expect(d.task.status).toBe("running");
    expect(d.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "permission.resolved").at(-1)).toMatchObject({ id: ask.id, decision: "deny", by: "user" });

    const pending2 = c.callTool({ name: "exec.run", arguments: { command: "touch created.txt" } });
    await new Promise((r) => setTimeout(r, 100));
    d = await fetch(`${base}/api/tasks/${taskId}`).then(j);
    const ask2 = d.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "permission.ask").at(-1);
    await fetch(`${base}/api/tasks/${taskId}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ask2.id, decision: "allow" }) });
    expect(JSON.parse(text(await pending2))).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(text(await c.callTool({ name: "fs.list", arguments: { path: "." } }))).some((e: { name: string }) => e.name === "created.txt")).toBe(true);
    // cwd cannot escape either
    expect((await c.callTool({ name: "exec.run", arguments: { command: "ls", cwd: "../outside" } })).isError).toBe(true);
    await c.close();
  });

  test("a POST without a session that is not initialize is refused; the session cap holds", async () => {
    const r = await fetch(`${url}?token=${token}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(r.status).toBe(400);
    const clients = [];
    for (let i = 0; i < 8; i++) clients.push(await connect());
    let err: unknown;
    try {
      await connect();
    } catch (e) {
      err = e;
    }
    for (const c of clients) await c.close();
    expect(String(err)).toContain("too many sessions");
    // sessions ended with DELETE are gone: a new client connects again
    await (await connect()).close();
  });

  test("exec.run read-only output is capped and the process is killed; the pathological regex is refused by fs.grep", async () => {
    const c = await connect();
    writeFileSync(join(repo, "big.txt"), "x".repeat(200_000));
    const r = JSON.parse(text(await c.callTool({ name: "exec.run", arguments: { command: "cat big.txt" } })));
    expect(r.stdout.length).toBeLessThan(70_000);
    expect(r.stdout).toContain("(truncated)");
    expect(r.mode).toBe("read-only");
    const g = await c.callTool({ name: "fs.grep", arguments: { pattern: "(a+)+$", path: "." } });
    expect(g.isError).toBe(true);
    expect(text(g)).toContain("nested");
    // a bare `cat /etc/passwd` is not read-only: it needs approval (deny it)
    const pending = c.callTool({ name: "exec.run", arguments: { command: "cat /etc/passwd" } });
    await new Promise((r) => setTimeout(r, 100));
    const d = await fetch(`${base}/api/tasks/${taskId}`).then(j);
    const ask = d.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "permission.ask").at(-1);
    expect(ask.input.reason).toContain("outside the task scope");
    await fetch(`${base}/api/tasks/${taskId}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ask.id, decision: "deny" }) });
    expect((await pending).isError).toBe(true);
    // a relative word is checked from the cwd the command runs in (#2024): sub/out-link leads outside
    mkdirSync(join(repo, "sub"), { recursive: true });
    symlinkSync(join(outside, "secret.txt"), join(repo, "sub", "out-link"));
    try {
      const viaCwd = c.callTool({ name: "exec.run", arguments: { command: "cat out-link", cwd: "sub" } });
      await new Promise((r) => setTimeout(r, 100));
      const d2 = await fetch(`${base}/api/tasks/${taskId}`).then(j);
      const ask2 = d2.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "permission.ask").at(-1);
      expect(ask2.detail).toBe("cat out-link");
      expect(ask2.input.reason).toContain("outside the task scope");
      await fetch(`${base}/api/tasks/${taskId}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ask2.id, decision: "deny" }) });
      expect((await viaCwd).isError).toBe(true);
    } finally {
      rmSync(join(repo, "sub"), { recursive: true, force: true }); // other tests list the repo root exactly
    }
    await c.close();
  });

  test("the endpoint survives a finished task while its process lingers (follow-ups reuse it) and is revoked once the process is gone", async () => {
    // idleAdapter never ends on its own; abort ends the process → the endpoint is revoked below
    expect((await fetch(`${base}/api/tasks/${taskId}/mcp`).then(j)).token).toBe(token);
  });

  test("the endpoint is revoked when the task ends", async () => {
    await fetch(`${base}/api/tasks/${taskId}/abort`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(`${url}?token=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await fetch(`${base}/api/tasks/${taskId}/mcp`)).status).toBe(409);
  });
});

describe("cross-origin defence on loopback", () => {
  test("a request carrying a foreign Origin is refused even without a token requirement", async () => {
    expect((await fetch(`${base}/api/tasks`, { headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect((await fetch(`${base}/api/tasks`, { headers: { origin: base } })).status).toBe(200);
    expect((await fetch(`${base}/api/tasks`)).status).toBe(200);
  });
});

describe("local API token (#31)", () => {
  test("health reports authRequired=false on loopback and the token file exists with the daemon's token", async () => {
    const h = await fetch(`${base}/api/health`).then(j);
    expect(h.authRequired).toBe(false);
    expect(core.token).toMatch(/^sb_/);
    expect(h.mcp.base).toContain("/mcp/<taskId>");
  });

  test("off loopback, /api needs the bearer token but /api/health stays open", async () => {
    const h2 = mkdtempSync(join(tmpdir(), "sb-auth-"));
    const c2 = await startServer(loadConfig({ SWITCHBOARD_HOME: h2, SWITCHBOARD_PORT: "0", ...NO_HISTORY, SWITCHBOARD_HOST: "0.0.0.0" }), [idleAdapter()], { port: 0 });
    const b2 = `http://127.0.0.1:${c2.server.port}`;
    try {
      expect((await fetch(`${b2}/api/health`).then(j)).authRequired).toBe(true);
      expect((await fetch(`${b2}/api/tasks`)).status).toBe(401);
      expect((await fetch(`${b2}/api/tasks`, { headers: { authorization: `Bearer ${c2.token}` } })).status).toBe(200);
      // the query form is for /ws and /mcp only; API routes never take it (no token in history/logs)
      expect((await fetch(`${b2}/api/tasks?token=${c2.token}`)).status).toBe(401);
      expect((await fetch(`${b2}/ws`, { headers: { upgrade: "websocket", connection: "upgrade" } })).status).toBe(401);
      // health off-loopback reveals nothing but authRequired
      const h = await fetch(`${b2}/api/health`).then(j);
      expect(h.home).toBeUndefined();
      expect(h.runners).toBeUndefined();
      // a browser page from another origin cannot drive the API even with the token
      expect((await fetch(`${b2}/api/tasks`, { headers: { authorization: `Bearer ${c2.token}`, origin: "http://evil.example" } })).status).toBe(403);
      expect((await fetch(`${b2}/api/tasks`, { headers: { authorization: `Bearer ${c2.token}`, origin: `http://127.0.0.1:${c2.server.port}` } })).status).toBe(200);
    } finally {
      await c2.stop();
      rmSync(h2, { recursive: true, force: true });
    }
  });
});

describe("staged writes (#11)", () => {
  let taskId: string;
  let url: string;
  let token: string;
  const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "") as string;
  const connect = async () => {
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}?token=${token}`)));
    return client;
  };

  test("fs.write / fs.patch stage instead of writing; the file is untouched until the user applies", async () => {
    const t = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: repo, title: "staging", prompt: "p", runner: "claude" }) }).then(j);
    taskId = t.id;
    ({ url, token } = await fetch(`${base}/api/tasks/${taskId}/mcp`).then(j));
    const c = await connect();
    const w = JSON.parse(text(await c.callTool({ name: "fs.write", arguments: { path: "src/new.ts", content: "export const x = 1;\n" } })));
    expect(w.status).toBe("pending");
    expect(existsSync(join(repo, "src", "new.ts"))).toBe(false);
    const p = JSON.parse(text(await c.callTool({ name: "fs.patch", arguments: { path: "src/a.ts", find: "const b = 1;", replace: "const b = 2;" } })));
    expect(p.status).toBe("pending");
    expect(readFileSync(join(repo, "src", "a.ts"), "utf8")).toContain("const b = 1;");
    const dup = await c.callTool({ name: "fs.patch", arguments: { path: "src/a.ts", find: "const", replace: "let" } });
    expect(dup.isError).toBe(true);
    expect(text(dup)).toContain("more than once");
    const esc = await c.callTool({ name: "fs.write", arguments: { path: "../outside/x.md", content: "x" } });
    expect(esc.isError).toBe(true);
    const list = await fetch(`${base}/api/tasks/${taskId}/staging`).then(j);
    expect(list.map((s: { rel: string; status: string }) => [s.rel, s.status])).toEqual([["src/new.ts", "pending"], ["src/a.ts", "pending"]]);
    expect(list[1].diff).toContain("-const b = 1;\n+const b = 2;");
    const d = await fetch(`${base}/api/tasks/${taskId}`).then(j);
    expect(d.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "artifact")).toHaveLength(2);
    await c.close();
  });

  test("apply writes, reject marks, a file that moved on is a conflict, and decisions are final", async () => {
    const list = await fetch(`${base}/api/tasks/${taskId}/staging`).then(j);
    const [w, p] = list;
    const applied = await fetch(`${base}/api/tasks/${taskId}/staging/${w.id}/apply`, { method: "POST" }).then(j);
    expect(applied.status).toBe("applied");
    expect(readFileSync(join(repo, "src", "new.ts"), "utf8")).toBe("export const x = 1;\n");
    // the patched file changes underneath the staged edit → 409
    writeFileSync(join(repo, "src", "a.ts"), "changed elsewhere\n");
    const conflict = await fetch(`${base}/api/tasks/${taskId}/staging/${p.id}/apply`, { method: "POST" });
    expect(conflict.status).toBe(409);
    const rejected = await fetch(`${base}/api/tasks/${taskId}/staging/${p.id}/reject`, { method: "POST" }).then(j);
    expect(rejected.status).toBe("rejected");
    expect((await fetch(`${base}/api/tasks/${taskId}/staging/${p.id}/apply`, { method: "POST" })).status).toBe(400);
    expect((await fetch(`${base}/api/tasks/${taskId}/staging/${w.id}/reject`, { method: "POST" })).status).toBe(400);
    const d = await fetch(`${base}/api/tasks/${taskId}`).then(j);
    expect(d.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "artifact" && e.kind === "file")).toHaveLength(1);
  });

  test("chained patches, no-op / binary refusals, cross-task ownership, fs.pending", async () => {
    const c = await connect();
    writeFileSync(join(repo, "src", "chain.ts"), "a\nb\nc\n");
    const p1 = JSON.parse(text(await c.callTool({ name: "fs.patch", arguments: { path: "src/chain.ts", find: "a\n", replace: "A\n" } })));
    // the second patch builds on the first pending one, so `find` may target text only the first patch introduced
    const p2 = JSON.parse(text(await c.callTool({ name: "fs.patch", arguments: { path: "src/chain.ts", find: "A\nb", replace: "A\nB" } })));
    expect(p1.status).toBe("pending");
    expect(p2.status).toBe("pending");
    const noop = await c.callTool({ name: "fs.patch", arguments: { path: "src/chain.ts", find: "c", replace: "c" } });
    expect(text(noop)).toContain("no change");
    writeFileSync(join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
    const bin = await c.callTool({ name: "fs.patch", arguments: { path: "bin.dat", find: "x", replace: "y" } });
    expect(text(bin)).toContain("binary");
    const pending = JSON.parse(text(await c.callTool({ name: "fs.pending", arguments: {} })));
    expect(pending.filter((x: { path: string; status: string }) => x.path === "src/chain.ts" && x.status === "pending")).toHaveLength(2);
    // applying in order reproduces the chain; a stale second apply after an out-of-order write is a conflict
    const list = (await fetch(`${base}/api/tasks/${taskId}/staging?status=pending`).then(j)).filter((x: { rel: string }) => x.rel === "src/chain.ts");
    expect(list[0].before).toBeUndefined(); // list payload is slim
    expect(list[1].diff).toContain("-b\n+B");
    await fetch(`${base}/api/tasks/${taskId}/staging/${list[0].id}/apply`, { method: "POST" });
    await fetch(`${base}/api/tasks/${taskId}/staging/${list[1].id}/apply`, { method: "POST" });
    expect(readFileSync(join(repo, "src", "chain.ts"), "utf8")).toBe("A\nB\nc\n");
    // another task cannot apply or reject this task's changes, and nothing is written when it tries
    const other = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: repo, title: "other", prompt: "p", runner: "claude" }) }).then(j);
    const w = JSON.parse(text(await c.callTool({ name: "fs.write", arguments: { path: "src/owned.ts", content: "mine\n" } })));
    expect((await fetch(`${base}/api/tasks/${other.id}/staging/${w.staged}/apply`, { method: "POST" })).status).toBe(403);
    expect((await fetch(`${base}/api/tasks/${other.id}/staging/${w.staged}/reject`, { method: "POST" })).status).toBe(403);
    expect(existsSync(join(repo, "src", "owned.ts"))).toBe(false);
    expect((await fetch(`${base}/api/tasks/${taskId}/staging?status=pending`).then(j)).some((x: { id: string }) => x.id === w.staged)).toBe(true);
    await fetch(`${base}/api/tasks/${other.id}/abort`, { method: "POST" });
    await c.close();
  });

  test("rotate revokes the old token and issues a new one", async () => {
    const fresh = await fetch(`${base}/api/tasks/${taskId}/mcp/rotate`, { method: "POST" }).then(j);
    expect(fresh.token).not.toBe(token);
    expect((await fetch(`${url}?token=${token}`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    token = fresh.token;
    const c = await connect();
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("fs.write");
    await c.close();
  });
});

describe("exec.run process groups (#1136)", () => {
  let dir: string;
  let daemon: Awaited<ReturnType<typeof startServer>>;
  let api: string;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (fn: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end) await Bun.sleep(20);
    return fn();
  };
  const pidOf = (file: string) => {
    try {
      return Number(readFileSync(file, "utf8").trim()) || 0;
    } catch {
      return 0;
    }
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sb-mcp-pg-"));
    mkdirSync(join(dir, "repo"), { recursive: true });
    writeFileSync(join(dir, "mcp.yaml"), "exec:\n  timeoutMs: 4000\n");
    daemon = await startServer(loadConfig({ SWITCHBOARD_HOME: dir, SWITCHBOARD_PORT: "0", ...NO_HISTORY }), [idleAdapter()], { port: 0 });
    api = `http://127.0.0.1:${daemon.server.port}`;
  });
  afterAll(async () => {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A task, its MCP client, and a started exec.run of `sleep 300 & echo $! > child.pid; sleep 300` awaiting approval. */
  async function run(name: string) {
    const t = await fetch(`${api}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: join(dir, "repo"), title: name, prompt: "p", runner: "claude" }) }).then(j);
    const ep = await fetch(`${api}/api/tasks/${t.id}/mcp`).then(j);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${ep.url}?token=${ep.token}`)));
    const childFile = join(dir, "repo", `${name}.pid`);
    const spawned: number[] = [];
    daemon.mcp.spawn = ((...a: Parameters<typeof Bun.spawn>) => {
      const p = Bun.spawn(...a);
      spawned.push(p.pid);
      return p;
    }) as typeof Bun.spawn;
    const call = client.callTool({ name: "exec.run", arguments: { command: `sleep 300 & echo $! > ${name}.pid; sleep 300` } }).then(
      (r) => r,
      (e) => ({ isError: true, content: [{ text: String(e) }] }),
    );
    let ask: { id: string } | undefined;
    for (let i = 0; i < 200 && !ask; i++) {
      const d = await fetch(`${api}/api/tasks/${t.id}`).then(j);
      ask = d.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "permission.ask").at(-1);
      if (!ask) await Bun.sleep(20);
    }
    await fetch(`${api}/api/tasks/${t.id}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ask!.id, decision: "allow" }) });
    expect(await until(() => pidOf(childFile) > 0)).toBe(true);
    return { id: t.id, client, call, child: pidOf(childFile), spawned };
  }

  test("a timed-out exec.run takes its children with it", async () => {
    const r = await run("timeout");
    try {
      expect(alive(r.child)).toBe(true);
      const res = (await r.call) as { content: Array<{ text: string }> };
      expect(JSON.parse(res.content[0]!.text)).toMatchObject({ timedOut: true });
      expect(await until(() => !alive(r.child) && !alive(r.spawned[0]!), 6000)).toBe(true);
    } finally {
      daemon.mcp.spawn = Bun.spawn;
      await r.client.close().catch(() => undefined);
    }
  }, 15_000);

  test("a command that succeeds but leaves a background child is not reported as timed out, and the child is gone", async () => {
    const t = await fetch(`${api}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: join(dir, "repo"), title: "bg", prompt: "p", runner: "claude" }) }).then(j);
    const ep = await fetch(`${api}/api/tasks/${t.id}/mcp`).then(j);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${ep.url}?token=${ep.token}`)));
    try {
      const t0 = Date.now();
      const call = client.callTool({ name: "exec.run", arguments: { command: "sleep 300 & echo $! > bg.pid; echo done" } });
      let ask: { id: string } | undefined;
      for (let i = 0; i < 200 && !ask; i++) {
        const d = await fetch(`${api}/api/tasks/${t.id}`).then(j);
        ask = d.events.map((e: { ev: AgentEvent }) => e.ev).filter((e: AgentEvent) => e.t === "permission.ask").at(-1);
        if (!ask) await Bun.sleep(20);
      }
      await fetch(`${api}/api/tasks/${t.id}/permission`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: ask!.id, decision: "allow" }) });
      const res = (await call) as { content: Array<{ text: string }> };
      expect(JSON.parse(res.content[0]!.text)).toMatchObject({ exitCode: 0, timedOut: false });
      expect(Date.now() - t0).toBeLessThan(3000); // not held until the 4 s timeout
      const child = pidOf(join(dir, "repo", "bg.pid"));
      expect(child).toBeGreaterThan(0);
      expect(await until(() => !alive(child), 2000)).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
    }
  });

  test("an exec.run still running when the task ends is killed", async () => {
    const r = await run("ended");
    try {
      expect(alive(r.child)).toBe(true);
      await fetch(`${api}/api/tasks/${r.id}/abort`, { method: "POST" });
      // well inside the 4 s timeout: it is the task's end that kills, not the timeout
      expect(await until(() => !alive(r.child) && !alive(r.spawned[0]!), 2000)).toBe(true);
      // the MCP session is closed with the task: the call may never be answered, which is fine
      await Promise.race([r.call, Bun.sleep(500)]);
    } finally {
      daemon.mcp.spawn = Bun.spawn;
      await r.client.close().catch(() => undefined);
    }
  });
});
