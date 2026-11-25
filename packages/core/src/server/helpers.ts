import { existsSync } from "node:fs";
import { join, sep, basename } from "node:path";
import { loadMcpPolicy } from "../mcp.ts";
import { loadPricing } from "../pricing.ts";
import { heldIn } from "../backlog-pick.ts";
import type { OtherRepo } from "../backlog-prompt.ts";
import { loadRoutingTable } from "../routing.ts";
import type { Workspace } from "@switchboard/protocol";
import { setupScripts } from "../skillsync.ts";
import { savedConfigFile } from "../workspace-config.ts";
import type { CoreConfig } from "../config.ts";
import type { Db } from "../db.ts";

export const SETTINGS_KEY = "settings";

/** What a Task on another workspace is told about its repository; a `scripts/setup` that cannot be read counts as none. */
export function otherRepo(meta: Workspace, ws: Workspace): OtherRepo | undefined {
  if (ws.kind === "meta") return undefined;
  let setup: OtherRepo["setup"] = { config: false, kit: [], copies: [] };
  try {
    setup = setupScripts({ metaPath: meta.path, cwd: ws.path, saved: savedConfigFile(ws.id) });
  } catch {
    // the Task starts with the plain instructions
  }
  return { meta: meta.path, projectVar: ws.projectVar, setup };
}

export const TOPIC = "events";

/** What holds a PBI in backlog-next's log: a wait or a prerequisite not met. */
export type Held = ReturnType<typeof heldIn>[number]["pending"][number];

/** One per line of the log: overlaps still open (待ち), prerequisites not done yet (前提), ones a person has to look at. */
export const HELD_LINES: Array<[string, (pending: Held[], stuck: Held[]) => Held[]]> = [
  ["待ち", (pending) => pending.filter((x) => "reason" in x && x.reason === "overlap")],
  ["前提", (pending) => pending.filter((x) => !("reason" in x && x.reason === "overlap"))],
  ["進められない", (_, stuck) => stuck],
];

/** `PR #12 マージ待ち`, `#13 取り下げ`, …; an overlap is named alone (it waits for the other side to close). */
export function heldWhy(x: Held): string {
  const ref = `${x.kind === "pr" ? "PR " : ""}#${x.number}`;
  if ("reason" in x && x.reason === "overlap") return x.state === "missing" ? `${ref} 見つからない` : ref;
  const need = "need" in x ? x.need : x.kind === "pr" ? "merged" : "done";
  if (x.state === "pending") return `${ref} ${need === "release" ? "リリース待ち" : need === "merged" ? "マージ待ち" : "未完"}`;
  if (x.state === "withdrawn") return `${ref} 取り下げ`;
  if (x.state === "missing") return `${ref} 見つからない`;
  if (x.state === "cycle") return `${ref} と循環`;
  if (x.kind === "issue" && need === "release") return `${ref} は Issue に（リリース）が付いている（PR の番号に直す）`;
  return need === "release" ? `${ref} の反映を確かめられない` : `${ref} 判定できない`;
}

/** The shipped defaults of the version at `root` with the user's copies under `home` first, as a release reload reads them.
 *  A table left out (undefined) keeps its previous value: its shipped file is broken, or neither file exists. `kept` says why, one line each. */
export function readShippedDefaults(home: string, root: string): { routing?: ReturnType<typeof loadRoutingTable>; pricing?: ReturnType<typeof loadPricing>; mcpPolicy?: ReturnType<typeof loadMcpPolicy>; kept: string[] } {
  const kept: string[] = [];
  const paths = (file: string) => [join(home, file), join(root, "packages", "core", "config", file)];
  const usable = (what: string, file: string, problems: string[] = []) => {
    if (!paths(file).some((p) => existsSync(p))) return kept.push(`${what}: ${file} is in neither ${home} nor the release`), false;
    const bad = problems.find((p) => p.startsWith(`${root}${sep}`));
    if (bad) return kept.push(`${what}: ${bad}`), false;
    return true;
  };
  const out: ReturnType<typeof readShippedDefaults> = { kept };
  const r = loadRoutingTable(paths("routing.yaml"));
  if (usable("routing table", "routing.yaml", r.problems)) out.routing = r;
  const p = loadPricing(paths("pricing.json"));
  if (usable("pricing table", "pricing.json", p.problems)) out.pricing = p;
  if (usable("MCP policy", "mcp.yaml")) {
    try { out.mcpPolicy = loadMcpPolicy(paths("mcp.yaml")); } catch (e) { kept.push(`MCP policy: ${String((e as Error).message ?? e)}`); }
  }
  return out;
}

/** The repository this daemon runs from is always registered as the "meta" workspace (self-dev), and it is the only one. */
export function seedWorkspaces(db: Db, cfg: CoreConfig) {
  db.seedMetaWorkspace(cfg.repoRoot, basename(cfg.repoRoot));
}

/** How often the buffered API requests are written to api_requests. */
export const API_REQUESTS_FLUSH_MS = 10_000;
