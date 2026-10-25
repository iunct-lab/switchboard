import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RunnerId, Workspace } from "@switchboard/protocol";

/**
 * The prompt prefix "改善 →" on Home puts in front of a request. It used to be one hard-coded paragraph about Switchboard,
 * so switching the Workspace select left an instruction that still said "you are working in Switchboard" — a request for
 * another repository (DAK, say) could not be phrased. Now the daemon writes it per workspace: the meta workspace keeps its
 * architecture map, any other repository gets what can be read off its tree (layout, instruction files, test / run commands).
 * The text ends with the "やってほしいこと:" marker; everything the user types after it is the request itself.
 */
export const BRIEF_REQUEST_MARKER = "やってほしいこと:";

/** Directories that say nothing about a repository's shape. */
const NOISE = new Set(["node_modules", "dist", "build", "target", "out", "coverage", "__pycache__", "venv", ".venv"]);
const MAX_ENTRIES = 14;

/** Best effort over an arbitrary tree: a manifest of an unexpected shape degrades to the generic lines, never to a 500. */
/** `runners` are the ones the daemon registered: the architecture map names only those adapters. */
export function workspaceBrief(ws: Workspace, runners: readonly RunnerId[]): string {
  try {
    return brief(ws, runners);
  } catch {
    return `${ws.kind === "meta" ? "あなたは Switchboard（このアプリ自身）のリポジトリで作業しています。" : `あなたは ${ws.name}（${ws.path}）のリポジトリで作業しています。`}\nテスト: 変更にはテストを添え、既存テストを壊さないこと。\n\n${BRIEF_REQUEST_MARKER}\n`;
  }
}

function brief(ws: Workspace, runners: readonly RunnerId[]): string {
  const lines: string[] = [];
  if (ws.kind === "meta") {
    lines.push("あなたは Switchboard（このアプリ自身）のリポジトリで作業しています。");
    lines.push(`構成: packages/protocol（AgentEvent zod スキーマ）, packages/core（Bun デーモン: server.ts / tasks.ts / db.ts）, packages/adapters/{${runners.join(",")}}（各ランナーのアダプタ）, apps/web（React + Vite UI）。`);
  } else {
    lines.push(`あなたは ${ws.name}（${ws.path}）のリポジトリで作業しています。`);
    const layout = listLayout(ws.path);
    if (layout) lines.push(`構成: ${layout}`);
  }
  const instructions = ["CLAUDE.md", "AGENTS.md"].filter((f) => existsSync(join(ws.path, f)));
  if (instructions.length) lines.push(`指示: リポジトリの ${instructions.join(" / ")} に従うこと。`);
  const checks = detectChecks(ws.path);
  lines.push(checks.length ? `テスト: リポジトリ直下で ${checks.map((c) => `\`${c}\``).join("、")}。変更にはテストを添え、既存テストを壊さないこと。` : "テスト: 変更にはテストを添え、既存テストを壊さないこと。");
  const run = detectRun(ws.path);
  if (run) lines.push(`起動: \`${run}\`。`);
  return `${lines.join("\n")}\n\n${BRIEF_REQUEST_MARKER}\n`;
}

/** Top-level entries, directories first with a trailing slash, hidden and generated ones left out, capped. */
function listLayout(dir: string): string {
  let entries: Array<{ name: string; dir: boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith(".") && !NOISE.has(e.name))
      // Dirent.isDirectory() is false for a symlinked directory; stat follows the link
      .map((e) => ({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && isDir(join(dir, e.name))) }));
  } catch {
    return "";
  }
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  const shown = entries.slice(0, MAX_ENTRIES).map((e) => (e.dir ? `${e.name}/` : e.name));
  if (entries.length > MAX_ENTRIES) shown.push(`…（他 ${entries.length - MAX_ENTRIES} 件）`);
  return shown.join(", ");
}

/** Commands that verify a change, read off the manifests present. Order: JS/TS, Python, Rust, Go, Make. */
export function detectChecks(dir: string): string[] {
  const out: string[] = [];
  const has = (f: string) => existsSync(join(dir, f));
  const pkg = readJson(join(dir, "package.json"));
  const scripts = isRecord(pkg) && isRecord(pkg.scripts) ? pkg.scripts : null;
  if (scripts) {
    const runner = has("bun.lock") || has("bun.lockb") || has("bunfig.toml") ? "bun" : has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    for (const script of ["typecheck", "lint", "test"]) {
      if (typeof scripts[script] !== "string") continue;
      // `bun run test` is right for every value of scripts.test; only the literal "bun test" is shortened (arguments such as
      // "bun test packages apps" or a --preload must not be dropped)
      if (script === "test" && runner === "bun" && String(scripts.test).trim() === "bun test") out.push("bun test");
      else out.push(runner === "npm" ? `npm run ${script}` : `${runner} run ${script}`);
    }
  }
  if (has("pyproject.toml")) {
    // pytest is configured ([tool.pytest…]) or declared as a dependency, or there is a tests directory — a mention in a
    // comment or an exclude list does not count, and a *file* named tests is not a test suite
    const py = readText(join(dir, "pyproject.toml"));
    const configured = /^\s*\[tool\.pytest/m.test(py) || /["']pytest(\[[^"']*\])?\s*[>=<~!;"']/m.test(py);
    if (configured || isDir(join(dir, "tests")) || isDir(join(dir, "test"))) out.push(has("uv.lock") ? "uv run pytest" : "pytest");
  }
  if (has("Cargo.toml")) out.push("cargo test");
  if (has("go.mod")) out.push("go test ./...");
  if (/^test:/m.test(readText(join(dir, "Makefile")))) out.push("make test");
  return out;
}

/** How the thing is started, when the repository says so (a compose file at the root). */
export function detectRun(dir: string): string | null {
  for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) if (existsSync(join(dir, f))) return "docker compose up";
  return null;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}
