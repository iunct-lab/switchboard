import { isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentEvent, AnswerPolicy, ApprovalRuleMatch, KnowledgeDoc, Task, Workspace } from "@switchboard/protocol";
import type { KnowledgeStore } from "./knowledge.ts";
import { appliesTo } from "./materializer.ts";
import { safeRealpath } from "./mcp.ts";
import { matchPolicies } from "./policies.ts";
import { issueOf } from "./stops.ts";

/** Shell syntax that turns one command into several; an allow rule never covers a command containing it. */
const SHELL_SYNTAX = /[;|&<>$`(){}\n\r]/;

/**
 * Approval rules (issue #13). Knowledge documents carry
 *   approval: { confirm: ["docker-compose*.yml", ".github/**"], allow: ["*.md", "bun test*"] }
 * Patterns are globs matched against the path a write touches (relative to the scope root, and absolute) or the
 * command an exec runs. `confirm` always wins over `allow`; with no match the default stays "ask every time".
 * An auto-allow is recorded as permission.resolved(by: rule) with the rule that fired, so it is auditable.
 */
export type Verdict = { decision: "ask"; match?: ApprovalRuleMatch } | { decision: "allow"; match: ApprovalRuleMatch };

export interface ApprovalRuleSet {
  source: string;
  confirm: string[];
  allow: string[];
}

export function rulesFromDocs(docs: KnowledgeDoc[], ws: Workspace | null): ApprovalRuleSet[] {
  return docs
    .filter((d) => d.frontmatter.approval && !d.frontmatter._invalid && (ws ? appliesTo(d, ws) : !d.frontmatter.repo && !d.frontmatter.repos?.length))
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((d) => ({ source: d.path, confirm: d.frontmatter.approval?.confirm ?? [], allow: d.frontmatter.approval?.allow ?? [] }));
}

export interface Subjects {
  kind: "path" | "command";
  /** Paths: relative to the containing scope root ("/"-separated). Commands: the command line. */
  values: string[];
  /** A path outside every scope root, or a command with shell syntax: never auto-allowed. */
  blocked: boolean;
}

/**
 * What a permission.ask is about. Only `write` asks (paths from the structured input, never from display text) and
 * `exec` asks (the command line) can be matched; `network` / `other` asks are always for the user.
 * Paths are resolved with symlinks and must fall inside one of the task's scope roots; an outside path blocks
 * auto-allow for the whole ask. Commands containing shell syntax likewise.
 */
export function subjectsOf(ask: Extract<AgentEvent, { t: "permission.ask" }>, task: Task): Subjects {
  const roots = (task.scope.length ? task.scope : [task.cwd]).map((r) => safeRealpath(resolve(r)));
  const input = (ask.input ?? {}) as Record<string, unknown>;
  if (ask.kind === "exec") {
    const cmd = typeof input.command === "string" ? input.command.trim() : "";
    if (!cmd) return { kind: "command", values: [], blocked: true };
    return { kind: "command", values: [cmd], blocked: SHELL_SYNTAX.test(cmd) };
  }
  if (ask.kind !== "write") return { kind: "path", values: [], blocked: true };
  const values: string[] = [];
  let blocked = false;
  const addPath = (p: unknown) => {
    if (typeof p !== "string" || !p) return;
    const abs = safeRealpath(isAbsolute(p) ? p : resolve(roots[0]!, p));
    const root = roots.find((r) => abs === r || abs.startsWith(r + sep));
    if (!root) {
      blocked = true;
      return;
    }
    values.push(relative(root, abs).split(sep).join("/"));
  };
  addPath(input.file_path);
  addPath(input.notebook_path);
  addPath(input.path);
  for (const c of (input.changes as Array<{ path?: unknown }> | undefined) ?? []) addPath(c?.path);
  if (values.length === 0) blocked = true;
  return { kind: "path", values, blocked };
}

/** The saved answer policies (#938) an approval is also checked against, after the Knowledge `confirm` rules and before `allow`. */
export interface PolicyView {
  list: AnswerPolicy[];
  pbiOpen: (workspaceId: string | null, number: number) => boolean;
  now: number;
}

export function evaluate(rules: ApprovalRuleSet[], ask: Extract<AgentEvent, { t: "permission.ask" }>, task: Task, policies?: PolicyView): Verdict {
  const subjects = subjectsOf(ask, task);
  const isCommand = subjects.kind === "command";
  for (const r of rules) {
    for (const pattern of r.confirm) {
      const hit = subjects.values.find((s) => globMatch(pattern, s, isCommand));
      if (hit !== undefined) return { decision: "ask", match: { source: r.source, pattern, mode: "confirm", subject: hit } };
    }
  }
  if (subjects.blocked) return { decision: "ask" };
  if (policies?.list.length && (ask.kind === "exec" || ask.kind === "write") && subjects.values.length === 1) {
    const pbi = issueOf(task);
    const subject = { kind: "approval" as const, op: ask.kind, target: subjects.values[0]!, conditions: [], head: null };
    const hit = matchPolicies(policies.list, { id: `approval:${task.id}:${ask.id}`, subject, workspaceId: task.workspaceId, pbi, pbiOpen: pbi !== null && policies.pbiOpen(task.workspaceId, pbi), choices: [] }, policies.now).hit;
    if (hit) return { decision: "allow", match: { source: `policy:${hit.id}`, pattern: hit.target, mode: "allow", subject: subject.target } };
  }
  for (const r of rules) {
    for (const pattern of r.allow) {
      const hit = subjects.values.find((s) => globMatch(pattern, s, isCommand));
      if (hit !== undefined) return { decision: "allow", match: { source: r.source, pattern, mode: "allow", subject: hit } };
    }
  }
  return { decision: "ask" };
}

/** The `confirm` rule that fires on a tool approval, or null (what always asks, #938: a saved policy never overrides it). */
export function confirmHitOf(rules: ApprovalRuleSet[], ask: Extract<AgentEvent, { t: "permission.ask" }>, task: Task): ApprovalRuleMatch | null {
  const v = evaluate(rules, ask, task);
  return v.decision === "ask" && v.match?.mode === "confirm" ? v.match : null;
}

/** The `confirm` rule that fires on a stop record's `<op> <target>` read as a command (#938), or null. */
export function confirmHitOfCommand(rules: ApprovalRuleSet[], command: string): ApprovalRuleMatch | null {
  for (const r of rules) for (const pattern of r.confirm) if (globMatch(pattern, command, true)) return { source: r.source, pattern, mode: "confirm", subject: command };
  return null;
}

export class ApprovalRules {
  constructor(
    private store: KnowledgeStore,
    private workspaceOf: (task: Task) => Workspace | null,
    private workspaceById: (id: string) => Workspace | null = () => null,
    private policies: () => Omit<PolicyView, "now"> = () => ({ list: [], pbiOpen: () => true }),
  ) {}
  /** The confirm rule a Task's tool approval hits (#938), or null. */
  confirmHit(task: Task, ask: Extract<AgentEvent, { t: "permission.ask" }>): ApprovalRuleMatch | null {
    const ws = this.workspaceOf(task);
    return confirmHitOf(rulesFromDocs(this.store.list(), ws), ask, task);
  }
  /** The confirm rule a saved policy's subject hits (#938): an approval's path / command, or a stop record's `<op> <target>`. */
  confirmOf(workspaceId: string | null, kind: string, op: string, target: string): ApprovalRuleMatch | null {
    const rules = rulesFromDocs(this.store.list(), workspaceId ? this.workspaceById(workspaceId) : null);
    if (kind !== "approval") return confirmHitOfCommand(rules, `${op} ${target}`);
    for (const r of rules) for (const pattern of r.confirm) if (globMatch(pattern, target, op === "exec")) return { source: r.source, pattern, mode: "confirm", subject: target };
    return null;
  }
  evaluate(task: Task, ask: Extract<AgentEvent, { t: "permission.ask" }>): Verdict {
    const ws = this.workspaceOf(task);
    // Repo-scoped rules for this workspace plus global ones; a task without a workspace only sees global rules.
    const docs = this.store.list();
    const rules = ws ? rulesFromDocs(docs, ws) : rulesFromDocs(docs, null);
    return evaluate(rules, ask, task, { ...this.policies(), now: Date.now() });
  }
}

/* ---------- glob ---------- */

const cache = new Map<string, RegExp>();

/**
 * Glob → RegExp: `*` (no `/`), `**` (anything), `?`, `{a,b}`, `[…]`. A pattern without `/` matches against the last
 * path segment too (so `*.md` hits `docs/x.md`). For command lines (`command: true`) `*` matches anything, `/`
 * included, so `bun test*` covers `bun test packages/core`.
 */
export function globToRegExp(glob: string, command = false): RegExp {
  const key = `${command ? "c:" : "p:"}${glob}`;
  let re = cache.get(key);
  if (re) return re;
  const star = command ? ".*" : "[^/]*";
  let src = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") i++;
        src += "(?:.*/)?";
        if (glob[i + 1] === undefined) src += ".*";
      } else src += star;
    } else if (c === "?") src += command ? "." : "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end < 0) src += "\\{";
      else {
        src += "(?:" + glob.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, star)).join("|") + ")";
        i = end;
      }
    } else if (c === "[") {
      const end = glob.indexOf("]", i);
      if (end < 0) src += "\\[";
      else {
        const body = glob.slice(i + 1, end).replace(/\\/g, "\\\\");
        src += "[" + (body.startsWith("!") ? "^" + body.slice(1) : body) + "]";
        i = end;
      }
    } else src += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  re = new RegExp(`^${src}$`);
  cache.set(key, re);
  return re;
}

/**
 * Path patterns and command patterns never cross. A pattern is a command pattern when it starts with `cmd:` or
 * contains a space; the caller says which kind the subject is (paths may contain spaces too). A plain path pattern
 * without `/` also matches the file's basename (so `*.md` hits `docs/x.md` — inside the scope, since subjects are
 * scope-relative by construction).
 */
export function globMatch(glob: string, subject: string, isCommand = false): boolean {
  const cmdPattern = glob.startsWith("cmd:") || glob.includes(" ");
  if (cmdPattern !== isCommand) return false;
  const g = glob.startsWith("cmd:") ? glob.slice(4) : glob;
  const re = globToRegExp(g, isCommand);
  if (re.test(subject)) return true;
  if (!isCommand && !g.includes("/") && subject.includes("/")) return re.test(subject.split("/").pop()!);
  return false;
}
