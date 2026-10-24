#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKLOG_USAGE, readRecords, runBacklog } from "./backlog-client.ts";
import { bootstrap } from "./bootstrap.ts";
import { defaultConfig, findConfig, loadConfig, loadPublicSync, resolveProject, type OpsConfig } from "./config.ts";
import { realGh, repoOf, type GhClient } from "./gh.ts";
import { exportCopy } from "./export-copy.ts";
import { formatLint, lint } from "./lint.ts";
import { pullMain } from "./pull-main.ts";
import { spawnRun, sync } from "./public-sync.ts";
import { createRequest } from "./request.ts";
import { scanIssues } from "./scan.ts";
import { findSecrets, hostAws } from "./secrets.ts";
import { setField, UsageError } from "./set.ts";
import { parseLabels, syncLabels } from "./labels.ts";
import { reconcileProject, triage } from "./triage.ts";

const USAGE = `使い方: bun ops-kit/src/cli.ts <command> [--config <ops.config.json>] ...

  set <issue> <field> <value>
      Issue 1 件の Project フィールドを 1 つ設定する（単一選択 / 数値 / テキスト / 日付）。Project に無ければ追加する
      例: set 16 Status Ready / set 16 "Story Points" 5
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
      節が本文に無ければ作らない

${BACKLOG_USAGE}

  pull-main
      main の作業ツリー（git worktree list の最初）を upstream に fast-forward する。fast-forward できない・未コミットの変更が取り込むファイルと重なる・detached・upstream 無しは何も変えず理由を出して exit 1、fetch できない・Git でないは exit 2。設定ファイルは要らない
  sync-labels [<file>] [--dry-run]
      リポジトリのラベルを <file>（既定 .github/labels.yml）に合わせる。無いものを作り、色・説明が違うものを直す。
      <file> に無いラベルは消さない。--dry-run は変えるものを出すだけ。設定ファイルは要らない
  scan-text <file|->
      文（ファイル、- は標準入力）に認証に使える値（device code、承認 URL、トークン、鍵、アカウント ID、ホストの AWS の設定のプロファイル名・SSO のセッション名など）が無いか検査する
      出力は <file>:<行>: <種類>。値は出さない。exit 0 = 無い、1 = ある、2 = 読めなかった。設定ファイルは要らない
  scan-issues [<owner/name>]
      リポジトリの Issue・PR の題と本文、コメント、PR のレビューコメントとレビュー本文を全部、同じ検査に通す。出力は <URL>: <種類>（<行> 行目）と、最後に hits: <当たり> / scanned: <読んだ文の数>
      exit 0 = 無い、1 = ある、2 = 検査できなかった（取得の失敗）。<owner/name> を省くと GH_REPO、無ければ origin。設定ファイルは要らない

  public-sync [--source <ref>] [--dry-run] [--adopted] [--target-url <url>]
      main のツリーだけを（履歴なしで）公開リポジトリへ送る。公開先・送るもの・外すファイル・書き換えるファイルは設定の publicSync だけを読む
      設定は送るツリー（--source）のものを読む。初回は main へ根のコミット、2 回目からは sync/<タグ> の PR を開いて自分でマージし、題が版なら Release を付ける。
      Private のリポジトリ名・ホームパス・個人のメールアドレス・秘密の形の値（変わる行）があれば送らない。前回より古い --source は送らない。--dry-run は送らず結果だけ出す
      --adopted: 公開側だけの変更を Private に取り込み済みとして、置き換えて送る。--source の既定は origin/main
      exit 0 = 送った / 送るものが無い / dry-run、1 = 止まった（理由は stderr）、2 = 使い方の誤り

  export-copy <dest> --words-file <file>
      キットを読めないリポジトリ（公開リポジトリなど）が同梱するコピーを <dest> に作る（テストを除くコード、skills、bin、
      README。<dest>/KIT_VERSION に元のコミットと日時）。--words-file で指定した固有語のリスト（キットの外）の語が 1 件でもあればコピーを消して exit 1
      <dest> は無い・空・前のコピー（KIT_VERSION がある）のどれか。前のコピーは置き換える。設定ファイルは要らない

--config を省くと、今のディレクトリから上へ ops.config.json を探す。
Project URL は環境変数 <envPrefix>_PROJECT_URL、設定の省略可能な projectUrl、同名のリポジトリ変数（gh variable get）の順で読む（持ち主もその URL から）。<envPrefix>_PROJECT_OWNER は持ち主だけを変える。リポジトリは GH_REPO、無ければ origin。

設定ファイルの例（ops.config.json）:
`;

export async function main(argv: string[], gh: GhClient = realGh(), out: (s: string) => void = console.log, err: (s: string) => void = console.error, sleep: (ms: number) => Promise<void> = Bun.sleep, env: Record<string, string | undefined> = process.env): Promise<number> {
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
  if (command === "backlog") {
    // the configuration only tells whether triage takes a phase; none is needed to read or edit
    let phase = false;
    try {
      phase = !!loadConfig(configPath).fields.phase;
    } catch {
      /* no ops.config.json: triage takes no phase */
    }
    return runBacklog(rest, env, { out, err }, { phase });
  }
  if (command === "pull-main") {
    if (rest.length) return usage(err, "pull-main", 2);
    return pullMain(process.cwd(), out, err);
  }
  if (command === "public-sync") {
    const flags = new Set(["--dry-run", "--adopted"]);
    const valued = new Set(["--source", "--target-url"]);
    const given: Record<string, string> = {};
    const on = new Set<string>();
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (flags.has(a)) on.add(a);
      else if (valued.has(a) && rest[i + 1] !== undefined && !rest[i + 1]!.startsWith("--")) given[a] = rest[++i]!;
      else return usage(err, "public-sync [--source <ref>] [--dry-run] [--adopted] [--target-url <url>]", 2);
    }
    try {
      const cfg = loadPublicSync(configPath, undefined, given["--source"] ?? "origin/main");
      const r = await repoOf(gh);
      out(sync({ host: hostAws(), privateRepo: `${r.owner}/${r.name}`, target: cfg.target, versioning: cfg.versioning, include: cfg.include, exclude: cfg.exclude, rewrite: cfg.rewrite, serviceUsers: cfg.serviceUsers, source: given["--source"], targetUrl: given["--target-url"], dryRun: on.has("--dry-run"), adopted: on.has("--adopted") }, spawnRun));
      return 0;
    } catch (e) {
      err((e as Error).message);
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
      const [named, ...extra] = rest;
      if (extra.length || (named !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(named))) return usage(err, "scan-issues [<owner/name>]", 2);
      let repo = named;
      if (repo === undefined) {
        const r = await repoOf(gh);
        repo = `${r.owner}/${r.name}`;
      }
      const { hits, scanned } = await scanIssues(gh, repo, sleep, hostAws());
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

function usage(err: (s: string) => void, msg: string, code = 1): number {
  err(`${msg}\n（bun ops-kit/src/cli.ts --help で使い方）`);
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
