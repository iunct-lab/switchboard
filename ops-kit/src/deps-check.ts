/**
 * `ops-kit deps-check [--file-request]`: checks a repository's dependencies — vulnerabilities, a major version
 * behind, a version published 90 days ago or more — and, with `--file-request`, files one request for the month (or adds
 * to the open one with the same title). Reading a tool's output and judging are pure functions; running the tools and
 * reaching the backlog are injected (`DepsCheckDeps`), so a test runs it with fakes. A package manager is an
 * `Ecosystem`: bun is the first, uv the second: one more entry in `ECOSYSTEMS`.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export type Dep = {
  /** Where it was found: bun's workspace name (`bun outdated --filter '*'`), uv's directory of `uv.lock` (relative to the root); `.` for none. */
  dir: string;
  name: string;
  current: string;
  candidate: string;
  reason: string;
  /** The candidate's publication date (YYYY-MM-DD) or null when it could not be read. */
  published: string | null;
  license: string | null;
  /** The package manager the row came from (`bun`, …): an open PR handles it only through that manager's files. */
  tool?: string;
};

/** One vulnerability of `bun audit` / `pip-audit`. `dir` is set when the audit ran per directory (uv). */
export type Finding = { name: string; severity: string; title: string; id: string; dir?: string };

/** A row of `bun outdated`: `latest` is the candidate; `current` is what the lockfile has. */
export type Outdated = { dir: string; name: string; current: string; latest: string };

export const STALE_DAYS = 90;

/** `bun audit --json`: `{ "<package>": [{ id, url, title, severity, vulnerable_versions, ... }] }`. Throws on anything else. */
export function parseBunAudit(out: string): Finding[] {
  const json = JSON.parse(out) as unknown;
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("bun audit --json の出力が読めない");
  const findings: Finding[] = [];
  for (const [name, list] of Object.entries(json as Record<string, unknown>)) {
    if (!Array.isArray(list)) throw new Error(`bun audit --json の ${name} が配列でない`);
    for (const f of list as Array<{ id?: unknown; url?: unknown; title?: unknown; severity?: unknown }>) {
      const url = typeof f.url === "string" ? f.url : "";
      findings.push({ name, severity: String(f.severity ?? "unknown"), title: String(f.title ?? ""), id: url.split("/").pop() || String(f.id ?? "?") });
    }
  }
  return findings;
}

/**
 * The table `bun outdated` prints (with `--filter '*'` it has a Workspace column). `(dev)` / `(peer)` / `(optional)` after a
 * name is dropped. A row whose current and latest are the same is not outdated and is left out.
 */
export function parseBunOutdated(out: string): Outdated[] {
  const rows = out.split("\n").filter((l) => l.startsWith("|") && !/^\|[-|]+\|?$/.test(l.trim())).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  const head = rows.find((r) => r[0] === "Package");
  if (!head) return [];
  const col = (n: string) => head.indexOf(n);
  const [p, c, l, w] = [col("Package"), col("Current"), col("Latest"), col("Workspace")];
  if (c < 0 || l < 0) throw new Error("bun outdated の表の見出しが読めない");
  return rows
    .filter((r) => r !== head)
    .map((r) => ({ dir: w >= 0 ? r[w]! : ".", name: r[p]!.replace(/ \((dev|peer|optional)\)$/, ""), current: r[c]!, latest: r[l]! }))
    .filter((r) => r.current !== r.latest);
}

/** The part a breaking change raises: the major, or for `0.x` the minor (`0.25` → `0.26` breaks under semver). */
const majorOf = (v: string) => {
  const [major, minor] = (/^\D*(\d+)(?:\.(\d+))?/.exec(v) ?? []).slice(1).map(Number);
  return major === 0 ? `0.${minor ?? 0}` : String(major ?? NaN);
};
const majorBehind = (candidate: string, current: string) => majorOf(candidate) !== majorOf(current) && newerVersion(candidate, current);

/**
 * The rows that meet a condition: a vulnerability (one row per package; a package `bun audit` names that is not in
 * `bun outdated` has `-` for versions), a major version behind, or a current version published `STALE_DAYS` days ago
 * or more (only a dependency with a newer version: one already at the latest cannot be updated). `deps` carry
 * `published` of the candidate and of the current version in `currentPublished` (by `name@version`).
 */
export function judge(deps: Dep[], audit: Finding[], now: Date, currentPublished: Record<string, string | null> = {}, tool?: string): { hit: boolean; rows: Dep[] } {
  const rows: Dep[] = [];
  for (const d of deps) {
    const reasons: string[] = [];
    for (const f of audit.filter((a) => a.name === d.name && (a.dir === undefined || a.dir === d.dir))) reasons.push(`脆弱性 ${f.id}（${f.severity}）`);
    if (majorBehind(d.candidate, d.current)) reasons.push("outdated（major の遅れ）");
    const since = currentPublished[`${d.name}@${d.current}`];
    const days = since ? Math.floor((now.getTime() - Date.parse(since)) / 86_400_000) : NaN;
    if (days >= STALE_DAYS) reasons.push(`outdated（現在の版の公開から ${days} 日）`);
    if (reasons.length) rows.push({ ...d, reason: reasons.join("、") });
  }
  for (const f of audit.filter((a) => !deps.some((d) => d.name === a.name && (a.dir === undefined || a.dir === d.dir)))) {
    const dir = f.dir ?? ".";
    const same = rows.find((r) => r.dir === dir && r.name === f.name && r.current === "-");
    const reason = `脆弱性 ${f.id}（${f.severity}）`;
    if (same) same.reason += `、${reason}`;
    // the row of a vulnerability the outdated list did not name keeps its package manager, so only that manager's files handle it
    else rows.push({ dir, name: f.name, current: "-", candidate: "-", reason, published: null, license: null, ...(tool ? { tool } : {}) });
  }
  return { hit: rows.length > 0, rows };
}

/** An open PR that changes a lockfile or manifest (`bun.lock` / `package.json` / `uv.lock` / `pyproject.toml`): those files and their patches. */
export type OpenPr = { number: number; files: Array<{ path: string; patch: string }>; unread?: string[] };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parts = (v: string) => (/\d+(\.\d+)*/.exec(v)?.[0] ?? "").split(".").filter(Boolean).map(Number);

/**
 * SemVer's order of what follows the numbers: a prerelease (`-…`) before the release; between prereleases, identifier by
 * identifier (dot-separated) — numbers as numbers and before words, words by ASCII order, and fewer identifiers first
 * when the rest is equal (`beta` < `dev`, `beta.2` < `beta.2.1`). A build tag after `+` is not compared.
 */
function compareSemverSuffix(a: string, b: string): number {
  const pre = (v: string) => {
    const m = /^-([^+]*)/.exec(v.replace(/^\./, "-"));
    return m ? m[1]!.split(".") : null;
  };
  const [x, y] = [pre(a), pre(b)];
  if (!x || !y) return x ? -1 : y ? 1 : 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i], y[i]];
    if (p === q) continue;
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const [np, nq] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (np && nq) return Number(p) - Number(q);
    if (np !== nq) return np ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Whether version `a` is later than `b` (`^8.3.7` > `8.3.5`; `1.0` and `1.0.0` are the same); false when either has no
 * numbers. With the same numbers, the suffix decides by SemVer (`compareSemverSuffix`).
 */
export function newerVersion(a: string, b: string, compareSuffix: (a: string, b: string) => number = compareSemverSuffix): boolean {
  const [x, y] = [parts(a), parts(b)];
  if (!x.length || !y.length) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  const rest = (v: string) => v.slice((/\d+(\.\d+)*/.exec(v)?.index ?? 0) + (/\d+(\.\d+)*/.exec(v)?.[0].length ?? 0)).replace(/["'\s,;].*$/, "");
  return compareSuffix(rest(a), rest(b)) > 0;
}

/**
 * The versions the added lines (`+`) of one file give the row's package: the key `"<name>": "<range>"` (`package.json`,
 * `bun.lock`'s workspaces) and a `bun.lock` entry `"<path or name>": ["<name>@<version>"`. A line that names the package
 * only inside another package's entry (its dependencies) gives none. An ecosystem with other files adds its own reader.
 */
export type VersionReader = (file: { path: string; patch: string }, row: Dep) => string[];

export const bunVersions: VersionReader = (file, row) => {
  if ((row.tool ?? "bun") !== "bun" || !/(^|\/)(bun\.lock|package\.json)$/.test(file.path)) return [];
  const n = escapeRe(row.name);
  const re = new RegExp(`^\\+\\s*("${n}"\\s*:\\s*"([^"]+)"|"[^"]*"\\s*:\\s*\\["${n}@([^"]+)")`);
  return file.patch.split("\n").flatMap((l) => {
    const m = /^\+{3} /.test(l) ? null : re.exec(l);
    return m ? [m[2] ?? m[3]!] : [];
  });
};

/**
 * uv: a uv row only, through the files of its directory only (`<dir>/uv.lock`, `<dir>/pyproject.toml`). In `uv.lock`, an added `version`
 * line under `name = "<name>"`; in `pyproject.toml`, a requirement (one a line or inside an inline array, either quote,
 * with an environment marker) that is on the added side and not on the removed side — an unchanged neighbour in a
 * changed array gives none — and its lower bound (`>=3.0` → `3.0`).
 */
export const uvVersions: VersionReader = (file, row) => {
  const m = /^(?:(.*)\/)?(uv\.lock|pyproject\.toml)$/.exec(file.path);
  if (row.tool !== "uv" || !m || (m[1] ?? ".") !== row.dir) return [];
  const lines = file.patch.split("\n").filter((l) => !/^[+-]{3} /.test(l));
  if (m[2] === "uv.lock") {
    // the line above the added version, skipping the removed one (`-version = …`), is the package's name
    const nameAbove = (i: number) => {
      while (i > 0 && lines[i - 1]!.startsWith("-")) i--;
      return lines[i - 1]?.slice(1);
    };
    return lines.flatMap((l, i) => (/^\+version = "/.test(l) && nameAbove(i) === `name = "${row.name}"` ? [/"([^"]+)"/.exec(l)![1]!] : []));
  }
  // names compare as PEP 503 normalises them (`PyYAML` = `pyyaml`, `typing_extensions` = `typing-extensions`)
  const n = row.name.toLowerCase().split(/[-_.]+/).map(escapeRe).join("[-_.]+");
  const req = new RegExp(`(^|[\\[,=])\\s*(["'])(${n}(\\[[^\\]]*\\])?\\s*[<>=!~;](?:(?!\\2).)*)\\2`, "gi");
  const reqs = (sign: string) => new Set(lines.filter((l) => l.startsWith(sign)).flatMap((l) => [...l.slice(1).matchAll(req)].map((x) => x[3]!.replace(/\s+/g, ""))));
  const [was, now] = [reqs("-"), reqs("+")];
  return [...now].filter((x) => !was.has(x)).flatMap((x) => {
    const v = /(?:===|==|>=|~=|>)([0-9][^,;]*)/.exec(x);
    return v ? [v[1]!] : [];
  });
};

export const VERSION_READERS: VersionReader[] = [bunVersions, uvVersions];

/** PEP 440's rank of a word after the numbers: prereleases (`dev` < `a`/`alpha` < `b`/`beta` < `rc` and others) < the release < `post`. */
const RELEASE = 4;
function wordRank(w: string): number {
  if (w === "dev") return 0;
  if (w === "a" || w === "alpha") return 1;
  if (w === "b" || w === "beta") return 2;
  if (w === "post" || w === "r" || w === "rev") return 5;
  return 3;
}

/**
 * PEP 440's order of what follows the numbers, token by token (words and numbers: `rc1.dev2` → rc, 1, dev, 2). Numbers
 * compare as numbers, words by rank; where one side has ended, it is the release against a word (`rc1` > `rc1.dev2`,
 * `1.0` < `1.0.post1`) and before a number. A local label after `+` is not compared.
 */
function comparePep440Suffix(a: string, b: string): number {
  const tokens = (v: string) => v.toLowerCase().replace(/\+.*$/, "").match(/[a-z]+|\d+/g) ?? [];
  const [x, y] = [tokens(a), tokens(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i], y[i]];
    if (p === q) continue;
    const num = (t: string) => /^\d/.test(t);
    if (p === undefined) return num(q!) ? -1 : RELEASE - wordRank(q!);
    if (q === undefined) return num(p) ? 1 : wordRank(p) - RELEASE;
    if (num(p) && num(q)) return Number(p) - Number(q);
    if (num(p) !== num(q)) return num(p) ? -1 : 1;
    const d = wordRank(p) - wordRank(q);
    if (d) return d;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The suffix order of a row's package manager: PEP 440 for uv's (Python), SemVer otherwise. */
const suffixOrderOf = (row: Dep) => (row.tool === "uv" ? comparePep440Suffix : compareSemverSuffix);

/**
 * Splits `rows` into those no open PR handles and the PR numbers that do (by name). A PR handles a row when one of its
 * files moves the package to a version later than the row's current one. A line that keeps the current version (a new
 * workspace that adds the same range) does not. A row with a vulnerability always stays: whether a PR's version still
 * falls in the advisory's range is not read here, and a vulnerability is listed until it is fixed.
 */
export function excludeFiled(rows: Dep[], prs: OpenPr[], readers: VersionReader[] = VERSION_READERS): { rows: Dep[]; filed: Array<{ name: string; prs: number[] }> } {
  const filed = new Map<string, number[]>();
  const kept = rows.filter((r) => {
    if (r.reason.includes("脆弱性")) return true;
    const by = prs
      .filter((p) => p.files.some((f) => readers.some((read) => read(f, r).some((v) => newerVersion(v, r.current, suffixOrderOf(r))))))
      .map((p) => p.number);
    if (!by.length) return true;
    filed.set(r.name, [...new Set([...(filed.get(r.name) ?? []), ...by])]);
    return false;
  });
  return { rows: kept, filed: [...filed].map(([name, prs]) => ({ name, prs })) };
}

/** The conditions of an update for a bun repository (the sentence the scheduled checks used). */
export const BUN_CONDITIONS =
  "候補の版は公開から 7 日以上経ったものだけ。bun install は --minimum-release-age=604800 を付ける。lockfile と package.json 以外は触らない。新しい依存を増やさない。postinstall を持つ依存は名前を挙げて別判断にし trustedDependencies に足さない。更新後に bun pm ls の差分を PR に貼る。major は 1 パッケージ 1 PR。";

/** The conditions of an update for a uv repository (the sentence the scheduled checks used). */
export const UV_CONDITIONS =
  "候補の版は公開から 7 日以上経ったものだけ。uv.lock と pyproject.toml 以外は触らない。新しい依存を増やさない。更新後に uv tree の差分（増えた推移的依存）を PR に貼る。各ディレクトリのテストと CI の手順を通す。major は 1 パッケージ 1 PR。";

/** `audits` are the lines of `## 出典` that say how the vulnerabilities were checked (one per tool run, or that it did not run). */
export type BodySource = { now: Date; audits: string[]; filed: Array<{ name: string; prs: number[] }>; prsRead: boolean; unread?: string[] };

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const titleOf = (now: Date) => `依存の更新: ${ymd(now).slice(0, 7)}`;

/** The request's body: `## 要望` (the table), `## 出典`, `## 更新の条件` (the tool's sentence, then the repository's own). */
export function buildBody(rows: Dep[], source: BodySource, conditions: string[]): string {
  const lines = ["## 要望", "", "依存を更新したい。", "", "| 場所 | パッケージ | 今 | 候補 | 理由 | 候補の公開日 | ライセンス |", "|---|---|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${[r.dir, r.name, r.current, r.candidate, r.reason, r.published ?? "不明", r.license ?? "不明"].map(cell).join(" | ")} |`);
  lines.push("");
  if (!source.prsRead) lines.push("既出の確認なし（開いた PR を読めなかった）。", "");
  for (const u of source.unread ?? []) lines.push(`既出の確認が一部できない: ${u}（GitHub が差分を省いた）。`);
  if (source.unread?.length) lines.push("");
  for (const f of source.filed) lines.push(`既出: ${f.name}（${f.prs.map((n) => `#${n}`).join("、")} が扱っている）`);
  if (source.filed.length) lines.push("");
  lines.push("## 出典", "", "- 誰の言葉: 定期の検査", `- いつ: ${ymd(source.now)}`, "- 経路: 定期実行（ops-kit deps-check --file-request）", ...source.audits.map((a) => `- 検査: ${a}`), "", "## 更新の条件", "");
  for (const c of conditions) lines.push(`- ${c}`);
  return lines.join("\n") + "\n";
}

/**
 * Runs a command (in `cwd`, with `stdin` on its standard input) and gives its standard output and exit code. Its standard
 * error goes to ours (`inherit`, the default), into the output (`merge`: uv prints its report there) or nowhere (`ignore`).
 * May throw when it cannot start.
 */
export type Exec = (cmd: string[], opts?: { cwd?: string; stdin?: string; stderr?: "inherit" | "merge" | "ignore" }) => Promise<{ out: string; code: number }>;

export interface DepsCheckDeps {
  exec: Exec;
  now: () => Date;
  cwd: string;
  /** A JSON document over HTTP (PyPI); null when it could not be read. */
  fetchJson: (url: string) => Promise<unknown | null>;
  /** The open PRs that change a lockfile or manifest; null = could not be read. */
  openPrs: () => Promise<OpenPr[] | null>;
  /** The open requests (`ref` is `#N`, or the id the app gave one it has not numbered yet). */
  openRequests: () => Promise<Array<{ ref: string; title: string }>>;
  /** Files a request; returns the line of the output that names it (`#N` when numbered), or null. */
  fileRequest: (title: string, body: string) => Promise<string | null>;
  comment: (ref: string, body: string) => Promise<void>;
  out: (s: string) => void;
  err: (s: string) => void;
}

/**
 * What one package manager gives: the vulnerabilities, the outdated dependencies (with candidate dates), its sentence of
 * conditions. `audits` say how the audit ran (for `## 出典`); `notes` are lines to print (a tool that did not run).
 */
export interface Ecosystem {
  name: string;
  applies: (cwd: string) => boolean;
  conditions: string;
  /** `unaudited`: the places whose vulnerabilities were not checked (the tool did not run or its output could not be read). */
  collect: (deps: DepsCheckDeps) => Promise<{ audit: Finding[]; audits: string[]; notes: string[]; outdated: Outdated[]; deps: Dep[]; currentPublished: Record<string, string | null>; unaudited?: string[] }>;
}

async function must(exec: Exec, cmd: string[], okCodes: number[] = [0]): Promise<string> {
  const r = await exec(cmd);
  if (!okCodes.includes(r.code)) throw new Error(`${cmd.slice(0, 3).join(" ")} が exit ${r.code} で終わった`);
  return r.out;
}

/** `bun info <name> <field> --json`, or null when it cannot be read. */
async function info(exec: Exec, spec: string, field: string): Promise<unknown> {
  try {
    return JSON.parse(await must(exec, ["bun", "info", spec, field, "--json"]));
  } catch {
    return null;
  }
}

export const bunEcosystem: Ecosystem = {
  name: "bun",
  applies: (cwd) => existsSync(join(cwd, "bun.lock")),
  conditions: BUN_CONDITIONS,
  async collect({ exec }) {
    // bun audit exits 1 when it found something; its output is what tells (a failure prints no JSON)
    const audit = await exec(["bun", "audit", "--json"]);
    if (audit.code > 1) throw new Error(`bun audit が exit ${audit.code} で終わった`);
    const findings = parseBunAudit(audit.out);
    const outdated = parseBunOutdated(await must(exec, ["bun", "outdated", "--filter", "*"]));
    const times = new Map<string, Record<string, string> | null>();
    const licenses = new Map<string, string | null>();
    const currentPublished: Record<string, string | null> = {};
    const deps: Dep[] = [];
    for (const o of outdated) {
      if (!times.has(o.name)) times.set(o.name, (await info(exec, o.name, "time")) as Record<string, string> | null);
      const key = `${o.name}@${o.latest}`;
      if (!licenses.has(key)) {
        const l = await info(exec, key, "license");
        licenses.set(key, typeof l === "string" ? l : l ? JSON.stringify(l) : null);
      }
      const time = times.get(o.name);
      // a date that cannot be read leaves that row's 90-day check undone; depsCheck names such rows (null here)
      currentPublished[`${o.name}@${o.current}`] = time?.[o.current]?.slice(0, 10) ?? null;
      deps.push({ dir: o.dir, name: o.name, current: o.current, candidate: o.latest, reason: "", published: time?.[o.latest]?.slice(0, 10) ?? null, license: licenses.get(key) ?? null, tool: "bun" });
    }
    return { audit: findings, audits: [`bun audit の終了コード ${audit.code}（脆弱性 ${findings.length} 件）`], notes: [], outdated, deps, currentPublished };
  },
};

const SKIPPED_DIRS = new Set(["node_modules", ".venv", ".git"]);

/** The directories under `root` that have a `uv.lock` (relative to it, `.` for root itself), sorted; `node_modules` / `.venv` / `.git` are not entered. */
export function findUvDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a directory that cannot be read has no uv.lock we could check
    }
    if (entries.some((e) => e.isFile() && e.name === "uv.lock")) found.push(relative(root, dir) || ".");
    for (const e of entries) if (e.isDirectory() && !SKIPPED_DIRS.has(e.name)) walk(join(dir, e.name));
  };
  walk(root);
  return found.sort();
}

/** What `uv lock --upgrade --dry-run` reports (on its standard error): `Update <name> v<current> -> v<candidate>` per dependency it would raise. */
export function parseUvUpgrade(out: string): Array<{ name: string; current: string; latest: string }> {
  // uv always reports the resolution; without that line the output is not what this reads (exit 2, not "nothing to update")
  if (!/^Resolved \d+ packages? /m.test(out)) throw new Error("uv lock --upgrade --dry-run の出力が読めない（Resolved の行が無い）");
  const rows: Array<{ name: string; current: string; latest: string }> = [];
  for (const l of out.split("\n")) {
    // a lock with Python-version forks names a version per fork on each side (`v1.10.0, v2.13.5 -> v1.10.26, v3.0.0`):
    // one row per fork, paired in order (when the counts differ, the rest pair with the other side's last)
    const m = /^Update (\S+) (.+?) -> (.+)$/.exec(l.trim());
    if (!m) continue;
    const list = (s: string) => s.split(",").map((v) => v.trim().replace(/^v/, "")).filter(Boolean);
    const [from, to] = [list(m[2]!), list(m[3]!)];
    for (let i = 0; i < Math.max(from.length, to.length); i++) {
      const current = from[Math.min(i, from.length - 1)]!;
      const latest = to[Math.min(i, to.length - 1)]!;
      if (current !== latest && !rows.some((r) => r.name === m[1] && r.current === current && r.latest === latest)) rows.push({ name: m[1]!, current, latest });
    }
  }
  return rows;
}

/**
 * `pip-audit -f json`: `{ "dependencies": [{ name, version, vulns: [{ id, fix_versions, ... }] }] }`. The severity column
 * of a finding holds the fixed version (pip-audit gives no severity). Throws on anything else.
 */
export function parsePipAudit(out: string, dir?: string): Finding[] {
  const json = JSON.parse(out) as { dependencies?: Array<{ name?: unknown; vulns?: unknown }> };
  if (!Array.isArray(json?.dependencies)) throw new Error("pip-audit -f json の出力が読めない");
  const findings: Finding[] = [];
  for (const d of json.dependencies) {
    const vulns = Array.isArray(d.vulns) ? (d.vulns as Array<{ id?: unknown; fix_versions?: unknown; description?: unknown }>) : [];
    for (const v of vulns) {
      const fix = Array.isArray(v.fix_versions) && v.fix_versions.length ? `修正版 ${String(v.fix_versions[0])}` : "修正版なし";
      findings.push({ name: String(d.name), severity: fix, title: String(v.description ?? ""), id: String(v.id ?? "?"), ...(dir === undefined ? {} : { dir }) });
    }
  }
  return findings;
}

/** A distribution name as PEP 503 normalises it (`PyYAML` = `pyyaml`, `typing_extensions` = `typing-extensions`). */
const pep503 = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

/**
 * The names (PEP 503) a `pyproject.toml` asks for directly: `[project].dependencies`, `[project.optional-dependencies]` and
 * `[dependency-groups]` (an `include-group` table is not a requirement). null when the text is not TOML.
 */
export function directDeps(pyprojectText: string): Set<string> | null {
  let toml: { project?: { dependencies?: unknown; "optional-dependencies"?: Record<string, unknown> }; "dependency-groups"?: Record<string, unknown> };
  try {
    toml = Bun.TOML.parse(pyprojectText) as typeof toml;
  } catch {
    return null;
  }
  const lists = [toml?.project?.dependencies, ...Object.values(toml?.project?.["optional-dependencies"] ?? {}), ...Object.values(toml?.["dependency-groups"] ?? {})];
  const names = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const req of list) {
      const m = typeof req === "string" ? /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(req) : null;
      if (m) names.add(pep503(m[1]!));
    }
  }
  return names;
}

/** From `https://pypi.org/pypi/<name>/json`: the first upload date of each version, and the license when it is short. */
function pypiFacts(json: unknown): { dates: Record<string, string>; license: string | null; version: string | null } {
  const j = (json ?? {}) as { info?: { version?: unknown; license_expression?: unknown; license?: unknown }; releases?: Record<string, Array<{ upload_time_iso_8601?: string }>> };
  const dates: Record<string, string> = {};
  for (const [v, files] of Object.entries(j.releases ?? {})) {
    const first = (files ?? []).map((f) => f.upload_time_iso_8601 ?? "").filter(Boolean).sort()[0];
    if (first) dates[v] = first.slice(0, 10);
  }
  const lic = [j.info?.license_expression, j.info?.license].find((x) => typeof x === "string" && x.trim() !== "" && x.length <= 40);
  // `info` describes the latest release only: its license is the candidate's only when the candidate is that release
  return { dates, license: typeof lic === "string" ? lic.trim() : null, version: typeof j.info?.version === "string" ? j.info.version : null };
}

export const uvEcosystem: Ecosystem = {
  name: "uv",
  applies: (cwd) => findUvDirs(cwd).length > 0,
  conditions: UV_CONDITIONS,
  async collect({ exec, fetchJson, cwd }) {
    const outdated: Outdated[] = [];
    const audit: Finding[] = [];
    const audits: string[] = [];
    const notAudited: string[] = [];
    const notes: string[] = [];
    for (const dir of findUvDirs(cwd)) {
      const at = join(cwd, dir);
      const check = await exec(["uv", "lock", "--check"], { cwd: at, stderr: "ignore" });
      if (check.code !== 0) {
        // in the body's 出典, and as a line of the output even when nothing meets a condition (no body then)
        const line = `${dir}: uv lock --check が exit ${check.code}（uv.lock が pyproject.toml と合っていない）`;
        audits.push(line);
        notes.push(line);
      }
      const upgrade = await exec(["uv", "lock", "--upgrade", "--dry-run"], { cwd: at, stderr: "merge" });
      if (upgrade.code !== 0) throw new Error(`uv lock --upgrade --dry-run（${dir}）が exit ${upgrade.code} で終わった`);
      const upgrades = parseUvUpgrade(upgrade.out).map((r) => ({ dir, ...r }));
      const audited = audit.length;
      try {
        const exported = await exec(["uv", "export", "--frozen", "--no-emit-project", "--no-emit-local", "--format", "requirements-txt"], { cwd: at, stderr: "ignore" });
        if (exported.code !== 0) throw new Error(`uv export が exit ${exported.code} で終わった`);
        // pip-audit reads the requirements from standard input as /dev/stdin (it does not take `-`); the export is hashed, so it audits without building
        const run = await exec(["uvx", "pip-audit", "-r", "/dev/stdin", "--no-deps", "--disable-pip", "-f", "json"], { cwd: at, stdin: exported.out, stderr: "ignore" });
        if (run.code > 1) throw new Error(`pip-audit が exit ${run.code} で終わった`);
        audit.push(...parsePipAudit(run.out, dir));
      } catch {
        notAudited.push(dir);
      }
      // only the direct dependencies of this directory's pyproject.toml, and any package pip-audit named (transitive or not);
      // a pyproject.toml that cannot be read narrows nothing, and says so
      let direct: Set<string> | null = null;
      try {
        direct = directDeps(readFileSync(join(at, "pyproject.toml"), "utf8"));
      } catch {}
      if (direct === null) {
        notes.push(`${dir}: pyproject.toml が読めないので、uv の更新できる依存を直接の依存に絞らず全部出す`);
        outdated.push(...upgrades);
      } else {
        const vulnerable = new Set(audit.slice(audited).map((f) => pep503(f.name)));
        outdated.push(...upgrades.filter((r) => direct.has(pep503(r.name)) || vulnerable.has(pep503(r.name))));
      }
    }
    // the directories it did not run in are named; the others' vulnerabilities are in the table as usual
    if (notAudited.length) notes.push(`pip-audit が走らなかった（${notAudited.join("、")}）。そのディレクトリの脆弱性は検査せず、outdated だけで判定する`);
    const ran = findUvDirs(cwd).length - notAudited.length;
    audits.push(
      [ran ? `pip-audit: 脆弱性 ${audit.length} 件` : "", notAudited.length ? `pip-audit: 走らなかった（${notAudited.join("、")}）` : ""].filter(Boolean).join("、"),
    );
    const facts = new Map<string, ReturnType<typeof pypiFacts> | null>();
    const currentPublished: Record<string, string | null> = {};
    const deps: Dep[] = [];
    for (const o of outdated) {
      if (!facts.has(o.name)) {
        const json = await fetchJson(`https://pypi.org/pypi/${o.name}/json`);
        facts.set(o.name, json ? pypiFacts(json) : null);
      }
      const f = facts.get(o.name);
      // as for bun: a date PyPI does not give (another index, a local label) is said in that row; the check goes on
      currentPublished[`${o.name}@${o.current}`] = f?.dates[o.current] ?? null;
      deps.push({ dir: o.dir, name: o.name, current: o.current, candidate: o.latest, reason: "", published: f?.dates[o.latest] ?? null, license: f && f.version === o.latest ? f.license : null, tool: "uv" });
    }
    return { audit, audits, notes, outdated, deps, currentPublished, unaudited: notAudited };
  },
};

/** The package managers this check knows; a repository uses every one it has a lockfile for. */
export const ECOSYSTEMS: Ecosystem[] = [bunEcosystem, uvEcosystem];

export type DepsCheckOptions = { fileRequest: boolean; extraConditions: string[] };

/** exit 0 = nothing meets a condition, 1 = something does, 2 = a tool did not run (or the request could not be filed). */
export async function depsCheck(opts: DepsCheckOptions, deps: DepsCheckDeps): Promise<number> {
  const used = ECOSYSTEMS.filter((e) => e.applies(deps.cwd));
  if (!used.length) {
    deps.err(`依存の検査に使える lockfile（${ECOSYSTEMS.map((e) => e.name).join(" / ")}）が ${deps.cwd} に無い`);
    return 2;
  }
  const now = deps.now();
  let rows: Dep[] = [];
  const audits: string[] = [];
  const notes: string[] = [];
  let auditCount = 0;
  let outdatedCount = 0;
  const undated: string[] = [];
  const unaudited: string[] = [];
  try {
    for (const e of used) {
      const got = await e.collect(deps);
      for (const d of got.deps) if (got.currentPublished[`${d.name}@${d.current}`] === null) undated.push(d.dir === "." ? d.name : `${d.dir}/${d.name}`);
      audits.push(...got.audits);
      notes.push(...got.notes);
      unaudited.push(...(got.unaudited ?? []));
      auditCount += got.audit.length;
      outdatedCount += got.outdated.length;
      rows = rows.concat(judge(got.deps, got.audit, now, got.currentPublished, e.name).rows);
    }
  } catch (e) {
    deps.err(`検査の道具が走らなかった: ${(e as Error).message}`);
    return 2;
  }
  // not a condition by itself (it would file a request every month for a package the registry does not date), and not
  // silent: a line of the output and of the body's 出典
  if (undated.length) {
    const line = `今の版の公開日が読めず 90 日の判定をしていない: ${[...new Set(undated)].join("、")}`;
    notes.push(line);
    audits.push(line);
  }
  for (const n of notes) deps.out(n);
  const prs = rows.length ? await deps.openPrs() : [];
  const split = excludeFiled(rows, prs ?? []);
  const unread = (prs ?? []).flatMap((p) => (p.unread ?? []).map((path) => `#${p.number} の ${path}`));
  const source: BodySource = { now, audits, filed: split.filed, prsRead: prs !== null, unread };
  const conditions = [...used.map((e) => e.conditions), ...opts.extraConditions];
  // a place whose vulnerabilities were not checked is in the summary too, so "脆弱性 0 件" is not read as "checked, none"
  const summary = `outdated ${outdatedCount} 件、脆弱性 ${auditCount} 件${unaudited.length ? `（${unaudited.join("、")} は未検査）` : ""}、条件に当たる ${split.rows.length} 件、既出 ${split.filed.length} 件`;
  const hit = split.rows.length > 0;
  if (!hit) {
    deps.out(`deps-check: 当たらない（${summary}）`);
    for (const f of split.filed) deps.out(`既出: ${f.name}（${f.prs.map((n) => `#${n}`).join("、")} が扱っている）`);
    // with no body, the part of the 既出 check that could not be done is said in the output
    for (const u of unread) deps.out(`既出の確認が一部できない: ${u}（GitHub が差分を省いた）`);
    if (!prs) deps.out("既出の確認なし（開いた PR を読めなかった）");
    if (opts.fileRequest) deps.out("要望: 当たらないので起票しない");
    return 0;
  }
  const body = buildBody(split.rows, source, conditions);
  deps.out(`deps-check: 当たった（${summary}）`);
  deps.out(body);
  if (!opts.fileRequest) return 1;
  const title = titleOf(now);
  try {
    const open = (await deps.openRequests()).find((r) => r.title === title);
    if (open && !open.ref.startsWith("#")) {
      // the app has not numbered it yet (its create waits to be sent): a comment needs the number, so this run adds nothing
      deps.out(`要望: 同じ題の要望 ${open.ref} が GitHub への送信待ち（番号なし）なので足さない`);
    } else if (open) {
      await deps.comment(open.ref, body);
      deps.out(`要望: 開いた要望 ${open.ref} に足した`);
    } else {
      const ref = await deps.fileRequest(title, body);
      deps.out(`要望: 起票した${ref ? ` ${ref}` : "（番号はアプリが後で付ける）"}`);
    }
  } catch (e) {
    deps.err(`要望を出せなかった: ${(e as Error).message}`);
    return 2;
  }
  return 1;
}

/** Writes `body` to a file in a fresh temp directory for the call, and removes it afterwards. */
export async function withBodyFile<T>(body: string, f: (file: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "deps-check."));
  try {
    const file = join(dir, "body.md");
    writeFileSync(file, body);
    return await f(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
