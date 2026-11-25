import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { findRepoRoot } from "./config.ts";

/**
 * What the running daemon reads from the release it started from, as paths relative to the release root.
 * `dirs` end with `/`. `complete` is false when something it reads could not be told (`unknown` says what),
 * and a caller then has to assume any file may be read.
 */
export interface DaemonReads {
  complete: boolean;
  files: string[];
  dirs: string[];
  unknown: string[];
}

/** The daemon's entry point; everything it imports is reached from here. */
const ENTRY = "packages/core/src/main.ts";

/** Read by the runtime itself when it starts (dependency resolution, compiler options), whether or not imported; the package.json and tsconfig.json of each package a reached file is in are added as the walk reaches it. */
const STARTUP_FILES = ["package.json", "bun.lock", "bunfig.toml", "tsconfig.json", "tsconfig.base.json"];


/** A line that builds a path from where the started release lies, so it may read a file no import reaches. */
const SITE = /import\.meta\.(dir|dirname|url|path|file|filename)|findRepoRoot\(|\bcodeRoot\b|\bliveRoot\b|process\.cwd\(\)/;

/**
 * Every file the import walk reaches that has lines matching `SITE`: how many such lines (`sites`), and what those
 * lines read from the release or hand on as a path (`reads`; a directory ends with `/`). A walked file whose count
 * differs from its entry makes the answer incomplete, so a new site has to be read and declared here.
 * A declared `.ts` file is a script the daemon runs from the release, and the walk follows its imports as well.
 * sb-rescue starts the daemon with the release as its working folder, so `process.cwd()` there is the release root.
 * The comment on each entry is what reading its lines found.
 */
export const RUNTIME_READS: Record<string, { sites: number; reads: string[] }> = {
  // the template's choices for a workspace without its own file; the `cwd = process.cwd()` defaults find the nearest ops.config.json, the release root's when a caller passes none
  "ops-kit/src/config.ts": { sites: 13, reads: ["ops-kit/template/ops.config.json", "ops.config.json"] },
  // `cwd` only names the folder git asks for the origin remote in (git's own data, no file of the tree)
  "ops-kit/src/gh.ts": { sites: 1, reads: [] },
  // the working folder is written into the slot holder's record, nothing is read from it
  "ops-kit/src/heavy.ts": { sites: 1, reads: [] },
  // REVERSIBILITY_FILE, read by the merge rules
  "ops-kit/src/reversibility.ts": { sites: 1, reads: ["ops-kit/reversibility.json"] },
  // SCRATCH_APPS_DOC: its path is written into a Task's prompt, and the Task reads the file there
  "packages/core/src/artifacts.ts": { sites: 1, reads: ["docs/design/scratch-apps.md"] },
  // codeRoot is the release root; webDist under it serves the screen (the type field and findRepoRoot's own line read nothing)
  "packages/core/src/config.ts": { sites: 6, reads: ["apps/web/dist/"] },
  // DAEMON_ROOT runs the release's merge gate as a job, with the release's bunfig.toml (a comment line and the copy child's own folder read nothing)
  "packages/core/src/jobs.ts": { sites: 3, reads: ["scripts/merge-gate.ts", "bunfig.toml"] },
  // codeRoot's folder name is the version shown, and git asks its own data for the commit
  "packages/core/src/ops-stops.ts": { sites: 3, reads: [] },
  // processDir: the process definitions
  "packages/core/src/process-defs.ts": { sites: 1, reads: ["ops-kit/processes/"] },
  // liveRoot's folder name is the release named in the health answer
  "packages/core/src/routes/health.ts": { sites: 2, reads: [] },
  // codeRoot is the folder gh is asked in for the budget, and liveRoot is cut out of a path shown on the screen
  "packages/core/src/routes/ledger.ts": { sites: 3, reads: [] },
  // the replacement daemon starts in the same folder; a reload reads releases/current (the new release), not the started one
  "packages/core/src/server/lifecycle.ts": { sites: 3, reads: [] },
  // the shipped routing table, from liveRoot (the started release until a reload)
  "packages/core/src/server/settings.ts": { sites: 4, reads: ["packages/core/config/"] },
  // the shipped pricing and MCP policy, from liveRoot
  "packages/core/src/server/setup.ts": { sites: 3, reads: ["packages/core/config/"] },
  // loadTrustedSkills reads the kit's skills
  "packages/core/src/server/task-hooks.ts": { sites: 1, reads: ["ops-kit/skills/"] },
  // skillPathsFor lists the kit's skills
  "packages/core/src/skillsync.ts": { sites: 1, reads: ["ops-kit/skills/"] },
  // fileRequest runs request_issue.sh, which runs the kit's cli.ts with the release root's ops.config.json
  "scripts/file-request.ts": { sites: 2, reads: ["ops-kit/src/cli.ts", "scripts/setup/request_issue.sh", "ops.config.json"] },
  // the root is used only when the file is run as a command, which the daemon does not do
  "scripts/file-size.ts": { sites: 1, reads: [] },
  // scriptRoot is main's, and the daemon's local CI jobs run the checkout's copy of this script, not the release's
  "scripts/local-ci.ts": { sites: 2, reads: [] },
  // the reversibility list and bunfig.toml; the gate job passes --cwd, so the process.cwd() defaults are the checkout
  "scripts/merge-gate.ts": { sites: 4, reads: ["ops-kit/reversibility.json", "bunfig.toml"] },
  // BUDGET_PATH; the other lines run git and gh in the folder (git's data, not the tree)
  "scripts/perf-ratchet.ts": { sites: 6, reads: ["scripts/perf-budget.json"] },
  // the folder git asks for the origin remote in
  "scripts/repo.ts": { sites: 2, reads: [] },
  // ROOT is read only when the file is run as a command, which the daemon does not do
  "scripts/test-select.ts": { sites: 1, reads: [] },
  // reached from cli.ts, which the daemon runs only as `request` (through request_issue.sh); none of these lines is on that path
  "ops-kit/src/cli.ts": { sites: 6, reads: [] },
  "ops-kit/src/deps-check-io.ts": { sites: 1, reads: [] },
  "ops-kit/src/export-copy.ts": { sites: 1, reads: [] },
  "ops-kit/src/job-client.ts": { sites: 1, reads: [] },
  "ops-kit/src/public-sync.ts": { sites: 1, reads: [] },
};

const EXTENSIONS = ["", ".ts", ".tsx", ".js", ".mjs", "/index.ts", "/index.js"];

function resolveFile(base: string): string | null {
  for (const ext of EXTENSIONS) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

interface WorkspacePackage {
  dir: string;
  manifest: string;
  exports: unknown;
  main: string | undefined;
}

/** The workspace packages a daemon file can import by name: the root `package.json`'s `workspaces`, as the runtime links them. */
function workspaceGlobs(root: string): string[] {
  try {
    const ws = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))?.workspaces;
    const list = Array.isArray(ws) ? ws : ws?.packages;
    return Array.isArray(list) ? list.filter((g): g is string => typeof g === "string").map((g) => `${g.replace(/\/$/, "")}/package.json`) : [];
  } catch {
    return [];
  }
}

function workspacePackages(root: string): Map<string, WorkspacePackage> {
  const out = new Map<string, WorkspacePackage>();
  for (const pattern of workspaceGlobs(root)) {
    for (const rel of new Bun.Glob(pattern).scanSync({ cwd: root })) {
      const manifest = join(root, rel);
      try {
        const json = JSON.parse(readFileSync(manifest, "utf8"));
        if (typeof json?.name === "string") {
          out.set(json.name, { dir: dirname(manifest), manifest, exports: json.exports, main: json.main });
        }
      } catch {
        /* not a package we can read: its imports stay unresolved and show up in `unknown` */
      }
    }
  }
  return out;
}

/** `name` or `name/sub` against a workspace package's `exports` (a string or a map of subpaths) or `main`. */
function resolvePackage(pkg: WorkspacePackage, sub: string): string | null {
  const key = sub === "" ? "." : `./${sub}`;
  let target: unknown;
  if (typeof pkg.exports === "string") target = key === "." ? pkg.exports : undefined;
  else if (pkg.exports && typeof pkg.exports === "object") target = (pkg.exports as Record<string, unknown>)[key];
  if (target && typeof target === "object") {
    const t = target as Record<string, unknown>;
    target = t.bun ?? t.import ?? t.default;
  }
  if (typeof target === "string") return resolveFile(join(pkg.dir, target));
  if (pkg.exports !== undefined && pkg.exports !== null) return null;
  if (sub === "") return pkg.main ? resolveFile(join(pkg.dir, pkg.main)) : resolveFile(join(pkg.dir, "index"));
  return resolveFile(join(pkg.dir, sub));
}

function packageOf(spec: string, packages: Map<string, WorkspacePackage>): [WorkspacePackage, string] | null {
  for (const [name, pkg] of packages) {
    if (spec === name) return [pkg, ""];
    if (spec.startsWith(`${name}/`)) return [pkg, spec.slice(name.length + 1)];
  }
  return null;
}

function stripShebang(src: string): string {
  return src.startsWith("#!") ? src.slice(src.indexOf("\n") + 1) : src;
}

function siteCount(src: string): number {
  return src.split("\n").filter((line) => SITE.test(line)).length;
}

const TRANSPILED = /\.(ts|tsx|js|mjs)$/;

export function daemonReads(root: string): DaemonReads {
  const packages = workspacePackages(root);
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const rel = (p: string) => relative(root, p);
  const files = new Set<string>();
  const dirs = new Set<string>();
  const unknown: string[] = [];
  const reached = new Set<string>();
  const queue = [join(root, ENTRY)];

  for (const name of STARTUP_FILES) if (existsSync(join(root, name))) files.add(name);

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    if (!existsSync(file)) {
      unknown.push(rel(file)); // a declared script that is not there
      continue;
    }
    files.add(rel(file));
    // the runtime reads the package.json and tsconfig.json of the package a file is in
    for (const pkg of packages.values()) {
      if (!file.startsWith(`${pkg.dir}/`)) continue;
      files.add(rel(pkg.manifest));
      if (existsSync(join(pkg.dir, "tsconfig.json"))) files.add(rel(join(pkg.dir, "tsconfig.json")));
    }
    if (!TRANSPILED.test(file)) continue;
    const src = readFileSync(file, "utf8");

    for (const { path: spec } of transpiler.scanImports(stripShebang(src))) {
      if (spec.startsWith(".") || spec.startsWith("/")) {
        const target = resolveFile(resolve(dirname(file), spec));
        if (target && !rel(target).startsWith("..")) queue.push(target);
        else unknown.push(`${rel(file)} -> ${spec}`);
        continue;
      }
      const hit = packageOf(spec, packages);
      if (!hit) continue; // node:, bun: and node_modules: read by the runtime, outside the release's own files
      const [pkg, sub] = hit;
      const target = resolvePackage(pkg, sub);
      if (target) queue.push(target);
      else unknown.push(`${rel(file)} -> ${spec}`);
    }

    const sites = siteCount(src);
    if (sites === 0) continue;
    const declared = RUNTIME_READS[rel(file)];
    if (!declared || declared.sites !== sites) {
      unknown.push(rel(file));
      continue;
    }
    for (const r of declared.reads) {
      if (r.endsWith("/")) dirs.add(r);
      else if (TRANSPILED.test(r)) queue.push(join(root, r)); // a script the daemon runs: what it imports is read too
      else files.add(r);
    }
  }

  return { complete: unknown.length === 0, files: [...files].sort(), dirs: [...dirs].sort(), unknown: unknown.sort() };
}

if (import.meta.main) {
  console.log(JSON.stringify(daemonReads(findRepoRoot(import.meta.dir))));
}
