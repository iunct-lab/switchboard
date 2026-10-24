import type { RunnerId } from "@switchboard/protocol";

/**
 * A runner's own login, from the screen (#354). The daemon runs the runner's login command (`claude auth login`,
 * `codex login --device-auth`) as a child process and relays what it prints — the URL to open and, for a device flow,
 * the one-time code — so nobody opens a terminal. Claude then asks for the code its page shows: `submit` writes it to
 * the child's stdin and forgets it. The credentials are written by the runner itself; Switchboard keeps none (#180),
 * and the pasted code never reaches a log, the DB or an API response.
 *
 * Observed (2026-09-26): codex prints `https://auth.openai.com/codex/device` and a code like `ABCD-EFGHI` (ANSI
 * coloured) and waits for the approval elsewhere; claude prints "If the browser didn't open, visit: https://…" and
 * "Paste code here if prompted >", and reads stdin.
 */
export type RunnerLoginState = "waiting" | "done" | "failed";
export interface RunnerLoginView {
  runner: RunnerId;
  state: RunnerLoginState;
  /** Where the person signs in. */
  url?: string;
  /** A device flow's one-time code, to type on that page (codex). Not a secret of the person's: the CLI shows it. */
  code?: string;
  /** The CLI waits for the code its page shows (claude): the screen offers a box for it. */
  needsCode: boolean;
  error?: string;
}

interface Child {
  stdin: { write(s: string): unknown; flush?(): unknown; end?(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}
export type SpawnLogin = (argv: string[]) => Child;

/** Ten minutes: the device code lasts fifteen, and a login left open must not hold the runner forever. */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const URL_RE = /https:\/\/[^\s"'<>]+/g;
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/;

interface Session { view: RunnerLoginView; child: Child; timer: ReturnType<typeof setTimeout>; seen: Promise<void> }

export class RunnerLogins {
  private sessions = new Map<RunnerId, Session>();
  constructor(
    private spawn: SpawnLogin,
    private onDone: (runner: RunnerId) => void,
    private timeoutMs = LOGIN_TIMEOUT_MS,
  ) {}

  get(runner: RunnerId): RunnerLoginView | undefined {
    const s = this.sessions.get(runner);
    return s && { ...s.view };
  }

  /**
   * Starts the login (or returns the one already running) and resolves once its URL is out, it ended, or 15 s passed.
   * Only a URL on one of `hosts` is relayed (an update notice printed first is skipped).
   */
  async start(runner: RunnerId, argv: string[], hosts: string[] = []): Promise<RunnerLoginView> {
    const running = this.sessions.get(runner);
    if (running && running.view.state === "waiting") {
      await running.seen;
      return { ...running.view };
    }
    const child = this.spawn(argv);
    const view: RunnerLoginView = { runner, state: "waiting", needsCode: false };
    let text = "";
    // Once the URL and the code (or the prompt for one) are out, nothing more is read from the output: after the paste
    // the CLI may echo it, and no part of it may become a relayed code.
    let settled = false;
    const allowed = (u: string) => {
      try {
        const h = new URL(u).hostname;
        return hosts.length === 0 || hosts.some((a) => h === a || h.endsWith(`.${a}`));
      } catch {
        return false;
      }
    };
    let markSeen!: () => void;
    const seen = new Promise<void>((r) => (markSeen = r));
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      try {
        for await (const chunk of stream) {
          if (settled) continue;
          text += decoder.decode(chunk, { stream: true });
          const plain = text.replace(ANSI, "");
          view.url ??= [...plain.matchAll(URL_RE)].map((m) => m[0]).find(allowed);
          if (/paste code/i.test(plain)) view.needsCode = true;
          // the device code sits on a line of its own, never inside the URL; a CLI that asks for a paste has none
          if (!view.needsCode) view.code ??= plain.split("\n").filter((l) => !l.includes("http")).join("\n").match(DEVICE_CODE)?.[0];
          if (view.url && (view.code || view.needsCode)) {
            settled = true;
            markSeen();
          }
        }
      } catch {
        /* the child went away */
      }
    };
    void read(child.stdout);
    void read(child.stderr);
    const timer = setTimeout(() => {
      if (view.state !== "waiting") return;
      view.state = "failed";
      view.error = "ログインが時間内に終わりませんでした。もう一度「ログインする」を押してください";
      child.kill();
    }, this.timeoutMs);
    const session: Session = { view, child, timer, seen };
    this.sessions.set(runner, session);
    void child.exited.then((code) => {
      clearTimeout(timer);
      if (view.state === "waiting") {
        view.state = code === 0 ? "done" : "failed";
        // the exit code only: the CLI's output may echo what was typed into it
        if (code !== 0) view.error = `ログインのコマンドが終了しました（exit ${code}）。もう一度「ログインする」を押してください`;
      }
      if (view.state === "done") this.onDone(runner);
      markSeen();
    });
    await Promise.race([seen, Bun.sleep(15_000)]);
    return { ...view };
  }

  /** Hands the code the runner's page showed to the waiting CLI (claude). The code is not kept anywhere. */
  async submit(runner: RunnerId, code: string): Promise<RunnerLoginView | undefined> {
    const s = this.sessions.get(runner);
    if (!s || s.view.state !== "waiting") return s && { ...s.view };
    // one line only: a paste must not type further lines into the CLI
    s.child.stdin.write((code.trim().split(/\r?\n/)[0] ?? "") + "\n");
    s.child.stdin.flush?.();
    // the CLI exchanges the code and exits; wait a little for that, the screen polls afterwards
    await Promise.race([s.child.exited, Bun.sleep(20_000)]);
    return { ...s.view };
  }

  /** 取り消す: ends a login that is waiting (e.g. its URL never came). */
  cancel(runner: RunnerId): RunnerLoginView | undefined {
    const s = this.sessions.get(runner);
    if (!s) return undefined;
    if (s.view.state === "waiting") {
      s.view.state = "failed";
      s.view.error = "取り消しました";
      clearTimeout(s.timer);
      s.child.kill();
    }
    return { ...s.view };
  }

  stop(): void {
    for (const s of this.sessions.values()) {
      clearTimeout(s.timer);
      if (s.view.state === "waiting") s.child.kill();
    }
  }
}
