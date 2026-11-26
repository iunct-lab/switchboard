/**
 * The tools that run local-ci's steps off the host in one build (`sb-offload`, docs/design/local-ci-offload.md): the build's
 * script (`ciScript`, which writes the `sb-step:` marks), starting and collecting it (`runBuild`, `hostOffload`), the files a
 * perf build gives back (`buildFiles`) and the record of a build not yet written to its PR (`writePending` and the rest).
 * Reading the marks into each step's code (`parseBuild`), settling the result and the pass mark stay in scripts/local-ci.ts
 * (merge-gate's `security:gates`); this file is a support file (`security:gate-support`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { hostAws, type HostAws } from "../ops-kit/src/secrets.ts";
import type { Step } from "./ci.ts";
import { isPerfStep, quote, type StepsSource, type TestSelection } from "./local-ci.ts";
import { buildKey, fileLog, findReusable, offloadRecordPath, reusableOutput, type OffloadCaller, type OffloadLog } from "./offload-record.ts";

/** The size of an off-host build, `sb-offload --size`. */
export type OffloadSize = "small" | "medium" | "large";

/** What a build is given besides its script: its size, the directory of recordings (`--fixtures`), the file of the host's AWS names (`--names`, a path only: its content is in no script, argument or log) the tar of the tag a perf run compares with (`--base-tree`) and the tree whose container/Dockerfile is the ci image's source (`--image-root`; none = the work tree that is sent). */
export interface OffloadRun { size: OffloadSize; fixtures?: string; names?: string; baseTree?: string; imageRoot?: string }

/** `start` could not start the build: sb-offload's exit code and what it printed (`runBuild` hands it back as `notStarted`: no step ran, so it is nobody's failed step). */
export class OffloadStartError extends Error {
  constructor(readonly code: number, readonly output: string) {
    super(`sb-offload: ビルドを始められなかった（exit ${code}）`);
  }
}

/**
 * `start`: one build of `script` with `cwd`'s work tree in the ci image (`sb-offload --ci --detach`), returning its id as soon as it has started (throws `OffloadStartError` when it did not).
 * `collect`: waits for that build (`sb-offload --collect <id>`, from any process, later too): its code is sb-offload's (the script's, or 124 timed out / 130 stopped / 1 failed before it) and its log.
 * `start` also returns `image` (the id of the image build it had to start first) when there was one.
 * `fixtures`: the recordings the build reads (read only there) and whether the run needs them (`required`: `SWITCHBOARD_FIXTURES` given here, so a missing recording fails a test).
 */
export interface Offload {
  fixtures?: { dir: string; required: boolean };
  start: (script: string, cwd: string, o: OffloadRun) => Promise<{ build: string; image?: string }>;
  /** 外のビルドを始めるたびに 1 行足す記録（`hostOffload` だけが持つ。無ければ記録も入力の鍵の計算もしない）。 */
  log?: OffloadLog;
  collect: (build: string) => Promise<{ code: number; output: string }>;
  /** Whether the installed `sb-offload` takes `flag` (`--base-tree`, `--image-root`: its usage names it; the host's is replaced only at boot, so an older one may not). Not given = it does. */
  knows?: (flag: string) => Promise<boolean>;
}

/** Written by the steps' script before anything else, on the tmpfs the root script mounts (the steps' user can write it, the root shell reads it). */
const STARTED = "/sb/tmp/sb-started";

/**
 * One build's script, run by `sb-offload --ci` in the ci image (git with PCRE, Bun, Codex CLI, Chromium are the image's):
 * as root, a tmpfs TMPDIR and the work tree's owner; then, in a new PID namespace, as the image's user `switchboard` (a login `su -`, so the
 * build's own environment, its credentials included, does not reach the steps; only the image's CHROME_BIN and
 * PLAYWRIGHT_BROWSERS_PATH are passed) the work tree as one commit with `origin` (a URL, no credentials), the install (only a tree with a `package.json`),
 * and every step in `bash -e -c` between its marks, stopping at the first that fails (a `keepGoing` step does not stop it).
 * `fixtures`: the build has the recordings in the user's `~/.switchboard/fixtures`; `required` exports SWITCHBOARD_FIXTURES so that a missing recording fails a test.
 * `fileSizeBase`: the base's list of scripts/file-size.ts (`STILL_OVER`), read by the host: exported as FILE_SIZE_BASE_LIST, since the build has no base ref to read it from.
 * The host's AWS names reach the build as the user's `~/.aws/config`, written by the build's setup from `--names` (`runBuild`); the script holds none of them.
 * Nothing of this host's environment goes in (no token, no recordings' place). docs/design/local-ci-offload.md.
 * Why the mount namespace: the steps' user could read the build role's credentials from `/codebuild/output/tmp/env.sh`, so the steps start inside a namespace where that directory is empty.
 * Why the PID namespace: the build's PID 1 does not reap orphans, so a killed child stays a zombie that `kill(pid, 0)` finds
 * alive and the child-cleanup tests fail. The namespace's init is a bash that reaps them; `exit $?` keeps bash from
 * replacing itself with su (then su would be PID 1 and reap nothing).
 */
export function ciScript(steps: Step[], o: { repo?: string; fixtures?: { required: boolean }; perf?: true; fileSizeBase?: Record<string, number> }): string {
  const lastPerf = o.perf ? steps.map((s) => isPerfStep(s)).lastIndexOf(true) : -1;
  const origin = o.repo && /^[\w.-]+\/[\w.-]+$/.test(o.repo) ? ` && git remote add origin ${quote(`https://github.com/${o.repo}.git`)}` : "";
  const user = [
    // the steps' first action: the root shell tells a build whose steps never started from a step that failed by this file (no stage of the launch is checked on its own)
    `: > ${STARTED}`,
    "set -u",
    "cd /sb/work",
    'export CI=true TMPDIR="$(mktemp -d /sb/tmp/t.XXXXXX)"',
    ...(o.fixtures?.required ? ["export SWITCHBOARD_FIXTURES=$HOME/.switchboard/fixtures"] : []),
    ...(o.perf ? ["export PERF_ENV=offload"] : []),
    ...(o.fileSizeBase ? [`export FILE_SIZE_BASE_LIST=${quote(JSON.stringify(o.fileSizeBase))}`] : []),
    "git config --global user.name local-ci && git config --global user.email local-ci@localhost && git config --global init.defaultBranch main",
    `{ git init -q${origin} && git add -A && git commit -qm local-ci; } || { echo "sb-setup: git の作業ツリーを作れない"; exit 1; }`,
    'if [ -f package.json ]; then bun install --frozen-lockfile >/tmp/install.log 2>&1 || { cat /tmp/install.log; echo "sb-setup: bun install が失敗"; exit 1; }; fi',
    ...steps.flatMap((s, i) => [
      `echo "sb-step: ${i} begin $(date +%s.%N)"`,
      `bash -e -c ${quote(s.run)}; c=$?; echo; echo "sb-step: ${i} exit $c $(date +%s.%N)"${s.keepGoing ? "" : '; [ "$c" -eq 0 ] || exit "$c"'}`,
      // after the last perf step: the files the host's records and judgement read, one line each (a missing file or a failure here changes no step's result)
      ...(i === lastPerf ? [`for f in ${BUILD_FILES.join(" ")}; do [ -f "$f" ] && echo "sb-file: $f $(base64 -w0 "$f")"; done; true`] : []),
    ]),
  ].join("\n");
  // The steps' text comes from the repository under test, so it never goes into this root script as source: it is base64 (no quote, no newline, no
  // line of its own), written to a file by printf and run only as the unprivileged user, inside the namespaces below.
  const encoded = Buffer.from(user).toString("base64");
  return [
    "set -u",
    `printf '%s' '${encoded}' | base64 -d > /tmp/sb-local-ci.sh || { echo "sb-setup: 手順を書けない"; exit 1; }`,
    'mkdir -p /sb/tmp && mount -t tmpfs -o size=2g,mode=1777 tmpfs /sb/tmp || { echo "sb-setup: tmpfs を作れない"; exit 1; }',
    'chown -R switchboard /sb/work && chmod 644 /tmp/sb-local-ci.sh || { echo "sb-setup: 作業ツリーの持ち主を switchboard にできない"; exit 1; }',
    'unshare --pid --fork --mount-proc true || { echo "sb-setup: PID 名前空間を作れない"; exit 1; }',
    'unshare --mount --propagation private true || { echo "sb-setup: mount 名前空間を作れない"; exit 1; }',
    // the steps run in a mount namespace of their own whose /codebuild/output/tmp is an empty tmpfs: CodeBuild writes the build role's credential path and token
    // to env.sh there (mode 666), which `su -` does not hide; the mask is in this namespace only, so the buildspec's later commands see the real directory.
    // This launcher holds nothing of the repository's: only fixed text.
    `rm -f ${STARTED}`,
    `cat > /tmp/sb-run.sh <<'SB_RUN_EOF' || { echo "sb-setup: 起動の手順を書けない"; exit 1; }`,
    'if [ -d /codebuild/output/tmp ]; then mount -t tmpfs -o size=1m,mode=755 tmpfs /codebuild/output/tmp || { echo "sb-setup: env.sh を覆えない"; exit 1; }; fi',
    `unshare --pid --fork --mount-proc bash -c 'su - switchboard -c "CHROME_BIN=\${CHROME_BIN:-} PLAYWRIGHT_BROWSERS_PATH=\${PLAYWRIGHT_BROWSERS_PATH:-} PERF_BASE_TREE=\${PERF_BASE_TREE:-} bash /tmp/sb-local-ci.sh"; exit $?'`,
    "SB_RUN_EOF",
    "unshare --mount --propagation private bash /tmp/sb-run.sh; c=$?",
    // the launcher's code passes through; no marker means the steps never started (any stage before them), and then the code is kept when it is non-zero, so a step that deleted
    // the marker (the steps' user owns it) still reads as its own result, and the marker's absence turns only a zero code (steps that could not have run) into 1; limit: a passing run whose step deleted it reads as 1
    `[ -e ${STARTED} ] || { echo "sb-setup: 手順を起こせない"; exit "$(( c != 0 ? c : 1 ))"; }`,
    'exit "$c"',
  ].join("\n");
}

/** The steps' script a `ciScript` carries (it is base64 in the root script, so that no step text is in the root script's source); for tests and for a reader of a built script. */
export function stepsOf(script: string): string {
  const m = /^printf '%s' '([^']*)' \| base64 -d > \/tmp\/sb-local-ci\.sh/m.exec(script);
  const body = m?.[1] ?? "";
  if (!body || body.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error("stepsOf: the script has no valid base64 steps body");
  return Buffer.from(body, "base64").toString("utf8");
}

/** The files a perf build gives back in its log (`sb-file: <name> <base64>`); no other name is taken. */
const BUILD_FILES = ["perf-result.json", "perf-base.json"];

/** The files a build's log carries (`ciScript` with `perf`) by name, the last line of a name winning; a name that is not one of `BUILD_FILES` (a path included) is ignored. */
export function buildFiles(output: string): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  for (const l of output.split("\n")) {
    const m = /^sb-file: (\S+) ([A-Za-z0-9+/=]*)$/.exec(l.trim());
    if (!m || !BUILD_FILES.includes(m[1]!)) continue;
    const bytes = Buffer.from(m[2]!, "base64");
    // a line the log cut or split decodes to broken JSON: leave the file out (perf then reads as not measured) instead of writing it
    try {
      JSON.parse(bytes.toString("utf8"));
    } catch {
      console.error(`sb-file: ${m[1]} is not JSON (the log line was cut?): left out`);
      continue;
    }
    files[m[1]!] = bytes;
  }
  return files;
}

/** What sb-offload's own exit means when a step has no exit mark. */
export const offloadReason = (code: number) => `sb-offload: exit ${code}（${code === 124 ? "時間切れ" : code === 130 ? "中断" : "ビルドの失敗"}）`;

/**
 * The one build of every step of a CI (`ciScript`): the host's AWS names go in a JSON of mode 600 in a directory of its own, given by path as
 * `names` and removed once the build has started (sb-offload has sent it by then); the value is in no script, argument other than that path, environment or log.
 * A host with no AWS config (or a `host` with none, as test-changed passes: its build runs no public-tree check) gives no file.
 * `started` is told the build's id before the wait, to be written down (`writePending`). A build that could not be started comes back with
 * `notStarted` (sb-offload's code and output): no step ran, so the caller must not read it as a step's failure.
 * `imageRoot`: the tree whose container/Dockerfile the ci image is (another repository's work tree has none, or has its own); an
 * `sb-offload` that does not know the flag yet starts nothing.
 * `reuse`: a build of exactly the same input key (the script, the size, every file of the work tree, the recordings) recorded within
 * `hours` is not started again: its result is collected (a running one is waited for) and comes back with `reused`. A build that
 * did not run to its command's end (stopped, timed out, failed before it, a log that is gone) is not reused.
 */
export async function runBuild(offload: Offload, steps: Step[], cwd: string, o: { caller: OffloadCaller; repo?: string; size?: OffloadSize; host?: HostAws; perf?: true; baseTree?: string; imageRoot?: string; fileSizeBase?: Record<string, number>; reuse?: { hours: number; now?: number }; started?: (build: string) => void }): Promise<{ code: number; output: string; notStarted?: true; reused?: { build: string; at: string } }> {
  const host = o.host ?? hostAws();
  const hasNames = host.names.length + host.accountIds.length > 0;
  const script = ciScript(steps, { ...(o.repo ? { repo: o.repo } : {}), ...(offload.fixtures ? { fixtures: { required: offload.fixtures.required } } : {}), ...(o.perf ? { perf: true as const } : {}), ...(o.fileSizeBase ? { fileSizeBase: o.fileSizeBase } : {}) });
  const size = o.size ?? "small";
  // the key is read from the work tree as it is when the build starts
  const key = offload.log ? await buildKey(cwd, script, { size, ...(offload.fixtures ? { fixtures: offload.fixtures.dir } : {}) }).catch(() => undefined) : undefined;
  if (o.reuse && offload.log && key) {
    // a record that cannot be read is no reason to fail the run: a new build
    const prev = (() => {
      try {
        return findReusable(offload.log!, key, o.reuse!.hours, o.reuse!.now ?? Date.now());
      } catch {
        return undefined;
      }
    })();
    if (prev) {
      const out = await offload.collect(prev.build);
      if (reusableOutput(out.output)) return { ...out, reused: { build: prev.build, at: prev.at } };
    }
  }
  // an sb-offload from before the flag would take it for the command: nothing is started, and it says what is missing
  if (o.imageRoot && (await offload.knows?.("--image-root")) === false) {
    return { code: 2, output: "sb-offload が --image-root を知らない（ホストの次の起動で入る）", notStarted: true };
  }
  const dir = hasNames ? mkdtempSync(join(tmpdir(), "switchboard.names.")) : undefined;
  let build: string;
  let image: string | undefined;
  try {
    let names: string | undefined;
    if (dir) {
      names = join(dir, "names.json");
      writeFileSync(names, JSON.stringify({ names: host.names, accountIds: host.accountIds }), { mode: 0o600 });
    }
    const started = await offload.start(script, cwd, { size, ...(offload.fixtures ? { fixtures: offload.fixtures.dir } : {}), ...(names ? { names } : {}), ...(o.baseTree ? { baseTree: o.baseTree } : {}), ...(o.imageRoot ? { imageRoot: o.imageRoot } : {}) });
    build = started.build;
    image = started.image;
    if (offload.log) {
      const at = new Date().toISOString();
      try {
        if (image) offload.log.append({ at, caller: o.caller, kind: "image", build: image, size, tree: cwd });
        offload.log.append({ at, caller: o.caller, kind: "ci", build, size, ...(key ? { key } : {}), tree: cwd });
      } catch (e) {
        console.error(`offload-record: 記録を書けなかった（${e instanceof Error ? e.message : String(e)}）`);
      }
    }
  } catch (e) {
    if (e instanceof OffloadStartError) return { code: e.code, output: e.output, notStarted: true };
    throw e;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  o.started?.(build);
  return offload.collect(build);
}

/**
 * The real build when `sb-offload` is on PATH (the cloud host), else none. Its environment has no GitHub token and no recordings' place.
 * The recordings go by `--fixtures`: `SWITCHBOARD_FIXTURES` here when given (the run needs them: `required`), else `~/.switchboard/fixtures` when it exists.
 */
export function hostOffload(): Offload | undefined {
  const bin = Bun.which("sb-offload", { PATH: process.env.PATH ?? "" });
  if (!bin) return undefined;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && !["GH_TOKEN", "GITHUB_TOKEN", "SWITCHBOARD_FIXTURES"].includes(k))) as Record<string, string>;
  const given = process.env.SWITCHBOARD_FIXTURES;
  const usual = join(process.env.HOME || homedir(), ".switchboard", "fixtures");
  const fixtures = given ? { dir: given, required: true } : existsSync(usual) ? { dir: usual, required: false } : undefined;
  let usage: Promise<string> | undefined;
  return {
    ...(fixtures ? { fixtures } : {}),
    log: fileLog(offloadRecordPath()),
    // called with no arguments sb-offload prints its usage (stderr, exit 2): read once per process
    knows: async (flag) =>
      (await (usage ??= (async () => {
        try {
          const p = Bun.spawn([bin], { env, stdout: "pipe", stderr: "pipe" });
          const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
          return `${out}${err}`;
        } catch {
          // it cannot be run: no flag is known; the build's start then fails and says why
          return "";
        }
      })())).includes(flag),
    start: async (script, cwd, o) => {
      const p = Bun.spawn([bin, "--ci", "--detach", ...(o.fixtures ? ["--fixtures", o.fixtures] : []), ...(o.names ? ["--names", o.names] : []), ...(o.baseTree ? ["--base-tree", o.baseTree] : []), ...(o.imageRoot ? ["--image-root", o.imageRoot] : []), "--size", o.size, script], { cwd, env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      // the image build's log may come before it: only the started line names the build
      const build = out.split("\n").map((l) => /^sb-offload: started (\S+)$/.exec(l.trim())?.[1]).find((b) => b);
      if (code !== 0 || !build) throw new OffloadStartError(code === 0 ? 1 : code, `${out}${err}`);
      // sb-offload writes the image build's started line to stderr (only the ci build's goes to stdout)
      const image = `${out}\n${err}`.split("\n").map((l) => /^sb-offload: no ci image \S+ yet; building it, started (\S+)$/.exec(l.trim())?.[1]).find((b) => b);
      return { build, ...(image ? { image } : {}) };
    },
    collect: async (build) => {
      const p = Bun.spawn([bin, "--collect", build], { env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return { code, output: `${out}${err}` };
    },
  };
}

/**
 * A build started and not yet written to its PR: what writing the mark needs, no more (no token, no AWS name: the build's id is all that names the build).
 * One file per PR under `pendingDirOf`, written when the build has started and removed once its result was posted (or was not to be posted), so a local-ci
 * that is gone (the daemon restarted, the host stopped) leaves the result to `--collect`.
 */
export interface Pending {
  repo: string;
  pr: number;
  /** The clone the result is posted through (`resolveTarget`'s root). */
  root: string;
  head: string;
  base: string;
  build: string;
  /** When the build started (ms): its log is kept 7 days. */
  at: number;
  steps: Step[];
  selection?: TestSelection;
  incremental?: { pass: string; commits: number; files: number };
  /** The checkout has scripts/ci.ts: a pass carries its step seconds. */
  ciTs: boolean;
  /** The steps came from the workspace's settings (the comment names them). */
  source?: StepsSource;
  /** The local-ci process waiting for this build and this boot's id (null when unreadable): while it is alive it writes the result itself, and `--collect` leaves the record. */
  pid: number;
  boot: string | null;
  /** The job (its id) the local-ci that started this build ran as: a result written after that job ended goes to its folder. */
  job?: string;
}

/** This boot's id, or null when it cannot be read. */
export const bootId = (): string | null => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
};

/** Is the process that wrote this record still alive, in the same boot? (a pid means nothing after a reboot) */
export const recordLive = (p: Pending, boot = bootId(), cmdline: (pid: number) => string | null = procCmdline): boolean => {
  if (p.pid === process.pid || boot === null || p.boot !== boot) return false;
  // the pid may be another process's by now: it must still be a local-ci (unreadable = gone)
  return cmdline(p.pid)?.includes("local-ci") ?? false;
};

/** The command line of a process (/proc/<pid>/cmdline, its arguments joined by spaces), or null when it cannot be read. */
const procCmdline = (pid: number): string | null => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return null;
  }
};

/** Does a collected build's output say anything about the build? A build that is not there (`no build`), a read that failed, and a SUCCEEDED build whose log is gone (`ended SUCCEEDED without the command's exit code`: its log is kept 7 days, the build's record longer) say nothing; one that ended before its steps (`ended FAILED / FAULT / STOPPED / TIMED_OUT without the command's exit code`) is a failed build. */
export const buildSpoke = (output: string): boolean => /^(sb-step: |sb-offload: exit \d+$)/m.test(output) || /^sb-offload: \S+ ended (FAILED|FAULT|STOPPED|TIMED_OUT) without the command's exit code$/m.test(output);

/**
 * Where the pending records are: `switchboard.local-ci-pending` under `cache` (~/.cache). The same place as `localCiPendingDir` in
 * packages/core/src/jobs.ts, which the daemon looks in at its start to run `--collect`; scripts/ do not import packages/core, so the name is written in both.
 */
export const pendingDirOf = (cache: string): string => join(cache, "switchboard.local-ci-pending");
const pendingFile = (cache: string, repo: string, pr: number): string => join(pendingDirOf(cache), `${repo.replaceAll("/", "_")}-${pr}.json`);
/** How long the build's log is kept (CodeBuild's, 7 days). */
export const BUILD_LOG_KEEP_MS = 7 * 24 * 3600 * 1000;

export function writePending(cache: string, p: Pending): void {
  mkdirSync(pendingDirOf(cache), { recursive: true });
  const file = pendingFile(cache, p.repo, p.pr);
  writeFileSync(`${file}.tmp`, JSON.stringify(p), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** Removes the PR's record only when it is still of `build` (another run may have written its own build's since). */
export function clearPending(cache: string, repo: string, pr: number, build: string): void {
  const file = pendingFile(cache, repo, pr);
  if (readPendingFile(file)?.build === build) rmSync(file, { force: true });
}

export const readPendingFile = (file: string): Pending | undefined => {
  try {
    const p = JSON.parse(readFileSync(file, "utf8")) as Partial<Pending>;
    return typeof p.repo === "string" && Number.isInteger(p.pr) && typeof p.root === "string" && typeof p.head === "string" && typeof p.base === "string" && typeof p.build === "string" && typeof p.at === "number" && Array.isArray(p.steps) ? ({ ...p, job: typeof p.job === "string" && /^\d+$/.test(p.job) ? p.job : undefined } as Pending) : undefined;
  } catch {
    return undefined;
  }
};

/** The PR's record when it is of this head and base (a build that already runs or ran for them). */
export function pendingFor(cache: string, repo: string, pr: number, head: string, base: string): Pending | undefined {
  const p = readPendingFile(pendingFile(cache, repo, pr));
  return p && p.head === head && p.base === base ? p : undefined;
}
