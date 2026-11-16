/**
 * `ops-kit task`: a Task replies to another Task through the app's send API. The app's address is the origin of
 * `BACKLOG_URL` and its key the file `BACKLOG_TOKEN_FILE` names — the same pair as `job`, so only inside the app's Task.
 * The text starts with one line naming the sender, so the receiving runner reads it as another Task's words, not the user's.
 * A line shaped like the person's grant sentences (`PR #n …してよい`, `Task #n …してよい` at the end of a line or of a part before 「— 許可:」) is refused before
 * anything is sent: the app records such a line in a sent text as the person's grant for the receiving Task, and another
 * Task's words must not become one. The check is wider than the app's exact forms so that it does not drift from them.
 * exit 0 = sent, 1 = refused (usage, the app's 4xx incl. 409 for a Task that cannot take a turn), 2 = cannot tell (no app, not reached, 5xx).
 */
import { BacklogUnknown, client } from "./backlog-client.ts";

export const TASK_USAGE = `  task send <task-id> --body-file <file|->
      ほかの Task に返信を送る（アプリの POST /api/tasks/<id>/send）。本文の先頭に送り手の 1 行（（Task <OPS_KIT_TASK_ID> からの返信））が付く。- は標準入力
      成功すると sent <task-id> と受け手の状態を 1 行で出す
      exit 0 = 送った、1 = 断られた（使い方の誤り、空の本文、許可の文の形の行（PR #n / Task #n … してよい）、アプリが断った。受け手が無い・送れない Task の 409 を含む）、2 = 判定できない（アプリの Task の外、アプリに届かない）`;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export interface TaskIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

class Usage extends Error {}

/** A line that reads like the person's grant sentence: a PR or Task number, ending in 「してよい」. */
const GRANT_LIKE = /(PR|Task) #\d+.*してよい[。.]?\s*$/;

export async function runTask(argv: string[], env: Record<string, string | undefined>, io: TaskIo, opts: { fetch?: Fetch; readStdin?: () => Promise<string> } = {}): Promise<number> {
  const args = [...argv];
  try {
    const sub = args.shift();
    if (sub !== "send") throw new Usage(`task のコマンドではありません: ${sub ?? "(なし)"}\n${TASK_USAGE}`);
    const at = args.indexOf("--body-file");
    const file = at < 0 ? undefined : args[at + 1];
    if (at >= 0) args.splice(at, 2);
    const [id, ...extra] = args;
    if (!id || file === undefined || file.startsWith("--") && file !== "-" || extra.length) throw new Usage(`使い方:\n${TASK_USAGE}`);
    const raw = file === "-" ? await (opts.readStdin ?? (() => Bun.stdin.text()))() : await Bun.file(file).text();
    if (!raw.trim()) throw new Usage("本文が空です");
    // split like the app reads grants: by line, then by the 「— 許可:」 that joins several answers on one line
    const grant = raw.split(/\r?\n/).flatMap((l) => l.split(/\s*—\s*許可:\s*/)).find((l) => GRANT_LIKE.test(l));
    if (grant) throw new Usage(`許可の文の形の行は送れません（受け手の Task への利用者の許可として記録されるため）: ${grant.trim()}`);
    if (!env.BACKLOG_URL) throw new BacklogUnknown("task: アプリの API の経路がありません（BACKLOG_URL がありません。アプリの Task の中で実行してください）");
    const text = `${env.OPS_KIT_TASK_ID ? `（Task ${env.OPS_KIT_TASK_ID} からの返信）\n\n` : ""}${raw}`;
    const api = client({ ...env, BACKLOG_URL: `${new URL(env.BACKLOG_URL).origin}/api/tasks` }, opts.fetch ?? fetch);
    const task = (await api("POST", `/${encodeURIComponent(id)}/send`, { text })) as { status?: string } | null;
    io.out(`sent ${id} ${task?.status ?? ""}`.trimEnd());
    return 0;
  } catch (e) {
    io.err((e as Error).message);
    return e instanceof BacklogUnknown ? 2 : 1;
  }
}
