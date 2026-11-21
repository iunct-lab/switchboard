/**
 * Putting a checked version of the Claude Code or Codex CLI next to the one in use, trying it, and moving the link to it
 * — or back. The file arrives already checked against its checksum and signature (cli-update-source.ts); here it is only
 * placed, run (`--version`, then one read-only turn through the adapter) and, when both come back, the link is swapped.
 * Every decision is one row of `cli_updates`. When this runs, and how often, is the caller's.
 *
 * Places are the installers' own: Claude `~/.local/share/claude/versions/<v>` with the link `~/.local/bin/claude`, Codex
 * `~/.codex/packages/standalone/releases/<v>-<target>` with the link `…/standalone/current`. The CLI's own `update` is
 * never called: it would fetch what nobody checked. Two versions are kept, the one in use and the one before it.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, copyFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createClaudeAdapter } from "@switchboard/adapter-claude";
import { createCodexAdapter } from "@switchboard/adapter-codex";
import type { CliRelease, CliRunner } from "./cli-update-source.ts";
import type { CliUpdateOutcome, CliUpdateRecord, CliUpdateRow } from "./db/cli-updates.ts";
import { isLimitText } from "./ratelimit.ts";
import { readOnlyMode, runSuggestionTurn } from "./suggest-llm.ts";

/** What this file reads and writes of the database: `Db` has these (db/cli-updates.ts). */
export interface CliUpdateStore {
  addCliUpdate(row: CliUpdateRow): void;
  lastCliUpdate(runner: string, outcome?: CliUpdateOutcome): CliUpdateRecord | null;
  linkMoves(runner: string): CliUpdateRecord[];
}

export interface InstallDeps {
  store: CliUpdateStore;
  home: string;
  /** Codex's `<arch>-unknown-linux-musl`, as in the name of its release directory. */
  codexTarget: string;
  now: () => number;
  /** One read-only turn through the adapter on `bin`; throws when it does not come back. */
  turn: (runner: CliRunner, bin: string) => Promise<void>;
  /** Unpacks a Codex `tar.gz` into an existing directory. */
  untar: (tarball: string, dir: string) => Promise<void>;
  /** Runs `<bin> --version` and returns what it printed; throws when it does not run. */
  version: (bin: string) => Promise<string>;
}

export type Check = { ok: true } | { ok: false; reason: string; /** the usage limit stopped the turn: it says nothing about the version */ limit?: boolean };
export type Done = { ok: true; outcome: CliUpdateOutcome } | { ok: false; outcome: CliUpdateOutcome | null; reason: string };

/* ---------- where things are ---------- */

/** The link the CLI is run through, and where a version's files go: the one table where the two runners differ. */
export function placesOf(runner: CliRunner, home: string, codexTarget: string) {
  const versions = runner === "claude" ? join(home, ".local", "share", "claude", "versions") : join(home, ".codex", "packages", "standalone", "releases");
  const dirName = (v: string) => (runner === "claude" ? v : `${v}-${codexTarget}`);
  return {
    link: runner === "claude" ? join(home, ".local", "bin", "claude") : join(home, ".codex", "packages", "standalone", "current"),
    versions,
    /** What the link points at for a version: Claude's one file, Codex's directory. */
    dir: (v: string) => join(versions, dirName(v)),
    /** What is run. */
    bin: (v: string) => (runner === "claude" ? join(versions, v) : join(versions, dirName(v), "bin", "codex")),
    /** The version a directory entry stands for, or null when it is not one of ours. */
    versionOf: (name: string): string | null => {
      const v = runner === "claude" ? name : name.endsWith(`-${codexTarget}`) ? name.slice(0, -codexTarget.length - 1) : null;
      return v !== null && /^\d+\.\d+\.\d+$/.test(v) ? v : null; // exactly a version: a "2.0.0-backup" of someone's is not ours
    },
    /** What to run to reach the version the link points at. */
    viaLink: runner === "claude" ? join(home, ".local", "bin", "claude") : join(home, ".codex", "packages", "standalone", "current", "bin", "codex"),
  };
}


export function readLink(path: string): string {
  if (!existsSync(path) || !lstatSync(path).isSymbolicLink()) throw new Error(`${path} は symlink ではない（戻し先が分からない）`);
  return readlinkSync(path);
}

/** Puts the link back to `before` after a move that did not hold — unless something else put a plain file there meanwhile, which is left as it is. */
function putBack(path: string, before: string): void {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ?? true) swapLink(path, before);
}

/** Points `path` at `target` without a moment where `path` does not exist (a temporary link in the same directory, then rename). */
export function swapLink(path: string, target: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.swap`);
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, path);
}

/** The version the link points at, or null when it is not one of ours. */
export function currentVersion(runner: CliRunner, deps: Pick<InstallDeps, "home" | "codexTarget">): string | null {
  const p = placesOf(runner, deps.home, deps.codexTarget);
  try {
    const target = readLink(p.link);
    // only a link into the installers' own place is theirs: a link to an executable kept elsewhere is left alone
    if (resolve(dirname(p.link), dirname(target)) !== p.versions) return null;
    return p.versionOf(basename(target));
  } catch {
    return null;
  }
}

/* ---------- placing, trying ---------- */

const sha256File = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file).on("data", (c) => h.update(c)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });

/**
 * Puts the downloaded (checked) file where the version lives. What is already there under that name is run only when it
 * is provably the checked bytes: the version the link points at, or Claude's one file equal to the download. The version
 * kept to go back to is never replaced (refused). Anything else there is a leftover (a version placed and not moved in, before a restart or a wait) that `prune` would remove: it is placed again.
 * Returns the place (what the link will point at).
 */
export async function stage(runner: CliRunner, release: CliRelease, downloaded: string, deps: InstallDeps): Promise<string> {
  const p = placesOf(runner, deps.home, deps.codexTarget);
  const dest = p.dir(release.version);
  const there = existsSync(dest);
  if (there) {
    if (currentVersion(runner, deps) === release.version) return dest;
    if (runner === "claude" && (await sha256File(dest)) === (await sha256File(downloaded))) return dest;
    if (rollbackTarget(runner, deps) === release.version) {
      throw new Error(`${dest} に、確かめたものと同じと分からないファイルが既にある（戻し先なので置き換えない）`);
    }
  }
  mkdirSync(p.versions, { recursive: true });
  // names no version has (prune clears them if this stops halfway), in the same directory so each step is one rename
  const tmp = mkdtempSync(join(p.versions, ".stage-"));
  try {
    let placed: string;
    if (runner === "claude") {
      placed = join(tmp, "claude");
      copyFileSync(downloaded, placed);
      chmodSync(placed, 0o755);
    } else {
      placed = join(tmp, "package");
      mkdirSync(placed);
      await deps.untar(downloaded, placed);
      if (!existsSync(join(placed, "bin", "codex"))) throw new Error("the Codex package has no bin/codex");
    }
    if (there && existsSync(dest)) renameSync(dest, join(tmp, "leftover")); // goes with tmp below
    renameSync(placed, dest);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dest;
}

/** The first version-shaped word: the one the CLI says it is ("codex-cli 0.3.0 (previously 0.2.0)" is 0.3.0; "0.3.0-alpha.1" is not 0.3.0). */
const saidVersion = (out: string): string | undefined => /(?<![\w.])\d+\.\d+\.\d+(?:[-+][\w.]+)?(?![\w.])/.exec(out)?.[0];

/** `<bin> --version` names the version the release says it is. */
export async function probe(bin: string, release: CliRelease, deps: Pick<InstallDeps, "version">): Promise<Check> {
  let out: string;
  try {
    out = await deps.version(bin);
  } catch (e) {
    return { ok: false, reason: `--version が動かない: ${short((e as Error).message)}` };
  }
  if (saidVersion(out) !== release.version) return { ok: false, reason: `--version が ${release.version} でない: ${short(out)}` };
  return { ok: true };
}

/** `version` = the probe only; `turn` = the probe and one read-only turn. A turn stopped by the usage limit is not a refusal. */
export async function smoke(runner: CliRunner, release: CliRelease, bin: string, mode: "turn" | "version", deps: InstallDeps): Promise<Check> {
  const seen = await probe(bin, release, deps);
  if (!seen.ok || mode === "version") return seen;
  try {
    await deps.turn(runner, bin);
  } catch (e) {
    const msg = (e as Error).message;
    if (isLimitText(runner, msg)) return { ok: false, reason: `使用上限で 1 ターンが通らない: ${short(msg)}`, limit: true };
    return { ok: false, reason: `1 ターンが通らない: ${short(msg)}` };
  }
  return { ok: true };
}

/* ---------- swapping ---------- */

export interface SwapOptions {
  /** Asked right before the link moves (after the checks, which take time): false = leave the link, record nothing, try again later. */
  canMove?: () => boolean;
  /** Whether a turn must come back before the link moves (`turn`), or the version is enough. */
  smoke: "turn" | "version";
  by: "auto" | "person";
}

function note(deps: InstallDeps, row: Omit<CliUpdateRow, "at">): void {
  deps.store.addCliUpdate({ at: deps.now(), ...row });
}

/**
 * Moves the link to a staged version once it passes `smoke`. A version that fails is `refused` and the link stays; one the
 * usage limit kept from being tried is `untested` and the link stays too (the next try goes again). The link is read
 * again after the swap, and put back when it does not answer as the release.
 */
export async function swap(runner: CliRunner, release: CliRelease, opts: SwapOptions, deps: InstallDeps): Promise<Done> {
  const p = placesOf(runner, deps.home, deps.codexTarget);
  const from = currentVersion(runner, deps);
  if (from === release.version) return { ok: false, outcome: null, reason: `もう ${release.version} で動いている` };
  const row = { runner, fromVersion: from, toVersion: release.version, sha256: release.sha256, by: opts.by };
  // no installers' link: nothing here to manage, and nothing tried (no --version, no turn spent)
  if (lstatSync(p.link, { throwIfNoEntry: false }) === undefined) {
    const reason = `${p.link} が無い（インストーラの link が無いので入れ替えない）`;
    note(deps, { ...row, outcome: "refused", reason });
    return { ok: false, outcome: "refused", reason };
  }
  // a link that is a plain file (installed some other way) is not replaced: there would be nothing to put back
  if (existsSync(p.link) && !lstatSync(p.link).isSymbolicLink()) {
    const reason = `${p.link} が symlink でないので入れ替えない`;
    note(deps, { ...row, outcome: "refused", reason });
    return { ok: false, outcome: "refused", reason };
  }
  const checked = await smoke(runner, release, p.bin(release.version), opts.smoke, deps);
  if (!checked.ok) {
    const outcome = checked.limit ? "untested" : "refused";
    note(deps, { ...row, outcome, reason: checked.reason });
    return { ok: false, outcome, reason: checked.reason };
  }
  const before = (() => {
    try {
      return readLink(p.link);
    } catch {
      return null;
    }
  })();
  if (opts.canMove && !opts.canMove()) return { ok: false, outcome: null, reason: "確かめのあいだに入れ替えられなくなった（Task が動き始めた）" };
  // the link is the installers': without one there is nothing here to manage (and nothing to put back)
  if (before === null) return { ok: false, outcome: null, reason: `${p.link} が無い（インストーラの link が無い）` };
  // asked again: something else may have put a plain file there while the checks ran
  if (existsSync(p.link) && !lstatSync(p.link).isSymbolicLink()) return { ok: false, outcome: null, reason: `${p.link} が symlink でなくなった` };
  row.fromVersion = currentVersion(runner, deps); // what is actually replaced (read right before the move, not before the checks)
  swapLink(p.link, p.dir(release.version));
  const after = await probe(p.viaLink, release, deps);
  if (!after.ok) {
    // put back only what this moved: a plain file someone put there meanwhile is left as it is
    putBack(p.link, before);
    const reason = `入れ替えたあとの確認が通らず戻した: ${after.reason}`;
    note(deps, { ...row, outcome: "refused", reason });
    return { ok: false, outcome: "refused", reason };
  }
  try {
    note(deps, { ...row, outcome: "installed", reason: opts.smoke === "turn" ? "--version と 1 ターンが通った" : "--version が通った" });
  } catch (e) {
    // without its row the version could not be gone back from: the link goes back too
    putBack(p.link, before);
    throw e;
  }
  return { ok: true, outcome: "installed" };
}

/**
 * Where `rollback` goes: the newest version recorded as `installed` before the one in use was installed, leaving out any
 * version a rollback later moved away from. Only a version that passed the checks here is a target — one the installer or
 * the CLI's own `update` put there is not — and a version a person went back from is not offered again.
 */
export function rollbackTarget(runner: CliRunner, deps: Pick<InstallDeps, "store" | "home" | "codexTarget">): string | null {
  const now = currentVersion(runner, deps);
  if (now === null) return null;
  const leftByRollback = new Set<string>();
  let pastNow = false;
  for (const row of deps.store.linkMoves(runner)) {
    if (row.outcome === "rolled-back") {
      if (row.fromVersion !== null) leftByRollback.add(row.fromVersion);
      continue;
    }
    if (!pastNow) {
      pastNow = row.toVersion === now;
      continue;
    }
    if (row.toVersion !== now && !leftByRollback.has(row.toVersion)) return row.toVersion;
  }
  return null;
}

/** The versions a rollback moved away from and that were not installed again since: not to be brought in again by themselves. */
export function rolledAwayFrom(runner: CliRunner, deps: Pick<InstallDeps, "store">): Set<string> {
  const away = new Set<string>();
  const installedSince = new Set<string>();
  for (const row of deps.store.linkMoves(runner)) {
    if (row.outcome === "installed") installedSince.add(row.toVersion);
    else if (row.fromVersion !== null && !installedSince.has(row.fromVersion)) away.add(row.fromVersion);
  }
  return away;
}

/** Puts back the version `rollbackTarget` names, when its files are still there; says why when not, and changes nothing. */
export async function rollback(runner: CliRunner, by: "auto" | "person", deps: InstallDeps): Promise<Done> {
  const p = placesOf(runner, deps.home, deps.codexTarget);
  const now = currentVersion(runner, deps);
  const target = rollbackTarget(runner, deps);
  if (!target) return { ok: false, outcome: null, reason: "戻す先の版（ここで確かめて入れた前の版）が記録に無い" };
  if (!existsSync(p.bin(target))) return { ok: false, outcome: null, reason: `${target} のファイルが無い` };
  let before: string;
  try {
    before = readLink(p.link);
  } catch (e) {
    return { ok: false, outcome: null, reason: short((e as Error).message) };
  }
  swapLink(p.link, p.dir(target));
  const seen = await deps.version(p.viaLink).catch(() => "");
  if (saidVersion(seen) !== target) {
    putBack(p.link, before);
    return { ok: false, outcome: null, reason: `${target} に戻したが --version が合わず、元に戻した: ${short(seen)}` };
  }
  try {
    note(deps, { runner, fromVersion: now, toVersion: target, outcome: "rolled-back", sha256: null, reason: "前の版に戻した", by });
  } catch (e) {
    putBack(p.link, before); // without its row the version gone back from would be brought in again: the link goes back too
    throw e;
  }
  return { ok: true, outcome: "rolled-back" };
}

const STAGE_STALE_MS = 3_600_000; // longer than any placing (a copy, or an untar of about 400 MB)

/** Removes every version but the one in use and the one `rollback` goes to, and unfinished stages. Returns the versions removed. */
export function prune(runner: CliRunner, deps: InstallDeps): string[] {
  const p = placesOf(runner, deps.home, deps.codexTarget);
  const now = currentVersion(runner, deps);
  if (now === null) return []; // the link is not ours: nothing says what is in use, so nothing goes
  const kept = new Set([now, rollbackTarget(runner, deps) ?? ""]);
  const gone: string[] = [];
  if (!existsSync(p.versions)) return gone;
  for (const name of readdirSync(p.versions)) {
    // what a stage that never finished left (the process stopped mid-copy or mid-untar)
    if (name.startsWith(".stage-")) {
      // only an old one: a young one may be another placing that is still unpacking
      if (deps.now() - lstatSync(join(p.versions, name)).mtimeMs > STAGE_STALE_MS) rmSync(join(p.versions, name), { recursive: true, force: true });
      continue;
    }
    const v = p.versionOf(name);
    if (v === null || kept.has(v)) continue;
    rmSync(join(p.versions, name), { recursive: true, force: true });
    gone.push(v);
  }
  return gone;
}

/** The whole way for a checked file: place it, swap, and clear what is no longer needed. */
export async function install(runner: CliRunner, release: CliRelease, downloaded: string, opts: SwapOptions, deps: InstallDeps): Promise<Done> {
  const dest = placesOf(runner, deps.home, deps.codexTarget).dir(release.version);
  const placedNow = !existsSync(dest); // a version already there (the one kept to go back to) is not this call's to remove
  try {
    await stage(runner, release, downloaded, deps);
  } catch (e) {
    const reason = `置けなかった: ${short((e as Error).message)}`;
    note(deps, { runner, fromVersion: currentVersion(runner, deps), toVersion: release.version, outcome: "refused", sha256: release.sha256, reason, by: opts.by });
    return { ok: false, outcome: "refused", reason };
  }
  const done = await swap(runner, release, opts, deps);
  if (done.ok) prune(runner, deps);
  else if (done.outcome === "refused" && placedNow && currentVersion(runner, deps) !== release.version) rmSync(dest, { recursive: true, force: true });
  return done;
}

const short = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 120);

/* ---------- the host's ---------- */

async function run(cmd: string[], ms: number): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), ms);
  try {
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  } finally {
    clearTimeout(timer);
  }
}

export function hostInstallDeps(store: CliUpdateStore): InstallDeps {
  return {
    store,
    home: homedir(),
    codexTarget: `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl`,
    now: Date.now,
    async turn(runner, bin) {
      const adapter = runner === "claude" ? createClaudeAdapter({ bin }) : createCodexAdapter({ bin });
      const cwd = mkdtempSync(join(tmpdir(), "switchboard.cli-update."));
      try {
        await runSuggestionTurn({ adapter, cwd, permissionMode: readOnlyMode(adapter).mode }, "OK とだけ返してください。", AbortSignal.timeout(180_000), true);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    async untar(tarball, dir) {
      const r = await run(["tar", "-xzf", tarball, "-C", dir], 5 * 60_000);
      if (r.code !== 0) throw new Error(`tar が exit ${r.code}: ${short(r.err)}`);
    },
    async version(bin) {
      const r = await run([bin, "--version"], 30_000);
      if (r.code !== 0) throw new Error(`exit ${r.code}: ${short(r.out + r.err)}`);
      return r.out; // what it says on stdout: a warning on stderr that names another version does not count
    },
  };
}
