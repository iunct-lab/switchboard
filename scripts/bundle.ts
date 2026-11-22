#!/usr/bin/env bun
// 束の作業を終える Task が、束が置いた止め（定期実行・昇格）を解く / 見るコマンド。
// 使い方: bun scripts/bundle.ts release | status
// 宛先と鍵は scripts/promote.ts と同じ（デーモンが Task に渡す BACKLOG_URL の origin と BACKLOG_TOKEN_FILE）。
// release は止めた定期実行だけを戻す（止めている間に利用者が入れた・消したものは触らない）。
// exit: 0 = 済んだ（止めが無いときも） / 2 = 使い方の誤り・デーモンに届かない・答えが読めない
import { readFileSync } from "node:fs";

type Hold = { taskId: string; since: number; schedules: string[]; base: string | null };

export async function bundle(o: { cmd: string | undefined; base: string; token: string; fetch: typeof fetch }): Promise<{ code: 0 | 2; out: string }> {
  if (o.cmd !== "release" && o.cmd !== "status") return { code: 2, out: "使い方: bun scripts/bundle.ts release | status" };
  const headers = { authorization: `Bearer ${o.token}` };
  try {
    const r = await o.fetch(`${o.base}/api/bundle`, { method: o.cmd === "release" ? "DELETE" : "GET", headers });
    const text = await r.text();
    if (!r.ok) return { code: 2, out: `/api/bundle が ${r.status}: ${text}` };
    const body = JSON.parse(text) as unknown;
    if (o.cmd === "release") {
      const { released, restored } = body as { released?: boolean; restored?: string[] };
      return { code: 0, out: released ? `止めを解いた。戻した定期実行 ${restored?.length ?? 0} 件` : "止めはありません" };
    }
    const hold = body as Hold | null;
    return { code: 0, out: hold ? `止め中: Task ${hold.taskId}、${new Date(hold.since).toISOString()} から、止めた定期実行 ${hold.schedules.length} 件` : "止めはありません" };
  } catch (e) {
    return { code: 2, out: `デーモンに届かない: ${(e as Error).message}` };
  }
}

async function main(argv: string[]): Promise<number> {
  const url = process.env.BACKLOG_URL;
  const file = process.env.BACKLOG_TOKEN_FILE;
  if (argv.length !== 1 || !url || !file) {
    console.error("使い方: bun scripts/bundle.ts release | status（Task の中で、BACKLOG_URL と BACKLOG_TOKEN_FILE が要る）");
    return 2;
  }
  let token: string;
  try {
    token = readFileSync(file, "utf8").trim();
  } catch {
    console.error("BACKLOG_TOKEN_FILE を読めない");
    return 2;
  }
  let base: string;
  try {
    base = new URL(url).origin;
  } catch {
    console.error(`BACKLOG_URL が URL でない: ${url}`);
    return 2;
  }
  const r = await bundle({ cmd: argv[0], base, token, fetch });
  console.log(r.out);
  return r.code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
