/**
 * The rechecks whose pass is decided by a command (`docs/merge-gate.md`, "Recheck"): the app runs this as a job in the
 * PR's checkout (`ops-kit job request recheck`), so the Task does not keep a shell open for them.
 *
 *   bun scripts/recheck.ts <migration|rescue|security:lockfile> [--head <sha>] [--base <ref>]
 *
 * It runs the kind's commands in order and ends with the exit code of the first one that fails. The kinds that need a
 * reader (size, responsibility, ...) are reviews, not commands, and are not here.
 */
import { basename } from "node:path";
import { SECURITY_GROUPS } from "./merge-gate.ts";

export type CommandKind = "migration" | "rescue" | "security:lockfile";
export const COMMAND_KINDS = ["migration", "rescue", "security:lockfile"] as const;

/** The commands of each kind, run from the checkout's root. The one place the table lives. */
export const RECHECK_COMMANDS: Record<CommandKind, string[][]> = {
  migration: [["env", "-u", "SWITCHBOARD_SUPERVISED", "bun", "test", "packages/core/src/schema.test.ts", "packages/core/src/transfer.test.ts"]],
  rescue: [
    ["env", "-u", "SWITCHBOARD_SUPERVISED", "bun", "test", "rescue/src"],
    ["env", "-u", "SWITCHBOARD_SUPERVISED", "bun", "scripts/rescue-e2e.ts"],
  ],
  "security:lockfile": [["bun", "install", "--frozen-lockfile", "--ignore-scripts"], ["bun", "run", "licenses:check"]],
};

/** The lock files `merge-gate` asks the `security:lockfile` recheck for: the same glob, not a copy. */
const isLockFile = (f: string): boolean => SECURITY_GROUPS["security:lockfile"].some((g) => g.match(f));

export type Run = (argv: string[]) => number;
export type Deps = {
  /** Runs a command in the checkout with its output passed through; returns its exit code. */
  run: Run;
  /** Stdout of a command in the checkout, or null when it failed. */
  read: (argv: string[]) => string | null;
  out: (s: string) => void;
};

/** `bun.lock` packages by key, each entry as it is written (`[name@version, source, meta, integrity?]` for a registry package; a git, tarball or workspace entry has other shapes). */
export function lockEntries(text: string): Map<string, unknown> {
  const packages = (Bun.JSONC.parse(text) as { packages?: Record<string, unknown> }).packages ?? {};
  return new Map(Object.entries(packages));
}

/** An entry's version, source and integrity when it has the registry shape; its JSON otherwise (a git, tarball or workspace entry). */
function showEntry(e: unknown): string {
  if (e === undefined) return "(none)";
  if (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string" && (e.length <= 3 || typeof e[3] === "string")) return `${e[0]} source=${e[1] || "-"} integrity=${e[3] || "-"}`;
  return JSON.stringify(e);
}

/** One line per package whose entry differs between two `bun.lock` texts (the whole entry is compared): added, removed, or changed. */
export function lockChanges(before: string | null, after: string | null, file: string): string[] {
  const a = before === null ? new Map<string, unknown>() : lockEntries(before);
  const b = after === null ? new Map<string, unknown>() : lockEntries(after);
  const lines: string[] = [];
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const x = a.get(key);
    const y = b.get(key);
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    let [from, to] = [showEntry(x), showEntry(y)];
    if (from === to) [from, to] = [JSON.stringify(x), JSON.stringify(y)]; // only what the entry shows no field for changed (its dependencies)
    lines.push(`${file}: ${key}: ${from} -> ${to}`);
  }
  return lines;
}

/** The lock files the PR changes: null when the diff cannot be read. */
const changedLocks = (base: string, deps: Deps): string[] | null => deps.read(["git", "diff", "--name-only", `${base}...HEAD`])?.split("\n").filter((f) => f && isLockFile(f)) ?? null;

/** Before anything installs: every changed lock file must be a `bun.lock`. */
function lockfileGate(base: string, deps: Deps): boolean {
  const locks = changedLocks(base, deps);
  if (locks === null) deps.out(`差分を読めません: git diff ${base}...HEAD`);
  else if (locks.some((f) => basename(f) !== "bun.lock")) deps.out(`bun.lock でない lock ファイルが変わっています（この再チェックでは通せません）: ${locks.filter((f) => basename(f) !== "bun.lock").join(", ")}`);
  else return true;
  return false;
}

/** After the install and the license check pass: the changed entries, one line each. */
function lockfileEntries(base: string, deps: Deps): boolean {
  const locks = changedLocks(base, deps) ?? [];
  deps.out(`変わった lock ファイル: ${locks.join(", ") || "なし"}`);
  // the merge base, as `git diff <base>...HEAD` reads it: what the base gained since the fork is not this PR's change
  const from = deps.read(["git", "merge-base", base, "HEAD"])?.trim();
  if (!from) {
    deps.out(`merge base を読めません: git merge-base ${base} HEAD`);
    return false;
  }
  for (const f of locks) for (const line of lockChanges(deps.read(["git", "show", `${from}:${f}`]), deps.read(["git", "show", `HEAD:${f}`]), f)) deps.out(line);
  return true;
}

/** Exit code: 0 = the kind passes, the first failing command's code, or 1 for a kind not known / a lock file that is not `bun.lock`. */
export function main(argv: string[], deps: Deps): number {
  const args = [...argv];
  const take = (flag: string): string | undefined => {
    const at = args.indexOf(flag);
    return at < 0 ? undefined : args.splice(at, 2)[1];
  };
  const head = take("--head");
  const base = take("--base") ?? "origin/main";
  const [kind] = args;
  if (!(COMMAND_KINDS as readonly string[]).includes(kind ?? "")) {
    deps.out(`使い方: bun scripts/recheck.ts <${COMMAND_KINDS.join("|")}> [--head <sha>] [--base <ref>]`);
    return 1;
  }
  const k = kind as CommandKind;
  // the app records the head it asked for; the slot may have been waited for, so the checkout must still be on it, and clean
  if (head !== undefined) {
    const now = deps.read(["git", "rev-parse", "HEAD"])?.trim();
    if (now !== head) {
      deps.out(`checkout の HEAD が依頼のときの ${head} から変わっています（${now ?? "読めません"}）。走らせません`);
      return 1;
    }
    if (deps.read(["git", "status", "--porcelain"]) !== "") {
      deps.out("checkout に未コミットの変更があります。走らせません");
      return 1;
    }
  }
  // a lock file that is not bun.lock fails before anything installs
  if (k === "security:lockfile" && !lockfileGate(base, deps)) return 1;
  for (const cmd of RECHECK_COMMANDS[k]) {
    deps.out(`$ ${cmd.join(" ")}`);
    const code = deps.run(cmd);
    if (code !== 0) return code;
  }
  if (k === "security:lockfile" && !lockfileEntries(base, deps)) return 1;
  return 0;
}

if (import.meta.main) {
  const real: Deps = {
    run: (argv) => Bun.spawnSync(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" }).exitCode ?? 1,
    read: (argv) => {
      const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore" });
      return r.exitCode === 0 ? r.stdout.toString() : null;
    },
    out: (s) => console.log(s),
  };
  process.exit(main(process.argv.slice(2), real));
}
