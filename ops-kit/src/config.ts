import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { GhClient } from "./gh.ts";
import { z } from "zod";

const Section = z.union([z.string().min(1), z.object({ name: z.string().min(1), hint: z.string().min(1) }).strict()]);
export type Section = z.infer<typeof Section>;
export const sectionName = (s: Section) => (typeof s === "string" ? s : s.name);

/** A path in the tree, relative to its top; `dir/` (a trailing slash) is the directory and everything under it. */
const TreePath = z.string().min(1).refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "ツリーの中の相対パス（先頭の / と .. は不可）");

/** Where the main tree is published (`ops-kit public-sync`): the public repository, what goes, the files left out, the files naming the repository. */
export const PublicSync = z
  .object({
    versioning: z.literal("independent").optional(),
    target: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "target は <owner>/<name>"),
    /** What goes public. A top-level entry not named here, one added later too, stays private; a file added under a named directory goes. Omitted = the whole tree. */
    include: z.array(TreePath).min(1).optional(),
    /** Exceptions inside what goes. */
    exclude: z.array(TreePath).default([]),
    rewrite: z.array(z.string().min(1)).default([]),
    /** OS users that are no one's (a host template's service user, whose home the docs describe): the check for the syncing user's name in paths skips them. */
    serviceUsers: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type PublicSync = z.infer<typeof PublicSync>;

/** Where a repository lives (#920): read by `forgeOf` in `forge.ts`. Separate from a workspace's runner settings. */
export const ForgeConfig = z.object({ service: z.string().min(1) }).strict();

/**
 * A repository's backlog settings (`ops.config.json`). The kit itself holds no value of any one repository: the
 * Project, the choices of each field, the required sections and the Story Points all come from here.
 */
export const OpsConfig = z
  .object({
    /** `https://github.com/users/<login>/projects/<n>` or `https://github.com/orgs/<org>/projects/<n>`. */
    projectUrl: z.string().regex(/^https:\/\/github\.com\/(users|orgs)\/[^/]+\/projects\/\d+$/, "projectUrl は https://github.com/(users|orgs)/<owner>/projects/<n>").optional(),
    /** The Project's owner; default: the one in `projectUrl`. `@me` is the signed-in user. */
    owner: z.string().min(1).optional(),
    /** `<envPrefix>_PROJECT_URL` in the environment overrides `projectUrl`. */
    envPrefix: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "envPrefix は大文字・数字・_"),
    /** The choices of the single-select fields Area / Kind / Priority, and Phase if the Project has one. */
    fields: z.object({
      area: z.array(z.string().min(1)).min(1),
      kind: z.array(z.string().min(1)).min(1),
      priority: z.array(z.string().min(1)).min(1),
      phase: z.array(z.string().min(1)).min(1).optional(),
    }),
    /** A Phase's Milestone title matches this (a RegExp source). */
    milestone: z.object({ pattern: z.string().min(1) }).optional(),
    /**
     * Headings each kind of Issue must have (the name without `##`; `hint` is added to the violation), and the PBI
     * section that points back at the request: required, and its first non-empty line matches `pattern` (`hint` says
     * the expected form in the violation).
     */
    sections: z
      .object({
        pbi: z.array(Section),
        task: z.array(Section),
        request: z.array(Section),
        origin: z.object({ name: z.string().min(1), pattern: z.string().min(1), hint: z.string().min(1) }).strict().optional(),
      })
      .strict(),
    storyPoints: z.array(z.number().int().positive()).min(1).default([1, 2, 3, 5, 8]),
    publicSync: PublicSync.optional(),
    /** The service the repository lives on (#920, `forge.ts`); omitted = GitHub. */
    forge: ForgeConfig.optional(),
  })
  .strict();
export type OpsConfig = z.infer<typeof OpsConfig>;

export const CONFIG_FILE = "ops.config.json";

/** `path`, or the nearest `ops.config.json` from `cwd` up. */
export function findConfig(path: string | undefined, cwd = process.cwd()): string {
  if (path) return resolve(cwd, path);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG_FILE))) return join(dir, CONFIG_FILE);
    if (dirname(dir) === dir) throw new Error(`${CONFIG_FILE} が ${cwd} から上に見つかりません（--config で指定できます）`);
  }
}

export function parseConfig(json: unknown, where = CONFIG_FILE): OpsConfig {
  const r = OpsConfig.safeParse(json);
  if (!r.success) throw new Error(`${where} が不正です:\n${r.error.issues.map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`);
  for (const [path, source] of [["milestone.pattern", r.data.milestone?.pattern], ["sections.origin.pattern", r.data.sections.origin?.pattern]] as const) {
    if (source === undefined) continue;
    try {
      new RegExp(source);
    } catch {
      throw new Error(`${where} が不正です:\n  ${path}: 正規表現として読めません`);
    }
  }
  return r.data;
}

/** The kit's template of `ops.config.json`: the choices a workspace kept in the app without its own file is checked with (#2361). */
export const TEMPLATE_CONFIG = join(import.meta.dir, "../template/ops.config.json");

/**
 * The settings of a repository with no `ops.config.json` whose backlog the app keeps (no GitHub, #2361): the template
 * with its placeholders filled (Area `app`), so no Phase and no Milestone. Copy the template to change them.
 */
export function defaultConfig(): OpsConfig {
  const text = readFileSync(TEMPLATE_CONFIG, "utf8").replaceAll("__AREA__", "app").replaceAll("__PREFIX__", "BACKLOG");
  return parseConfig(JSON.parse(text), TEMPLATE_CONFIG);
}

export function loadConfig(path?: string, cwd = process.cwd()): OpsConfig {
  const file = findConfig(path, cwd);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} を読めません: ${(e as Error).message}`);
  }
  return parseConfig(json, file);
}

/**
 * The Project to operate on: owner login (or `@me`) and number. The environment's `<envPrefix>_PROJECT_URL` wins over
 * `projectUrl` and brings its own owner (`owner` belongs to `projectUrl`); `<envPrefix>_PROJECT_OWNER` wins over both.
 */
export function projectOf(cfg: OpsConfig, env: Record<string, string | undefined> = process.env): { owner: string; number: number } {
  const fromEnv = env[`${cfg.envPrefix}_PROJECT_URL`];
  const url = fromEnv || cfg.projectUrl || "";
  const m = /\/(users|orgs)\/([^/]+)\/projects\/(\d+)/.exec(url);
  if (!m) throw new Error(`Project の URL が読めません: ${url}`);
  return { owner: env[`${cfg.envPrefix}_PROJECT_OWNER`] || (fromEnv ? undefined : cfg.owner) || m[2]!, number: Number(m[3]) };
}

/**
 * The `publicSync` of the config file, and nothing else: a repository whose settings are not in the kit's shape yet can
 * still publish. Throws if there is none.
 */
/**
 * `at`: a commit to read the config from instead of the working tree (public-sync reads the one of the tree it sends, so a
 * working tree behind a new tag does not apply old rules to it). The file is the same path in that commit.
 */
export function loadPublicSync(path?: string, cwd = process.cwd(), at?: string): PublicSync {
  const file = findConfig(path, cwd);
  let json: { publicSync?: unknown };
  try {
    json = JSON.parse(at ? gitShow(file, at) : readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} を読めません: ${(e as Error).message}`);
  }
  if (json === null || typeof json !== "object" || json.publicSync === undefined) throw new Error(`${file} に publicSync がありません（公開先・外すファイル・書き換えるファイル）`);
  const r = PublicSync.safeParse(json.publicSync);
  if (!r.success) throw new Error(`${file} が不正です:\n${r.error.issues.map((i) => `  publicSync.${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`);
  return r.data;
}

function gitShow(file: string, at: string): string {
  const p = Bun.spawnSync(["git", "-C", dirname(file), "show", `${at}:./${basename(file)}`], { stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`not in ${at}: ${p.stderr.toString().trim().split("\n")[0]}`);
  return p.stdout.toString();
}

/** Resolve only for commands that use the Project; gh chooses the repository. */
export async function resolveProject(cfg: OpsConfig, gh: GhClient, env: Record<string, string | undefined> = process.env): Promise<OpsConfig> {
  if (env[`${cfg.envPrefix}_PROJECT_URL`] || cfg.projectUrl) return cfg;
  const name = `${cfg.envPrefix}_PROJECT_URL`;
  const url = (await gh.run(["variable", "get", name])).trim();
  projectOf({ ...cfg, projectUrl: url, owner: undefined }, env);
  return { ...cfg, projectUrl: url, owner: undefined };
}
