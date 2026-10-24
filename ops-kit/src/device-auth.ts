import { readFileSync } from "node:fs";
import { findSecrets, hostAws } from "./secrets.ts";

/**
 * `device-auth -- <command>`: runs a command that asks for an approval elsewhere (an SSO device login prints a URL and a
 * one-time code) and hands the URL and code to the app running the Task, which shows them to the person. What the agent
 * reads back — the command's output, kept in the Task's log — has them withheld, so the agent cannot write them into an
 * Issue. The app's address comes in `DEVICE_AUTH_URL`, its key in the file `DEVICE_AUTH_TOKEN_FILE` names.
 */
export interface Approval {
  url?: string;
  code?: string;
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const URL_RE = /https:\/\/[^\s"'<>]+/g;
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{4,5}\b/;
export const WITHHELD = "[画面に表示]";
const WITHHELD_LINE = "[伏せた行]";
/** A device code lasts 10–15 minutes; a command whose page says otherwise is given `--expires-in`. */
export const DEFAULT_EXPIRES_SEC = 600;
/** A URL with no code after it this long is sent alone (a page that shows its own code, or none). */
const URL_ALONE_MS = 1000;
/** A line the command has not ended yet is written after this much quiet (a prompt waiting on the same line). */
const PARTIAL_MS = 300;

/** The approval URL and the one-time code in a command's output: the code on a line without a URL, or the URL's `user_code=`. */
export function findApproval(text: string): Approval {
  const plain = text.replace(ANSI, "");
  const urls = [...plain.matchAll(URL_RE)].map((m) => m[0]);
  const withCode = urls.find((u) => /[?&]user_code=/.test(u));
  const url = withCode ?? urls[0];
  let inUrl: string | undefined;
  try {
    inUrl = withCode ? new URL(withCode).searchParams.get("user_code") ?? undefined : undefined;
  } catch {
    /* not a URL after all */
  }
  // outside the URLs, so a URL's own parameters (state=…) are never taken for a code, and a code after a URL on its line is
  const code = plain.replace(URL_RE, " ").match(DEVICE_CODE)?.[0] ?? inUrl;
  return { ...(url && { url }), ...(code && { code }) };
}

/** Withholds `values` (longest first, a URL holds its code) and every line `findSecrets` hits. */
export function redact(text: string, values: string[]): string {
  let out = text;
  for (const v of [...values].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(v).join(WITHHELD);
  const lines = out.split("\n");
  for (const hit of findSecrets(out, hostAws())) lines[hit.line - 1] = WITHHELD_LINE;
  return lines.join("\n");
}

/**
 * The processes under `pid`, children first (`pgrep -P`, on Linux and macOS). None when pgrep is missing (a slim
 * container): the command itself is still stopped. One that left the tree (a double fork, setsid) is not found.
 */
function descendants(pid: number): number[] {
  let kids: number[];
  try {
    kids = Bun.spawnSync(["pgrep", "-P", String(pid)]).stdout.toString().split("\n").map(Number).filter((n) => n > 0);
  } catch {
    return [];
  }
  return kids.flatMap((k) => [k, ...descendants(k)]);
}

export interface DeviceAuthIo {
  out(text: string): void;
  err(text: string): void;
}

const USAGE = "使い方: device-auth [--expires-in <秒>] -- <command...>";

/** Parses the arguments, runs the command and returns the exit code (the command's, 124 on expiry, 2 on misuse or a failed hand-over). */
export async function runDeviceAuth(argv: string[], env: Record<string, string | undefined>, io: DeviceAuthIo, signal?: AbortSignal): Promise<number> {
  // Options, then the command after `--` (bun hands a script its arguments without the first `--`, so it may be gone)
  let expiresInSec = DEFAULT_EXPIRES_SEC;
  let i = 0;
  for (; argv[i] === "--expires-in"; i += 2) {
    const n = Number(argv[i + 1]);
    if (!Number.isInteger(n) || n < 1 || n > 900) {
      io.err(`${USAGE}（--expires-in は 1〜900）\n`);
      return 2;
    }
    expiresInSec = n;
  }
  const command = argv.slice(argv[i] === "--" ? i + 1 : i);
  if (command.length === 0) {
    io.err(`${USAGE}\n`);
    return 2;
  }
  const target = env.DEVICE_AUTH_URL;
  if (!target) {
    io.err("device-auth: 承認を画面に出す経路がありません（DEVICE_AUTH_URL がありません）。コマンドは動かしていません。値を出さずに、何の承認が要るかを Task の会話で聞いて止めてください（issue-workflow の「Issue・PR・コメントに書かない値」）\n");
    return 2;
  }
  let key = "";
  try {
    if (env.DEVICE_AUTH_TOKEN_FILE) key = readFileSync(env.DEVICE_AUTH_TOKEN_FILE, "utf8").trim();
  } catch {
    /* a daemon on loopback asks for no key */
  }
  const call = (method: "POST" | "DELETE", body?: unknown) =>
    fetch(target, {
      method,
      headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

  // what the screen shows, so the person can judge the URL; the daemon takes up to 2000 characters
  const joined = command.join(" ");
  const shown = joined.length > 200 ? `${joined.slice(0, 199)}…` : joined;
  const deadline = Date.now() + expiresInSec * 1000;
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "pipe", stderr: "pipe", env: env as Record<string, string> });
  // Stops the command and what it started (`sh -c "<login> …"`, #992). Found from the parent links before the command
  // goes (afterwards they hang off init); the command stays in the caller's process group and session, so a runner that
  // kills its tool's whole group still reaches all of them.
  const stop = () => {
    const kids = descendants(child.pid);
    child.kill();
    for (const pid of kids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
  };
  const found: Approval = {};
  /** Every URL and code seen so far: withheld from the output for as long as the command runs. */
  const withheld = new Set<string>();
  let sentCode: string | undefined;
  let sent = false;
  let failed = false;
  let posting = Promise.resolve();
  let aloneTimer: ReturnType<typeof setTimeout> | undefined;

  // Sends what was found, once; again when a code comes after a URL that was sent alone (the screen's entry is replaced).
  const sync = () => {
    if (failed || !found.url || (sent && sentCode === found.code)) return;
    clearTimeout(aloneTimer);
    const first = !sent;
    sent = true;
    sentCode = found.code;
    const body = { url: found.url, ...(found.code && { code: found.code }), command: shown, expiresInSec: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) };
    posting = posting.then(async () => {
      if (failed) return;
      const res = await call("POST", body).catch(() => null);
      if (!res?.ok) {
        failed = true;
        io.err(`device-auth: 承認を画面に渡せませんでした（${res ? `HTTP ${res.status}` : "接続できません"}）。コマンドを止めました。値を出さずに、何の承認が要るかを Task の会話で聞いて止めてください\n`);
        stop();
        return;
      }
      if (first) io.err("device-auth: 承認の URL とコードを Task の画面に出しました。利用者の承認を待っています\n");
    });
  };

  // Line by line, so a value is known before the line holding it is written; a line left open is written after a pause.
  const pump = async (stream: ReadableStream<Uint8Array>, write: (s: string) => void) => {
    const decoder = new TextDecoder();
    let pending = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const emit = (text: string) => {
      const a = findApproval(text);
      if (a.url) withheld.add(a.url);
      if (a.code) withheld.add(a.code);
      found.url ??= a.url;
      found.code ??= a.code;
      if (found.url && found.code) sync();
      else if (found.url && !sent && !aloneTimer) aloneTimer = setTimeout(sync, URL_ALONE_MS);
      write(redact(text, [...withheld]));
    };
    for await (const chunk of stream) {
      pending += decoder.decode(chunk, { stream: true });
      clearTimeout(timer);
      const end = pending.lastIndexOf("\n");
      if (end >= 0) {
        emit(pending.slice(0, end + 1));
        pending = pending.slice(end + 1);
      }
      if (pending) {
        timer = setTimeout(() => {
          const rest = pending;
          pending = "";
          if (rest) emit(rest);
        }, PARTIAL_MS);
      }
    }
    clearTimeout(timer);
    if (pending) emit(pending);
  };

  let expired = false;
  const expiry = setTimeout(() => {
    expired = true;
    stop();
  }, expiresInSec * 1000);
  const onAbort = stop;
  signal?.addEventListener("abort", onAbort);
  const pumps = Promise.all([pump(child.stdout, io.out), pump(child.stderr, io.err)]);
  const code = await child.exited;
  // a process the command left behind may hold the pipes open: what it writes later is not waited for
  await Promise.race([pumps, Bun.sleep(500)]);
  clearTimeout(expiry);
  clearTimeout(aloneTimer);
  signal?.removeEventListener("abort", onAbort);
  await posting;
  if (sent && !failed) await call("DELETE").catch(() => null);
  if (failed) return 2;
  if (expired) {
    io.err(`device-auth: 期限（${expiresInSec} 秒）が切れました。コマンドを止めました\n`);
    return 124;
  }
  return code ?? 1;
}
