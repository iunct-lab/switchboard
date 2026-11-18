/**
 * Whether a `gh` command line only reads. It is the list a machine that must not write to the forge goes by (the app's
 * work machine: its daemon's `gh`, and the check in front of `gh` in its Tasks), so it is written the safe way round:
 * what is not known to read counts as a write — an unknown group or subcommand, `gh api` with a method other than
 * GET / HEAD, with a request body, with a field and no explicit GET, or a GraphQL text that is not one plain query.
 */

/**
 * The subcommands of each group that only read (a local checkout or a download writes nothing to the forge). The listing
 * of every item of a Project is left out: the kit never calls it (one call reads the whole Project), so it stops here too.
 */
const READS: Record<string, ReadonlySet<string>> = {
  auth: new Set(["status", "token"]),
  cache: new Set(["list"]),
  issue: new Set(["list", "view", "status"]),
  label: new Set(["list"]),
  pr: new Set(["list", "view", "status", "diff", "checks", "checkout"]),
  project: new Set(["list", "view", "field-list"]),
  release: new Set(["list", "view", "download"]),
  repo: new Set(["list", "view", "clone"]),
  ruleset: new Set(["list", "view", "check"]),
  run: new Set(["list", "view", "watch", "download"]),
  search: new Set(["issues", "prs", "repos", "commits", "code"]),
  variable: new Set(["get", "list"]),
  workflow: new Set(["list", "view"]),
};
/** Groups that are a read by themselves. */
const READ_GROUPS = new Set(["status", "help", "version", "--version", "--help", "completion"]);

/** The flags of `gh api` that take a value, by what the value is. */
const API_VALUE: Record<string, "method" | "field" | "body" | "other"> = {
  "-X": "method", "--method": "method",
  "-f": "field", "--raw-field": "field", "-F": "field", "--field": "field",
  "--input": "body",
  "-H": "other", "--header": "other", "-q": "other", "--jq": "other", "-t": "other", "--template": "other", "--hostname": "other", "--cache": "other", "-p": "other", "--preview": "other",
};

function apiReadsOnly(args: string[]): boolean {
  let method: string | undefined;
  const fields: string[] = [];
  let endpoint: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("-")) {
      endpoint ??= a;
      continue;
    }
    // `--flag=value`, `-Xvalue` and `-f key=value` are the same flag
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a.startsWith("--") ? a : a.slice(0, 2);
    const kind = API_VALUE[name];
    if (kind === undefined) continue; // a switch (`--paginate`, `-i`, `--slurp`)
    const glued = eq > 0 ? a.slice(eq + 1) : !a.startsWith("--") && a.length > 2 ? a.slice(2) : undefined;
    const value = glued ?? args[++i];
    if (value === undefined) return false;
    if (kind === "method") method = value.toUpperCase();
    else if (kind === "body") return false;
    else if (kind === "field") fields.push(value);
  }
  if (endpoint === undefined) return false;
  if (method !== undefined && method !== "GET" && method !== "HEAD") return false;
  const path = endpoint.replace(/^https?:\/\/[^/]+/i, "").replace(/^\//, "");
  if (path === "graphql") {
    // one text, written on the line, that is a query; every other field is a variable of it (never read from a file)
    const queries = fields.filter((f) => f.startsWith("query="));
    if (queries.length !== 1 || fields.some((f) => f.slice(f.indexOf("=") + 1).startsWith("@"))) return false;
    const text = queries[0]!.slice("query=".length);
    return /^\s*(query\b|\{)/.test(text) && !/\b(mutation|subscription)\b/.test(text);
  }
  // a field without an explicit GET makes gh send a POST
  return fields.length === 0 || method !== undefined;
}

export function ghReadsOnly(argv: string[]): boolean {
  let i = 0;
  // gh takes -R before the group too
  for (; i < argv.length && argv[i]!.startsWith("-") && !READ_GROUPS.has(argv[i]!); i++) if (argv[i] === "-R" || argv[i] === "--repo") i++;
  const group = argv[i];
  if (group === undefined) return true; // `gh` alone prints its help
  if (READ_GROUPS.has(group)) return true;
  if (group === "api") return apiReadsOnly(argv.slice(i + 1));
  const reads = READS[group];
  if (!reads) return false;
  for (let j = i + 1; j < argv.length; j++) {
    const a = argv[j]!;
    if (a === "-R" || a === "--repo") j++;
    else if (!a.startsWith("-")) return reads.has(a);
  }
  return false;
}

/**
 * Set to `1` in the environment of a session on a machine that must not write to the forge (the app sets it for the
 * Tasks of a work machine). The check in front of `gh` then lets only reads through. A session can unset it — it is the
 * same OS user — so the credentials on such a machine must not be able to write either.
 */
export const FORGE_READ_ONLY_ENV = "OPS_KIT_FORGE_READ_ONLY";
export const forgeReadOnly = (env: Record<string, string | undefined>) => env[FORGE_READ_ONLY_ENV] === "1";
