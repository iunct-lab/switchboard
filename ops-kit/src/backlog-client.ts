import { readFileSync } from "node:fs";
import { commentOnGithub, createOnGithub, editOnGithub, listFromGithub, viewFromGithub, type Project } from "./backlog-github.ts";
import { projectOf, type OpsConfig } from "./config.ts";
import { repoOf, type GhClient } from "./gh.ts";
import { fieldChoice, setField, UsageError } from "./set.ts";
import { triage } from "./triage.ts";
import { findSecrets, hostAws } from "./secrets.ts";

/**
 * `ops-kit backlog …` (#918): the backlog the app running the Task stored, read and edited through its API — the same
 * routes as its screen — instead of asking GitHub each time. Reads answer what is stored (and how fresh); `--fresh`
 * asks the app to send what it keeps and import the repository first. Edits are stored there and sent to GitHub by
 * the app later. Nothing here writes the app's database or asks GitHub: when the app cannot be reached, nothing is
 * read as current (exit 2). The stored data is what is true (#2264): when the app cannot reach GitHub, `--fresh`
 * answers what is stored with its last sync and 「GitHub 未同期」. The app's address comes in `BACKLOG_URL`, its key in the file `BACKLOG_TOKEN_FILE` names.
 */

/** triage's usage, one text for the list and the errors: `<phase>` is read only when the configuration has fields.phase. */
export const triageUsage = (phase: boolean) => `triage <issue> <area> <kind> <priority> ${phase ? "[<phase>] " : ""}[<parent>] [<status>]`;

export const BACKLOG_USAGE = `  backlog list [--search <語>] [--label <l>]... [--state open|closed|all] [--fresh] [--json]
      保存済みの Issue を、取得の時刻と同期の状態つきで出す（行: #番号 type OPEN|CLOSED Status 題）。GitHub には問い合わせない
      --search: 題の部分一致（大文字小文字を区別しない）/ --label: すべてを持つもの / --state: 既定 open
  backlog view <issue> [--fresh] [--json]
      Issue 1 件（本文、コメント、Project のフィールド、送信待ち、同期の状態）。<issue> は番号か、ここで作ってまだ番号の無い Issue の localId。保留中の編集（競合・失敗・結果不明）は「保留:」の行に理由つき
  backlog retry <issue>
      GitHub が受け付けなかった（失敗で保留中の）編集を、原因を直した後に全部送り直す（アプリの Task の中だけ）。無ければ 1
  backlog withdraw <issue> [--reason <文>]
      結果不明・失敗で保留中の編集を、GitHub に何も書かずに全部取り下げる（中身を確かめてから。アプリの Task の中だけ）。無ければ 1
  backlog create --title <t> [--body-file <f|->] [--label <l>]... [--milestone <m>] [--parent <n>] [--field <name>=<value>]... [--head <枝> --base <枝>]
      --head / --base: PR の代わりのローカルの「変更」として作る（GitHub 連携の無い workspace だけ。両方そろえる）
  backlog edit <issue> [--title <t>] [--body-file <f|->] [--add-label <l>]... [--remove-label <l>]... [--state open|closed]
               [--reason completed|not-planned] [--milestone <m> | --no-milestone] [--parent <n> | --no-parent]
      --reason: 閉じた理由（--state closed と一緒だけ。重複・やらないと決めた Issue は not-planned。閉じている Issue の理由の付け替えも同じ形）
  backlog comment <issue> --body-file <f|->
  backlog set <issue> <field> <value>
      <value> が空（""）ならそのフィールドを空にする
  backlog ${triageUsage(true)}
      <phase> は設定に fields.phase があるときだけ渡す（無い設定では "" を渡しても読み飛ばす）
      編集はアプリに保存して返り、アプリが後で GitHub に送る（GitHub 連携の無い workspace ではその場で確定し、作成で番号が付く。
      BACKLOG_URL が無ければ GitHub にその場で書く）。認証に使える値を含む文は送らない
      --fresh: アプリに送信と取込みを済ませてから答えさせる（着手・マージの判断の前、最新の回答を読むとき）。
      取込みは軽い読みなので、GitHub のボードを手で変えた Project のフィールドは画面の再読込か次の全件読みまで入らない。
      GitHub に届かなければ保存値と未同期の印（最終同期の時刻と「GitHub 未同期」、stderr）で答える（exit 0）
      exit 0 = できた、1 = 断られた（使い方の誤り・保存していない Issue・秘密の検出など）、2 = 判定できない（アプリに届かない、
      まだ取り込んでいない）。BACKLOG_URL が無い環境（アプリの Task の外）では GitHub に直接つないで同じ形で出す・書く
      （--fresh は何もしない、--workspace は 1、set / triage / --field は ops.config.json の Project）。
      BACKLOG_URL があってアプリに届かなければ GitHub に切り替えず 2
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

/**
 * One line of `backlog list`: `#<number>\t<type>\t<OPEN|CLOSED>\t<Status|->\t<title>` (type = `change` for a local
 * change (#3969), else the x of a `type:x` label, else `-`).
 */
export function listRow(i: { number: number; title: string; state: string; type: string; status: string | null }): string {
  return `#${i.number}\t${i.type}\t${i.state}\t${i.status ?? "-"}\t${i.title}`;
}

/** A local change shares the Issues' numbers (#2463) but is not one (#3969): its row says `change`. */
const typeOf = (i: { labels: string[]; change?: unknown }) => (i.change ? "change" : i.labels.find((l) => l.startsWith("type:"))?.slice("type:".length) || "-");

export interface ListFilter {
  /** A part of the title, case-insensitive. */
  search?: string;
  /** Every one of these labels. */
  labels: string[];
  state: "open" | "closed" | "all";
  /** Issues, local changes or both (#3969); absent = Issues, so an open change is not counted as an open Issue. */
  kind?: "issue" | "change" | "all";
}

/** The issues `backlog list` shows for `f`, by number (the app's stored order and GitHub's search order differ). */
export function filterIssues<T extends { number: number; title: string; state: string; labels: string[]; change?: unknown }>(issues: T[], f: ListFilter): T[] {
  const word = f.search?.toLowerCase();
  const kind = f.kind ?? "issue";
  return issues.filter((i) => (kind === "all" || (kind === "change") === Boolean(i.change)) && (f.state === "all" || i.state.toLowerCase() === f.state) && f.labels.every((l) => i.labels.includes(l)) && (!word || i.title.toLowerCase().includes(word))).sort((a, b) => a.number - b.number);
}

interface Sync {
  workspaceId: string;
  /** Where the workspace's backlog is kept: `github` (synced with GitHub), or another value for one kept only in the app. */
  backlog: string;
  repository: string | null;
  syncedAt: number | null;
  syncing: boolean;
  sync: { state: string; reason: string | null; pendingCount: number };
}

/**
 * `gh` / `project` / `config`: without BACKLOG_URL (outside the app's Task), the commands read and write GitHub itself
 * through `gh`, with the Status of `project` (null = none: Status `-`) and the Project of `config` for set / triage /
 * `--field` (it throws when there is none). With BACKLOG_URL, gh is never used, even when the app cannot be reached.
 */
export async function runBacklog(argv: string[], env: Record<string, string | undefined>, io: BacklogIo, opts: { fetch?: Fetch; cwd?: string; phase?: boolean; gh?: GhClient; project?: () => Promise<Project>; config?: () => Promise<OpsConfig> } = {}): Promise<number> {
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
    if (sub === "--help" || sub === "-h") {
      io.out(BACKLOG_USAGE);
      return 0;
    }
    const explicit = take("--workspace");
    const fresh = has("--fresh");
    const asJson = has("--json");
    const api = client(env, opts.fetch ?? fetch);
    // outside the app's Task: GitHub itself, in the same shape (#3071). Never when BACKLOG_URL is set and the app is down
    const direct = !env.BACKLOG_URL && opts.gh ? { gh: opts.gh, project: opts.project ?? (async () => null) } : null;
    // the Project's fields on GitHub need the repository's ops.config.json (its Project)
    const config = async () => {
      try {
        if (!opts.config) throw new Error("設定がありません");
        const c = await opts.config();
        // a Project URL that cannot be read is refused here, before anything is written (create writes the Issue first)
        projectOf(c, env);
        return c;
      } catch (e) {
        throw new Refused(`GitHub の Project のフィールドを書くには ops.config.json（Project の URL）が要ります: ${(e as Error).message}`);
      }
    };
    // a value written straight to GitHub is checked against this clone's ops.config.json first (#3795): a choice that
    // differs only in case is written as the choice, one not there is refused before anything is written. Not when
    // GH_REPO names another repository than origin's (another Project, whose choices are not this config's)
    const choose = async (fields: Record<string, string>): Promise<Record<string, string>> => {
      // no field named: nothing to check, and no config asked for (a plain create needs none)
      if (!Object.keys(fields).length) return fields;
      if (env.GH_REPO) {
        const origin = await repoName({ ...env, GH_REPO: undefined }, opts.cwd).catch(() => "");
        if ((await repoName(env, opts.cwd)).toLowerCase() !== origin.toLowerCase()) return fields;
      }
      const c = await config();
      return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, String(fieldChoice(c, name, value))]));
    };
    // what the Project's commands say on GitHub goes to stderr: stdout keeps the lines the app's answers give
    const note = (s: string) => io.err(s);
    if (direct && explicit !== undefined) throw new Refused("--workspace はアプリの Task の中だけ（BACKLOG_URL が無いので GitHub に直接つなぐ）");
    const githubRepo = async () => {
      const [owner, name] = (await repoName(env, opts.cwd)).split("/") as [string, string];
      return { owner, name };
    };
    // looked up once per command: only after a sync (`again`) is it read anew, for the time it says
    let looked: ReturnType<typeof findWorkspace> | undefined;
    const workspace = async (imported = true, again = false) => {
      if (again || !looked) looked = findWorkspace(api, env, { workspace: explicit, cwd: opts.cwd });
      return imported ? importedOnly(await looked) : (await looked).ws;
    };
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
        const search = take("--search");
        const labels = takeAll("--label");
        const state = take("--state") ?? "open";
        const kind = take("--type") ?? "issue";
        if (args.length || !/^(open|closed|all)$/.test(state) || !/^(issue|change|all)$/.test(kind)) throw new Refused("backlog list [--search <語>] [--label <l>]... [--state open|closed|all] [--type issue|change|all（既定 issue。change はローカルの変更）] [--fresh] [--json]");
        const filter: ListFilter = { search, labels, state: state as ListFilter["state"], kind: kind as ListFilter["kind"] };
        if (direct) {
          // GitHub's word search is wider than a part of the title: filtered again as the stored values are
          const repo = await githubRepo();
          const items = filterIssues(await listFromGithub(direct.gh, repo, await direct.project(), filter), filter).map((i) => ({ number: i.number, type: typeOf(i), state: i.state, status: i.status, title: i.title, labels: i.labels }));
          if (asJson) io.out(JSON.stringify({ repository: `${repo.owner}/${repo.name}`, source: "github", items }));
          else {
            io.out(`# ${repo.owner}/${repo.name}  GitHub から直接（アプリの保存値ではない）`);
            for (const i of items) io.out(listRow(i));
          }
          return 0;
        }
        let ws = await workspace(!fresh);
        if (fresh) await settle(ws), (ws = await workspace(true, true));
        const records = (await api("GET", `/records?workspaceId=${encodeURIComponent(ws.workspaceId)}`)) as StoredRecords;
        const items = filterIssues(records.issues, filter).map((i) => ({ number: i.number, type: typeOf(i), state: i.state, status: (i.fields?.Status as string | null | undefined) ?? null, title: i.title, labels: i.labels }));
        // what the last import could not read is kept as it was stored: shown, and said to be not current
        const unread = items.filter((i) => records.unread.includes(i.number)).map((i) => i.number);
        if (unread.length) io.err(`最後の取込みで読めていない Issue（保存値のまま。今の値ではない）: ${unread.map((n) => `#${n}`).join(", ")}（--fresh で取り込み直す）`);
        if (asJson) io.out(JSON.stringify({ ...ws, items, unread }));
        else {
          io.out(freshness(ws));
          for (const i of items) io.out(listRow(i));
        }
        return 0;
      }
      case "view": {
        const [ref, ...extra] = args;
        if (!ref || extra.length) throw new Refused("backlog view <issue> [--fresh] [--json]");
        if (direct) {
          const d = await viewFromGithub(direct.gh, await githubRepo(), await direct.project(), number(ref));
          io.out(asJson ? JSON.stringify(d) : formatDetail(d));
          return 0;
        }
        let ws = await workspace(!fresh);
        if (fresh) await settle(ws);
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
        const head = take("--head");
        const base = take("--base");
        if (!title || args.length || !head !== !base) throw new Refused("backlog create --title <t> [--body-file <f|->] [--label <l>]... [--milestone <m>] [--parent <n>] [--field <name>=<value>]... [--head <枝> --base <枝>]");
        if (direct && head) throw new Refused("--head / --base（ローカルの変更）はアプリの Task の中だけ（BACKLOG_URL が要る）");
        noSecrets(title, body, milestone, ...labels, ...Object.values(fields).map(String));
        if (direct) {
          if (Object.keys(fields).length) await config();
          const n = await createOnGithub(direct.gh, config, await githubRepo(), { title, body, labels, milestone, parent: parent ? number(parent) : null, fields: await choose(fields) }, note);
          io.out(`#${n} を作りました（GitHub）`);
          return 0;
        }
        const ws = await workspace();
        const r = (await api("POST", "", { workspaceId: ws.workspaceId, title, body: body ?? "", labels, milestone: milestone ?? null, parent: parent ? number(parent) : null, fields: Object.keys(fields).length ? fields : null, ...(head && base ? { change: { head, base } } : {}) })) as { localId: string; number?: number | null };
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
        const reasonArg = take("--reason");
        // the CLI's spelling → the API's value (#3146); only with a close
        const REASONS = { completed: "COMPLETED", "not-planned": "NOT_PLANNED" } as const;
        const reason = reasonArg !== undefined && Object.hasOwn(REASONS, reasonArg) ? REASONS[reasonArg as keyof typeof REASONS] : undefined;
        const milestone = has("--no-milestone") ? null : take("--milestone");
        const parent = has("--no-parent") ? null : take("--parent");
        if (!ref || args.length || (state !== undefined && !/^(open|closed)$/i.test(state)) || (reasonArg !== undefined && (!reason || state?.toLowerCase() !== "closed")))
          throw new Refused("backlog edit <issue> [--title <t>] [--body-file <f|->] [--add-label <l>]... [--remove-label <l>]... [--state open|closed] [--reason completed|not-planned（--state closed と一緒だけ）] [--milestone <m> | --no-milestone] [--parent <n> | --no-parent]");
        noSecrets(title, body, milestone ?? undefined, ...add);
        const input: Record<string, unknown> = {
          ...(title !== undefined && { title }),
          ...(body !== undefined && { body }),
          ...((add.length || remove.length) && { labels: { add, remove } }),
          ...(state !== undefined && { state: state.toUpperCase() }),
          ...(reason && { stateReason: reason }),
          ...(milestone !== undefined && { milestone }),
          ...(parent !== undefined && { parent: parent === null ? null : number(parent) }),
        };
        if (!Object.keys(input).length) throw new Refused("変えるものを 1 つ以上渡してください");
        if (direct) {
          await editOnGithub(direct.gh, await githubRepo(), number(ref), { title, body, add, remove, ...(state !== undefined && { state: state.toUpperCase() as "OPEN" | "CLOSED" }), ...(reason && { stateReason: reason }), ...(milestone !== undefined && { milestone }), ...(parent !== undefined && { parent: parent === null ? null : number(parent) }) });
          io.out(`#${number(ref)} を保存しました`);
          return 0;
        }
        return await edit(ref, input);
      }
      case "comment": {
        const [ref] = args.splice(0, 1);
        const body = await text(take("--body-file"));
        if (!ref || !body?.trim() || args.length) throw new Refused("backlog comment <issue> --body-file <f|->");
        noSecrets(body);
        if (direct) {
          await commentOnGithub(direct.gh, await githubRepo(), number(ref), body);
          io.out(`#${number(ref)} にコメントを保存しました`);
          return 0;
        }
        const ws = await workspace();
        await api("POST", `/${number(ref)}/comment`, { workspaceId: ws.workspaceId, text: body });
        io.out(`#${number(ref)} にコメントを保存しました`);
        return 0;
      }
      case "set": {
        const [ref, field, value, ...extra] = args;
        if (!ref || !field || value === undefined || extra.length) throw new Refused("backlog set <issue> <field> <value>");
        noSecrets(value);
        if (direct) {
          // an empty value empties the field (#3810): not a choice to check
          const chosen = value === "" ? value : (await choose({ [field]: value }))[field]!;
          await setField(direct.gh, await config(), number(ref), field, chosen, note);
          io.out(`#${number(ref)} を保存しました`);
          return 0;
        }
        // an empty value empties the field (#3810): the app sends a clear for null
        if (value === "") return await edit(ref, { fields: { [field]: null } });
        // GitHub's field type decides when it is sent (backlog-send.ts): a number only where the stored value is one
        const ws = await workspace();
        const d = (await api("GET", `/${encodeURIComponent(issueRef(ref))}?workspaceId=${encodeURIComponent(ws.workspaceId)}`)) as Detail;
        const numeric = typeof d.fields?.[field] === "number" && /^-?[0-9]+(\.[0-9]+)?$/.test(value);
        return await edit(ref, { fields: { [field]: numeric ? Number(value) : value } });
      }
      case "triage": {
        const [ref, area, kind, priority, ...tail] = args;
        // a repository without a Phase: "" in its place means none; <parent> and <status> follow
        if (!opts.phase && tail[0] === "" && tail.length > 2) tail.shift();
        const phase = opts.phase ? tail.shift() : undefined;
        const [parent, status, ...extra] = tail;
        if (!ref || !area || !kind || !priority || (opts.phase && !phase) || extra.length) throw new Refused(`backlog ${triageUsage(!!opts.phase)}`);
        noSecrets(area, kind, priority, phase, status);
        if (direct) {
          const c = await choose({ Area: area, Kind: kind, Priority: priority, ...(phase !== undefined && { Phase: phase }), Status: status || "Backlog" });
          await triage(direct.gh, await config(), number(ref), { area: c.Area!, kind: c.Kind!, priority: c.Priority!, ...(phase !== undefined && { phase: c.Phase! }), ...(parent ? { parent: number(parent) } : {}), status: c.Status! }, note);
          io.out(`#${number(ref)} を保存しました`);
          return 0;
        }
        const fields: Record<string, string> = { Area: area, Kind: kind, Priority: priority, ...(phase !== undefined && { Phase: phase }), Status: status || "Backlog" };
        return await edit(ref, { project: true, fields, ...(parent ? { parent: number(parent) } : {}) });
      }
      case "retry": {
        // a send GitHub refused waits held, and the Issue's edits after it with it (#2885): each failed one goes back
        const [ref, ...extra] = args;
        if (!ref || extra.length) throw new Refused("backlog retry <issue>");
        if (direct) throw new Refused("retry はアプリの Task の中だけ（BACKLOG_URL が無いので送り直すものがありません）");
        const ws = await workspace();
        const d = (await api("GET", `/${encodeURIComponent(issueRef(ref))}?workspaceId=${encodeURIComponent(ws.workspaceId)}`)) as Detail;
        const failed = (d.held ?? []).filter((h) => h.status === "failed");
        if (!failed.length) throw new Refused(`#${issueRef(ref)} に失敗で保留中の編集はありません`);
        let sent = 0;
        for (const h of failed) {
          try {
            await api("PATCH", `/${encodeURIComponent(issueRef(ref))}`, { workspaceId: ws.workspaceId, retry: { operation: h.operation } });
          } catch (e) {
            // the ones put back before stay put back: say so with why the rest stopped
            if (sent) io.out(`#${issueRef(ref)} の失敗した編集 ${failed.length} 件のうち ${sent} 件を送り直します。残りは止まりました`);
            throw e;
          }
          sent++;
        }
        io.out(`#${issueRef(ref)} の失敗した編集 ${failed.length} 件を送り直します`);
        return 0;
      }
      case "withdraw": {
        // a held post or edit taken back (#3804): nothing written to GitHub, the Issue's edits after it go on
        const reason = take("--reason") ?? "エージェントが中身を確かめて取り下げ";
        const [ref, ...extra] = args;
        if (!ref || extra.length || !reason.trim()) throw new Refused("backlog withdraw <issue> [--reason <文>]");
        noSecrets(reason);
        if (direct) throw new Refused("withdraw はアプリの Task の中だけ（BACKLOG_URL が無いので取り下げるものがありません）");
        const ws = await workspace();
        const d = (await api("GET", `/${encodeURIComponent(issueRef(ref))}?workspaceId=${encodeURIComponent(ws.workspaceId)}`)) as Detail;
        // a create last: the Issue's operations after it are taken back first
        const held = (d.held ?? []).filter((h) => h.status === "unknown" || h.status === "failed").sort((a, b) => Number(a.kind === "create") - Number(b.kind === "create"));
        if (!held.length) throw new Refused(`#${issueRef(ref)} に結果不明・失敗で保留中の編集はありません`);
        let done = 0;
        for (const h of held) {
          try {
            await api("PATCH", `/${encodeURIComponent(issueRef(ref))}`, { workspaceId: ws.workspaceId, withdraw: { operation: h.operation, reason } });
          } catch (e) {
            if (done) io.out(`#${issueRef(ref)} の保留中の編集 ${held.length} 件のうち ${done} 件を取り下げました。残りは止まりました`);
            throw e;
          }
          done++;
        }
        io.out(`#${issueRef(ref)} の保留中の編集 ${held.length} 件を取り下げました（GitHub には何も書いていません）`);
        return 0;
      }
      default:
        throw new Refused(`backlog のコマンドではありません: ${sub ?? "(なし)"}\n${BACKLOG_USAGE}`);
    }
  } catch (e) {
    io.err((e as Error).message);
    return e instanceof Refused || e instanceof UsageError ? 1 : 2;
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
  issues: Array<{ number: number; title: string; url: string; state: "OPEN" | "CLOSED"; stateReason: string | null; body: string; labels: string[]; parent: number | null; subIssues: number[]; createdAt: string; updatedAt: string; closedAt: string | null; fields: Record<string, string | number | null> | null; change?: NonNullable<Detail["issue"]["change"]> }>;
  /** The stored Issues' comments as shown (with those not sent yet), oldest first. */
  comments: Array<{ issue: number; body: string; createdAt: string }>;
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
    const looked = await findWorkspace(api, opts.repo ? { ...env, GH_REPO: opts.repo } : env, { cwd: opts.cwd });
    const ws = opts.fresh ? looked.ws : importedOnly(looked);
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

/**
 * Whether the app syncs the repository (`repo`, else as `readRecords`) (#3069): its workspace, or null when the list does
 * not have it. A workspace the app gave (BACKLOG_WORKSPACE) that is not listed, and an app that cannot be asked, throw
 * BacklogUnknown: neither means the app does not know the repository.
 */
export async function appSync(env: Record<string, string | undefined>, opts: { repo?: string; fetch?: Fetch } = {}): Promise<{ workspaceId: string } | null> {
  try {
    const { ws, wanted, explicit } = await lookWorkspace(client(env, opts.fetch ?? fetch), opts.repo ? { ...env, GH_REPO: opts.repo } : env, {});
    if (!ws && explicit) throw new Unknown(wanted);
    return ws ? { workspaceId: ws.workspaceId } : null;
  } catch (e) {
    throw e instanceof Unknown ? e : new Unknown((e as Error).message);
  }
}

/**
 * The repository's row of the app's workspaces (`GET /syncs`: each one's sync state, no records read); throws when the app
 * does not have it. A workspace the app gave (BACKLOG_WORKSPACE) that is not listed is the same.
 */
async function findWorkspace(api: ReturnType<typeof client>, env: Record<string, string | undefined>, opts: { workspace?: string; cwd?: string }): Promise<Looked> {
  const looked = await lookWorkspace(api, env, opts);
  if (!looked.ws) throw new Unknown(looked.wanted);
  return { ...looked, ws: looked.ws };
}

interface Looked { ws: Sync; wanted: string; explicit: string | undefined }

/** The repository's row of the app's list, if it has one; `wanted`: the line that says it has not. */
async function lookWorkspace(api: ReturnType<typeof client>, env: Record<string, string | undefined>, opts: { workspace?: string; cwd?: string }) {
  // a Task on a workspace whose backlog is kept in the app (#2265) is given its id: no repository to read it by
  const explicit = opts.workspace ?? (env.GH_REPO ? undefined : env.BACKLOG_WORKSPACE || undefined);
  const syncs = await listSyncs(api);
  const repo = explicit ? null : await repoName(env, opts.cwd);
  const ws = syncs.find((s) => (explicit ? s.workspaceId === explicit : s.repository?.toLowerCase() === repo!.toLowerCase()));
  return { ws, explicit, wanted: explicit ? `workspace ${explicit} がアプリにありません` : `${repo} のバックログはアプリに取り込まれていません（workspace の登録か --workspace <id>）` };
}

/** The app's workspaces with their sync state: `GET /syncs`, else (404) the old list route, once. */
async function listSyncs(api: ReturnType<typeof client>): Promise<Sync[]> {
  try {
    return ((await api("GET", "/syncs")) as { syncs: Sync[] }).syncs;
  } catch (e) {
    // for a daemon older than the kit, until it is promoted (PBI #3362): the old route's `syncs` rows are the same
    if (e instanceof Refused && e.message.startsWith("backlog: 404")) return ((await api("GET", "")) as { syncs: Sync[] }).syncs;
    throw e;
  }
}

/** One never imported is unknown (exit 2), never "no items" or "not stored". */
function importedOnly({ ws }: Looked): Sync {
  if (ws.syncedAt === null) throw new Unknown(`${ws.repository ?? ws.workspaceId} はまだ取り込まれていません（同期 ${ws.sync.state}${ws.sync.reason ? `、${ws.sync.reason}` : ""}）。空の一覧や「保存されていない」として扱わない`);
  return ws;
}

/** A connection the sandbox refused (EPERM / EACCES), not an app that is down. */
function isSandboxRefusal(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  const message = (e as Error).message ?? "";
  return code === "EPERM" || code === "EACCES" || /^(EPERM|EACCES)\b/.test(message);
}

/** Calls the app's backlog API: the parsed answer, or Refused (4xx) / Unknown (no app, 5xx, 424, not imported = 409 on a read). */
export function client(env: Record<string, string | undefined>, f: Fetch) {
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
      const message = (e as Error).message;
      // a sandbox closing loopback (Codex's Auto, #2725): an approved rerun reaches the app, so say so instead of asking the user
      if (isSandboxRefusal(e)) throw new Unknown(`backlog: アプリに届きません（${message}）。サンドボックスがこのホストのアプリ（BACKLOG_URL）への接続を止めています。ランナーの承認つきの実行で同じコマンドを 1 回やり直してください（Codex は承認を求める実行。利用者に聞かない）。判定できません`);
      throw new Unknown(`backlog: アプリに届きません（${message}）。判定できません`);
    }
    const answer = await res.json().catch(() => null);
    if (res.ok) return answer;
    const message = `backlog: ${res.status} ${(answer as { error?: string } | null)?.error ?? res.statusText}`;
    // 409 on a read / a fresh, and 424, are a backlog not imported or not readable now: unknown, never "none"
    if (res.status >= 500 || res.status === 424 || res.status === 401 || (res.status === 409 && (method === "GET" || path === "/sync"))) throw new Unknown(message, res.status);
    throw new Refused(message);
  };
}

/**
 * The GitHub repositories the app syncs, with their workspace (GET /api/backlog/syncs, #3073): what the gh
 * guard stops a direct backlog write to, besides the Task's own. Null when the app cannot be asked (no BACKLOG_URL,
 * not reached, 4xx / 5xx, no answer in 5 seconds): the guard then judges the workspace only, and does not hold gh up
 * for as long as an `ops-kit backlog` command waits.
 */
export async function syncedRepositories(env: Record<string, string | undefined>, f: Fetch = fetch): Promise<Array<{ repository: string; workspaceId: string }> | null> {
  try {
    const list = { syncs: await listSyncs(client(env, (url, init) => f(url, { ...init, signal: AbortSignal.timeout(5_000) }))) };
    return list.syncs.flatMap((s) => (s.backlog === "github" && s.repository !== null ? [{ repository: s.repository, workspaceId: s.workspaceId }] : []));
  } catch {
    return null;
  }
}

/** The repository the backlog commands act on: GH_REPO, else origin; GitHub is never asked for it. */
export async function repoName(env: Record<string, string | undefined>, cwd?: string): Promise<string> {
  const noGh = { run: async () => { throw new Unknown("リポジトリが分かりません（GH_REPO を設定するか、origin のあるディレクトリで実行するか、--workspace <id>）"); } } as unknown as Parameters<typeof repoOf>[0];
  const r = await repoOf(noGh, env, cwd);
  return `${r.owner}/${r.name}`;
}

const jst = (at: number | null) => (at === null ? "未取得" : new Date(at).toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }) + " JST");

function freshness(ws: Sync): string {
  return `# ${ws.repository ?? "?"}  最終取得 ${jst(ws.syncedAt)}  同期 ${ws.sync.state}${ws.sync.reason ? `（${ws.sync.reason}）` : ""}  送信待ち ${ws.sync.pendingCount}${ws.syncing ? "  取込み中" : ""}`;
}

/** One Issue as `backlog view` shows it: the app's stored one, or GitHub's own without BACKLOG_URL (`sync.state` "github"). */
export interface Detail {
  /** The workspace the app answered from; absent in GitHub's own (without BACKLOG_URL). */
  workspaceId?: string;
  issue: { number: number; title: string; state: string; stateReason?: string | null; labels: string[]; milestone: string | null; parent: number | null; subIssues: number[]; body: string; url: string; change?: { head: string; base: string; mergeCommit: string | null; mergedAt: string | null; reviewedHead: string | null } };
  /** A local change's branch tips now (#2485); absent / null otherwise. */
  changeRefs?: { head: string | null; base: string | null } | null;
  comments: Array<{ id: string; body: string; createdAt: string }>;
  fields: Record<string, string | number | null> | null;
  fetchedAt: number | null;
  localId: string | null;
  pending: number;
  /** The edits held, not sent (#887, #2885); none in GitHub's own (without BACKLOG_URL). */
  held?: Array<{ operation: string; kind: "create" | "set" | "comment"; field: string | null; status: "conflict" | "failed" | "unknown"; reason: string | null }>;
  sync: { state: string; reason: string | null; lastSuccessfulSync: number | null };
}

/** A close that was not a completion (#3146); completed and none read as before. */
const REASON = { NOT_PLANNED: " not planned", DUPLICATE: " duplicate" } as const;
const HELD = { conflict: "競合", failed: "失敗", unknown: "結果不明" } as const;
const HELD_KIND = { create: "新規作成", comment: "コメント" } as const;

export function formatDetail(d: Detail): string {
  const i = d.issue;
  const at = d.sync.lastSuccessfulSync === null ? "未取得" : new Date(d.sync.lastSuccessfulSync).toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }) + " JST";
  return [
    `#${i.number || d.localId} ${i.title} [${i.state}${REASON[i.stateReason as keyof typeof REASON] ?? ""}]`,
    ...(i.change ? [changeLine(i.change, d.changeRefs ?? null)] : []),
    `labels: ${i.labels.join(", ") || "-"}  milestone: ${i.milestone ?? "-"}  parent: ${i.parent ? `#${i.parent}` : "-"}`,
    `fields: ${d.fields ? Object.entries(d.fields).map(([k, v]) => `${k}=${v ?? "-"}`).join(", ") : "-"}`,
    `最終取得 ${at}  同期 ${d.sync.state}${d.sync.reason ? `（${d.sync.reason}）` : ""}  送信待ち ${d.pending}`,
    ...(d.held ?? []).map((h) => `保留: ${h.kind === "set" ? h.field : HELD_KIND[h.kind]} ${HELD[h.status]}${h.reason ? `（${h.reason}）` : ""}`),
    "",
    i.body,
    ...d.comments.flatMap((c) => ["", `----- ${c.createdAt}`, c.body]),
  ].join("\n");
}

/** A local change's line (#2485): its branches and their tips now, or the commit it was merged as. */
function changeLine(c: NonNullable<Detail["issue"]["change"]>, refs: Detail["changeRefs"]): string {
  const sha = (x: string | null | undefined) => (x ? x.slice(0, 7) : "なし");
  const tips = c.mergeCommit ? `MERGED ${c.mergeCommit.slice(0, 7)} (reviewed ${sha(c.reviewedHead)})` : `head ${sha(refs?.head)} base ${sha(refs?.base)}`;
  return `変更: ${c.head} → ${c.base}  ${tips}`;
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
