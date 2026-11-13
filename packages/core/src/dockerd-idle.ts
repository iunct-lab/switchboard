/**
 * Stopping the host's rootless dockerd (sb-dockerd.service) when nothing uses it. It holds memory for as long as it
 * runs, and `/usr/local/bin/docker` starts it again on the next call, so the daemon only has to stop it: SIGTERM to the
 * main process (the user's own, no root needed). Like HostIdle: a `read` function is injected, `start` / `stop` run the tick.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DockerdState {
  unit: "none" | "inactive" | "active";
  mainPid: number | null;
  /** Running containers. */
  containers: number;
  /** Processes named `docker` (the CLI, which may be a build or a compose that has no container yet). */
  clients: number;
}

export class DockerdIdle {
  private idleSince: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly holdMs: number;
  private readonly tickMs: number;
  private readonly now: () => number;

  constructor(
    private read: () => Promise<DockerdState>,
    private stopDockerd: (pid: number) => void,
    opts: { holdMs: number; tickMs?: number; now?: () => number },
  ) {
    this.holdMs = opts.holdMs; // the default lives in config.ts (dockerdIdleMs)
    this.tickMs = opts.tickMs ?? 60_000;
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick().catch(() => undefined), this.tickMs);
      this.timer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const s = await this.read();
      if (s.unit !== "active" || s.mainPid === null || s.containers > 0 || s.clients > 0) {
        this.idleSince = null;
        return;
      }
      const now = this.now();
      this.idleSince ??= now;
      if (now - this.idleSince >= this.holdMs) {
        this.idleSince = null;
        this.stopDockerd(s.mainPid);
      }
    } finally {
      this.busy = false;
    }
  }
}

/** The default stop: SIGTERM to dockerd's main process, one log line; a failure is one error line and the daemon goes on. */
export function sigtermDockerd(holdMs: number): (pid: number) => void {
  return (pid) => {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`dockerd-idle: no container and no docker client for ${Math.round(holdMs / 60_000)} minutes; stopped sb-dockerd (pid ${pid})`);
    } catch (e) {
      console.error(`dockerd-idle: could not stop sb-dockerd (pid ${pid}): ${String((e as Error).message ?? e)}`);
    }
  };
}

/** Processes whose /proc/<pid>/comm is exactly `docker` (not dockerd, docker-compose, …). */
export function countDockerClients(procDir = "/proc"): number {
  let n = 0;
  for (const name of readdirSync(procDir)) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (readFileSync(join(procDir, name, "comm"), "utf8").trim() === "docker") n++;
    } catch {
      // the process ended between the listing and the read
    }
  }
  return n;
}

/**
 * The real read. Not the docker CLI: it goes through dockerd-up, which would start the dockerd we just stopped.
 * Containers come from the Engine API; a socket that does not answer counts as "in use" so nothing is stopped blind.
 */
export async function readDockerdState(home: string, systemctl = "systemctl"): Promise<DockerdState> {
  const none: DockerdState = { unit: "none", mainPid: null, containers: 0, clients: 0 };
  const proc = Bun.spawn([systemctl, "show", "sb-dockerd", "-p", "LoadState,ActiveState,MainPID"], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return none;
  const v = Object.fromEntries(out.split("\n").map((l) => l.split("=", 2) as [string, string]));
  if (v.LoadState !== "loaded") return none;
  const pid = Number(v.MainPID);
  if (v.ActiveState !== "active" || !Number.isInteger(pid) || pid <= 0) return { unit: "inactive", mainPid: null, containers: 0, clients: 0 };
  let containers = 1; // unknown = in use
  try {
    const res = await fetch("http://localhost/containers/json", { unix: join(home, ".docker", "run", "docker.sock"), signal: AbortSignal.timeout(5000) } as RequestInit);
    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list)) containers = list.length;
    }
  } catch {
    // keep "in use"
  }
  return { unit: "active", mainPid: pid, containers, clients: countDockerClients() };
}

/** What the daemon starts: none on a candidate (a scratch daemon must not stop the host's dockerd). */
export function createDockerdIdle(cfg: { candidate: boolean; dockerdIdleMs: number }, home: string, read: () => Promise<DockerdState> = () => readDockerdState(home)): DockerdIdle | null {
  return cfg.candidate ? null : new DockerdIdle(read, sigtermDockerd(cfg.dockerdIdleMs), { holdMs: cfg.dockerdIdleMs });
}
