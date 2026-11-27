import { isWorkingStatus, type LoginKind, type RunnerId, type RunnerInfo, type RunnerAdapter } from "@switchboard/protocol";
import { LOGIN_FORCED_RECHECK_MS, LOGIN_RECHECK_MS } from "../login.ts";
import { versionAtLeast } from "../tasks/state.ts";
import type { ServerContext, ServerContextInit } from "./context.ts";
import { runGh } from "../backlog-gh.ts";
import { RunnerLogins } from "../runnerlogin.ts";
import { afterGithubLogin } from "../github-login.ts";

// `force` = the banner's 再確認 (?recheck=1): the person just logged in and should not wait out the minute. Still at
// most one run per LOGIN_FORCED_RECHECK_MS, so a page that keeps requesting it cannot keep spawning the runners.
export const refreshLogins = (sc: Pick<ServerContext, "loginCheckedAt" | "loginCheck" | "detected" | "loginExpired">, force = false): Promise<void> => {
  const age = Date.now() - sc.loginCheckedAt;
  if (age < (force ? LOGIN_FORCED_RECHECK_MS : LOGIN_RECHECK_MS)) return Promise.resolve();
  sc.loginCheck ??= Promise.all(
    sc.detected
      .filter((d) => d.info.available && d.info.login !== undefined)
      .map(async (d) => {
        const r = await d.adapter.detect().catch(() => null);
        if (!r?.available || r.login === undefined) return;
        d.info = { ...d.info, login: r.login, loginKind: r.loginKind, bedrockFrom: r.bedrockFrom, loginExpiresAt: r.loginExpiresAt, loginHint: r.loginHint, note: r.note };
        if (r.login === "ok") sc.loginExpired.delete(d.adapter.id);
      }),
  ).then(() => {
    sc.loginCheckedAt = Date.now();
    sc.loginCheck = null;
  });
  return sc.loginCheck;
};

// A runner's login from the screen: the daemon runs the runner's own login command and relays its URL / code.
// Done → the login is checked again at once, so the banner goes away.
export const runnerCliEnv = (_sc: unknown) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "CLAUDECODE" && !k.startsWith("CLAUDE_CODE_")) env[k] = v;
  return env;
};

export const ghBin = (sc: Pick<ServerContext, "opts">) => (sc.opts.ghBin === undefined ? Bun.which("gh") : sc.opts.ghBin);

export const loginTarget = (sc: Pick<ServerContext, "detected">, id: string, api = false) => {
  const d = sc.detected.find((x) => x.adapter.id === id);
  const args = api ? d?.adapter.loginApiArgs : d?.adapter.loginArgs;
  return d && d.info.available && d.info.path && args ? { runner: d.adapter.id, argv: [d.info.path, ...args], hosts: d.adapter.loginHosts ?? [] } : null;
};

// The runner's own logout: its command is run with a limit, then the login is read again at once so the
// screen shows "logged out" and the banner's login buttons.
export const logoutTarget = (sc: Pick<ServerContext, "detected">, id: string) => {
  const d = sc.detected.find((x) => x.adapter.id === id);
  const args = d?.adapter.logoutArgs;
  return d && d.info.available && d.info.path && args ? { runner: d.adapter.id, argv: [d.info.path, ...args] } : null;
};

// Runner list for /api/health: detection is from boot (the login and the note from the last recheck), the effective default mode and auto-resume follow the saved
// settings, and the models / the CLI's default model are read each time — the default is the user's own CLI
// setting and changes there.
// Amazon Bedrock only when the user chose it for the runner and the adapter has `bedrockModel`. Nothing
// switches to it by itself: a runner whose login lapsed stays `expired`.
export const bedrockOf = (sc: Pick<ServerContext, "adapterMap" | "settings">, runner: RunnerId) => (sc.adapterMap.get(runner)?.bedrockModel ? sc.settings().bedrock[runner] : undefined);

// Where the bill of a runner's usage goes now, for the ledger row: Bedrock for a Task started there, else the login the
// runner's last status check reported (a Claude account or an Anthropic Console one). undefined = not known.
export const loginKindOf = (sc: Pick<ServerContext, "bedrockTasks" | "detected">, runner: RunnerId, taskId?: string): LoginKind | undefined => (taskId !== undefined && sc.bedrockTasks.has(taskId) ? "bedrock" : sc.detected.find((d) => d.adapter.id === runner)?.info.loginKind);

// The saved list by Bedrock ids: a model with none there is left out, and a later one that maps to an id already listed is dropped
const bedrockModels = (listed: RunnerInfo["models"], toBedrock: (m: RunnerInfo["models"][number]) => RunnerInfo["models"][number] | null): RunnerInfo["models"] => {
  const seen = new Set<string>();
  return listed.map(toBedrock).filter((m): m is RunnerInfo["models"][number] => m !== null && !seen.has(m.value) && !!seen.add(m.value));
};

export const runnerInfo = (sc: Pick<ServerContext, "detected" | "bedrockOf" | "bedrockTasks" | "db" | "loginExpired" | "settings" | "savedAutoResume" | "savedModels" | "savedDefaultMode">): RunnerInfo[] =>
  sc.detected.map(({ adapter, info }) => {
    const bedrock = sc.bedrockOf(adapter.id);
    // on Bedrock the runner's own login is not used: it reads as ok, with the kind that says where the bill goes
    const login = bedrock ? "ok" : info.login !== undefined && sc.loginExpired.has(adapter.id) ? "expired" : info.login;
    // where Bedrock comes from is decided here and nowhere else: the setting chosen on the screen, or the CLI's own settings the detection read
    const bedrockFrom: RunnerInfo["bedrockFrom"] = bedrock ? "settings" : login === "ok" && info.bedrockFrom === "cli" && info.loginKind === "bedrock" ? "cli" : undefined;
    const loginKind = bedrock ? "bedrock" : login === "ok" ? info.loginKind : undefined;
    // Tasks started on Bedrock that still work, also after the setting went back: a switch back does not change what they run on
    const bedrockRunning = [...sc.bedrockTasks].filter((id) => { const t = sc.db.getTask(id); return t?.runner === adapter.id && isWorkingStatus(t.status); }).length;
    const loginExpiresAt = !bedrock && login === "ok" ? info.loginExpiresAt : undefined; // an expiry beside "expired" or Bedrock would mislead
    const forks = adapter.forks === true && versionAtLeast(info.version, adapter.forkMinVersion);
    // the one list to edit, and on Bedrock the same list by Bedrock ids (a model with none there is left out)
    const listed = sc.savedModels(adapter.id) ?? adapter.models ?? [];
    const base = { ...info, forks, login, loginKind, bedrockFrom, ...(bedrockRunning ? { bedrockRunning } : {}), loginExpiresAt, bedrockAvailable: adapter.bedrockModel !== undefined, defaultModel: sc.settings().defaultModel[adapter.id], defaultEffort: sc.settings().defaultEffort[adapter.id], subagentModel: sc.settings().subagentModel[adapter.id], subagents: adapter.id === "claude" ? true : undefined, autoResume: sc.savedAutoResume(adapter.id), models: bedrock && adapter.bedrockModel ? bedrockModels(listed, adapter.bedrockModel) : listed, ...(bedrock ? { listModels: listed } : {}), cliDefaultModel: adapter.cliDefaultModel?.() };
    if (!info.permissionModes.length) return base;
    const saved = sc.savedDefaultMode(adapter.id);
    const valid = saved !== undefined && info.permissionModes.some((m) => m.value === saved);
    return { ...base, defaultPermissionMode: valid ? saved : adapter.defaultPermissionMode };
  });

export async function setupLogins(sc: Pick<ServerContextInit, "adapterMap" | "detected" | "adapters" | "loginCheckedAt" | "loginCheck" | "loginExpired" | "runnerLogins" | "runnerCliEnv" | "refreshLogins" | "opts" | "githubLogins" | "cfg" | "NOTICES_KEY" | "bedrockTasks">): Promise<void> {
  sc.adapterMap = new Map<RunnerId, RunnerAdapter>();
  sc.detected = [];
  for (const a of sc.adapters) {
    const d = await a.detect();
    sc.detected.push({ adapter: a, info: { id: a.id, forks: false, ...(a.label ? { label: a.label } : {}), ...d, permissionModes: a.permissionModes ?? [], models: a.models ?? [], efforts: a.efforts ?? [], bedrockAvailable: a.bedrockModel !== undefined } });
    if (d.available) sc.adapterMap.set(a.id, a);
  }
  // Login: the runner's own status command runs again when /api/health is read and its last answer is over a
  // minute old (the login and the note are taken from it; which runners are available stays as detected at boot). A turn that
  // ended on an auth error marks the runner expired until a later check or a turn that went through says otherwise.
  sc.loginCheckedAt = Date.now();
  sc.loginCheck = null;
  sc.loginExpired = new Set<RunnerId>();
  sc.runnerLogins = new RunnerLogins(
    (argv) => {
      return Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: sc.runnerCliEnv() });
    },
    (runner) => {
      sc.loginExpired.delete(runner);
      // a check already in flight may have started before the login finished: run another one after it
      void (sc.loginCheck ?? Promise.resolve()).then(() => {
        sc.loginCheckedAt = 0;
        return sc.refreshLogins();
      });
    },
    sc.opts.loginTimeoutMs,
  );
  // GitHub's own login from the screen (github-login.ts): the same relay, keyed "gh". Done → git is pointed at gh's
  // credentials; the screen reads /api/github/status again on its own.
  sc.githubLogins = new RunnerLogins<"gh">(
    (argv) => Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: sc.runnerCliEnv() }),
    () => {
      void afterGithubLogin(sc.opts.gh ?? runGh, sc.cfg.repoRoot, sc.opts.gitConfig).then((ok) => {
        if (!ok) console.error("github login: gh auth setup-git failed; git over https may not use the login");
      });
    },
    sc.opts.loginTimeoutMs,
  );
  // Settings live in sqlite so the UI can change them; read on every use so a PATCH takes effect at once.
  /** The daemon's notices' first sight and resolution (asks-notices.ts `noticeAsks`). */
  sc.NOTICES_KEY = "notices";
  // the tasks whose session was started on Bedrock: a turn's login bookkeeping follows what it ran on, not the setting at its end
  sc.bedrockTasks = new Set<string>();
}
