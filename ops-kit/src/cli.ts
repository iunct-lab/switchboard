#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKLOG_USAGE, readRecords, runBacklog } from "./backlog-client.ts";
import { bootstrap } from "./bootstrap.ts";
import { defaultConfig, findConfig, loadConfig, loadPublicSync, publicCopyRefusal, resolveProject, type OpsConfig } from "./config.ts";
import { realGh, repoOf, type GhClient } from "./gh.ts";
import { exportCopy } from "./export-copy.ts";
import { resolveReviewThread } from "./forge-github.ts";
import { forgeTargetOf, originOf } from "./forge.ts";
import { createGitlabMr, gitlabMrDiscussions, resolveGitlabDiscussion, runGlab, startGitlabDiscussion, viewGitlabMr, type Sh } from "./forge-gitlab.ts";
import { formatLint, lint } from "./lint.ts";
import { pullMain } from "./pull-main.ts";
import { check, spawnRun, sync, withStaleNote } from "./public-sync.ts";
import { checkRequestBody, createRequest } from "./request.ts";
import { scanIssues } from "./scan.ts";
import { findSecrets, hostAws } from "./secrets.ts";
import { setField, UsageError } from "./set.ts";
import { parseLabels, syncLabels } from "./labels.ts";
import { reconcileProject, triage } from "./triage.ts";

const USAGE = `使い方: bun ops-kit/src/cli.ts <command> [--config <ops.config.json>] ...

  set <issue> <field> <value>
      Issue 1 件の Project フィールドを 1 つ設定する（単一選択 / 数値 / テキスト / 日付）。Project に無ければ追加する
      例: set 16 Status Ready / set 16 "Story Points" 5
      BACKLOG_URL がある（アプリの Task の中）なら GitHub に書かずアプリに保存する（backlog set / backlog triage と同じ。triage も）
  triage <issue> <area> <kind> <priority> [<phase>] [<parent>] [<status>]
      Issue を Project に入れ、Area / Kind / Priority /（Phase）/ Status と親（Task の親 PBI）を設定する
      <phase> は設定に fields.phase があるときだけ渡す。<parent> を飛ばすなら "" を渡す。<status> の既定は Backlog
  reconcile-project [--dry-run]
      open の Issue / PR のうち Project に無いものだけを追加する（フィールドは付けない。既にある item は触らない）。
      Actions の project-autoadd が動かないときの代わり。--dry-run は追加するものを出すだけ

  lint [--no-project] [--fresh]
      open の PBI / Task / 要望が記載規約（設定の sections と storyPoints）を満たすか検査する。1 つのクエリ（100 件ずつ）で読む
      BACKLOG_URL がある（アプリの Task の中）なら GitHub ではなくアプリの保存値を読む（Project はアプリがその workspace に読むもの）。
      --fresh: その前にアプリに送信と取込みをさせる。アプリが GitHub に届かなければ保存値を検査し「GitHub 未同期」を出す。
      アプリに届かない・未取得は 2（gh には切り替えない）
      exit 0 = 合格、1 = 違反あり、2 = 検査できなかった（取得の失敗、形の違い、Project が見つからない）
      --no-project: Project（Story Points / Status）を見ない。gh に project の権限が無い環境用
      GitHub 連携の無い workspace（BACKLOG_WORKSPACE があり GH_REPO が無い）で ops.config.json が無ければ、雛形 ops-kit/template/ops.config.json の値で検査する

  bootstrap <title> [--dry-run]
      Project を用意する（設定の Project、無ければ同じ題の Project、それも無ければ作る）。設定の Area / Kind / Priority /
      （Phase）の単一選択と数値の Story Points のうち、無いフィールドを作る。何度実行してもよい
      Status の選択肢は、この実行で作った Project にだけ Backlog / Ready / In progress / In review / Done を入れる（既存の
      Project の Status を書き換えると全 item の Status が消えるので、足りない選択肢を出すだけ）。ビューは UI で作る
  request <title> <body-file>
      要望 Issue（type:request）を本文のファイルから作り、Project に Status Backlog で入れる。設定の sections.request の
      節が本文に無ければ作らない。BACKLOG_URL がある（アプリの Task の中）なら gh で作らず backlog create でアプリに保存する

${BACKLOG_USAGE}

  pull-main
      main の作業ツリー（git worktree list の最初）を upstream に fast-forward する。fast-forward できない・未コミットの変更が取り込むファイルと重なる・detached・upstream 無しは何も変えず理由を出して exit 1、fetch できない・Git でないは exit 2。設定ファイルは要らない
  sync-labels [<file>] [--dry-run]
      リポジトリのラベルを <file>（既定 .github/labels.yml）に合わせる。無いものを作り、色・説明が違うものを直す。
      <file> に無いラベルは消さない。--dry-run は変えるものを出すだけ。設定ファイルは要らない
  scan-text <file|->
      文（ファイル、- は標準入力）に認証に使える値（device code、承認 URL、トークン、鍵、アカウント ID、ホストの AWS の設定のプロファイル名・SSO のセッション名など）が無いか検査する
      出力は <file>:<行>: <種類>。値は出さない。exit 0 = 無い、1 = ある、2 = 読めなかった。設定ファイルは要らない
  scan-issues [<owner/name>] [--since <ISO 8601>] [--recheck <URL>]...
      リポジトリの Issue・PR の題と本文、コメント、PR のレビューコメントとレビュー本文を全部、同じ検査に通す。出力は <URL>: <種類>（<行> 行目）と、最後に hits: <当たり> / scanned: <読んだ文の数>
      --since はその時刻より後に更新されたものだけを読む。--recheck は前回の当たりの場所（URL）を差分の外でも読み直す（何回でも）
      exit 0 = 無い、1 = ある、2 = 検査できなかった（取得の失敗）。<owner/name> を省くと GH_REPO、無ければ origin。設定ファイルは要らない

  public-sync [--source <ref>] [--dry-run] [--adopted] [--target-url <url>]
      main のツリーだけを（履歴なしで）公開リポジトリへ送る。公開先・送るもの・外すファイル・書き換えるファイルは設定の publicSync だけを読む
      設定は送るツリー（--source）のものを読む。初回は main へ根のコミット、2 回目からは sync/<タグ> の PR を開いて自分でマージし、題が版なら Release を付ける。
      Private のリポジトリ名・ホームパス・個人のメールアドレス・秘密の形の値（変わる行）があれば送らない。前回より古い --source は送らない。--dry-run は送らず結果だけ出す
      --adopted: 公開側だけの変更を Private に取り込み済みとして、置き換えて送る。--source の既定は origin/main
      exit 0 = 送った / 送るものが無い / dry-run、1 = 止まった（理由は stderr）、2 = 使い方の誤り
  public-sync --check [--source <ref>]
      送らずに、公開に出すツリーを同期と同じに組み立てて、Private のリポジトリ名・ホームパス・個人のメールアドレス・秘密の形の値（全ファイル。ホストの AWS のプロファイル名・アカウントは、ホストの設定があるときだけ）を検査する（CI 用。公開側に触らない）。--source の既定は HEAD
      exit 0 = 無い（origin が publicSync.target の公開側の写しでは検査しない）、1 = ある、2 = 使い方の誤り

  mr create --source <branch> --target <branch> --title <t> --body-file <f|->
  mr view <iid> | mr discussions <iid>
  mr note <iid> --body-file <f|-> [--path <file> --line <n>]
  mr resolve <iid> <discussion id>...
      ops.config.json の forge が gitlab のリポジトリで、GitLab の標準の MR・discussion を glab で使う（ブランチは git で push しておく）。
      view / discussions は JSON を出す。note は --path / --line があれば差分のその行に discussion を始める。本文に認証に使える値があれば送らない。
      github のリポジトリでは何もせず exit 2（PR は gh を使う）。exit 0 = できた、1 = GitLab が断った・resolve にならなかった、2 = 使い方の誤り
  pr resolve-thread <thread id>...
      PR のレビュースレッドを resolve する（GraphQL の resolveReviewThread だけ。id は PRRT_ で始まるもの）。
      id の形が違えば何もせず exit 1。resolve にならなかったスレッドがあれば exit 1。設定ファイルは要らない
  export-copy <dest> --words-file <file>
      キットを読めないリポジトリ（公開リポジトリなど）が同梱するコピーを <dest> に作る（テストを除くコード、skills、bin、
      README。<dest>/KIT_VERSION に元のコミットと日時）。--words-file で指定した固有語のリスト（キットの外）の語が 1 件でもあればコピーを消して exit 1
      <dest> は無い・空・前のコピー（KIT_VERSION がある）のどれか。前のコピーは置き換える。設定ファイルは要らない

--config を省くと、今のディレクトリから上へ ops.config.json を探す。
Project URL は環境変数 <envPrefix>_PROJECT_URL、設定の省略可能な projectUrl、同名のリポジトリ変数（gh variable get）の順で読む（持ち主もその URL から）。<envPrefix>_PROJECT_OWNER は持ち主だけを変える。リポジトリは GH_REPO、無ければ origin。

設定ファイルの例（ops.config.json）:
`;

/**
 * The repository `public-sync --check` looks for: GH_REPO, else origin. Not gh's chosen remote nor gh itself (as `repoOf`
 * reads): a default pointed at the public copy would make the check skip a private tree.
 */
function checkedRepo(env: Record<string, string | undefined>): string {
  const fromEnv = env.GH_REPO?.replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "").split("/").slice(-2);
  if (fromEnv?.length === 2) return fromEnv.join("/");
  const url = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
  const m = /github\.com[:/]([^/]+)\/([^/\s]+?)(\.git)?\/?$/.exec(url);
  if (!m) throw new Error("リポジトリが分かりません（GH_REPO を設定するか、origin が GitHub の clone で実行してください）");
  return `${m[1]}/${m[2]}`;
}

export async function main(argv: string[], gh: GhClient = realGh(), out: (s: string) => void = console.log, err: (s: string) => void = console.error, sleep: (ms: number) => Promise<void> = Bun.sleep, env: Record<string, string | undefined> = process.env, glab: Sh = runGlab): Promise<number> {
  const args = [...argv];
  let configPath: string | undefined;
  const at = args.indexOf("--config");
  if (at >= 0) {
    configPath = args[at + 1];
    if (!configPath) return usage(err, "--config にパスを渡してください");
    args.splice(at, 2);
  }
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    out(USAGE + readFileSync(join(import.meta.dir, "../fixtures/config-with-phase.json"), "utf8"));
    return command ? 0 : 1;
  }
  if (command === "export-copy") {
    const [dest, flag, wordsFile, ...extra] = rest;
    if (!dest || (flag !== undefined && (flag !== "--words-file" || !wordsFile)) || extra.length) return usage(err, "export-copy <dest> --words-file <file>");
    try {
      const r = exportCopy({ dest, wordsFile });
      out(`${r.dest} に書きました\n${r.version.trimEnd()}`);
      return 0;
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
  }
  // in the app's Task, gh-guard refuses `gh issue create`: the request is stored in the app like backlog create, and the
  // line callers read (要望を作成: #N, scripts/file-request.ts) is kept when the app numbers it at once (a backlog kept
  // in the app only; one sent to GitHub has no number until then)
  if (command === "request" && env.BACKLOG_URL) {
    const [title, bodyFile, ...extra] = rest;
    if (!title || !bodyFile || extra.length) return usage(err, "request <title> <body-file>");
    try {
      checkRequestBody(loadConfig(configPath), bodyFile);
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
    const created = (s: string) => {
      const m = /^#(\d+) を作りました/.exec(s);
      out(m ? `>> 要望を作成: #${m[1]}（アプリに保存）` : s);
    };
    return runBacklog(["create", "--title", title, "--body-file", bodyFile, "--label", "type:request", "--field", "Status=Backlog"], env, { out: created, err });
  }
  // in the app's Task, set / triage are stored in the app like backlog set / triage (#2694): written to GitHub here, the
  // next edit stored in the app starts from the value before it and is sent as a conflict
  if (command === "backlog" || ((command === "set" || command === "triage") && env.BACKLOG_URL)) {
    // the configuration only tells whether triage takes a phase; none is needed to read or edit
    let phase = false;
    try {
      phase = !!loadConfig(configPath).fields.phase;
    } catch {
      /* no ops.config.json: triage takes no phase */
    }
    return runBacklog(command === "backlog" ? rest : args, env, { out, err }, { phase });
  }
  if (command === "pull-main") {
    if (rest.length) return usage(err, "pull-main", 2);
    return pullMain(process.cwd(), out, err);
  }
  if (command === "public-sync") {
    const flags = new Set(["--dry-run", "--adopted", "--check"]);
    const valued = new Set(["--source", "--target-url"]);
    const given: Record<string, string> = {};
    const on = new Set<string>();
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (flags.has(a)) on.add(a);
      else if (valued.has(a) && rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("--")) given[a] = rest[++i]!;
      else return usage(err, "public-sync [--source <ref>] [--dry-run] [--adopted] [--target-url <url>] | public-sync --check [--source <ref>]", 2);
    }
    if (on.has("--check") && (on.size > 1 || given["--target-url"])) return usage(err, "public-sync --check [--source <ref>]", 2);
    if (on.has("--check")) {
      try {
        const cfg = loadPublicSync(configPath, undefined, given["--source"] ?? "HEAD");
        const repo = checkedRepo(env);
        // the public copy's own CI: its origin is publicSync.target, and there is no private name to look for
        if (publicCopyRefusal(repo)) {
          out(`public check: skipped (${repo} is publicSync.target, the public copy)`);
          return 0;
        }
        out(check({ host: hostAws(), privateRepo: repo, target: cfg.target, include: cfg.include, exclude: cfg.exclude, rewrite: cfg.rewrite, source: given["--source"] }, spawnRun));
        return 0;
      } catch (e) {
        err((e as Error).message);
        return 1;
      }
    }
    let privateRepo = "";
    try {
      const cfg = loadPublicSync(configPath, undefined, given["--source"] ?? "origin/main");
      const r = await repoOf(gh);
      privateRepo = `${r.owner}/${r.name}`;
      out(sync({ host: hostAws(), privateRepo, target: cfg.target, versioning: cfg.versioning, include: cfg.include, exclude: cfg.exclude, rewrite: cfg.rewrite, serviceUsers: cfg.serviceUsers, source: given["--source"], targetUrl: given["--target-url"], dryRun: on.has("--dry-run"), adopted: on.has("--adopted") }, spawnRun));
      return 0;
    } catch (e) {
      const message = (e as Error).message;
      // a --source tag stopped by the tree check: whether origin/main, by its own publicSync, has the hits fixed
      const main = () => ({ ...loadPublicSync(configPath, undefined, "origin/main"), privateRepo });
      err(given["--source"] && privateRepo ? withStaleNote(message, main, spawnRun) : message);
      return 1;
    }
  }
  if (command === "sync-labels") {
    const dryRun = rest.includes("--dry-run");
    const files = rest.filter((a) => a !== "--dry-run");
    if (files.length > 1 || files[0]?.startsWith("--")) return usage(err, "sync-labels [<file>] [--dry-run]", 2);
    try {
      const want = parseLabels(readFileSync(files[0] ?? ".github/labels.yml", "utf8"));
      const r = await repoOf(gh);
      await syncLabels(gh, `${r.owner}/${r.name}`, want, { dryRun }, out);
      return 0;
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
  }
  if (command === "mr") return mr(rest, glab, out, err);
  if (command === "pr") {
    const [sub, ...ids] = rest;
    if (sub !== "resolve-thread" || ids.length === 0) return usage(err, "pr resolve-thread <thread id>...");
    const bad = ids.filter((id) => !/^PRRT_[\w-]+$/.test(id));
    if (bad.length) return usage(err, `レビュースレッドの id ではありません（PRRT_ で始まるもの）: ${bad.join(" ")}`);
    let failed = 0;
    for (const id of ids) {
      try {
        await resolveReviewThread(gh, id);
        out(`${id} resolved`);
      } catch (e) {
        err(`${id}: ${(e as Error).message}`);
        failed++;
      }
    }
    return failed ? 1 : 0;
  }
  // The two checks read no configuration: they run in any directory, with or without an ops.config.json
  if (command === "scan-text" || command === "scan-issues") {
    try {
      if (command === "scan-text") {
        const [file, ...extra] = rest;
        if (!file || extra.length) return usage(err, "scan-text <file|->", 2);
        const hits = findSecrets(file === "-" ? await Bun.stdin.text() : readFileSync(file, "utf8"), hostAws());
        for (const h of hits) out(`${file}:${h.line}: ${h.kind}`);
        return hits.length > 0 ? 1 : 0;
      }
      const SCAN_USAGE = "scan-issues [<owner/name>] [--since <ISO 8601>] [--recheck <URL>]...";
      const positional: string[] = [];
      const recheck: string[] = [];
      let since: string | undefined;
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i]!;
        if (a === "--since" || a === "--recheck") {
          const v = rest[++i];
          if (v === undefined) return usage(err, SCAN_USAGE, 2);
          if (a === "--since") since = v;
          else recheck.push(v);
        } else positional.push(a);
      }
      const [named, ...extra] = positional;
      if (extra.length || (named !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(named))) return usage(err, SCAN_USAGE, 2);
      if (since !== undefined && Number.isNaN(Date.parse(since))) return usage(err, SCAN_USAGE, 2);
      let repo = named;
      if (repo === undefined) {
        const r = await repoOf(gh);
        repo = `${r.owner}/${r.name}`;
      }
      if (recheck.some((u) => !u.startsWith(`https://github.com/${repo}/`))) return usage(err, SCAN_USAGE, 2);
      const { hits, scanned } = await scanIssues(gh, repo, sleep, hostAws(), { since, recheck });
      for (const h of hits) out(`${h.url}: ${h.kind}（${h.line} 行目）`);
      out(`hits: ${hits.length} / scanned: ${scanned}`);
      return hits.length > 0 ? 1 : 0;
    } catch (e) {
      err((e as Error).message);
      return 2;
    }
  }
  let cfg: OpsConfig;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    // a workspace kept in the app without GitHub (#2361) is linted with the kit's template when it has no file of its own
    if (command === "lint" && !configPath && env.BACKLOG_URL && env.BACKLOG_WORKSPACE && !env.GH_REPO && !hasConfig()) {
      err("ops.config.json が無いので既定の選択肢（ops-kit/template/ops.config.json）で検査");
      cfg = defaultConfig();
    } else {
      err((e as Error).message);
      return command === "lint" ? 2 : 1;
    }
  }
  try {
    const stored = command === "lint" && !!env.BACKLOG_URL;
    if (["set", "triage", "reconcile-project", "bootstrap", "request"].includes(command) || (command === "lint" && !stored && !rest.includes("--no-project"))) cfg = await resolveProject(cfg, gh);
    switch (command) {
      case "set": {
        const [issue, field, value] = rest;
        if (!issue || !field || value === undefined || rest.length !== 3) return usage(err, "set <issue> <field> <value>");
        await setField(gh, cfg, issueNumber(issue), field, value, out);
        return 0;
      }
      case "triage": {
        const [issue, area, kind, priority, ...tail] = rest;
        const phase = cfg.fields.phase ? tail.shift() : undefined;
        const [parent, status, ...extra] = tail;
        if (!issue || !area || !kind || !priority || (cfg.fields.phase && !phase) || extra.length) {
          return usage(err, `triage <issue> <area> <kind> <priority> ${cfg.fields.phase ? "<phase> " : ""}[<parent>] [<status>]`);
        }
        await triage(gh, cfg, issueNumber(issue), { area, kind, priority, phase, parent: parent ? issueNumber(parent) : undefined, status: status || undefined }, out);
        return 0;
      }
      case "reconcile-project": {
        if (rest.some((a) => a !== "--dry-run")) return usage(err, "reconcile-project [--dry-run]");
        await reconcileProject(gh, cfg, { dryRun: rest.includes("--dry-run") }, out);
        return 0;
      }
      case "lint": {
        if (rest.some((a) => a !== "--no-project" && a !== "--fresh") || new Set(rest).size !== rest.length) return usage(err, "lint [--no-project] [--fresh]", 2);
        const records = stored ? await readRecords(env, { fresh: rest.includes("--fresh") }) : undefined;
        if (records) err(`アプリの保存値を検査（${records.repository}、最終取得 ${new Date(records.fetchedAt).toISOString()}${rest.includes("--fresh") && !records.unsynced ? "、取込み済み" : ""}）`);
        if (records?.unsynced) err(records.unsynced);
        const { violations } = await lint(gh, cfg, { withProject: !rest.includes("--no-project"), records });
        for (const line of formatLint(violations)) out(line);
        return violations.length > 0 ? 1 : 0;
      }
      case "bootstrap": {
        const dryRun = rest.includes("--dry-run");
        const words = rest.filter((a) => a !== "--dry-run");
        if (words.length !== 1 || !words[0]) return usage(err, "bootstrap <title> [--dry-run]");
        await bootstrap(gh, cfg, { title: words[0], dryRun }, out);
        return 0;
      }
      case "request": {
        const [title, bodyFile, ...extra] = rest;
        if (!title || !bodyFile || extra.length) return usage(err, "request <title> <body-file>");
        await createRequest(gh, cfg, { title, bodyFile }, out);
        return 0;
      }
      default:
        return usage(err, `知らないコマンドです: ${command}`);
    }
  } catch (e) {
    err((e as Error).message);
    // lint: anything but a finished check is "could not check", never a pass or a violation count
    return command === "lint" ? 2 : 1;
  }
}

function hasConfig(): boolean {
  try {
    findConfig(undefined);
    return true;
  } catch {
    return false;
  }
}

function issueNumber(s: string): number {
  if (!/^#?[0-9]+$/.test(s)) throw new UsageError(`Issue 番号ではありません: ${s}`);
  return Number(s.replace(/^#/, ""));
}

/** `mr …` (#923): GitLab's MR and discussions through glab, on the checkout's GitLab project. */
async function mr(rest: string[], glab: Sh, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const [sub, ...args] = rest;
  const flag = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args.splice(i, 2)[1] : undefined;
  };
  const text = (f: string | undefined) => (f === "-" ? Bun.stdin.text() : f ? Bun.file(f).text() : Promise.resolve(undefined));
  const usageMr = (m: string) => usage(err, m, 2);
  let target;
  try {
    target = forgeTargetOf(process.cwd(), originOf(process.cwd()));
  } catch (e) {
    return usageMr((e as Error).message);
  }
  if (target.service !== "gitlab") return usageMr(`このリポジトリは ${target.service} です。PR は gh を使ってください`);
  try {
    if (sub === "create") {
      const [source, into, title, body] = [flag("source"), flag("target"), flag("title"), await text(flag("body-file"))];
      if (!source || !into || !title || body === undefined || args.length) return usageMr("mr create --source <branch> --target <branch> --title <t> --body-file <f|->");
      const m = await createGitlabMr(glab, target, { source, target: into, title, description: body }, hostAws());
      out(`!${m.iid} ${m.url}`);
      return 0;
    }
    const iid = Number(args.shift());
    if (!Number.isInteger(iid) || iid <= 0) return usageMr(`mr ${sub ?? "<create|view|discussions|note|resolve>"} <iid> …`);
    if (sub === "view" && !args.length) return out(JSON.stringify(await viewGitlabMr(glab, target, iid), null, 2)), 0;
    if (sub === "discussions" && !args.length) return out(JSON.stringify(await gitlabMrDiscussions(glab, target, iid), null, 2)), 0;
    if (sub === "note") {
      const [body, path, line] = [await text(flag("body-file")), flag("path"), flag("line")];
      if (body === undefined || args.length || (path === undefined) !== (line === undefined) || (line !== undefined && !/^[1-9]\d*$/.test(line))) return usageMr("mr note <iid> --body-file <f|-> [--path <file> --line <n>]");
      out(await startGitlabDiscussion(glab, target, iid, body, path ? { path, line: Number(line) } : undefined, hostAws()));
      return 0;
    }
    if (sub === "resolve" && args.length) {
      let failed = 0;
      for (const id of args) {
        try {
          await resolveGitlabDiscussion(glab, target, iid, id);
          out(`${id} resolved`);
        } catch (e) {
          err(`${id}: ${(e as Error).message}`);
          failed++;
        }
      }
      return failed ? 1 : 0;
    }
    return usageMr("mr <create|view|discussions|note|resolve> …");
  } catch (e) {
    err((e as Error).message);
    return 1;
  }
}

function usage(err: (s: string) => void, msg: string, code = 1): number {
  err(`${msg}\n（bun ops-kit/src/cli.ts --help で使い方）`);
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
