import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { currentRepo, originRepo } from "./repo.ts";
import { sh } from "./local-ci";
import { forgeTargetOf, originOf, type ForgeTarget } from "../ops-kit/src/forge.ts";
import { mergeGitlabMr, readGitlabMerge, runGlab, type Sh } from "../ops-kit/src/forge-gitlab.ts";
import { linkedIssues } from "./task-paths.ts";
import { overlaps, scopeIn } from "../ops-kit/src/task-paths.ts";
import { client, runBacklog, type Detail, type StoredRecords } from "../ops-kit/src/backlog-client.ts";
import { CONFIG_FILE, sharedFilesOf } from "../ops-kit/src/config.ts";
import { LIMIT_FILES, limitsRaisedOf } from "./merge-gate-limits.ts";
import { markedLinesTouched } from "./merge-gate-rules.ts";
import { heldSettingsOf, type HeldSettings } from "./workspace-settings.ts";
import { mergeRecords, type MergeRecordJob, type MergeRecords } from "../ops-kit/src/merge-records.ts";
import { mergeRecordsEnv } from "./merge-records-env.ts";
import { attackedOf, ciAtTips, ciOf, rechecksOf, reviewedOf } from "./merge-gate-records.ts";

export const LARGE_LINES = 300;

export const PROTECTED = [
  "rescue/**",
  ".github/**",
  "packages/core/src/db.ts",
  "packages/core/src/db/**",
  "packages/core/src/schema-baseline.json",
  "packages/core/src/auth.ts",
  "packages/core/src/approval.ts",
  "packages/core/src/selfdev.ts",
  "packages/core/config/**",
  "scripts/setup/**",
  ".claude/skills/**",
  "ops-kit/skills/**",
  "package.json",
  "bun.lock",
].map((p) => new Bun.Glob(p));

/**
 * Rules for any repository (--repo too): a PR touching one of these is large whatever its size, with the class as the reason.
 * Security: a path word (split at / . _ -, lower-cased) in SECURITY_WORDS, or a path of SECURITY_GROUPS (CI and repository
 * settings, lock files — adding a dependency changes the lock —, the gates, the host scripts) or SECURITY_WORD_FILES (secrets
 * files). Instructions: CLAUDE.md, AGENTS.md and the skills, asked of the owner. Responsibility: the operating settings
 * (ops.config.json); README.md's `## Design rules` section is judged per line (designRulesTouched).
 */
export const SECURITY_WORDS = ["auth", "approval", "permission", "permissions", "secret", "secrets", "credential", "credentials", "token", "tokens", "crypto", "sandbox"];
/**
 * The security reason split by the group of paths it met, so the asks and answers count per group and a group
 * the user approves can move to a recheck later. docs: a document only (decided before the others, alone); words: a path
 * word or a secrets file; the rest: SECURITY_GROUPS. A path in two groups is in both (a yes for one does not lift the other).
 * tests: a path word or a host path met only by what runs neither in production nor as root on the host — a test, a
 * fixture, or a host file that differs only in comment and blank lines (`commentOnlyChange`; decided before words and
 * host, alone). A file is judged by its path before a rename too, and only when how it changed is known (`fileSecurityKinds`).
 */
export const SECURITY_KINDS = ["security:docs", "security:tests", "security:words", "security:lockfile", "security:github", "security:gates", "security:host"] as const;
export type SecurityKind = (typeof SECURITY_KINDS)[number];
const glob = (ps: string[]) => ps.map((p) => new Bun.Glob(p));
/** Secrets files: in the words group (they hold the secrets the words name). */
const SECURITY_WORD_FILES = glob(["**/.env*", "**/.gitleaks.toml"]);
export const SECURITY_GROUPS: Record<Exclude<SecurityKind, "security:docs" | "security:tests" | "security:words">, Bun.Glob[]> = {
  "security:lockfile": glob(["**/{bun.lock,package-lock.json,pnpm-lock.yaml,yarn.lock,uv.lock,poetry.lock,go.sum,Cargo.lock}", "**/requirements*.txt"]),
  "security:github": glob([".github/**"]),
  // the gate and local CI decide merges like CI does, local-merge makes them and forge-resync pushes the sync branch that becomes a PR:
  // a small change to them is still the user's to approve
  "security:gates": glob(["scripts/merge-gate.ts", "scripts/merge-gate-limits.ts", "scripts/merge-gate-rules.ts", "ops-kit/reversibility.json", "scripts/local-ci.ts", "scripts/local-merge.ts", "scripts/forge-resync.ts"]),
  // Switchboard's own (a --repo without aws/host never meets it): the cloud host runs main's host scripts as root at
  // every start (sb-host-update)
  "security:host": glob(["aws/host/**"]),
};
/**
 * Documents that instruct the Task (skills, CLAUDE.md, AGENTS.md) are not security:docs: they decide what a Task does. Nor is
 * a .md under .github (the PR and Issue templates are inputs of the development, and GitHub reads them as settings).
 */
const INSTRUCTIONS = glob([".claude/skills/**", "ops-kit/skills/**", "**/CLAUDE.md", "**/AGENTS.md", ".github/**"]);
/** Tests and fixtures: they run in CI and local CI only (security:tests). */
const SECURITY_TEST_FILES = glob(["**/*.test.ts", "scripts/*-e2e.ts", "**/fixtures/**"]);
/** The host files where a line starting with `#` is a comment (shell, systemd units, YAML): only these can be comment-only. */
export const HOST_COMMENT_FILES = glob(["aws/host/**/*.{sh,service,timer,yml,yaml}"]);
const HOST_ROOT_NOTE = "（aws/host は起動のたびに root が main から入れて走らせる。root で走る範囲が増えるなら main の保護の見直しの契機: docs/design/cloud-hosting.md §6.5）";
// Design documents are not here: they do not decide what a Task does, and a PR fixes them with the change, so they would
// match nearly every PR. Whether a PBI's scope holds for them is the main review's (cross-runner-review).
export const RESPONSIBILITY = ["ops.config.json"].map((p) => new Bun.Glob(p));
/** The files that instruct the Task: the owner reads their diff (`instructions`), and they come alone, with tests at most. */
export const INSTRUCTIONS_FILES = ["**/CLAUDE.md", "**/AGENTS.md", ".claude/skills/**", "ops-kit/skills/**"].map((p) => new Bun.Glob(p));
const DESIGN_RULES = "README.md の ## Design rules";

/**
 * Two kinds of large reason. Ask: only the user lifts it (--allow-large) — the security groups the table answers
 * irreversible. Recheck: a `[recheck] <kind> pass <head sha>` PR comment lifts it, per kind (size: line count and the other
 * protected paths; responsibility: ops.config.json; migration: MIGRATION; rescue: RESCUE, the rollback itself;
 * design-rules: README.md's Design rules; security:docs, security:tests and security:lockfile: the security groups the
 * owner moved to a recheck, docs/design/merge-gate.md).
 */
export type RecheckKind = "size" | "responsibility" | "migration" | "rescue" | "design-rules" | "security:docs" | "security:tests" | "security:lockfile";
export type AskKind = SecurityKind | "instructions" | "limits";
/** The words of the record marks, in this order: who lifted which kind of a large PR. */
export const MERGE_KINDS = [...SECURITY_KINDS, "rescue", "design-rules", "size", "instructions", "responsibility", "migration", "limits"] as const;
export type MergeKind = (typeof MERGE_KINDS)[number];

/**
 * The split into ask and recheck comes from the reversibility table (ops-kit/reversibility.json, docs/design/process-kernel.md K3):
 * a gateKind whose answer is `irreversible` is asked of the user, any other is lifted by a recheck. The globs stay here.
 * Throws, with the reason, on a table of the wrong shape (unknown effect or answer, a repeated or missing kind).
 */
export const REVERSIBILITY_PATH = join(import.meta.dir, "..", "ops-kit", "reversibility.json");
/** The fixed vocabulary of the table: the file must list exactly these, so a table cannot widen its own words. */
const EFFECTS = ["repository", "state", "external", "person"];
const ANSWERS = ["reversible", "compensable", "irreversible"];
export function loadReversibility(path = REVERSIBILITY_PATH): { ask: AskKind[]; recheck: RecheckKind[]; reversible: string[] } {
  const t = JSON.parse(readFileSync(path, "utf8"));
  const bad = (m: string): never => { throw new Error(`reversibility table ${path}: ${m}`); };
  if (t?.v !== 1 || !Array.isArray(t.effects) || !Array.isArray(t.answers) || !Array.isArray(t.rows)) bad("expected { v: 1, effects, answers, rows }");
  if (JSON.stringify(t.effects) !== JSON.stringify(EFFECTS)) bad(`effects must be ${JSON.stringify(EFFECTS)}`);
  if (JSON.stringify(t.answers) !== JSON.stringify(ANSWERS)) bad(`answers must be ${JSON.stringify(ANSWERS)}`);
  const ask: string[] = [];
  const recheck: string[] = [];
  const reversible: string[] = [];
  const seen = new Set<string>();
  for (const row of t.rows) {
    if (!t.effects.includes(row.effect)) bad(`unknown effect ${JSON.stringify(row.effect)} in "${row.op}"`);
    if (!t.answers.includes(row.answer)) bad(`unknown answer ${JSON.stringify(row.answer)} in "${row.op}"`);
    if (row.gateKind == null) continue;
    if (seen.has(row.gateKind)) bad(`kind ${row.gateKind} appears twice`);
    seen.add(row.gateKind);
    (row.answer === "irreversible" ? ask : recheck).push(row.gateKind);
    if (row.answer === "reversible") reversible.push(row.gateKind);
  }
  const missing = MERGE_KINDS.filter((k) => !seen.has(k));
  if (missing.length) bad(`kinds missing: ${missing.join(", ")}`);
  const unknown = [...seen].filter((k) => !(MERGE_KINDS as readonly string[]).includes(k));
  if (unknown.length) bad(`unknown kinds: ${unknown.join(", ")}`);
  return { ask: ask as AskKind[], recheck: recheck as RecheckKind[], reversible };
}
const REVERSIBILITY = loadReversibility();
export const RECHECK_KINDS: RecheckKind[] = REVERSIBILITY.recheck;
export const ASK_KINDS: AskKind[] = REVERSIBILITY.ask;
/** The kinds the table answers `reversible`: a direct PR (one the app started a Task to merge as a direct one) touching only these skips the main review. */
const REVERSIBLE_KINDS: string[] = REVERSIBILITY.reversible;
/** The mark `mergePr` puts on a PR merged without a main review (direct, no large reason): `[merge-direct] <head sha>`. */
export const MERGE_DIRECT = /^\[merge-direct\] ([0-9a-f]{40})\b/;
/**
 * The mark of the ask: `[merge-ask] <kinds> <head sha>` (kinds comma-separated). The answer on the Task's ask reads it for the
 * head it was asked at; the verdict reads none (--allow-large needs the app's record of the person's grant: judge).
 */
export const MERGE_ASK = /^\[merge-ask\] ([a-z:-]+(?:,[a-z:-]+)*) ([0-9a-f]{40})\b/;
export const RESCUE = ["rescue/**"].map((p) => new Bun.Glob(p));
export const MIGRATION = ["packages/core/src/db.ts", "packages/core/src/db/**", "packages/core/src/schema-baseline.json"].map((p) => new Bun.Glob(p));
const DESIGN_RULES_HEADING = /^## Design rules[ \t]*$/m;

const TESTS = ["**/*.test.ts", "scripts/*-e2e.ts"].map((p) => new Bun.Glob(p));
const DOCS = ["docs/**", "**/*.md"].map((p) => new Bun.Glob(p));
/**
 * Paths that need an attacking review besides the security groups they may not be in: what moves a release, the rescue,
 * the way in from outside and what a Task may run. Switchboard's own paths, applied to every --repo as they are (like
 * `security:host`): another repository with the same paths also needs the attacking review.
 */
export const ATTACK_PATHS = glob(["packages/core/src/promotion.ts", "packages/core/src/server/promotion.ts", "scripts/promote.ts", "rescue/**", "packages/core/src/uplink-in.ts", ".claude/settings.json", "ops-kit/bin/**"]);
/** Only these comment authors' marks count (the audits of the marks read them; the verdict reads no comment): on a public --repo anyone can comment. */
export const MARK_AUTHORS = ["OWNER", "MEMBER", "COLLABORATOR"];

export type FileStatus = "added" | "removed" | "renamed" | "copied" | "modified" | "changed";

export interface PrFacts {
  /**
   * `status`: how the file changed; `previous`: its path before a rename or a copy (always with those two). Absent, or
   * `changed` (the file's type changed), = not known: the file is then no test, fixture or document for the security
   * groups (`fileSecurityKinds`), so every reader states it. A reader that cannot tell a rename lists both paths.
   * `commentOnly`: a host file read whole on both sides that differs only in comment and blank lines (`commentOnlyChange`); absent = not so, or not read.
   */
  files: { path: string; additions: number; deletions: number; status?: FileStatus; previous?: string; commentOnly?: boolean }[];
  /** What the PR changes in ops.config.json (`configScopeOf`); absent = it does not touch the file, or the change was not read. */
  configScope?: ConfigScope;
  checks: { name: string; conclusion: string }[];
  /** README.md's `## Design rules` section changed (designRulesTouched); absent = not. */
  designRulesTouched?: boolean;
  /** `<path>:<line of the base>` of the user-marked lines an instruction file's change deletes or rewrites (markedLinesTouched); absent = none. */
  userRulesTouched?: string[];
  /** What the PR raises in the limit files (`limitsRaised`, one line each); absent = nothing, or the change was not read. */
  limitsRaised?: string[];
  /** A CI run that never started, or none, was replaced by the local pass of the head and the base's tip; GitHub still calls the PR UNSTABLE for a failed run. */
  localCi?: boolean;
  /** Why the PR's local-ci results did not count (an older base, a newer fail); absent = none, or one counted. */
  localCiNote?: string;
  /**
   * The settings Switchboard keeps for the clone's workspace, as the person confirmed them (`heldSettingsOf`): the version
   * the judgement names, and whether a change of them waits for the person. Absent = the clone has its own
   * `ops.config.json`, or nothing is kept.
   */
  held?: HeldSettings;
  /** The kinds the app's recheck jobs satisfy at the head (`rechecksOf`); absent = none. */
  rechecks?: RecheckKind[];
  /** The app ran a main review of the head that passed and left its findings (`reviewedOf`); absent = none. */
  reviewed?: true;
  /** The same for the attacking-side review (`attackedOf`); absent = none. */
  attacked?: true;
  unresolvedThreads: number;
  /**
   * A local change that stands in for this GitHub PR while GitHub cannot be read: its review threads are not known, so it
   * is not merged here. The PR is the one the change was made with, else an open PR the stored records have for an Issue
   * the change closes (`standsInFor`): it does not rest on the Task having named it. Absent = none known.
   */
  threadsUnread?: number;
  /**
   * A local change in a GitHub workspace whose branch was pushed to origin (it has a remote-tracking ref): a PR of it may
   * exist that the stored records do not have yet, with review threads nobody can read now. Not merged here. Absent = not so.
   */
  threadsUnknown?: string;
  mergeState: string;
  /**
   * The app holds the person's grant of this head for the Task that runs the gate (`GET /api/merge-records`), or the
   * person runs the gate themselves, outside a Task (`appRecords`): `--allow-large` then lifts the ask reasons. Absent =
   * no grant. A comment of the PR says nothing here: the verdict reads no comment.
   */
  granted?: boolean;
  /** How the person names this in the sentence that grants it (`PR #12`, `変更 L7`); absent = a PR, named by its number. */
  subject?: string;
  /** The head's sha (a grant is of one head; --merge merges only this head); absent = not read. */
  head?: string;
  /** The app started the Task that opened this as a direct one (`records.direct`): with no large reason it needs no main review. The branch's name says nothing. */
  direct?: boolean;
  /** The base branch (--merge-stack checks the stack's order by it); absent = not read. */
  base?: string;
  /** The head branch (--merge-stack: the branch the PR above must be based on); absent = not read. */
  branch?: string;
  /** The Tasks the PR closes: the paths their bodies name, and what the other Tasks of their PBIs name; absent = the PR closes no Task. */
  task?: { numbers: number[]; named: string[]; siblings: { number: number; paths: string[] }[] };
}

export interface Judgement {
  verdict: "merge" | "stop";
  impact: "small" | "large";
  reasons: string[];
  /** The ask kinds among the large reasons (kept with --allow-large: what the user's yes lifted). */
  ask: AskKind[];
  /** The recheck kinds among the large reasons that have no mark of the head yet. */
  recheck: RecheckKind[];
  /** Every recheck kind the change asks for, those already recorded for the head too (what `[再チェック <kind>]` reasons are built from); absent = none. */
  required?: RecheckKind[];
  /** What was not checked: it does not stop the merge. Absent = nothing. */
  notes?: string[];
  /** The main review was not asked for: a direct PR with no large reason (mergePr marks it). Absent = it was asked for. */
  reviewSkipped?: true;
  /** The paths that need an attacking review (`attackPaths`); absent = none. Whether a fresh mark is there is in `reasons`. */
  attack?: string[];
}

const matches = (globs: Bun.Glob[], path: string) => globs.some((g) => g.match(path));

/**
 * The security groups of a path; empty = not security. A document that is not an instruction is security:docs alone. A
 * path met only by a path word or the host group is security:tests alone when it is a test or a fixture, or a host file
 * that differs in comments only (`commentOnly`). A secrets file and a path of any other group (CI settings, the gates, lock
 * files) keep their groups whatever the file is. `exempt` false: the path is taken for neither a document nor a test.
 */
export function securityKinds(path: string, commentOnly = false, exempt = true): SecurityKind[] {
  const secrets = matches(SECURITY_WORD_FILES, path);
  const words = secrets || path.toLowerCase().split(/[\/._-]/).some((w) => SECURITY_WORDS.includes(w));
  const groups = (Object.keys(SECURITY_GROUPS) as (keyof typeof SECURITY_GROUPS)[]).filter((k) => matches(SECURITY_GROUPS[k], path));
  if (!words && groups.length === 0) return [];
  if (exempt && matches(DOCS, path) && !matches(INSTRUCTIONS, path)) return ["security:docs"];
  const host = groups.includes("security:host");
  if (exempt && !secrets && groups.every((k) => k === "security:host") && (matches(SECURITY_TEST_FILES, path) || (host && commentOnly && matches(HOST_COMMENT_FILES, path)))) return ["security:tests"];
  return [...(words ? ["security:words" as const] : []), ...groups];
}

/**
 * The security groups of a changed file. The path alone does not decide: a product file renamed into a test or fixture
 * path (`aws/auth.ts` → `aws/fixtures/auth.ts`) is still the product file, so a file with a path before it is judged by
 * both paths and the stricter answer stands (a group that is asked takes out the recheck-only document and test
 * groups). A file whose change is not known (no status, or a type change) gets no document or test answer, and only a
 * modified file can be comment-only.
 */
export function fileSecurityKinds(x: PrFacts["files"][number]): SecurityKind[] {
  const known = x.status !== undefined && x.status !== "changed" && ((x.status !== "renamed" && x.status !== "copied") || !!x.previous);
  const now = securityKinds(x.path, x.commentOnly === true && x.status === "modified", known);
  if (!x.previous) return now;
  const all = [...new Set([...now, ...securityKinds(x.previous)])];
  const hard = all.filter((k) => k !== "security:docs" && k !== "security:tests");
  return hard.length > 0 ? hard : all;
}

const ATTACK_KINDS: SecurityKind[] = ["security:words", "security:lockfile", "security:github", "security:gates", "security:host"];

/**
 * The changed files that need an attacking review: those in a security group other than documents and tests (a file is
 * judged by its path before a rename too, `fileSecurityKinds`) and those of `ATTACK_PATHS` (also by the path before a rename).
 */
export function attackPaths(f: PrFacts): string[] {
  return f.files
    .filter((x) => fileSecurityKinds(x).some((k) => ATTACK_KINDS.includes(k)) || matches(ATTACK_PATHS, x.path) || (x.previous !== undefined && matches(ATTACK_PATHS, x.previous)))
    .map((x) => x.path);
}

/** A here-document's word after `<<`: an optional `-`, then a quoted or a plain word, ended by a blank or an operator. */
const HEREDOC = /^(-?)[ \t]*(?:'([^']+)'|"([^"$`\\]+)"|(\\?)([A-Za-z0-9_.+-]+))(?=$|[ \t;|&)<>])/;

/**
 * Shell: per line, whether the line starts where a `#` line or a blank line does nothing — outside a here-document,
 * outside a quoted string, and not after a line ending in a continuation `\`. null = the state cannot be followed
 * with certainty: a backtick substitution, a here-document inside a string or one that never ends, a line of a
 * here-document with an unquoted word that ends in a continuation `\` (the shell joins the next line to it, so a line
 * that reads as the end word may not be the end), `case` inside a
 * `$( )` of a string, an arithmetic `(( ))` or a `${ }` left open at the end of a line, a `#` straight after an
 * operator, a string still open at the end of the file. Whitespace is the space and the tab only (as the shell reads it).
 */
function shellPlain(lines: string[]): boolean[] | null {
  const plain: boolean[] = [];
  // "dq": inside "…"; a number: the open parentheses of a $( … ) begun inside "…" (closing it returns to the string)
  const stack: ("dq" | number)[] = [];
  let quote: "'" | "$'" | null = null;
  let continued = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    plain[i] = stack.length === 0 && quote === null && !continued;
    continued = false;
    const pending: { word: string; tabs: boolean; quoted: boolean }[] = [];
    let brace = 0;
    for (let j = 0; j < line.length; j++) {
      const c = line[j]!;
      const top = stack.at(-1);
      if (quote !== null) {
        if (quote === "$'" && c === "\\") j++;
        else if (c === "'") quote = null;
        continue;
      }
      if (top === "dq") {
        if (c === "\\") j++;
        else if (c === '"') stack.pop();
        else if (c === "`") return null;
        else if (c === "$" && line[j + 1] === "(") { stack.push(1); j++; }
        else if (c === "$" && line[j + 1] === "{" && !/^\$\{(?:[^"'`\\(){}]|\\.)*\}/.test(line.slice(j))) return null;
        continue;
      }
      if (c === "\\") { if (j === line.length - 1) continued = true; j++; continue; }
      if (c === "'") {
        if (line[j - 1] === "$" && line[j - 2] === "$") return null;
        quote = line[j - 1] === "$" ? "$'" : "'";
        continue;
      }
      if (c === '"') { stack.push("dq"); continue; }
      if (c === "`") return null;
      if (c === "#" && (j === 0 || /[ \t;|&()<>]/.test(line[j - 1]!))) {
        if (brace > 0 || (j > 0 && !/[ \t]/.test(line[j - 1]!))) return null;
        break; // the rest of the line is a comment
      }
      if (c === "$" && line[j + 1] === "{") { brace++; j++; continue; }
      if (c === "}" && brace > 0) { brace--; continue; }
      if (c === "(" && line[j + 1] === "(" && !line.slice(j).includes("))")) return null;
      if (c === "<" && line[j + 1] === "<") {
        if (line[j + 2] === "<") { j += 2; continue; } // a here-string
        const m = HEREDOC.exec(line.slice(j + 2));
        if (!m || stack.length > 0) return null;
        pending.push({ word: m[2] ?? m[3] ?? m[5]!, tabs: m[1] === "-", quoted: m[5] === undefined || m[4] === "\\" });
        j += 1 + m[0].length;
        continue;
      }
      if (typeof top === "number") {
        if (/^(case|esac)\b/.test(line.slice(j)) && !/\w/.test(line[j - 1] ?? "")) return null;
        if (c === "(") stack[stack.length - 1] = top + 1;
        else if (c === ")") { if (top === 1) stack.pop(); else stack[stack.length - 1] = top - 1; }
      }
    }
    if (brace > 0) return null;
    if (pending.length > 0 && (continued || quote !== null || stack.length > 0)) return null;
    for (const h of pending) {
      for (;;) {
        if (++i >= lines.length) return null;
        plain[i] = false;
        if ((h.tabs ? lines[i]!.replace(/^\t+/, "") : lines[i]) === h.word) break;
        if (!h.quoted && (/\\+$/.exec(lines[i]!)?.[0].length ?? 0) % 2 === 1) return null;
      }
    }
  }
  return stack.length === 0 && quote === null && !continued ? plain : null;
}

/** systemd units: a line after one ending in `\` is part of that line's value. */
const unitPlain = (lines: string[]): boolean[] => lines.map((_, i) => i === 0 || !lines[i - 1]!.endsWith("\\"));

/**
 * YAML: a line inside a block scalar (`|` / `>`: the blank lines and the lines indented deeper than its key, or than
 * the `-` of an item with no key) is content. null = a line the scanner cannot place: a tab in the indentation, a quoted or flow value not closed on its
 * line, an anchor, alias or tag, or a line that is neither `key:`, `key: value` nor a `- ` item (a scalar continued
 * over lines).
 */
function yamlPlain(lines: string[]): boolean[] | null {
  const plain = lines.map(() => true);
  const COMMENT = "(?:[ \\t]+#.*)?[ \\t]*$";
  const closed = [`^"(?:[^"\\\\]|\\\\.)*"${COMMENT}`, `^'(?:[^']|'')*'${COMMENT}`, `^\\[[^\\[\\]{}"'#]*\\]${COMMENT}`, `^\\{[^\\[\\]{}"'#]*\\}${COMMENT}`].map((r) => new RegExp(r));
  const header = new RegExp(`^[|>][+-]?[0-9]?[+-]?${COMMENT}`);
  let block: number | null = null;
  // the column a one-line scalar hangs from: a deeper line after it would continue the scalar
  let scalar: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const indent = /^ */.exec(line)![0].length;
    const blank = /^[ \t]*$/.test(line);
    if (block !== null) {
      if (blank || indent > block) { plain[i] = false; continue; }
      block = null;
    }
    if (blank || /^ *#/.test(line)) continue;
    if (line[indent] === "\t" || (scalar !== null && indent > scalar)) return null;
    scalar = null;
    let body = line.slice(indent);
    if (body === "---" || body === "...") continue;
    let col = indent;
    let dash: number | null = null;
    while (body === "-" || body.startsWith("- ")) {
      dash = col;
      const rest = body.slice(1).trimStart();
      col += body.length - rest.length;
      body = rest;
    }
    const key = /^(?:[A-Za-z0-9_@.\/-][^:#"']*|"[^"\\]*"|'[^']*'):(?:[ \t]+(.*))?$/.exec(body);
    if (!key && dash === null) return null;
    const value = (key ? key[1] ?? "" : body).trim();
    if (value === "") continue;
    if (/^[|>]/.test(value)) {
      if (!header.test(value)) return null;
      block = key ? col : dash;
      continue;
    }
    if (/^["'\[{]/.test(value) ? !closed.some((r) => r.test(value)) : /^[&*!%?`]/.test(value)) return null;
    scalar = key ? col : dash;
  }
  return plain;
}

/** The host file's text without the `#` lines and blank lines that do nothing where they stand; the first line stays whatever it is (the interpreter line). null = the file's state cannot be followed, or the file is of no kind where `#` is a comment. */
function withoutComments(path: string, text: string): string | null {
  if (/[\r\0]/.test(text)) return null;
  // the end of the last line is not a line of its own (a file with and without it are two different texts)
  const end = text.endsWith("\n") ? "\n" : "";
  const lines = text.slice(0, text.length - end.length).split("\n");
  const plain = path.endsWith(".sh") ? shellPlain(lines) : /\.(service|timer)$/.test(path) ? unitPlain(lines) : /\.ya?ml$/.test(path) ? yamlPlain(lines) : null;
  if (!plain) return null;
  return lines.filter((l, i) => !(i > 0 && plain[i] && /^[ \t]*(#.*)?$/.test(l))).join("\n") + end;
}

/**
 * Whether a host file changed in comment lines (`#`) and blank lines only. Decided from the whole file on both sides,
 * not from the lines of a patch: a `#` line inside a here-document (`#includedir` in a sudoers file written by a
 * script), a `#` or blank line put between the lines of a command continued by `\`, and a `#` line inside a quoted
 * string or a YAML block scalar are content. The two files must be the same once the lines that are comments where
 * they stand are taken out of each. A side that was not read, or whose state cannot be followed, is not comment-only.
 */
export function commentOnlyChange(path: string, base: string | undefined, head: string | undefined): boolean {
  if (base === undefined || head === undefined || base === head) return false;
  const a = withoutComments(path, base);
  return a !== null && a === withoutComments(path, head);
}

/**
 * Whether `diff` (git's: one file's or a whole PR's) has exactly one section for `path` whose header says nothing but
 * a content change of a regular file — no mode change, no rename or copy, no creation or removal, no symlink.
 */
export function plainDiffHeader(diff: string, path: string): boolean {
  const sections = diff.split(/^(?=diff --git )/m).filter((s) => s.split("\n", 1)[0] === `diff --git a/${path} b/${path}`);
  if (sections.length !== 1) return false;
  const lines = sections[0]!.split("\n");
  const at = lines.findIndex((l) => l.startsWith("@@"));
  return at === 4 && /^index [0-9a-f]+\.\.[0-9a-f]+ 100(644|755)$/.test(lines[1]!) && lines[2] === `--- a/${path}` && lines[3] === `+++ b/${path}`;
}

export function classify(path: string): "security" | "instructions" | "responsibility" | null {
  if (securityKinds(path).length > 0) return "security";
  if (matches(INSTRUCTIONS_FILES, path)) return "instructions";
  if (matches(RESPONSIBILITY, path)) return "responsibility";
  return null;
}

/**
 * Whether a unified diff of README.md deletes or changes a line of the base README's `## Design rules` section (the heading
 * to the line before the next `## `), or adds a line inside it. No such heading → false (the rest of a README is not a rule).
 */
export function designRulesTouched(readme: string, patch: string): boolean {
  const lines = readme.split("\n");
  const at = lines.findIndex((l) => DESIGN_RULES_HEADING.test(l));
  if (at < 0) return false;
  const next = lines.findIndex((l, i) => i > at && l.startsWith("## "));
  const first = at + 1;
  const last = next < 0 ? lines.length : next; // 1-based: the line before the next heading
  let old = 0;
  for (const l of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? /.exec(l);
    if (hunk) {
      old = hunk[2] === "0" ? Number(hunk[1]) + 1 : Number(hunk[1]); // -a,0: the lines are added after old line a
      continue;
    }
    if (l.startsWith("-")) {
      if (old >= first && old <= last) return true;
      old++;
    } else if (l.startsWith("+")) {
      if (old - 1 >= first && old - 1 <= last) return true; // added after old line old-1
    } else if (l.startsWith(" ")) old++;
  }
  return false;
}

function countsTowardSize(path: string): boolean {
  if (matches(TESTS, path)) return false;
  if (path.startsWith(".claude/skills/") || path.startsWith("ops-kit/skills/")) return true;
  return !matches(DOCS, path);
}

/**
 * A PR's change to ops.config.json for the scope check: the paths it adds to and takes out of `publicSync.include` /
 * `publicSync.exclude`, and whether anything else in the file differs (`other`).
 */
export interface ConfigScope { added: string[]; removed: string[]; other: boolean }

/** `ConfigScope` of two versions of ops.config.json (the merge base's and the head's). A version that does not parse is `other`. */
export function configScopeOf(before: string, after: string): ConfigScope {
  const read = (text: string) => {
    const json = JSON.parse(text) as { publicSync?: { include?: unknown; exclude?: unknown } } | null;
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("not an object");
    const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    const { include, exclude, ...sync } = json.publicSync ?? {};
    // a list that is not a list of paths is not what the lists' rule reads: it stays in `rest`
    const lists = [include, exclude].every((v) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string")));
    return { include: list(include), exclude: list(exclude), rest: JSON.stringify({ ...json, publicSync: lists ? (json.publicSync === undefined ? undefined : sync) : json.publicSync }) };
  };
  try {
    const a = read(before);
    const b = read(after);
    const diff = (x: string[], y: string[]) => x.filter((p) => !y.includes(p));
    return {
      added: [...diff(b.include, a.include), ...diff(b.exclude, a.exclude)],
      removed: [...diff(a.include, b.include), ...diff(a.exclude, b.exclude)],
      other: a.rest !== b.rest,
    };
  } catch {
    return { added: [], removed: [], other: true };
  }
}

/**
 * A file that comes along with what a Task names, so the Task need not name it: (a) the test next to a named file
 * (`<name>.test.ts` of `<name>.ts`, `.tsx` too), (b) a design document (`docs/design/**.md`), (c) ops.config.json when the
 * PR only lists its own files for the public copy — every path added to `publicSync.include` / `exclude` is a file the PR
 * adds (or renames to), every path taken out one it removes (or renames from), and nothing else in the file differs (so
 * a directory's `exclude` cannot be dropped this way). Which kinds pass is decided here, not by a setting.
 */
function companion(path: string, f: PrFacts, named: string[]): boolean {
  const test = /^(.*)\.test\.(tsx?)$/.exec(path);
  if (test) return named.some((q) => overlaps(`${test[1]}.${test[2]}`, q));
  if (path.startsWith("docs/design/") && path.endsWith(".md")) return true;
  if (path !== CONFIG_FILE || !f.configScope || f.configScope.other) return false;
  const created = f.files.filter((x) => x.status === "added" || x.status === "renamed").map((x) => x.path);
  const gone = f.files.flatMap((x) => (x.status === "removed" ? [x.path] : x.status === "renamed" && x.previous ? [x.previous] : []));
  return f.configScope.added.every((p) => created.includes(p)) && f.configScope.removed.every((p) => gone.includes(p));
}

/**
 * What the Task scope says of a PR, never a reason to stop: `notes` (that the Tasks' paths could not be read, which
 * files are outside what they name, which passed as companions), and the parts the review material is made of. The
 * files of the PR no path of its Tasks covers and that are no `companion` are `outside`, in the PR's order, each with
 * the sibling Tasks that name it.
 */
function taskScope(f: PrFacts): { notes: string[]; tasks: string; outside: string[]; along: string[] } {
  if (!f.task) return { notes: [], tasks: "", outside: [], along: [] };
  const { numbers, named, siblings } = f.task;
  const tasks = numbers.map((n) => `#${n}`).join(", ");
  if (named.length === 0) return { notes: [`Task ${tasks} の本文からパスが読めない（範囲の検査をしていない）`], tasks, outside: [], along: [] };
  const unnamed = f.files.map((x) => x.path).filter((p) => !named.some((q) => overlaps(p, q)));
  const along = unnamed.filter((p) => companion(p, f, named));
  const outsidePaths = unnamed.filter((p) => !along.includes(p));
  const owners = (p: string) => siblings.filter((s) => s.paths.some((q) => overlaps(p, q))).map((s) => s.number).sort((a, b) => a - b);
  const outside = outsidePaths.map((p) => {
    const by = owners(p);
    return by.length > 0 ? `${p}（${by.map((n) => `Task #${n}`).join("、")} が名指し）` : p;
  });
  const notes = [
    ...(outside.length ? [`Task ${tasks} の名指しの外: ${outside.join(", ")}`] : []),
    ...(along.length ? [`付いてくるファイル: ${along.join(", ")}`] : []),
  ];
  return { notes, tasks, outside, along };
}

/**
 * The material the main review gets of the Task scope: the files the Tasks do not name, for the reviewer to tell a
 * change the Task's purpose needs from one mixed in from another Task. Empty when there is no Task, its paths could not
 * be read, or every file is named or comes along.
 */
export function scopeMaterial(f: PrFacts): string {
  const s = taskScope(f);
  if (s.outside.length === 0) return "";
  return [
    "# Task の名指しの外のファイル",
    "",
    `Task ${s.tasks} の本文が名指ししていないファイル。ファイルごとに、Task の目的に要る変更か、別の Task の変更の混入かを見る。`,
    "",
    ...s.outside.map((p) => `- ${p}`),
    ...(s.along.length ? ["", `付いてくるファイル（名指しは要らない）: ${s.along.join(", ")}`] : []),
    "",
  ].join("\n");
}

/** --allow-large lifts the large reasons only with the app's record of the person's grant of the head (`PrFacts.granted`); no comment is read. */
export function judge(f: PrFacts, opts: { allowLarge: boolean }): Judgement {
  const large: { kind: RecheckKind | AskKind; text: string }[] = [];
  const add = (kind: RecheckKind | AskKind, head: string, paths: string[], note = "") => {
    if (paths.length > 0) large.push({ kind, text: `${head}: ${paths.join(", ")}${note}` });
  };
  const lines = f.files
    .filter((x) => countsTowardSize(x.path))
    .reduce((n, x) => n + x.additions + x.deletions, 0);
  if (lines > LARGE_LINES) {
    large.push({ kind: "size", text: `テストと docs を除いた変更が ${lines} 行で、${LARGE_LINES} 行を超えている` });
  }
  const paths = f.files.map((x) => x.path);
  const kinds = new Map(f.files.map((x) => [x.path, fileSecurityKinds(x)]));
  // rescue is its own kind whatever else its file is (rescue/CLAUDE.md too); a security file there says セキュリティ instead,
  // but one that is only a test (security:tests, a recheck by reading) keeps the rescue recheck too, which runs rescue's tests
  const rescue = (p: string) => matches(RESCUE, p) && (classify(p) !== "security" || kinds.get(p)!.every((k) => k === "security:tests"));
  const touched = paths.filter((p) => classify(p) === null && matches(PROTECTED, p) && !rescue(p));
  for (const kind of SECURITY_KINDS) {
    // a group that comes from the path before a rename names that path too
    const named = f.files.filter((x) => kinds.get(x.path)!.includes(kind)).map((x) => (x.previous && !securityKinds(x.path).includes(kind) ? `${x.path}（改名前: ${x.previous}）` : x.path));
    add(kind, `セキュリティ（${kind}）`, named, kind === "security:host" ? HOST_ROOT_NOTE : "");
  }
  add("rescue", "rescue", paths.filter(rescue));
  add("design-rules", "責務", f.designRulesTouched ? [DESIGN_RULES] : []);
  add("limits", "検査の上限・許可リストを上げる", f.limitsRaised ?? []);
  // the user-marked lines an instruction file's change deletes or rewrites go on this reason, whatever the file's own kind is
  // (security by a path word, rescue, renamed out of an instruction path): a line is never left without a reason
  const userRules = f.userRulesTouched ?? [];
  // an instruction file is asked whatever else it is (a path word, rescue/), and so is one renamed out of an instruction path
  // only a rename: a copy leaves its source as it was, and a local change sees the copy as a file added
  const isInstruction = (x: PrFacts["files"][number]) => matches(INSTRUCTIONS_FILES, x.path) || (x.status === "renamed" && x.previous !== undefined && matches(INSTRUCTIONS_FILES, x.previous));
  const instructed = f.files.filter(isInstruction).map((x) => (matches(INSTRUCTIONS_FILES, x.path) ? x.path : `${x.path}（改名前: ${x.previous}）`));
  const ruleNote = userRules.length > 0 ? `（利用者の決まりの行を消す・変える: ${userRules.join(", ")}）` : "";
  if (instructed.length > 0) add("instructions", "指示のファイル", instructed, ruleNote);
  else if (userRules.length > 0) add("instructions", "指示のファイル", [...new Set(userRules.map((r) => r.replace(/:[^:]*$/, "")))], ruleNote);
  add("responsibility", "責務", paths.filter((p) => classify(p) === "responsibility" && !rescue(p)));
  // an instruction file comes with tests at most: a PR of both is split, and no yes lifts it. A file renamed out of an
  // instruction path leaves a file that is not one, as a local change (a file removed and a file added) shows it
  const others = f.files.flatMap((x) => {
    const isOther = (p: string) => !matches(INSTRUCTIONS_FILES, p) && !/\.test\.ts$/.test(p);
    // a rename into an instruction path removes the file it came from, as a local change shows it
    const from = x.status === "renamed" && x.previous !== undefined && isOther(x.previous) ? [`${x.previous}（改名で消える）`] : [];
    return [...(isOther(x.path) ? [x.path] : []), ...from];
  });
  const mixed = instructed.length > 0 && others.length > 0 ? `[分ける] 指示のファイル（${instructed.join(", ")}）とほかのファイル（${others.join(", ")}）を同じ PR で変えている。指示のファイルだけの PR に分けて出し直す` : "";
  add("migration", "保護するパスに触れている", touched.filter((p) => matches(MIGRATION, p)));
  add("size", "保護するパスに触れている", touched.filter((p) => !matches(MIGRATION, p)));
  // a direct PR skips the main review when no large reason is left once the kinds the table answers reversible are set aside;
  // those kinds stay large for the impact, the recheck and the ask
  const reviewSkipped = f.direct === true && large.every((l) => REVERSIBLE_KINDS.includes(l.kind));
  const impact = large.length > 0 ? "large" : "small";
  const marked = new Set(f.rechecks ?? []);
  const required = RECHECK_KINDS.filter((k) => large.some((l) => l.kind === k));
  const recheck = required.filter((k) => !marked.has(k));
  const ask = ASK_KINDS.filter((k) => large.some((l) => l.kind === k));
  const isAsk = (k: RecheckKind | AskKind): k is AskKind => (ASK_KINDS as string[]).includes(k);

  // the person's grant of this head lifts every kind left: the kinds are not in the record (a grant is of one head, and
  // the head decides what is asked of it)
  const left = [...ask, ...recheck];
  const lifted = opts.allowLarge && (left.length === 0 || f.granted === true);
  const reasons = lifted
    ? []
    : large
      .filter((l) => isAsk(l.kind) || !marked.has(l.kind))
      .map((l) => `${isAsk(l.kind) ? "[聞く]" : `[再チェック ${l.kind}]`} ${l.text}`);
  if (mixed) reasons.push(mixed);
  if (opts.allowLarge && !lifted) {
    reasons.push(`利用者の許可の記録が無い: ${left.join(",")}（Task の会話で利用者が「${f.subject ?? "PR #<n>"} をマージしてよい」と認めると、その head に記録される。新しいコミットの後は聞き直す）`);
  }
  // the settings kept by Switchboard (the CI's steps, the gate) have a change the person has not confirmed: the merge waits
  // for that answer. Not lifted by --allow-large or the person's grant of the head: it is answered where the change is shown (判断待ち)
  if (f.held?.pending) reasons.push(`[聞く] Switchboard の側の設定（workspace ${f.held.workspace}）に、利用者が確かめていない変更がある（キー: ${f.held.pending.keys.join(", ") || "不明"}）。アプリの判断待ちで確認するか断ってから判定し直す（--allow-large では外れない）`);
  const scope = taskScope(f);
  if (f.checks.length === 0) reasons.push("CI のチェックが 1 つも無い");
  for (const c of f.checks) {
    if (c.conclusion !== "SUCCESS" && c.conclusion !== "SKIPPED") {
      reasons.push(`CI のチェック ${c.name} が ${c.conclusion || "未完了"}`);
    }
  }
  if (f.localCiNote && reasons.some((r) => r.startsWith("CI のチェック"))) reasons.push(f.localCiNote);
  if (f.unresolvedThreads > 0) reasons.push(`解決していないレビュースレッドが ${f.unresolvedThreads} 件ある`);
  if (f.threadsUnread) reasons.push(`PR #${f.threadsUnread} のレビュースレッドを読めない（GitHub が使えない間のローカルの変更）。未解決のスレッドが無いと確かめられないので、GitHub が戻ってから PR で進める`);
  else if (f.threadsUnknown) reasons.push(`枝 ${f.threadsUnknown} は origin に push 済みで、PR があるか・未解決のレビュースレッドが無いかを確かめられない（GitHub が使えない間のローカルの変更）。GitHub が戻ってから PR で進める`);
  if (!reviewSkipped && !f.reviewed) {
    reasons.push("この head（か、この PR のコミットが同じ差分で入った head）で合格した主レビューの仕事の記録が無い（アプリで回したレビュー。コメントでは満たされない）");
  }
  // not lifted by --allow-large or the person's grant of the head: the answer is about the change, the attacking review looks for what is wrong with it
  const attack = attackPaths(f);
  if (attack.length > 0 && !f.attacked) {
    const named = f.files.filter((x) => attack.includes(x.path)).map((x) => (x.previous && x.previous !== x.path ? `${x.path}（改名前: ${x.previous}）` : x.path));
    reasons.push(`この head（か、この PR のコミットが同じ差分で入った head）で合格した攻める側のレビューの仕事の記録が無い: ${named.join(", ")}`);
  }
  const unstableForLocalCi = f.mergeState === "UNSTABLE" && f.localCi === true;
  if (f.mergeState === "BLOCKED" && f.localCi) {
    // the local pass is a job record of the app: a required status check or review of the base branch is not met by it
    reasons.push(`mergeStateStatus が BLOCKED: base の枝の保護（必須のチェックか承認）がマージを止めている。local-ci の結果はアプリの仕事の記録で、GitHub の必須チェックにはならない（${PROTECTION_DOC}）`);
  } else if (f.mergeState !== "CLEAN" && !unstableForLocalCi) reasons.push(`mergeStateStatus が CLEAN でない: ${f.mergeState}`);

  return { verdict: reasons.length === 0 ? "merge" : "stop", impact, reasons, ask, recheck, ...(required.length > 0 ? { required } : {}), ...(scope.notes.length || f.held ? { notes: [...scope.notes, ...(f.held ? [heldNote(f.held)] : [])] } : {}), ...(reviewSkipped ? { reviewSkipped: true as const } : {}), ...(attack.length > 0 ? { attack } : {}) };
}

/** The line a judgement names the settings it was made with: the workspace and the version the person confirmed. */
export const heldNote = (h: HeldSettings): string => `設定: Switchboard の側（workspace ${h.workspace}、利用者が確かめた版 ${h.version ?? "なし"}${h.ciHash ? `、CI の手順のハッシュ ${h.ciHash}` : ""}）${h.pending ? "。確かめていない変更が待っている（使っていない）" : ""}`;

/** Runs `gh`; `env` is added to the environment (mergePr pins GH_REPO for `gh stack merge`). */
type Run = (args: string[], env?: Record<string, string>) => Promise<string>;

/** The checkout a run as the app's job works in (`--cwd`). The job starts in the daemon's own folder, so Bun reads no `bunfig.toml` or `.env` of the checkout for it; git and `gh` run in the checkout (the front of `gh` reads its refusals to write from the working tree it runs in, and `gh stack merge` acts on it). */
let workDir: string | undefined;

async function gh(args: string[], env?: Record<string, string>): Promise<string> {
  // `gh` can be the front of `gh` (a Bun script): started in the checkout it would read that folder's bunfig.toml and .env, so Bun is told not to and given the daemon's own config file
  const bun = workDir ? { BUN_OPTIONS: `--no-env-file --config=${join(import.meta.dir, "../bunfig.toml")}` } : {};
  const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe", ...(workDir && { cwd: workDir }), ...((env || workDir) && { env: { ...process.env, ...env, ...bun } }) });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed: ${err.trim()}`);
  return out;
}

interface WorkflowRun { id: number; name: string; status: string; conclusion: string | null; created_at: string }

/**
 * CI = the Actions workflow runs of the head commit, the newest per workflow (a later run of the same workflow on the same
 * commit, e.g. after the PR is closed and reopened, wins; a re-run keeps its run and only updates its status and conclusion).
 * Not statusCheckRollup: it includes check runs, which need Checks — a permission a fine-grained token cannot have.
 */
function newestRuns(runs: WorkflowRun[]): WorkflowRun[] {
  const newest = new Map<string, WorkflowRun>();
  for (const r of runs) {
    const had = newest.get(r.name);
    if (!had || r.created_at > had.created_at || (r.created_at === had.created_at && r.id > had.id)) newest.set(r.name, r);
  }
  return [...newest.values()];
}

const toCheck = (r: WorkflowRun) => ({ name: r.name, conclusion: r.status === "completed" ? (r.conclusion ?? "").toUpperCase() : "" });

export function checksFromRuns(runs: WorkflowRun[]): PrFacts["checks"] {
  return newestRuns(runs).map(toCheck);
}

/**
 * When Actions does not start (billing: the job fails with no steps and no runner, or the run stays queued), or there is no run at all, the local
 * pass of `bun scripts/local-ci.ts` counts as the CI's success. Only for a run that never started (a CI
 * whose tests really failed still stops the merge) and only when the newest result of the stack's top is a pass whose
 * head has this PR's commits as they are now, by `git cherry` (`inPass`, read by `ciOf`).
 */
const LOCAL_CI_SUFFIX = "（Actions が始まらず、ローカルで pass）";
const LOCAL_CI_ONLY = "local-ci（Actions の run が無く、ローカルで pass）";
const PROTECTION_DOC = "docs/merge-gate.md の「Branch protection and local results」";

/**
 * The top of `n`'s stack: up by the one open PR whose base is this one's head branch. None or two above → here.
 * The PRs' branches are what is read (it only finds where to put the local CI; what `gh stack merge` merges is `stackMembers`).
 */
export async function stackTop(n: number, headRefName: string, run: (args: string[]) => Promise<string>, repo: string): Promise<number> {
  const seen = new Set([n]);
  for (let top = n, ref = headRefName; ;) {
    const above = JSON.parse(await run(["pr", "list", "-R", repo, "--base", ref, "--state", "open", "--json", "number,headRefName"])) as Array<{ number: number; headRefName: string }>;
    if (!Array.isArray(above) || above.length !== 1 || seen.has(above[0]!.number)) return top;
    top = above[0]!.number;
    ref = above[0]!.headRefName;
    seen.add(top);
  }
}

/** A PR of the set `gh stack merge <n>` merges: its number and the head GitHub's stack has for it. */
export interface StackPr { n: number; head: string }

/**
 * What `gh stack merge <n>` merges, read where gh stack reads it: GitHub's registered stack of PR `n` (the Stacks REST API,
 * `repos/<repo>/stacks?pull_request=<n>`), its PRs not yet merged from the bottom up to and including `n`, bottom first, each with
 * the head GitHub has for it. gh stack reads a bare number as a stack number first, so a stack numbered `n` is an error too
 * (GitHub numbers stacks in the same sequence as issues and PRs, so it is not expected). No stack or more than one, a base other
 * than the default branch, a closed or draft PR below `n`, or a PR without a head is an error: the set cannot be judged as a whole.
 */
export async function stackMembers(n: number, run: (args: string[]) => Promise<string>, repo: string, defaultBranch: string): Promise<StackPr[]> {
  let numbered = true;
  try {
    await run(["api", `repos/${repo}/stacks/${n}`]);
  } catch (e) {
    if (!/HTTP 404/.test((e as Error).message)) throw e;
    numbered = false;
  }
  if (numbered) throw new Error(`#${n} はスタックの番号でもある（gh stack merge はスタックとして読む）`);
  type Remote = { number?: number; base?: { ref?: string }; pull_requests?: Array<{ number: number; state?: string; draft?: boolean; merged_at?: string | null; head?: { sha?: string } }> };
  const stacks = JSON.parse(await run(["api", `repos/${repo}/stacks?pull_request=${n}`])) as Remote[];
  if (!Array.isArray(stacks) || stacks.length !== 1) throw new Error(`#${n} を含む GitHub のスタックが ${Array.isArray(stacks) ? stacks.length : "?"} 件（1 件でない。スタックに無い PR は --merge）`);
  const s = stacks[0]!;
  if (s.base?.ref !== defaultBranch) throw new Error(`スタックの base が ${s.base?.ref ?? "不明"}（既定の枝 ${defaultBranch} でない）`);
  const prs = s.pull_requests ?? [];
  const at = prs.findIndex((p) => p.number === n);
  if (at < 0) throw new Error(`スタックに #${n} が無い`);
  const members: StackPr[] = [];
  for (const p of prs.slice(0, at + 1)) {
    if (p.merged_at) continue;
    if (p.state !== "open" || p.draft) throw new Error(`スタックの #${p.number} が ${p.draft ? "draft" : p.state ?? "不明"}`);
    if (!p.head?.sha) throw new Error(`スタックの #${p.number} の head が読めない`);
    members.push({ n: p.number, head: p.head.sha });
  }
  return members;
}

/**
 * The shared files (`sharedFiles` of ops.config.json: `shared`) the pass's stack touches that the base changed after the
 * pass: commits between the pass's base and the base's tip now that touch one of them and are not in the pass's head with
 * the same diff (`git cherry`: a PR of the same stack merged below is, so the rebase after it does not count). Work on
 * these files is not held back by the parallel guard, so two changes that merge without a conflict may still break
 * together: the pass saw the base before the other one. No list or none touched: nothing is fetched.
 */
export async function sharedMoved(git: { root: string; url: string }, shared: string[], passHead: string, passBase: string, baseTip: string): Promise<string[]> {
  if (!shared.length || passBase === baseTip) return [];
  const at = ["git", "-C", git.root];
  await sh([...at, "fetch", "-q", "--no-tags", "--no-write-fetch-head", git.url, passHead, passBase, baseTip])
    .catch(() => { throw new Error(`${[passHead, passBase, baseTip].map((x) => x.slice(0, 7)).join(" / ")} を fetch できない（通信か、一番上で回し直す）`); });
  const fork = (await sh([...at, "merge-base", passBase, passHead])).trim();
  const touched = (await sh([...at, "diff", "--name-only", "--no-renames", fork, passHead])).split("\n").filter((f) => shared.includes(f));
  if (!touched.length) return [];
  const foreign = new Set((await sh([...at, "cherry", passHead, baseTip, passBase])).split("\n").filter((l) => l.startsWith("+ ")).map((l) => l.slice(2).trim()));
  const out: string[] = [];
  for (const f of touched) {
    const commits = (await sh([...at, "log", "--format=%H", `${passBase}..${baseTip}`, "--", f])).split("\n").filter(Boolean);
    if (commits.some((c) => foreign.has(c))) out.push(f);
  }
  return out;
}

/** A commit the remote does not have (never pushed, or gone): the record naming it covers nothing, which is not a failure to judge. A fetch that failed for another reason (the network, a login) is one. */
export class HeadUnreadable extends Error {}

/** What git says when the remote has no such commit (`fatal: remote error: upload-pack: not our ref <sha>`, and the wording of other servers). */
const REMOTE_HAS_NOT = /not our ref|couldn't find remote ref|no such ref|unadvertised object|did not match any/i;

/**
 * Whether every commit of the PR now (from its merge-base with the base's tip to its head) is in the pass's head's history
 * with the same diff: `git cherry` prints no `+` line, and every merge commit among them (which git cherry skips) is
 * in that history as is. GitHub's rebase after a merge below keeps each commit's diff; a fix commit or a conflict
 * resolution that changes one does not. The three commits are fetched from `url` into `root` without writing a ref.
 * Not a worktree, or a fetch that failed for any reason but the remote not having a commit, throws: no judgement (exit 2).
 * A commit the remote does not have throws `HeadUnreadable`.
 */
export async function inPass(git: { root: string; url: string }, passHead: string, prHead: string, baseTip: string): Promise<boolean> {
  const at = ["git", "-C", git.root];
  await sh([...at, "rev-parse", "--git-dir"]).catch(() => { throw new Error("git の作業ツリーでない（判定に要るコミットを取れない）"); });
  await sh([...at, "fetch", "-q", "--no-tags", "--no-write-fetch-head", git.url, passHead, prHead, baseTip])
    .catch((e: Error) => {
      const names = [passHead, prHead, baseTip].map((x) => x.slice(0, 7)).join(" / ");
      if (REMOTE_HAS_NOT.test(e.message)) throw new HeadUnreadable(`${names} をリモートが持たない`);
      throw new Error(`${names} を fetch できない（通信か、一番上で回し直す）`);
    });
  const mergeBase = (await sh([...at, "merge-base", baseTip, prHead])).trim();
  if ((await sh([...at, "cherry", passHead, prHead, mergeBase])).split("\n").some((l) => l.startsWith("+ "))) return false;
  // git cherry skips merge commits: one in the PR (a conflict resolved in it) counts only when the pass's head has it as is
  for (const m of (await sh([...at, "rev-list", "--merges", `${mergeBase}..${prHead}`])).split("\n").filter(Boolean)) {
    if (!await sh([...at, "merge-base", "--is-ancestor", m, passHead]).then(() => true, () => false)) return false;
  }
  return true;
}

async function checksWithLocalCi(runs: WorkflowRun[], localPass: boolean, run: (args: string[]) => Promise<string>, repo: string): Promise<PrFacts["checks"]> {
  // every run skipped = CI ran nowhere (a job behind <PREFIX>_ACTIONS without the variable): the same as no run, not a pass
  const ran = newestRuns(runs).some((r) => toCheck(r).conclusion !== "SKIPPED");
  if (!ran) return localPass ? [{ name: LOCAL_CI_ONLY, conclusion: "SUCCESS" }] : [];
  const checks: PrFacts["checks"] = [];
  for (const r of newestRuns(runs)) {
    const c = toCheck(r);
    // a run still queued (or waiting) has not started: with the local pass it counts like a run that never started
    if (localPass && ["queued", "waiting", "requested", "pending"].includes(r.status)) {
      checks.push({ name: `${r.name}${LOCAL_CI_SUFFIX}`, conclusion: "SUCCESS" });
      continue;
    }
    if (localPass && c.conclusion === "FAILURE") {
      const jobs = JSON.parse(await run(["api", `repos/${repo}/actions/runs/${r.id}/jobs`])).jobs as Array<{ steps?: unknown[] }>;
      if (jobs.length > 0 && jobs.every((j) => (j.steps ?? []).length === 0)) {
        checks.push({ name: `${r.name}${LOCAL_CI_SUFFIX}`, conclusion: "SUCCESS" });
        continue;
      }
    }
    checks.push(c);
  }
  return checks;
}

/**
 * `<path>:<line>` of the user-marked lines the PR's instruction files delete or rewrite, from the merge base's file and the
 * PR's patch of it. A new file has none; a file whose patch GitHub leaves out (a very large diff) is listed as `<path>: 差分を読めない` (one with no changed line, a pure rename or a binary file, is not).
 */
async function readUserRulesTouched(n: number, run: (args: string[]) => Promise<string>, repo: string, base: string, head: string): Promise<string[]> {
  const listed = (await run(["api", "--paginate", `repos/${repo}/pulls/${n}/files?per_page=100`, "-q", ".[] | {filename, previous_filename, status, changes, patch}"])).trim();
  // jq writes a key GitHub leaves out as null
  const files: { filename: string; previous_filename: string | null; status: string; changes: number | null; patch: string | null }[] = listed ? listed.split("\n").map((l) => JSON.parse(l)) : [];
  // the base's file a row changed: the path before a rename (a copy changes no file of the base)
  const before = (x: (typeof files)[number]) => (x.status === "renamed" ? x.previous_filename ?? x.filename : x.filename);
  const mine = files.filter((x) => x.status !== "added" && x.status !== "copied" && matches(INSTRUCTIONS_FILES, before(x)));
  if (mine.length === 0) return [];
  const mergeBase = (await run(["api", `repos/${repo}/compare/${base}...${head}`, "-q", ".merge_base_commit.sha"])).trim();
  const out: string[] = [];
  for (const x of mine) {
    const path = before(x);
    // no patch and no changed line: a pure rename, a mode change or a binary file — no line moved
    if (x.patch === null) {
      if (x.changes !== 0) out.push(`${path}: 差分を読めない`);
      continue;
    }
    const text = await run(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${contentsPath(path)}?ref=${mergeBase}`]);
    out.push(...markedLinesTouched(text, x.patch).map((i) => `${path}:${i}`));
  }
  return out;
}

/**
 * The README at the merge base (the PR's diff is against it, not the base branch's tip) and the PR's README.md patch.
 * GitHub leaves the patch out of a very large diff; then a section that is there cannot be ruled out, so it counts as touched.
 */
async function readmeDesignRulesTouched(n: number, run: (args: string[]) => Promise<string>, repo: string, base: string, head: string): Promise<boolean> {
  const mergeBase = (await run(["api", `repos/${repo}/compare/${base}...${head}`, "-q", ".merge_base_commit.sha"])).trim();
  const readme = await run(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/README.md?ref=${mergeBase}`]);
  if (!DESIGN_RULES_HEADING.test(readme)) return false; // the rest of a README is not a rule, whatever the patch
  const file = (await run(["api", "--paginate", `repos/${repo}/pulls/${n}/files?per_page=100`, "-q", '.[] | select(.filename == "README.md")'])).trim();
  const patch: string | undefined = file ? JSON.parse(file).patch : undefined;
  return patch === undefined ? true : designRulesTouched(readme, patch);
}

/**
 * How each file of a PR changed, from GitHub's REST list (`gh pr view` has no path before a rename). A rename or a
 * copy counts only with its `previous_filename`; a row that is missing or says anything else leaves the file without a
 * status (not known: `fileSecurityKinds` then takes it for no test).
 */
async function readFileStatus(n: number, run: (args: string[]) => Promise<string>, repo: string): Promise<Map<string, Pick<PrFacts["files"][number], "status" | "previous">>> {
  const listed = (await run(["api", "--paginate", `repos/${repo}/pulls/${n}/files?per_page=100`, "-q", ".[] | {filename, status, previous_filename}"])).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { filename?: string; status?: string; previous_filename?: string | null });
  const out = new Map<string, Pick<PrFacts["files"][number], "status" | "previous">>();
  for (const x of listed) {
    if (typeof x.filename !== "string") continue;
    const st = x.status;
    if (st === "added" || st === "removed" || st === "modified" || st === "changed") out.set(x.filename, { status: st });
    else if ((st === "renamed" || st === "copied") && x.previous_filename) out.set(x.filename, { status: st, previous: x.previous_filename });
  }
  return out;
}

const contentsPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

/**
 * The host files of a PR that differ only in comment and blank lines (`commentOnlyChange`). Only a modified file where
 * `#` is a comment is read: the PR's whole diff for its header (GitHub's file list does not show a mode change) and
 * the file itself at the merge base and at the head. The file must also be the same at the base's tip as at the merge
 * base (what is merged is then the head's file). Anything that cannot be read leaves the file out (asked as before).
 */
async function readCommentOnly(n: number, files: PrFacts["files"], run: (args: string[]) => Promise<string>, repo: string, base: string, head: string): Promise<Set<string>> {
  const host = files.filter((x) => x.status === "modified" && matches(HOST_COMMENT_FILES, x.path)).map((x) => x.path);
  const out = new Set<string>();
  if (host.length === 0) return out;
  try {
    const diff = await run(["api", "-H", "Accept: application/vnd.github.diff", `repos/${repo}/pulls/${n}`]);
    const mergeBase = (await run(["api", `repos/${repo}/compare/${base}...${head}`, "-q", ".merge_base_commit.sha"])).trim();
    const at = (path: string, ref: string) => run(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${contentsPath(path)}?ref=${ref}`]);
    for (const path of host) {
      if (!plainDiffHeader(diff, path)) continue;
      try {
        const forked = await at(path, mergeBase);
        if (mergeBase !== base && (await at(path, base)) !== forked) continue;
        if (commentOnlyChange(path, forked, await at(path, head))) out.add(path);
      } catch { /* not read: not comment-only */ }
    }
  } catch { /* the diff or the merge base was not read: nothing is comment-only */ }
  return out;
}

/**
 * For the scope check of a PR that touches ops.config.json: `configScopeOf` of the file at the merge base and at the
 * head. A version that cannot be read (the PR adds or removes the file) is empty, so the change is `other`.
 */
async function readConfigScope(run: (args: string[]) => Promise<string>, repo: string, base: string, head: string): Promise<ConfigScope> {
  const mergeBase = (await run(["api", `repos/${repo}/compare/${base}...${head}`, "-q", ".merge_base_commit.sha"])).trim();
  const at = (ref: string) => run(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${CONFIG_FILE}?ref=${ref}`]).catch(() => "");
  return configScopeOf(await at(mergeBase), await at(head));
}

const TASK_LABEL = "type:task";
const BACKLOG_TASK = /^Backlog-Task: \d+\s*$/im;
const ISSUE_QUERY = "query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){ number body labels(first:20){nodes{name}} parent{ subIssues(first:100){ nodes{ number body labels(first:20){nodes{name}} } } } } } }";

interface TaskIssue { number: number; body: string; labels: { nodes: { name: string }[] } }
const isTask = (i: TaskIssue) => i.labels.nodes.some((l) => l.name === TASK_LABEL);

/**
 * The Tasks a PR closes, read from GitHub's Issues (not the stored backlog). `Backlog-Task:` names an Issue of
 * the app only, which GitHub does not have. `files`: a path a PR adds at the top of the tree still starts a path (as readOthers).
 */
async function readTask(pr: { body: string | null; headRefName: string | null }, files: string[], run: (args: string[]) => Promise<string>, repo: string): Promise<PrFacts["task"]> {
  if (BACKLOG_TASK.test(pr.body ?? "")) return undefined;
  const [owner, name] = repo.split("/");
  const issues: (TaskIssue & { parent: { subIssues: { nodes: TaskIssue[] } } | null })[] = [];
  for (const n of new Set(linkedIssues(pr))) {
    const out = await run(["api", "graphql", "-f", `query=${ISSUE_QUERY}`, "-f", `o=${owner}`, "-f", `r=${name}`, "-F", `n=${n}`]);
    issues.push(JSON.parse(out).data.repository.issue);
  }
  const tasks = issues.filter(isTask);
  if (tasks.length === 0) return undefined;
  const top: { name: string; dir: boolean }[] = (JSON.parse(await run(["api", `repos/${repo}/contents`])) as { name: string; type: string }[])
    .map((e) => ({ name: e.name, dir: e.type === "dir" }));
  for (const f of files) {
    const [head, ...more] = f.split("/");
    if (!top.some((t) => t.name === head)) top.push({ name: head!, dir: more.length > 0 });
  }
  const numbers = tasks.map((t) => t.number);
  const others = new Map(tasks.flatMap((t) => t.parent?.subIssues.nodes ?? []).filter((s) => isTask(s) && !numbers.includes(s.number)).map((s) => [s.number, s]));
  return {
    numbers,
    named: [...new Set(tasks.flatMap((t) => scopeIn(t.body, top)))],
    siblings: [...others.values()].map((s) => ({ number: s.number, paths: scopeIn(s.body, top) })),
  };
}

/**
 * The jobs the app ran for PRs of a repository (its `GET /api/merge-records`): CI, the reviews and the rechecks are read
 * from these and from nothing a comment or an argument says. The app not answering throws, so the caller cannot judge (exit 2).
 */
export type JobsOf = (repo: string, prs: number[]) => Promise<MergeRecordJob[]>;

/**
 * What the app records of `prs` (the first is the one judged) at `head`: the jobs, whether the person's grant of the
 * head is held for the Task that runs the gate, and whether the app started that Task as a direct one that opened the PR.
 * The app not answering throws, so the caller cannot judge (exit 2).
 */
export type RecordsOf = (repo: string, prs: number[], head?: string) => Promise<MergeRecords>;

/** The Task the gate runs in: the id the app gives every Task (the kit's own variable first); none = the person runs it from their terminal. */
export const taskOf = (env: Record<string, string | undefined>): string | undefined => env.OPS_KIT_TASK_ID || env.SWITCHBOARD_TASK_ID || undefined;

/**
 * The app's records (`GET /api/merge-records`) at the address and key `env` names; `mergeRecordsEnv` fills the usual place
 * when it names none, so a terminal outside a Task reaches it too. In a Task the grant is the app's record of that Task and
 * head. Outside a Task there is no Task to record it for: the person's own `--allow-large` is the consent (it lifts
 * nothing without the flag, which `judge` reads), so `granted` is true.
 */
export const appRecords = (env: Record<string, string | undefined>, f?: (url: string, init?: RequestInit) => Promise<Response>): RecordsOf =>
  async (repo, prs, head) => {
    const taskId = taskOf(env);
    const r = await mergeRecords(mergeRecordsEnv(env), { repo, prs, ...(taskId ? { taskId } : {}), ...(head ? { head } : {}) }, f);
    return taskId ? r : { ...r, granted: true };
  };

/** The jobs alone, from the same place. No Task is sent: the app would wait (up to 110 s) for a reply of the person's still being read before it answers a call that names one, and the jobs do not depend on it. */
export const appJobs = (env: Record<string, string | undefined>, f?: (url: string, init?: RequestInit) => Promise<Response>): JobsOf =>
  async (repo, prs) => (await mergeRecords(mergeRecordsEnv(env), { repo, prs }, f)).jobs;

/**
 * `repo`: owner/name; another repository's backlog stage Task passes its own with --repo (the rules stay these).
 * `git`: where `inPass` fetches the commits to (`root`, a git worktree) and from (`url`, the repository's own, even when
 * the worktree's origin is another: --repo).
 */
export async function readPr(n: number, run = gh, repo = currentRepo(), git = { root: process.cwd(), url: `https://github.com/${repo}.git` }, held: HeldSettings | undefined = heldSettingsOf(git.root), recordsOf: RecordsOf = appRecords(process.env)): Promise<PrFacts> {
  const [owner, name] = repo.split("/");
  const pr = JSON.parse(
    await run(["pr", "view", String(n), "-R", repo, "--json", "body,files,baseRefName,baseRefOid,headRefName,headRefOid,mergeStateStatus"]),
  );
  // GitHub has not worked it out yet (just after a push or a base change): nothing to judge by
  if (pr.mergeStateStatus === "UNKNOWN") throw new Error("mergeStateStatus が UNKNOWN（GitHub が計算中。少し待ってやり直す）");
  const rules = pr.files.some((x: { path: string; changeType?: string }) => x.path === "README.md" && x.changeType !== "ADDED")
    && await readmeDesignRulesTouched(n, run, repo, pr.baseRefOid, pr.headRefOid);
  // a rename may come from an instruction path: readUserRulesTouched reads the path before it
  const userRules = pr.files.some((x: { path: string; changeType?: string }) => x.changeType !== "ADDED" && (matches(INSTRUCTIONS_FILES, x.path) || x.changeType === "RENAMED"))
    ? await readUserRulesTouched(n, run, repo, pr.baseRefOid, pr.headRefOid)
    : [];
  const runs = JSON.parse(await run(["api", `repos/${repo}/actions/runs?head_sha=${pr.headRefOid}&per_page=100`]));
  const threads = JSON.parse(
    await run([
      "api", "graphql",
      "-f", "query=query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){ reviewThreads(first:100){ totalCount nodes{ isResolved } } } } }",
      "-f", `o=${owner}`, "-f", `r=${name}`, "-F", `n=${n}`, // -f: a name like "123" or "true" stays a String (-F would type it)
    ]),
  ).data.repository.pullRequest.reviewThreads;
  if (threads.totalCount > threads.nodes.length) {
    throw new Error(`レビュースレッドが ${threads.totalCount} 件あり、1 ページ（${threads.nodes.length} 件）で読み切れない`);
  }
  // what the app recorded for this PR and for the top of its stack, where local CI is run: one read of its records
  const top = await stackTop(n, pr.headRefName, run, repo);
  const { jobs, granted, direct } = await recordsOf(repo.toLowerCase(), top === n ? [n] : [n, top], pr.headRefOid);
  // a job's head stands for the PR's head when it is the same commit or has the PR's commits with the same diff (read once per head)
  const seen = new Map<string, Promise<boolean>>();
  const covers = (jobHead: string) => jobHead === pr.headRefOid ? true : seen.get(jobHead) ?? seen.set(jobHead, inPass(git, jobHead, pr.headRefOid, pr.baseRefOid).catch((e) => { if (e instanceof HeadUnreadable) return false; throw e; })).get(jobHead)!;
  const own = jobs.filter((j) => j.pr === n);
  const local = await ciOf(jobs, top, covers, (passHead, passBase) => sharedMoved(git, sharedFilesOf(git.root), passHead, passBase, pr.baseRefOid), held);
  const checks = await checksWithLocalCi(runs.workflow_runs, local.pass, run, repo);
  const rechecks = (await rechecksOf(own, pr.headRefOid, covers)) as RecheckKind[];
  const reviewed = await reviewedOf(own, covers);
  const attacked = await attackedOf(own, covers);
  const task = await readTask(pr, pr.files.map((x: { path: string }) => x.path), run, repo);
  // how each file changed, and its path before a rename: the security groups and the scope check both judge by them
  const status = await readFileStatus(n, run, repo);
  const files: PrFacts["files"] = pr.files.map((x: PrFacts["files"][number]) => ({ path: x.path, additions: x.additions, deletions: x.deletions, ...status.get(x.path) }));
  // only a PR of a Task that touches ops.config.json: the file's two versions
  const configScope = task && files.some((x) => x.path === CONFIG_FILE) ? await readConfigScope(run, repo, pr.baseRefOid, pr.headRefOid) : undefined;
  const commentOnly = await readCommentOnly(n, files, run, repo, pr.baseRefOid, pr.headRefOid);
  for (const x of files) if (commentOnly.has(x.path)) x.commentOnly = true;
  const limitFiles = files.some((x) => LIMIT_FILES.includes(x.path));
  const forked = limitFiles ? (await run(["api", `repos/${repo}/compare/${pr.baseRefOid}...${pr.headRefOid}`, "-q", ".merge_base_commit.sha"])).trim() : "";
  const raised = limitFiles ? await limitsRaisedOf(files, (side, path) => run(["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/${contentsPath(path)}?ref=${side === "head" ? pr.headRefOid : forked}`])) : [];
  return {
    files,
    ...(configScope ? { configScope } : {}),
    checks,
    ...(rules ? { designRulesTouched: true } : {}),
    ...(userRules.length > 0 ? { userRulesTouched: userRules } : {}),
    ...(raised.length > 0 ? { limitsRaised: raised } : {}),
    ...(checks.some((c) => c.name.endsWith(LOCAL_CI_SUFFIX) || c.name === LOCAL_CI_ONLY) ? { localCi: true } : {}),
    ...(local.note ? { localCiNote: local.note } : {}),
    ...(held ? { held } : {}),
    ...(rechecks.length > 0 ? { rechecks } : {}),
    ...(reviewed ? { reviewed: true as const } : {}),
    ...(attacked ? { attacked: true as const } : {}),
    unresolvedThreads: threads.nodes.filter((t: { isResolved: boolean }) => !t.isResolved).length,
    mergeState: pr.mergeStateStatus,
    ...(granted ? { granted: true } : {}),
    subject: `PR #${n}`,
    head: pr.headRefOid,
    ...(direct ? { direct: true } : {}),
    base: pr.baseRefName,
    ...(pr.headRefName ? { branch: pr.headRefName } : {}),
    ...(task ? { task } : {}),
  };
}

/** A local change as `ops-kit backlog view --json` reads it: the stored change and its branch tips now. */
export type ChangeDetail = Detail & { issue: Detail["issue"] & { change: NonNullable<Detail["issue"]["change"]> }; changeRefs: { head: string | null; base: string | null } };

/**
 * A local change (`--change <n>`) from the app (`ops-kit backlog view <n> --json`: BACKLOG_URL and
 * BACKLOG_WORKSPACE, as the kit picks the workspace) — what a GitHub PR's view gives otherwise. Not a change, a branch
 * gone or the app not answering throws: no judgement (exit 2).
 */
export async function readChangeDetail(n: number, env: Record<string, string | undefined>, opts: { fetch?: (url: string, init?: RequestInit) => Promise<Response>; cwd?: string } = {}): Promise<ChangeDetail> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runBacklog(["view", String(n), "--change", "--json"], env, { out: (s) => out.push(s), err: (s) => err.push(s) }, opts);
  if (code !== 0) throw new Error(`#${n} を読めない: ${err.join(" ").trim() || `exit ${code}`}`);
  const d = JSON.parse(out.join("\n")) as Detail;
  if (!d.issue.change) throw new Error(`#${n} は変更ではない`);
  if (!d.changeRefs?.head || !d.changeRefs.base) throw new Error(`#${n} の枝が無い（${!d.changeRefs?.head ? d.issue.change.head : d.issue.change.base}）`);
  return d as ChangeDetail;
}

export const LOCAL_CHANGE_CI = "local-ci（ローカルで pass）";

/**
 * The facts of a local change from the app and the checkout `root` (its own git; nothing is fetched, gh is not
 * called): the same PrFacts readPr gives a PR, judged by the same `judge`. A change has no review threads of its own
 * (findings and their triage are comments); where it stands in for a GitHub pull request, that PR's threads cannot be
 * read and nothing stored has them, so a PR known to exist (`threadsUnread`) or possibly existing (`threadsUnknown`)
 * stops the merge instead of counting as none. No comment is read: the person's grant of the change's head is the app's
 * record under the workspace's own key (`local:<workspaceId>`, in lower case). The base
 * branch's protection on GitHub is not visible here: forge-resync never pushes to main directly, it always goes in
 * through a sync PR, and the judgement applies to that PR
 * (docs/design/forge-integration.md lists every reason and how the local way evaluates it).
 */
export async function readChange(d: ChangeDetail, root: string, records?: StoredRecords, recordsOf: RecordsOf = appRecords(process.env)): Promise<PrFacts> {
  const git = (...args: string[]) => sh(["git", "-C", root, ...args]);
  const { head, base } = d.changeRefs as { head: string; base: string };
  const range = `${base}...${head}`;
  // how each file changed. No renames: a rename is its two halves, a file added and a file removed, so both paths are
  // judged (the scope check and the security groups) without trusting git's guess of what was renamed. Any other letter
  // (a type change is "changed") leaves the status out: not known
  const STATUS: Record<string, FileStatus> = { A: "added", D: "removed", M: "modified", T: "changed" };
  // -z: paths as they are (git quotes a path with a non-ASCII character or a quote otherwise, and a quoted path matches no glob)
  const named = (await git("diff", "-z", "--name-status", "--no-renames", range)).split("\0");
  const status = new Map<string, FileStatus | undefined>();
  for (let i = 0; i + 1 < named.length; i += 2) if (named[i]) status.set(named[i + 1]!, STATUS[named[i]!]);
  const files: PrFacts["files"] = (await git("diff", "-z", "--numstat", "--no-renames", range)).split("\0").filter(Boolean).map((l) => {
    const [add, del, ...path] = l.split("\t");
    // a binary file is "-": no lines
    const st = status.get(path.join("\t"));
    return { path: path.join("\t"), additions: Number(add) || 0, deletions: Number(del) || 0, ...(st ? { status: st } : {}) };
  });
  const task = records ? changeTask(d, files.map((f) => f.path), records) : undefined;
  const mergeBaseOf = async () => (await git("merge-base", base, head)).trim();
  const configScope = task && files.some((f) => f.path === CONFIG_FILE)
    ? configScopeOf(await git("show", `${await mergeBaseOf()}:${CONFIG_FILE}`).catch(() => ""), await git("show", `${head}:${CONFIG_FILE}`).catch(() => ""))
    : undefined;
  // a host file: its diff's header (a mode change is not comment-only) and the whole file on both sides. The file must
  // be the same at the base's tip as at the merge base (what is merged is then the head's file)
  for (const f of files) {
    if (f.status !== "modified" || !matches(HOST_COMMENT_FILES, f.path)) continue;
    const at = (ref: string) => git("show", `${ref}:${f.path}`).catch(() => undefined);
    const diff = await git("diff", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/", range, "--", f.path).catch(() => "");
    const forked = await at(await mergeBaseOf());
    if (plainDiffHeader(diff, f.path) && forked !== undefined && forked === await at(base) && commentOnlyChange(f.path, forked, await at(head))) f.commentOnly = true;
  }
  const held = heldSettingsOf(root);
  // what the app recorded for this change: its repository is the workspace's (`local:<workspaceId>`, in lower case: the key the
  // grant of `変更 L<n> をマージしてよい` is recorded under, `changeRepoOf`), its number the change's, its head the branch's tip
  if (!d.workspaceId) throw new Error(`#${d.issue.number} の workspace が分からない（アプリの答えに workspaceId が無い。仕事の記録を引けない）`);
  const { jobs, granted, direct } = await recordsOf(`local:${d.workspaceId}`.toLowerCase(), [d.issue.number], head);
  const local = ciAtTips(jobs, d.issue.number, head, base, held);
  let rules = false;
  if (files.some((f) => f.path === "README.md")) {
    const mergeBase = (await git("merge-base", base, head)).trim();
    const readme = await git("show", `${mergeBase}:README.md`).catch(() => "");
    rules = DESIGN_RULES_HEADING.test(readme) && designRulesTouched(readme, await git("diff", range, "--", "README.md"));
  }
  const userRules: string[] = [];
  for (const f of files.filter((x) => x.status !== "added" && matches(INSTRUCTIONS_FILES, x.previous ?? x.path))) {
    const path = f.previous ?? f.path;
    const mergeBase = (await git("merge-base", base, head)).trim();
    const text = await git("show", `${mergeBase}:${path}`).catch(() => "");
    userRules.push(...markedLinesTouched(text, await git("diff", "--no-renames", range, "--", path)).map((i) => `${path}:${i}`));
  }
  const raised = await limitsRaisedOf(files, async (side, path) => git("show", `${side === "head" ? head : await mergeBaseOf()}:${path}`));
  // a job's head stands for the change's head only when it is the same commit: no PR's commits to compare by
  const sameHead = (h: string) => h === head;
  const rechecks = (await rechecksOf(jobs, head, sameHead)) as RecheckKind[];
  const reviewed = await reviewedOf(jobs, sameHead);
  const attacked = await attackedOf(jobs, sameHead);
  // a conflict with the base's tip: the merge cannot be made as is. Only exit 1 is a conflict; any other failure (an old
  // git without --write-tree, a missing object) is no judgement
  const tree = Bun.spawnSync(["git", "-C", root, "merge-tree", "--write-tree", base, head], { stdout: "ignore", stderr: "pipe" });
  if (tree.exitCode !== 0 && tree.exitCode !== 1) throw new Error(`git merge-tree が exit ${tree.exitCode}: ${tree.stderr.toString().trim().split("\n")[0]}`);
  const clean = tree.exitCode === 0;
  // in a GitHub workspace the change stands in for a pull request: whether one exists is read from what is known here,
  // not from what the Task said when it made the change
  const apart = records !== undefined && records.service !== "switchboard";
  const pr = d.issue.change.pr ?? (apart ? standsInFor(d, records!) : undefined);
  const pushed = apart && !pr && (await git("rev-parse", "--verify", "-q", `refs/remotes/origin/${d.issue.change.head}`).then((o) => o.trim() !== "", () => false));
  return {
    files,
    checks: local.pass ? [{ name: LOCAL_CHANGE_CI, conclusion: "SUCCESS" }] : [],
    ...(rules ? { designRulesTouched: true } : {}),
    ...(userRules.length > 0 ? { userRulesTouched: userRules } : {}),
    ...(raised.length > 0 ? { limitsRaised: raised } : {}),
    ...(local.note ? { localCiNote: local.note } : {}),
    ...(held ? { held } : {}),
    ...(rechecks.length > 0 ? { rechecks } : {}),
    ...(reviewed ? { reviewed: true as const } : {}),
    ...(attacked ? { attacked: true as const } : {}),
    unresolvedThreads: 0,
    ...(pr ? { threadsUnread: pr } : {}),
    ...(pushed ? { threadsUnknown: d.issue.change.head } : {}),
    mergeState: d.issue.state === "CLOSED" ? "CLOSED" : clean ? "CLEAN" : "DIRTY",
    ...(granted ? { granted: true } : {}),
    subject: `変更 L${d.issue.number}`,
    ...(direct ? { direct: true } : {}),
    head,
    base: d.issue.change.base,
    ...(configScope ? { configScope } : {}),
    ...(task ? { task } : {}),
  };
}

/**
 * The stored records of the workspace a change is in (`GET /api/backlog/records`): its Issues as the app keeps them —
 * GitHub's as last imported, when the workspace's Issues are GitHub's. The Task-scope check of a change reads them, as
 * a PR's reads GitHub. An app that does not answer throws: no judgement.
 */
export async function readChangeRecords(d: ChangeDetail, env: Record<string, string | undefined>, f: (url: string, init?: RequestInit) => Promise<Response> = fetch): Promise<StoredRecords> {
  if (!d.workspaceId) throw new Error(`#${d.issue.number} の workspace が分からない（アプリの答えに workspaceId が無い）`);
  return (await client(env, f)("GET", `/records?workspaceId=${encodeURIComponent(d.workspaceId)}`)) as StoredRecords;
}

/**
 * The Tasks a change closes (its body's `Closes #n` / `Backlog-Task: n` and its branch `sb/<n>-`, as a PR's), with the
 * paths their bodies name and what the other Tasks of their PBIs name: what `readTask` gives a PR, from the stored
 * records. Where the changes are numbered apart from a service's Issues, a linked Issue that is not stored throws (a PR
 * naming an Issue GitHub does not have is not judged either); on a backlog kept here the change itself is no Task.
 */
export function changeTask(d: ChangeDetail, files: string[], records: StoredRecords): PrFacts["task"] {
  const apart = records.service !== "switchboard";
  const issues = records.issues.filter((i) => !i.change);
  const linked = [...new Set(linkedIssues({ body: d.issue.body, headRefName: d.issue.change.head }))].filter((n) => apart || n !== d.issue.number);
  const found = linked.map((n) => issues.find((i) => i.number === n) ?? n);
  const missing = found.filter((x): x is number => typeof x === "number");
  if (apart && missing.length) throw new Error(`変更が閉じる Issue ${missing.map((n) => `#${n}`).join(", ")} が保存されていない（Task の範囲を確かめられない）`);
  const isTaskIssue = (i: { labels: string[] }) => i.labels.includes(TASK_LABEL);
  const tasks = found.filter((x): x is StoredRecords["issues"][number] => typeof x !== "number" && isTaskIssue(x));
  if (tasks.length === 0) return undefined;
  const top = [...records.top];
  for (const f of files) {
    const [first, ...more] = f.split("/");
    if (!top.some((t) => t.name === first)) top.push({ name: first!, dir: more.length > 0 });
  }
  const numbers = tasks.map((t) => t.number);
  const parents = new Set(tasks.flatMap((t) => (t.parent === null ? [] : [t.parent])));
  const others = issues.filter((i) => i.parent !== null && parents.has(i.parent) && isTaskIssue(i) && !numbers.includes(i.number));
  return {
    numbers,
    named: [...new Set(tasks.flatMap((t) => scopeIn(t.body, top)))],
    siblings: others.map((s) => ({ number: s.number, paths: scopeIn(s.body, top) })),
  };
}

/**
 * The open pull request the stored records have for an Issue a change closes (the lowest number when several): the PR
 * the change stands in for, whether or not the change was made with it. Undefined = the records have none.
 */
export function standsInFor(d: ChangeDetail, records: StoredRecords): number | undefined {
  const linked = new Set(linkedIssues({ body: d.issue.body, headRefName: d.issue.change.head }));
  return records.pulls.filter((p) => p.state === "OPEN" && p.closes.some((n) => linked.has(n))).map((p) => p.number).sort((a, b) => a - b)[0];
}

/** GitLab is still working the MR's merge status out: nothing to judge by yet. */
const GITLAB_PENDING = ["unchecked", "checking", "preparing", "approvals_syncing"];

/**
 * A GitLab MR as the facts `judge` reads; the rules stay the same. CI = the head pipeline, only when it ran on
 * the head; none (or an older one) = the local pass of the head and the target branch's tip now. A pipeline that ran and
 * failed stops the merge. No note of the MR is read: the reviews, the rechecks and the person's grant are the app's records of the MR. README.md's Design rules section is not read
 * on GitLab: an MR touching README.md counts as touching it (asked). `mergeState`: GitLab's `detailed_merge_status`,
 * `mergeable` as CLEAN; one still being worked out throws (not judged). Approvals (a paid API) are not read.
 */
export async function readGitlabPr(iid: number, sh: Sh, target: ForgeTarget, held?: HeldSettings, recordsOf: RecordsOf = appRecords(process.env)): Promise<PrFacts> {
  const r = await readGitlabMerge(sh, target, iid);
  const status = r.mr.mergeStatus;
  if (!status || GITLAB_PENDING.includes(status)) throw new Error(`detailed_merge_status が ${status ?? "無い"}（GitLab が計算中。少し待ってやり直す）`);
  const head = r.mr.head;
  // what the app recorded for this MR, by the project's path and the MR's number: a job's head stands for the MR's head only when it is the same commit
  if (!target.repository) throw new Error("GitLab のプロジェクトが分からない（仕事の記録を引けない）");
  const { jobs, granted, direct } = await recordsOf(target.repository.toLowerCase(), [iid], head);
  const local = ciAtTips(jobs, iid, head, r.baseTip, held);
  const localPass = local.pass;
  const localCiNote = local.note;
  const ran = r.pipeline && r.pipeline.sha === head ? r.pipeline : null;
  const checks: PrFacts["checks"] = ran
    ? [{ name: "GitLab pipeline", conclusion: ran.status === "success" ? "SUCCESS" : ran.status === "skipped" ? "SKIPPED" : ["created", "pending", "running", "waiting_for_resource", "preparing", "scheduled"].includes(ran.status) ? "" : ran.status.toUpperCase() }]
    : localPass ? [{ name: LOCAL_CI_ONLY, conclusion: "SUCCESS" }] : [];
  const localCi = !ran && localPass;
  const sameHead = (h: string) => h === head;
  const rechecks = (await rechecksOf(jobs, head, sameHead)) as RecheckKind[];
  const reviewed = await reviewedOf(jobs, sameHead);
  const attacked = await attackedOf(jobs, sameHead);
  // GitLab says the CI must pass when it has no pipeline of the head: the local pass is that CI here, as UNSTABLE is on GitHub
  const mergeState = status === "mergeable" ? "CLEAN" : localCi && (status === "ci_must_pass" || status === "ci_still_running") ? "UNSTABLE" : status;
  if (!r.authored.length) throw new Error(`!${iid} のコミットが読めない`);
  return {
    // GitLab's list gives a renamed file as its two paths (readGitlabMerge), so both are judged; no file is read whole, so none is comment-only
    files: r.files.map((f) => ({ ...f, status: "modified" as const })),
    checks,
    ...(r.files.some((f) => f.path === "README.md") ? { designRulesTouched: true } : {}),
    ...(localCi ? { localCi: true } : {}),
    ...(localCiNote ? { localCiNote } : {}),
    ...(held ? { held } : {}),
    ...(rechecks.length ? { rechecks } : {}),
    ...(reviewed ? { reviewed: true as const } : {}),
    ...(attacked ? { attacked: true as const } : {}),
    unresolvedThreads: r.unresolved,
    mergeState,
    ...(granted ? { granted: true } : {}),
    // the sentence the app reads (`parseMergeGrants`) names the number as `PR #n` for an MR too; an `MR !n` would grant nothing
    subject: `PR #${iid}`,
    ...(direct ? { direct: true } : {}),
    head,
    base: r.mr.target,
  };
}

export type MergeMode = "merge" | "merge-stack" | "merge-sync";

/** A read just before the merge failed (the default branch, the stack, a PR's head and base): not judged (exit 2), not a failed merge. */
export class NotJudged extends Error {}

/** A PR below the one named, judged in the same process: the head it was judged at, and whether it skipped the main review. */
export interface StackMember { n: number; head: string; reviewSkipped: boolean; base?: string }

/**
 * merge: one PR, only at the judged head (`gh pr merge --match-head-commit`). merge-stack: the named PR and every PR below it in
 * GitHub's stack, by one `gh stack merge <n>` (`below`: the lower PRs, each judged `merge` in the same run; none = the named PR is the
 * bottom). gh stack takes no -R and no head to match: it runs in the stack's worktree, whose origin must be the judged
 * repository, and the stack (`stackMembers`: which PRs, at which heads) and each PR's own head and base are read again just before the marks and again just
 * before the merge; any difference from what was judged stops it (a change in the last moment is not caught).
 */
export async function mergePr(n: number, repo: string, mode: MergeMode, facts: PrFacts, run: Run, stackRepo: () => string | undefined = originRepo, reviewSkipped = false, below: StackMember[] = []): Promise<void> {
  if (!facts.head) throw new Error("head の sha が読めていない");
  // GH_REPO is pinned to the judged repository: gh stack takes no -R, and a GH_REPO left in the environment would name another.
  // No variable marks the merge as the gate's: a Task's merge goes through the app's job (`requestGate`), which runs this in the daemon's
  // environment, where the Task's front of `gh` is not; a variable the Task could set would let any merge past that front
  const marked: Record<string, string> | undefined = mode === "merge" ? undefined : { GH_REPO: repo };
  const mark = (pr: number, head: string, skipped: boolean) => skipped ? run(["pr", "comment", String(pr), "-R", repo, "--body", `[merge-direct] ${head}`]) : undefined;
  if (mode === "merge") {
    await mark(n, facts.head, reviewSkipped);
    await run(["pr", "merge", String(n), "-R", repo, "--rebase", "--delete-branch", "--match-head-commit", facts.head], marked);
    return;
  }
  // the sync PR of the local main (`scripts/forge-resync.ts`): a Merge commit, as the landing ref is its second parent (a rebase or a squash would change the commits the local main has)
  if (mode === "merge-sync") {
    await mark(n, facts.head, reviewSkipped);
    await run(["pr", "merge", String(n), "-R", repo, "--merge", "--delete-branch", "--match-head-commit", facts.head]);
    return;
  }
  const local = stackRepo();
  if (local !== repo) throw new Error(`--merge-stack は作業ツリーの origin（${local ?? "不明"}）のスタックをマージする。判定した ${repo} と違う`);
  const stack: StackMember[] = [...below, { n, head: facts.head, reviewSkipped, base: facts.base }];
  const judged = stack.map((m) => `#${m.n}@${m.head}`).join(" ");
  // a read that fails here leaves the stack not judged (exit 2), not a failed merge
  const read = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      throw new NotJudged(`マージの直前に${what}を読み直せなかった: ${(e as Error).message}`);
    }
  };
  const defaultBranch = await read("既定の枝", async () => (await run(["repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])).trim());
  // the stack (which PRs, the heads it has) and each PR's own head and base, in case the stack's copy lags or a PR was retargeted
  const same = async () => {
    const now = (await read("スタック", () => stackMembers(n, run, repo, defaultBranch))).map((m) => `#${m.n}@${m.head}`).join(" ");
    if (now !== judged) throw new Error(`判定の後にスタックが変わった（${judged} → ${now}）。判定し直す`);
    for (const m of stack) {
      const [own, base] = (await read(`#${m.n} の head`, () => run(["pr", "view", String(m.n), "-R", repo, "--json", "headRefOid,baseRefName", "-q", '.headRefOid + " " + .baseRefName']))).trim().split(" ");
      if (own !== m.head) throw new Error(`判定の後に #${m.n} の head が変わった（${m.head} → ${own}）。判定し直す`);
      if (m.base !== undefined && base !== m.base) throw new Error(`判定の後に #${m.n} の base が変わった（${m.base} → ${base}）。判定し直す`);
    }
  };
  await same();
  if (stack.some((m) => m.reviewSkipped)) {
    for (const m of stack) await mark(m.n, m.head, m.reviewSkipped);
    await same();
  }
  await run(["stack", "merge", String(n), "--rebase", "-y"], marked);
}

const USAGE = "usage: bun scripts/merge-gate.ts <PR> [--allow-large] [--merge | --merge-stack | --merge-sync] [--repo <owner/name>]\n       bun scripts/merge-gate.ts --change <n> [--allow-large]\n       bun scripts/merge-gate.ts <PR> --scope | --change <n> --scope   (the review material of the Task scope; no judgement)";

/**
 * What a run as the app's job leaves for its record: `$J/result.json` (the judged head and the verdict's parts), which the daemon reads when
 * the job ends. Only a job has `J`; a run from a terminal leaves nothing. It is written when the verdict is known, and again with `merged`
 * once the merge is done; a write that fails is said and does not fail the run. `judged`: the named PR's judgement last, with the
 * PRs below it in a stack before it (their reasons carry the PR's number).
 */
export function writeGateResult(env: Record<string, string | undefined>, r: { head: string | null | undefined; verdict: "merge" | "stop"; judged: Array<{ pr: number | null; j: Judgement; head?: string | null }>; /** The number of the named PR, with the stack's own entries kept per PR. */ topPr?: number; allowLarge: boolean; merged: boolean }, err: (s: string) => void = console.error): void {
  if (!env.J || !r.head) return;
  try {
    const named = r.judged.at(-1)!.j;
    const record = {
      head: r.head,
      verdict: r.verdict,
      ask: [...new Set(r.judged.flatMap((x) => x.j.ask))],
      recheck: [...new Set(r.judged.flatMap((x) => x.j.recheck))],
      required: [...new Set(r.judged.flatMap((x) => x.j.required ?? []))],
      // a stack: each PR's own head and kinds, and whether its main review was skipped (the lists above are the stack's union, its reasons carry `#<n>:`)
      ...(r.topPr !== undefined && r.judged.length > 1 ? { stack: r.judged.map((x) => ({ pr: x.pr ?? r.topPr!, head: x.head ?? r.head, ask: x.j.ask, recheck: x.j.recheck, required: x.j.required ?? [], merged: r.merged, reviewSkipped: x.j.reviewSkipped === true })) } : {}),
      reasons: r.judged.flatMap((x) => x.j.reasons.map((t) => (x.pr === null ? t : `#${x.pr}: ${t}`))),
      allowLarge: r.allowLarge,
      reviewSkipped: named.reviewSkipped === true,
      merged: r.merged,
    };
    writeFileSync(join(env.J, "result.json"), JSON.stringify(record));
  } catch (e) {
    err(`仕事の記録に判定を残せない: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * In a Task (`SWITCHBOARD_TASK_ID`) the verdict is not made here: this asks the app (`BACKLOG_URL`'s origin, the key in
 * `BACKLOG_TOKEN_FILE`) to run its own copy of this script as a job (kind `gate`: the PR's number and the flags, no command), reads the job
 * every `SWITCHBOARD_GATE_POLL_MS` (2 s) until it ends or `SWITCHBOARD_GATE_WAIT_MS` (10 min) is over, prints what the job printed and ends
 * with its exit code. The app not reached, a request it refuses (an older daemon that does not know the kind), a wait that runs out and a
 * job that did not end are not judged: exit 2. The job keeps running if the wait runs out; its record says what it did.
 */
export async function requestGate(args: string[], env: Record<string, string | undefined>, cwd: string, log: (s: string) => void, err: (s: string) => void, opts: { fetch?: (url: string, init?: RequestInit) => Promise<Response>; /** Set to the head the job judged (null when it left none), for a caller that acts on the verdict and must act on that head. */ judged?: { head?: string | null } } = {}): Promise<number> {
  const f = opts.fetch ?? fetch;
  const rest = [...args];
  const take = (flag: string): boolean => {
    const at = rest.indexOf(flag);
    if (at < 0) return false;
    rest.splice(at, 1);
    return true;
  };
  const value = (flag: string): string | undefined => {
    const at = rest.indexOf(flag);
    if (at < 0) return undefined;
    const v = rest[at + 1];
    rest.splice(at, v === undefined ? 1 : 2);
    return v ?? "";
  };
  const change = value("--change");
  const repo = value("--repo");
  const allowLarge = take("--allow-large");
  const scope = take("--scope");
  const modes = (["merge", "merge-stack", "merge-sync"] as const).filter((m) => take(`--${m}`));
  const number = change !== undefined ? change : rest[0];
  if ((change !== undefined ? rest.length > 0 : rest.length !== 1) || !/^\d+$/.test(number ?? "") || Number(number) < 1 || modes.length > 1 || (repo !== undefined && !/^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/.test(repo))) {
    err(USAGE);
    return 2;
  }
  const taskId = taskOf(env);
  if (!env.BACKLOG_URL || !env.BACKLOG_TOKEN_FILE || !taskId) {
    err("判定できなかった: アプリの Task の中なのに、アプリの住所・鍵・Task の id（BACKLOG_URL・BACKLOG_TOKEN_FILE・OPS_KIT_TASK_ID）が揃っていない");
    return 2;
  }
  const origin = new URL(env.BACKLOG_URL).origin;
  const wait = Number(env.SWITCHBOARD_GATE_WAIT_MS) > 0 ? Number(env.SWITCHBOARD_GATE_WAIT_MS) : 600_000;
  const every = Number(env.SWITCHBOARD_GATE_POLL_MS) > 0 ? Number(env.SWITCHBOARD_GATE_POLL_MS) : 2_000;
  const body = { kind: "gate", taskId, cwd, pr: Number(number), ...(change !== undefined ? { change: true } : {}), ...(repo !== undefined ? { repo } : {}), ...(allowLarge ? { allowLarge } : {}), ...(modes[0] ? { merge: modes[0] } : {}), ...(scope ? { scope } : {}) };
  type Polled = { job: { id: number; status: string; exitCode: number | null; summary: string | null; result?: { gate?: { head: string | null } } | null }; out: string | null };
  const call = async (method: "GET" | "POST", path: string, payload?: unknown): Promise<unknown> => {
    const r = await f(`${origin}${path}`, { method, headers: { authorization: `Bearer ${readFileSync(env.BACKLOG_TOKEN_FILE!, "utf8").trim()}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`アプリが ${r.status} を返した: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  };
  let id: number;
  try {
    id = ((await call("POST", "/api/jobs", body)) as { id: number }).id;
  } catch (e) {
    err(`判定できなかった: 判定の仕事をアプリに頼めない: ${(e as Error).message}`);
    return 2;
  }
  const until = Date.now() + wait;
  let lost = 0;
  while (true) {
    await Bun.sleep(every);
    let p: Polled;
    try {
      p = (await call("GET", `/api/jobs/${id}`)) as Polled;
      lost = 0;
    } catch (e) {
      if (++lost >= 5 || Date.now() >= until) {
        err(`判定できなかった: 仕事 job#${id} を読めない: ${(e as Error).message}（仕事は続いていることがある。そのまま判定とマージが走りうるので、PR の状態を見てから聞き直す）`);
        return 2;
      }
      continue;
    }
    if (p.job.status !== "running") {
      if (opts.judged) opts.judged.head = p.job.result?.gate?.head ?? null;
      if (p.out) log(p.out.trimEnd());
      if (p.job.status === "aborted" || p.job.exitCode === null) {
        err(`判定できなかった: 仕事 job#${id} が終わりを残さずに止まった\n${p.job.summary ?? ""}`);
        return 2;
      }
      if (p.job.exitCode !== 0 && p.job.summary) err(p.job.summary);
      return p.job.exitCode;
    }
    if (Date.now() >= until) {
      err(`判定できなかった: 仕事 job#${id} が ${Math.round(wait / 1000)} 秒で終わらなかった（SWITCHBOARD_GATE_WAIT_MS で延ばせる。仕事は続いている。そのまま判定とマージが走りうるので、PR の状態を見てから聞き直す）`);
      return 2;
    }
  }
}

/** The command: 0 = merge (and merged, with --merge / --merge-stack) / 1 = stop, or the merge failed / 2 = not judged. Only a merge verdict merges. */
export async function main(args: string[], run: Run = gh, log = console.log, err = console.error, stackRepo: () => string | undefined = originRepo, glab: Sh = runGlab, cwd = process.cwd(), backlog: { env: Record<string, string | undefined>; fetch?: (url: string, init?: RequestInit) => Promise<Response> } = { env: process.env }): Promise<number> {
  // in a Task the verdict (and the merge) is the app's: its own copy of this script runs as a job, and its record is what the Task's verdict is
  if (backlog.env.SWITCHBOARD_TASK_ID) return requestGate(args, backlog.env, cwd, log, err, { fetch: backlog.fetch });
  // `--cwd <dir>`: the checkout to judge in, given by the app's job, which starts in the daemon's own folder. A Task's shell never reaches this (it asks the app).
  const cwdAt = args.indexOf("--cwd");
  if (cwdAt >= 0) {
    const dir = args[cwdAt + 1];
    if (!dir || !isAbsolute(dir)) {
      err(USAGE);
      return 2;
    }
    workDir = dir;
    return main([...args.slice(0, cwdAt), ...args.slice(cwdAt + 2)], run, log, err, stackRepo === originRepo ? () => originRepo(dir) : stackRepo, glab, dir, backlog);
  }
  const changeAt = args.indexOf("--change");
  if (changeAt >= 0) return changeMain(args, changeAt, log, err, cwd, backlog);
  const n = Number(args.find((a) => /^\d+$/.test(a)));
  const repoAt = args.indexOf("--repo");
  const modes = (["merge", "merge-stack", "merge-sync"] as const).filter((m) => args.includes(`--${m}`));
  // the checkout's GitLab project (its ops.config.json `forge`): the MR is judged by the same rules, merged by GitLab
  let lab: ForgeTarget | null = null;
  if (repoAt < 0) {
    try {
      const t = forgeTargetOf(cwd, originOf(cwd));
      if (t.service === "gitlab") lab = t;
    } catch (e) {
      err(`判定できなかった: ${(e as Error).message}`);
      return 2;
    }
  }
  if (lab) return gitlabMain(n, lab, args, modes, glab, log, err, cwd, backlog);
  const repo = repoAt >= 0 ? args[repoAt + 1] : currentRepo(cwd);
  if (!n || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || modes.length > 1) {
    err(USAGE);
    return 2;
  }
  let facts: PrFacts;
  try {
    facts = await readPr(n, run, repo, { root: cwd, url: `https://github.com/${repo}.git` }, undefined, appRecords(backlog.env, backlog.fetch));
  } catch (e) {
    err(`判定できなかった: ${(e as Error).message}`);
    return 2;
  }
  if (args.includes("--scope")) {
    log(scopeMaterial(facts));
    return 0;
  }
  const allowLarge = args.includes("--allow-large");
  const j = judge(facts, { allowLarge });
  const mode = modes[0];
  // --merge-stack: the named PR with every PR below it in GitHub's stack (what gh stack merges), each judged at the head the stack has.
  // Without it the run is one PR, as before (a stack is judged PR by PR, or with --merge-stack)
  const lower: Array<{ pr: number; facts: PrFacts; j: Judgement }> = [];
  if (mode === "merge-stack") {
    try {
      const defaultBranch = (await run(["repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])).trim();
      const members = await stackMembers(n, run, repo, defaultBranch);
      const top = members[members.length - 1];
      if (top?.n !== n || top.head !== facts.head) throw new Error(`スタックの #${n} の head（${top?.head ?? "無い"}）が読んだ head（${facts.head ?? "無い"}）と違う`);
      for (const m of members.slice(0, -1)) {
        const f = await readPr(m.n, run, repo, { root: cwd, url: `https://github.com/${repo}.git` }, undefined, appRecords(backlog.env, backlog.fetch));
        if (f.head !== m.head) throw new Error(`スタックの #${m.n} の head（${m.head}）が読んだ head（${f.head ?? "無い"}）と違う`);
        lower.push({ pr: m.n, facts: f, j: judge(f, { allowLarge }) });
      }
      // the order the stack lists is checked by the PRs' own branches: the lowest on the default branch, each next on the one below it
      const bases = [...lower.map((l) => l.facts.base), facts.base];
      members.forEach((m, i) => {
        const want = i === 0 ? defaultBranch : lower[i - 1]!.facts.branch;
        if (!want || bases[i] !== want) throw new Error(`スタックの #${m.n} の base（${bases[i] ?? "不明"}）が下の枝（${want ?? "不明"}）でない`);
      });
    } catch (e) {
      err(`判定できなかった: ${(e as Error).message}`);
      return 2;
    }
  }
  const all = lower.every((l) => l.j.verdict === "merge") && j.verdict === "merge";
  if (lower.length === 0) log(JSON.stringify(j, null, 2));
  else log(JSON.stringify({ verdict: all ? "merge" : "stop", stack: [...lower.map((l) => ({ pr: l.pr, ...l.j })), { pr: n, ...j }] }, null, 2));
  const record = (merged: boolean) => writeGateResult(backlog.env, { head: facts.head, verdict: all ? "merge" : "stop", judged: [...lower.map((l) => ({ pr: l.pr, j: l.j, head: l.facts.head })), { pr: null, j, head: facts.head }], topPr: n, allowLarge, merged }, err);
  record(false);
  if (!all) return 1;
  if (!mode) return 0;
  // only the sync PR of the local main goes in with a Merge commit: its branch is the one `forge-resync.ts` makes
  if (mode === "merge-sync" && !(/^sb\/sync-main-[0-9a-f]{7}$/.test(facts.branch ?? "") && lower.length === 0)) {
    err(`同期の PR ではない（枝 ${facts.branch ?? "不明"}。sb/sync-main-<7 桁> だけが Merge commit で入る）。マージしていない`);
    return 1;
  }
  try {
    const below = lower.map((l) => ({ n: l.pr, head: l.facts.head!, reviewSkipped: l.j.reviewSkipped === true, base: l.facts.base }));
    await mergePr(n, repo, mode, facts, run, stackRepo, j.reviewSkipped === true, below);
  } catch (e) {
    if (e instanceof NotJudged) {
      err(`判定できなかった: ${e.message.split("\n")[0]}`);
      return 2;
    }
    err(`マージできなかった: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  }
  record(true);
  return 0;
}

/**
 * `--change <n>`: a local change judged by the same rules from the app and the checkout's git, gh never called.
 * It only judges: the merge is scripts/local-merge.ts. A PR number, --repo or a merge mode with it is not judged (2).
 */
async function changeMain(args: string[], at: number, log: (s: string) => void, err: (s: string) => void, cwd: string, backlog: { env: Record<string, string | undefined>; fetch?: (url: string, init?: RequestInit) => Promise<Response> }): Promise<number> {
  const value = args[at + 1] ?? "";
  const rest = args.filter((_, i) => i !== at && i !== at + 1);
  if (!/^\d+$/.test(value) || rest.some((a) => a !== "--allow-large" && a !== "--scope")) {
    err(USAGE);
    return 2;
  }
  let facts: PrFacts;
  let records: StoredRecords;
  try {
    const root = (await sh(["git", "-C", cwd, "rev-parse", "--show-toplevel"])).trim();
    const detail = await readChangeDetail(Number(value), backlog.env, { fetch: backlog.fetch, cwd });
    records = await readChangeRecords(detail, backlog.env, backlog.fetch);
    facts = await readChange(detail, root, records, appRecords(backlog.env, backlog.fetch));
  } catch (e) {
    err(`判定できなかった: ${(e as Error).message}`);
    return 2;
  }
  if (args.includes("--scope")) {
    log(scopeMaterial(facts));
    return 0;
  }
  const j = judge(facts, { allowLarge: args.includes("--allow-large") });
  log(JSON.stringify(j, null, 2));
  writeGateResult(backlog.env, { head: facts.head, verdict: j.verdict, judged: [{ pr: null, j }], allowLarge: args.includes("--allow-large"), merged: false }, err);
  return j.verdict === "merge" ? 0 : 1;
}

/** The command on a GitLab MR: --merge merges only the judged head; there is no stack to merge (--merge-stack is refused). */
async function gitlabMain(n: number, target: ForgeTarget, args: string[], modes: MergeMode[], glab: Sh, log: (s: string) => void, err: (s: string) => void, cwd: string, backlog: { env: Record<string, string | undefined>; fetch?: (url: string, init?: RequestInit) => Promise<Response> }): Promise<number> {
  if (!n || modes.length > 1 || modes[0] === "merge-stack" || modes[0] === "merge-sync") {
    err(modes[0] === "merge-stack" || modes[0] === "merge-sync" ? "GitLab の MR は --merge だけ（スタックのマージも同期の PR も無い）" : USAGE);
    return 2;
  }
  let facts: PrFacts;
  try {
    facts = await readGitlabPr(n, glab, target, heldSettingsOf(cwd), appRecords(backlog.env, backlog.fetch));
  } catch (e) {
    err(`判定できなかった: ${(e as Error).message}`);
    return 2;
  }
  if (args.includes("--scope")) {
    log(scopeMaterial(facts));
    return 0;
  }
  const j = judge(facts, { allowLarge: args.includes("--allow-large") });
  log(JSON.stringify(j, null, 2));
  const record = (merged: boolean) => writeGateResult(backlog.env, { head: facts.head, verdict: j.verdict, judged: [{ pr: null, j }], allowLarge: args.includes("--allow-large"), merged }, err);
  record(false);
  if (j.verdict !== "merge") return 1;
  if (!modes[0]) return 0;
  try {
    await mergeGitlabMr(glab, target, n, facts.head!);
  } catch (e) {
    err(`マージできなかった: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  }
  record(true);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
