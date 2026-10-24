/**
 * bun scripts/check-models.ts — the model lists offered in the UI (CLAUDE_MODELS / CODEX_MODELS) against the tables the
 * installed CLIs carry (PBI #248). The tables are local data, never a vendor API and never an API key (PBI #155:
 * Switchboard holds no key): claude — the model table embedded in the installed executable; codex — `codex debug models
 * --bundled`, the table shipped in the binary (without `--bundled` it refreshes over the network, so the flag is always
 * given). The one network read is the version check against the public npm registry (#1273, below), still with no key.
 *
 * Prints one line per runner and finding:
 *   <runner> stale: <ids>   — listed in the UI but not in the CLI's table (an old or mistyped id)
 *   <runner> unseen: <ids>  — in the CLI's table but not in REVIEWED (a model nobody has looked at yet)
 *   <runner> 価格表未整備: <ids> — listed in the UI but priced by no row of pricing.json (the user's ~/.switchboard/pricing.json
 *                                  first, as the daemon reads it)
 *   unpriced (ledger): ...       — the claude / codex model names the ledger could not price, split into new (in the CLI's
 *                                  table: the price table lags behind) and unknown (not in it: a wrong name?). Report only:
 *                                  past ledger rows cannot be fixed, so they do not change the exit code
 *   <runner> outdated: <installed> → <latest> — the installed CLI is behind the npm registry's latest (#1273: an old CLI
 *                                  carries an old table, so a new model shows as "no drift"; Haiku 5.5, #1071). Drift (exit 1)
 *   <runner> version: <installed>（最新） / <runner> latest: 分からない（<why>） — the registry could not be read: report
 *                                  only, the exit code is the table comparison's. The CLI is never updated here.
 * Exit 0 = no drift / 1 = drift / 2 = cannot tell (a CLI is missing, or its table read as empty = its format changed).
 *
 * --file-request (the daily schedule, docs/design/check-models.md): on exit 1 also file a request Issue (type:request)
 * through scripts/setup/request_issue.sh, unless an open request has the same title (the same drift). The exit code is
 * the same with or without it; exit 2 files nothing (a changed CLI format is this script's to fix).
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PricingTable } from "@switchboard/protocol";
import { CLAUDE_MODELS } from "../packages/adapters/claude/src/index.ts";
import { CODEX_MODELS } from "../packages/adapters/codex/src/index.ts";
import { loadPricing, resolveModel } from "../packages/core/src/pricing.ts";
import { fileRequest } from "./file-request";

export type Runner = "claude" | "codex";

/**
 * Ids a person has looked at and decided to list or leave out (2026-10-07, claude 2.1.293 / codex-cli 0.159.2).
 * When a new id shows up as unseen, decide whether it goes in CLAUDE_MODELS / CODEX_MODELS first, then add it here.
 */
export const REVIEWED: Record<Runner, string[]> = {
  claude: [
    "claude-3-5-haiku", "claude-3-5-sonnet", "claude-3-7-sonnet",
    "claude-fable-5", "claude-fable-5-1",
    "claude-haiku-4-5", "claude-haiku-5-5",
    "claude-mythos-5", "claude-mythos-5-1",
    "claude-opus-4-0", "claude-opus-4-1", "claude-opus-4-5", "claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5",
    "claude-sonnet-4-0", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-sonnet-5-5",
  ],
  codex: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"],
};

const CLAUDE_ENTRY = /\{id:"(claude-[a-z0-9-]+)",family:"([a-z]+)",display_name:"([^"]+)"/g;

/** Ids of the model table embedded in the claude executable: `{id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5",…}`. */
export function claudeCatalog(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(CLAUDE_ENTRY)) ids.add(m[1]!);
  return [...ids];
}

/**
 * The embedded table's entries, scanned chunk by chunk: the executable is about 240 MB, and one string of it got the
 * script OOM-killed on a 3.8 GB host. The tail of each chunk is carried into the next so an entry cut in two is found.
 */
export async function claudeTableText(file: string): Promise<string> {
  const found: string[] = [];
  let carry = "";
  for await (const chunk of Bun.file(file).stream()) {
    const text = carry + Buffer.from(chunk).toString("latin1");
    for (const m of text.matchAll(CLAUDE_ENTRY)) found.push(m[0]);
    carry = text.slice(-512);
  }
  return found.join("\n");
}

/** Slugs of `codex debug models --bundled` that the CLI offers (`visibility: "list"`; `"hide"` is internal). */
export function codexCatalog(json: string): string[] {
  const models = (JSON.parse(json) as { models?: { slug?: unknown; visibility?: unknown }[] }).models ?? [];
  return models.filter((m) => m.visibility === "list" && typeof m.slug === "string").map((m) => m.slug as string);
}

export function compareModels(a: { listed: string[]; catalog: string[]; reviewed: string[] }): { stale: string[]; unseen: string[] } {
  return {
    stale: a.listed.filter((id) => !a.catalog.includes(id)),
    unseen: a.catalog.filter((id) => !a.reviewed.includes(id)),
  };
}

/** The listed ids no row of the price table resolves to. */
export function unpricedListed(listed: string[], table: PricingTable, runner: Runner): string[] {
  return listed.filter((id) => !resolveModel(table, id, runner));
}

/** The ledger's unpriced claude / codex model names. [] when there is no database or ledger yet. */
export function unpricedLedgerNames(dbPath: string): { runner: Runner; model: string }[] {
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ledger'").get()) return [];
    return db
      .query("SELECT DISTINCT runner, model FROM ledger WHERE source = 'unpriced' AND runner IN ('claude', 'codex') AND model IS NOT NULL ORDER BY runner, model")
      .all() as { runner: Runner; model: string }[];
  } finally {
    db.close();
  }
}

/**
 * new = the CLI's table has the name (the price table lags behind); unknown = it does not (a wrong name?). The name is
 * cut the way resolveModel cuts it first: a context-window tag ([1m]), then a date suffix (claude-haiku-4-5-20251001).
 * A runner whose table could not be read is left out (that run already says it cannot tell).
 */
export function classifyUnpriced(names: { runner: Runner; model: string }[], catalogs: Partial<Record<Runner, string[]>>): { new: string[]; unknown: string[] } {
  const out = { new: [] as string[], unknown: [] as string[] };
  for (const n of names) {
    const catalog = catalogs[n.runner];
    if (catalog) (catalog.includes(n.model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "")) ? out.new : out.unknown).push(`${n.runner} ${n.model}`);
  }
  return out;
}

/** Where each CLI's table comes from. null = the CLI is not installed. */
export interface Readers {
  claude(): Promise<string | null>;
  codex(): Promise<string | null>;
}

/** The installed CLIs found on `path` (the process's PATH unless given). */
export function hostReaders(path = process.env.PATH ?? ""): Readers {
  return {
    async claude() {
      const bin = Bun.which("claude", { PATH: path });
      return bin ? claudeTableText(realpathSync(bin)) : null;
    },
    async codex() {
      const bin = Bun.which("codex", { PATH: path });
      if (!bin) return null;
      const p = Bun.spawn([bin, "debug", "models", "--bundled"], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code !== 0) throw new Error(`codex debug models --bundled exited ${code}: ${err.trim()}`);
      return out;
    },
  };
}

/** The npm package each CLI ships as; its `latest` dist-tag is the newest version (#1273). */
export const PACKAGES: Record<Runner, string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex" };

/** Where the installed and the newest version of each CLI come from (#1273). */
export interface VersionReaders {
  /** The installed CLI's version (`x.y.z`); null when the CLI is not on PATH. Throws when `--version` fails or shows no version. */
  installed(runner: Runner): Promise<string | null>;
  /** The newest published version; throws when the registry cannot be read (no network, a changed response). */
  latest(runner: Runner): Promise<string>;
}

const SEMVER = /\b(\d+)\.(\d+)\.(\d+)\b/;

/** -1 / 0 / 1 as `a` is older than / the same as / newer than `b` (numeric major.minor.patch; anything after is ignored). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = SEMVER.exec(v);
    if (!m) throw new Error(`not a version: ${v}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

/** The host's CLIs (`<bin> --version`) and the npm registry (one GET per runner, 10 s; no key, nothing cached). */
export function hostVersions(path = process.env.PATH ?? ""): VersionReaders {
  return {
    async installed(runner) {
      const bin = Bun.which(runner, { PATH: path });
      if (!bin) return null;
      const p = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      if (code !== 0) throw new Error(`${runner} --version exited ${code}: ${err.trim().slice(0, 80)}`);
      const m = SEMVER.exec(out);
      if (!m) throw new Error(`${runner} --version shows no version: ${out.trim().slice(0, 80)}`);
      return m[0];
    },
    async latest(runner) {
      const r = await fetch(`https://registry.npmjs.org/${PACKAGES[runner]}/latest`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`registry.npmjs.org answered ${r.status}`);
      const v = ((await r.json()) as { version?: unknown }).version;
      if (typeof v !== "string" || !SEMVER.test(v)) throw new Error("registry.npmjs.org: no version in the answer");
      return v;
    },
  };
}

const HOME = process.env.SWITCHBOARD_HOME || join(homedir(), ".switchboard");

export interface Sources {
  read: Readers;
  versions: VersionReaders;
  pricing: PricingTable;
  /** switchboard.db, whose ledger is read for unpriced names. */
  dbPath: string;
}

export function hostSources(): Sources {
  const pricing = loadPricing([join(HOME, "pricing.json"), join(import.meta.dir, "..", "packages", "core", "config", "pricing.json")]).table;
  return { read: hostReaders(), versions: hostVersions(), pricing, dbPath: join(HOME, "switchboard.db") };
}

/** One kind of drift for one runner. The order of KINDS is the order in a request's title. */
export const KINDS = ["stale", "unseen", "価格表未整備", "outdated"] as const;
export interface Finding {
  runner: Runner;
  kind: (typeof KINDS)[number];
  ids: string[];
}

export interface Report {
  lines: string[];
  code: 0 | 1 | 2;
  findings: Finding[];
}

export async function checkModels(src: Sources = hostSources()): Promise<Report> {
  const { read } = src;
  const lines: string[] = [];
  const findings: Finding[] = [];
  const catalogs: Partial<Record<Runner, string[]>> = {};
  let code: 0 | 1 | 2 = 0;
  const runners: [Runner, string[], (s: string) => string[], () => Promise<string | null>][] = [
    ["claude", CLAUDE_MODELS.map((m) => m.value), claudeCatalog, read.claude],
    ["codex", CODEX_MODELS.map((m) => m.value), codexCatalog, read.codex],
  ];
  for (const [runner, listed, parse, source] of runners) {
    const unpriced = unpricedListed(listed, src.pricing, runner);
    if (unpriced.length) {
      lines.push(`${runner} 価格表未整備: ${unpriced.join(", ")}`);
      findings.push({ runner, kind: "価格表未整備", ids: unpriced });
      if (code === 0) code = 1;
    }
    let catalog: string[];
    try {
      const text = await source();
      if (text === null) {
        lines.push(`${runner}: 判定できなかった（CLI が PATH に無い）`);
        code = 2;
        continue;
      }
      catalog = parse(text);
    } catch (e) {
      lines.push(`${runner}: 判定できなかった（${(e as Error).message}）`);
      code = 2;
      continue;
    }
    if (catalog.length === 0) {
      lines.push(`${runner}: 判定できなかった（モデル表が 0 件。CLI の形式が変わった）`);
      code = 2;
      continue;
    }
    catalogs[runner] = catalog;
    const { stale, unseen } = compareModels({ listed, catalog, reviewed: REVIEWED[runner] });
    if (stale.length) {
      lines.push(`${runner} stale: ${stale.join(", ")}`);
      findings.push({ runner, kind: "stale", ids: stale });
    }
    if (unseen.length) {
      lines.push(`${runner} unseen: ${unseen.join(", ")}`);
      findings.push({ runner, kind: "unseen", ids: unseen });
    }
    if (!stale.length && !unseen.length) lines.push(`${runner}: ズレなし（${catalog.length} 件）`);
    else if (code === 0) code = 1;
  }
  // The CLI's version against the registry's latest (#1273): an old CLI carries an old table, which the comparison
  // above cannot see. Only when the CLI is there; the registry not answering is reported, not counted.
  for (const runner of ["claude", "codex"] as Runner[]) {
    let installed: string | null;
    try {
      installed = await src.versions.installed(runner);
    } catch (e) {
      lines.push(`${runner} version: 分からない（${(e as Error).message}）`);
      continue;
    }
    if (installed === null) continue;
    let latest: string;
    try {
      latest = await src.versions.latest(runner);
    } catch (e) {
      lines.push(`${runner} latest: 分からない（${(e as Error).message}）`);
      continue;
    }
    if (compareVersions(installed, latest) < 0) {
      lines.push(`${runner} outdated: ${installed} → ${latest}`);
      // the id is the installed version only: the title then stays the same while the CLI stays, however many versions npm publishes meanwhile (one open request, not one per release)
      findings.push({ runner, kind: "outdated", ids: [installed] });
      if (code === 0) code = 1;
    } else lines.push(`${runner} version: ${installed}（最新）`);
  }
  // A row stays 'unpriced' after its model is priced (nothing re-prices the ledger): only names still unpriced count.
  const stillUnpriced = unpricedLedgerNames(src.dbPath).filter((n) => !resolveModel(src.pricing, n.model, n.runner));
  const ledger = classifyUnpriced(stillUnpriced, catalogs);
  if (ledger.new.length) lines.push(`unpriced (ledger) new（価格表未整備）: ${ledger.new.join(", ")}`);
  if (ledger.unknown.length) lines.push(`unpriced (ledger) unknown（名前の誤り?）: ${ledger.unknown.join(", ")}`);
  if (!ledger.new.length && !ledger.unknown.length) lines.push("unpriced (ledger): なし");
  return { lines, code, findings };
}

const TITLE_MAX = 256;

/**
 * The request Issue for a drift, or null when there is none. The title is built from the findings sorted by runner,
 * kind and id, so the same drift always gets the same title — that is what alreadyFiled compares.
 */
export function requestFor(report: Report, source: { date: string; versions: string[] }): { title: string; body: string } | null {
  if (report.code !== 1 || report.findings.length === 0) return null;
  const sorted = report.findings
    .map((f) => ({ ...f, ids: [...f.ids].sort() }))
    .sort((a, b) => a.runner.localeCompare(b.runner) || KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  const full = `モデル一覧のズレ: ${sorted.map((f) => `${f.runner} ${f.kind} ${f.ids.join(",")}`).join(" / ")}`;
  // GitHub refuses titles over 256 characters. A long one is cut and keeps a hash of the whole, so it stays stable (sha1, not Bun.hash, whose output may change with Bun).
  const title = full.length <= TITLE_MAX ? full : `${full.slice(0, TITLE_MAX - 12)} … ${createHash("sha1").update(full).digest("hex").slice(0, 8)}`;
  const body = [
    "## 要望",
    "インストール済みの CLI のモデル表と、Switchboard のモデル一覧・価格表がずれています。一覧を見直してください。",
    "",
    "```",
    ...report.lines,
    "```",
    "",
    "直し方（docs/design/check-models.md）:",
    "- `stale`: 一覧（`CLAUDE_MODELS` は packages/adapters/claude/src/index.ts、`CODEX_MODELS` は packages/adapters/codex/src/index.ts）の古い / 誤った ID を直す",
    "- `unseen`: 一覧に載せるかを決めて一覧に足し（載せないなら足さない）、どちらでも scripts/check-models.ts の `REVIEWED` に足す",
    "- `価格表未整備`: packages/core/config/pricing.json の `models` に公式の価格を足す",
    "- `outdated`: CLI を更新する（Switchboard は更新しない。更新した次の実行で `version: …（最新）` になる）",
    "",
    "## 出典",
    "- 誰の言葉: 定期の検査",
    `\`bun scripts/check-models.ts --file-request\`（定期実行） / ${source.date} / ${source.versions.join(" / ")}`,
  ].join("\n");
  return { title, body };
}

async function run(cmd: string[]): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "inherit" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { out, code };
}

async function fileRequestFor(report: Report): Promise<void> {
  const versions: string[] = [];
  for (const bin of ["claude", "codex"]) {
    const v = Bun.which(bin) ? (await run([bin, "--version"])).out.trim() : "";
    versions.push(v ? `${bin} ${v.replace(new RegExp(`^${bin}(-cli)?\\s*`, "i"), "")}` : `${bin} なし`);
  }
  const req = requestFor(report, { date: new Date().toISOString().slice(0, 10), versions });
  if (!req) return;
  const r = await fileRequest(req);
  if ("open" in r) console.log(`要望: 既存 #${r.open}（起票しない）`);
}

if (import.meta.main) {
  const report = await checkModels();
  for (const l of report.lines) console.log(l);
  if (process.argv.includes("--file-request") && report.code === 1) {
    try {
      await fileRequestFor(report);
    } catch (e) {
      console.log(`要望: 起票できなかった（${(e as Error).message}）`);
    }
  }
  process.exit(report.code);
}
