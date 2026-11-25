/**
 * bun scripts/release-smoke.ts <owner/name> [--api <Releases API base URL>] [--record <development tag>] — install the newest Release of a
 * repository the way README's "Use it" says, on this machine but as a machine without git would, and see it run:
 * the Release's source tarball is unpacked into a temporary HOME, `bun rescue/install.ts --source <owner/name>` builds
 * it there with a PATH that has no git, sb-rescue is started from it on two free ports, and `/api/health` must answer
 * ok and the rescue page 200. Everything is stopped and removed afterwards. Exit 0 = pass, 1 = fail, 2 = usage.
 * The last line is `[release-smoke] pass|fail <tag> <sha>` (`resultLine`), a mark in the form of the tag CI's.
 * The build and the daemon run inside a heavy slot of this machine.
 *
 * `--record <development tag>` (`recordSmoke`) also writes that line into the body of the Release of the development
 * tag, in this clone's origin (the same place as the tag CI's `[tag-ci]` mark; a line of the same public tag is
 * replaced, not doubled), and on a fail files a request (scripts/file-request.ts, the tag CI's way: a comment on the
 * open request with the same title, if there is one).
 *
 * Why: the development host runs from its own clone and never takes this path, so a Release that cannot be installed
 * without git would go unnoticed there. This is the check to run against the real Release after a public sync made it.
 * The scheduled public sync calls it after a sync that ended 0, in a repository that has this script (the shared
 * `ops-kit public-sync` knows nothing of it; see docs/design/schedule-samples.md, "Public repository sync").
 *
 * `smokeRelease` and `recordSmoke` take everything they touch as `deps`, so their tests run against a fake Releases
 * API and fake writes with no process started; the defaults below are the real ones.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { withHeavySlot } from "../ops-kit/src/heavy.ts";
import { findSecrets, hostAws } from "../ops-kit/src/secrets.ts";
import { type Filed, commentRequest, fileRequest, requestText } from "./file-request.ts";
import { must, spawnSh, withReleaseLock } from "./release-tag.ts";
import { currentRepo } from "./repo.ts";
import { hidePaths } from "./tag-ci.ts";

export interface SmokeDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Run to the end; `output` is stdout and stderr together. */
  run: (argv: string[], o: { cwd: string; env: Record<string, string> }) => Promise<{ code: number; output: string }>;
  /** Start and leave running; `kill` stops it and resolves once it is gone. `exited` resolves with its code if it ends by itself. */
  spawn: (argv: string[], o: { cwd: string; env: Record<string, string> }) => { kill: () => Promise<void>; exited: Promise<number | null> };
  /** A new empty directory for the temporary HOME, and its removal. */
  tmp: () => string;
  remove: (dir: string) => void;
  /** A directory to use as the whole PATH: every command of this machine but git. */
  gitlessPath: (dir: string) => string;
  /** The path `command` resolves to on `path`, or null. */
  which: (command: string, path: string) => string | null;
  freePort: () => Promise<number>;
  sleep: (ms: number) => Promise<void>;
  bun: string;
}

export interface SmokeResult { ok: boolean; tag: string | null; sha: string | null; /** What was seen, in order. */ steps: string[]; /** Why it failed (null on a pass). */ reason: string | null }

const SOURCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TAG = /^v\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;
export const GITHUB_API = "https://api.github.com";

/** The mark of a result: one line, the same shape as the tag CI's `[tag-ci] pass|fail <sha>`. */
export const resultLine = (r: Pick<SmokeResult, "ok" | "tag" | "sha">): string => `[release-smoke] ${r.ok ? "pass" : "fail"} ${r.tag ?? "-"} ${r.sha ?? "-"}`;

/**
 * Link every command on `path` into `dir` except git and its helpers (`git`, `git-*`), first directory first as PATH
 * resolves them, and return `dir`: a PATH on which this machine has no git.
 */
export function gitlessPath(dir: string, path = process.env.PATH ?? ""): string {
  mkdirSync(dir, { recursive: true });
  for (const from of path.split(delimiter).filter(Boolean)) {
    let names: string[];
    try {
      names = readdirSync(from);
    } catch {
      continue; // a PATH entry that does not exist
    }
    for (const name of names) {
      if (name === "git" || name.startsWith("git-") || existsSync(join(dir, name))) continue;
      try {
        if (statSync(join(from, name)).isFile()) symlinkSync(join(from, name), join(dir, name));
      } catch {
        // a dangling link in a PATH directory: not a command
      }
    }
  }
  return dir;
}

/**
 * Install the newest Release of `repo` from the Releases API at `api` into a temporary HOME with no git on PATH, start
 * it under sb-rescue and check `/api/health` and the rescue page. `waitMs`: how long the two may take to answer.
 */
export async function smokeRelease(o: { repo: string; api?: string; waitMs?: number; pollMs?: number }, deps: SmokeDeps): Promise<SmokeResult> {
  const steps: string[] = [];
  let tag: string | null = null;
  let sha: string | null = null;
  const fail = (reason: string): SmokeResult => ({ ok: false, tag, sha, steps, reason });
  if (!SOURCE.test(o.repo)) return fail(`not an owner/name: ${o.repo}`);
  const api = (o.api ?? GITHUB_API).replace(/\/+$/, "");
  const home = deps.tmp();
  let rescue: ReturnType<SmokeDeps["spawn"]> | null = null;
  try {
    const json = async (url: string) => {
      const r = await deps.fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "switchboard-release-smoke" } });
      if (!r.ok) throw new Error(`GET ${url} returned ${r.status}`);
      return (await r.json()) as Record<string, unknown>;
    };
    const latest = (await json(`${api}/repos/${o.repo}/releases/latest`)).tag_name;
    if (typeof latest !== "string" || !TAG.test(latest)) return fail(`the latest Release of ${o.repo} is not a version tag: ${String(latest)}`);
    tag = latest;
    const commit = (await json(`${api}/repos/${o.repo}/commits/${tag}`)).sha;
    if (typeof commit !== "string" || !SHA.test(commit)) return fail(`${tag} of ${o.repo} has no commit`);
    sha = commit;
    steps.push(`latest Release: ${tag} (${sha.slice(0, 7)})`);

    const path = deps.gitlessPath(join(home, "bin"));
    const git = deps.which("git", path);
    if (git) return fail(`the PATH for the install still has git (${git}): the check would not see a missing git`);
    // HOME and PATH only: nothing of this machine's Switchboard (its home, its ports, its clone) reaches the install
    const env: Record<string, string> = { HOME: home, PATH: path, ...(o.api ? { SWITCHBOARD_GITHUB_API: api } : {}) };

    // step 1 of "Use it": the Release's source tarball, unpacked
    const src = join(home, "switchboard-src");
    mkdirSync(src, { recursive: true });
    const tarball = await deps.fetch(`${api}/repos/${o.repo}/tarball/${tag}`, { headers: { "user-agent": "switchboard-release-smoke" } });
    if (!tarball.ok) return fail(`the tarball of ${tag} returned ${tarball.status}`);
    writeFileSync(join(home, "src.tar.gz"), new Uint8Array(await tarball.arrayBuffer()));
    const unpack = await deps.run(["tar", "-xzf", join(home, "src.tar.gz"), "-C", src, "--strip-components=1"], { cwd: home, env });
    if (unpack.code !== 0) return fail(`the tarball of ${tag} did not unpack: ${unpack.output.trim().slice(-500)}`);
    steps.push("tarball unpacked");

    // step 2: the installer builds the newest Release under the temporary HOME
    const install = await deps.run([deps.bun, "rescue/install.ts", "--source", o.repo], { cwd: src, env });
    if (install.code !== 0) return fail(`rescue/install.ts --source ${o.repo} exited ${install.code}: ${install.output.trim().slice(-1500)}`);
    steps.push("installed without git");

    // step 3: sb-rescue from the install, on ports of its own
    const port = await deps.freePort();
    const rescuePort = await deps.freePort();
    rescue = deps.spawn([deps.bun, join(home, ".switchboard", "rescue", "sb-rescue.js")], { cwd: home, env: { ...env, SWITCHBOARD_PORT: String(port), SWITCHBOARD_RESCUE_PORT: String(rescuePort) } });
    let ended: number | null | undefined;
    void rescue.exited.then((code) => (ended = code));
    const end = Date.now() + (o.waitMs ?? 120_000);
    let health = "no answer";
    let page = "no answer";
    for (;;) {
      health = await deps.fetch(`http://127.0.0.1:${port}/api/health`).then(async (r) => (r.ok && ((await r.json()) as { ok?: unknown }).ok === true ? "ok" : `status ${r.status}`), (e) => `no answer (${String((e as Error).message ?? e)})`);
      page = await deps.fetch(`http://127.0.0.1:${rescuePort}/`).then((r) => (r.status === 200 ? "200" : `status ${r.status}`), (e) => `no answer (${String((e as Error).message ?? e)})`);
      if (health === "ok" && page === "200") break;
      if (ended !== undefined) return fail(`sb-rescue exited (${ended}) before the daemon answered`);
      if (Date.now() >= end) return fail(`not up in time: /api/health ${health}, the rescue page ${page}`);
      await deps.sleep(o.pollMs ?? 500);
    }
    steps.push("/api/health ok", "rescue page 200");
    return { ok: true, tag, sha, steps, reason: null };
  } catch (e) {
    return fail(String((e as Error).message ?? e));
  } finally {
    if (rescue) await rescue.kill().catch(() => undefined);
    deps.remove(home);
  }
}

/** The line of a result in a Release's body, whatever its tag and commit: the pattern `recordLine` replaces. */
const MARK = /^\[release-smoke\] (?:pass|fail) (\S+) (\S+)[ \t]*$/gm;
export const RECORD_HEADING = "## 公開の Release の確かめ";

/**
 * The Release body with `line` in it: the line of the same public tag (or the same `-` of a Release that was not found)
 * is replaced in place, any other stays, and a body with none gets the line under its own heading at the end.
 */
export function recordLine(body: string, line: string): string {
  const tag = /^\[release-smoke\] (?:pass|fail) (\S+)/.exec(line)![1]!;
  let found = false;
  const out = body.replace(MARK, (all, t: string) => {
    if (t !== tag) return all;
    if (found) return "\u0000";
    found = true;
    return line;
  });
  if (found) return out.replace(/\u0000\n?/g, "");
  return `${body.trimEnd()}\n\n${RECORD_HEADING}\n${line}\n`.trimStart();
}

/** The title of the request for a public Release that did not come up: the same for the same public tag. */
export const requestTitleOf = (publicTag: string | null): string => `公開の Release が入らない: ${publicTag ?? "-"}`;

/** The request for a failed result. The reason is without host paths, and left out when it holds a value usable for auth. */
export function failureRequest(r: SmokeResult, devTag: string, repo: string, date = new Date().toISOString().slice(0, 10)): { title: string; body: string } {
  const reason = hidePaths(r.reason ?? "");
  const detail = findSecrets(reason, hostAws()).length === 0 ? reason : "（理由に認証に使える値が含まれるので書かない。実行したホストの出力を見る）";
  const body = [
    "## 要望",
    `公開の同期が出した Release ${r.tag ?? "（見つからない）"} が、README の「Use it」と同じに git の無い環境で入れて起動できなかった。直してほしい（この要望は直した PBI が閉じる）。`,
    "",
    "````text",
    `公開の Release: ${r.tag ?? "-"}（${r.sha?.slice(0, 7) ?? "-"}）`,
    `同期した開発元のタグ: ${devTag}（${repo}）`,
    ...r.steps.map((s) => `見えたこと: ${s}`),
    `落ちた理由: ${detail}`,
    "````",
    "",
    `結果の行は開発元のタグの Release の本文にある（\`gh release view ${devTag} -R ${repo} --json body -q .body\`）。`,
    "",
    "## 出典",
    "- 誰の言葉: 定期の検査",
    `- いつ: ${date}`,
    "- 経路: 公開の同期の後の確かめ（scripts/release-smoke.ts）",
    "",
    "## 添付",
    "なし",
    "",
    "## 派生 PBI",
    "",
    "## 解釈メモ",
    "- 同じ公開のタグの失敗は同じ題になる。次の同期の後も同じタグで落ちればこの要望にコメントが付く（閉じない）",
  ].join("\n");
  return { title: requestTitleOf(r.tag), body };
}

export interface RecordDeps {
  /** The development repository (origin). */
  repo: string;
  /** The body of the Release of `tag` in `repo`, or null when it cannot be read. */
  readBody: (tag: string) => string | null;
  writeBody: (tag: string, body: string) => void;
  /** Read and write under one lock (the clone's release lock). */
  locked: <T>(fn: () => T) => T;
  file: (req: { title: string; body: string }) => Promise<Filed>;
  comment: (ref: string, body: string) => Promise<void>;
  /** An open request's body and comments. */
  text: (ref: string) => Promise<string>;
  log: (line: string) => void;
  date?: string;
}

/**
 * Write the result's line into the development tag's Release, and for a fail file a request or comment on the open one
 * with the same title (once per public tag). A Release that cannot be read is an error: the line is not written to a
 * body that was not read.
 */
export async function recordSmoke(r: SmokeResult, devTag: string, d: RecordDeps): Promise<void> {
  // a Release that cannot be read or written does not keep a fail from its request: the request is the durable record
  let unrecorded: unknown = null;
  try {
    d.locked(() => {
      const body = d.readBody(devTag);
      if (body === null) throw new Error(`the Release of ${devTag} in ${d.repo} cannot be read`);
      const next = recordLine(body, resultLine(r));
      if (next !== body) d.writeBody(devTag, next);
    });
    d.log(`${devTag} の Release に ${resultLine(r)} を書いた`);
  } catch (e) {
    unrecorded = e;
  }
  if (!r.ok) await fileFailure(r, devTag, d);
  if (unrecorded !== null) throw unrecorded;
}

async function fileFailure(r: SmokeResult, devTag: string, d: RecordDeps): Promise<void> {
  const req = failureRequest(r, devTag, d.repo, d.date);
  const filed = await d.file(req);
  if (!("open" in filed)) {
    d.log(`要望を立てた: ${filed.filed === null ? "番号不明" : `#${filed.filed}`}`);
    return;
  }
  const named = `${r.tag ?? "-"}（${r.sha?.slice(0, 7) ?? "-"}）`;
  if ((await d.text(filed.open)).includes(named)) return;
  await d.comment(filed.open, `${named}でも同じ失敗（開発元のタグ ${devTag}）`);
  d.log(`要望: 既存 ${filed.open} にコメントした（起票しない）`);
}

/** The real writes: gh on this clone's origin, under the release lock of this clone. */
export const realRecordDeps = (repo = currentRepo()): RecordDeps => ({
  repo,
  readBody: (tag) => {
    const r = spawnSh(["gh", "release", "view", tag, "-R", repo, "--json", "body", "-q", ".body"]);
    return r.ok ? r.out : null;
  },
  writeBody: (tag, body) => void must(spawnSh, ["gh", "release", "edit", tag, "-R", repo, "--notes-file", "-"], body),
  locked: (fn) => withReleaseLock(must(spawnSh, ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]), fn),
  file: (req) => fileRequest(req),
  comment: (ref, body) => commentRequest(ref, body),
  text: (ref) => requestText(ref),
  log: (l) => console.log(l),
});

/** The real machine: processes, the temp directory, the network. */
export const realDeps = (): SmokeDeps => ({
  fetch: (url, init) => fetch(url, init),
  async run(argv, o) {
    const p = Bun.spawn(argv, { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, output: out + err };
  },
  spawn(argv, o) {
    const p = Bun.spawn(argv, { cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    return {
      exited: p.exited,
      // SIGTERM: sb-rescue stops its daemon first
      async kill() {
        p.kill("SIGTERM");
        const hard = setTimeout(() => p.kill("SIGKILL"), 15_000);
        await p.exited;
        clearTimeout(hard);
      },
    };
  },
  tmp: () => {
    const dir = mkdtempSync(join(tmpdir(), "switchboard.release-smoke."));
    chmodSync(dir, 0o700);
    return dir;
  },
  remove: (dir) => rmSync(dir, { recursive: true, force: true }),
  gitlessPath: (dir) => gitlessPath(dir),
  which: (command, path) => Bun.which(command, { PATH: path }),
  async freePort() {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = s.port as number;
    await s.stop(true);
    return port;
  },
  sleep: (ms) => Bun.sleep(ms),
  bun: process.execPath,
});

export function parseArgs(args: string[]): { repo: string; api?: string; record?: string } | null {
  const rest = [...args];
  const take = (flag: string): string | undefined | null => {
    const at = rest.indexOf(flag);
    if (at < 0) return undefined;
    const v = rest[at + 1];
    rest.splice(at, v === undefined ? 1 : 2);
    return v ?? null;
  };
  const api = take("--api");
  const record = take("--record");
  if (rest.length !== 1 || !SOURCE.test(rest[0]!)) return null;
  if (api === null || (api !== undefined && !/^https?:\/\//.test(api))) return null;
  if (record === null || (record !== undefined && !TAG.test(record))) return null;
  return { repo: rest[0]!, ...(api ? { api } : {}), ...(record ? { record } : {}) };
}

if (import.meta.main) {
  const a = parseArgs(process.argv.slice(2));
  if (!a) {
    console.error("usage: bun scripts/release-smoke.ts <owner/name> [--api <Releases API base URL>] [--record <development tag>]");
    process.exit(2);
  }
  const r = await withHeavySlot("release-smoke", () => smokeRelease({ repo: a.repo, ...(a.api ? { api: a.api } : {}), waitMs: 300_000 }, realDeps()));
  for (const s of r.steps) console.log(`✓ ${s}`);
  if (r.reason) console.log(`✗ ${r.reason}`);
  let recorded = true;
  if (a.record) {
    try {
      await recordSmoke(r, a.record, realRecordDeps());
    } catch (e) {
      recorded = false;
      console.log(`✗ 結果を記録できなかった: ${(e as Error).message}`);
    }
  }
  console.log(resultLine(r));
  process.exit(r.ok && recorded ? 0 : 1);
}
