import { readFileSync } from "node:fs";
import { repoOf } from "./gh.ts";
import { findSecrets, hostAws } from "./secrets.ts";

/**
 * `ops-kit backlog …` (#918): the backlog the app running the Task stored, read and edited through its API — the same
 * routes as its screen — instead of asking GitHub each time. Reads answer what is stored (and how fresh); `--fresh`
 * asks the app to send what it keeps and import the repository first. Edits are stored there and sent to GitHub by
 * the app later. Nothing here writes the app's database or asks GitHub: when the app cannot be reached, nothing is
 * read as current (exit 2). The stored data is what is true (#2264): when the app cannot reach GitHub, `--fresh`
 * answers what is stored with its last sync and 「GitHub 未同期」. The app's address comes in `BACKLOG_URL`, its key in the file `BACKLOG_TOKEN_FILE` names.
 */

export const BACKLOG_USAGE = `  backlog list [--fresh] [--json]
      保存済みのバックログ（要望と PBI）を、取得の時刻と同期の状態つきで出す。GitHub には問い合わせない
  backlog view <issue> [--fresh] [--json]
      Issue 1 件（本文、コメント、Project のフィールド、送信待ち、同期の状態）。<issue> は番号か、ここで作ってまだ番号の無い Issue の localId
  backlog create --title <t> [--body-file <f|->] [--label <l>]... [--milestone <m>] [--parent <n>] [--field <name>=<value>]...
  backlog edit <issue> [--title <t>] [--body-file <f|->] [--add-label <l>]... [--remove-label <l>]... [--state open|closed]
               [--milestone <m> | --no-milestone] [--parent <n> | --no-parent]
  backlog comment <issue> --body-file <f|->
  backlog set <issue> <field> <value>
  backlog triage <issue> <area> <kind> <priority> [<phase>] [<parent>] [<status>]
      編集はアプリに保存して返り、アプリが後で GitHub に送る（GitHub 連携の無い workspace ではその場で確定し、作成で番号が付く）。認証に使える値を含む文は送らない
      --fresh: アプリに送信と取込みを済ませてから答えさせる（着手・マージの判断の前、最新の回答を読むとき）。
      GitHub に届かなければ保存値と未同期の印（最終同期の時刻と「GitHub 未同期」、stderr）で答える（exit 0）
      exit 0 = できた、1 = 断られた（使い方の誤り・保存していない Issue・秘密の検出など）、2 = 判定できない（アプリに届かない、
      まだ取り込んでいない）。BACKLOG_URL が無い環境（アプリの Task の外）は 2
      リポジトリは --workspace <id>、無ければ GH_REPO、無ければ BACKLOG_WORKSPACE（GitHub 連携の無い workspace の Task にアプリが渡す）、無ければ origin`;

export interface BacklogIo {
  out: (s: string) => void;
  err: (s: string) => void;
  /** Standard input, for `--body-file -`. */
  stdin?: () => Promise<string>;
}

/** The app answered no (4xx): the edit or the read is refused. */
class Refused extends Error {}
/** It cannot be told: the app is not reached, answered 5xx / 424, or has not imported the repository. `status`: the app's answer, if any. */
export class BacklogUnknown extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
  }
}
const Unknown = BacklogUnknown;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

interface List {
  syncs: Sync[];
  items: Array<{ number: number; workspaceId: string; type: string; stage: string; projectStatus?: string | null; title: string }>;
}

interface Sync {
  workspaceId: string;
  repository: string | null;
  syncedAt: number | null;
  syncing: boolean;
  sync: { state: string; reason: string | null; pendingCount: number };
}

export async function runBacklog(argv: string[], env: Record<string, string | undefined>, io: BacklogIo, opts: { fetch?: Fetch; cwd?: string; phase?: boolean } = {}): Promise<number> {
  const args = [...argv];
  const take = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    if (at < 0) return undefined;
    const v = args[at + 1];
    if (v === undefined || v.startsWith("--")) throw new Refused(`${flag} に値を渡してください`);
    args.splice(at, 2);
    return v;
  };
  const takeAll = (flag: string): string[] => {
    const all: string[] = [];
    for (let v = take(flag); v !== undefined; v = take(flag)) all.push(v);
    return all;
  };
  const has = (flag: string): boolean => {
    const at = args.indexOf(flag);
    if (at >= 0) args.splice(at, 1);
    return at >= 0;
  };
  try {
    const [sub] = args.splice(0, 1);
    const explicit = take("--workspace");
    const fresh = has("--fresh");
    const asJson = has("--json");
    const api = client(env, opts.fetch ?? fetch);
    const load = (imported = true) => findWorkspace(api, env, { workspace: explicit, cwd: opts.cwd, imported });
    const workspace = async (imported = true) => (await load(imported)).ws;
    const settle = async (ws: Sync) => {
      const unsynced = await syncOrStored(api, ws);
      if (unsynced) io.err(unsynced);
    };
    // an edit is stored at once and sent by the app: there is nothing for it to wait for
    if ((fresh || asJson) && sub !== "list" && sub !== "view") throw new Refused("--fresh と --json は list / view だけ（編集はアプリに保存して返り、送信はアプリが行う）");
    const text = async (file: string | undefined) => (file === undefined ? undefined : file === "-" ? await (io.stdin ?? (() => Bun.stdin.text()))() : readFileSync(file, "utf8"));
    const noSecrets = (...texts: Array<string | undefined>) => {
      const kinds = [...new Set(texts.flatMap((t) => (t ? findSecrets(t, hostAws(env as NodeJS.ProcessEnv)).map((h) => h.kind) : [])))];
      if (kinds.length) throw new Refused(`認証に使える値（${kinds.join(", ")}）が含まれるので送りません。値を消してから実行してください`);
    };
    const edit = async (ref: string, body: Record<string, unknown>) => {
      const ws = await workspace();
      await api("PATCH", `/${encodeURIComponent(issueRef(ref))}`, { workspaceId: ws.workspaceId, ...body });
      // pending or not shows in `view` (送信待ち): a backlog kept in the app is applied at once (#2265)
      io.out(`#${issueRef(ref)} を保存しました`);
      return 0;
    };
    switch (sub) {
      case "list": {
        if (args.length) throw new Refused("backlog list [--fresh] [--json]");
        let { ws, list } = await load(!fresh);
        if (fresh) await settle(ws), ({ ws, list } = await load());
        const items = list.items.filter((i) => i.workspaceId === ws.workspaceId);
        if (asJson) io.out(JSON.stringify({ ...ws, items }));
        else {
          io.out(freshness(ws));
          for (const i of items) io.out(`#${i.number}\t${i.type}\t${i.stage}\t${i.projectStatus ?? "-"}\t${i.title}`);
        }
        return 0;
      }
      case "view": {
        const [ref, ...extra] = args;
        if (!ref || extra.length) throw new Refused("backlog view <issue> [--fresh] [--json]");
        let ws = await workspace(!fresh);
        if (fresh) await settle(ws), (ws = await workspace());
        const d = (await api("GET", `/${encodeURIComponent(issueRef(ref))}?workspaceId=${encodeURIComponent(ws.workspaceId)}`)) as Detail;
        io.out(asJson ? JSON.stringify(d) : formatDetail(d));
        return 0;
      }
      case "create": {
        const title = take("--title");
        const body = await text(take("--body-file"));
        const labels = takeAll("--label");
        const milestone = take("--milestone");
        const parent = take("--parent");
        const fields = Object.fromEntries(takeAll("--field").map(fieldPair));
        if (!title || args.length) throw new Refused("backlog create --title <t> [--body-file <f|->] [--label <l>]... [--milestone <m>] [--parent <n>] [--field <name>=<value>]...");
        noSecrets(title, body, milestone, ...labels, ...Object.values(fields).map(String));
        const ws = await workspace();
        const r = (await api("POST", "", { workspaceId: ws.workspaceId, title, body: body ?? "", labels, milestone: milestone ?? null, parent: parent ? number(parent) : null, fields: Object.keys(fields).length ? fields : null })) as { localId: string; number?: number | null };
        // a backlog kept in the app numbers it at once (#2265); GitHub's once it is sent
        io.out(typeof r.number === "number" ? `#${r.number} を作りました（localId ${r.localId}）` : `作りました（送信待ち）: localId ${r.localId}。番号が付く前も backlog view ${r.localId} で読める`);
        return 0;
      }
      case "edit": {
        const [ref] = args.splice(0, 1);
        const title = take("--title");
        const body = await text(take("--body-file"));
        const add = takeAll("--add-label");
        const remove = takeAll("--remove-label");
        const state = take("--state");
        const milestone = has("--no-milestone") ? null : take("--milestone");
        const parent = has("--no-parent") ? null : take("--parent");
        if (!ref || args.length || (state !== undefined && !/^(open|closed)$/i.test(state))) throw new Refused("backlog edit <issue> [--title <t>] [--body-file <f|->] [--add-label <l>]... [--remove-label <l>]... [--state open|closed] [--milestone <m> | --no-milestone] [--parent <n> | --no-parent]");
        noSecrets(title, body, milestone ?? undefined, ...add);
        const input: Record<string, unknown> = {
          ...(title !== undefined && { title }),
          ...(body !== undefined && { body }),
          ...((add.length || remove.length) && { labels: { add, remove } }),
          ...(state !== undefined && { state: state.toUpperCase() }),
          ...(milestone !== undefined && { milestone }),
          ...(parent !== undefined && { parent: parent === null ? null : number(parent) }),
        };
        if (!Object.keys(input).length) throw new Refused("変えるものを 1 つ以上渡してください");
        return await edit(ref, input);
      }
      case "comment": {
        const [ref] = args.splice(0, 1);
        const body = await text(take("--body-file"));
        if (!ref || !body?.trim() || args.length) throw new Refused("backlog comment <issue> --body-file <f|->");
        noSecrets(body);
        const ws = await workspace();
        await api("POST", `/${number(ref)}/comment`, { workspaceId: ws.workspaceId, text: body });
        io.out(`#${number(ref)} にコメントを保存しました`);
        return 0;
      }
      case "set": {
        const [ref, field, value, ...extra] = args;
        if (!ref || !field || value === undefined || extra.length) throw new Refused("backlog set <issue> <field> <value>");
        noSecrets(value);
        // GitHub's field type decides when it is sent (backlog-send.ts): a number only where the stored value is one
        const ws = await workspace();
        const d = (await api("GET", `/${encodeURIComponent(issueRef(ref))}?workspaceId=${encodeURIComponent(ws.workspaceId)}`)) as Detail;
        const numeric = typeof d.fields?.[field] === "number" && /^-?[0-9]+(\.[0-9]+)?$/.test(value);
        return await edit(ref, { fields: { [field]: numeric ? Number(value) : value } });
      }
      case "triage": {
        const [ref, area, kind, priority, ...tail] = args;
        const phase = opts.phase ? tail.shift() : undefined;
        const [parent, status, ...extra] = tail;
        if (!ref || !area || !kind || !priority || (opts.phase && !phase) || extra.length) throw new Refused(`backlog triage <issue> <area> <kind> <priority> ${opts.phase ? "<phase> " : ""}[<parent>] [<status>]`);
        const fields: Record<string, string> = { Area: area, Kind: kind, Priority: priority, ...(phase !== undefined && { Phase: phase }), Status: status || "Backlog" };
        return await edit(ref, { project: true, fields, ...(parent ? { parent: number(parent) } : {}) });
      }
      default:
        throw new Refused(`backlog のコマンドではありません: ${sub ?? "(なし)"}\n${BACKLOG_USAGE}`);
    }
  } catch (e) {
    io.err((e as Error).message);
    return e instanceof Refused ? 1 : 2;
  }
}

/** What `GET /api/backlog/records` answers (#919): the stored records the kit's lint and parallel guard read instead of GitHub. */
export interface StoredRecords {
  workspaceId: string;
  /** `github`; any other = a backlog kept in the app only (#2265): no GitHub Issue or Project behind it. */
  service: string;
  repository: string;
  project: { owner: string; number: number };
  fetchedAt: number;
  /** The checkout's top level, against which a Task body's paths are read. */
  top: Array<{ name: string; dir: boolean }>;
  /** Every stored Issue (open and closed) as shown, with its fields in the workspace's Project (null = not in it). */
  issues: Array<{ number: number; title: string; state: "OPEN" | "CLOSED"; stateReason: string | null; body: string; labels: string[]; parent: number | null; subIssues: number[]; updatedAt: string; fields: Record<string, string | number | null> | null }>;
  /** Issues whose last read was not complete (404 / 403 / not read yet): what is stored of them is not current. */
  unread: number[];
  pulls: Array<{ number: number; state: "OPEN" | "CLOSED" | "MERGED"; isDraft: boolean; labels: string[]; closes: number[]; mergeCommit: string | null; updatedAt: string; files: string[] | null }>;
}

/**
 * The stored records of the repository (`repo`, else GH_REPO, else BACKLOG_WORKSPACE, else origin) for the kit's checks (#919); with `fresh`,
 * the app sends what it keeps and imports first, and when it cannot reach GitHub the stored records are answered with
 * `unsynced` (#2264). Throws BacklogUnknown when it cannot be told (no app, not imported, 5xx): a check then answers
 * "could not check" (exit 2), never a pass.
 */
export async function readRecords(env: Record<string, string | undefined>, opts: { fresh: boolean; repo?: string; cwd?: string; fetch?: Fetch }): Promise<StoredRecords & { unsynced: string | null }> {
  try {
    const api = client(env, opts.fetch ?? fetch);
    const { ws } = await findWorkspace(api, opts.repo ? { ...env, GH_REPO: opts.repo } : env, { cwd: opts.cwd, imported: !opts.fresh });
    const unsynced = opts.fresh ? await syncOrStored(api, ws) : null;
    return { ...((await api("GET", `/records?workspaceId=${encodeURIComponent(ws.workspaceId)}`)) as StoredRecords), unsynced };
  } catch (e) {
    throw e instanceof Unknown ? e : new Unknown((e as Error).message);
  }
}

/**
 * `POST /sync` (#2264): null once the app sent what it keeps and imported; the line to show when it could not reach
 * GitHub (424) — what is stored is answered then. Anything else it cannot tell (no app, 5xx, 401, not imported) throws.
 */
async function syncOrStored(api: ReturnType<typeof client>, ws: Sync): Promise<string | null> {
  try {
    await api("POST", "/sync", { workspaceId: ws.workspaceId });
    return null;
  } catch (e) {
    if (!(e instanceof Unknown) || e.status !== 424) throw e;
    return `GitHub 未同期: 保存値で答えます（最終同期 ${jst(ws.syncedAt)}。${e.message}）`;
  }
}

/** The workspace of the repository in the app's list. `imported`: one never imported is unknown (exit 2), never "no items" or "not stored". */
async function findWorkspace(api: ReturnType<typeof client>, env: Record<string, string | undefined>, opts: { workspace?: string; cwd?: string; imported: boolean }): Promise<{ ws: Sync; list: List }> {
  // a Task on a workspace whose backlog is kept in the app (#2265) is given its id: no repository to read it by
  const explicit = opts.workspace ?? (env.GH_REPO ? undefined : env.BACKLOG_WORKSPACE || undefined);
  const list = (await api("GET", "")) as List;
  const repo = explicit ? null : await repoName(env, opts.cwd);
  const ws = list.syncs.find((s) => (explicit ? s.workspaceId === explicit : s.repository?.toLowerCase() === repo!.toLowerCase()));
  if (!ws) throw new Unknown(explicit ? `workspace ${explicit} がアプリにありません` : `${repo} のバックログはアプリに取り込まれていません（workspace の登録か --workspace <id>）`);
  if (opts.imported && ws.syncedAt === null) throw new Unknown(`${ws.repository ?? ws.workspaceId} はまだ取り込まれていません（同期 ${ws.sync.state}${ws.sync.reason ? `、${ws.sync.reason}` : ""}）。空の一覧や「保存されていない」として扱わない`);
  return { ws, list };
}

/** Calls the app's backlog API: the parsed answer, or Refused (4xx) / Unknown (no app, 5xx, 424, not imported = 409 on a read). */
function client(env: Record<string, string | undefined>, f: Fetch) {
  return async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const base = env.BACKLOG_URL;
    if (!base) throw new Unknown("backlog: アプリの API の経路がありません（BACKLOG_URL がありません。アプリの Task の中で実行してください）。保存済みの値は読めません");
    let key = "";
    try {
      if (env.BACKLOG_TOKEN_FILE) key = readFileSync(env.BACKLOG_TOKEN_FILE, "utf8").trim();
    } catch {
      throw new Unknown(`backlog: アプリの鍵のファイルが読めません（BACKLOG_TOKEN_FILE）`);
    }
    let res: Response;
    try {
      res = await f(`${base.replace(/\/+$/, "")}${path}`, { method, headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) }, ...(body !== undefined && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      throw new Unknown(`backlog: アプリに届きません（${(e as Error).message}）。判定できません`);
    }
    const answer = await res.json().catch(() => null);
    if (res.ok) return answer;
    const message = `backlog: ${res.status} ${(answer as { error?: string } | null)?.error ?? res.statusText}`;
    // 409 on a read / a fresh, and 424, are a backlog not imported or not readable now: unknown, never "none"
    if (res.status >= 500 || res.status === 424 || res.status === 401 || (res.status === 409 && (method === "GET" || path === "/sync"))) throw new Unknown(message, res.status);
    throw new Refused(message);
  };
}

async function repoName(env: Record<string, string | undefined>, cwd?: string): Promise<string> {
  // GH_REPO, else origin; GitHub is never asked for it
  const noGh = { run: async () => { throw new Unknown("リポジトリが分かりません（GH_REPO を設定するか、origin のあるディレクトリで実行するか、--workspace <id>）"); } } as unknown as Parameters<typeof repoOf>[0];
  const r = await repoOf(noGh, env, cwd);
  return `${r.owner}/${r.name}`;
}

const jst = (at: number | null) => (at === null ? "未取得" : new Date(at).toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }) + " JST");

function freshness(ws: Sync): string {
  return `# ${ws.repository ?? "?"}  最終取得 ${jst(ws.syncedAt)}  同期 ${ws.sync.state}${ws.sync.reason ? `（${ws.sync.reason}）` : ""}  送信待ち ${ws.sync.pendingCount}${ws.syncing ? "  取込み中" : ""}`;
}

interface Detail {
  issue: { number: number; title: string; state: string; labels: string[]; milestone: string | null; parent: number | null; body: string; url: string };
  comments: Array<{ id: string; body: string; createdAt: string }>;
  fields: Record<string, string | number | null> | null;
  fetchedAt: number | null;
  localId: string | null;
  pending: number;
  sync: { state: string; reason: string | null; lastSuccessfulSync: number | null };
}

function formatDetail(d: Detail): string {
  const i = d.issue;
  const at = d.sync.lastSuccessfulSync === null ? "未取得" : new Date(d.sync.lastSuccessfulSync).toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }) + " JST";
  return [
    `#${i.number || d.localId} ${i.title} [${i.state}]`,
    `labels: ${i.labels.join(", ") || "-"}  milestone: ${i.milestone ?? "-"}  parent: ${i.parent ? `#${i.parent}` : "-"}`,
    `fields: ${d.fields ? Object.entries(d.fields).map(([k, v]) => `${k}=${v ?? "-"}`).join(", ") : "-"}`,
    `最終取得 ${at}  同期 ${d.sync.state}${d.sync.reason ? `（${d.sync.reason}）` : ""}  送信待ち ${d.pending}`,
    "",
    i.body,
    ...d.comments.flatMap((c) => ["", `----- ${c.createdAt}`, c.body]),
  ].join("\n");
}

function issueRef(s: string): string {
  return /^#?[0-9]+$/.test(s) ? s.replace(/^#/, "") : s;
}

function number(s: string): number {
  if (!/^#?[0-9]+$/.test(s)) throw new Refused(`Issue 番号ではありません: ${s}`);
  return Number(s.replace(/^#/, ""));
}

function fieldPair(s: string): [string, string] {
  const at = s.indexOf("=");
  if (at <= 0) throw new Refused(`--field は <name>=<value>: ${s}`);
  return [s.slice(0, at), s.slice(at + 1)];
}
