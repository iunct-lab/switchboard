/**
 * Kernel report (docs/design/process-kernel.md, K2 first step): the Tasks of a window grouped by their provenance — the
 * process candidate (with `--by-bundle`, also the skills bundle they were started with) — with, per group, how many, and the medians of their
 * duration, cost, the person's interventions and the instruction size. Observational: it shows n and leaves the judgement
 * to the reader; Tasks from before provenance was recorded are their own group.
 *
 *   bun scripts/kernel-report.ts [--days N] [--db <path>] [--json] [--by-bundle] [--baseline YYYY-MM-DD] [--repo-dir <git dir>]
 *
 * Reads the Switchboard database read-only (`--db`, else `$SWITCHBOARD_HOME/switchboard.db`, else `~/.switchboard/switchboard.db`).
 */
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provenance } from "../packages/protocol/src/index.ts";

export const NO_PROVENANCE = "記録なし";
/** Provenance recorded, but no process candidate named (a Task typed on Home): not the same as no record. */
export const NO_PROCESS = "候補なし";
export const SKILLS_PREFIX = 8;

export type ReasonKind = "button" | "auto" | "returned" | "other" | "none";

/**
 * Who chose the process, from `processReason` (the words the choosers write): the button (`direct button`,
 * `backlog stage <action>`), the automatic choice (`auto direct: …` / `auto pipeline: …`), a direct Task sent back to the
 * pipeline (`direct returned`). No reason recorded (no provenance, or none named) is `none`; any other text is `other`.
 */
export function reasonKind(reason: string | null | undefined): ReasonKind {
  if (typeof reason !== "string" || !reason) return "none";
  if (reason === "direct button" || reason.startsWith("backlog stage ")) return "button";
  if (reason.startsWith("auto ")) return "auto";
  if (reason === "direct returned") return "returned";
  return "other";
}

export type Stratum = {
  /** `<process id, 候補なし or 記録なし>`; with `byBundle`, `<that>@<skills hash prefix or ->` */
  key: string;
  process: string;
  skills: string;
  n: number;
  /** How many of the group's Tasks each kind of reason chose; sums to `n`. */
  reasons: Record<ReasonKind, number>;
  /** Done Tasks only (`status_at - created_at`); null when none is done. */
  durationMsMedian: number | null;
  /** Sum of the ledger's `cost_usd` per Task; null when no Task has a row. */
  costUsdMedian: number | null;
  /** `userInstructions + asks` of the Task's rules eval; null when no Task has one. */
  interventionsMedian: number | null;
  instructionBytesMedian: number | null;
};

/** One row of the "選び方の成績" table: how a kind of reason fared (see `reasonGroup`). */
export type ChoiceScore = { group: string; chosen: number; returned: number; merged: number };

export const DEFAULT_BASELINE = "2026-11-03";
export const OUTCOME_WINDOW_DAYS = 28;

/** The pull requests of one group (p0-pipeline or the rest) merged in a window, and how many of them were reworked (`reworkOf`). */
export type ReworkGroup = { n: number; reworked: number };
/**
 * One side (a 28-day window) of an outcome row: how many records it rests on, and their median (null when none). The rework
 * row has no median: `split` holds its two groups, and `n` is their sum (no `split` = git could not be read: no record).
 */
export type OutcomeSide = { n: number; value: number | null; split?: { p0: ReworkGroup; other: ReworkGroup } };
/**
 * One row of the "成果の条件" table: bytes = instruction size a Task starts with (median `instructionBytes`), closeDays = days
 * from a request's creation to its closing (median), rework = per group (p0-pipeline / the rest) the share of merged pull requests that were reworked.
 */
export type Outcome = { key: "bytes" | "closeDays" | "rework"; baseline: OutcomeSide; recent: OutcomeSide };

export type Report = { days: number; since: number; tasks: number; byBundle: boolean; strata: Stratum[]; choices: ChoiceScore[]; baselineDate: string; outcomes: Outcome[] };

/**
 * The kind of reason, with the numbers a chooser writes into it left out so equal rules count together:
 * `direct button` / `backlog stage <x>` → ボタン, `auto direct: <what> N 字 ≤ M` → `自動 direct: <what> ≤ M` (what was
 * measured — 本文 or 要望の文 — and the criterion's limit stay, the actual size goes), `auto pipeline: …` → 自動 pipeline, `direct returned` → 戻した.
 * Any other text is その他 (a schedule's reason), no reason at all is 理由なし.
 */
export function reasonGroup(reason: string | null | undefined): string {
  if (typeof reason !== "string" || !reason) return "理由なし";
  if (reason === "direct button" || reason.startsWith("backlog stage ")) return "ボタン";
  if (reason.startsWith("auto direct")) {
    const m = /^auto direct:\s*(\S+)\s+\d+\s*字\s*≤\s*(\d+)/.exec(reason);
    return m ? `自動 direct: ${m[1]} ≤ ${m[2]}` : "自動 direct";
  }
  if (reason.startsWith("auto pipeline")) return "自動 pipeline";
  if (reason === "direct returned") return "戻した";
  return "その他";
}

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

type Row = { id: string; status: string; created_at: number; status_at: number; provenance: string | null };

/** The repository of each workspace's backlog (`workspaces.backlog_source`); a workspace without a readable one is left out. */
function workspaceRepos(db: Database): Map<string, string> {
  const repoOf = new Map<string, string>();
  for (const w of db.query("SELECT id, backlog_source FROM workspaces WHERE backlog_source IS NOT NULL").all() as Array<{ id: string; backlog_source: string }>) {
    try {
      const repo = (JSON.parse(w.backlog_source) as { repository?: string }).repository;
      if (repo) repoOf.set(w.id, repo);
    } catch {
      /* an unreadable source has no repository */
    }
  }
  return repoOf;
}

/** A merged pull request as the stored PR record holds it (`mergedAt` is null on records from before it was stored). */
/** `files` is null when the record has no file list (an older record or one past the importer's limit): unknown, not empty. */
type MergedPr = { repository: string; number: number; closes: number[]; mergedAt: string | null; files: string[] | null; mergeCommit: string | null };

/** The stored PR records with `state = MERGED`. An unreadable record is left out. */
function mergedPullRequests(db: Database): MergedPr[] {
  const prs: MergedPr[] = [];
  for (const r of db.query("SELECT repository, remote FROM backlog_records WHERE object_kind = 'pull-request' AND remote IS NOT NULL").all() as Array<{ repository: string; remote: string }>) {
    try {
      const pr = JSON.parse(r.remote) as { number?: unknown; state?: string; closes?: unknown; mergedAt?: unknown; files?: unknown; mergeCommit?: unknown };
      if (pr.state !== "MERGED" || !Array.isArray(pr.closes)) continue;
      prs.push({
        repository: r.repository,
        number: typeof pr.number === "number" ? pr.number : -1,
        closes: pr.closes.filter((n): n is number => typeof n === "number"),
        mergedAt: typeof pr.mergedAt === "string" ? pr.mergedAt : null,
        files: Array.isArray(pr.files) ? pr.files.filter((f): f is string => typeof f === "string") : null,
        mergeCommit: typeof pr.mergeCommit === "string" ? pr.mergeCommit : null,
      });
    } catch {
      /* an unreadable record closes nothing */
    }
  }
  return prs;
}

/** Per repository, the parent of each issue (`parent` of the issue record): one level up, a PBI from its Task. */
function issueParents(db: Database): Map<string, Map<number, number>> {
  const parents = new Map<string, Map<number, number>>();
  for (const r of db.query("SELECT repository, remote FROM backlog_records WHERE object_kind = 'issue' AND remote IS NOT NULL").all() as Array<{ repository: string; remote: string }>) {
    try {
      const issue = JSON.parse(r.remote) as { number?: unknown; parent?: unknown };
      if (typeof issue.number !== "number" || typeof issue.parent !== "number") continue;
      const m = parents.get(r.repository) ?? new Map<number, number>();
      m.set(issue.number, issue.parent);
      parents.set(r.repository, m);
    } catch {
      /* an unreadable record has no parent */
    }
  }
  return parents;
}

/** A rework is a fix or a revert (a `git revert` subject starts with a capital R). */
const REWORK_SUBJECT = /^(fix|revert)\b/i;
/** Part of the definition, not a setting: a pull request is reworked by a fix/revert landing within this many days of its merge. */
export const REWORK_DAYS = 7;

export type GitCommit = { sha?: string; at: string; subject: string; files: string[] };

/**
 * The numbers of the pull requests that were reworked: a commit whose subject starts with `fix` or `revert`, committed from the
 * PR's merge to 7 days after it, touching at least one of the PR's files (the PR's own merge commit, `mergeCommit`, is not its rework).
 */
export function reworkOf(prs: Array<{ number: number; mergedAt: string; files: string[]; mergeCommit?: string | null }>, commits: GitCommit[]): Set<number> {
  const out = new Set<number>();
  const fixes = commits.filter((c) => REWORK_SUBJECT.test(c.subject)).map((c) => ({ ...c, t: Date.parse(c.at) }));
  for (const pr of prs) {
    const from = Date.parse(pr.mergedAt);
    if (!Number.isFinite(from)) continue;
    const files = new Set(pr.files);
    if (fixes.some((c) => c.t >= from && c.t <= from + REWORK_DAYS * 86_400_000 && !(c.sha && c.sha === pr.mergeCommit) && c.files.some((f) => files.has(f)))) out.add(pr.number);
  }
  return out;
}

/** What `readGit` found: the repository (`owner/name` of `origin`) the commits are of, and its main's commits since a time. */
export type GitHistory = { repository: string; commits: GitCommit[] };

/** `origin/main`'s commits since `sinceMs` with their files, of the repository at `dir`; null when git cannot be read there. */
export function readGit(dir: string, sinceMs: number): GitHistory | null {
  const git = (args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const remote = git(["remote", "get-url", "origin"]);
  const repository = remote.status === 0 ? /([^/:]+\/[^/]+?)(?:\.git)?\s*$/.exec(remote.stdout)?.[1] : undefined;
  if (!repository) return null;
  const log = git(["-c", "core.quotePath=false", "log", `--since=${new Date(sinceMs).toISOString()}`, "--name-only", "--format=%x01%H%x09%cI%x09%s", "origin/main"]);
  if (log.status !== 0) return null;
  const commits: GitCommit[] = [];
  for (const block of log.stdout.split("\x01").slice(1)) {
    const [head = "", ...files] = block.split("\n");
    const [sha, at, ...subject] = head.split("\t");
    if (sha && at) commits.push({ sha, at, subject: subject.join("\t"), files: files.filter(Boolean) });
  }
  return { repository, commits };
}

/**
 * Per kind of reason (`reasonGroup`), over the window's Tasks that name an issue (`stage_issue`, shadows left out): how many
 * were chosen; how many of the direct ones were later sent back (a Task with the reason `direct returned` on the same
 * workspace and issue, started after it); how many have a merged pull request closing that issue in the workspace's repository
 * (the stored PR record's `state = MERGED` and `closes`), or closing one of its sub-issues (the issue record's `parent`), so a
 * PBI whose Tasks merged counts as merged.
 */
function choiceScores(db: Database, since: number): ChoiceScore[] {
  const rows = db.query("SELECT workspace_id, stage_issue, stage_action, created_at, provenance FROM tasks WHERE created_at >= ? AND shadow_of IS NULL AND stage_issue IS NOT NULL").all(since) as Array<{ workspace_id: string | null; stage_issue: number; stage_action: string | null; created_at: number; provenance: string | null }>;
  const reasonOf = (raw: string | null): string | null => {
    try {
      return raw ? ((JSON.parse(raw) as Provenance).processReason ?? null) : null;
    } catch {
      return null;
    }
  };
  // the returns of the window (a return is started after the direct Task it sends back, so one before the window cannot matter)
  const returnedAt = new Map<string, number[]>();
  for (const r of db.query("SELECT workspace_id, stage_issue, created_at, provenance FROM tasks WHERE stage_issue IS NOT NULL AND shadow_of IS NULL AND created_at >= ?").all(since) as Array<{ workspace_id: string | null; stage_issue: number; created_at: number; provenance: string | null }>) {
    if (reasonOf(r.provenance) !== "direct returned") continue;
    const k = `${r.workspace_id}#${r.stage_issue}`;
    returnedAt.set(k, [...(returnedAt.get(k) ?? []), r.created_at]);
  }
  const repoOf = workspaceRepos(db);
  // per repository, the issues a merged PR closes, then their parents (one level: a PBI whose Task merged)
  const merged = new Map<string, Set<number>>();
  for (const pr of mergedPullRequests(db)) {
    const set = merged.get(pr.repository) ?? new Set<number>();
    for (const n of pr.closes) set.add(n);
    merged.set(pr.repository, set);
  }
  // the parents are read against the closed issues alone (not the set being added to), so one level only, whatever the order
  for (const [repository, parents] of issueParents(db)) {
    const set = merged.get(repository);
    if (!set) continue;
    const up = [...parents].filter(([number]) => set.has(number)).map(([, parent]) => parent);
    for (const p of up) set.add(p);
  }
  const groups = new Map<string, ChoiceScore>();
  for (const t of rows) {
    const group = reasonGroup(reasonOf(t.provenance));
    const g = groups.get(group) ?? { group, chosen: 0, returned: 0, merged: 0 };
    g.chosen++;
    if (t.stage_action === "direct" && (returnedAt.get(`${t.workspace_id}#${t.stage_issue}`) ?? []).some((at) => at > t.created_at)) g.returned++;
    const repo = t.workspace_id ? repoOf.get(t.workspace_id) : undefined;
    if (repo && merged.get(repo)?.has(t.stage_issue)) g.merged++;
    groups.set(group, g);
  }
  return [...groups.values()].sort((a, b) => b.chosen - a.chosen || a.group.localeCompare(b.group));
}

/**
 * The "成果の条件" rows over two 28-day windows: the one before `baselineMs` and the one before `now`. bytes: the window's Tasks
 * (shadows left out) by `created_at`. closeDays: the requests (issue records labelled `type:request`, CLOSED) of the repositories
 * the workspaces' backlogs point at (as `choiceScores` reads them) that closed in the window. Nothing is judged here.
 */
const noOutcomes = (): Outcome[] => (["bytes", "closeDays", "rework"] as const).map((key) => ({ key, baseline: { n: 0, value: null }, recent: { n: 0, value: null } }));

function outcomes(db: Database, baselineMs: number, now: number, git: GitHistory | null): Outcome[] {
  const win = OUTCOME_WINDOW_DAYS * 86_400_000;
  const windows = { baseline: [baselineMs - win, baselineMs], recent: [now - win, now] } as const;
  const bytes = { baseline: [] as number[], recent: [] as number[] };
  for (const t of db.query("SELECT created_at, provenance FROM tasks WHERE shadow_of IS NULL AND provenance IS NOT NULL AND created_at >= ? AND created_at < ?").all(Math.min(windows.baseline[0], windows.recent[0]), Math.max(baselineMs, now)) as Array<{ created_at: number; provenance: string }>) {
    let b: unknown;
    try {
      b = (JSON.parse(t.provenance) as Provenance).instructionBytes;
    } catch {
      continue;
    }
    if (typeof b !== "number") continue;
    for (const k of ["baseline", "recent"] as const) if (t.created_at >= windows[k][0] && t.created_at < windows[k][1]) bytes[k].push(b);
  }
  const days = { baseline: [] as number[], recent: [] as number[] };
  const repos = new Set(workspaceRepos(db).values());
  for (const r of db.query("SELECT repository, remote FROM backlog_records WHERE object_kind = 'issue' AND remote IS NOT NULL").all() as Array<{ repository: string; remote: string }>) {
    if (!repos.has(r.repository)) continue;
    try {
      const i = JSON.parse(r.remote) as { state?: string; labels?: unknown; createdAt?: string; closedAt?: string | null };
      if (i.state !== "CLOSED" || !Array.isArray(i.labels) || !i.labels.includes("type:request")) continue;
      const created = Date.parse(i.createdAt ?? "");
      const closed = Date.parse(i.closedAt ?? "");
      if (!Number.isFinite(created) || !Number.isFinite(closed) || closed < created) continue;
      for (const k of ["baseline", "recent"] as const) if (closed >= windows[k][0] && closed < windows[k][1]) days[k].push((closed - created) / 86_400_000);
    } catch {
      /* an unreadable record is no request */
    }
  }
  const side = (xs: number[]): OutcomeSide => ({ n: xs.length, value: median(xs) });
  return [
    { key: "bytes", baseline: side(bytes.baseline), recent: side(bytes.recent) },
    { key: "closeDays", baseline: side(days.baseline), recent: side(days.recent) },
    { key: "rework", ...reworkSides(db, windows, git) },
  ];
}

/**
 * The rework row: the pull requests merged in each window (stored `mergedAt`; a record without it cannot be dated and is left
 * out) in the repository `git` is of, split by who did the work: a PR belongs to p0-pipeline when a Task of that process names
 * (`stage_issue`) an issue the PR closes or the parent of one (as `choiceScores` reads merges), else to the rest when such a Task
 * has some other recorded process (or none named); a PR no Task names, or only a Task with no provenance, is in neither.
 * No git history: no record (no `split`).
 */
function reworkSides(db: Database, windows: Record<"baseline" | "recent", readonly [number, number]>, git: GitHistory | null): { baseline: OutcomeSide; recent: OutcomeSide } {
  if (!git) return { baseline: { n: 0, value: null }, recent: { n: 0, value: null } };
  const repoOf = workspaceRepos(db);
  const taskGroup = new Map<number, "p0" | "other">();
  for (const t of db.query("SELECT workspace_id, stage_issue, provenance FROM tasks WHERE shadow_of IS NULL AND stage_issue IS NOT NULL AND provenance IS NOT NULL").all() as Array<{ workspace_id: string | null; stage_issue: number; provenance: string }>) {
    if (!t.workspace_id || repoOf.get(t.workspace_id) !== git.repository) continue;
    let p: Provenance;
    try {
      p = JSON.parse(t.provenance) as Provenance;
    } catch {
      continue;
    }
    if (!p || typeof p !== "object" || !p.bundle || typeof p.bundle !== "object") continue;
    if (p.process?.id === "p0-pipeline" || !taskGroup.has(t.stage_issue)) taskGroup.set(t.stage_issue, p.process?.id === "p0-pipeline" ? "p0" : "other");
  }
  const parents = issueParents(db).get(git.repository) ?? new Map<number, number>();
  const prs = mergedPullRequests(db).flatMap((pr) => {
    if (pr.repository !== git.repository || pr.mergedAt === null || pr.files === null) return []; // without a date or a file list it cannot be judged
    const groups = pr.closes.flatMap((n) => [taskGroup.get(n), taskGroup.get(parents.get(n) ?? -1)]);
    const group = groups.includes("p0") ? "p0" : groups.includes("other") ? "other" : null;
    const { mergedAt, files } = pr;
    return group ? [{ number: pr.number, mergedAt, files, mergeCommit: pr.mergeCommit, group }] : [];
  });
  const reworked = reworkOf(prs, git.commits);
  const side = (k: "baseline" | "recent"): OutcomeSide => {
    const split = { p0: { n: 0, reworked: 0 }, other: { n: 0, reworked: 0 } };
    for (const pr of prs) {
      const at = Date.parse(pr.mergedAt);
      if (!(at >= windows[k][0] && at < windows[k][1])) continue;
      split[pr.group].n++;
      if (reworked.has(pr.number)) split[pr.group].reworked++;
    }
    return { n: split.p0.n + split.other.n, value: null, split };
  };
  return { baseline: side("baseline"), recent: side("recent") };
}

/** The baseline date is the end of that day (UTC): the window is the 28 days up to and including it. */
export const baselineEndMs = (date: string | undefined): number => Date.parse(`${date ?? DEFAULT_BASELINE}T00:00:00Z`) + 86_400_000;

/** `git`: the history the rework row reads (`readGit`); none given or null = that row has no record. */
export function kernelReport(db: Database, opts: { days: number; now?: number; byBundle?: boolean; baseline?: string; git?: GitHistory | null }): Report {
  const now = opts.now ?? Date.now();
  const byBundle = opts.byBundle ?? false;
  const since = now - opts.days * 86_400_000;
  // a database an older daemon still owns has no provenance column yet (the read-only report never migrates it): every Task is then 記録なし
  const hasProvenance = (db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).some((c) => c.name === "provenance");
  const rows = db.query(`SELECT id, status, created_at, status_at, ${hasProvenance ? "provenance" : "NULL AS provenance"} FROM tasks WHERE created_at >= ? AND shadow_of IS NULL`).all(since) as Row[];
  const cost = new Map((db.query("SELECT task_id, SUM(cost_usd) AS c FROM ledger GROUP BY task_id").all() as Array<{ task_id: string; c: number }>).map((r) => [r.task_id, r.c]));
  const evals = new Map<string, number>();
  for (const r of db.query("SELECT task_id, json FROM task_evals WHERE source = 'rules'").all() as Array<{ task_id: string; json: string }>) {
    try {
      const m = (JSON.parse(r.json) as { metrics?: { userInstructions?: number; asks?: number } }).metrics;
      if (m && typeof m.userInstructions === "number" && typeof m.asks === "number") evals.set(r.task_id, m.userInstructions + m.asks);
    } catch {
      /* an unreadable eval counts as none */
    }
  }
  const groups = new Map<string, { process: string; skills: string; duration: number[]; cost: number[]; interventions: number[]; bytes: number[]; n: number; reasons: Record<ReasonKind, number> }>();
  for (const r of rows) {
    let p: Provenance | null = null;
    if (r.provenance) {
      try {
        p = JSON.parse(r.provenance) as Provenance;
      } catch {
        p = null;
      }
    }
    // a record without its bundle (a hand-edited or future shape) is not a record this report can read: 記録なし, like an unreadable row
    if (p && (typeof p !== "object" || !p.bundle || typeof p.bundle !== "object")) p = null;
    const processId = p ? p.process?.id ?? NO_PROCESS : NO_PROVENANCE;
    const skills = byBundle && p?.bundle.skills ? p.bundle.skills.slice(0, SKILLS_PREFIX) : "-";
    const key = byBundle ? `${processId}@${skills}` : processId;
    const g = groups.get(key) ?? { process: processId, skills, duration: [], cost: [], interventions: [], bytes: [], n: 0, reasons: { button: 0, auto: 0, returned: 0, other: 0, none: 0 } };
    g.n++;
    g.reasons[reasonKind(p?.processReason)]++;
    if (r.status === "done") g.duration.push(r.status_at - r.created_at);
    const c = cost.get(r.id);
    if (c !== undefined) g.cost.push(c);
    const i = evals.get(r.id);
    if (i !== undefined) g.interventions.push(i);
    if (p && typeof p.instructionBytes === "number") g.bytes.push(p.instructionBytes);
    groups.set(key, g);
  }
  // the columns and tables the choices read are older than provenance; without provenance (an older daemon's database) there are no reasons to group
  const choices = hasProvenance ? choiceScores(db, since) : [];
  const strata = [...groups.entries()]
    .map(([key, g]) => ({ key, process: g.process, skills: g.skills, n: g.n, reasons: g.reasons, durationMsMedian: median(g.duration), costUsdMedian: median(g.cost), interventionsMedian: median(g.interventions), instructionBytesMedian: median(g.bytes) }))
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));
  const baselineDate = opts.baseline ?? DEFAULT_BASELINE;
  const baselineMs = baselineEndMs(baselineDate);
  if (!Number.isFinite(baselineMs)) throw new Error(`--baseline must be a date (YYYY-MM-DD): ${baselineDate}`);
  return { days: opts.days, since, tasks: rows.length, byBundle, strata, choices, baselineDate, outcomes: hasProvenance ? outcomes(db, baselineMs, now, opts.git ?? null) : noOutcomes() };
}

const fmtMs = (ms: number | null) => (ms === null ? "-" : `${(ms / 60_000).toFixed(1)} 分`);
const fmtUsd = (x: number | null) => (x === null ? "-" : `$${x.toFixed(2)}`);
const fmtNum = (x: number | null) => (x === null ? "-" : String(Math.round(x * 10) / 10));
const fmtBytes = (x: number | null) => (x === null ? "-" : `${Math.round(x / 1024)} KB`);

const fmtReasons = (x: Record<ReasonKind, number>) => `ボタン ${x.button} / 自動 ${x.auto} / 戻した ${x.returned}${x.other ? ` / その他 ${x.other}` : ""}`;

const OUTCOME_LABELS: Record<Outcome["key"], { label: string; fmt: (x: number) => string }> = {
  bytes: { label: "b. Task が読み始める命令の大きさ（中央値）", fmt: (x) => fmtBytes(x) },
  closeDays: { label: "c. 要望が閉じるまでの日数（中央値）", fmt: (x) => `${Math.round(x * 10) / 10} 日` },
  rework: { label: "a. 再作業（直した後にまた直す）", fmt: (x) => String(x) },
};

/** The rework cell: the two groups' shares side by side (a group with no pull request reads 記録なし); the whole cell when git could not be read. */
const fmtRework = (x: OutcomeSide): string => {
  if (!x.split || x.n === 0) return NO_PROVENANCE;
  const g = (label: string, v: ReworkGroup) => `${label} ${v.n === 0 ? NO_PROVENANCE : `${Math.round((100 * v.reworked) / v.n)}%`}`;
  return `${g("p0-pipeline", x.split.p0)} / ${g("それ以外", x.split.other)}`;
};
const fmtReworkN = (x: OutcomeSide): string => (x.split ? `${x.split.p0.n} + ${x.split.other.n}` : "0");

export function renderReport(r: Report): string {
  const lines = [`# カーネルの報告 — 直近 ${r.days} 日の Task ${r.tasks} 件（${new Date(r.since).toISOString().slice(0, 10)} 以降、shadow を除く）`, ""];
  const bundleHead = r.byBundle ? " スキルの束 |" : "";
  lines.push(`| プロセス |${bundleHead} n | 選んだ理由 | 所要時間の中央値（done） | 費用の中央値 | 介入の中央値 | 命令の大きさの中央値 |`, `|---|${r.byBundle ? "---|" : ""}---:|---|---:|---:|---:|---:|`);
  for (const s of r.strata) lines.push(`| ${s.process} |${r.byBundle ? ` ${s.skills} |` : ""} ${s.n} | ${fmtReasons(s.reasons)} | ${fmtMs(s.durationMsMedian)} | ${fmtUsd(s.costUsdMedian)} | ${fmtNum(s.interventionsMedian)} | ${fmtBytes(s.instructionBytesMedian)} |`);
  lines.push("", `層別は観察で、決着ではない（候補（プロセス）だけで分ける。スキルの束でも分けるには --by-bundle。n と幅を見る。費用は API 相当の見積、介入は rules の評価がある Task だけ。${NO_PROVENANCE} = 由来の記録が無い Task、${NO_PROCESS} = 記録はあるが候補を名指ししていない Task。選んだ理由は processReason の語で分け、理由が無い Task は ボタン・自動・戻した のどれにも入らない）。`);
  lines.push("", "## 選び方の成績", "", "| 選んだ理由 | 選ばれた数 | 直行から戻された数 | マージまで行った数 |", "|---|---:|---:|---:|");
  for (const c of r.choices) lines.push(`| ${c.group} | ${c.chosen} | ${c.returned} | ${c.merged} |`);
  lines.push("", "Issue に結びついた Task（stage_issue あり）だけを数える。戻された数は直行（direct）の Task のうち、同じ Issue に後から「戻した」Task があるもの。マージまでは、その workspace のリポジトリの PR 記録に、その Issue かその sub-issue（1 段下。PBI の Task）を閉じるマージ済みの PR があるもの（Task が出した PR とは限らない。要望から PBI へのつながりは追わない）。基準は仮の出発点。見直す材料であって決着ではない。");
  lines.push("", `## 成果の条件（基準日 ${r.baselineDate} までの ${OUTCOME_WINDOW_DAYS} 日と、直近 ${OUTCOME_WINDOW_DAYS} 日）`, "", `| 行 | ${r.baselineDate} まで | 直近 | n（基準日まで / 直近） |`, "|---|---:|---:|---:|");
  const cell = (x: OutcomeSide, fmt: (v: number) => string) => (x.n === 0 || x.value === null ? NO_PROVENANCE : fmt(x.value));
  for (const o of r.outcomes) {
    if (o.key === "rework") lines.push(`| ${OUTCOME_LABELS.rework.label} | ${fmtRework(o.baseline)} | ${fmtRework(o.recent)} | ${fmtReworkN(o.baseline)} / ${fmtReworkN(o.recent)} |`);
    else lines.push(`| ${OUTCOME_LABELS[o.key].label} | ${cell(o.baseline, OUTCOME_LABELS[o.key].fmt)} | ${cell(o.recent, OUTCOME_LABELS[o.key].fmt)} | ${o.baseline.n} / ${o.recent.n} |`);
  }
  lines.push("", "値を並べるだけで、良し悪しは書かない（利用者が決める）。b は窓内に始めた Task（shadow を除く）の由来の記録から、c は窓内に閉じた要望（type:request）のうち、workspace のバックログが指すリポジトリのものから。a は窓内にマージされた PR（PR 記録の mergedAt があるもの）のうち、p0-pipeline の Task が出した仕事とそれ以外の Task が出した仕事（PR が閉じた Issue かその親を、Task が stage_issue に持つもの。由来の記録が無い Task の PR は入れない）に分け、main のコミット（fix / revert で始まる題、PR のマージから 7 日以内、同じファイルを触る。PR 自身のマージコミットは除く）で再作業になった割合。a の n は「p0-pipeline の PR 数 + それ以外の PR 数」。git が読めなければ記録なし。");
  return lines.join("\n");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
}

if (import.meta.main) {
  const days = Number(arg("--days") ?? 30);
  if (!Number.isFinite(days) || days <= 0) {
    console.error("--days must be a positive number");
    process.exit(1);
  }
  const dbPath = arg("--db") ?? join(process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard"), "switchboard.db");
  if (!existsSync(dbPath)) {
    console.error(`no database at ${dbPath}`);
    process.exit(2);
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const baseline = arg("--baseline");
    // the rework row reads main's commits from the oldest window's start on (`--repo-dir`, else the current directory)
    const git = readGit(arg("--repo-dir") ?? process.cwd(), Math.min(baselineEndMs(baseline), Date.now()) - OUTCOME_WINDOW_DAYS * 86_400_000);
    const report = kernelReport(db, { days, byBundle: process.argv.includes("--by-bundle"), baseline, git });
    console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : renderReport(report));
  } finally {
    db.close();
  }
}
