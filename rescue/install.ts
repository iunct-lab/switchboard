/**
 * bun rescue/install.ts — bundle sb-rescue into one file outside the checkout (<home>/rescue/sb-rescue.js), so the
 * process that must survive a broken self-update does not run from the tree agents edit. Re-run it by hand after a
 * reviewed change to rescue/ has been merged; nothing updates it automatically.
 *
 * bun rescue/install.ts --source <owner/name> — without git: run it from the unpacked source tarball of a Release.
 * It downloads the latest Release of <owner/name>, builds it as the first release under <home>/releases, records the
 * source in <home>/update-source.json and bundles sb-rescue the same way.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { installFromSource } from "./src/install-source.ts";

const home = process.env.SWITCHBOARD_HOME ? resolve(process.env.SWITCHBOARD_HOME) : join(homedir(), ".switchboard");
const outdir = join(home, "rescue");
const args = process.argv.slice(2);
const source = args[0] === "--source" ? args[1] : undefined;
if (args.length !== 0 && !(args.length === 2 && source && !source.startsWith("-"))) {
  console.error("usage: bun rescue/install.ts [--source <owner/name>]");
  process.exit(2);
}

if (source) {
  try {
    const { tag, sha, kept } = await installFromSource(home, source);
    if (kept) console.log(`${tag ?? sha.slice(0, 7)} already runs from ${source}; newer releases come through the check of their diff, not this install`);
    else console.log(`installed ${tag} (${sha.slice(0, 7)}) from ${source} under ${join(home, "releases")}`);
  } catch (e) {
    console.error(`install failed: ${String((e as Error).message ?? e)}`);
    process.exit(1);
  }
}
const built = await Bun.build({ entrypoints: [join(import.meta.dir, "src", "main.ts")], target: "bun", outdir, naming: "sb-rescue.js" });
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
console.log(`installed ${join(outdir, "sb-rescue.js")}`);
const homeEnv = process.env.SWITCHBOARD_HOME ? `SWITCHBOARD_HOME=${home} ` : "";
console.log(`start it with:\n  ${source ? homeEnv : `SWITCHBOARD_REPO_ROOT=${resolve(import.meta.dir, "..")} `}bun ${join(outdir, "sb-rescue.js")}`);
