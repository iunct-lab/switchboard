import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface CoreConfig {
  /** Data directory: sqlite db, logs. Override with SWITCHBOARD_HOME. */
  home: string;
  /**
   * `home` lives under a temporary directory (#64): everything written there can vanish, and a later start without
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
   * sets it when the daemon runs from an immutable release (#178); otherwise it is the tree this code lives in.
   */
  repoRoot: string;
  /** The tree this running code lives in (a release directory under sb-rescue): built web UI and shipped config defaults. */
  codeRoot: string;
  /**
   * Started by sb-rescue on a copy of the database to see whether this version boots (#178, SWITCHBOARD_CANDIDATE=1).
   * Nothing may act on that copy by itself: no schedules, no usage-limit resumes, no session-log import.
   */
  candidate: boolean;
  /** sb-rescue's address when it started this daemon from a release (#178, SWITCHBOARD_RESCUE_URL): promotion goes through it. */
  rescueUrl?: string;
  /** 人が開く救援画面の URL（#399）。sb-rescue の管理下のときだけ: クラウドホストは SWITCHBOARD_WEB_URL の /rescue/、Mac は rescueUrl。 */
  rescuePageUrl?: string;
  /** Optional built web UI to serve when present. */
  webDist: string;
  /** How long a finished runner process is kept alive for follow-ups before it is released (then `--resume` is used). */
  runnerIdleMs: number;
  /**
   * The Markdown folder that is the source of truth for rules / commands / notes. Override with SWITCHBOARD_KNOWLEDGE.
   * Default ~/Knowledge, or <home>/Knowledge when the data folder is temporary (a test or a fake-runner daemon must not
   * write into the user's Inbox, #2865).
   */
  knowledgeDir: string;
  /** Local API token file (issue #31). Required on /api and /ws when `host` is not loopback. */
  tokenPath: string;
  /** Public base URL handed to MCP clients (e.g. inside Docker use http://host.docker.internal:47831). On loopback its host name is also an allowed Host (#1135). */
  publicUrl?: string;
  /** Claude Code's session logs (#91). Override with SWITCHBOARD_CLAUDE_PROJECTS; tests point it at an empty folder. */
  claudeProjectsDir: string;
  /** Where Claude Code writes its /insights report (`report.html`, #1838): `<CLAUDE_CONFIG_DIR or ~/.claude>/usage-data`. Override with SWITCHBOARD_CLAUDE_USAGE_DATA (tests). */
  claudeUsageDataDir: string;
  /** Codex's home: session logs under `sessions/` (#179, moved by export / import). Override with SWITCHBOARD_CODEX_HOME. */
  codexHome: string;
  /** Uploaded attachments (#124), inside `home`. */
  attachmentsDir: string;
  /** Registered reports (#1777), inside `home`: `<taskId>/<artifactId>/…`. */
  artifactsDir: string;
  /** How often the logs are re-read for terminal sessions; 0 = only at boot and on POST /api/history/import. */
  historyPollMs: number;
  /**
   * The environment's stop command (#181, SWITCHBOARD_IDLE_STOP_CMD): called with the next wake time (ISO, or "-")
   * after 20 idle minutes. Only a machine that may be stopped sets it (the cloud host); unset = the daemon never asks.
   */
  idleStopCmd?: string;
  /**
   * The CDN's shared origin header value (#181, SWITCHBOARD_EDGE_HEADER_VALUE): set on a cloud host, every request not
   * from this machine must carry it. Unset = no check (a Mac, the Tailscale route of #26).
   */
  edgeHeaderValue?: string;
  /**
   * GitHub's Webhook may reach POST /api/backlog/webhooks/github without the token (#887, SWITCHBOARD_GITHUB_WEBHOOK=1):
   * the user opens it, as it is the one route anyone who reaches the daemon may call. Off = it asks for the token as
   * every other route does. It opens only with `githubWebhookSecret` as well (#1493).
   */
  githubWebhook: boolean;
  /** The Webhook's Secret on GitHub (SWITCHBOARD_GITHUB_WEBHOOK_SECRET): each delivery's X-Hub-Signature-256 must match it. Unset = the route stays closed. */
  githubWebhookSecret?: string;
  /**
   * Verifies the cloud host's login cookie (`sb_session`, #211, #701; SWITCHBOARD_SESSION_PUBLIC_KEY): the Ed25519 public
   * key, raw 32 bytes in base64url. The seed that signs stays with the Starter. Unset = tokens only.
   */
  sessionPublicKey?: string;
  /** The cloud host's Starter (SWITCHBOARD_STARTER_URL): asked whether a login cookie's passkey is still registered (#708). */
  starterUrl?: string;
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
    codeRoot,
    candidate: env.SWITCHBOARD_CANDIDATE === "1",
    rescueUrl: env.SWITCHBOARD_RESCUE_URL || undefined,
    rescuePageUrl: env.SWITCHBOARD_RESCUE_URL ? (env.SWITCHBOARD_WEB_URL ? `${env.SWITCHBOARD_WEB_URL.replace(/\/+$/, "")}/rescue/` : env.SWITCHBOARD_RESCUE_URL) : undefined,
    idleStopCmd: env.SWITCHBOARD_IDLE_STOP_CMD || undefined,
    edgeHeaderValue: env.SWITCHBOARD_EDGE_HEADER_VALUE || undefined,
    githubWebhook: env.SWITCHBOARD_GITHUB_WEBHOOK === "1",
    githubWebhookSecret: env.SWITCHBOARD_GITHUB_WEBHOOK_SECRET || undefined,
    // anything but a 32-byte key in base64url = no cookie login
    sessionPublicKey: /^[A-Za-z0-9_-]{43}$/.test(env.SWITCHBOARD_SESSION_PUBLIC_KEY ?? "") ? env.SWITCHBOARD_SESSION_PUBLIC_KEY : undefined,
    starterUrl: env.SWITCHBOARD_STARTER_URL || undefined,
    webDist: join(codeRoot, "apps", "web", "dist"),
    runnerIdleMs: numberOr(env.SWITCHBOARD_RUNNER_IDLE_MS, 10 * 60 * 1000),
    knowledgeDir: env.SWITCHBOARD_KNOWLEDGE ? resolve(expandHome(env.SWITCHBOARD_KNOWLEDGE)) : join(homeIsTemp ? home : homedir(), "Knowledge"),
    tokenPath: env.SWITCHBOARD_TOKEN_FILE ?? join(home, "token"),
    publicUrl: env.SWITCHBOARD_PUBLIC_URL,
    claudeProjectsDir: env.SWITCHBOARD_CLAUDE_PROJECTS ? resolve(expandHome(env.SWITCHBOARD_CLAUDE_PROJECTS)) : join(homedir(), ".claude", "projects"),
    claudeUsageDataDir: env.SWITCHBOARD_CLAUDE_USAGE_DATA ? resolve(expandHome(env.SWITCHBOARD_CLAUDE_USAGE_DATA)) : join(env.CLAUDE_CONFIG_DIR ? resolve(expandHome(env.CLAUDE_CONFIG_DIR)) : join(homedir(), ".claude"), "usage-data"),
    codexHome: env.SWITCHBOARD_CODEX_HOME ? resolve(expandHome(env.SWITCHBOARD_CODEX_HOME)) : join(homedir(), ".codex"),
    attachmentsDir: join(home, "attachments"),
    artifactsDir: join(home, "artifacts"),
    historyPollMs: numberOr(env.SWITCHBOARD_HISTORY_POLL_MS, 30_000),
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
