/**
 * The rescue page (#178): one screen that works while Switchboard is down. Everything that changes state is a POST
 * that answers 202 and runs in the background, one at a time; the page polls /api/status to follow it.
 * Same defences as the daemon: a request with an Origin must come from this page, and off loopback every request
 * needs the token in `<home>/token` — on the cloud host the login cookie (#211) instead, since there the token counts only
 * from this machine (#748). With the cookie, a state-changing POST also needs a passkey check within 5 minutes (the
 * Starter's sb_recent, #497); the token and loopback do not.
 * /tmp (#797) is read only on request (GET /api/tmp, not in /api/status) and its clean answers 200 at once, outside `operate`.
 * Every 30 minutes sb-rescue also cleans it by itself (#1720), with the same judgement as the button, and with it local CI's leftovers
 * under ~/.cache and, on a machine of Switchboard's own, uv's and bun's caches and docker's unused images (#2549). GET /api/tmp
 * says how full the root disk is (`disk`) and when each kind was last cleaned (`sweeps`).
 */
import { createPublicKey, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RescueAgent } from "./agent.ts";
import page from "./page.html" with { type: "text" };
import { checkDaemon, listSnapshots, promote, restoreDb, rollback, tasksThatStop, type Ctx } from "./promote.ts";
import { sweepCaches, sweepCacheWork, sweepDocker } from "./cache.ts";
import { cleanTmp, diskUsage, scanTmp, SWEEP_MS, sweepTmp, type TmpJudge, type TmpSweep } from "./tmp.ts";
import { appendHistory, currentOf, listReleases, previousOf, readHistory, run } from "./releases.ts";

export interface RescueOptions {
  port: number;
  host?: string;
  /** The rescue agent's command line (tests and the E2E pass a fake; the default is `claude -p` with an allowlist). */
  agentArgv?: string[];
  /**
   * The cloud host's Starter (#181, aws/starter.ts): 作り直す replaces the instance through it. Unset (a Mac) = no
   * such button; the route answers 404.
   */
  starter?: { url: string; token: string };
  /**
   * What the environment saves before 作り直す replaces the disk (#403, SWITCHBOARD_REBUILD_SAVE_CMD; the cloud host's
   * sb-runner-sync puts the runners' records in S3). A failure stops the rebuild. Unset = nothing to save.
   */
  beforeRebuild?: string[];
  /** How long the save may take (default 10 s: with the Starter's 15 s it stays under CloudFront's 30 s origin timeout). */
  beforeRebuildLimitMs?: number;
  /**
   * The cloud host's login (#211, #701): the starter Lambda signs an `sb_session` cookie after a passkey check with a
   * seed only it reads, and this public key (SWITCHBOARD_SESSION_PUBLIC_KEY, raw 32 bytes in base64url) verifies it here
   * as it does in the daemon. Unset (a Mac) = the token only.
   */
  sessionPublicKey?: string;
  /** CloudFront's shared header value (SWITCHBOARD_EDGE_HEADER_VALUE), sent when the Starter is asked about a cookie (#708). */
  edge?: string;
  /** How long a Starter answer about a cookie is kept (#708); tests shorten it. Unset = SESSION_RECHECK_MS. */
  sessionKeepMs?: number;
  /** Overrides where a request came from (#748); a test makes 127.0.0.1 look like another machine. Unset = the socket's peer. */
  peerAddress?: (req: Request) => string | undefined;
  /**
   * 再起動 ends sb-rescue itself rather than the daemon alone (#435): the cloud host's systemd (Restart=always) starts it
   * again after its ExecStartPre, so the environment (Parameter Store, through sb-env) and the host scripts are read
   * again. Set by SWITCHBOARD_RESCUE_RESTART_BY_EXIT. Unset (a Mac) = the daemon alone, with the environment it has.
   */
  exitToRestart?: () => void;
  /** The /tmp the page shows and cleans (#797); tests pass a fake. Default "/tmp" (not os.tmpdir(), which follows TMPDIR). */
  tmpDir?: string;
  /**
   * The machine is Switchboard's alone (SWITCHBOARD_RESCUE_OWNS_TMP=1, the cloud host): /tmp's clean also takes any mktemp directory
   * and cache, and the automatic clean also takes uv's and bun's caches and the images no docker container uses (#2549).
   */
  tmpOwned?: boolean;
  /** Where local CI leaves its working directories and logs, swept with /tmp (#2549); tests pass a fake. Default ~/.cache. */
  cacheDir?: string;
  /** Whose uv and bun caches the automatic clean takes on a machine of Switchboard's own (#2549); tests pass a fake. Default homedir(). */
  home?: string;
  /** Runs the docker prune of the automatic clean (#2549); tests pass a fake. Default: the real docker. */
  dockerSh?: (argv: string[]) => Promise<string>;
  /** The interval of the automatic /tmp clean (#1720); tests shorten it. Default SWEEP_MS. */
  tmpSweepMs?: number;
}

const isLoopback = (host: string) => host === "127.0.0.1" || host === "localhost" || host === "::1";

/** Host names (as `URL.hostname` spells them) that mean this machine. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * DNS rebinding defence (#1135): on loopback no token is asked, and a page on a name that now resolves to 127.0.0.1
 * sends that name as both Origin and Host. The Host's name must be a loopback name; the port is not compared. No Host
 * header = the request URL's host. Unparsable = refused. The same rule as the daemon's hostAllowed
 * (packages/core/src/auth.ts): change both together.
 */
function hostAllowed(req: Request): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL("http://" + (req.headers.get("host") ?? new URL(req.url).host)).hostname);
  } catch {
    return false;
  }
}

function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.get("host") ?? new URL(req.url).host);
  } catch {
    return false;
  }
}

function tokenEquals(a: string | null, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The login's limits (#498): 7 days from the sign-in, 24 hours from the last action. The same values as aws/auth.ts and
 *  packages/core/src/auth.ts (aws/session-contract.test.ts pins them). */
export const SESSION_MAX_MS = 7 * 24 * 3600_000;
export const SESSION_IDLE_MS = 24 * 3600_000;

/**
 * `<body>.<sig>`: body = base64url of the UTF-8 text `<passkeyId>.<idleUntilMs>.<expiresMs>` (a session) or `<passkeyId>.<expiresMs>` (a recent check), sig = base64url of the Ed25519 signature
 * over prefix + the base64url text of body (as aws/auth.ts signs it with a seed only the Starter reads), checked with the
 * public key. The passkey id when it verifies, no time has passed and idle-until is not past the cap, else undefined. Written again here rather than
 * imported: sb-rescue shares no code with Switchboard (#178).
 */
function signedId(raw: string, publicKey: string, prefix: string, now: number): string | undefined {
  if (!raw || raw.length > 512) return;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return;
  const body = raw.slice(0, dot);
  const sigText = raw.slice(dot + 1);
  const sig = Buffer.from(sigText, "base64url");
  if (sig.length !== 64 || sig.toString("base64url") !== sigText) return; // one spelling per signature
  try {
    if (!verify(null, Buffer.from(prefix + body), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" }), sig)) return;
  } catch {
    return;
  }
  const [id, ...at] = Buffer.from(body, "base64url").toString("utf8").split(".");
  const ms = at.map(Number);
  if (!id || ms.length !== (prefix === "" ? 2 : 1) || !ms.every((t) => Number.isFinite(t) && t > now)) return;
  return ms.every((t, i) => i === 0 || t >= ms[i - 1]!) ? id : undefined;
}
/** The passkey ids of every valid `<name>=` pair (every pair is tried: a stale one first does not hide the good one). */
function signedIds(req: Request, name: string, publicKey: string, prefix: string, now: number): string[] {
  const pairs = (req.headers.get("cookie") ?? "").split(";").map((v) => v.trim()).filter((v) => v.startsWith(`${name}=`));
  return pairs.map((pair) => signedId(pair.slice(name.length + 1), publicKey, prefix, now)).filter((id): id is string => id !== undefined);
}
/** A passkey check within 5 minutes (#497): an `sb_recent` (signed over "recent:" + body) by a valid session's passkey. */
export function recentCookieOk(req: Request, publicKey: string | undefined, now = Date.now()): boolean {
  if (!publicKey) return false;
  const sessions = signedIds(req, "sb_session", publicKey, "", now);
  return signedIds(req, "sb_recent", publicKey, "recent:", now).some((id) => sessions.includes(id));
}

/** How long a Starter answer about a login cookie is trusted (#708): a removed passkey is shut out within this. */
export const SESSION_RECHECK_MS = 5 * 60_000;

/**
 * The cookie check with revocation (#708), as the daemon does it (written again: no shared code, #178): a verified
 * `sb_session` is asked about at the Starter's `GET /_auth/status`, whose `loggedIn` is true only while its passkey is
 * registered; the answer is kept per cookie. No answer refuses and is not kept. No Starter = no cookie is valid.
 */
function makeSessionCheck(o: RescueOptions) {
  const keep = o.sessionKeepMs ?? SESSION_RECHECK_MS;
  const answers = new Map<string, { ok: boolean; at: number }>();
  const asking = new Map<string, Promise<boolean>>();
  const ask = (value: string): Promise<boolean> => {
    const pending = asking.get(value);
    if (pending) return pending;
    const p = (async () => {
      try {
        const headers: Record<string, string> = { cookie: `sb_session=${value}` };
        if (o.edge) headers["x-switchboard-edge"] = o.edge;
        const r = await fetch(`${o.starter!.url.replace(/\/+$/, "")}/_auth/status`, { headers, signal: AbortSignal.timeout(5000) });
        if (!r.ok) return false;
        const ok = ((await r.json()) as { loggedIn?: unknown }).loggedIn === true;
        const t = Date.now();
        for (const [k, v] of answers) if (t - v.at >= keep) answers.delete(k);
        answers.set(value, { ok, at: t });
        return ok;
      } catch {
        return false;
      } finally {
        asking.delete(value);
      }
    })();
    asking.set(value, p);
    return p;
  };
  return async (req: Request): Promise<boolean> => {
    if (!o.sessionPublicKey || !o.starter) return false;
    const now = Date.now();
    const pairs = (req.headers.get("cookie") ?? "").split(";").map((v) => v.trim()).filter((v) => v.startsWith("sb_session="));
    for (const pair of pairs) {
      const value = pair.slice("sb_session=".length);
      if (signedId(value, o.sessionPublicKey, "", now) === undefined) continue;
      const hit = answers.get(value);
      if (hit && now - hit.at < keep ? hit.ok : await ask(value)) return true;
    }
    return false;
  };
}

export function startRescue(ctx: Ctx, o: RescueOptions) {
  const host = o.host ?? "127.0.0.1";
  const tmpDir = o.tmpDir ?? "/tmp";
  const tmpJudge: TmpJudge = { owned: o.tmpOwned ?? false };
  // not at start: scripts/rescue-e2e.ts starts the bundle on the host's real /tmp
  const cacheDir = o.cacheDir ?? join(homedir(), ".cache");
  const home = o.home ?? homedir();
  const lastSweeps: Record<"tmp" | "work" | "cache" | "docker", TmpSweep | null> = { tmp: null, work: null, cache: null, docker: null };
  const sweepTimer = setInterval(async () => {
    try {
      lastSweeps.tmp = sweepTmp(tmpDir, tmpJudge);
    } catch (e) {
      console.error("tmp sweep failed:", e);
    }
    try {
      lastSweeps.work = await sweepCacheWork(cacheDir, tmpJudge);
    } catch (e) {
      console.error("cache sweep failed:", e);
    }
    if (!tmpJudge.owned) return; // the caches and docker are shared with the user's other apps
    try {
      lastSweeps.cache = sweepCaches(home, tmpJudge);
    } catch (e) {
      console.error("uv / bun cache sweep failed:", e);
    }
    try {
      lastSweeps.docker = await sweepDocker(tmpJudge, o.dockerSh);
    } catch (e) {
      console.error("docker sweep failed:", e);
    }
  }, o.tmpSweepMs ?? SWEEP_MS);
  const authRequired = !isLoopback(host);
  let busy: string | null = null;
  let lastError: string | null = null;
  const subjects = new Map<string, string>();
  const agent = new RescueAgent(ctx, o.agentArgv);

  const sessionCheck = makeSessionCheck(o);
  /** How the request is let in: loopback, the token, the login cookie (its passkey still registered, #708), or not at all. */
  // With the passkey login on (a cloud host), the token counts only from this machine (#748): CloudFront's VPC origin is
  // not loopback, so from outside only the cookie. Judged by the connection's peer, never a header.
  const tokenCounts = (req: Request) => {
    if (!o.sessionPublicKey) return true;
    const peer = o.peerAddress ? o.peerAddress(req) : server.requestIP(req)?.address;
    // the same rule as the daemon's isLoopbackAddress (packages/core/src/auth.ts): change both together
    return peer !== undefined && (peer === "::1" || peer.startsWith("127.") || peer.startsWith("::ffff:127."));
  };
  const authOf = async (req: Request, allowQuery: boolean): Promise<"open" | "token" | "cookie" | null> => {
    if (!authRequired) return "open";
    const file = join(ctx.home, "token");
    const token = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    const header = req.headers.get("authorization");
    const given = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : allowQuery ? new URL(req.url).searchParams.get("token") : null;
    return tokenCounts(req) && tokenEquals(given, token) ? "token" : (await sessionCheck(req)) ? "cookie" : null;
  };

  /** Run one state-changing operation in the background; a second one while it runs is refused. */
  const operate = (name: string, fn: () => Promise<unknown>): Response => {
    if (busy) return Response.json({ error: `busy: ${busy}` }, { status: 409 });
    busy = name;
    lastError = null;
    void fn()
      .catch((e) => (lastError = `${name}: ${String((e as Error).message ?? e)}`))
      .finally(() => (busy = null));
    return Response.json({ started: name }, { status: 202 });
  };

  /**
   * Release tags (#282): one `for-each-ref` per status read, commit → its highest `v*` tag. Not cached: CI tags a
   * commit after its merge and a tag can be moved by hand, and this stays one process however many releases there are.
   */
  const releaseTags = async (): Promise<Map<string, string>> => {
    const out = await run(["git", "-C", ctx.repo, "for-each-ref", "refs/tags/v*", "--sort=-v:refname", "--format=%(objectname) %(*objectname) %(refname:short)"], ctx.repo).catch(() => "");
    const bySha = new Map<string, string>();
    for (const line of out.split("\n")) {
      const [obj, peeled, name] = line.trim().split(" ");
      // an annotated tag names its commit in %(*objectname); a lightweight one has it empty and points at the commit
      const sha = peeled || obj;
      if (sha && name && !bySha.has(sha)) bySha.set(sha, name);
    }
    return bySha;
  };
  /** A release's commit subject (cached: it never changes) and its release tag. */
  const describe = async (sha: string, tags: Map<string, string>) => {
    if (!subjects.has(sha)) subjects.set(sha, await run(["git", "-C", ctx.repo, "log", "-1", "--format=%s", sha], ctx.repo).catch(() => ""));
    return { sha, subject: subjects.get(sha) ?? "", tag: tags.get(sha) ?? null };
  };

  const status = async () => {
    const [unhealthy, stopping] = await Promise.all([checkDaemon(ctx.port, ctx.home), tasksThatStop(ctx.port, ctx.home)]);
    return {
      current: currentOf(ctx.home),
      previous: previousOf(ctx.home),
      releases: await releaseTags().then((tags) => Promise.all(listReleases(ctx.home).map((sha) => describe(sha, tags)))),
      state: ctx.sup.state,
      running: ctx.sup.running,
      /** null = the daemon answers; otherwise why it does not. */
      unhealthy,
      /** The running and waiting tasks that 再起動 and the release switches stop (#435). */
      stopping,
      port: ctx.port,
      busy,
      lastError,
      history: readHistory(ctx.home).slice(-20).reverse(),
      snapshots: listSnapshots(ctx.home),
      log: ctx.sup.logTail(200),
      agent: agent.status(),
      rebuild: !!o.starter,
      /** 再起動 reads the environment and the host scripts again (#435). */
      restartReloads: !!o.exitToRestart,
    };
  };

  const server = Bun.serve({
    hostname: host,
    port: o.port,
    async fetch(req): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (!authRequired && !hostAllowed(req)) return Response.json({ error: `host not allowed: open http://127.0.0.1:${server.port}` }, { status: 403 });
      if (!sameOrigin(req)) return Response.json({ error: "cross-origin request refused" }, { status: 403 });
      const auth = await authOf(req, path === "/");
      if (!auth) return new Response(o.sessionPublicKey ? "unauthorized: log in with the passkey at /_auth/ and open /rescue/ again" : "unauthorized: open this page with ?token=<the contents of ~/.switchboard/token>", { status: 401 });
      if (req.method === "GET" && path === "/") return new Response(page as unknown as string, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'self' 'unsafe-inline'; frame-ancestors 'none'" } });
      if (req.method === "GET" && path === "/api/status") return Response.json(await status());
      if (req.method === "GET" && path === "/api/tmp") return Response.json({ ...scanTmp(tmpDir, tmpJudge), disk: diskUsage("/"), sweeps: lastSweeps });
      if (req.method !== "POST") return Response.json({ error: "not found" }, { status: 404 });
      if (auth === "cookie" && !recentCookieOk(req, o.sessionPublicKey)) return Response.json({ error: "操作の前にパスキーで確かめてください", reason: "recent" }, { status: 401 });
      // An empty body means "no arguments"; a body that does not parse is refused — a cut-off {commit} must not
      // turn "go back to this release" into "go back to the previous one".
      const text = await req.text();
      let body: { commit?: unknown; snapshot?: unknown; names?: unknown };
      try {
        body = text.trim() ? JSON.parse(text) : {};
        if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
      } catch {
        return Response.json({ error: "the request body is not a JSON object" }, { status: 400 });
      }
      const commit = typeof body.commit === "string" && /^[\w./-]{1,100}$/.test(body.commit) && !body.commit.startsWith("-") ? body.commit : undefined;
      switch (path) {
        case "/api/restart":
          if (o.exitToRestart) {
            const exit = o.exitToRestart;
            return operate("restart", async () => {
              await ctx.sup.stop();
              appendHistory(ctx.home, { action: "restart", from: currentOf(ctx.home), to: currentOf(ctx.home), ok: true, reason: "restarted sb-rescue from the rescue page: the environment and the host scripts are read again (#435)" });
              exit();
            });
          }
          return operate("restart", async () => {
            await ctx.sup.restart();
            appendHistory(ctx.home, { action: "restart", from: currentOf(ctx.home), to: currentOf(ctx.home), ok: true, reason: "restarted from the rescue page" });
          });
        case "/api/rollback":
          if (body.commit !== undefined && !(commit && listReleases(ctx.home).includes(commit))) return Response.json({ error: "no such release" }, { status: 400 });
          if (!commit && !previousOf(ctx.home)) return Response.json({ error: "there is no previous release" }, { status: 400 });
          return operate("rollback", () => rollback(ctx, commit));
        case "/api/promote":
          if (!commit) return Response.json({ error: "commit required" }, { status: 400 });
          return operate("promote", () => promote(ctx, commit));
        case "/api/restore-db":
          if (typeof body.snapshot !== "string" || !listSnapshots(ctx.home).includes(body.snapshot)) return Response.json({ error: "no such snapshot" }, { status: 400 });
          return operate("restore-db", () => restoreDb(ctx, body.snapshot as string));
        // Not under `operate`: the agent runs for minutes and must not block a rollback. It has no way to promote.
        case "/api/agent/start":
          try {
            await agent.start();
            return Response.json({ started: "agent" }, { status: 202 });
          } catch (e) {
            return Response.json({ error: String((e as Error).message ?? e) }, { status: 409 });
          }
        // Not under `operate` either: the Starter replaces this whole machine, including this process.
        case "/api/rebuild": {
          if (!o.starter) return Response.json({ error: "not a cloud host (SWITCHBOARD_STARTER_URL is unset)" }, { status: 404 });
          // a press after a refusal starts clean: the page must not show the last reason while this save runs (review #405)
          lastError = null;
          // a refusal stays in the status (lastError), which the page re-renders every 2 s, not only in this answer
          const refuse = (error: string) => ((lastError = `作り直す: ${error}`), Response.json({ error }, { status: 424 }));
          if (o.beforeRebuild?.length) {
            // Bounded: past CloudFront's 30 s the page would show a failure while this went on to rebuild anyway.
            const limit = o.beforeRebuildLimitMs ?? 10_000;
            // 424, not 502: CloudFront answers an origin 502 / 504 with the start page, and the reason would not reach the page (#364)
            const notSaved = (why: string) => refuse(`the runners' records were not saved (${o.beforeRebuild!.join(" ")}: ${why}); not rebuilding`);
            let save: ReturnType<typeof Bun.spawn<"ignore", "ignore", "pipe">>;
            try {
              save = Bun.spawn(o.beforeRebuild, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
            } catch (e) {
              return notSaved(String((e as Error).message ?? e));
            }
            // Answered at the limit whatever the save's own children do: aws or flock under bash keep stderr open after
            // the kill, and waiting for its end would run past CloudFront's 30 s again.
            let timer: ReturnType<typeof setTimeout> | undefined;
            const late = new Promise<"late">((done) => (timer = setTimeout(() => (save.kill(), done("late")), limit)));
            let result: "late" | [number, string];
            try {
              result = await Promise.race([Promise.all([save.exited, new Response(save.stderr).text()]), late]);
            } catch (e) {
              save.kill(); // the 424 goes out now; the save must not run on without its time limit (review #405)
              return notSaved(String((e as Error).message ?? e));
            } finally {
              clearTimeout(timer);
            }
            if (result === "late") return notSaved(`did not finish within ${limit / 1000} s`);
            const [code, err] = result;
            if (code !== 0) return notSaved(`exit ${code}${err.trim() ? `, ${err.trim().slice(-300)}` : ""}`);
          }
          const r = await fetch(`${o.starter.url.replace(/\/+$/, "")}/rebuild`, { method: "POST", headers: { "x-switchboard-start-token": o.starter.token, ...(o.edge ? { "x-switchboard-edge": o.edge } : {}) }, signal: AbortSignal.timeout(15_000) }).catch((e: Error) => e);
          if (r instanceof Error) return refuse(`the Starter did not answer: ${r.message}`);
          if (!r.ok) return refuse(`the Starter answered ${r.status}`);
          lastError = null;
          appendHistory(ctx.home, { action: "rebuild", from: currentOf(ctx.home), to: null, ok: true, reason: `作り直す from the rescue page: the root volume goes back to its launch state, sqlite comes back from Litestream${o.beforeRebuild?.length ? ", the runners' records from what was saved just now" : ""}` });
          return Response.json({ started: "rebuild" }, { status: 202 });
        }
        // Not under `operate`: unrelated to the releases, and removing a few directories takes seconds.
        case "/api/tmp/clean":
          if (!Array.isArray(body.names) || !body.names.every((n) => typeof n === "string")) return Response.json({ error: "names required" }, { status: 400 });
          return Response.json(cleanTmp(tmpDir, body.names as string[], tmpJudge));
        case "/api/agent/stop":
          await agent.stop();
          return Response.json({ stopped: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    },
  });
  return {
    server,
    stop: async () => {
      clearInterval(sweepTimer);
      await agent.stop();
      await server.stop(true);
    },
  };
}
