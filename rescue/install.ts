/**
 * bun rescue/install.ts — bundle sb-rescue into one file outside the checkout (<home>/rescue/sb-rescue.js), so the
 * process that must survive a broken self-update does not run from the tree agents edit. Re-run it by hand after a
 * reviewed change to rescue/ has been merged; nothing updates it automatically.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const home = process.env.SWITCHBOARD_HOME ? resolve(process.env.SWITCHBOARD_HOME) : join(homedir(), ".switchboard");
const outdir = join(home, "rescue");
const built = await Bun.build({ entrypoints: [join(import.meta.dir, "src", "main.ts")], target: "bun", outdir, naming: "sb-rescue.js" });
if (!built.success) {
  for (const log of built.logs) console.error(log);
  process.exit(1);
}
console.log(`installed ${join(outdir, "sb-rescue.js")}`);
console.log(`start it with:\n  SWITCHBOARD_REPO_ROOT=${resolve(import.meta.dir, "..")} bun ${join(outdir, "sb-rescue.js")}`);
