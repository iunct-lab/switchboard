#!/usr/bin/env bun
// Task が「自分以外の Task が動いても待ってもいなければ昇格する」（CLAUDE.md の常時の OK）を自分で確かめてから、昇格を頼む 1 つのコマンド。
// 使い方: bun scripts/promote.ts <commit>   （<commit> は sha・タグ・origin/main など。作業フォルダで完全な sha に解決する）
// 宛先と鍵はデーモンが Task に渡す BACKLOG_URL の origin と BACKLOG_TOKEN_FILE。呼んだ Task は SWITCHBOARD_TASK_ID で除く。
// exit: 0 = 昇格を頼んだ / 1 = ほかの Task がいるので頼まない / 2 = 判定できない・頼めない（待つのはデーモンの promoteWhenIdle で、ここでは待たない・再試行しない）
import { readFileSync } from "node:fs";

export type PromoteInput = {
  commit: string;
  taskId: string | undefined;
  base: string;
  token: string;
  fetch: typeof fetch;
  resolve: (rev: string) => Promise<string>;
};

type Busy = { id: string; title?: string; status?: string };

export async function promote(o: PromoteInput): Promise<{ code: 0 | 1 | 2; out: string }> {
  let sha: string;
  try {
    sha = (await o.resolve(o.commit)).trim();
  } catch (e) {
    return { code: 2, out: `コミットを解決できない: ${o.commit}: ${(e as Error).message}` };
  }
  if (!sha) return { code: 2, out: `コミットを解決できない: ${o.commit}` };
  const headers = { authorization: `Bearer ${o.token}` };
  try {
    const h = await o.fetch(`${o.base}/api/health`, { headers });
    if (!h.ok) return { code: 2, out: `/api/health が ${h.status}: ${await h.text()}` };
    const listed = ((await h.json()) as { busyTasks?: unknown }).busyTasks;
    // 一覧が無い（鍵が通らず公開の項目だけが返った、古いデーモン）なら、ほかの Task がいないとは言えない
    if (!Array.isArray(listed)) return { code: 2, out: "/api/health に busyTasks が無い（鍵が通らない・デーモンが古い）。ほかの Task を確かめられない" };
    const busy = (listed as Busy[]).filter((t) => !o.taskId || t.id !== o.taskId);
    if (busy.length) {
      return { code: 1, out: [`昇格しない: ほかに動いている・待っている Task ${busy.length} 件`, ...busy.map((t) => `${t.id}\t${t.title ?? ""}\t${t.status ?? ""}`)].join("\n") };
    }
    const r = await o.fetch(`${o.base}/api/daemon/promote`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ commit: sha, force: true }),
    });
    const text = await r.text();
    if (r.status >= 200 && r.status < 300) return { code: 0, out: `${text}\ncommit ${sha}` };
    return { code: 2, out: `昇格を頼めない: ${r.status} ${text}` };
  } catch (e) {
    return { code: 2, out: `デーモンに届かない: ${(e as Error).message}` };
  }
}

async function main(argv: string[]): Promise<number> {
  const [commit] = argv;
  const url = process.env.BACKLOG_URL;
  const file = process.env.BACKLOG_TOKEN_FILE;
  if (!commit || argv.length !== 1 || !url || !file) {
    console.error("使い方: bun scripts/promote.ts <commit>（Task の中で、BACKLOG_URL と BACKLOG_TOKEN_FILE が要る）");
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
  const r = await promote({
    commit,
    taskId: process.env.SWITCHBOARD_TASK_ID,
    base,
    token,
    fetch,
    resolve: async (rev) => {
      const p = Bun.spawn(["git", "rev-parse", "--verify", `${rev}^{commit}`], { stdout: "pipe", stderr: "pipe" });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      if ((await p.exited) !== 0) throw new Error(err.trim() || "git rev-parse failed");
      return out.trim();
    },
  });
  console.log(r.out);
  return r.code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
