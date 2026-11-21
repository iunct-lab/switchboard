/**
 * codex_types.ts — generate the Codex protocol types the adapter uses from the pinned Codex.
 *
 * `bun run typecheck` runs this first. The types come from the Codex version pinned as `CODEX_VERSION` in
 * container/Dockerfile (the version the CI image has), not from whichever Codex this host has installed, so every
 * typecheck caller sees the same types. The output,
 * packages/adapters/codex/src/generated/, is not kept in Git (.gitignore). Only the transitive import closure
 * of the seeds below is written: the full generation is ~750 files, the adapter reads a handful of them.
 * No login is needed. If the host's Codex is the pinned version it is used; otherwise the generation for that pin is
 * read from the cache (~/.cache/switchboard.codex-ts/<pin>/, about 3 MB), made once by installing the pinned Codex
 * with npm into a temporary directory that is removed afterwards. There is no fallback to the host's Codex.
 *
 * Usage:
 *   bun run scripts/codex_types.ts                 # the pinned Codex (CODEX_BIN to override)
 *   CODEX_TS_DIR=/path/to/generated bun run scripts/codex_types.ts   # reuse an existing generation
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const outDir = join(root, "packages", "adapters", "codex", "src", "generated");

/** Types the adapter imports directly. Everything they reference is pulled in transitively. */
const SEEDS = [
  "InitializeParams", "InitializeResponse",
  "v2/ThreadStartParams", "v2/ThreadStartResponse", "v2/ThreadResumeParams", "v2/ThreadResumeResponse", "v2/ThreadForkParams", "v2/ThreadForkResponse",
  "v2/TurnStartParams", "v2/TurnStartResponse", "v2/TurnSteerParams", "v2/TurnInterruptParams", "v2/TurnInterruptResponse",
  "v2/ThreadStartedNotification", "v2/ThreadStatusChangedNotification", "v2/ThreadTokenUsageUpdatedNotification",
  "v2/TurnStartedNotification", "v2/TurnCompletedNotification",
  "v2/ItemStartedNotification", "v2/ItemCompletedNotification", "v2/AgentMessageDeltaNotification",
  "v2/CommandExecutionOutputDeltaNotification", "v2/ServerRequestResolvedNotification", "v2/ErrorNotification",
  "v2/AccountRateLimitsUpdatedNotification",
  "v2/CommandExecutionRequestApprovalParams", "v2/CommandExecutionRequestApprovalResponse",
  "v2/FileChangeRequestApprovalParams", "v2/FileChangeRequestApprovalResponse",
  "v2/ToolRequestUserInputParams", "v2/ToolRequestUserInputResponse",
  "v2/McpServerElicitationRequestParams", "v2/McpServerElicitationRequestResponse",
];

export type CodexSource = { kind: "dir"; dir: string } | { kind: "bin"; bin: string } | { kind: "fetch"; dir: string };

/** The Codex version the CI image installs: the `ARG CODEX_VERSION=` line of container/Dockerfile. */
export function codexPin(dockerfile: string): string {
  const m = dockerfile.match(/^ARG CODEX_VERSION=(\S+)\s*$/m);
  if (!m) throw new Error("container/Dockerfile に ARG CODEX_VERSION= の行がありません");
  return m[1]!;
}

export const defaultCacheDir = (): string => join(homedir(), ".cache", "switchboard.codex-ts");

/** Where the types come from. Explicit overrides win; the host's Codex only when it is exactly the pin. */
export function chooseCodexSource(a: {
  pin: string;
  hostVersion: string | undefined;
  hostBin?: string;
  env: Record<string, string | undefined>;
  cacheDir: string;
}): CodexSource {
  if (a.env.CODEX_TS_DIR) return { kind: "dir", dir: a.env.CODEX_TS_DIR };
  if (a.env.CODEX_BIN) return { kind: "bin", bin: a.env.CODEX_BIN };
  if (a.hostBin && a.hostVersion === `codex-cli ${a.pin}`) return { kind: "bin", bin: a.hostBin };
  const dir = join(a.cacheDir, a.pin);
  if (existsSync(join(dir, "VERSION"))) return { kind: "dir", dir };
  return { kind: "fetch", dir };
}

function run(cmd: string[]): void {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.slice(0, 3).join(" ")} が失敗 (exit ${p.exitCode}): ${p.stderr.toString().trim().split("\n").slice(-3).join(" / ")}`);
}

/**
 * Removes the `.fetch-*` install dirs a killed fetch left behind (a signal skips the `finally` below), so the pinned
 * Codex (about 400 MB) does not stay in the cache. Only dirs older than `maxAgeMs` go: a fetch takes seconds, and a
 * younger dir may be another process's fetch in progress.
 */
export function sweepStaleFetches(cacheDir: string, nowMs = Date.now(), maxAgeMs = 30 * 60_000): void {
  if (!existsSync(cacheDir)) return;
  for (const name of readdirSync(cacheDir)) {
    if (!name.startsWith(".fetch-")) continue;
    const p = join(cacheDir, name);
    try {
      if (statSync(p).mtimeMs < nowMs - maxAgeMs) rmSync(p, { recursive: true, force: true });
    } catch {
      // Removed by another process meanwhile.
    }
  }
}

/** Installs the pinned Codex into a temp dir, generates the types, keeps only the generation (the binary is removed). */
function fetchPinned(pin: string, dest: string, cacheDir: string): void {
  mkdirSync(cacheDir, { recursive: true });
  sweepStaleFetches(cacheDir);
  const tmp = mkdtempSync(join(cacheDir, ".fetch-"));
  try {
    run(["npm", "install", "--prefix", join(tmp, "c"), "--ignore-scripts", "--no-fund", "--no-audit", `@openai/codex@${pin}`]);
    const bin = join(tmp, "c", "node_modules", ".bin", "codex");
    run([bin, "app-server", "generate-ts", "--out", join(tmp, "gen")]);
    const ver = Bun.spawnSync([bin, "--version"], { stdout: "pipe" }).stdout.toString().trim();
    writeFileSync(join(tmp, "gen", "VERSION"), ver + "\n");
    try {
      renameSync(join(tmp, "gen"), dest);
    } catch (e) {
      // Another process placed it first; keep theirs.
      if (!existsSync(join(dest, "VERSION"))) throw e;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Returns the directory holding a full generation, and a temp dir to remove afterwards (if one was made).
 * A failed fetch throws; it never falls back to the host's Codex.
 */
export function resolveGeneration(a: Parameters<typeof chooseCodexSource>[0] & { fetch?: typeof fetchPinned }): { genDir: string; tmp?: string } {
  const src = chooseCodexSource(a);
  if (src.kind === "dir") return { genDir: src.dir };
  if (src.kind === "fetch") {
    try {
      (a.fetch ?? fetchPinned)(a.pin, src.dir, a.cacheDir);
    } catch (e) {
      throw new Error(`pin の Codex ${a.pin} を取れない: ${(e as Error).message}`);
    }
    return { genDir: src.dir };
  }
  const tmp = mkdtempSync(join(tmpdir(), "codex-ts-"));
  const proc = Bun.spawnSync([src.bin, "app-server", "generate-ts", "--out", tmp], { stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) process.exit(proc.exitCode);
  const ver = Bun.spawnSync([src.bin, "--version"], { stdout: "pipe" }).stdout.toString().trim();
  writeFileSync(join(tmp, "VERSION"), ver + "\n");
  return { genDir: tmp, tmp };
}

if (import.meta.main) {
const pin = codexPin(readFileSync(join(root, "container", "Dockerfile"), "utf8"));
const hostBin = Bun.which("codex") ?? undefined;
const hostVersion = hostBin ? Bun.spawnSync([hostBin, "--version"], { stdout: "pipe" }).stdout.toString().trim() : undefined;
let generation: { genDir: string; tmp?: string };
try {
  generation = resolveGeneration({ pin, hostVersion, hostBin, env: process.env, cacheDir: defaultCacheDir() });
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const { genDir, tmp } = generation;

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
}
