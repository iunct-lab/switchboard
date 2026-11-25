/**
 * `ops-kit job`: a Task asks the app to run its local CI or a review as the app's own job, instead of
 * keeping its session open on a wait loop. The app's address is the origin of `BACKLOG_URL` and its key the file
 * `BACKLOG_TOKEN_FILE` names — the same pair as `backlog`, so only inside the app's Task. The Task waits by ending its
 * turn on a `depends` stop with `job#<id>`; the app resumes it with the result. There is no command that waits here.
 * exit 0 = done, 1 = refused (usage, the app's 4xx), 2 = cannot tell (no app, not reached, 5xx).
 */
import { isAbsolute, resolve } from "node:path";
import { BacklogUnknown, client } from "./backlog-client.ts";

export const JOB_USAGE = `  job request local-ci <PR> [--cwd <dir>] [--fixtures <dir>] [--local] [--change]
      アプリにローカル CI（scripts/local-ci.ts <PR>）を仕事として頼む。仕事はアプリの子として重い処理の枠を取って走り、Task のセッションの子にならない
      --local は外のビルドを使えるホストでも全手順をこのマシンで回す（既定は外。外のビルドが無ければ指定せずにここで回る）
      --fixtures は録画庫（絶対パス）。仕事の環境に録画庫として渡り（変数の名前はアプリが決める）、録画の不足を失敗にする
      --change は <PR> がアプリが持つ変更（GitHub の PR でないローカルの変更）の番号のとき
  job request review <PR> [--runner codex|claude] [--as fallback|recheck|audit|attack|arbiter] [--kinds <k,k>] [--change] --prompt <file> --out <file> [--cwd <dir>]
      アプリにレビュー（cross-runner-review の codex exec / claude -p）を仕事として頼む。--prompt を読み --out に書く（どちらも --cwd の中）
      --runner を省くとアプリが設定と Task のランナーから主レビュアーを決める。主レビュアーでないランナーの名指しは断られる。
      主レビュアーでないランナーに頼むのは、理由を --as で言うときだけ（fallback = 主レビュアーが使用上限、recheck = 再チェック、arbiter = 監督者の裁定、audit = マージ後の監査、attack = 攻める側のレビュー。attack は主レビュアーのランナーで頼み、そのランナーが使用上限ならもう一方で代替する。アプリは上限を確かめず、どちらのランナーも通す）
      --as recheck・--as arbiter は --runner を省くとアプリが設定（再チェックのランナー）から選ぶ。設定と違うランナーの名指しは断られる。ほかの --as は --runner が要る
      --kinds は --as recheck の記録に付ける種類の印（security:docs など。カンマ区切り）。マージ判定は --as recheck のレビューでは種類を外さない（レビューで見る種類は --as arbiter の監督者の裁定で外れる）。--change は <PR> がアプリが持つ変更の番号のとき
      アプリは --prompt の指示の後ろに、レビューするランナーの動き方（読み取り専用のサンドボックス / plan モード）の文を足して渡す
      request は仕事の id を job#<id> の 1 行で出し、続けて止まりの記録（アプリが Task に渡す止まりの報告の書式）に書く JSON の例を出す。待たずにそれを書いてターンを終えると、
      仕事が終わったときにアプリが結果の要約を添えて Task を再開する。--cwd の既定は今の作業フォルダ（Task のリポジトリの checkout）
  job request recheck <PR> --kind migration|rescue|security:lockfile [--cwd <dir>] [--change]
      アプリに、コマンドで合否が決まる再チェック（scripts/recheck.ts <種類>）を仕事として頼む。種類ごとのコマンドはアプリが組む（コマンドは運ばない）。
      request の出力と待ち方は local-ci と同じ。レビューで見る種類（size など）は監督者の裁定（job request review --as arbiter）で外れる
  job request tag-ci [--cwd <dir>]
      アプリにタグの CI（scripts/tag-ci.ts --sha <最新のタグのコミット>。そのコミットで CI の手順を全部回す）を仕事として頼む。PR は取らない。仕事の記録（そのコミットの合否）を、アプリが昇格の判定で読む。
      request の出力と待ち方は local-ci と同じ
  job list [--json]
      頼まれた仕事（実行中と、終わって 7 日以内）。行: job#<id> 種類 PR 状態 Task
      exit 0 = できた、1 = 断られた（使い方の誤り、アプリが断った）、2 = 判定できない（アプリの Task の外、アプリに届かない）`;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface JobIo {
  out: (s: string) => void;
  err: (s: string) => void;
}
type Job = { id: number; kind: string; taskId: string; pr: number; runner: string | null; status: string; exitCode: number | null; model: string | null; effort: string | null };

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
  JSON.stringify({ id: `job-${job.id}`, op: `ops-kit job request ${job.kind}`, target: job.kind === "tag-ci" ? "タグの CI" : `PR #${job.pr}`, reason: "depends", safety: "read-only", evidence: `job#${job.id} を頼んだ`, state: "waiting", conditions: [{ key: `job#${job.id}`, value: "done", met: false }] });

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
      const why = take("--as");
      const kindsArg = take("--kinds");
      const recheckKind = take("--kind");
      const local = args.includes("--local");
      if (local) args.splice(args.indexOf("--local"), 1);
      const change = args.includes("--change");
      if (change) args.splice(args.indexOf("--change"), 1);
      const [kind, prArg, ...extra] = args;
      const pr = kind === "tag-ci" ? 0 : Number(prArg);
      if (kind === "tag-ci" ? prArg !== undefined || extra.length : !Number.isInteger(pr) || pr <= 0 || extra.length) throw new Usage(`使い方:\n${JOB_USAGE}`);
      if (!env.OPS_KIT_TASK_ID) throw new BacklogUnknown("job: Task の id がありません（OPS_KIT_TASK_ID。アプリの Task の中で実行してください）");
      let body: Record<string, unknown>;
      if (kind === "local-ci") {
        if (runner || prompt || outFile || why || kindsArg !== undefined || recheckKind !== undefined) throw new Usage("local-ci は --runner / --as / --kinds / --kind / --prompt / --out を取りません");
        if (fixtures !== undefined && !isAbsolute(fixtures)) throw new Usage(`--fixtures は絶対パスで渡してください: ${fixtures}`);
        body = { kind, taskId: env.OPS_KIT_TASK_ID, pr, cwd, ...(fixtures !== undefined && { fixtures }), ...(local && { local }), ...(change && { change }) };
      } else if (kind === "tag-ci") {
        if (runner || prompt || outFile || why || kindsArg !== undefined || fixtures !== undefined || local || change || recheckKind !== undefined) throw new Usage("tag-ci は --cwd だけを取ります");
        body = { kind, taskId: env.OPS_KIT_TASK_ID, cwd };
      } else if (kind === "recheck") {
        if (runner || prompt || outFile || why || kindsArg !== undefined || fixtures !== undefined || local) throw new Usage("recheck は --kind <種類> と --cwd / --change だけを取ります");
        if (!recheckKind || !["migration", "rescue", "security:lockfile"].includes(recheckKind)) throw new Usage(`recheck には --kind migration|rescue|security:lockfile が要ります: ${recheckKind ?? "(なし)"}`);
        body = { kind, taskId: env.OPS_KIT_TASK_ID, pr, cwd, recheck: recheckKind, ...(change && { change }) };
      } else if (kind === "review") {
        if (fixtures !== undefined || local || recheckKind !== undefined) throw new Usage("review は --fixtures / --local / --kind を取りません");
        if ((runner !== undefined && runner !== "codex" && runner !== "claude") || !prompt || !outFile) throw new Usage("review は --prompt <file> と --out <file> が要ります（--runner は codex|claude）");
        if (why !== undefined && !["fallback", "recheck", "audit", "attack", "arbiter"].includes(why)) throw new Usage(`--as は fallback / recheck / audit / attack / arbiter のどれかです: ${why}`);
        if (why && why !== "recheck" && why !== "arbiter" && !runner) throw new Usage("--as（主レビューでない回の理由）は --runner codex|claude と一緒に渡してください（--as recheck と --as arbiter は省けばアプリが選ぶ）");
        const kinds = kindsArg === undefined ? [] : kindsArg.split(",").map((k) => k.trim());
        if (kinds.some((k) => !k)) throw new Usage("--kinds は再チェックの種類をカンマ区切りで渡してください");
        if (why !== "recheck" && kindsArg !== undefined) throw new Usage("--kinds は --as recheck のときだけ渡します");
        body = { kind, taskId: env.OPS_KIT_TASK_ID, pr, ...(runner && { runner }), ...(why && { as: why }), ...(kinds.length && { kinds }), ...(change && { change }), cwd, promptFile: resolve(cwd, prompt), outFile: resolve(cwd, outFile) };
      } else throw new Usage(`仕事の種類は local-ci・review・recheck・tag-ci のどれかです: ${kind ?? "(なし)"}`);
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
      // a review's runner with the model / effort it ran with ("-": the CLI's own, or not recorded)
      else for (const j of jobs) io.out([`job#${j.id}`, j.kind + (j.runner ? `(${j.runner}${j.kind === "review" ? ` ${j.model ?? "-"} / ${j.effort ?? "-"}` : ""})` : ""), `PR #${j.pr}`, j.status + (j.exitCode === null ? "" : `(${j.exitCode})`), j.taskId].join("\t"));
      return 0;
    }
    throw new Usage(`job のコマンドではありません: ${sub ?? "(なし)"}\n${JOB_USAGE}`);
  } catch (e) {
    io.err((e as Error).message);
    return e instanceof BacklogUnknown ? 2 : 1;
  }
}
