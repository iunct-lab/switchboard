/**
 * The first release without git: the latest Release of `source` (`owner/name`) is downloaded as a tarball, unpacked,
 * built and made current, and `<home>/update-source.json` records where later releases come from. The caller
 * (rescue/install.ts) bundles sb-rescue after this.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkSource, extractTarball, fetchTarball, latestRelease } from "./github-release.ts";
import { appendHistory, buildFromTree, currentOf, releasesDir, switchTo } from "./releases.ts";

/**
 * A home that already runs a release is not switched: a later release goes through the check of its diff, and the source
 * stays the one it was installed with. Run again with the same source, this changes nothing (the caller bundles sb-rescue
 * again) and says which release runs; with another source, or on a home built from a checkout, it throws.
 */
export async function installFromSource(home: string, source: string): Promise<{ tag: string | null; sha: string; kept: boolean }> {
  checkSource(source);
  const running = currentOf(home);
  if (running) {
    const file = join(home, "update-source.json");
    const was = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { source?: unknown }).source : null;
    if (was !== source) {
      throw new Error(was ? `${home} is installed from ${String(was)}; it is not changed to ${source}` : `${home} runs releases built from a checkout; install into another SWITCHBOARD_HOME`);
    }
    let tag: string | null = null;
    try {
      tag = (JSON.parse(readFileSync(join(releasesDir(home), running, ".release.json"), "utf8")) as { tag?: string }).tag ?? null;
    } catch {
      // no tag recorded: said as unknown
    }
    return { tag, sha: running, kept: true };
  }
  const { tag, sha } = await latestRelease(source);
  mkdirSync(releasesDir(home), { recursive: true });
  if (!existsSync(join(releasesDir(home), sha))) {
    const work = join(releasesDir(home), `.tmp-${sha}-${process.pid}`);
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    try {
      const tarball = await fetchTarball(source, tag, work);
      const tree = join(work, "tree");
      await extractTarball(tarball, tree, { tag, sha });
      await buildFromTree(tree, sha, home, { tag, sha });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
  const from = currentOf(home);
  switchTo(home, sha);
  // written last: sb-rescue reads "a source and no release" as "install first", so a failed build leaves no source file behind
  writeFileSync(join(home, "update-source.json"), JSON.stringify({ source }) + "\n");
  appendHistory(home, { action: "install", from, to: sha, ok: true, reason: `first release ${tag} from ${source}` });
  return { tag, sha, kept: false };
}
