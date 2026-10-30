import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { main } from "./cli.ts";
import { fakeGh, type FakeCall } from "./gh.ts";

const config = join(import.meta.dir, "../fixtures/config-with-phase.json");
let saved: string | undefined;
let savedAws: string | undefined;
let awsDir: string;
beforeEach(() => {
  saved = process.env.GH_REPO;
  process.env.GH_REPO = "example/repo";
  // a made-up AWS config, so that the host's own is never read
  savedAws = process.env.AWS_CONFIG_FILE;
  awsDir = mkdtempSync(join(tmpdir(), "ops-kit.aws."));
  writeFileSync(join(awsDir, "config"), "[default]\n[profile x-admin]\n");
  process.env.AWS_CONFIG_FILE = join(awsDir, "config");
});
afterEach(() => {
  if (saved === undefined) delete process.env.GH_REPO;
  else process.env.GH_REPO = saved;
  if (savedAws === undefined) delete process.env.AWS_CONFIG_FILE;
  else process.env.AWS_CONFIG_FILE = savedAws;
  rmSync(awsDir, { recursive: true });
});

function run(argv: string[], responses: Parameters<typeof fakeGh>[0] = []) {
  const out: string[] = [];
  const err: string[] = [];
  const gh = fakeGh(responses);
  // outside the app's Task: a Task running these tests has BACKLOG_URL, which sends set / triage to the app
  return main(argv, gh, (s) => out.push(s), (s) => err.push(s), async () => {}, { ...process.env, BACKLOG_URL: undefined }).then((code) => ({ code, out: out.join("\n"), err: err.join("\n"), gh }));
}

describe("cli", () => {
  test("--help lists the commands and shows a config example", async () => {
    const r = await run(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("set <issue> <field> <value>");
    expect(r.out).toContain("triage <issue> <area> <kind> <priority>");
    expect(r.out).toContain('"projectUrl"');
    expect((await run([])).code).toBe(1);
  });

  test("set runs with --config and prints what it set", async () => {
    const r = await run(["set", "#16", "Status", "Ready", "--config", config], [
      () => ({ repositoryOwner: { projectV2: { id: "P1", field: { id: "F1", dataType: "SINGLE_SELECT", options: [{ id: "O2", name: "Ready" }] } } }, repository: { issue: { id: "I1", projectItems: { nodes: [{ id: "IT1", project: { number: 1 } }] } } } }),
      () => ({}),
    ]);
    expect(r).toMatchObject({ code: 0, out: "#16  Status = Ready", err: "" });
  });

  test("triage reads the phase positionally only when the config has one; an empty parent skips it", async () => {
    const fields = ["Area:one", "Kind:bug", "Priority:P1", "Phase:Phase 0", "Status:Ready"].map((s) => {
      const [name, opt] = s.split(":");
      return { id: name, name, options: [{ id: `${name}:${opt}`, name: opt }] };
    });
    const r = await run(["triage", "3", "one", "bug", "P1", "Phase 0", "", "Ready", "--config", config], [
      () => ({ repositoryOwner: { projectV2: { id: "P1", fields: { nodes: fields } } }, repository: { issue: { id: "I1", projectItems: { nodes: [{ id: "IT1", project: { number: 1 } }] } } } }),
      () => ({}),
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("   Phase = Phase 0");
    expect(r.out).toContain("   Status = Ready");
    expect(r.gh.calls).toHaveLength(2);
  });

  test("bootstrap takes a title and --dry-run in either order; request takes a title and a body file", async () => {
    const empty = () => ({ repositoryOwner: { id: "O", projectsV2: { pageInfo: { hasNextPage: false }, nodes: [] } } });
    for (const argv of [["bootstrap", "--dry-run", "Backlog"], ["bootstrap", "Backlog", "--dry-run"]]) {
      const r = await run([...argv, "--config", config], [empty]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("DRY_RUN> Project「Backlog」を example に作る");
      expect(r.out).toContain("DRY_RUN> 作った Project の Status の選択肢を Backlog / Ready / In progress / In review / Done にする");
    }
    expect((await run(["bootstrap", "--config", config])).err).toContain("bootstrap <title> [--dry-run]");
    expect((await run(["bootstrap", "a", "b", "--config", config])).err).toContain("bootstrap <title> [--dry-run]");
    expect((await run(["request", "title-only", "--config", config])).err).toContain("request <title> <body-file>");
    expect((await run(["request", "t", "f", "extra", "--config", config])).err).toContain("request <title> <body-file>");
    const help = (await run(["--help"])).out;
    expect(help).toContain("bootstrap <title> [--dry-run]");
    expect(help).toContain("request <title> <body-file>");
  });

  test("public-sync: --adopt-baseline needs --source and independent versioning (exit 2)", async () => {
    const help = (await run(["--help"])).out;
    expect(help).toContain("public-sync [--source <ref>] [--dry-run] [--adopted] [--adopt-baseline] [--target-url <url>]");
    expect(help).toContain("--adopt-baseline: independent");
    const dir = mkdtempSync(join(tmpdir(), "ops-kit.adopt."));
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=dev", "-c", "user.email=dev@example.com", ...args]);
    const prev = process.cwd();
    try {
      git("init", "-q", "-b", "main");
      Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", join(dir, "origin.git")]);
      git("remote", "add", "origin", join(dir, "origin.git"));
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify({ publicSync: { target: "example/app" } }));
      git("add", "ops.config.json"); git("commit", "-qm", "config"); git("tag", "v1.0.0"); git("push", "-q", "origin", "main", "--tags");
      process.chdir(dir);
      const cfg = join(dir, "ops.config.json");
      const noSource = await run(["public-sync", "--config", cfg, "--adopt-baseline", "--dry-run"]);
      expect(noSource).toMatchObject({ code: 2 });
      expect(noSource.err).toContain("public-sync --adopt-baseline --source <vX.Y.Z>");
      const plain = await run(["public-sync", "--config", cfg, "--adopt-baseline", "--source", "v1.0.0", "--dry-run"]);
      expect(plain).toMatchObject({ code: 2 });
      expect(plain.err).toContain("publicSync.versioning: independent");
      expect((await run(["public-sync", "--config", cfg, "--check", "--adopt-baseline"])).code).toBe(2);
      // the setting is read at origin/main, not at the --source tag published before independent versioning
      writeFileSync(cfg, JSON.stringify({ publicSync: { target: "example/app", versioning: "independent" } }));
      git("commit", "-qam", "independent"); git("push", "-q", "origin", "main");
      // and the flag reaches the sync: an empty target stops the migration, while a plain sync would plan v0.1.0
      Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", join(dir, "public.git")]);
      const adopt = await run(["public-sync", "--config", cfg, "--adopt-baseline", "--source", "v1.0.0", "--dry-run", "--target-url", join(dir, "public.git")]);
      expect(adopt).toMatchObject({ code: 1 });
      expect(adopt.err).toContain("public main missing");
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mistakes exit 1 with a message: bad arguments, an unknown command, a missing config, a gh failure", async () => {
    expect((await run(["set", "16", "Status", "--config", config])).err).toContain("set <issue> <field> <value>");
    expect((await run(["nope", "--config", config])).err).toContain("知らないコマンドです: nope");
    expect((await run(["set", "x", "Status", "Ready", "--config", config])).err).toContain("Issue 番号ではありません");
    const missing = await run(["set", "1", "Status", "Ready", "--config", "/nonexistent/ops.config.json"]);
    expect(missing).toMatchObject({ code: 1 });
    expect(missing.err).toContain("を読めません");
    const failed = await run(["set", "1", "Status", "Ready", "--config", config], [() => { throw new Error("gh api が失敗しました"); }]);
    expect(failed).toMatchObject({ code: 1, err: "gh api が失敗しました" });
  });

  test("scan-text: kind and line of each hit, never the value; exit 0 / 1 / 2; no config needed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit.scan."));
    writeFileSync(join(dir, "bad.md"), `## 判断待ち\nAuthorization: Bearer ${"A".repeat(24)}\n`);
    writeFileSync(join(dir, "fine.md"), "着手: 枝 `sb/1-x`\n");
    const bad = await run(["scan-text", join(dir, "bad.md")]);
    expect(bad).toMatchObject({ code: 1, out: `${join(dir, "bad.md")}:2: bearer-token`, err: "" });
    expect(bad.out).not.toContain("AAAA");
    expect(await run(["scan-text", join(dir, "fine.md")])).toMatchObject({ code: 0, out: "" });
    expect((await run(["scan-text", join(dir, "none.md")])).code).toBe(2);
    expect((await run(["scan-text"])).code).toBe(2);
    rmSync(dir, { recursive: true });
  });

  test("scan-text and scan-issues find a name of the host's AWS config, by kind and line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit.scan."));
    writeFileSync(join(dir, "named.md"), "一行目\naws sso login --profile x-admin\n");
    const text = await run(["scan-text", join(dir, "named.md")]);
    expect(text).toMatchObject({ code: 1, out: `${join(dir, "named.md")}:2: aws-profile` });
    expect(text.out).not.toContain("x-admin");
    const issues = await run(["scan-issues", "o/r"], [() => [{ html_url: "https://github.example/o/r/issues/3", title: "題", body: "--profile x-admin" }], () => [], () => []]);
    expect(issues).toMatchObject({ code: 1, out: "https://github.example/o/r/issues/3: aws-profile（1 行目）\nhits: 1 / scanned: 1" });
    rmSync(dir, { recursive: true });
  });

  test("scan-text and scan-issues find an account id of the host's AWS config written bare, and never print it", async () => {
    // made up, put together so that no file holds it in one piece
    const id = ["8642", "9753", "1086"].join("");
    writeFileSync(process.env.AWS_CONFIG_FILE!, `[profile x-admin]\nsso_account_id = ${id}\n`);
    const dir = mkdtempSync(join(tmpdir(), "ops-kit.scan."));
    writeFileSync(join(dir, "bare.md"), `一行目\nメモ ${id}\n`);
    const text = await run(["scan-text", join(dir, "bare.md")]);
    expect(text).toMatchObject({ code: 1, out: `${join(dir, "bare.md")}:2: account-id` });
    expect(`${text.out}${text.err}`).not.toContain(id);
    const issues = await run(["scan-issues", "o/r"], [() => [{ html_url: "https://github.example/o/r/issues/4", title: "題", body: `メモ ${id}` }], () => [], () => []]);
    expect(issues).toMatchObject({ code: 1, out: "https://github.example/o/r/issues/4: account-id（1 行目）\nhits: 1 / scanned: 1" });
    expect(`${issues.out}${issues.err}`).not.toContain(id);
    rmSync(dir, { recursive: true });
  });

  test("sync-labels reads the file and needs no config; reconcile-project resolves the config's Project; bad arguments exit 2 / 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit.labels."));
    writeFileSync(join(dir, "labels.yml"), "- name: bug\n  color: d73a4a\n");
    const labels = await run(["sync-labels", join(dir, "labels.yml"), "--dry-run"], [() => []]);
    rmSync(dir, { recursive: true });
    expect(labels).toMatchObject({ code: 0 });
    expect(labels.out).toContain(">> (dry-run) create bug");
    expect(labels.gh.calls[0]).toMatchObject({ path: "repos/example/repo/labels?per_page=100&page=1" });
    expect((await run(["sync-labels", "a.yml", "b.yml"])).code).toBe(2);
    const project = await run(["--config", config, "reconcile-project", "--dry-run"], [
      () => ({ repositoryOwner: { projectV2: { id: "P1" } } }),
      () => ({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }),
      () => ({ repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }),
    ]);
    expect(project).toMatchObject({ code: 0, out: "追加する: 0 件" });
    expect((await run(["--config", config, "reconcile-project", "--all"])).code).toBe(1);
  });

  test("scan-issues prints hits and scanned: the place and the kind; exit 0 / 1 / 2", async () => {
    const code = ["QWJK", "ZRTP"].join("-");
    const hit = await run(["scan-issues", "o/r"], [() => [{ html_url: "https://github.example/o/r/issues/3", title: "題", body: `コード ${code}` }], () => [], () => []]);
    expect(hit).toMatchObject({ code: 1, out: "https://github.example/o/r/issues/3: device-code（1 行目）\nhits: 1 / scanned: 1" });
    expect(hit.out).not.toContain("QWJK");
    // no argument: the repository of GH_REPO
    const none = await run(["scan-issues"], [() => [], () => [], () => []]);
    expect(none).toMatchObject({ code: 0, out: "hits: 0 / scanned: 0" });
    expect(none.gh.calls[0]).toMatchObject({ path: "repos/example/repo/issues?state=all&per_page=100&page=1" });
    expect((await run(["scan-issues", "o/r"], [() => { throw new Error("HTTP 403"); }])).code).toBe(2);
    expect((await run(["scan-issues", "not a repo"])).code).toBe(2);
  });

  test("scan-issues --since reads the difference and --recheck the earlier hits; a bad time or another repository's URL is usage", async () => {
    const code = ["QWJK", "ZRTP"].join("-");
    const r = await run(["scan-issues", "--since", "2026-10-20T00:00:00Z", "--recheck", "https://github.com/o/r/issues/3", "o/r"], [() => [], () => [], () => [], () => ({ title: "題", body: `コード ${code}` })]);
    expect(r).toMatchObject({ code: 1, out: "https://github.com/o/r/issues/3: device-code（1 行目）\nhits: 1 / scanned: 1" });
    expect(r.gh.calls.map((c) => (c.kind === "api" ? c.path : ""))).toEqual([
      "repos/o/r/issues?since=2026-10-20T00%3A00%3A00Z&state=all&per_page=100&page=1",
      "repos/o/r/issues/comments?since=2026-10-20T00%3A00%3A00Z&per_page=100&page=1",
      "repos/o/r/pulls/comments?since=2026-10-20T00%3A00%3A00Z&per_page=100&page=1",
      "repos/o/r/issues/3",
    ]);
    expect((await run(["scan-issues", "o/r", "--since", "yesterday"])).code).toBe(2);
    expect((await run(["scan-issues", "o/r", "--since"])).code).toBe(2);
    expect((await run(["scan-issues", "o/r", "--recheck", "https://github.com/x/y/issues/3"])).code).toBe(2);
  });

  test("ops-kit on PATH runs scan-issues from a repository without entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit-bin-"));
    try {
      const repo = join(dir, "repo");
      const fake = join(dir, "fake");
      const issues = join(dir, "issues.json");
      // a repository with neither scripts/setup nor ops.config.json; its origin names the repository
      mkdirSync(repo);
      Bun.spawnSync(["git", "init", "-q", repo]);
      Bun.spawnSync(["git", "-C", repo, "remote", "add", "origin", "https://github.com/o/r.git"]);
      // the gh behind the kit's guard: the issue list from issues.json, every other list empty
      mkdirSync(fake);
      writeFileSync(join(fake, "gh"), `#!/usr/bin/env bun\nconst path = process.argv[3] ?? "";\nconsole.log(path.startsWith("repos/o/r/issues?") ? await Bun.file(${JSON.stringify(issues)}).text() : "[]");\n`);
      chmodSync(join(fake, "gh"), 0o755);
      const ops = (...args: string[]) => {
        const PATH = [join(import.meta.dir, "../bin"), fake, dirname(process.execPath), dirname(Bun.which("git")!)].join(":");
        const p = Bun.spawnSync(["ops-kit", "scan-issues", ...args], { cwd: repo, env: { PATH }, stdout: "pipe", stderr: "pipe" });
        return { code: p.exitCode, out: p.stdout.toString() };
      };
      writeFileSync(issues, JSON.stringify([{ html_url: "https://github.example/o/r/issues/1", title: "題", body: "本文" }]));
      expect(ops("o/r")).toEqual({ code: 0, out: "hits: 0 / scanned: 1\n" });
      // no argument, as the skills write it: the repository of the origin
      expect(ops()).toEqual({ code: 0, out: "hits: 0 / scanned: 1\n" });
      const code = ["QWJK", "ZRTP"].join("-");
      writeFileSync(issues, JSON.stringify([{ html_url: "https://github.example/o/r/issues/3", title: "題", body: `コード ${code}` }]));
      const hit = ops();
      expect(hit).toEqual({ code: 1, out: "https://github.example/o/r/issues/3: device-code（1 行目）\nhits: 1 / scanned: 1\n" });
      expect(hit.out).not.toContain("QWJK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("mr uses GitLab's own MR and discussions through glab in a GitLab checkout; a GitHub one is told to use gh (#923)", async () => {
    const home = mkdtempSync(join(tmpdir(), "ops-kit-cli-mr-"));
    const was = process.cwd();
    const calls: string[][] = [];
    const glab = async (cmd: string[]) => {
      calls.push(cmd);
      const p = cmd.at(-1)!;
      if (p.endsWith("/merge_requests")) return JSON.stringify({ iid: 7, web_url: "https://gitlab.example.com/group/app/-/merge_requests/7", state: "opened", source_branch: "b", target_branch: "main", sha: "1".repeat(40) });
      if (p.includes("/discussions/")) return JSON.stringify({ id: "a".repeat(40), notes: [{ id: 1, body: "x", resolvable: true, resolved: !p.includes("b".repeat(40)) }] });
      return "[]";
    };
    const mr = (...a: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      return main(["mr", ...a], fakeGh([]), (s) => out.push(s), (s) => err.push(s), async () => {}, { ...process.env, BACKLOG_URL: undefined }, glab).then((code) => ({ code, out: out.join("\n"), err: err.join("\n") }));
    };
    try {
      Bun.spawnSync(["git", "init", "-q", home]);
      Bun.spawnSync(["git", "-C", home, "remote", "add", "origin", "https://gitlab.example.com/group/app.git"]);
      writeFileSync(join(home, "ops.config.json"), JSON.stringify({ forge: { service: "gitlab", host: "gitlab.example.com", project: "group/app" } }));
      writeFileSync(join(home, "body.md"), "Closes #13");
      process.chdir(home);
      expect(await mr("create", "--source", "b", "--target", "main", "--title", "t", "--body-file", "body.md")).toEqual({ code: 0, out: "!7 https://gitlab.example.com/group/app/-/merge_requests/7", err: "" });
      expect((await mr("resolve", "7", "a".repeat(40), "b".repeat(40))).code).toBe(1);
      expect((await mr("note", "7", "--body-file", "body.md", "--path", "a.ts")).code).toBe(2);
      expect((await mr("view", "x")).code).toBe(2);
      expect(calls.every((c) => c[0] === "glab" && c[3] === "gitlab.example.com")).toBe(true);
      writeFileSync(join(home, "ops.config.json"), JSON.stringify({}));
      calls.length = 0;
      expect(await mr("view", "7")).toMatchObject({ code: 2, err: expect.stringContaining("PR は gh を使ってください") });
      expect(calls).toEqual([]);
    } finally {
      process.chdir(was);
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("pr resolve-thread resolves each thread", async () => {
    const resolved = (call: unknown) => {
      expect(call).toMatchObject({ kind: "graphql" });
      return { resolveReviewThread: { thread: { isResolved: true } } };
    };
    const r = await run(["pr", "resolve-thread", "PRRT_a1", "PRRT_b-2"], [resolved, resolved]);
    expect(r).toMatchObject({ code: 0, out: "PRRT_a1 resolved\nPRRT_b-2 resolved" });
    expect(r.gh.calls.map((c) => c.kind === "graphql" && c.vars)).toEqual([{ t: "PRRT_a1" }, { t: "PRRT_b-2" }]);
    expect((r.gh.calls[0] as { query: string }).query).toContain("resolveReviewThread(input:{threadId:$t})");
    // an id of another shape is refused before gh is called (only review threads, not any node)
    const bad = await run(["pr", "resolve-thread", "PRRT_a1", "I_kwDO1"]);
    expect(bad.code).toBe(1);
    expect(bad.gh.calls).toEqual([]);
    expect((await run(["pr", "resolve-thread"])).code).toBe(1);
    // GitHub not answering resolved is a failure of that thread
    const no = await run(["pr", "resolve-thread", "PRRT_a1"], [() => ({ resolveReviewThread: { thread: { isResolved: false } } })]);
    expect(no).toMatchObject({ code: 1, err: "PRRT_a1: PRRT_a1 が resolve にならなかった" });
  });
});

test("lint --no-project does not resolve a missing Project URL", async () => {
  const cfg = JSON.parse(readFileSync(config, "utf8"));
  delete cfg.projectUrl;
  const path = join(awsDir, "ops.config.json");
  writeFileSync(path, JSON.stringify(cfg));
  const gh = fakeGh([() => ({ repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } })]);
  gh.run = async () => { throw new Error("Project lookup must not run"); };
  expect(await main(["lint", "--no-project", "--config", path], gh, () => {}, () => {}, Bun.sleep, { ...process.env, BACKLOG_URL: undefined })).toBe(0);
});

test("lint without ops.config.json checks a workspace without GitHub with the template's choices (#2361)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-kit.noconfig."));
  const pbi = "## ユーザーストーリー\nx\n## 到達点 / 受け入れ条件\n- [ ] 1. x\n## スコープ外\nx\n## 元要望\n#1（x）\n\n**Story Points**: 5\n";
  const task = "## 親 PBI\n#2\n## やること\nx\n## 手順\nx\n## 検証\nx\n## 完了条件\nx\n";
  const issue = { state: "OPEN", stateReason: null, updatedAt: "", parent: null, subIssues: [] as number[] };
  const records = {
    workspaceId: "ws_local", service: "app", repository: "ws_local", project: { owner: "app", number: 0 }, fetchedAt: 1, unread: [], pulls: [],
    issues: [
      { ...issue, number: 2, title: "PBI: x", body: pbi, labels: ["type:pbi"], subIssues: [3], fields: { Status: "Ready", Area: "app", Kind: "feature", Priority: "P1", "Story Points": 5 } },
      { ...issue, number: 3, title: "Task: x", body: task, labels: ["type:task"], parent: 2, fields: { Status: "Backlog" } },
    ],
  };
  const sync = { workspaceId: "ws_local", repository: "ws_local", syncedAt: 1, sync: { state: "synced", reason: null, lastSuccessfulSync: 1 } };
  const server = Bun.serve({ port: 0, fetch: (req) => Response.json(new URL(req.url).pathname.endsWith("/records") ? records : req.method === "POST" ? {} : { syncs: [sync], items: [] }) });
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const env = { ...process.env, BACKLOG_URL: `http://127.0.0.1:${server.port}/api/backlog`, BACKLOG_WORKSPACE: "ws_local", BACKLOG_TOKEN_FILE: undefined, GH_REPO: undefined };
    const err: string[] = [];
    expect(await main(["lint", "--fresh"], fakeGh([]), () => {}, (s) => err.push(s), async () => {}, env)).toBe(0);
    expect(err[0]).toContain("既定の選択肢");
    // a workspace on GitHub keeps needing its file
    expect(await main(["lint", "--fresh"], fakeGh([]), () => {}, () => {}, async () => {}, { ...env, GH_REPO: "acme/app" })).toBe(2);
  } finally {
    process.chdir(cwd);
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("set / triage with BACKLOG_URL (#2694)", () => {
  // a fake app: what it was asked, and the stored fields of the one Issue
  function fakeApp() {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const sync = { workspaceId: "ws_1", repository: "example/repo", syncedAt: 1, syncing: false, sync: { state: "synced", reason: null, pendingCount: 0 } };
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        const path = url.pathname.replace(/^\/api\/backlog/, "");
        calls.push({ method: req.method, path, body: req.method === "PATCH" ? await req.json() : null });
        if (path === "") return Response.json({ syncs: [sync], items: [] });
        if (req.method === "GET") return Response.json({ issue: { number: 12 }, comments: [], fields: { Status: "Backlog", "Story Points": 3 }, fetchedAt: 1, localId: null, pending: 0 });
        return Response.json({});
      },
    });
    const env = { ...process.env, BACKLOG_URL: `http://127.0.0.1:${server.port}/api/backlog`, BACKLOG_TOKEN_FILE: undefined, BACKLOG_WORKSPACE: undefined, GH_REPO: "example/repo" };
    return { calls, env, stop: () => server.stop(true) };
  }
  const patches = (calls: Array<{ method: string; body: unknown }>) => calls.filter((c) => c.method === "PATCH").map((c) => c.body);

  test("set and triage are stored in the app and never written with gh", async () => {
    const app = fakeApp();
    try {
      const gh = fakeGh([]);
      const out: string[] = [];
      expect(await main(["set", "12", "Status", "In progress", "--config", config], gh, (s) => out.push(s), () => {}, async () => {}, app.env)).toBe(0);
      expect(await main(["triage", "12", "one", "bug", "P1", "Phase 0", "", "Ready", "--config", config], gh, (s) => out.push(s), () => {}, async () => {}, app.env)).toBe(0);
      expect(out).toEqual(["#12 を保存しました", "#12 を保存しました"]);
      expect(patches(app.calls)).toEqual([
        { workspaceId: "ws_1", fields: { Status: "In progress" } },
        { workspaceId: "ws_1", project: true, fields: { Area: "one", Kind: "bug", Priority: "P1", Phase: "Phase 0", Status: "Ready" } },
      ]);
      expect(gh.calls).toHaveLength(0);
    } finally {
      app.stop();
    }
  });

  test("another repository's ops.config.json: its fields decide triage's arguments, and nothing goes to gh", async () => {
    const app = fakeApp();
    const dir = mkdtempSync(join(tmpdir(), "ops-kit.other-config."));
    try {
      const cfg = JSON.parse(readFileSync(config, "utf8"));
      delete cfg.fields.phase;
      cfg.projectUrl = "https://github.com/users/someone/projects/9";
      writeFileSync(join(dir, "ops.config.json"), JSON.stringify(cfg));
      const gh = fakeGh([]);
      expect(await main(["set", "12", "Story Points", "5", "--config", join(dir, "ops.config.json")], gh, () => {}, () => {}, async () => {}, app.env)).toBe(0);
      expect(await main(["triage", "12", "one", "bug", "P1", "", "Ready", "--config", join(dir, "ops.config.json")], gh, () => {}, () => {}, async () => {}, app.env)).toBe(0);
      expect(patches(app.calls)).toEqual([
        { workspaceId: "ws_1", fields: { "Story Points": 5 } },
        { workspaceId: "ws_1", project: true, fields: { Area: "one", Kind: "bug", Priority: "P1", Status: "Ready" } },
      ]);
      expect(gh.calls).toHaveLength(0);
    } finally {
      app.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an app that cannot be reached is not told (exit 2), and gh is not used instead", async () => {
    const gh = fakeGh([]);
    const err: string[] = [];
    expect(await main(["set", "12", "Status", "Ready", "--config", config], gh, () => {}, (s) => err.push(s), async () => {}, { ...process.env, BACKLOG_URL: "http://127.0.0.1:1/api/backlog", GH_REPO: "example/repo" })).toBe(2);
    expect(err.join("\n")).toContain("アプリに届きません");
    expect(gh.calls).toHaveLength(0);
  });

  test("without BACKLOG_URL, set still writes to GitHub with gh", async () => {
    const r = await run(["set", "12", "Status", "Ready", "--config", config], [
      () => ({ repositoryOwner: { projectV2: { id: "P1", field: { id: "F1", dataType: "SINGLE_SELECT", options: [{ id: "O2", name: "Ready" }] } } }, repository: { issue: { id: "I1", projectItems: { nodes: [{ id: "IT1", project: { number: 1 } }] } } } }),
      () => ({}),
    ]);
    expect(r).toMatchObject({ code: 0, out: "#12  Status = Ready" });
    expect(r.gh.calls).toHaveLength(2);
  });
});

describe("request with BACKLOG_URL", () => {
  // a fake app that numbers what it creates (a backlog kept in the app) unless told it waits to be sent (GitHub's)
  function fakeApp(numbered: boolean) {
    const posts: unknown[] = [];
    const sync = { workspaceId: "ws_1", repository: "example/repo", syncedAt: 1, syncing: false, sync: { state: "synced", reason: null, pendingCount: 0 } };
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const path = new URL(req.url).pathname.replace(/^\/api\/backlog/, "");
        if (req.method === "POST" && path === "") {
          posts.push(await req.json());
          return Response.json({ localId: "loc_1", number: numbered ? 77 : null });
        }
        return Response.json({ syncs: [sync], items: [] });
      },
    });
    const env = { ...process.env, BACKLOG_URL: `http://127.0.0.1:${server.port}/api/backlog`, BACKLOG_TOKEN_FILE: undefined, BACKLOG_WORKSPACE: undefined, GH_REPO: "example/repo" };
    return { posts, env, stop: () => server.stop(true) };
  }
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "ops-kit.request-app."))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const body = "## 要望\n整えた文\n\n## 出典\n- 誰の言葉: 定期の検査\n- いつ: 2026-01-01\n";

  test("is stored in the app as a type:request in Backlog, never created with gh, and keeps the 要望を作成 line", async () => {
    const app = fakeApp(true);
    try {
      writeFileSync(join(dir, "req.md"), body);
      const gh = fakeGh([]);
      const out: string[] = [];
      expect(await main(["request", "モデル一覧のズレ", join(dir, "req.md"), "--config", config], gh, (s) => out.push(s), () => {}, async () => {}, app.env)).toBe(0);
      expect(app.posts).toEqual([{ workspaceId: "ws_1", title: "モデル一覧のズレ", body, labels: ["type:request"], milestone: null, parent: null, fields: { Status: "Backlog" } }]);
      expect(out).toEqual([">> 要望を作成: #77（アプリに保存）"]);
      expect(gh.calls).toHaveLength(0);
    } finally {
      app.stop();
    }
  });

  test("waiting to be sent to GitHub: no number yet, so no 要望を作成 line", async () => {
    const app = fakeApp(false);
    try {
      writeFileSync(join(dir, "req.md"), body);
      const out: string[] = [];
      expect(await main(["request", "t", join(dir, "req.md"), "--config", config], fakeGh([]), (s) => out.push(s), () => {}, async () => {}, app.env)).toBe(0);
      expect(out.join("\n")).toContain("送信待ち");
      expect(out.join("\n")).not.toContain("要望を作成");
    } finally {
      app.stop();
    }
  });

  test("a body without the required sections is refused before the app is asked", async () => {
    const app = fakeApp(true);
    try {
      writeFileSync(join(dir, "req.md"), "## 要望\n整えた文\n");
      const err: string[] = [];
      expect(await main(["request", "t", join(dir, "req.md"), "--config", config], fakeGh([]), () => {}, (s) => err.push(s), async () => {}, app.env)).toBe(1);
      expect(err.join("\n")).toContain("## 出典");
      expect(app.posts).toHaveLength(0);
    } finally {
      app.stop();
    }
  });
});

describe("backlog without BACKLOG_URL (#3071)", () => {
  // the same two Issues, stored in a fake app and answered by a fake GitHub
  const pbi = { number: 12, title: "PBI: 題", state: "OPEN", labels: ["type:pbi", "area:one"], body: "本文の行", url: "https://github.com/example/repo/issues/12", milestone: "Phase 0 — 始まり", parent: null };
  const task = { number: 13, title: "Task: 実装", state: "OPEN", labels: ["type:task"], body: "", url: "", milestone: null, parent: 12 };
  const comment = { id: "IC_1", body: "## 回答\nはい", createdAt: "2026-10-29T00:00:00Z" };
  const later = { id: "IC_101", body: "## 回答\n最新", createdAt: "2026-10-30T00:00:00Z" };
  const fields = { Status: "Ready", "Story Points": 5, Notes: "メモ", Due: "2026-11-01" };
  function fakeApp() {
    const sync = { workspaceId: "ws_1", repository: "example/repo", syncedAt: 1, syncing: false, sync: { state: "synced", reason: null, pendingCount: 0 } };
    const stored = (i: typeof pbi | typeof task, f: Record<string, string | number> | null) => ({ number: i.number, title: i.title, state: i.state, stateReason: null, body: i.body, labels: i.labels, parent: i.parent, subIssues: [], updatedAt: "", fields: f });
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname.replace(/^\/api\/backlog/, "");
        if (path === "") return Response.json({ syncs: [sync], items: [] });
        if (path === "/records") return Response.json({ workspaceId: "ws_1", service: "github", repository: "example/repo", project: { owner: "example", number: 1 }, fetchedAt: 1, top: [], unread: [], pulls: [], issues: [stored(task, null), stored(pbi, fields)] });
        return Response.json({ issue: { ...pbi, milestone: pbi.milestone }, comments: [comment, later], fields, fetchedAt: 1, localId: null, pending: 0, sync: { state: "synced", reason: null, lastSuccessfulSync: 1 } });
      },
    });
    return { url: `http://127.0.0.1:${server.port}/api/backlog`, stop: () => server.stop(true) };
  }
  // another Project, and another owner's Project of the same number, come first: only example/1 is read
  const items = (f: Record<string, string | number> | null) => ({
    nodes: [
      { project: { number: 7, owner: { login: "example" } }, fieldValues: { nodes: [{ name: "Done", field: { name: "Status" } }] } },
      { project: { number: 1, owner: { login: "other" } }, fieldValues: { nodes: [{ name: "Done", field: { name: "Status" } }] } },
      ...(f ? [{ project: { number: 1, owner: { login: "Example" } }, fieldValues: { nodes: [{ name: f.Status, field: { name: "Status" } }, { number: f["Story Points"], field: { name: "Story Points" } }, { text: f.Notes, field: { name: "Notes" } }, { date: f.Due, field: { name: "Due" } }, {}] } }] : []),
    ],
  });
  const ghIssue = (i: typeof pbi | typeof task, f: Record<string, string | number> | null) => ({ number: i.number, title: i.title, state: i.state, labels: { nodes: i.labels.map((name) => ({ name })) }, projectItems: items(f) });
  const graphql = (c: FakeCall | undefined) => (c?.kind === "graphql" ? c : null);
  const cli = async (argv: string[], env: Record<string, string | undefined>, responses: Parameters<typeof fakeGh>[0]) => {
    const out: string[] = [];
    const err: string[] = [];
    const gh = fakeGh(responses);
    const code = await main([...argv, "--config", config], gh, (s) => out.push(s), (s) => err.push(s), async () => {}, { ...process.env, BACKLOG_TOKEN_FILE: undefined, BACKLOG_WORKSPACE: undefined, GH_REPO: "example/repo", EXAMPLE_PROJECT_URL: undefined, ...env });
    return { code, lines: out.join("\n").split("\n"), err: err.join("\n"), gh };
  };

  test("list and view read GitHub itself and show what the app shows for the same Issues", async () => {
    const app = fakeApp();
    try {
      // GitHub's word search is wider than a part of the title: #13 comes back and is filtered out as in the app
      const search = () => ({ search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [ghIssue(task, null), ghIssue(pbi, fields), {}] } });
      const direct = await cli(["backlog", "list", "--label", "type:pbi"], { BACKLOG_URL: undefined }, [search]);
      const stored = await cli(["backlog", "list", "--label", "type:pbi"], { BACKLOG_URL: app.url }, []);
      expect([direct.code, stored.code]).toEqual([0, 0]);
      expect(direct.lines[0]).toBe("# example/repo  GitHub から直接（アプリの保存値ではない）");
      expect(direct.lines.slice(1)).toEqual(["#12\tpbi\tOPEN\tReady\tPBI: 題"]);
      expect(direct.lines.slice(1)).toEqual(stored.lines.slice(1));
      // by number on both: GitHub's search order and the app's stored order are not
      const both = () => ({ search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [ghIssue(pbi, fields), ghIssue(task, null)] } });
      expect((await cli(["backlog", "list"], { BACKLOG_URL: undefined }, [both])).lines.slice(1)).toEqual((await cli(["backlog", "list"], { BACKLOG_URL: app.url }, [])).lines.slice(1));
      expect(graphql(direct.gh.calls[0])?.vars.q).toBe('repo:example/repo is:issue is:open label:"type:pbi"');
      expect(stored.gh.calls).toHaveLength(0);
      // --json: the same items, said to be GitHub's
      const json = await cli(["backlog", "list", "--state", "all", "--search", "題", "--json"], { BACKLOG_URL: undefined }, [search]);
      expect(JSON.parse(json.lines.join("\n"))).toEqual({ repository: "example/repo", source: "github", items: [{ number: 12, type: "pbi", state: "OPEN", status: "Ready", title: "PBI: 題", labels: ["type:pbi", "area:one"] }] });
      expect(graphql(json.gh.calls[0])?.vars.q).toBe('repo:example/repo is:issue "題" in:title');

      // the comments past the first page are read too
      const issue = () => ({ repository: { issue: { ...ghIssue(pbi, fields), body: pbi.body, url: pbi.url, milestone: { title: pbi.milestone }, parent: null, comments: { pageInfo: { hasNextPage: true, endCursor: "c100" }, nodes: [comment] } } } });
      const page2 = () => ({ repository: { issue: { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [later] } } } });
      const view = await cli(["backlog", "view", "12"], { BACKLOG_URL: undefined }, [issue, page2]);
      const viewStored = await cli(["backlog", "view", "12"], { BACKLOG_URL: app.url }, []);
      expect([view.code, viewStored.code]).toEqual([0, 0]);
      // the title, labels and fields lines, the body and the comments: the same; only the freshness line differs
      expect(view.lines.slice(0, 3)).toEqual(viewStored.lines.slice(0, 3));
      expect(view.lines.slice(4)).toEqual(viewStored.lines.slice(4));
      expect(view.lines[2]).toBe("fields: Status=Ready, Story Points=5, Notes=メモ, Due=2026-11-01");
      expect(view.lines.slice(-2)).toEqual(["## 回答", "最新"]);
      expect(graphql(view.gh.calls[1])?.vars).toEqual({ o: "example", n: "repo", num: 12, after: "c100" });
      expect(view.lines[3]).toContain("同期 github  送信待ち 0");
      expect(graphql(view.gh.calls[0])?.vars).toEqual({ o: "example", n: "repo", num: 12, after: null });
    } finally {
      app.stop();
    }
  });

  test("without a Project, Status is -; --workspace is refused", async () => {
    const noProject = join(mkdtempSync(join(tmpdir(), "ops-kit.no-project.")), "ops.config.json");
    try {
      const cfg = JSON.parse(readFileSync(config, "utf8"));
      delete cfg.projectUrl;
      writeFileSync(noProject, JSON.stringify(cfg));
      const out: string[] = [];
      // the variable that names the Project is not there: no Project, and the search asks for no Project fields
      const gh = fakeGh([() => { throw new Error("variable not found"); }, () => ({ search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [ghIssue(pbi, null)] } })]);
      expect(await main(["backlog", "list", "--config", noProject], gh, (s) => out.push(s), () => {}, async () => {}, { ...process.env, BACKLOG_URL: undefined, GH_REPO: "example/repo", EXAMPLE_PROJECT_URL: undefined })).toBe(0);
      expect(out.slice(1)).toEqual(["#12\tpbi\tOPEN\t-\tPBI: 題"]);
      expect(graphql(gh.calls[1])?.query).toContain("search(");
      expect(graphql(gh.calls[1])?.query).not.toContain("projectItems");
    } finally {
      rmSync(dirname(noProject), { recursive: true, force: true });
    }
    const ws = await cli(["backlog", "list", "--workspace", "ws_1"], { BACKLOG_URL: undefined }, []);
    expect([ws.code, ws.gh.calls.length]).toEqual([1, 0]);

  });

  test("a Project of @me is the signed-in user's: another owner's Project of the same number is not read", async () => {
    const mine = join(mkdtempSync(join(tmpdir(), "ops-kit.me-project.")), "ops.config.json");
    try {
      writeFileSync(mine, JSON.stringify({ ...JSON.parse(readFileSync(config, "utf8")), owner: "@me" }));
      const project = (owner: string, status: string) => ({ project: { number: 1, owner: { login: owner } }, fieldValues: { nodes: [{ name: status, field: { name: "Status" } }] } });
      const gh = fakeGh([() => ({ viewer: { login: "Me" }, search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ ...ghIssue(pbi, null), projectItems: { nodes: [project("other", "Done"), project("me", "Ready")] } }] } })]);
      const out: string[] = [];
      expect(await main(["backlog", "list", "--config", mine], gh, (s) => out.push(s), () => {}, async () => {}, { ...process.env, BACKLOG_URL: undefined, GH_REPO: "example/repo", EXAMPLE_PROJECT_URL: undefined, EXAMPLE_PROJECT_OWNER: undefined })).toBe(0);
      expect(out.slice(1)).toEqual(["#12\tpbi\tOPEN\tReady\tPBI: 題"]);
      expect(graphql(gh.calls[0])?.query).toContain("viewer{ login }");
    } finally {
      rmSync(dirname(mine), { recursive: true, force: true });
    }
  });

  test("create / edit / comment / set / triage write GitHub with gh and answer the lines the app's answers give", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ops-kit.backlog-write."));
    try {
      writeFileSync(join(dir, "body.md"), "作る本文");
      const runOf = (c: FakeCall) => (c.kind === "run" ? c.args : []);
      // the body goes in a file gh reads while it runs: read it there
      const bodies: string[] = [];
      const readBody = (c: FakeCall) => {
        const args = runOf(c);
        const at = args.indexOf("--body-file");
        if (at >= 0) bodies.push(readFileSync(args[at + 1]!, "utf8"));
      };
      const projectAndIssue = (id: string) => ({ repositoryOwner: { projectV2: { id: "P1", field: { id: "F1", dataType: "SINGLE_SELECT", options: [{ id: "O2", name: "Ready" }] } } }, repository: { issue: { id, projectItems: { nodes: [{ id: "IT1", project: { number: 1 } }] } } } });

      const create = await cli(["backlog", "create", "--title", "PBI: 新しい", "--body-file", join(dir, "body.md"), "--label", "type:pbi", "--milestone", "Phase 0 — 始まり", "--parent", "3", "--field", "Status=Ready"], { BACKLOG_URL: undefined }, [
        (c) => (readBody(c), "https://github.com/example/repo/issues/21\n"),
        () => ({ repository: { child: { id: "I21", parent: null }, parent: { id: "I3" } } }),
        () => ({}),
        () => projectAndIssue("I21"),
        () => ({}),
      ]);
      expect([create.code, create.lines]).toEqual([0, ["#21 を作りました（GitHub）"]]);
      // the line `request` and scripts/file-request.ts read
      expect(create.lines[0]).toMatch(/^#(\d+) を作りました/);
      expect(runOf(create.gh.calls[0]!).filter((a) => !a.includes("ops-kit.backlog-body."))).toEqual(["issue", "create", "-R", "example/repo", "--title", "PBI: 新しい", "--body-file", "--label", "type:pbi", "--milestone", "Phase 0 — 始まり"]);
      expect(graphql(create.gh.calls[2])?.query).toContain("addSubIssue");
      expect(graphql(create.gh.calls[2])?.vars).toEqual({ p: "I3", c: "I21", r: true });
      expect(graphql(create.gh.calls[4])?.query).toContain("updateProjectV2ItemFieldValue");
      expect(create.err).toContain("#21  Status = Ready");

      const edit = await cli(["backlog", "edit", "12", "--title", "新しい題", "--add-label", "area:two", "--remove-label", "area:one", "--state", "closed", "--no-milestone"], { BACKLOG_URL: undefined }, [() => "", () => ""]);
      expect([edit.code, edit.lines]).toEqual([0, ["#12 を保存しました"]]);
      expect(edit.gh.calls.map(runOf)).toEqual([
        ["issue", "edit", "12", "-R", "example/repo", "--title", "新しい題", "--add-label", "area:two", "--remove-label", "area:one", "--remove-milestone"],
        ["issue", "close", "12", "-R", "example/repo"],
      ]);
      const parentless = await cli(["backlog", "edit", "13", "--body-file", join(dir, "body.md"), "--state", "open", "--no-parent"], { BACKLOG_URL: undefined }, [readBody, () => "", () => ({ repository: { child: { id: "I13", parent: { id: "I12" } } } }), () => ({})]);
      expect(parentless.code).toBe(0);
      expect(runOf(parentless.gh.calls[1]!)).toEqual(["issue", "reopen", "13", "-R", "example/repo"]);
      expect(graphql(parentless.gh.calls[3])?.query).toContain("removeSubIssue");
      expect(graphql(parentless.gh.calls[3])?.vars).toEqual({ p: "I12", c: "I13" });

      const comment = await cli(["backlog", "comment", "12", "--body-file", join(dir, "body.md")], { BACKLOG_URL: undefined }, [(c) => (readBody(c), "")]);
      expect([comment.code, comment.lines]).toEqual([0, ["#12 にコメントを保存しました"]]);
      expect(runOf(comment.gh.calls[0]!).slice(0, 5)).toEqual(["issue", "comment", "12", "-R", "example/repo"]);
      expect(bodies).toEqual(["作る本文", "作る本文", "作る本文"]);

      const set = await cli(["backlog", "set", "12", "Status", "Ready"], { BACKLOG_URL: undefined }, [() => projectAndIssue("I12"), () => ({})]);
      expect([set.code, set.lines]).toEqual([0, ["#12 を保存しました"]]);
      expect(graphql(set.gh.calls[1])?.vars).toMatchObject({ p: "P1", i: "IT1", f: "F1", value: "O2" });

      const select = (name: string, value: string) => ({ id: `F_${name}`, name, options: [{ id: `O_${value}`, name: value }] });
      const triage = await cli(["backlog", "triage", "12", "one", "bug", "P1", "Phase 0", "", "Ready"], { BACKLOG_URL: undefined }, [
        () => ({ repositoryOwner: { projectV2: { id: "P1", fields: { nodes: [select("Area", "one"), select("Kind", "bug"), select("Priority", "P1"), select("Phase", "Phase 0"), select("Status", "Ready")] } } }, repository: { issue: { id: "I12", projectItems: { nodes: [{ id: "IT1", project: { number: 1 } }] } } } }),
        () => ({}),
      ]);
      expect([triage.code, triage.lines]).toEqual([0, ["#12 を保存しました"]]);
      expect(graphql(triage.gh.calls[1])?.vars).toMatchObject({ o0: "O_one", o1: "O_bug", o2: "O_P1", o3: "O_Phase 0", o4: "O_Ready" });

      // a value that signs in is refused before gh is asked
      writeFileSync(join(dir, "secret.md"), "ghp_" + "a".repeat(36));
      for (const argv of [["backlog", "create", "--title", "t", "--body-file", join(dir, "secret.md")], ["backlog", "comment", "12", "--body-file", join(dir, "secret.md")], ["backlog", "edit", "12", "--body-file", join(dir, "secret.md")]]) {
        const r = await cli(argv, { BACKLOG_URL: undefined }, []);
        expect([r.code, r.gh.calls.length]).toEqual([1, 0]);
      }
      // triage's values too: one that signs in never reaches gh, nor the lines it prints
      const token = "ghp_" + "a".repeat(36);
      const secret = await cli(["backlog", "triage", "12", token, "bug", "P1", "Phase 0"], { BACKLOG_URL: undefined }, []);
      expect([secret.code, secret.gh.calls.length, secret.err.includes(token)]).toEqual([1, 0, false]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("set / triage / --field without a Project in ops.config.json are refused, and nothing is written", async () => {
    const noProject = join(mkdtempSync(join(tmpdir(), "ops-kit.no-project.")), "ops.config.json");
    try {
      const cfg = JSON.parse(readFileSync(config, "utf8"));
      delete cfg.projectUrl;
      writeFileSync(noProject, JSON.stringify(cfg));
      const novar = () => {
        throw new Error("variable not found");
      };
      for (const argv of [["backlog", "set", "12", "Status", "Ready"], ["backlog", "triage", "12", "one", "bug", "P1", "Phase 0"], ["backlog", "create", "--title", "t", "--field", "Status=Ready"]]) {
        const gh = fakeGh([novar]);
        const err: string[] = [];
        expect(await main([...argv, "--config", noProject], gh, () => {}, (s) => err.push(s), async () => {}, { ...process.env, BACKLOG_URL: undefined, GH_REPO: "example/repo", EXAMPLE_PROJECT_URL: undefined })).toBe(1);
        expect(err.join("\n")).toContain("ops.config.json");
        // only the read of the variable that would name the Project
        expect(gh.calls.map((c) => c.kind === "run" && c.args[0])).toEqual(["variable"]);
      }
    } finally {
      rmSync(dirname(noProject), { recursive: true, force: true });
    }
    // a Project URL that cannot be read is refused before the Issue is created
    const bad = await cli(["backlog", "create", "--title", "t", "--field", "Status=Ready"], { BACKLOG_URL: undefined, EXAMPLE_PROJECT_URL: "https://example.com/not-a-project" }, []);
    expect([bad.code, bad.gh.calls.length]).toEqual([1, 0]);
    expect(bad.err).toContain("Project の URL が読めません");
  });

  test("an app that cannot be reached is not replaced by GitHub (exit 2, no gh call)", async () => {
    for (const argv of [["backlog", "list"], ["backlog", "view", "12"], ["backlog", "comment", "12", "--body-file", config], ["backlog", "set", "12", "Status", "Ready"], ["backlog", "triage", "12", "one", "bug", "P1", "Phase 0"]]) {
      const r = await cli(argv, { BACKLOG_URL: "http://127.0.0.1:1/api/backlog" }, []);
      expect(r.code).toBe(2);
      expect(r.err).toContain("アプリに届きません");
      expect(r.gh.calls).toHaveLength(0);
    }
  });
});
