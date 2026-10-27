/** Resolve the user's repository without storing a destination in the tree. */
export function currentRepo(cwd = process.cwd()): string {
  const given = process.env.GH_REPO;
  if (given) {
    const repo = parseRepo(given);
    if (repo) return repo;
    throw new Error("GH_REPO must be owner/name, host/owner/name, or a repository URL");
  }
  const result = Bun.spawnSync(["git", "-C", cwd, "remote", "get-url", "origin"], { stderr: "pipe" });
  const repo = result.exitCode === 0 ? parseRepo(result.stdout.toString().trim()) : undefined;
  if (!repo) throw new Error("Cannot resolve repository: set GH_REPO or configure a valid origin remote");
  return repo;
}

/** The working tree's origin only (not GH_REPO): what a repository-local command like `gh stack` acts on. */
export function originRepo(cwd = process.cwd()): string | undefined {
  const result = Bun.spawnSync(["git", "-C", cwd, "remote", "get-url", "origin"], { stderr: "pipe" });
  return result.exitCode === 0 ? parseRepo(result.stdout.toString().trim()) : undefined;
}

function parseRepo(value: string): string | undefined {
  const path = value.trim().replace(/^[a-z][a-z\d+.-]*:\/\/(?:[^/@]+@)?[^/]+\//i, "")
    .replace(/^[^/@]+@[^:]+:/, "").replace(/\.git\/?$/, "").replace(/\/$/, "");
  const parts = path.split("/");
  if (parts.length === 3) parts.shift();
  return parts.length === 2 && parts.every((p) => /^[\w.-]+$/.test(p) && p !== "." && p !== "..") ? parts.join("/") : undefined;
}
