/**
 * bun scripts/release-smoke.ts <owner/name> [--api <Releases API base URL>] — install the newest Release of a
 * repository the way README's "Use it" says, on this machine but as a machine without git would, and see it run:
 * the Release's source tarball is unpacked into a temporary HOME, `bun rescue/install.ts --source <owner/name>` builds
 * it there with a PATH that has no git, sb-rescue is started from it on two free ports, and `/api/health` must answer
 * ok and the rescue page 200. Everything is stopped and removed afterwards. Exit 0 = pass, 1 = fail, 2 = usage.
 * The last line is `[release-smoke] pass|fail <tag> <sha>` (`resultLine`), a mark in the form of the tag CI's.
 *
 * Why: the development host runs from its own clone and never takes this path, so a Release that cannot be installed
 * without git would go unnoticed there. This is the check to run against the real Release after a public sync made it.
 * It is an entry point of its own: the public sync does not call it (see docs/design/local-container.md, "Check it").
 *
 * `smokeRelease` takes everything it touches as `deps`, so its test runs it against a fake Releases API with no
 * process started; the defaults below are the real ones.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

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

export function parseArgs(args: string[]): { repo: string; api?: string } | null {
  const at = args.indexOf("--api");
  const api = at >= 0 ? args[at + 1] : undefined;
  const rest = at >= 0 ? [...args.slice(0, at), ...args.slice(at + 2)] : args;
  if (rest.length !== 1 || !SOURCE.test(rest[0]!) || (at >= 0 && (!api || !/^https?:\/\//.test(api)))) return null;
  return { repo: rest[0]!, ...(api ? { api } : {}) };
}

if (import.meta.main) {
  const a = parseArgs(process.argv.slice(2));
  if (!a) {
    console.error("usage: bun scripts/release-smoke.ts <owner/name> [--api <Releases API base URL>]");
    process.exit(2);
  }
  const r = await smokeRelease({ ...a, waitMs: 300_000 }, realDeps());
  for (const s of r.steps) console.log(`✓ ${s}`);
  if (r.reason) console.log(`✗ ${r.reason}`);
  console.log(resultLine(r));
  process.exit(r.ok ? 0 : 1);
}
