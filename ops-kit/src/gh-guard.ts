import { readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The check in front of `gh` (#661, docs/design/secret-guard.md): what a `gh` command is about to write to GitHub,
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

/**
 * An Issue write the app's Task makes in place of `ops-kit backlog` (#2694): its subcommand, and the repository it
 * names (`-R` / `--repo`, before the group too, or the URL given for the Issue), null when it names none — gh then
 * writes to GH_REPO or the checkout's. Null for anything else: a read, a pull request, `gh api`.
 */
export function backlogWrite(argv: string[]): { sub: string; repo: string | null } | null {
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
    else if (ISSUE_VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith("-")) words.push(i);
  }
  const [group, sub, ...refs] = words.map((i) => argv[i]!);
  if (group !== "issue" || sub === undefined || !BACKLOG_WRITES.has(sub)) return null;
  const url = refs.map((r) => /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/issues\/\d+/.exec(r)?.[1]).find((r) => r !== undefined);
  return { sub, repo: named !== undefined ? named.split("/").slice(-2).join("/") : (url ?? null) };
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
