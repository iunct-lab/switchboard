import { readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The check in front of `gh` (#661, docs/design/secret-guard.md): what a `gh` command is about to write to GitHub,
 * as the texts findSecrets reads. `ops-kit/bin/gh` is first in the PATH of every runner the agent manager starts.
 */
/** The first line of the guard's file after the shebang; realCommand knows another copy of the guard by it. */
export const GUARD_MARK = "// gh-guard";

const WRITES: Record<string, string[]> = { issue: ["create", "new", "comment", "edit"], pr: ["create", "new", "comment", "edit", "review"] };
/** Flags of `gh issue` / `gh pr` that take a value, by what the value is. `-R` is read so that its value is not taken for the subcommand. */
const ISSUE_FLAGS: Record<string, "text" | "file" | "skip"> = { "--title": "text", "-t": "text", "--body": "text", "-b": "text", "--body-file": "file", "-F": "file", "--repo": "skip", "-R": "skip" };
const API_FLAGS: Record<string, "raw" | "typed" | "file" | "skip"> = { "--raw-field": "raw", "-f": "raw", "--field": "typed", "-F": "typed", "--input": "file", "--method": "skip", "-X": "skip", "--header": "skip", "-H": "skip", "--jq": "skip", "-q": "skip", "--template": "skip", "-t": "skip", "--hostname": "skip", "--cache": "skip", "--preview": "skip", "-p": "skip" };

/**
 * The one-letter switches (flags with no value) of each write, the only letters a group of short flags may hold
 * before its value flag (`-cb x`). A letter that is neither is the value of a flag this file does not list (`-Hfeat`),
 * and the argument is not read as a group.
 */
const SWITCHES: Record<string, string> = { "issue create": "ew", "issue new": "ew", "issue comment": "ew", "pr create": "defw", "pr new": "defw", "pr comment": "ew", "pr review": "acr", api: "i" };

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
 * The texts of a command that writes (title, body, fields), or null for a command the check lets through unread:
 * a read, an interactive write with no text on the command line, anything that is not an Issue / pull request /
 * API call. `gh api` is read whatever its method: a field is a text on its way to GitHub. `read` gives the text of
 * a file (`-` is the standard input), or null when it cannot be read — gh then says so in its own words.
 */
export function bodiesOf(argv: string[], read: (path: string) => string | null): Read[] | null {
  const group = argv.findIndex((a) => !a.startsWith("-"));
  if (group < 0) return null;
  const api = argv[group] === "api";
  if (!api && !(argv[group]! in WRITES)) return null;
  const flags: Record<string, string> = api ? API_FLAGS : ISSUE_FLAGS;
  const sub = api ? undefined : argv.slice(group + 1).find((a) => WRITES[argv[group]!]!.includes(a));
  const switches = SWITCHES[api ? "api" : `${argv[group]} ${sub}`] ?? "";
  const reads: Read[] = [];
  let write = api;
  const file = (path: string, index: number, prefix: string) => {
    const text = read(path);
    if (text !== null) reads.push(...(api ? stringsOf(text) : [text]).map((t) => ({ text: t, from: { index, path, prefix } })));
  };
  for (let i = group + 1; i < argv.length; i++) {
    const f = flagOf(argv[i]!, flags, switches);
    if (f === null) {
      // the subcommand by its name wherever it stands (a flag this table does not know may come before it)
      if (!api && WRITES[argv[group]!]!.includes(argv[i]!)) write = true;
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
  return !write || reads.length === 0 ? null : reads;
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
