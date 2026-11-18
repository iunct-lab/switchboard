// The settings of a workspace kept on Switchboard's side instead of an `ops.config.json` committed to its repository:
// saved in the database (`workspaces.config`, the JSON text), and written to a file per workspace under the daemon's home
// so that the kit and the scripts read them as they read a repository's file. Which file a checkout is run with is the
// kit's one rule (`configFileOf`): its own `ops.config.json` when it has one, else this file — a file as a whole, never
// mixed key by key. The kit knows no workspace: it is handed the file's place (`OPS_KIT_CONFIG`) and nothing else.
// The file only ever holds settings the person confirmed: a change is recorded and, when it touches what the local CI or
// the merge gate reads, waits as a question (server/workspace-config.ts) while the file keeps the last confirmed value.
// docs/design/new-repo.md, "Settings kept on Switchboard's side".
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { Workspace } from "@switchboard/protocol";
import { CONFIG_ENV, CONFIG_FILE, CiConfig, ciStepsHash, configFileOf, configShapeError } from "../../../ops-kit/src/config.ts";
import { findSecrets, type HostAws } from "../../../ops-kit/src/secrets.ts";

/** Under the daemon's home: `<id>/ops.config.json` per workspace that has settings, and the index (scripts/workspace-settings.ts reads both names). */
export const WORKSPACE_CONFIG_DIR = "workspace-config";
export const WORKSPACE_CONFIG_INDEX = "index.json";

export const workspaceConfigFile = (home: string, id: string): string => join(home, WORKSPACE_CONFIG_DIR, id, CONFIG_FILE);

/**
 * The text to save, or why it is refused (one line). Empty = none (the saved settings go). Refused: not JSON, a key not in
 * its shape or unknown, `publicSync` (it is read at the commit that is sent, so it stays in the repository's file), and a
 * value that can authenticate (the file is handed to every Task there, and the CI's steps run as the host's user).
 */
export function checkWorkspaceConfig(text: string, host: HostAws): { config: string | null } | { refusal: string } {
  const trimmed = text.trim();
  if (!trimmed) return { config: null };
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch (e) {
    return { refusal: `JSON として読めません: ${(e as Error).message}` };
  }
  if (json !== null && typeof json === "object" && "publicSync" in json) return { refusal: "publicSync は Switchboard の側には置けません（送るコミットの版で読むので、リポジトリの ops.config.json に書く）" };
  const shape = configShapeError(json);
  if (shape) return { refusal: `設定の形が不正です: ${shape}` };
  if (findSecrets(trimmed, host).length) return { refusal: "認証に使える値を含む設定は保存できません" };
  return { config: `${JSON.stringify(json, null, 2)}\n` };
}

/**
 * The keys that only say how the backlog's Issues are written (the Project, its fields, the required sections). Every
 * other key — the CI's steps, the merge gate, the forge, the reviewer, the shared files, the update conditions, and any
 * key added later — is read by the local CI, the merge gate or a check in front of a write, so a change of it waits for
 * the person. A list of what does not wait, so that a key nobody classified waits.
 */
export const FORM_KEYS: readonly string[] = ["projectUrl", "owner", "envPrefix", "fields", "milestone", "sections", "storyPoints"];

/** The top-level keys whose value differs between two saved texts (null = none saved), sorted. */
export function changedKeys(before: string | null, after: string | null): string[] {
  const read = (t: string | null) => (t ? (JSON.parse(t) as Record<string, unknown>) : {});
  const a = read(before);
  const b = read(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}

/** Of `keys`, those the gates read (not in `FORM_KEYS`). */
export const gatingKeys = (keys: readonly string[]): string[] => keys.filter((k) => !FORM_KEYS.includes(k));

/** The name of a saved text as a version: the first 12 hex digits of its sha256 (scripts/workspace-settings.ts computes the same from the file). null = none saved. */
export const configVersion = (text: string | null | undefined): string | null => (text ? new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12) : null);

/** The hash of the CI steps in a saved text (what a local CI result names its steps by), or null when it has none. */
export function configCiHash(text: string | null | undefined): string | null {
  const ci = text ? CiConfig.safeParse((JSON.parse(text) as { ci?: unknown }).ci) : null;
  return ci?.success ? ciStepsHash(ci.data.steps) : null;
}

/**
 * Where each workspace's saved settings are, as this process last wrote them (`writeWorkspaceConfigs` is the only writer):
 * the daemon's readers find the file by the workspace's id, wherever the daemon's home is.
 */
const FILES = new Map<string, string>();

/** The saved settings' file of a workspace (what `OPS_KIT_CONFIG` names for its Tasks and jobs); "" = none saved. */
export const savedConfigFile = (id: string | null | undefined): string => (id ? FILES.get(id) ?? "" : "");

/** A change of a workspace's settings that waits for the person: named in the index so the scripts (the merge gate) can say so. */
export interface PendingConfig { workspaceId: string; id: number; at: number; keys: string[] }

/**
 * Writes every workspace's saved (confirmed) settings to its file and the index of them, and removes the files of
 * workspaces that have none (or are gone). The index also names the workspaces with a change waiting for the person
 * (`pending`: no value of the change, only that there is one and which keys). Called at the daemon's start and after every
 * save or answer: the database is the source, the files a copy. They are the daemon user's files: a Task, which runs as
 * the same user, can write them too — they tell the scripts what is in force, they are no fence.
 */
export function writeWorkspaceConfigs(home: string, workspaces: Workspace[], pending: PendingConfig[] = []): void {
  const dir = join(home, WORKSPACE_CONFIG_DIR);
  const kept = workspaces.filter((w) => w.config);
  const waiting = pending.flatMap((p) => {
    const w = workspaces.find((x) => x.id === p.workspaceId);
    return w ? [{ id: w.id, name: w.name, path: w.path, change: p.id, at: p.at, keys: p.keys }] : [];
  });
  // what this home had and no longer has (settings taken away, a workspace removed) is forgotten too
  for (const [id, file] of FILES) if (file.startsWith(dir + sep) && !kept.some((w) => w.id === id)) FILES.delete(id);
  for (const w of kept) FILES.set(w.id, workspaceConfigFile(home, w.id));
  if (!kept.length && !waiting.length && !existsSync(dir)) return;
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    if (name !== WORKSPACE_CONFIG_INDEX && !kept.some((w) => w.id === name)) rmSync(join(dir, name), { recursive: true, force: true });
  }
  const put = (file: string, text: string) => {
    writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  for (const w of kept) {
    mkdirSync(join(dir, w.id), { recursive: true });
    put(workspaceConfigFile(home, w.id), w.config!);
  }
  put(join(dir, WORKSPACE_CONFIG_INDEX), `${JSON.stringify({ workspaces: kept.map((w) => ({ id: w.id, name: w.name, path: w.path, file: workspaceConfigFile(home, w.id), version: configVersion(w.config) })), pending: waiting }, null, 2)}\n`);
}

/** `writeWorkspaceConfigs` from the database: the one call every writer of the settings ends with. */
export function writeConfigFiles(home: string, db: { listWorkspaces(): Workspace[]; pendingConfigChanges(): Array<{ workspaceId: string; id: number; at: number; keys: string[] }> }): void {
  writeWorkspaceConfigs(home, db.listWorkspaces(), db.pendingConfigChanges().map((c) => ({ workspaceId: c.workspaceId, id: c.id, at: c.at, keys: c.keys })));
}

/**
 * The settings file the checkout `dir` of a workspace is run with (the kit's rule: `dir`'s own `ops.config.json`, else the
 * workspace's saved one), or null when there is neither. The daemon's readers of a repository's settings go through here.
 */
export function workspaceConfigPath(ws: Pick<Workspace, "id"> | null | undefined, dir: string): string | null {
  return configFileOf(dir, savedConfigFile(ws?.id));
}

/** Which settings the workspace's checkout runs with now. */
export function workspaceConfigSource(ws: Pick<Workspace, "id" | "path">): "repository" | "switchboard" | "none" {
  return existsSync(join(ws.path, CONFIG_FILE)) ? "repository" : savedConfigFile(ws.id) ? "switchboard" : "none";
}

/** What a Task or a job of the workspace is started with so that the kit finds the saved settings; none saved = nothing. */
export function workspaceConfigEnv(ws: Pick<Workspace, "id"> | null | undefined): Record<string, string> {
  const file = savedConfigFile(ws?.id);
  return file ? { [CONFIG_ENV]: file } : {};
}
