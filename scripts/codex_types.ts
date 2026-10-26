/**
 * codex_types.ts — generate the Codex protocol types the adapter uses from the installed Codex.
 *
 * `bun run typecheck` runs this first, so the types always match the Codex this host talks to. The output,
 * packages/adapters/codex/src/generated/, is not kept in Git (.gitignore). Only the transitive import closure
 * of the seeds below is written: the full generation is ~750 files, the adapter reads a handful of them.
 * Developing (typecheck, CI) needs the Codex CLI installed; no login is needed.
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
    console.error("typecheck には Codex CLI が要ります。README の Setup に従って入れてください");
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

// The adapter imports these as types only. Refuse anything that would put runtime code into the build.
const RUNTIME = /^\s*(export\s+)?(const|let|var|function|class|enum|async function)\b/m;
for (const name of seen) {
  const src = readFileSync(join(genDir, `${name}.ts`), "utf8");
  if (RUNTIME.test(src) || /^\s*import\s+(?!type\b)/m.test(src)) {
    console.error(`${name}.ts contains runtime code or a value import; the generated types must stay declaration-only`);
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
if (tmp) rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${seen.size} files to ${relative(root, outDir)} (${version})`);
