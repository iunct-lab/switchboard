// A repository that keeps no `ops.config.json` of its own is run with the settings Switchboard keeps for its workspace
// (the same shape; saved in the app, Settings → Workspace). The daemon writes each workspace's settings to a file under
// its home and lists them in an index; here the scripts find the file of a clone. Which file applies is the kit's one rule
// (`configFileOf`: the checkout's own file when it has one, else this one), so this module only finds the file and its name.
// scripts/ do not import packages/core: the two names below are written in packages/core/src/workspace-config.ts too.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CiConfig, CONFIG_ENV, CONFIG_FILE, ciStepsHash } from "../ops-kit/src/config.ts";

/** Under the daemon's home: `<id>/ops.config.json` per workspace that has settings, and the index. */
export const WORKSPACE_CONFIG_DIR = "workspace-config";
export const WORKSPACE_CONFIG_INDEX = "index.json";

/** The settings Switchboard keeps for a workspace: the file (the shape of `ops.config.json`) and the workspace's name. */
export interface WorkspaceSettings { name: string; file: string }

interface IndexEntry { id: string; name: string; path: string; file: string }

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

interface PendingEntry { id: string; name: string; path: string; keys: string[]; at: number }

/** The workspaces the index names with a change of their settings waiting for the person's confirmation. */
function readPending(home: string): PendingEntry[] {
  try {
    const json = JSON.parse(readFileSync(join(home, WORKSPACE_CONFIG_DIR, WORKSPACE_CONFIG_INDEX), "utf8")) as { pending?: unknown };
    if (!Array.isArray(json.pending)) return [];
    return json.pending.filter((w): w is PendingEntry => !!w && typeof w === "object" && typeof (w as PendingEntry).name === "string" && typeof (w as PendingEntry).path === "string").map((w) => ({ ...w, keys: Array.isArray(w.keys) ? w.keys.map(String) : [], at: Number(w.at) || 0 }));
  } catch {
    return [];
  }
}

function readIndex(home: string): IndexEntry[] {
  try {
    const json = JSON.parse(readFileSync(join(home, WORKSPACE_CONFIG_DIR, WORKSPACE_CONFIG_INDEX), "utf8")) as { workspaces?: unknown };
    if (!Array.isArray(json.workspaces)) return [];
    return json.workspaces.filter((w): w is IndexEntry => !!w && typeof w === "object" && typeof (w as IndexEntry).name === "string" && typeof (w as IndexEntry).path === "string" && typeof (w as IndexEntry).file === "string");
  } catch {
    return [];
  }
}

/** The main work tree of the clone `root` is in (a Task's worktree is not the folder the workspace names), or `root` itself. */
function mainWorktree(root: string): string {
  const p = Bun.spawnSync(["git", "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { stdout: "pipe", stderr: "ignore" });
  const common = p.exitCode === 0 ? p.stdout.toString().trim() : "";
  return common.endsWith("/.git") ? dirname(common) : root;
}

/**
 * The settings kept for the workspace of the clone `root`, or undefined when there are none. Inside a Task or a job the
 * app names the file (`OPS_KIT_CONFIG`, the variable the kit reads); outside, the file is found in the daemon's index by
 * the clone's folder (the folder itself, or the main work tree of a worktree). A file that is named but gone is none.
 */
export function workspaceSettingsOf(root: string, env: Record<string, string | undefined> = process.env): WorkspaceSettings | undefined {
  const home = env.SWITCHBOARD_HOME || join(env.HOME || homedir(), ".switchboard");
  const index = readIndex(home);
  const named = env[CONFIG_ENV];
  if (named) {
    if (!existsSync(named)) return undefined;
    const file = real(named);
    return { name: index.find((w) => real(w.file) === file)?.name ?? "（名前不明）", file };
  }
  const at = new Set([real(root), real(mainWorktree(root))]);
  const found = index.find((w) => at.has(real(w.path)) && existsSync(w.file));
  return found ? { name: found.name, file: found.file } : undefined;
}

/**
 * What the person confirmed for the workspace of the clone `root`, as the daemon wrote it: the settings in force (their
 * version = the first 12 hex digits of the file's sha256, and the hash of their CI steps) and whether a change waits for
 * the person. For the merge gate. Found by the clone's folder in the daemon's index only — never by `OPS_KIT_CONFIG`,
 * which whoever runs the script chooses. undefined = the clone has its own `ops.config.json` (the settings kept by
 * Switchboard are not read at all then), or Switchboard keeps nothing and nothing waits for it.
 * The index and the files are the daemon user's: a Task, which runs as the same user, can write them. This tells an honest
 * run what is in force; it is no fence.
 */
export interface HeldSettings { workspace: string; version: string | null; ciHash: string | null; pending: { keys: string[]; at: number } | null }

export function heldSettingsOf(root: string, env: Record<string, string | undefined> = process.env): HeldSettings | undefined {
  const main = mainWorktree(root);
  if (existsSync(join(root, CONFIG_FILE)) || existsSync(join(main, CONFIG_FILE))) return undefined;
  const home = env.SWITCHBOARD_HOME || join(env.HOME || homedir(), ".switchboard");
  const at = new Set([real(root), real(main)]);
  const kept = readIndex(home).find((w) => at.has(real(w.path)) && existsSync(w.file));
  const waits = readPending(home).find((w) => at.has(real(w.path)));
  if (!kept && !waits) return undefined;
  let version: string | null = null;
  let ciHash: string | null = null;
  if (kept) {
    const text = readFileSync(kept.file, "utf8");
    version = new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12);
    try {
      const ci = CiConfig.safeParse((JSON.parse(text) as { ci?: unknown }).ci);
      if (ci.success) ciHash = ciStepsHash(ci.data.steps);
    } catch {}
  }
  return { workspace: (kept ?? waits!).name, version, ciHash, pending: waits ? { keys: waits.keys, at: waits.at } : null };
}

/**
 * Why a local CI pass does not count against what the person confirmed, or undefined when it does. `named`: the hash of the
 * steps the pass ran, which its job record has when they came from the settings Switchboard keeps; null = it names none. A
 * pass counts when its steps are the confirmed ones: it names the hash of the confirmed settings' steps, or — with no steps
 * confirmed — it names none (its steps were the checkout's own, which the PR's review covers). So a pass run with steps
 * from any other file (`OPS_KIT_CONFIG` pointed elsewhere, a change still waiting) is not the CI's success.
 */
export function stepsNotConfirmed(named: string | null, held: HeldSettings | undefined): string | undefined {
  const confirmed = held?.ciHash ?? null;
  if (named === confirmed) return undefined;
  if (named === null) return `local-ci の pass が、利用者の確かめた設定（Switchboard の側、workspace ${held!.workspace}、版 ${held!.version}）の CI の手順（ハッシュ ${confirmed}）で回したものでない（その設定で回し直す）`;
  return `local-ci の pass の手順（Switchboard の側の設定、ハッシュ ${named}）が、利用者の確かめた設定の手順（${confirmed ? `ハッシュ ${confirmed}` : "確かめた手順は無い"}）と違う（設定の変更は判断待ちで確認してから回し直す）`;
}
