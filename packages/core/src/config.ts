import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isMachineName } from "./machine.ts";

export interface CoreConfig {
  /** Data directory: sqlite db, logs. Override with SWITCHBOARD_HOME. */
  home: string;
  /**
   * `home` lives under a temporary directory: everything written there can vanish, and a later start without
   * the same SWITCHBOARD_HOME shows none of it. Surfaced in the boot log, /api/health and the UI.
   */
  homeIsTemp: boolean;
  /** `home` with the user's home directory shortened to `~` — for display only; the server knows homedir(), the browser does not. */
  homeDisplay: string;
  dbPath: string;
  port: number;
  host: string;
  /**
   * The repository agents edit: registered as the "meta" workspace, where self-dev checks run. SWITCHBOARD_REPO_ROOT
   * sets it when the daemon runs from an immutable release; otherwise it is the tree this code lives in.
   */
  repoRoot: string;
  /**
   * Where「GitHub から追加」clones and the only place a workspace's directory may be deleted with it: next to the
   * development checkout (`dirname(repoRoot)`) unless SWITCHBOARD_REPOS_DIR names another — the container, whose code
   * sits in /opt, points it at the repositories' volume.
   */
  reposDir: string;
  /** The tree this running code lives in (a release directory under sb-rescue): built web UI and shipped config defaults. */
  codeRoot: string;
  /**
   * Started by sb-rescue on a copy of the database to see whether this version boots (SWITCHBOARD_CANDIDATE=1).
   * Nothing may act on that copy by itself: no schedules, no usage-limit resumes, no session-log import.
   */
  candidate: boolean;
  /** sb-rescue's address when it started this daemon from a release (SWITCHBOARD_RESCUE_URL): promotion goes through it. */
  rescueUrl?: string;
  /** 人が開く救援画面の URL。sb-rescue の管理下のときだけ: クラウドホストは SWITCHBOARD_WEB_URL の /rescue/、Mac は rescueUrl。コンテナの中（rescueInContainer）では無い。 */
  rescuePageUrl?: string;
  /**
   * sb-rescue answers on the container's own loopback only (SWITCHBOARD_RESCUE_IN_CONTAINER=1, set by container/entrypoint.sh):
   * no address of it opens in a browser outside the container, so no page is named and the screen shows the commands that reach it.
   */
  rescueInContainer: boolean;
  /** Optional built web UI to serve when present. */
  webDist: string;
  /** How long a finished runner process is kept alive for follow-ups before it is released (then `--resume` is used). */
  runnerIdleMs: number;
  /** How long a review job may print nothing before `ops-kit idle-run` cuts it (seconds). Default 900, as cross-runner-review runs it. */
  jobReviewIdleS: number;
  /** How long sb-dockerd may run with no container and no docker client before the daemon stops it (ms). */
  dockerdIdleMs: number;
  /**
   * How long a Workspace's shell (the terminal opened without a Task) may stay with no socket attached and no input or
   * output before it is closed and stops keeping the host from its idle stop (SWITCHBOARD_WORKSPACE_SHELL_IDLE_MIN,
   * minutes; 30). A Task's shell ends with its Task instead.
   */
  workspaceShellIdleMs: number;
  /**
   * The Markdown folder that is the source of truth for rules / commands / notes. Override with SWITCHBOARD_KNOWLEDGE.
   * Default ~/Knowledge, or <home>/Knowledge when the data folder is temporary (a test or a fake-runner daemon must not
   * write into the user's notes).
   */
  knowledgeDir: string;
  /** Local API token file. Required on /api and /ws when `host` is not loopback. */
  tokenPath: string;
  /** Public base URL handed to MCP clients (e.g. inside Docker use http://host.docker.internal:47831). On loopback its host name is also an allowed Host. */
  publicUrl?: string;
  /** Claude Code's session logs. Override with SWITCHBOARD_CLAUDE_PROJECTS; tests point it at an empty folder. */
  claudeProjectsDir: string;
  /** Where Claude Code writes its /insights report (`report.html`): `<CLAUDE_CONFIG_DIR or ~/.claude>/usage-data`. Override with SWITCHBOARD_CLAUDE_USAGE_DATA (tests). */
  claudeUsageDataDir: string;
  /** Codex's home: session logs under `sessions/` (moved by export / import). Override with SWITCHBOARD_CODEX_HOME. */
  codexHome: string;
  /** Uploaded attachments, inside `home`. */
  attachmentsDir: string;
  /** Registered reports, inside `home`: `<taskId>/<artifactId>/…`. */
  artifactsDir: string;
  /** How often the logs are re-read for terminal sessions; 0 = only at boot and on POST /api/history/import. */
  historyPollMs: number;
  /**
   * The environment's stop command (SWITCHBOARD_IDLE_STOP_CMD): called with the next wake time (ISO, or "-")
   * after 20 idle minutes. Only a machine that may be stopped sets it (the cloud host); unset = the daemon never asks.
   */
  idleStopCmd?: string;
  /**
   * The CDN's shared origin header value (SWITCHBOARD_EDGE_HEADER_VALUE): set on a cloud host, every request not
   * from this machine must carry it. Unset = no check (a Mac, the Tailscale route).
   */
  edgeHeaderValue?: string;
  /**
   * GitHub's Webhook may reach POST /api/backlog/webhooks/github without the token (SWITCHBOARD_GITHUB_WEBHOOK=1):
   * the user opens it, as it is the one route anyone who reaches the daemon may call. Off = it asks for the token as
   * every other route does. It opens only with `githubWebhookSecret` as well.
   */
  githubWebhook: boolean;
  /** The Webhook's Secret on GitHub (SWITCHBOARD_GITHUB_WEBHOOK_SECRET): each delivery's X-Hub-Signature-256 must match it. Unset = the route stays closed. */
  githubWebhookSecret?: string;
  /**
   * Verifies the cloud host's login cookie (`sb_session`; SWITCHBOARD_SESSION_PUBLIC_KEY): the Ed25519 public
   * key, raw 32 bytes in base64url. The seed that signs stays with the Starter. Unset = tokens only.
   */
  sessionPublicKey?: string;
  /** The cloud host's Starter (SWITCHBOARD_STARTER_URL): asked whether a login cookie's passkey is still registered. */
  starterUrl?: string;
  /** Whether this daemon is one of two that share work through the uplink bucket, and as which (`loadUplink`). */
  uplink: UplinkConfig;
}

/**
 * How this daemon shares work with another machine's (SWITCHBOARD_UPLINK, and in this version only together with
 * `UPLINK_PREVIEW`: see `loadUplink`). Unset, or set without that second variable = it is alone: nothing below is used
 * and S3 is never asked.
 *  - `send`: a work machine. It holds no record of its own for long and never writes to the backlog's service: its
 *    Tasks' records and its backlog edits go to the uplink bucket, its backlog is a copy of the instance's.
 *  - `receive`: the instance. It takes in what work machines put there.
 * Both take a lease on a PBI before they start it (lease.ts).
 */
export interface UplinkConfig {
  mode: "send" | "receive" | null;
  /** This machine's name in what it sends and in its leases (SWITCHBOARD_MACHINE); the instance's default is `instance`. */
  machine: string;
  /**
   * The instance only: the work machines it takes anything from, each with the repositories it is registered for
   * (SWITCHBOARD_UPLINK_MACHINES, `parseMachines`). Empty = nothing is taken in from anyone and the bucket's `uplink/`
   * and `backlog/` are never read. What a key or an object says about its machine is checked against this, never trusted.
   */
  machines: Record<string, string[]>;
  /** SWITCHBOARD_UPLINK_BUCKET; empty on the instance = read from the parameter the template wrote. */
  bucket: string;
  /** How often a work machine sends and the instance takes in (SWITCHBOARD_UPLINK_INTERVAL_S; 5 and 10 minutes). */
  intervalMs: number;
  /** The most one delta holds before it is cut (SWITCHBOARD_UPLINK_MAX_BYTES); unset = uplink.ts's own. */
  maxBytes?: number;
  /** How long a lease lasts without being renewed, and how often it is renewed (SWITCHBOARD_LEASE_TTL_S 900, SWITCHBOARD_LEASE_RENEW_S 60). */
  leaseTtlMs: number;
  leaseRenewMs: number;
  /** How long one request of the lease store may take before it is given up (SWITCHBOARD_LEASE_CALL_TIMEOUT_S, 20); a request that never answers must not hold the renewal round. */
  leaseCallTimeoutMs: number;
  /** A work machine's copy of the instance's database: the Litestream replica's URL (SWITCHBOARD_REPLICA_URL) and how often it is taken (SWITCHBOARD_REPLICA_INTERVAL_S, 60 minutes). */
  replicaUrl: string;
  replicaIntervalMs: number;
}

/**
 * `SWITCHBOARD_UPLINK_MACHINES`: `pc1=acme/app+acme/tools,pc2=acme/app` — each work machine the instance takes
 * anything from, with the repositories (`owner/name`, compared without case) it may send backlog edits and Tasks for.
 * A value that cannot be read stops the start: a registry read half would take in from a machine nobody named.
 */
export function parseMachines(raw: string, own: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const [name, repos = ""] = part.split("=");
    const list = repos.split("+").map((r) => r.trim().toLowerCase());
    if (!isMachineName(name) || name === own || name! in out || part.split("=").length !== 2 || list.length === 0 || list.some((r) => !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9._-]+$/.test(r) || r.includes("..")))
      throw new Error(`SWITCHBOARD_UPLINK_MACHINES: "${part}" is not <machine>=<owner/name>[+<owner/name>…] (a machine is named once and is not this one, "${own}")`);
    out[name] = list;
  }
  return out;
}

/**
 * The second variable sharing work needs in this version, with the one value it takes. `SWITCHBOARD_UPLINK` alone
 * switches nothing on: the feature has not been tried against real AWS, and its conditions for deployment
 * (docs/design/work-machine.md, "Before deployment") are not met — it is not for use until they are. Whoever sets this
 * says they are running it before that, on purpose (the tests of the feature do).
 */
export const UPLINK_PREVIEW = { SWITCHBOARD_UPLINK_PREVIEW: "not-for-use" } as const;

export function loadUplink(env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = (line) => console.warn(line)): UplinkConfig {
  const asked = env.SWITCHBOARD_UPLINK ?? "";
  if (asked !== "" && asked !== "send" && asked !== "receive") throw new Error(`SWITCHBOARD_UPLINK is "${asked}": it is "send" (a work machine), "receive" (the instance) or unset`);
  // The one entrance of the feature. Without the second variable the mode is none, and everything that reads the mode
  // (the bucket, the leases, the timers, the work machine's role) stays as on a daemon that runs alone.
  const preview = env.SWITCHBOARD_UPLINK_PREVIEW === UPLINK_PREVIEW.SWITCHBOARD_UPLINK_PREVIEW;
  // A work machine must not start as an instance of its own instead (it would write to the forge and decide by itself): it does not start.
  if (asked === "send" && !preview) throw new Error(`SWITCHBOARD_UPLINK=send is not available in this version: a work machine is not for use until the conditions of docs/design/work-machine.md ("Before deployment") are met. This daemon does not start as a work machine, and it does not start alone in its place.`);
  if (asked === "receive" && !preview) warn(`[uplink] SWITCHBOARD_UPLINK=receive is set, and sharing work with another machine is not available in this version (docs/design/work-machine.md, "Before deployment"): this daemon runs alone — nothing is read from or written to the uplink bucket, and no lease is taken`);
  const raw = preview ? asked : "";
  const mode = raw === "" ? null : raw;
  const machine = env.SWITCHBOARD_MACHINE ?? (mode === "receive" ? "instance" : "");
  if (mode && !isMachineName(machine)) throw new Error(`SWITCHBOARD_UPLINK=${mode} needs SWITCHBOARD_MACHINE: a name that starts with a letter or a digit and holds letters, digits, "_" and "-" (it is "${machine}")`);
  if (mode === "send" && !env.SWITCHBOARD_UPLINK_BUCKET) throw new Error("SWITCHBOARD_UPLINK=send needs SWITCHBOARD_UPLINK_BUCKET");
  const machines = mode === "receive" ? parseMachines(env.SWITCHBOARD_UPLINK_MACHINES ?? "", machine) : {};
  const maxBytes = positiveOr(env.SWITCHBOARD_UPLINK_MAX_BYTES, 0);
  return {
    mode,
    machine,
    machines,
    bucket: env.SWITCHBOARD_UPLINK_BUCKET ?? "",
    intervalMs: positiveOr(env.SWITCHBOARD_UPLINK_INTERVAL_S, mode === "receive" ? 600 : 300) * 1000,
    ...(maxBytes > 0 ? { maxBytes } : {}),
    leaseTtlMs: positiveOr(env.SWITCHBOARD_LEASE_TTL_S, 900) * 1000,
    leaseRenewMs: positiveOr(env.SWITCHBOARD_LEASE_RENEW_S, 60) * 1000,
    leaseCallTimeoutMs: positiveOr(env.SWITCHBOARD_LEASE_CALL_TIMEOUT_S, 20) * 1000,
    replicaUrl: env.SWITCHBOARD_REPLICA_URL ?? "",
    replicaIntervalMs: positiveOr(env.SWITCHBOARD_REPLICA_INTERVAL_S, 3600) * 1000,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const home = env.SWITCHBOARD_HOME ? resolve(env.SWITCHBOARD_HOME) : join(homedir(), ".switchboard");
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  const codeRoot = findRepoRoot(import.meta.dir);
  const repoRoot = env.SWITCHBOARD_REPO_ROOT ? resolve(env.SWITCHBOARD_REPO_ROOT) : codeRoot;
  const dbPath = env.SWITCHBOARD_DB ?? join(home, "switchboard.db");
  const homeIsTemp = isTempDir(home) || isTempDir(dbPath);
  return {
    home,
    homeIsTemp,
    homeDisplay: home === homedir() ? "~" : home.startsWith(`${homedir()}/`) ? `~${home.slice(homedir().length)}` : home,
    dbPath,
    port: Number(env.SWITCHBOARD_PORT ?? 47831),
    host: env.SWITCHBOARD_HOST ?? "127.0.0.1",
    repoRoot,
    reposDir: env.SWITCHBOARD_REPOS_DIR ? resolve(env.SWITCHBOARD_REPOS_DIR) : dirname(repoRoot),
    codeRoot,
    candidate: env.SWITCHBOARD_CANDIDATE === "1",
    rescueUrl: env.SWITCHBOARD_RESCUE_URL || undefined,
    rescueInContainer: env.SWITCHBOARD_RESCUE_IN_CONTAINER === "1",
    rescuePageUrl: env.SWITCHBOARD_RESCUE_URL && env.SWITCHBOARD_RESCUE_IN_CONTAINER !== "1" ? (env.SWITCHBOARD_WEB_URL ? `${env.SWITCHBOARD_WEB_URL.replace(/\/+$/, "")}/rescue/` : env.SWITCHBOARD_RESCUE_URL) : undefined,
    idleStopCmd: env.SWITCHBOARD_IDLE_STOP_CMD || undefined,
    edgeHeaderValue: env.SWITCHBOARD_EDGE_HEADER_VALUE || undefined,
    githubWebhook: env.SWITCHBOARD_GITHUB_WEBHOOK === "1",
    githubWebhookSecret: env.SWITCHBOARD_GITHUB_WEBHOOK_SECRET || undefined,
    // anything but a 32-byte key in base64url = no cookie login
    sessionPublicKey: /^[A-Za-z0-9_-]{43}$/.test(env.SWITCHBOARD_SESSION_PUBLIC_KEY ?? "") ? env.SWITCHBOARD_SESSION_PUBLIC_KEY : undefined,
    starterUrl: env.SWITCHBOARD_STARTER_URL || undefined,
    webDist: join(codeRoot, "apps", "web", "dist"),
    runnerIdleMs: numberOr(env.SWITCHBOARD_RUNNER_IDLE_MS, 10 * 60 * 1000),
    jobReviewIdleS: numberOr(env.SWITCHBOARD_JOB_REVIEW_IDLE_S, 900),
    dockerdIdleMs: positiveOr(env.SWITCHBOARD_DOCKERD_IDLE_MIN, 10) * 60_000,
    workspaceShellIdleMs: positiveOr(env.SWITCHBOARD_WORKSPACE_SHELL_IDLE_MIN, 30) * 60_000,
    knowledgeDir: env.SWITCHBOARD_KNOWLEDGE ? resolve(expandHome(env.SWITCHBOARD_KNOWLEDGE)) : join(homeIsTemp ? home : homedir(), "Knowledge"),
    tokenPath: env.SWITCHBOARD_TOKEN_FILE ?? join(home, "token"),
    publicUrl: env.SWITCHBOARD_PUBLIC_URL,
    claudeProjectsDir: env.SWITCHBOARD_CLAUDE_PROJECTS ? resolve(expandHome(env.SWITCHBOARD_CLAUDE_PROJECTS)) : join(homedir(), ".claude", "projects"),
    claudeUsageDataDir: env.SWITCHBOARD_CLAUDE_USAGE_DATA ? resolve(expandHome(env.SWITCHBOARD_CLAUDE_USAGE_DATA)) : join(env.CLAUDE_CONFIG_DIR ? resolve(expandHome(env.CLAUDE_CONFIG_DIR)) : join(homedir(), ".claude"), "usage-data"),
    codexHome: env.SWITCHBOARD_CODEX_HOME ? resolve(expandHome(env.SWITCHBOARD_CODEX_HOME)) : join(homedir(), ".codex"),
    attachmentsDir: join(home, "attachments"),
    artifactsDir: join(home, "artifacts"),
    historyPollMs: numberOr(env.SWITCHBOARD_HISTORY_POLL_MS, 30_000),
    uplink: loadUplink(env),
  };
}

/** Whether a path is inside the OS temp area (os.tmpdir(), /tmp, macOS /var/folders). Symlinks resolved on both sides. */
export function isTempDir(p: string): boolean {
  const real = (x: string) => {
    try {
      return realpathSync(x);
    } catch {
      return resolve(x);
    }
  };
  // Compare raw and resolved forms on both sides: the path may not exist yet (realpath fails) while the roots do
  // (/var/folders → /private/var/folders on macOS), and vice versa.
  const targets = [resolve(p), real(p)];
  const roots = [tmpdir(), "/tmp", "/var/tmp", "/var/folders", "/private/tmp", "/private/var/tmp", "/private/var/folders"].flatMap((r) => [resolve(r), real(r)]);
  return roots.some((r) => targets.some((t) => t === r || t.startsWith(r.endsWith("/") ? r : `${r}/`)));
}

/** `~/x` → `$HOME/x` (launchd / systemd env files do not expand it). */
function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** Parse a numeric env var; anything that is not a finite number falls back (so "10m" does not become NaN → 0). */
function numberOr(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function positiveOr(raw: string | undefined, fallback: number): number {
  const n = numberOr(raw, fallback);
  return n > 0 ? n : fallback;
}

/** Walk up until we find the workspace root package.json named "switchboard". */
export function findRepoRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(require("node:fs").readFileSync(pkg, "utf8"));
        if (json?.name === "switchboard") return dir;
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from, "..", "..", "..");
}

/** Where "continue locally" runs a Cloud Task's continuation: a git worktree inside the clone, where the official CLI also puts its own. */
export function teleportWorktreePath(cwd: string, cloudTaskId: string): string {
  return join(cwd, ".claude", "worktrees", `teleport-${cloudTaskId}`);
}
