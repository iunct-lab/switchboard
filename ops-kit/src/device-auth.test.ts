import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findApproval, redact, WITHHELD } from "./device-auth.ts";

const BIN = join(import.meta.dir, "../bin/device-auth");
// Made-up values, never a real login
const URL_ = "https://device.login.example/activate";
const CODE = ["ABCD", "EFGH"].join("-");

let dir: string;
let login: string;
let server: ReturnType<typeof Bun.serve>;
let calls: Array<{ method: string; auth: string | null; body: unknown }>;
let answer = 200;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ops-kit.device-auth."));
  // A login like the cloud CLIs': the URL and the code (ANSI coloured), then waits until the person approves (here: a file appears)
  login = join(dir, "login.ts");
  writeFileSync(
    login,
    `const [done] = process.argv.slice(2);
console.log("Attempting to open your browser. If it does not open, visit:");
console.log("\\x1b[94m${URL_}\\x1b[0m");
console.log("Then enter the code:");
console.log("\\x1b[1m${CODE}\\x1b[0m");
console.error("waiting for the approval…");
while (!(await Bun.file(done).exists())) await Bun.sleep(20);
console.log("Successfully logged in.");
`,
  );
  // The code comes well after the URL (a CLI that asks the server first), five characters in its second group
  writeFileSync(
    join(dir, "late.ts"),
    `const [done] = process.argv.slice(2);
console.log("visit ${URL_}");
await Bun.sleep(1500);
console.log("ABCD-EFGHI");
while (!(await Bun.file(done).exists())) await Bun.sleep(20);
`,
  );
  writeFileSync(join(dir, "token"), "key-from-the-file\n");
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls.push({ method: req.method, auth: req.headers.get("authorization"), body: req.method === "POST" ? await req.json() : null });
      return Response.json(null, { status: answer });
    },
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function run(args: string[], env: Record<string, string | undefined>, approveAfterPosts = 1) {
  calls = [];
  const done = join(dir, `done-${Math.random()}`);
  const p = Bun.spawn([BIN, ...args.map((a) => a.replace("$DONE", done))], { env: { ...process.env, DEVICE_AUTH_URL: undefined, DEVICE_AUTH_TOKEN_FILE: undefined, ...env }, stdout: "pipe", stderr: "pipe" });
  if (approveAfterPosts > 0) {
    for (let i = 0; i < 300 && calls.filter((c) => c.method === "POST").length < approveAfterPosts; i++) await Bun.sleep(20);
    writeFileSync(done, "");
  }
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, out, err, done };
}

/** Runs `fn` with AWS_CONFIG_FILE on a made-up config holding one account id, which it is given bare. */
async function withHostAccount<T>(fn: (id: string) => Promise<T> | T): Promise<T> {
  const id = ["8642", "9753", "1086"].join("");
  const dir = mkdtempSync(join(tmpdir(), "device-auth.aws."));
  writeFileSync(join(dir, "config"), `[profile x-admin]\nsso_account_id = ${id}\n`);
  const saved = process.env.AWS_CONFIG_FILE;
  process.env.AWS_CONFIG_FILE = join(dir, "config");
  try {
    return await fn(id);
  } finally {
    if (saved === undefined) delete process.env.AWS_CONFIG_FILE;
    else process.env.AWS_CONFIG_FILE = saved;
    rmSync(dir, { recursive: true });
  }
}

describe("findApproval / redact", () => {
  test("the URL and the code on its own line (ANSI coloured); the code of a URL's user_code; a code inside a URL is not one", () => {
    expect(findApproval(`visit:\n\x1b[94m${URL_}\x1b[0m\ncode:\n\x1b[1m${CODE}\x1b[0m\n`)).toEqual({ url: URL_, code: CODE });
    expect(findApproval(`open https://d.example/a?user_code=${CODE}&x=1 now`)).toEqual({ url: `https://d.example/a?user_code=${CODE}&x=1`, code: CODE });
    expect(findApproval(`https://d.example/a?state=WXYZ-12345`)).toEqual({ url: "https://d.example/a?state=WXYZ-12345" });
    expect(findApproval("open https://d.example/device and enter ABCD-EFGHI")).toEqual({ url: "https://d.example/device", code: "ABCD-EFGHI" });
    expect(findApproval("nothing here")).toEqual({});
  });

  test("redact withholds the values (a URL holding the code whole) and every line findSecrets hits", () => {
    const text = `go to ${URL_}?user_code=${CODE}\nenter ${CODE}\naws_secret_access_key = ${"a".repeat(40)}\nok\n`;
    const r = redact(text, [CODE, `${URL_}?user_code=${CODE}`]);
    expect(r).not.toContain(CODE);
    expect(r).not.toContain(URL_);
    expect(r).not.toContain("a".repeat(40));
    expect(r).toBe(`go to ${WITHHELD}\nenter ${WITHHELD}\n[伏せた行]\nok\n`);
  });

  test("redact withholds a line holding an account id of the host's AWS config, written bare (#2351)", async () => {
    const out = await withHostAccount((id) => redact(`account list\n${id}\nok\n`, []));
    expect(out).toBe("account list\n[伏せた行]\nok\n");
  });
});

describe("ops-kit/bin/device-auth", () => {
  test("the URL and code go to the address with the key from the file; the output has neither; approval ends with exit 0 and a DELETE", async () => {
    const r = await run(["--", "bun", login, "$DONE"], { DEVICE_AUTH_URL: `http://127.0.0.1:${server.port}/api/tasks/t1/device-auth`, DEVICE_AUTH_TOKEN_FILE: join(dir, "token") });
    expect(r.code).toBe(0);
    const post = calls.find((c) => c.method === "POST");
    expect(post?.auth).toBe("Bearer key-from-the-file");
    // the command as shown, cut at 200 characters: a long TMPDIR (local-ci's under ~/.cache) makes it longer
    const command = `bun ${login} ${r.done}`;
    expect(post?.body).toMatchObject({ url: URL_, code: CODE, command: command.length > 200 ? `${command.slice(0, 199)}…` : command });
    expect((post?.body as { expiresInSec: number }).expiresInSec).toBeGreaterThan(590);
    expect(calls.at(-1)?.method).toBe("DELETE");
    expect(r.out + r.err).not.toContain(CODE);
    expect(r.out + r.err).not.toContain("login.example");
    expect(r.out).toContain(WITHHELD);
    expect(r.out).toContain("Successfully logged in.");
  });

  test("a code after the URL was sent alone: still withheld, and sent again with the code", async () => {
    const r = await run(["--", "bun", join(dir, "late.ts"), "$DONE"], { DEVICE_AUTH_URL: `http://127.0.0.1:${server.port}/x` }, 2);
    expect(r.code).toBe(0);
    expect(r.out + r.err).not.toContain("ABCD-EFGHI");
    expect(r.out + r.err).not.toContain("login.example");
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.body as { url: string; code?: string });
    expect(posts.map((p) => p.code)).toEqual([undefined, "ABCD-EFGHI"]);
    expect(posts[0]?.url).toBe(URL_);
  }, 10_000);

  test("a process the command left behind does not hold device-auth past the expiry", async () => {
    const started = Date.now();
    const r = await run(["--expires-in", "1", "--", "sh", "-c", `sleep 6 & echo ${URL_}; echo ${CODE}; wait`], { DEVICE_AUTH_URL: `http://127.0.0.1:${server.port}/x` }, 0);
    expect(r.code).toBe(124);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(calls.at(-1)?.method).toBe("DELETE");
  }, 10_000);

  test.each([
    ["on expiry", ["--expires-in", "1"], 200, 124],
    ["when the hand-over is refused", [], 500, 2],
  ])("%s what the command started is stopped too (#992)", async (_name, opts, status, exit) => {
    const pidFile = join(dir, "left.pid");
    answer = status;
    const r = await run([...opts, "--", "sh", "-c", `sleep 30 & echo $! > ${pidFile}; echo ${URL_}; echo ${CODE}; wait`], { DEVICE_AUTH_URL: `http://127.0.0.1:${server.port}/x` }, 0).finally(() => (answer = 200));
    expect(r.code).toBe(exit);
    const pid = Number(await Bun.file(pidFile).text());
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await Bun.sleep(20);
    expect(alive()).toBe(false);
  }, 10_000);

  test("device-auth stopped by a signal stops what the command started too, and DELETEs (#992)", async () => {
    calls = [];
    const pidFile = join(dir, "left-abort.pid");
    const p = Bun.spawn([BIN, "--", "sh", "-c", `sleep 30 & echo $! > ${pidFile}; echo ${URL_}; echo ${CODE}; wait`], { env: { ...process.env, DEVICE_AUTH_URL: `http://127.0.0.1:${server.port}/x` }, stdout: "pipe", stderr: "pipe" });
    for (let i = 0; i < 300 && !calls.some((c) => c.method === "POST"); i++) await Bun.sleep(20);
    p.kill("SIGTERM");
    await p.exited;
    const pid = Number(await Bun.file(pidFile).text());
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await Bun.sleep(20);
    expect(alive()).toBe(false);
    expect(calls.at(-1)?.method).toBe("DELETE");
  }, 10_000);

  test("--expires-in 1: the command is stopped, a DELETE comes, exit 124", async () => {
    const r = await run(["--expires-in", "1", "--", "bun", login, "$DONE"], { DEVICE_AUTH_URL: `http://127.0.0.1:${server.port}/x` }, 0);
    expect(r.code).toBe(124);
    expect((calls.find((c) => c.method === "POST")?.body as { expiresInSec: number }).expiresInSec).toBe(1);
    expect(calls.at(-1)?.method).toBe("DELETE");
    expect(r.err).toContain("期限");
    expect(r.out + r.err).not.toContain(CODE);
  });

  test("no DEVICE_AUTH_URL: exit 2 and the command never runs", async () => {
    const marker = join(dir, "ran");
    const r = await run(["--", "bun", "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "")`], {}, 0);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Task の会話で聞いて止めて");
    expect(existsSync(marker)).toBe(false);
    expect(calls).toEqual([]);
  });

  test("the address refuses the hand-over: the command is stopped, exit 2, nothing of the values in the output", async () => {
    answer = 409;
    try {
      const r = await run(["--", "bun", login, "$DONE"], { DEVICE_AUTH_URL: `http://127.0.0.1:${server.port}/x` }, 0);
      expect(r.code).toBe(2);
      expect(r.err).toContain("HTTP 409");
      expect(r.out + r.err).not.toContain(CODE);
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    } finally {
      answer = 200;
    }
  });

  test("no command, or a bad --expires-in: exit 2 with the usage", async () => {
    for (const args of [["--"], ["--expires-in", "0", "--", "true"], ["--expires-in", "901", "--", "true"]]) {
      const r = await run(args, { DEVICE_AUTH_URL: `http://127.0.0.1:${server.port}/x` }, 0);
      expect(r.code).toBe(2);
      expect(r.err).toContain("使い方");
    }
  });
});
