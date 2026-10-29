import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE, ForgeConfig } from "./config.ts";
import { githubHost } from "./gh.ts";
import { findSecrets, NO_HOST, type HostAws } from "./secrets.ts";

/**
 * The operations the backlog, its sync and the CI report need from the service a repository lives on (#920), apart from
 * how one service does them. A service is one entry of the map a caller passes to `runForgeOperation` (GitHub's:
 * `forge-github.ts` for the kit, `backlog-sync.ts` / `backlog-send.ts` for the app); a second service adds its entry
 * there and its name to a repository's `ops.config.json` `forge` (docs/design/forge-integration.md). PR and review
 * stay with the service's own CLI.
 */

/** The host and the repository come from where the service's implementation finds them (GitHub: `gh`, the checkout's origin). */
export interface ForgeTarget {
  service: string;
  host: string;
  /** null = the checkout's origin (resolved by the service's implementation). */
  repository: string | null;
}

/** What a repository without `forge` lives on: what every repository was before #920. */
export const DEFAULT_SERVICE = "github";

/** The repository's service from `<dir>/ops.config.json` (only `forge` is read); none there = DEFAULT_SERVICE. Throws on a malformed `forge`. */
export function forgeOf(dir: string): string {
  return forgeConfigOf(dir).service;
}

/**
 * The repository's target. GitLab's is the host and project its `forge` names, refused (ForgeUnsupported) when the
 * checkout's `origin` is another host or project: nothing is sent to a host the checkout does not come from, and the
 * remote is never changed here. Any other service finds its host and repository itself (`repository` null).
 */
export function forgeTargetOf(dir: string, origin: string | null): ForgeTarget {
  const f = forgeConfigOf(dir);
  if (f.service !== "gitlab") return { service: f.service, host: githubHost(), repository: null };
  const at = origin ? remoteOf(origin) : null;
  const named = `${f.host}/${f.project}`;
  if (!at || at.host.toLowerCase() !== f.host!.toLowerCase() || at.path.toLowerCase() !== f.project!.toLowerCase())
    throw new ForgeUnsupported(`origin（${origin ? (at ? `${at.host}/${at.path}` : "読めない URL") : "無し"}）が forge の ${named} と違うので GitLab に送りません（remote は変えません）`);
  return { service: "gitlab", host: f.host!, repository: f.project! };
}

/** The checkout's `origin` URL; null = none (no remote, not a checkout). */
export function originOf(dir: string): string | null {
  const r = Bun.spawnSync(["git", "-C", dir, "remote", "get-url", "origin"], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
}

/** The host and path of a git remote URL (https://, ssh://, scp-like `git@host:path`), without `.git`; null = not one of these. */
export function remoteOf(url: string): { host: string; path: string } | null {
  const m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url) ?? /^(?:[^@/]+@)?([^/:]+):(?!\/)(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? { host: m[1]!, path: m[2]! } : null;
}

function forgeConfigOf(dir: string): ForgeConfig {
  const file = join(dir, CONFIG_FILE);
  if (!existsSync(file)) return { service: DEFAULT_SERVICE };
  let forge: unknown;
  try {
    forge = (JSON.parse(readFileSync(file, "utf8")) as { forge?: unknown }).forge;
  } catch (e) {
    throw new ForgeUnsupported(`${file} を読めません: ${(e as Error).message}`);
  }
  if (forge === undefined) return { service: DEFAULT_SERVICE };
  const r = ForgeConfig.safeParse(forge);
  if (!r.success) throw new ForgeUnsupported(`${file} の forge が不正です: ${r.error.issues.map((i) => `${i.path.join(".") || "forge"}: ${i.message}`).join(" / ")}`);
  return r.data;
}

/**
 * read = import what the service has; write = set a field of an Issue (title, body, state, a label, the milestone, the
 * parent); create = a new Issue; comment = a comment; project = a Project item and its fields; verification = report a
 * check's result (the local CI's pass).
 */
export const FORGE_KINDS = ["read", "write", "create", "comment", "project", "verification"] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

export interface ForgeOperation<P = unknown> {
  kind: ForgeKind;
  target: ForgeTarget;
  /** What it sends out: checked for values that sign in right before it is sent. */
  texts?: string[];
  payload: P;
}

export type ForgeImpl<P = unknown, R = unknown> = Partial<Record<ForgeKind, (op: ForgeOperation<P>) => Promise<R>>>;

/** The service, or this operation on it, is not supported: said as it is, never done some other way. */
export class ForgeUnsupported extends Error {}
/** What it would send carries a value that signs in: nothing is sent. */
export class ForgeRefused extends Error {}

/** Throws ForgeUnsupported / ForgeRefused when `op` would not be sent; else the service's handler. */
export function checkForgeOperation<P, R>(op: ForgeOperation<P>, services: Record<string, ForgeImpl<P, R>>, host: HostAws = NO_HOST): (op: ForgeOperation<P>) => Promise<R> {
  const impl = Object.hasOwn(services, op.target.service) ? services[op.target.service] : undefined;
  if (!impl) throw new ForgeUnsupported(`サービス ${op.target.service} には対応していません（対応: ${Object.keys(services).join(", ")}）`);
  const run = impl[op.kind];
  if (!run) throw new ForgeUnsupported(`サービス ${op.target.service} の ${op.kind} には対応していません`);
  const kinds = [...new Set((op.texts ?? []).flatMap((t) => findSecrets(t, host).map((h) => h.kind)))];
  if (kinds.length) throw new ForgeRefused(`認証に使える値（${kinds.join(", ")}）が含まれるので ${op.target.service} に送りません`);
  return run;
}

/** Runs `op` on its target's service, after the checks of `checkForgeOperation`. */
export async function runForgeOperation<P, R>(op: ForgeOperation<P>, services: Record<string, ForgeImpl<P, R>>, host: HostAws = NO_HOST): Promise<R> {
  return checkForgeOperation(op, services, host)(op);
}

/** Every string inside a payload (an operation's value is a string, an object or a list): what goes out. */
export function textsOf(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(textsOf);
  if (v && typeof v === "object") return Object.values(v).flatMap(textsOf);
  return [];
}
