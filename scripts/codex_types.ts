/**
 * codex_types.ts — snapshot the subset of `codex app-server generate-ts` output that the Codex adapter uses.
 *
 * Why a subset: the full generation is ~550 files / 2.6 MB per version. The adapter reads a handful of
 * notifications and requests, so we commit the transitive import closure of those seeds only, under
 * packages/adapters/codex/src/generated/ (Apache-2.0, see packages/adapters/codex/NOTICE). CI typechecks
 * against the committed snapshot; `codex` itself is not required to build.
 *
 * Usage:
 *   bun run scripts/codex_types.ts                 # runs `codex app-server generate-ts` (CODEX_BIN to override)
 *   CODEX_TS_DIR=/path/to/generated bun run scripts/codex_types.ts   # reuse an existing generation
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outDir = join(root, "packages", "adapters", "codex", "src", "generated");

/** Types the adapter imports directly. Everything they reference is pulled in transitively. */
const SEEDS = [
  "InitializeParams", "InitializeResponse",
  "v2/ThreadStartParams", "v2/ThreadStartResponse", "v2/ThreadResumeParams", "v2/ThreadResumeResponse",
  "v2/TurnStartParams", "v2/TurnStartResponse", "v2/TurnSteerParams", "v2/TurnInterruptParams", "v2/TurnInterruptResponse",
  "v2/ThreadStartedNotification", "v2/ThreadStatusChangedNotification", "v2/ThreadTokenUsageUpdatedNotification",
  "v2/TurnStartedNotification", "v2/TurnCompletedNotification",
  "v2/ItemStartedNotification", "v2/ItemCompletedNotification", "v2/AgentMessageDeltaNotification",
  "v2/CommandExecutionOutputDeltaNotification", "v2/ServerRequestResolvedNotification", "v2/ErrorNotification",
  "v2/AccountRateLimitsUpdatedNotification",
  "v2/CommandExecutionRequestApprovalParams", "v2/CommandExecutionRequestApprovalResponse",
  "v2/FileChangeRequestApprovalParams", "v2/FileChangeRequestApprovalResponse",
];

let genDir = process.env.CODEX_TS_DIR;
let tmp: string | undefined;
if (!genDir) {
  const bin = process.env.CODEX_BIN ?? Bun.which("codex");
  if (!bin) {
    console.error("codex not found on PATH. Set CODEX_BIN=/path/to/codex or CODEX_TS_DIR=/path/to/generated");
    process.exit(1);
  }
  tmp = mkdtempSync(join(tmpdir(), "codex-ts-"));
  const proc = Bun.spawnSync([bin, "app-server", "generate-ts", "--out", tmp], { stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) process.exit(proc.exitCode);
  genDir = tmp;
  const ver = Bun.spawnSync([bin, "--version"], { stdout: "pipe" }).stdout.toString().trim();
  writeFileSync(join(tmp, "VERSION"), ver + "\n");
}

const seen = new Set<string>();
const queue = [...SEEDS];
while (queue.length) {
  const name = queue.pop()!;
  if (seen.has(name)) continue;
  const file = join(genDir, `${name}.ts`);
  if (!existsSync(file)) {
    console.error(`missing ${name}`);
    continue;
  }
  seen.add(name);
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(/from "(\.{1,2}\/[^"]+?)(?:\.ts)?"/g)) {
    const target = relative(genDir, resolve(dirname(file), m[1]!));
    queue.push(target);
  }
}

// License boundary: only type declarations may be vendored. Refuse anything that would ship runtime code.
const RUNTIME = /^\s*(export\s+)?(const|let|var|function|class|enum|async function)\b/m;
for (const name of seen) {
  const src = readFileSync(join(genDir, `${name}.ts`), "utf8");
  if (RUNTIME.test(src) || /^\s*import\s+(?!type\b)/m.test(src)) {
    console.error(`${name}.ts contains runtime code or a value import; the snapshot must stay declaration-only`);
    process.exit(2);
  }
}

rmSync(outDir, { recursive: true, force: true });
for (const name of [...seen].sort()) {
  const dst = join(outDir, `${name}.ts`);
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(join(genDir, `${name}.ts`), dst);
}
const version = existsSync(join(genDir, "VERSION")) ? readFileSync(join(genDir, "VERSION"), "utf8").trim() : "unknown";
writeFileSync(
  join(outDir, "README.md"),
  `# Generated — do not edit\n\nSnapshot of \`codex app-server generate-ts\` (${version}), restricted to the ${seen.size} files reachable from the seeds in \`scripts/codex_types.ts\`.\nRegenerate with \`bun run scripts/codex_types.ts\`. License: Apache-2.0 (OpenAI), see \`packages/adapters/codex/NOTICE\`.\n`,
);
if (tmp) rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${seen.size} files to ${relative(root, outDir)} (${version})`);
