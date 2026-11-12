/**
 * `ops-kit job`: a Task asks the app to run its local CI or a review as the app's own job, instead of
 * keeping its session open on a wait loop. The app's address is the origin of `BACKLOG_URL` and its key the file
 * `BACKLOG_TOKEN_FILE` names — the same pair as `backlog`, so only inside the app's Task. The Task waits by ending its
 * turn on a `depends` stop with `job#<id>`; the app resumes it with the result. There is no command that waits here.
 * exit 0 = done, 1 = refused (usage, the app's 4xx), 2 = cannot tell (no app, not reached, 5xx).
 */
import { isAbsolute, resolve } from "node:path";
import { BacklogUnknown, client } from "./backlog-client.ts";

export const JOB_USAGE = `  job request local-ci <PR> [--cwd <dir>] [--fixtures <dir>]
      アプリにローカル CI（scripts/local-ci.ts <PR>）を仕事として頼む。仕事はアプリの子として重い処理の枠を取って走り、Task のセッションの子にならない
      --fixtures は録画庫（絶対パス）。仕事の環境に録画庫として渡り（変数の名前はアプリが決める）、録画の不足を失敗にする
  job request review <PR> --runner codex|claude --prompt <file> --out <file> [--cwd <dir>]
      アプリにレビュー（cross-runner-review の codex exec / claude -p）を仕事として頼む。--prompt を読み --out に書く（どちらも --cwd の中）
      request は仕事の id を job#<id> の 1 行で出し、続けて止まりの記録（アプリが Task に渡す止まりの報告の書式）に書く JSON の例を出す。待たずにそれを書いてターンを終えると、
      仕事が終わったときにアプリが結果の要約を添えて Task を再開する。--cwd の既定は今の作業フォルダ（Task のリポジトリの checkout）
  job list [--json]
      頼まれた仕事（実行中と、終わって 7 日以内）。行: job#<id> 種類 PR 状態 Task
      exit 0 = できた、1 = 断られた（使い方の誤り、アプリが断った）、2 = 判定できない（アプリの Task の外、アプリに届かない）`;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface JobIo {
  out: (s: string) => void;
  err: (s: string) => void;
}
type Job = { id: number; kind: string; taskId: string; pr: number; runner: string | null; status: string; exitCode: number | null };

class Usage extends Error {}

/** The app's jobs API, through the backlog client (same key, same errors): `BACKLOG_URL`'s origin + /api/jobs. */
function jobsApi(env: Record<string, string | undefined>, f: Fetch) {
  if (!env.BACKLOG_URL) throw new BacklogUnknown("job: アプリの API の経路がありません（BACKLOG_URL がありません。アプリの Task の中で実行してください）");
  return client({ ...env, BACKLOG_URL: `${new URL(env.BACKLOG_URL).origin}/api/jobs` }, f);
}

/**
 * The stop to report after a request, as JSON: the Task writes it in the stop report the app's preamble describes (the
 * kit names no app, so the fence is the Task's to write), ends its turn on it, and is resumed when the job ends.
 */
export const stopExample = (job: { id: number; kind: string; pr: number }) =>
  JSON.stringify({ id: `job-${job.id}`, op: `ops-kit job request ${job.kind}`, target: `PR #${job.pr}`, reason: "depends", safety: "read-only", evidence: `job#${job.id} を頼んだ`, state: "waiting", conditions: [{ key: `job#${job.id}`, value: "done", met: false }] });

export async function runJob(argv: string[], env: Record<string, string | undefined>, io: JobIo, opts: { fetch?: Fetch; cwd?: string } = {}): Promise<number> {
  const args = [...argv];
  const take = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    if (at < 0) return undefined;
    const v = args[at + 1];
    if (v === undefined || v.startsWith("--")) throw new Usage(`${flag} に値を渡してください`);
    args.splice(at, 2);
    return v;
  };
  try {
    const sub = args.shift();
    if (sub === "request") {
      const cwd = resolve(opts.cwd ?? process.cwd(), take("--cwd") ?? ".");
      const runner = take("--runner");
      const prompt = take("--prompt");
      const outFile = take("--out");
      const fixtures = take("--fixtures");
      const [kind, prArg, ...extra] = args;
      const pr = Number(prArg);
      if (!Number.isInteger(pr) || pr <= 0 || extra.length) throw new Usage(`使い方:\n${JOB_USAGE}`);
      if (!env.OPS_KIT_TASK_ID) throw new BacklogUnknown("job: Task の id がありません（OPS_KIT_TASK_ID。アプリの Task の中で実行してください）");
      let body: Record<string, unknown>;
      if (kind === "local-ci") {
        if (runner || prompt || outFile) throw new Usage("local-ci は --runner / --prompt / --out を取りません");
        if (fixtures !== undefined && !isAbsolute(fixtures)) throw new Usage(`--fixtures は絶対パスで渡してください: ${fixtures}`);
        body = { kind, taskId: env.OPS_KIT_TASK_ID, pr, cwd, ...(fixtures !== undefined && { fixtures }) };
      } else if (kind === "review") {
        if (fixtures !== undefined) throw new Usage("review は --fixtures を取りません");
        if ((runner !== "codex" && runner !== "claude") || !prompt || !outFile) throw new Usage("review は --runner codex|claude と --prompt <file> と --out <file> が要ります");
        body = { kind, taskId: env.OPS_KIT_TASK_ID, pr, runner, cwd, promptFile: resolve(cwd, prompt), outFile: resolve(cwd, outFile) };
      } else throw new Usage(`仕事の種類は local-ci か review です: ${kind ?? "(なし)"}`);
      const job = (await jobsApi(env, opts.fetch ?? fetch)("POST", "", body)) as Job;
      io.out(`job#${job.id}`);
      io.out(`待たずに、止まりの報告（アプリの書式）にこの JSON を書いてターンを終えてください（仕事が終わるとアプリが結果を添えて再開します）:\n${stopExample({ id: job.id, kind: job.kind, pr: job.pr })}`);
      return 0;
    }
    if (sub === "list") {
      const asJson = args.includes("--json");
      if (args.some((a) => a !== "--json")) throw new Usage(`使い方:\n${JOB_USAGE}`);
      const jobs = (await jobsApi(env, opts.fetch ?? fetch)("GET", "")) as Job[];
      if (asJson) io.out(JSON.stringify(jobs, null, 2));
      else for (const j of jobs) io.out([`job#${j.id}`, j.kind + (j.runner ? `(${j.runner})` : ""), `PR #${j.pr}`, j.status + (j.exitCode === null ? "" : `(${j.exitCode})`), j.taskId].join("\t"));
      return 0;
    }
    throw new Usage(`job のコマンドではありません: ${sub ?? "(なし)"}\n${JOB_USAGE}`);
  } catch (e) {
    io.err((e as Error).message);
    return e instanceof BacklogUnknown ? 2 : 1;
  }
}
