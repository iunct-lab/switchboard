/**
 * bun scripts/release-check.ts <public tag> — a public Release, installed the way a user installs it, then promoted
 * until the release it was installed as is cleaned away, and rolled back, all under a temporary SWITCHBOARD_HOME:
 *   1. the tag's tarball is fetched from the public repository (`publicSync.target` of ops.config.json)
 *   2. it is served as Latest by a fake Releases API (container/fake-releases.ts)
 *   3. `rescue/install.ts --source` installs it on a PATH with no git and no gh, and sb-rescue is started
 *   4. the same tarball, re-rooted to a made-up commit each time, is promoted under the next patch tag until the first
 *      release's directory is gone from `releases/` (at most MAX_PROMOTIONS promotions; how many it takes is the
 *      version's own cleaning rule, so it is observed and not read from the code)
 *   5. the first release's directory is gone, or the cleaning did not run (a fail)
 *   6. sb-rescue goes back to the previous release
 * A real Claude Task goes through the daemon's own API (`POST /api/tasks`, `/resume`, `/fork` then `/send`) and must get
 * one Bash through: after the install (start), after the cleaning (resume, and a fork of it), and after the rollback
 * (resume). A Bash the hook refused, a tool error, or no result within `taskMs` is a fail. A runner that cannot be
 * used (not logged in, a usage limit, no cheap model to pick) is not a fail: the check judged nothing (`undecided`,
 * exit 2, no result line). The model is `--model <value>`, else the first Claude model of `/api/health` whose value
 * contains `haiku`.
 * `/api/health` of the daemon is read after every step that changes the running release. Each step prints `✓ <step>`;
 * a failure prints `✗ <reason>`; the last line is `[release-check] pass|fail <tag> <sha>`. Exit 0 = pass, 1 = fail,
 * 2 = usage or judged nothing (then no result line). The daemon gets a temporary SWITCHBOARD_HOME, a PATH without git
 * and gh, and no GitHub token, so it keeps nothing of this machine's Switchboard and writes nothing to GitHub. HOME
 * stays the user's, so the runner itself (Claude Code) uses the user's login and history there; that is the runner's own use, not the daemon's. The daemon is
 * started with SWITCHBOARD_CANDIDATE=1 (sb-rescue passes its environment on to the daemon it supervises), so it decides
 * nothing by itself: it does not update or prune the user's installed Claude Code and Codex, start schedules or the
 * backlog queue, or resume Tasks, and keeps the waiting queue held. It still serves the API, so a step can start a Task
 * through it. Its knowledge folder is redirected to the check's own home (SWITCHBOARD_KNOWLEDGE): left alone, it is
 * `~/Knowledge` whenever the check's folder is not under an OS temp root (a TMPDIR elsewhere). The other folders the
 * daemon reads under HOME (Claude projects, usage data, Codex home) are read, not written, and stay the user's. Candidate
 * mode also skips other parts of a real start, everything the daemon gates on `decidesNothing` or on `candidate`
 * itself. `decidesNothing` (a candidate or a work machine) gates the CLI update and the scheduler start; `candidate`
 * alone gates the pre-migration snapshot, the daemon_runs row, the session-log import, job recovery, auto-resume and
 * the backlog's boot polling and sending. The list is not exhaustive.
 *
 * `--record` writes the result where it is read, after the check has ended and the daemon is stopped, from this process
 * and never from the daemon (which has no gh and no token): on a pass the public Release's body gets
 * `[release-check] pass <sha>` (no tag: the line the command prints last, `[release-check] pass|fail <tag> <sha>`, is another one) and the Release stops being a prerelease and becomes Latest (`gh release edit
 * --prerelease=false --latest`; the sync made it a prerelease: `publicSync.prerelease`); on a fail its body gets only
 * `[release-check] fail <sha>` (no step and no output on the public side) and a request is filed in the development
 * repository with the failed step and the check's own lines of the reason, never an outside process's output (or an open request with the same title gets a comment).
 * A check that could not judge (exit 2) writes nothing anywhere. `checkResult` reads the last line of a sha.
 *
 * The steps are a list (`stepsOf`) over a shared `ctx`.
 *
 * `checkRelease` takes everything it touches as `deps` (SmokeDeps of release-smoke, plus the fake Releases API), so its
 * tests run with no process started.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeReleases, type FakeRelease } from "../container/fake-releases.ts";
import { isAuthText } from "../packages/core/src/login.ts";
import { isLimitText } from "../packages/core/src/ratelimit.ts";
import { withHeavySlot } from "../ops-kit/src/heavy.ts";
import { findSecrets, hostAws } from "../ops-kit/src/secrets.ts";
import { type Filed, commentRequest, fileRequest, requestText } from "./file-request.ts";
import { GITHUB_API, realDeps, type SmokeDeps } from "./release-smoke.ts";
import { must, spawnSh, type Sh } from "./release-tag.ts";
import { currentRepo } from "./repo.ts";
import { hidePaths } from "./tag-ci.ts";

export interface CheckDeps extends SmokeDeps {
  /** The fake Releases API serving `releases` (the first is Latest until `setLatest`). */
  startReleases: (o: { repo: string; releases: FakeRelease[] }) => { url: string; setLatest: (tag: string) => boolean; stop: () => void };
  /** The HOME the daemon runs with: the user's. */
  userHome: string;
}

export interface CheckOptions {
  /** The public tag to check. */
  tag: string;
  /** `owner/name` of the public repository. */
  repo: string;
  /** Reports each step as it is done. */
  log?: (line: string) => void;
  /** How long the daemon may take to answer after the start, and each promotion or rollback to finish. */
  waitMs?: number;
  pollMs?: number;
  maxPromotions?: number;
  /** The Claude model of the Tasks; absent = the first one of `/api/health` whose value contains `haiku`. */
  model?: string;
  /** How long a Task's turn may take to give its Bash result. */
  taskMs?: number;
}

/** `undecided`: why nothing could be judged (no usable runner); then `ok` is false and there is no result line. */
export interface CheckResult { ok: boolean; tag: string; sha: string | null; steps: string[]; reason: string | null; /** What an outside process returned: printed by the command, never written to a request. */ detail?: string; undecided?: string | null; /** The step that failed (absent for a fail before the steps). */ failedStep?: string }

/** The check could not be judged: not a pass and not a fail. */
class Undecided extends Error {}
/** A failure whose message is the check's own sentence (no text from an outside process): it may be written to a request. */
class Own extends Error {}
/**
 * A failure whose message is the check's own words, with the text an outside process returned (sb-rescue, the installer,
 * the build, the daemon, the runner) kept apart as `detail`: the command prints both, but only the message is ever
 * written to a request or a comment. Any error that is neither this nor one of the check's own (`Own`) is written as a
 * fixed sentence, with its message as the detail.
 */
class Detailed extends Error {
  constructor(message: string, readonly detail: string) {
    super(message);
  }
}
/** A GitHub answer that is no fact about the Release: a rate limit, a server error. */
class Transient extends Error {}
class HttpFailure extends Error {}
const httpError = (message: string, status: number): Error => (status === 403 || status === 429 || status >= 500 ? new Transient(message) : new HttpFailure(message));

/** What a step reads and leaves for the next. */
export interface Ctx {
  o: Required<Pick<CheckOptions, "tag" | "repo" | "waitMs" | "pollMs" | "maxPromotions" | "taskMs">> & Pick<CheckOptions, "model">;
  deps: CheckDeps;
  root: string;
  /** SWITCHBOARD_HOME of the daemon. */
  home: string;
  env: Record<string, string>;
  setLatest: (tag: string) => boolean;
  publicTarball: string;
  publicSha: string;
  /** The tree of the public tag, unpacked: `rescue/install.ts` runs from here. */
  src: string;
  port: number;
  rescuePort: number;
  /** The first release of the install (the public tag's commit), and how many promotions have been made since. */
  first: string;
  promoted: number;
  /** The tags and commits the fake API serves after the public tag, in the order they are promoted. */
  fakes: Array<{ tag: string; sha: string }>;
  /** The Task started after the install, the model it runs on, and the folder it works in. */
  taskId: string | null;
  model: string | null;
  taskCwd: string;
  /** sb-rescue once the install step has started it (the check stops it at the end). */
  rescue: ReturnType<SmokeDeps["spawn"]> | null;
}

export interface Step { name: string; run: (c: Ctx) => Promise<void> }

const TAG = /^v\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;
export const MAX_PROMOTIONS = 8;
export const TASK_PROMPT = "Bash で `pwd` を 1 回だけ実行し、その出力だけを返してください";

/**
 * A result's line in a public Release's body: pass or fail, then its commit (no tag: the Release is the tag's). The
 * line the command prints last is another one, `[release-check] pass|fail <tag> <sha>` (`resultLine`).
 */
export const RELEASE_CHECK_RESULT = /^\[release-check\] (pass|fail) ([0-9a-f]{40})(?=\s|$)/m;

/** The last result of `sha` in a public Release's body, or null: a later run's line outweighs an earlier one. */
export function checkResult(releaseBody: string, sha: string): "pass" | "fail" | null {
  let last: "pass" | "fail" | null = null;
  for (const m of releaseBody.matchAll(new RegExp(RELEASE_CHECK_RESULT.source, "gm"))) if (m[2] === sha) last = m[1] as "pass" | "fail";
  return last;
}

/** The line the public Release's body gets: the verdict and the commit only. */
export const bodyLine = (r: Pick<CheckResult, "ok" | "sha">): string => `[release-check] ${r.ok ? "pass" : "fail"} ${r.sha ?? "-"}`;
export const resultLine = (r: Pick<CheckResult, "ok" | "tag" | "sha">): string => `[release-check] ${r.ok ? "pass" : "fail"} ${r.tag} ${r.sha ?? "-"}`;

/** `v1.2.3` → `v1.2.<3 + n>`. */
export const patchAfter = (tag: string, n: number): string => {
  const [maj, min, pat] = tag.slice(1).split(".").map(Number) as [number, number, number];
  return `v${maj}.${min}.${pat + n}`;
};

/** A made-up commit for the nth fake release: 40 hex digits no real commit is likely to be. */
export const fakeSha = (n: number): string => `f${n.toString(16).padStart(39, "0")}`;

const status = (c: Ctx) => c.deps.fetch(`http://127.0.0.1:${c.rescuePort}/api/status`).then((r) => r.json() as Promise<{ current: string | null; previous: string | null; busy: string | null; lastError: string | null; unhealthy: string | null; history?: Array<{ action: string; reason?: string }> }>);

/** null = the daemon answers ok; otherwise what was seen. */
const health = (c: Ctx): Promise<string | null> =>
  c.deps.fetch(`http://127.0.0.1:${c.port}/api/health`).then(async (r) => (r.ok && ((await r.json()) as { ok?: unknown }).ok === true ? null : `status ${r.status}`), (e) => `no answer (${String((e as Error).message ?? e)})`);

async function until<T>(c: Ctx, what: string, ms: number, probe: () => Promise<T | null>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got !== null) return got;
    if (Date.now() >= end) throw new Own(`${what}: not in time`);
    await c.deps.sleep(c.o.pollMs);
  }
}

/** The daemon answers `/api/health` ok within the wait. */
async function healthy(c: Ctx, what: string): Promise<void> {
  const end = Date.now() + c.o.waitMs;
  for (;;) {
    const h = await health(c);
    if (h === null) return;
    if (Date.now() >= end) throw new Detailed(`${what}: /api/health did not answer ok`, h);
    await c.deps.sleep(c.o.pollMs);
  }
}

/** POST to sb-rescue and wait for the operation it starts to end. */
async function operate(c: Ctx, path: string, body: unknown, what: string): Promise<Awaited<ReturnType<typeof status>>> {
  const res = await c.deps.fetch(`http://127.0.0.1:${c.rescuePort}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status !== 202) throw new Detailed(`${what}: ${path} answered ${res.status}`, await res.text());
  const s = await until(c, `${what}: ${path} did not end`, c.o.waitMs, async () => {
    const st = await status(c);
    return st.busy === null ? st : null;
  });
  if (s.lastError) throw new Detailed(`${what}: sb-rescue reported an error`, String(s.lastError));
  return s;
}

/** Re-root the public tarball to `sha` (its top directory is named after the commit) and write it for the fake API. */
async function reroot(c: Ctx, sha: string, out: string): Promise<void> {
  const work = join(c.root, `reroot-${sha.slice(0, 8)}`);
  const top = `switchboard-${sha}`;
  mkdirSync(join(work, top), { recursive: true });
  const env = c.env;
  try {
    const x = await c.deps.run(["tar", "-xzf", c.publicTarball, "-C", join(work, top), "--strip-components=1"], { cwd: work, env });
    if (x.code !== 0) throw new Detailed(`unpacking the public tarball failed`, x.output.trim());
    const t = await c.deps.run(["tar", "-czf", out, "-C", work, top], { cwd: work, env });
    if (t.code !== 0) throw new Detailed(`packing the re-rooted tarball failed`, t.output.trim());
  } finally {
    c.deps.remove(work);
  }
}


/** One call of the daemon's API. */
async function call(c: Ctx, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await c.deps.fetch(`http://127.0.0.1:${c.port}${path}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { error: text };
  }
  return { status: res.status, json };
}

interface Ev { seq: number; ev: { t: string; [k: string]: unknown } }

/** The model of the Tasks, and a runner that can take them (otherwise: judged nothing). */
async function pickModel(c: Ctx): Promise<string> {
  if (c.model) return c.model;
  const h = await call(c, "GET", "/api/health");
  const claude = ((h.json?.runners ?? []) as Array<{ id: string; available?: boolean; login?: string; models?: Array<{ value: string }> }>).find((r) => r.id === "claude");
  if (!claude || claude.available !== true) throw new Undecided("the Claude runner is not available to the check daemon");
  if (claude.login === "expired") throw new Undecided("Claude is not logged in");
  const model = c.o.model ?? claude.models?.find((m) => m.value.includes("haiku"))?.value;
  if (!model) throw new Undecided("no Claude model with haiku in its value: pass --model <value>");
  return (c.model = model);
}

/** Wait for the turn that ends after `after`, and judge its Bash. */
async function judgeTurn(c: Ctx, id: string, after: number, what: string): Promise<void> {
  const end = Date.now() + c.o.taskMs;
  for (;;) {
    const r = await call(c, "GET", `/api/tasks/${id}?after=${after}`);
    if (r.status !== 200) throw new Own(`${what}: GET /api/tasks/${id} answered ${r.status}`);
    const events = (r.json.events ?? []) as Ev[];
    const task = r.json.task as { status: string; resumeAt: number | null };
    const refused = events.find((e) => e.ev.t === "permission.ask");
    if (refused) throw new Detailed(`${what}: a tool asks for approval instead of running`, `${String(refused.ev.tool)}: ${String(refused.ev.detail)}`);
    const turnEnd = events.find((e) => e.ev.t === "session.end");
    if (turnEnd) {
      const calls = events.filter((e) => e.ev.t === "tool.call" && e.ev.name === "Bash");
      const results = events.filter((e) => e.ev.t === "tool.result" && calls.some((k) => k.ev.id === e.ev.id));
      const bad = results.find((e) => e.ev.ok !== true);
      if (bad) throw new Detailed(`${what}: a Bash was refused or failed`, String(bad.ev.summary));
      if (results.length > 0 && results.length === calls.length) return;
      if (task.resumeAt !== null) throw new Undecided(`${what}: the Task is stopped on a limit`);
      const err = events.find((e) => e.ev.t === "error");
      const msg = err ? String(err.ev.message) : "";
      // as the daemon does (server/task-hooks.ts): a login failure or a usage limit is read from the summary and the errors of a turn that ended with status error only
      if (turnEnd.ev.status === "error") {
        const texts = [turnEnd.ev.summary, ...events.filter((e) => e.ev.t === "error").map((e) => e.ev.message)].map((x) => (typeof x === "string" ? x : undefined));
        const hit = texts.find((x) => isAuthText("claude", x) || isLimitText("claude", x));
        if (hit) throw new Undecided(`${what}: ${hit.slice(0, 200)}`);
      }
      throw new Detailed(`${what}: the turn ended with no Bash result`, msg);
    }
    if (task.resumeAt !== null) throw new Undecided(`${what}: the Task is stopped on a limit`);
    if (task.status === "error" || task.status === "aborted") throw new Own(`${what}: the Task is ${task.status}`);
    if (Date.now() >= end) throw new Own(`${what}: no Bash result within ${Math.round(c.o.taskMs / 1000)} s`);
    await c.deps.sleep(c.o.pollMs);
  }
}

/** The last seq a Task has, and the seq of its last turn that ended ok. */
async function marks(c: Ctx, id: string): Promise<{ last: number; ended: number | null }> {
  const r = await call(c, "GET", `/api/tasks/${id}?after=0`);
  if (r.status !== 200) throw new Own(`GET /api/tasks/${id}?after=0 answered ${r.status}`);
  const events = (r.json?.events ?? []) as Ev[];
  const ok = events.filter((e) => e.ev.t === "session.end" && e.ev.status === "ok");
  return { last: events.reduce((m, e) => Math.max(m, e.seq), 0), ended: ok.length ? ok[ok.length - 1]!.seq : null };
}

/** A Task is started, resumed, or forked (and then sent to), and one Bash goes through it. */
export async function bashOnce(c: Ctx, how: "start" | "resume" | "fork"): Promise<void> {
  const what = `Bash after ${how}`;
  const model = await pickModel(c);
  const refuse = (r: { status: number; json: any }, path: string) => new Detailed(`${what}: ${path} answered ${r.status}`, String(r.json?.error ?? JSON.stringify(r.json)));
  if (how === "start") {
    mkdirSync(c.taskCwd, { recursive: true });
    const r = await call(c, "POST", "/api/tasks", { prompt: TASK_PROMPT, cwd: c.taskCwd, runner: "claude", model, title: "release-check" });
    if (r.status !== 201) throw refuse(r, "POST /api/tasks");
    c.taskId = r.json.id;
    if (r.json.resumeReason === "start") throw new Undecided(`${what}: the Task was queued at a usage limit`);
    await judgeTurn(c, c.taskId!, 0, what);
    return;
  }
  if (!c.taskId) throw new Own(`${what}: no Task was started`);
  if (how === "resume") {
    const m = await marks(c, c.taskId);
    const r = await call(c, "POST", `/api/tasks/${c.taskId}/resume`, { text: TASK_PROMPT });
    if (r.status !== 200) throw refuse(r, "POST /resume");
    await judgeTurn(c, c.taskId, m.last, what);
    return;
  }
  const m = await marks(c, c.taskId);
  if (m.ended === null) throw new Own(`${what}: the Task has no turn that ended ok to fork from`);
  const f = await call(c, "POST", `/api/tasks/${c.taskId}/fork`, { seq: m.ended });
  if (f.status !== 201) throw refuse(f, "POST /fork");
  const child = f.json.id as string;
  const s = await call(c, "POST", `/api/tasks/${child}/send`, { text: TASK_PROMPT });
  if (s.status !== 200) throw refuse(s, "POST /send");
  await judgeTurn(c, child, 0, what);
}

/** The steps, in order. A step that throws is the fail: its message is the reason. */
export function stepsOf(): Step[] {
  return [
    {
      name: "install: the public tag from a fake Releases API, with no git and no gh",
      async run(c) {
        const install = await c.deps.run([c.deps.bun, "rescue/install.ts", "--source", c.o.repo], { cwd: c.src, env: c.env });
        if (install.code !== 0) throw new Detailed(`rescue/install.ts --source ${c.o.repo} exited ${install.code}`, install.output.trim());
        const rescue = c.deps.spawn([c.deps.bun, join(c.home, "rescue", "sb-rescue.js")], { cwd: c.root, env: { ...c.env, SWITCHBOARD_PORT: String(c.port), SWITCHBOARD_RESCUE_PORT: String(c.rescuePort) } });
        c.rescue = rescue;
        let ended: number | null | undefined;
        void rescue.exited.then((code) => (ended = code));
        const end = Date.now() + c.o.waitMs;
        for (;;) {
          const h = await health(c);
          if (h === null) break;
          if (ended !== undefined) throw new Own(`sb-rescue exited (${ended}) before the daemon answered`);
          if (Date.now() >= end) throw new Detailed(`not up in time: /api/health did not answer ok`, h);
          await c.deps.sleep(c.o.pollMs);
        }
        const s = await status(c);
        if (s.current !== c.publicSha) throw new Detailed(`the install does not run the public tag's commit`, `the install runs ${s.current ?? "nothing"}, not ${c.publicSha}`);
        c.first = s.current;
      },
    },
    { name: "a Claude Task is started and gets a Bash through", run: (c) => bashOnce(c, "start") },
    {
      name: "promote the same tarball under the next tag until the first release is cleaned away",
      async run(c) {
        while (c.promoted < c.o.maxPromotions && existsSync(join(c.home, "releases", c.first))) {
          const next = c.fakes[c.promoted]!;
          await reroot(c, next.sha, join(c.root, "fake", `${next.tag}.tar.gz`));
          c.setLatest(next.tag);
          const s = await operate(c, "/api/promote", { commit: next.tag, expectSha: next.sha }, `promotion ${c.promoted + 1} to ${next.tag}`);
          if (s.current !== next.sha) throw new Detailed(`promotion ${c.promoted + 1} to ${next.tag} did not leave it running`, `left ${s.current ?? "nothing"} running: ${s.history?.[0]?.reason ?? "no reason recorded"}`);
          await healthy(c, `after promotion ${c.promoted + 1}`);
          c.promoted++;
        }
      },
    },
    {
      name: "cleaning: the first release's directory is gone",
      async run(c) {
        if (existsSync(join(c.home, "releases", c.first))) throw new Own(`片付けが走らなかった: ${c.promoted} promotions later the first release ${c.first.slice(0, 7)} is still under releases/`);
      },
    },
    { name: "the Task is resumed after the cleaning and gets a Bash through", run: (c) => bashOnce(c, "resume") },
    { name: "the Task is forked after the cleaning and the fork gets a Bash through", run: (c) => bashOnce(c, "fork") },
    {
      name: "rollback to the previous release",
      async run(c) {
        const before = await status(c);
        if (!before.previous) throw new Own("there is no previous release to go back to");
        const s = await operate(c, "/api/rollback", {}, "rollback");
        if (s.current !== before.previous) throw new Detailed(`rollback did not leave the previous release running`, `rollback left ${s.current ?? "nothing"} running, not ${before.previous}`);
        await healthy(c, "after the rollback");
      },
    },
    { name: "the Task is resumed after the rollback and gets a Bash through", run: (c) => bashOnce(c, "resume") },
  ];
}

/** Install the public tag's Release as a user would, promote and roll back, and report what was seen. */
export async function checkRelease(o: CheckOptions, deps: CheckDeps): Promise<CheckResult> {
  const steps: string[] = [];
  let sha: string | null = null;
  const fail = (reason: string, detail?: string): CheckResult => ({ ok: false, tag: o.tag, sha, steps, reason, ...(detail ? { detail } : {}) });
  if (!TAG.test(o.tag)) return fail(`not a version tag: ${o.tag}`);
  const done = (s: string) => {
    steps.push(s);
    o.log?.(`✓ ${s}`);
  };
  const root = deps.tmp();
  let releases: ReturnType<CheckDeps["startReleases"]> | null = null;
  let c: Ctx | null = null;
  let stage: string | undefined;
  try {
    const getJson = async (url: string) => {
      const r = await deps.fetch(url, { headers: { accept: "application/vnd.github+json", "user-agent": "switchboard-release-check" } });
      if (!r.ok) throw httpError(`GET ${url} returned ${r.status}`, r.status);
      return (await r.json()) as Record<string, unknown>;
    };
    // GitHub or the network failing before any step ran says nothing about the Release: not judged
    const commit = (await getJson(`${GITHUB_API}/repos/${o.repo}/commits/${o.tag}`)).sha;
    if (typeof commit !== "string" || !SHA.test(commit)) return fail(`${o.tag} of ${o.repo} has no commit`);
    sha = commit;
    const tarball = await deps.fetch(`${GITHUB_API}/repos/${o.repo}/tarball/${o.tag}`, { headers: { "user-agent": "switchboard-release-check" } });
    if (!tarball.ok) throw httpError(`the tarball of ${o.tag} returned ${tarball.status}`, tarball.status);
    const publicTarball = join(root, "public.tar.gz");
    writeFileSync(publicTarball, new Uint8Array(await tarball.arrayBuffer()));
    done(`fetched ${o.repo} ${o.tag} (${sha.slice(0, 7)})`);

    const max = o.maxPromotions ?? MAX_PROMOTIONS;
    const fakes = Array.from({ length: max }, (_, i) => ({ tag: patchAfter(o.tag, i + 1), sha: fakeSha(i + 1) }));
    const served = join(root, "fake");
    mkdirSync(served, { recursive: true });
    writeFileSync(join(served, `${o.tag}.tar.gz`), new Uint8Array(readFileSync(publicTarball)));
    releases = deps.startReleases({ repo: o.repo, releases: [{ tag: o.tag, sha, tarball: join(served, `${o.tag}.tar.gz`) }, ...fakes.map((f) => ({ ...f, tarball: join(served, `${f.tag}.tar.gz`) }))] });
    done(`serving it as Latest from a fake Releases API`);

    const path = deps.gitlessPath(join(root, "bin"), ["git", "gh"]);
    for (const name of ["git", "gh"]) {
      const found = deps.which(name, path);
      if (found) return fail(`the PATH of the check still has ${name} (${found}): the check would not see it missing`);
    }
    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    // exactly these: nothing of this machine's Switchboard, and no GitHub token
    // SWITCHBOARD_CANDIDATE=1 is inherited by the daemon sb-rescue supervises: it decides nothing by itself, so it does not move the user's installed CLIs
    const env: Record<string, string> = { HOME: deps.userHome, PATH: path, SWITCHBOARD_HOME: home, SWITCHBOARD_GITHUB_API: releases.url, SWITCHBOARD_CANDIDATE: "1", SWITCHBOARD_KNOWLEDGE: join(home, "knowledge") };
    const src = join(root, "switchboard-src");
    mkdirSync(src, { recursive: true });
    const unpack = await deps.run(["tar", "-xzf", publicTarball, "-C", src, "--strip-components=1"], { cwd: root, env });
    if (unpack.code !== 0) return fail(`the tarball of ${o.tag} did not unpack`, unpack.output.trim());
    done("tarball unpacked");

    c = {
      o: { tag: o.tag, repo: o.repo, waitMs: o.waitMs ?? 600_000, pollMs: o.pollMs ?? 1000, maxPromotions: max, taskMs: o.taskMs ?? 300_000, ...(o.model ? { model: o.model } : {}) },
      deps, root, home, env, setLatest: releases.setLatest, publicTarball, publicSha: sha, src,
      port: await deps.freePort(), rescuePort: await deps.freePort(), first: sha, promoted: 0, fakes, taskId: null, model: null, taskCwd: join(root, "task-cwd"), rescue: null,
    };
    for (const step of stepsOf()) {
      stage = step.name;
      await step.run(c);
      done(step.name);
    }
    return { ok: true, tag: o.tag, sha, steps, reason: null };
  } catch (e) {
    if (e instanceof Undecided) return { ...fail(e.message), undecided: e.message };
    if (steps.length === 0 && !(e instanceof HttpFailure)) return { ...fail(String((e as Error).message ?? e)), undecided: String((e as Error).message ?? e) };
    // Only the check's own sentences reach the reason (and so a request): any other error (a JSON parse error, a message
    // that quotes what an outside process returned) is a fixed sentence there, and its message goes to the detail.
    const own = e instanceof Own || e instanceof Detailed || e instanceof HttpFailure;
    const message = String((e as Error).message ?? e);
    const failed = own ? fail(message, e instanceof Detailed ? e.detail : undefined) : fail("予期しないエラー（詳細は確認の標準出力）", message);
    return { ...failed, ...(stage ? { failedStep: stage } : {}) };
  } finally {
    releases?.stop();
    if (c?.rescue) await c.rescue.kill().catch(() => undefined);
    deps.remove(root);
  }
}

/** The title of the request for a failed check: the same for the same failed step. */
export const requestTitleOf = (failedStep: string | undefined): string => `要望: 公開前の確認が落ちた: ${failedStep ?? "準備"}`;

/** The lines the request quotes at most. */
export const OUTPUT_LINES = 20;

/**
 * The check's own words of the reason (up to OUTPUT_LINES lines, host paths hidden). What an outside process returned
 * is not in it (`CheckResult.detail` stays on the command's stdout). As a second guard, when any line holds a value
 * usable for auth the whole of it is withheld, as the tag CI's request does.
 */
export function outputLines(reason: string, host = hostAws()): string[] {
  const lines = hidePaths(reason).split("\n").filter((l) => l.trim() !== "");
  if (findSecrets(lines.join("\n"), host).length > 0) return ["（出力に認証に使える値が含まれるので書かない。実行したホストの出力を見る）"];
  return lines.slice(-OUTPUT_LINES);
}

/** How a request names the Release it is about: the filed body and the duplicate check both use it. */
export const releaseName = (r: Pick<CheckResult, "tag" | "sha">): string => `${r.tag}（${r.sha?.slice(0, 7) ?? "-"}）`;

/** The request for a failed check: it is the only place the failed step and the check's own lines are written. */
export function failureRequest(r: CheckResult, devRepo: string, publicRepo: string, date = new Date().toISOString().slice(0, 10)): { title: string; body: string } {
  const body = [
    "## 要望",
    `公開の Release ${r.tag} の公開前の確認（scripts/release-check.ts）が落ちた。この版がプレリリースなら、Latest には上げない（公開側の同期でプレリリースにしている場合）。直してほしい（この要望は直した PBI が閉じる）。`,
    "",
    "````text",
    `公開の Release: ${releaseName(r)}（${publicRepo}）`,
    `落ちた段: ${r.failedStep ?? "準備"}`,
    ...r.steps.map((s) => `通った段: ${s}`),
    "理由:",
    ...outputLines(r.reason ?? ""),
    "````",
    "",
    `公開側の Release の本文には \`[release-check] fail <sha>\` の 1 行だけがある（\`gh release view ${r.tag} -R ${publicRepo} --json body -q .body\`）。開発元は ${devRepo}。`,
    "",
    "## 出典",
    "- 誰の言葉: 定期の検査",
    `- いつ: ${date}`,
    "- 経路: 公開の同期の後の確認（scripts/release-check.ts --record）",
    "",
    "## 添付",
    "なし",
    "",
    "## 派生 PBI",
    "",
    "## 解釈メモ",
    "- 同じ段で落ちる間は同じ題になる。次のタグでも同じ段で落ちればこの要望にコメントが付く（閉じない）",
  ].join("\n");
  return { title: requestTitleOf(r.failedStep), body };
}

export interface RecordDeps {
  /** The development repository (origin), and the public one the Release is in. */
  devRepo: string;
  publicRepo: string;
  /** The body of the public Release of `tag`, or null when it cannot be read. */
  readBody: (tag: string) => string | null;
  /** The tag of the public repository's current Latest Release, or null when there is none. Throws when it cannot be read. */
  latestTag: () => string | null;
  /**
   * Write the body, and with `release` make the Release not a prerelease, in one edit: `latest` also makes it Latest,
   * `not-latest` leaves Latest where it is (the Release is older than the current one).
   */
  edit: (tag: string, body: string, release: "none" | "latest" | "not-latest") => void;
  file: (req: { title: string; body: string }) => Promise<Filed>;
  comment: (ref: string, body: string) => Promise<void>;
  text: (ref: string) => Promise<string>;
  log: (line: string) => void;
  date?: string;
}

/**
 * Write a result where it is read. Not judged: nothing, anywhere. Pass: the public body gets the line and the Release
 * becomes Latest. Fail: the public body gets the line alone, and a request (or a comment on the open one) is the
 * durable record, made even when the public write fails. A body that cannot be read is an error and nothing is written
 * to it (so a pass does not make Latest what could not be marked).
 */
export async function recordResult(r: CheckResult, d: RecordDeps): Promise<void> {
  if (r.undecided) return;
  const sha = r.sha;
  let unrecorded: unknown = null;
  if (!sha) unrecorded = new Error(`${r.tag} has no commit: no line to write`);
  else {
    try {
      const body = d.readBody(r.tag);
      if (body === null) throw new Error(`the Release of ${r.tag} in ${d.publicRepo} cannot be read`);
      const verdict = r.ok ? "pass" : "fail";
      const marked = checkResult(body, sha) === verdict;
      // a Latest that cannot be read throws here: nothing is written and the next run tries again
      const release = !r.ok ? "none" : notOlderThan(r.tag, d.latestTag()) ? "latest" : "not-latest";
      d.edit(r.tag, marked ? body : `${body.trimEnd()}\n${bodyLine(r)}\n`.trimStart(), release);
      d.log(`${r.tag} (${d.publicRepo}): ${marked ? "" : `${bodyLine(r)} を書いた`}${release === "latest" ? " Latest にした" : release === "not-latest" ? " プレリリースを外した（今の Latest より古いので Latest にはしない）" : ""}`.trim());
    } catch (e) {
      unrecorded = e;
    }
  }
  if (!r.ok) await fileFailure(r, d);
  if (unrecorded !== null) throw unrecorded;
}

async function fileFailure(r: CheckResult, d: RecordDeps): Promise<void> {
  const req = failureRequest(r, d.devRepo, d.publicRepo, d.date);
  const filed = await d.file(req);
  if (!("open" in filed)) {
    d.log(`要望を立てた: ${filed.filed === null ? "番号不明" : `#${filed.filed}`}`);
    return;
  }
  const named = releaseName(r);
  if ((await d.text(filed.open)).includes(named)) return;
  await d.comment(filed.open, `${named}でも同じ段で落ちた。\n\n\`\`\`\`text\n落ちた段: ${r.failedStep ?? "準備"}\n${outputLines(r.reason ?? "").join("\n")}\n\`\`\`\``);
  d.log(`要望: 既存 ${filed.open} にコメントした（起票しない）`);
}

/** Whether `tag` is the same version as `latest` or a newer one (null: there is none). Tags that are not versions are not. */
export function notOlderThan(tag: string, latest: string | null): boolean {
  if (latest === null) return true;
  const v = (t: string) => (TAG.test(t) ? t.slice(1).split(".").map(Number) : null);
  const a = v(tag);
  const b = v(latest);
  if (!a) return false;
  if (!b) return true;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

/** The Latest tag out of `gh api -i repos/<repo>/releases/latest`: a 404 is no Latest (null), anything else unread throws. */
export function latestFromApi(r: { ok: boolean; out: string }): string | null {
  const status = /^HTTP\/\S+ (\d+)/.exec(r.out)?.[1];
  if (status === "404") return null;
  if (status !== "200" || !r.ok) throw new Error(`the Latest Release of the public repository cannot be read (${status ? `HTTP ${status}` : "no answer"})`);
  const tag = (JSON.parse(r.out.split(/\r?\n\r?\n/).slice(1).join("\n\n")) as { tag_name?: unknown }).tag_name;
  if (typeof tag !== "string" || !tag) throw new Error("the Latest Release of the public repository has no tag_name");
  return tag;
}

/** The real writes: gh from this process (never from the check's daemon), in the public repository. */
export const realRecordDeps = (devRepo: string, publicRepo: string, sh: Sh = spawnSh): RecordDeps => ({
  devRepo,
  publicRepo,
  readBody: (tag) => {
    const r = sh(["gh", "release", "view", tag, "-R", publicRepo, "--json", "body", "-q", ".body"]);
    return r.ok ? r.out : null;
  },
  latestTag: () => latestFromApi(sh(["gh", "api", "-i", `repos/${publicRepo}/releases/latest`])),
  edit: (tag, body, release) => void must(sh, ["gh", "release", "edit", tag, "-R", publicRepo, "--notes-file", "-", ...(release === "latest" ? ["--prerelease=false", "--latest"] : release === "not-latest" ? ["--prerelease=false", "--latest=false"] : [])], body),
  file: (req) => fileRequest(req),
  comment: (ref, body) => commentRequest(ref, body),
  text: (ref) => requestText(ref),
  log: (l) => console.log(l),
});

/** `<tag> [--model <value>] [--wait-ms <n>] [--record]` (`--wait-ms`: how long each wait of the check may take; default 10 minutes). */
export function parseArgs(args: string[]): { tag: string; model?: string; waitMs?: number; record?: boolean } | null {
  if (!TAG.test(args[0] ?? "")) return null;
  const out: { tag: string; model?: string; waitMs?: number; record?: boolean } = { tag: args[0]! };
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--record" && !out.record) out.record = true;
    else if (rest[i] === "--model" && rest[i + 1] && !out.model) out.model = rest[++i]!;
    else if (rest[i] === "--wait-ms" && !out.waitMs && Number.isInteger(Number(rest[i + 1])) && Number(rest[i + 1]) > 0) out.waitMs = Number(rest[++i]);
    else return null;
  }
  return out;
}

export const realCheckDeps = (): CheckDeps => ({
  ...realDeps(),
  startReleases: (o) => {
    const f = startFakeReleases(o);
    return { url: f.url, setLatest: f.setLatest, stop: () => void f.stop() };
  },
  userHome: process.env.HOME ?? "",
});

/** What the command prints after the steps, and its exit code: an undecided check has no result line and exits 2. */
export function outcomeOf(r: CheckResult): { lines: string[]; code: number } {
  if (r.undecided) return { lines: [`? could not judge: ${r.undecided}`], code: 2 };
  return { lines: [...(r.reason ? [`✗ ${r.reason.slice(-1500)}`] : []), ...(r.detail ? [r.detail.slice(-1500)] : []), resultLine(r)], code: r.ok ? 0 : 1 };
}

if (import.meta.main) {
  const a = parseArgs(process.argv.slice(2));
  if (!a) {
    console.error("usage: bun scripts/release-check.ts <public tag, v1.2.3> [--model <value>] [--wait-ms <n>] [--record]");
    process.exit(2);
  }
  const repo = (JSON.parse(readFileSync(join(import.meta.dir, "..", "ops.config.json"), "utf8")) as { publicSync?: { target?: string } }).publicSync?.target;
  if (!repo) {
    console.error("ops.config.json has no publicSync.target");
    process.exit(2);
  }
  const r = await withHeavySlot("release-check", () => checkRelease({ tag: a.tag, repo, waitMs: a.waitMs ?? 600_000, ...(a.model ? { model: a.model } : {}), log: (l) => console.log(l) }, realCheckDeps()));
  const out = outcomeOf(r);
  // the result line is the last line of the command, the record's log comes before it
  for (const l of out.lines.slice(0, -1)) console.log(l);
  if (a.record && !r.undecided) {
    // the check is over and its daemon stopped: only this process writes, and only here is gh used
    try {
      await recordResult(r, realRecordDeps(currentRepo(), repo));
    } catch (e) {
      console.log(out.lines[out.lines.length - 1]);
      console.error(`--record: ${(e as Error).message}. Run it again`);
      process.exit(1);
    }
  }
  console.log(out.lines[out.lines.length - 1]);
  process.exit(out.code);
}
