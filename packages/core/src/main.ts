import { createClaudeAdapter } from "@switchboard/adapter-claude";
import { createCodexAdapter } from "@switchboard/adapter-codex";
import { createDakAdapter } from "@switchboard/adapter-dak";
import { loadConfig } from "./config.ts";
import { startServer } from "./server.ts";
import type { Suggester } from "./routing.ts";
import { relocate } from "./relocate.ts";
import { shutdownOnce } from "./selfdev.ts";
import { exportHistory, importHistory } from "./transfer.ts";
import { Db } from "./db.ts";
import { commitEventsArchive, prepareEventsArchive, readUploaded } from "./events-archive.ts";

const cfg = loadConfig();

// `main.ts export <out> [--encrypt <age recipient>]` / `main.ts import <file> [--identity <age key file>]` (#179) move the
// history to another machine and exit; with no arguments this is the daemon.
const [cmd, ...args] = process.argv.slice(2);
if (cmd === "export" || cmd === "import") {
  const flag = (name: string) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? "") : undefined);
  const file = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  // A flag without its value must stop, not quietly write an unencrypted package.
  const missing = ["--encrypt", "--identity"].some((f) => flag(f) === "" || flag(f)?.startsWith("--"));
  if (!file || missing) {
    console.error("usage: bun packages/core/src/main.ts export <out.tar.zst> [--encrypt <age recipient>]\n       bun packages/core/src/main.ts import <file> [--identity <age key file>]");
    process.exit(2);
  }
  const started = Date.now();
  try {
    const m = cmd === "export" ? await exportHistory(cfg, file, { encryptTo: flag("--encrypt") }) : await importHistory(cfg, file, { identity: flag("--identity") });
    console.log(`${cmd}ed ${file} (${(Bun.file(file).size / 1e6).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)} s; from ${m.host}, HOME ${m.home})`);
    for (const [k, v] of Object.entries(m.counts)) console.log(`  ${k.padEnd(15)} ${v ?? "— (not found, skipped)"}`);
    process.exit(0);
  } catch (e) {
    console.error(`${cmd} failed: ${(e as Error).message}`);
    process.exit(1);
  }
}
// `main.ts events-archive prepare <dir> --encrypt <age recipient>` / `events-archive commit <dir>` (#1431): write the bodies
// of old finished tasks' events to encrypted files, and, after `archive.sh` uploaded them, replace the rows with skeletons.
if (cmd === "events-archive") {
  const [step, dir, ...rest] = args;
  const recipient = rest.includes("--encrypt") ? rest[rest.indexOf("--encrypt") + 1] : undefined;
  if ((step !== "prepare" && step !== "commit") || !dir || dir.startsWith("--") || (step === "prepare" && (!recipient || recipient.startsWith("--")))) {
    console.error("usage: bun packages/core/src/main.ts events-archive prepare <dir> --encrypt <age recipient>\n       bun packages/core/src/main.ts events-archive commit <dir>");
    process.exit(2);
  }
  const db = new Db(cfg.dbPath);
  try {
    if (step === "prepare") {
      const entries = await prepareEventsArchive(db.sqlite, dir, { encryptTo: recipient });
      console.log(`prepared ${entries.length} tasks (${entries.reduce((n, e) => n + e.count, 0)} events) in ${dir}`);
    } else {
      const moved = commitEventsArchive(db.sqlite, dir, readUploaded(dir));
      console.log(`archived ${moved.length} tasks`);
    }
    process.exit(0);
  } catch (e) {
    console.error(`events-archive ${step} failed: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
// `main.ts relocate --from <old> --to <new>` (#427): rewrite the history's absolute paths once, with the daemon stopped.
if (cmd === "relocate") {
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const from = flag("--from");
  const to = flag("--to");
  if (!from || !to || from.startsWith("--") || to.startsWith("--")) {
    console.error("usage: bun packages/core/src/main.ts relocate --from <old absolute path> --to <new absolute path>");
    process.exit(2);
  }
  try {
    const r = await relocate(cfg, from, to);
    console.log(`relocated ${from} → ${to}`);
    for (const [k, v] of Object.entries(r.rows)) console.log(`  ${k.padEnd(21)} ${v}`);
    console.log(`  ${"claude folders".padEnd(21)} ${r.folders}`);
    process.exit(0);
  } catch (e) {
    console.error(`relocate failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

// Adapters are plugins: any subset may be missing. Missing binaries / unreachable servers are reported, not fatal.
const adapters = [createClaudeAdapter(), createCodexAdapter(), createDakAdapter({ baseUrl: process.env.SWITCHBOARD_DAK_URL })];

/**
 * LLM routing suggestions (#25). Off unless the settings say otherwise; `SWITCHBOARD_SUGGESTER=fake` swaps in a
 * stub that spends no quota, for trying the UI. The real, adapter-backed suggester is wired in below it.
 */
const fakeSuggester: Suggester = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async suggest(ctx) {
    const runner = (["codex", "dak", "claude"] as const).find((r) => ctx.available.has(r)) ?? "claude";
    return { runner, reason: "開発用スタブの提案（SWITCHBOARD_SUGGESTER=fake）", ruleId: "llm", available: ctx.available.has(runner), alternatives: [], llm: null };
  },
};

const core = await startServer(cfg, adapters, { backlogAutoImport: true, llmSuggester: process.env.SWITCHBOARD_SUGGESTER === "fake" ? () => fakeSuggester : undefined });
// Off loopback (SWITCHBOARD_HOST=0.0.0.0, the cloud host) the runner list is only for authorized callers: ask as one.
const health = (await fetch(`http://127.0.0.1:${core.server.port}/api/health`, { headers: { authorization: `Bearer ${core.token}` } }).then((r) => r.json())) as {
  runners: Array<{ id: string; available: boolean; version?: string; note?: string }>;
};
console.log(`switchboard core  http://${cfg.host}:${core.server.port}`);
console.log(`data              ${cfg.home}`);
if (cfg.homeIsTemp) console.warn(`WARNING           the data directory is under a temp folder; tasks and the ledger recorded there disappear with it and a start without the same SWITCHBOARD_HOME will not show them`);
console.log(`meta workspace    ${cfg.repoRoot}`);
for (const r of health.runners) {
  console.log(`runner ${r.id.padEnd(7)} ${r.available ? `ok ${r.version ?? ""}` : `unavailable — ${r.note ?? ""}`}`);
}

const shutdown = shutdownOnce(() => core.stop(), (c) => process.exit(c));
process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
process.on("uncaughtException", (e) => void shutdown(1, e));
process.on("unhandledRejection", (e) => void shutdown(1, e));
