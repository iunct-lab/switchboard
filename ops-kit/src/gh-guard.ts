import { readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { ownerName } from "./config.ts";

/**
 * The check in front of `gh` (docs/design/secret-guard.md): what a `gh` command is about to write to GitHub,
 * as the texts findSecrets reads. `ops-kit/bin/gh` is first in the PATH of every runner the agent manager starts.
 */
/** The first line of the guard's file after the shebang; realCommand knows another copy of the guard by it. */
export const GUARD_MARK = "// gh-guard";

type Flags = Record<string, "text" | "file" | "skip">;
/**
 * The writes of each group, by subcommand: its flags that take a value, by what the value is, and its one-letter
 * switches (flags with no value), the only letters a group of short flags may hold before its value flag (`-cb x`).
 * A letter that is neither is the value of a flag this file does not list (`-Hfeat`), and the argument is not read as
 * a group. One letter means another thing in another subcommand (`-c` is the text in `pr close`, a switch in
 * `pr review`), so each subcommand has its own row. `-R` is read so that its value is not taken for the subcommand.
 */
const ISSUE_FLAGS: Flags = { "--title": "text", "-t": "text", "--body": "text", "-b": "text", "--body-file": "file", "-F": "file", "--repo": "skip", "-R": "skip" };
const CLOSE_FLAGS: Flags = { "--comment": "text", "-c": "text", "--repo": "skip", "-R": "skip" };
const RELEASE_FLAGS: Flags = { "--title": "text", "-t": "text", "--notes": "text", "-n": "text", "--notes-file": "file", "-F": "file", "--target": "skip", "--discussion-category": "skip", "--notes-start-tag": "skip", "--repo": "skip", "-R": "skip" };
/**
 * `positional`: the arguments after the subcommand that are not flags are files whose content is sent (`-` is the
 * standard input) — all of them (`files`), or the one after the id (`source`).
 */
const GIST_FLAGS: Flags = { "--desc": "text", "-d": "text", "--filename": "skip", "-f": "skip" };
const COMMANDS: Record<string, Record<string, { flags: Flags; switches: string; positional?: "files" | "source" }>> = {
  issue: {
    create: { flags: ISSUE_FLAGS, switches: "ew" },
    new: { flags: ISSUE_FLAGS, switches: "ew" },
    comment: { flags: ISSUE_FLAGS, switches: "ew" },
    edit: { flags: ISSUE_FLAGS, switches: "" },
    close: { flags: { ...CLOSE_FLAGS, "--reason": "skip", "-r": "skip", "--duplicate-of": "skip" }, switches: "" },
  },
  pr: {
    create: { flags: ISSUE_FLAGS, switches: "defw" },
    new: { flags: ISSUE_FLAGS, switches: "defw" },
    comment: { flags: ISSUE_FLAGS, switches: "ew" },
    edit: { flags: ISSUE_FLAGS, switches: "" },
    review: { flags: ISSUE_FLAGS, switches: "acr" },
    close: { flags: CLOSE_FLAGS, switches: "d" },
    merge: { flags: { "--body": "text", "-b": "text", "--body-file": "file", "-F": "file", "--subject": "text", "-t": "text", "--author-email": "skip", "-A": "skip", "--match-head-commit": "skip", "--repo": "skip", "-R": "skip" }, switches: "dmrs" },
  },
  release: {
    create: { flags: RELEASE_FLAGS, switches: "dp" },
    new: { flags: RELEASE_FLAGS, switches: "dp" },
    edit: { flags: { ...RELEASE_FLAGS, "--tag": "skip" }, switches: "" },
  },
  gist: {
    create: { flags: GIST_FLAGS, switches: "pw", positional: "files" },
    new: { flags: GIST_FLAGS, switches: "pw", positional: "files" },
    edit: { flags: { ...GIST_FLAGS, "--add": "file", "-a": "file", "--remove": "skip", "-r": "skip" }, switches: "", positional: "source" },
  },
};
const API_FLAGS: Record<string, "raw" | "typed" | "file" | "skip"> = { "--raw-field": "raw", "-f": "raw", "--field": "typed", "-F": "typed", "--input": "file", "--method": "skip", "-X": "skip", "--header": "skip", "-H": "skip", "--jq": "skip", "-q": "skip", "--template": "skip", "-t": "skip", "--hostname": "skip", "--cache": "skip", "--preview": "skip", "-p": "skip" };
const API_SWITCHES = "i";

export interface Read {
  /** What findSecrets reads. */
  text: string;
  /** The argument that named a file or the standard input, by its place in argv (the guard may have to hand the same bytes on). */
  from?: { index: number; path: string; prefix: string };
}

/** Flag and value of one argument: `--body x` (value in the next argument), `--body=x`, `-b=x`, `-bx`, `-cb x` (switches grouped before it). */
function flagOf(arg: string, flags: Record<string, string>, switches: string): { flag: string; value?: string } | null {
  if (arg in flags) return { flag: arg };
  if (arg.startsWith("--")) {
    const eq = arg.indexOf("=");
    return eq > 0 && arg.slice(0, eq) in flags ? { flag: arg.slice(0, eq), value: arg.slice(eq + 1) } : null;
  }
  if (!/^-[A-Za-z]/.test(arg)) return null;
  // gh reads the letters of a group as switches up to the first flag that takes a value; the rest is its value
  for (let k = 1; k < arg.length && /[A-Za-z]/.test(arg[k]!); k++) {
    const short = `-${arg[k]}`;
    if (!(short in flags)) {
      if (switches.includes(arg[k]!)) continue;
      return null;
    }
    const rest = arg.slice(k + 1);
    return rest === "" ? { flag: short } : { flag: short, value: rest.startsWith("=") ? rest.slice(1) : rest };
  }
  return null;
}

/** Every string of a JSON document (a body sent with --input), each read with its own line breaks; the text itself when it is not JSON. */
function stringsOf(text: string): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") Object.values(v).forEach(walk);
  };
  try {
    walk(JSON.parse(text));
  } catch {
    return [text];
  }
  return out;
}

/**
 * Where the subcommand stands, found as gh (cobra) finds it: the first argument that is neither a flag nor the value of
 * one. A flag before the subcommand has its value in the next argument unless it is written `--flag=value` or `-xvalue`,
 * so in `issue --body close create` the subcommand is `create`. -1 when there is none.
 */
function subcommandAt(argv: string[], group: number): number {
  for (let i = group + 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("-")) return i;
    if ((a.startsWith("--") && !a.includes("=")) || a.length === 2) i++;
  }
  return -1;
}

/**
 * The texts of a command that writes (title, body, fields), or null for a command the check lets through unread:
 * a read, an interactive write with no text on the command line, anything that is not an Issue / pull request
 * write (closing comment and merge commit included), release title and notes, gist, or API call. `gh api` is read whatever its method: a field is a text on its way to GitHub. `read` gives the text of
 * a file (`-` is the standard input), or null when it cannot be read — gh then says so in its own words.
 * `stdinPiped`: the standard input is not a terminal, so `gist create` with no file reads it.
 */
export function bodiesOf(argv: string[], read: (path: string) => string | null, stdinPiped = false): Read[] | null {
  const group = argv.findIndex((a) => !a.startsWith("-"));
  if (group < 0) return null;
  const api = argv[group] === "api";
  let flags: Record<string, string> = API_FLAGS;
  let switches = API_SWITCHES;
  let positional: "files" | "source" | undefined;
  const subAt = api ? -1 : subcommandAt(argv, group);
  if (!api) {
    const subs = Object.hasOwn(COMMANDS, argv[group]!) ? COMMANDS[argv[group]!]! : {};
    const sub = argv[subAt];
    if (sub === undefined || !Object.hasOwn(subs, sub)) return null;
    ({ flags, switches, positional } = subs[sub]!);
  }
  const reads: Read[] = [];
  const file = (path: string, index: number, prefix: string) => {
    const text = read(path);
    if (text !== null) reads.push(...(api ? stringsOf(text) : [text]).map((t) => ({ text: t, from: { index, path, prefix } })));
  };
  let args = 0;
  // after `--` gh reads no more flags: every argument is positional, even one that starts with `-`
  let flagsEnd = false;
  for (let i = group + 1; i < argv.length; i++) {
    const f = flagsEnd ? null : flagOf(argv[i]!, flags, switches);
    if (f === null) {
      if (!flagsEnd && argv[i] === "--" && i > subAt) {
        flagsEnd = true;
        continue;
      }
      // an argument after the subcommand that is not a flag: the files of a gist (the id first for `edit`)
      if (positional !== undefined && i > subAt && (flagsEnd || argv[i] === "-" || !argv[i]!.startsWith("-"))) {
        args++;
        if (positional === "files" || args === 2) file(argv[i]!, i, "");
      }
      continue;
    }
    const attached = f.value !== undefined;
    const value = attached ? f.value! : argv[i + 1];
    const at = attached ? i : i + 1;
    // what stands before the value in its argument, so that the argument can be written again with another path
    const prefix = attached ? argv[i]!.slice(0, argv[i]!.length - value!.length) : "";
    if (!attached) i++;
    if (value === undefined) continue;
    const kind = flags[f.flag];
    if (kind === "text") reads.push({ text: value });
    else if (kind === "file") file(value, at, prefix);
    else if (kind === "raw" || kind === "typed") {
      const v = value.slice(value.indexOf("=") + 1);
      if (kind === "typed" && v.startsWith("@")) file(v.slice(1), at, `${prefix}${value.slice(0, value.indexOf("=") + 1)}@`);
      else reads.push({ text: v });
    }
  }
  // `gist create` with no file sends what is piped to it; gh reads the standard input itself, so no argument is replaced
  if (positional === "files" && args === 0 && stdinPiped) {
    const text = read("-");
    if (text !== null) reads.push({ text });
  }
  return reads.length === 0 ? null : reads;
}

const BACKLOG_WRITES = new Set(["create", "new", "comment", "edit", "close", "reopen"]);
/** The flags of `gh issue create / comment / edit / close / reopen` that take a value: the value is not the Issue argument. */
const ISSUE_VALUE_FLAGS = new Set(["--title", "-t", "--body", "-b", "--body-file", "-F", "--comment", "-c", "--reason", "-r", "--duplicate-of", "--assignee", "-a", "--label", "-l", "--milestone", "-m", "--project", "-p", "--template", "-T", "--recover", "--add-assignee", "--remove-assignee", "--add-label", "--remove-label", "--add-project", "--remove-project"]);
/** The stop of a write `ops-kit backlog` has no command for (deleting or moving an Issue): bin/gh says to write it with `env -u BACKLOG_URL gh …`. */
export const NO_EQUIVALENT = "Task の外の gh（この操作は ops-kit backlog に無い）";
/** `gh issue` subcommands that delete or move an Issue: the app's copy loses it, and ops-kit backlog has no equivalent. */
const ISSUE_REMOVALS = new Set(["delete", "transfer"]);
/** `gh label` subcommands that write a label's definition, which `ops-kit sync-labels` owns. */
const LABEL_DEF_WRITES = new Set(["create", "edit", "delete", "clone"]);
/** The flags of `gh label create / edit` that take a value. Only for `gh label`: elsewhere `-d` is a switch (`gh pr close -d`). */
const LABEL_VALUE_FLAGS = new Set(["--color", "-c", "--description", "-d", "--name", "-n"]);
const ISSUE_INSTEAD: Record<string, string> = { create: "create", new: "create", comment: "comment", edit: "edit", close: "edit --state closed", reopen: "edit --state open" };
const LABEL_DEF_INSTEAD = "ops-kit sync-labels（ラベルの定義。Task の中では env -u BACKLOG_URL ops-kit sync-labels）";
const PROJECT_INSTEAD = "ops-kit backlog set / triage";
const LABEL_INSTEAD = "ops-kit backlog edit --add-label / --remove-label";
const PARENT_INSTEAD = "ops-kit backlog edit --parent / --no-parent";
/**
 * The mutations of graphql that write an Issue, its comments, labels, sub-issues or Project item, and the command to
 * use instead. Creating a Project or a field (`createProjectV2*`) is not among them: `ops-kit backlog` writes neither.
 */
const BACKLOG_MUTATIONS: Array<[string[], string]> = [
  [["addProjectV2ItemById", "addProjectV2DraftIssue", "updateProjectV2ItemFieldValue", "clearProjectV2ItemFieldValue", "deleteProjectV2Item", "archiveProjectV2Item", "updateProjectV2ItemPosition"], PROJECT_INSTEAD],
  [["addSubIssue", "removeSubIssue", "reprioritizeSubIssue"], PARENT_INSTEAD],
  [["createIssue"], "ops-kit backlog create"],
  [["addComment", "updateIssueComment", "deleteIssueComment"], "ops-kit backlog comment"],
  [["addLabelsToLabelable", "removeLabelsFromLabelable"], LABEL_INSTEAD],
  [["closeIssue", "reopenIssue"], "ops-kit backlog edit --state closed / open"],
  [["updateIssue"], "ops-kit backlog edit"],
  [["deleteIssue", "transferIssue"], NO_EQUIVALENT],
  [["createLabel", "updateLabel", "deleteLabel"], LABEL_DEF_INSTEAD],
];
const PROJECT_ITEM_WRITES = new Set(["item-add", "item-edit", "item-delete", "item-archive"]);

/** A write to the backlog the app's Task makes in place of `ops-kit backlog`: the command to use instead, and the repository written to (null: none named). */
export interface BacklogWrite {
  instead: string;
  repo: string | null;
}

/**
 * A write to the backlog (Issues, their comments and labels, the Project's items) the app's Task makes in place of
 * `ops-kit backlog`, whatever form it takes: `gh issue create / comment / edit / close / reopen / delete /
 * transfer`, `gh label create / edit / delete / clone`, `gh api`
 * with a method other than GET / HEAD (or a field and no method) on `repos/<o>/<r>/issues…` or `…/labels…`, a graphql
 * mutation that names one of BACKLOG_MUTATIONS in `texts` (the fields and the `--input` bodiesOf read), and
 * `gh project item-add / item-edit / item-delete / item-archive`. Locking and pinning an Issue pass in every form: the app
 * does not sync them. `repo` is the repository it names (`-R` / `--repo`,
 * before the group too, the URL given for the Issue, or the path of `gh api`), null when it names none — gh then writes
 * to GH_REPO or the checkout's; graphql and `gh project` are read as naming none (their node id or Project is not asked
 * of GitHub). Null for anything else: a read, a pull request, Actions, git, contents, a release.
 */
export function backlogWrite(argv: string[], texts: string[] = []): BacklogWrite | null {
  let named: string | undefined;
  const words: number[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    // after `--` gh reads no more flags: the rest are arguments (the Issue's URL among them)
    if (a === "--") {
      for (let j = i + 1; j < argv.length; j++) words.push(j);
      break;
    }
    if (a === "-R" || a === "--repo") named = argv[++i];
    else if (/^(?:--repo=|-R=?)./.test(a)) named = a.replace(/^(?:--repo=|-R=?)/, "");
    // the value of a flag (a body that is a URL or starts with -R) names no repository and is not the Issue
    else if (ISSUE_VALUE_FLAGS.has(a) || (words.length > 0 && argv[words[0]!] === "label" && LABEL_VALUE_FLAGS.has(a))) i++;
    else if (!a.startsWith("-")) words.push(i);
  }
  if (words.length === 0) return null;
  const at = words[0]!;
  if (argv[at] === "api") return apiBacklogWrite(argv, at, texts);
  if (argv[at] === "project") return PROJECT_ITEM_WRITES.has(argv[subcommandAt(argv, at)] ?? "") ? { instead: PROJECT_INSTEAD, repo: null } : null;
  const [group, sub, ...refs] = words.map((i) => argv[i]!);
  const repoNamed = named !== undefined ? named.split("/").slice(-2).join("/") : undefined;
  // a label's definition: only -R / --repo names the repository (the argument of `clone` is the source)
  if (group === "label" && sub !== undefined && LABEL_DEF_WRITES.has(sub)) return { instead: LABEL_DEF_INSTEAD, repo: repoNamed ?? null };
  if (group !== "issue" || sub === undefined || !(BACKLOG_WRITES.has(sub) || ISSUE_REMOVALS.has(sub))) return null;
  // `transfer` takes the Issue, then the repository it moves to: the Issue's side is the one written
  const issueRefs = ISSUE_REMOVALS.has(sub) ? refs.slice(0, 1) : refs;
  const url = issueRefs.map((r) => /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/\d+/.exec(r)?.[1]).find((r) => r !== undefined);
  return { instead: ISSUE_REMOVALS.has(sub) ? NO_EQUIVALENT : `ops-kit backlog ${ISSUE_INSTEAD[sub]}`, repo: repoNamed ?? url ?? null };
}

function apiBacklogWrite(argv: string[], at: number, texts: string[]): BacklogWrite | null {
  const call = apiCallOf(argv, at);
  if (call === null) return null;
  if (call.path === "graphql") {
    if (!texts.some((t) => /\bmutation\b/.test(t))) return null;
    const hit = BACKLOG_MUTATIONS.find(([names]) => names.some((n) => texts.some((t) => new RegExp(`\\b${n}\\b`).test(t))));
    return hit ? { instead: hit[1], repo: null } : null;
  }
  if (!call.writes) return null;
  const m = /^repos\/([^/?]+)\/([^/?]+)\/((?:issues|labels)(?:\/[^?]*)?)(?:\?|$)/.exec(call.path);
  if (!m) return null;
  // `{owner}/{repo}` and the older `:owner/:repo` are filled by gh from GH_REPO or the checkout: none named
  const repo = /^[{:]/.test(m[1]!) || /^[{:]/.test(m[2]!) ? null : `${m[1]}/${m[2]}`;
  const rest = m[3]!.replace(/\/$/, "");
  const instead =
    rest === "labels" || rest.startsWith("labels/") ? LABEL_DEF_INSTEAD
    : rest === "issues" ? "ops-kit backlog create"
    : /^issues\/comments\/[^/]+$/.test(rest) ? "ops-kit backlog comment（コメントの編集・削除は無いので、新しいコメントで書く）"
    : /^issues\/[^/]+\/comments$/.test(rest) ? "ops-kit backlog comment"
    : /^issues\/[^/]+\/labels(\/|$)/.test(rest) ? LABEL_INSTEAD
    : /^issues\/[^/]+\/(sub_issues?|parent)(\/|$)/.test(rest) ? PARENT_INSTEAD
    : /^issues\/[^/]+\/transfer$/.test(rest) ? NO_EQUIVALENT
    // locking is not a value the app syncs: it does not conflict with the app's copy
    : /^issues\/[^/]+\/lock$/.test(rest) ? null
    : "ops-kit backlog edit";
  return instead === null ? null : { instead, repo };
}

/** The flags of `gh pr merge` / `gh stack merge` that take a value (the argument that is the PR is not one of them). */
const MERGE_VALUE_FLAGS = new Set(["--body", "-b", "--body-file", "-F", "--subject", "-t", "--author-email", "-A", "--match-head-commit"]);

/** The arguments of a `gh` command that are not flags or the values of the flags in MERGE_VALUE_FLAGS (`-R` / `--repo` too); after `--` all are arguments. */
function wordsOf(argv: string[]): string[] {
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      words.push(...argv.slice(i + 1));
      break;
    }
    if (a === "-R" || a === "--repo") i++;
    else if (MERGE_VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith("-")) words.push(a);
  }
  return words;
}

/**
 * A write that merges a pull request: `gh pr merge <n|url|branch>`, `gh stack merge <n>`, `gh api` with a method other than GET /
 * HEAD on `repos/<o>/<r>/pulls/<n>/merge`, and a graphql mutation that names `mergePullRequest` in `texts`. `pr` is the PR
 * it names (a number, or the number in its URL); null when it names none (a branch, the current branch, graphql). `-R` before the
 * group, `--` and a URL are read as backlogWrite reads them. Null for anything else.
 */
export function mergeWrite(argv: string[], texts: string[] = []): { pr: number | null } | null {
  const words = wordsOf(argv);
  const [group, sub, ref] = words;
  if (group === "api") {
    const at = argv.indexOf("api");
    const call = apiCallOf(argv, at);
    if (call === null) return null;
    if (call.path === "graphql") return call.mutation && texts.some((t) => /\bmutation\b/.test(t) && /\bmergePullRequest\b/.test(t)) ? { pr: null } : null;
    const m = /^repos\/[^/?]+\/[^/?]+\/pulls\/(\d+)\/merge(?:\?|$)/.exec(call.path);
    return call.writes && m ? { pr: Number(m[1]) } : null;
  }
  if (!((group === "pr" || group === "stack") && sub === "merge")) return null;
  const n = ref === undefined ? undefined : /^\d+$/.test(ref) ? ref : /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(ref)?.[1];
  return { pr: n === undefined ? null : Number(n) };
}

/**
 * The head a merge is held to on the command line, and whether the merge can carry one to GitHub. `gh pr merge`: its
 * `--match-head-commit <sha>` (null when it names none; `at` is where the flag can be added, right after `merge`).
 * A REST `gh api` PUT of `pulls/<n>/merge`: the `sha` field of its body (`-f`/`-F`/`--field`/`--raw-field`, 40 lower-case hex digits,
 * read as written because gh sends it as written; null when it has none, names it twice, or the body comes from `--input`). `carries` is false for `gh stack merge` and
 * graphql, which have no place to name a head.
 */
export function mergeHeadOf(argv: string[]): { head: string | null; at: number | null; carries: boolean } {
  const [group, sub] = wordsOf(argv);
  if (group === "api") {
    const call = apiCallOf(argv, argv.indexOf("api"));
    if (call === null || call.path === "graphql") return { head: null, at: null, carries: false };
    const shas: string[] = [];
    let input = false;
    for (let j = argv.indexOf("api") + 1; j < argv.length; j++) {
      const f = flagOf(argv[j]!, API_FLAGS, API_SWITCHES);
      if (f === null) continue;
      const value = f.value ?? argv[++j];
      if (value === undefined) continue;
      const kind = API_FLAGS[f.flag];
      if (kind === "file") input = true;
      else if ((kind === "raw" || kind === "typed") && value.startsWith("sha=")) shas.push(value.slice(4));
    }
    return { head: !input && shas.length === 1 && /^[0-9a-f]{40}$/.test(shas[0]!) ? shas[0]! : null, at: null, carries: true };
  }
  // read as gh reads it: the value of another flag (`--subject`, `--body`, `-R`, …) is text, not the flag, and the last one wins
  let head: string | null = null;
  for (let i = 0; i < argv.length && argv[i] !== "--"; i++) {
    const a = argv[i]!;
    if (a === "--match-head-commit") head = argv[++i]?.toLowerCase() ?? null;
    else if (a.startsWith("--match-head-commit=")) head = a.slice("--match-head-commit=".length).toLowerCase();
    else if (a === "-R" || a === "--repo" || MERGE_VALUE_FLAGS.has(a)) i++;
  }
  const pr = argv.indexOf("pr");
  const merge = argv.indexOf("merge", pr + 1);
  const isPr = group === "pr" && sub === "merge" && pr >= 0 && merge > pr;
  return { head, at: isPr ? merge + 1 : null, carries: isPr };
}

/** The switches a merge outside the gate may carry: the merge method and deleting the branch. */
const PLAIN_MERGE_SWITCHES = new Set(["--rebase", "-r", "--merge", "-m", "--squash", "-s", "--delete-branch", "-d"]);
/** The body fields a REST merge outside the gate may carry. */
const PLAIN_MERGE_FIELDS = new Set(["sha", "merge_method", "commit_title", "commit_message"]);

/**
 * A merge outside the gate in the one shape the guard reads exactly as gh does, or null for any other shape (the guard then
 * stops it rather than guess how gh reads it: for example a flag's value or a group of short flags).
 * `gh pr merge <n|github.com PR URL>` with only `-R`/`--repo <owner/name>`, the switches above and `--match-head-commit <40 hex>`;
 * a URL and `-R` naming different repositories is not it. `gh api` first, a PUT (`-X`/`--method`) of
 * `repos/<o>/<r>/pulls/<n>/merge`, and only the fields above with `-f`/`-F`/`--field`/`--raw-field`, each once (`sha` by `-f` /
 * `--raw-field` only).
 * `repo` is the repository the merge names (null: none, the clone's own); `head` the head it names (null: none).
 */
export function plainMergeOf(argv: string[]): { pr: number; repo: string | null; head: string | null } | null {
  // github.com only: the grant is kept by owner/name, with no host
  const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,9})$/;
  const hex = /^[0-9a-f]{40}$/;
  if (argv[0] === "api") {
    let method: string | null = null;
    let path: RegExpExecArray | null = null;
    const fields = new Map<string, string>();
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]!;
      const m = /^(-X|--method)(?:=(.*))?$/.exec(a) ?? (/^-X(.+)$/.exec(a) ? ["", "-X", a.slice(2)] : null);
      if (m) {
        const v = m[2] ?? argv[++i];
        if (v === undefined || method !== null) return null;
        method = v.toUpperCase();
        continue;
      }
      // `-f sha=…`, `-f=sha=…`, `-fsha=…` and the long forms, as pflag reads them
      const f = /^(--field|--raw-field)(?:=(.*))?$/s.exec(a) ?? /^(-f|-F)(?:=?(.+))?$/s.exec(a);
      if (f) {
        const v = f[2] ?? argv[++i];
        const kv = v === undefined ? null : /^([a-z_]+)=(.*)$/s.exec(v);
        if (kv === null || !PLAIN_MERGE_FIELDS.has(kv[1]!) || fields.has(kv[1]!)) return null;
        // `-F` / `--field` may send a value as a number or a file's content; the head goes as the text written (`-f`)
        if (kv[1] === "sha" && (f[1] === "-F" || f[1] === "--field")) return null;
        fields.set(kv[1]!, kv[2]!);
        continue;
      }
      if (a.startsWith("-") || path !== null) return null;
      // the repository is named: gh fills `{owner}/{repo}` from its own choice of remote, which the guard cannot follow
      path = /^\/?repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d{1,9})\/merge$/.exec(a);
      if (path === null) return null;
    }
    const sha = fields.get("sha");
    if (method !== "PUT" || path === null || (sha !== undefined && !hex.test(sha))) return null;
    return { pr: Number(path[2]), repo: path[1]!, head: sha ?? null };
  }
  const words: string[] = [];
  let named: string | null = null;
  let head: string | null = null;
  let heads = 0;
  let methods = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-R" || a === "--repo" || a.startsWith("--repo=")) {
      const v = a.startsWith("--repo=") ? a.slice("--repo=".length) : argv[++i];
      if (v === undefined || named !== null || !/^[\w.][\w.-]*\/[\w.-]+$/.test(v)) return null;
      named = v;
    } else if (a === "--match-head-commit" || a.startsWith("--match-head-commit=")) {
      const v = a === "--match-head-commit" ? argv[++i] : a.slice("--match-head-commit=".length);
      if (v === undefined || !hex.test(v) || ++heads > 1) return null;
      head = v;
    } else if (PLAIN_MERGE_SWITCHES.has(a)) {
      // one merge method at most, as gh takes it
      if (!/^-(d|-delete-branch)$/.test(a) && ++methods > 1) return null;
    }
    else if (a.startsWith("-")) return null;
    else words.push(a);
  }
  if (words.length !== 3 || words[0] !== "pr" || words[1] !== "merge") return null;
  const ref = words[2]!;
  const u = url.exec(ref);
  if (u === null && !/^\d{1,9}$/.test(ref)) return null;
  if (u !== null && named !== null && ownerName(u[1]!) !== ownerName(named)) return null;
  return { pr: Number(u?.[2] ?? ref), repo: u?.[1] ?? named, head };
}

/**
 * The environment variable `public-sync` sets on the one `gh` that merges its own sync PR: `<owner/name>#<n>` of the public copy
 * and the PR. The public copy takes no PR but the sync's, and the merge gate judges this repository's PRs only, so that merge
 * does not go through the gate.
 */
export const PUBLIC_SYNC_MARK = "OPS_PUBLIC_SYNC_PR";

/**
 * Whether a merge of PR `pr` is `public-sync`'s own: a merge whose write goes to `publicCopy` (`publicSync.target` of the working
 * tree; `writeTargetOf` names none for `gh stack`, and a graphql merge has no PR number, so neither is it), with no PR URL of
 * another repository (gh merges the URL's repository whatever `-R` says), and the mark names that repository and that PR.
 * Repositories are compared as `owner/name`, so a target written as a URL or with `.git` is the same. A merge of this
 * repository's PR, or of another repository's, is not it.
 */
export function publicSyncMerge(argv: string[], env: Record<string, string | undefined>, publicCopy: string | null, pr: number | null): boolean {
  if (publicCopy === null || pr === null) return false;
  const copy = ownerName(publicCopy);
  const repo = writeTargetOf(argv, env)?.repo;
  if (typeof repo !== "string" || ownerName(repo) !== copy) return false;
  if (argv.some((a) => { const u = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(a)?.[1]; return u !== undefined && ownerName(u) !== copy; })) return false;
  return env[PUBLIC_SYNC_MARK]?.trim().toLowerCase() === `${copy}#${pr}`;
}

/** The subcommands of each group that only read; any other subcommand of these groups writes. */
const READS: Record<string, Set<string>> = {
  issue: new Set(["list", "view", "status"]),
  pr: new Set(["list", "view", "status", "diff", "checks", "checkout"]),
  label: new Set(["list"]),
  release: new Set(["list", "view", "download"]),
};

/**
 * Where a write goes: the repository it names (`-R` / `--repo`, else the URL given for the Issue or pull
 * request, else `GH_REPO`), null when it names none (gh then writes to the checkout's default). Null for anything
 * that does not write: a read of `issue` / `pr` / `label` / `release`, `gh api` with GET, any other group.
 * `gh api` writes with a method other than GET / HEAD, or with a field and no method (gh then sends POST);
 * `graphql` writes when a field holds a mutation (or is read from a file). Only `repos/<owner>/<name>/…` names one;
 * `{owner}/{repo}` and `graphql` go where GH_REPO says, as gh fills them.
 */
export function writeTargetOf(argv: string[], env: Record<string, string | undefined>): { repo: string | null } | null {
  let named: string | undefined;
  let i = 0;
  // gh takes -R before the group too
  for (; i < argv.length && argv[i]!.startsWith("-"); i++) {
    if (argv[i] === "-R" || argv[i] === "--repo") named = argv[++i];
    else if (/^(?:--repo=|-R=?)./.test(argv[i]!)) named = argv[i]!.replace(/^(?:--repo=|-R=?)/, "");
  }
  const group = argv[i];
  if (group === undefined) return null;
  if (group === "api") {
    const call = apiCallOf(argv, i);
    if (call === null) return null;
    if (call.path === "graphql") return call.mutation ? { repo: env.GH_REPO || null } : null;
    if (!call.writes) return null;
    const m = /^repos\/([^/{}?]+)\/([^/{}?]+)(?:[/?]|$)/.exec(call.path);
    return { repo: m ? `${m[1]}/${m[2]}` : env.GH_REPO || null };
  }
  const reads = READS[group];
  if (reads === undefined) return null;
  const subAt = subcommandAt(argv, i);
  const sub = argv[subAt];
  if (sub === undefined || reads.has(sub)) return null;
  let url: string | undefined;
  // -R stands before the subcommand too (`issue -R x create`)
  for (let j = i + 1; j < argv.length; j++) {
    if (j === subAt) continue;
    const a = argv[j]!;
    if (a === "-R" || a === "--repo") named = argv[++j];
    else if (/^(?:--repo=|-R=?)./.test(a)) named = a.replace(/^(?:--repo=|-R=?)/, "");
    else if (ISSUE_VALUE_FLAGS.has(a)) j++;
    else url ??= /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+/.exec(a)?.[1];
  }
  return { repo: named ?? url ?? (env.GH_REPO || null) };
}

/**
 * A `gh api` call whose group stands at `at`: its endpoint as a path (`repos/…`, `graphql`; a full URL loses its host),
 * whether it writes (a method other than GET / HEAD, or a field and no method: gh then sends POST), and whether a field
 * may hold a mutation (one says `mutation`, or is read from a file). Null when it names no endpoint.
 */
function apiCallOf(argv: string[], at: number): { path: string; writes: boolean; mutation: boolean } | null {
  let method: string | undefined;
  let fields = false;
  let mutation = false;
  let endpoint: string | undefined;
  for (let j = at + 1; j < argv.length; j++) {
    const f = flagOf(argv[j]!, API_FLAGS, API_SWITCHES);
    if (f === null) {
      if (endpoint === undefined && !argv[j]!.startsWith("-")) endpoint = argv[j];
      continue;
    }
    const value = f.value ?? argv[++j];
    if (value === undefined) continue;
    const kind = API_FLAGS[f.flag];
    if (f.flag === "-X" || f.flag === "--method") method = value.toUpperCase();
    else if (kind === "raw" || kind === "typed" || kind === "file") {
      fields = true;
      const v = value.slice(value.indexOf("=") + 1);
      if (kind === "file" || (kind === "typed" && v.startsWith("@")) || /\bmutation\b/.test(v)) mutation = true;
    }
  }
  if (endpoint === undefined) return null;
  const path = endpoint.replace(/^https?:\/\/[^/]+/i, "").replace(/^\//, "");
  return { path, writes: method !== undefined ? method !== "GET" && method !== "HEAD" : fields, mutation };
}

/** The first `name` of the PATH that is not a guard: not this file, and not another checkout's copy of it (it holds `mark`). */
export function realCommand(name: string, path: string, self: string, mark: string): string | null {
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (!st.isFile() || (st.mode & 0o111) === 0 || realpathSync(p) === realpathSync(self)) continue;
      if (st.size < 100_000 && readFileSync(p, "utf8").includes(mark)) continue;
      return p;
    } catch {
      // no such command in this entry of the PATH, or one that cannot be read
    }
  }
  return null;
}
