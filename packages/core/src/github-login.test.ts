// test-reads: none
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GhRunner } from "./backlog.ts";
import { loadConfig } from "./config.ts";
import { afterGithubLogin, GITHUB_LOGIN_ARGS, GITHUB_LOGOUT_ARGS, githubStatus } from "./github-login.ts";
import { startServer } from "./server.ts";

const answer = (code: number, stdout = "", stderr = ""): GhRunner => async () => ({ code, stdout, stderr });

describe("githubStatus", () => {
  test("exit 0 is a login, with the account gh names", async () => {
    const out = "github.com\n  ✓ Logged in to github.com account octocat (keyring)\n  - Active account: true\n";
    expect(await githubStatus(answer(0, out), "/")).toEqual({ login: "ok", account: "octocat" });
  });
  test("no login or a refused token is none; gh that cannot start is missing", async () => {
    expect(await githubStatus(answer(1, "", "You are not logged into any GitHub hosts. To log in, run: gh auth login\n"), "/")).toEqual({ login: "none" });
    expect(await githubStatus(answer(127, "", "gh を起動できません"), "/")).toEqual({ login: "missing" });
  });
});

describe("afterGithubLogin", () => {
  const fakeGit = (set: Record<string, string>) => {
    const writes: string[][] = [];
    const git = async (args: string[]) => {
      if (args.length === 1) return { code: set[args[0]!] ? 0 : 1, stdout: set[args[0]!] ? `${set[args[0]!]}\n` : "" };
      writes.push(args);
      return { code: 0, stdout: "" };
    };
    return { git, writes };
  };
  const ghCalls = (user = "583231\toctocat\tThe Octocat\n") => {
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => (calls.push(args), { code: 0, stdout: args[0] === "api" ? user : "", stderr: "" });
    return { gh, calls };
  };

  test("points git at gh's credentials and leaves a set name and email alone", async () => {
    const { gh, calls } = ghCalls();
    const { git, writes } = fakeGit({ "user.name": "Me", "user.email": "me@example.com" });
    expect(await afterGithubLogin(gh, "/", git)).toBe(true);
    expect(calls).toEqual([["auth", "setup-git", "--hostname", "github.com"]]);
    expect(writes).toEqual([]);
  });

  test("a git without a commit name and email gets the account's name and noreply address", async () => {
    const { gh } = ghCalls();
    const { git, writes } = fakeGit({});
    await afterGithubLogin(gh, "/", git);
    expect(writes).toEqual([
      ["user.name", "The Octocat"],
      ["user.email", "583231+octocat@users.noreply.github.com"],
    ]);
  });

  test("an account without a name gives its login; only the missing value is written", async () => {
    const { gh } = ghCalls("583231\toctocat\t\n");
    const { git, writes } = fakeGit({ "user.email": "me@example.com" });
    await afterGithubLogin(gh, "/", git);
    expect(writes).toEqual([["user.name", "octocat"]]);
  });
});

describe("the API", () => {
  let dir: string;
  let fakeGh: string;
  const SHOWN = "WXYZ-1234";
  const calls: string[][] = [];
  // gh's status: none until the fake login below has ended, ok (an account) after it
  let loggedIn = false;
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[1] === "status") return loggedIn ? { code: 0, stdout: "", stderr: "  ✓ Logged in to github.com account octocat (keyring)\n" } : { code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts.\n" };
    if (args[1] === "setup-git") loggedIn = true;
    return { code: 0, stdout: "", stderr: "" };
  };
  const gitWrites: string[][] = [];
  const gitConfig = async (args: string[]) => (args.length > 1 && gitWrites.push(args), { code: 0, stdout: "set\n" });
  const start = (ghBin: string | null, runner: GhRunner = gh) => startServer(loadConfig({ SWITCHBOARD_HOME: dir, SWITCHBOARD_PORT: "0", SWITCHBOARD_CLAUDE_PROJECTS: join(dir, "none"), SWITCHBOARD_HISTORY_POLL_MS: "0" }), [], { port: 0, selfdevChecks: false, gh: runner, ghBin, gitConfig });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "switchboard-test-github-login-"));
    // what `gh auth login --web` prints without a terminal (2026-11-16), then it waits for the approval (here: 0.3 s).
    // The arguments are echoed to a file so the test sees the scopes the daemon asked for.
    fakeGh = join(dir, "gh");
    writeFileSync(fakeGh, `#!/bin/sh\necho "$@" > "${join(dir, "args")}"\necho "! First copy your one-time code: ${SHOWN}" >&2\necho "Open this URL to continue in your web browser: https://github.com/login/device" >&2\nsleep 0.3\nexit 0\n`);
    chmodSync(fakeGh, 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the login relays gh's code and page; once it ends git is set up and the status reads ok; the code is in no log and not in the DB", async () => {
    const log = spyOn(console, "log");
    const err = spyOn(console, "error");
    const core = await start(fakeGh);
    const base = `http://127.0.0.1:${core.server.port}`;
    try {
      expect(await (await fetch(`${base}/api/github/status`)).json()).toEqual({ login: "none" });
      const v = (await (await fetch(`${base}/api/github/login`, { method: "POST" })).json()) as { runner: string; url: string; code: string; state: string };
      expect(v).toMatchObject({ runner: "gh", url: "https://github.com/login/device", code: SHOWN, state: "waiting" });
      expect(await Bun.file(join(dir, "args")).text()).toBe(`${GITHUB_LOGIN_ARGS.join(" ")}\n`);
      let state = v.state;
      for (let i = 0; i < 50 && state === "waiting"; i++) {
        await Bun.sleep(100);
        state = ((await (await fetch(`${base}/api/github/login`)).json()) as { state: string }).state;
      }
      expect(state).toBe("done");
      for (let i = 0; i < 20 && !loggedIn; i++) await Bun.sleep(50);
      expect(calls).toContainEqual(["auth", "setup-git", "--hostname", "github.com"]);
      expect(await (await fetch(`${base}/api/github/status`)).json()).toEqual({ login: "ok", account: "octocat" });
      expect(gitWrites).toEqual([]); // name and email were set already
      for (const call of [...log.mock.calls, ...err.mock.calls]) expect(JSON.stringify(call)).not.toContain(SHOWN);
    } finally {
      await core.stop();
      log.mockRestore();
      err.mockRestore();
    }
    // the database and its journal, after the daemon closed them
    for (const f of readdirSync(dir).filter((n) => n.startsWith("switchboard.db"))) expect(readFileSync(join(dir, f)).includes(SHOWN)).toBe(false);
  });

  test("the logout runs gh's `auth logout`, then the status reads none; a failing gh is a 502; without gh it is a 404", async () => {
    const mark = join(dir, "gh-token");
    const logoutGh = join(dir, "gh-logout");
    // `auth logout` removes the mark; `auth status` exits 1 without it, like gh with no stored login
    writeFileSync(logoutGh, `#!/bin/sh\nif [ "$1 $2" = "auth logout" ]; then echo "$@" > "${join(dir, "logout-args")}"; [ -f "${join(dir, "gh-fail")}" ] && exit 1; rm -f "${mark}"; exit 0; fi\nexit 9\n`);
    chmodSync(logoutGh, 0o755);
    writeFileSync(mark, "");
    const statusGh: GhRunner = async () => (existsSync(mark) ? { code: 0, stdout: "", stderr: "  ✓ Logged in to github.com account octocat (keyring)\n" } : { code: 1, stdout: "", stderr: "not logged in\n" });
    const core = await start(logoutGh, statusGh);
    const base = `http://127.0.0.1:${core.server.port}`;
    try {
      expect(await (await fetch(`${base}/api/github/status`)).json()).toEqual({ login: "ok", account: "octocat" });
      writeFileSync(join(dir, "gh-fail"), "");
      expect((await fetch(`${base}/api/github/logout`, { method: "POST" })).status).toBe(502);
      expect(await (await fetch(`${base}/api/github/status`)).json()).toEqual({ login: "ok", account: "octocat" });
      rmSync(join(dir, "gh-fail"));
      const res = await fetch(`${base}/api/github/logout`, { method: "POST" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(await Bun.file(join(dir, "logout-args")).text()).toBe(`${GITHUB_LOGOUT_ARGS.join(" ")}\n`);
      expect(await (await fetch(`${base}/api/github/status`)).json()).toEqual({ login: "none" });
    } finally {
      await core.stop();
    }
    const none = await start(null, answer(127, "", "gh を起動できません"));
    try {
      expect((await fetch(`http://127.0.0.1:${none.server.port}/api/github/logout`, { method: "POST" })).status).toBe(404);
    } finally {
      await none.stop();
    }
  });

  test("without gh there is no login to start, and the status says gh is missing", async () => {
    const core = await start(null, answer(127, "", "gh を起動できません"));
    try {
      expect((await fetch(`http://127.0.0.1:${core.server.port}/api/github/login`, { method: "POST" })).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${core.server.port}/api/github/login`)).status).toBe(404);
      expect(await (await fetch(`http://127.0.0.1:${core.server.port}/api/github/status`)).json()).toEqual({ login: "missing" });
    } finally {
      await core.stop();
    }
  });
});
