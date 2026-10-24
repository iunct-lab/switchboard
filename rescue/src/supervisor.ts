/**
 * Starts the Switchboard daemon from `releases/current` and keeps it running (#178). The daemon's cwd and entry are
 * the *resolved* release directory, so switching `current` affects only the next start.
 * Exit 75 is the daemon asking for a restart; any other exit is a crash: retried with backoff, then `failed` — the
 * version is not changed here (only a promotion rolls back on its own; otherwise the person decides on the page).
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { releasesDir } from "./releases.ts";

export type DaemonState = "stopped" | "running" | "restarting" | "failed";
const RESTART_EXIT_CODE = 75;

export interface SupervisorOptions {
  home: string;
  /** The checkout agents edit; handed to the daemon as its meta workspace. */
  repo: string;
  port: number;
  rescueUrl?: string;
  /** Crash retries before giving up, and the first delay (doubles each time). */
  retries?: number;
  backoffMs?: number;
  /** A daemon that lived this long is considered started; its next crash counts from zero again. */
  stableMs?: number;
}

export class Supervisor {
  state: DaemonState = "stopped";
  /** The release the running (or last) process was started from. */
  running: string | null = null;
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private failures = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;

  constructor(private o: SupervisorOptions) {}

  /** Crashes (exits other than "restart me") since the last start() / restart() by a caller. */
  get crashes() {
    return this.failures;
  }

  get logPath() {
    return join(this.o.home, "daemon.log");
  }

  private note(message: string) {
    mkdirSync(this.o.home, { recursive: true });
    appendFileSync(this.logPath, `[rescue ${new Date().toISOString()}] ${message}\n`);
  }

  start(): void {
    if (this.proc) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const link = join(releasesDir(this.o.home), "current");
    if (!existsSync(link)) {
      this.state = "failed";
      this.note("no current release to start");
      return;
    }
    const dir = realpathSync(link);
    this.running = dir.split("/").pop() ?? null;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // sb-rescue's own secret for 作り直す (#181): the daemon and the runners it starts have no use for it
    delete env.SWITCHBOARD_STARTER_TOKEN;
    Object.assign(env, { SWITCHBOARD_SUPERVISED: "1", SWITCHBOARD_HOME: this.o.home, SWITCHBOARD_PORT: String(this.o.port), SWITCHBOARD_REPO_ROOT: this.o.repo });
    if (this.o.rescueUrl) env.SWITCHBOARD_RESCUE_URL = this.o.rescueUrl;
    const fd = openSync(this.logPath, "a");
    this.note(`starting ${this.running} on port ${this.o.port}`);
    const startedAt = Date.now();
    const generation = ++this.generation;
    const proc = Bun.spawn([process.execPath, join(dir, "packages", "core", "src", "main.ts")], { cwd: dir, env, stdin: "ignore", stdout: fd, stderr: fd });
    closeSync(fd);
    this.proc = proc;
    this.state = "running";
    void proc.exited.then((code) => {
      if (generation !== this.generation || this.proc !== proc) return; // stop() / restart() took over
      this.proc = null;
      if (code === RESTART_EXIT_CODE) {
        this.note("daemon asked for a restart");
        return this.start();
      }
      if (Date.now() - startedAt >= (this.o.stableMs ?? 30_000)) this.failures = 0;
      this.failures++;
      if (this.failures > (this.o.retries ?? 3)) {
        this.state = "failed";
        return this.note(`daemon exited (${code}); gave up after ${this.failures - 1} retries`);
      }
      const delay = (this.o.backoffMs ?? 1000) * 2 ** (this.failures - 1);
      this.state = "restarting";
      this.note(`daemon exited (${code}); retry ${this.failures} in ${delay} ms`);
      this.timer = setTimeout(() => this.start(), delay);
    });
  }

  async stop(): Promise<void> {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const proc = this.proc;
    this.proc = null;
    this.state = "stopped";
    if (!proc) return;
    proc.kill("SIGTERM");
    const killer = setTimeout(() => proc.kill("SIGKILL"), 10_000);
    await proc.exited;
    clearTimeout(killer);
  }

  /** Stop and start from whatever `current` points at now; the crash counter starts over. */
  async restart(): Promise<void> {
    await this.stop();
    this.failures = 0;
    this.start();
  }

  /** The last `lines` lines of the daemon log (reads only the tail of the file). */
  logTail(lines = 200): string[] {
    if (!existsSync(this.logPath)) return [];
    const size = statSync(this.logPath).size;
    const length = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(length);
    const fd = openSync(this.logPath, "r");
    readSync(fd, buf, 0, length, size - length);
    closeSync(fd);
    return buf.toString("utf8").split("\n").filter(Boolean).slice(-lines);
  }
}
