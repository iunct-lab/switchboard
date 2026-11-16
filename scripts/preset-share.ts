// 繰り返しの短い返事のうち、定型の指示を通したものの割合を DB から数える。手で回すときだけ使い、DB は読み取りだけで開く。
//   bun scripts/preset-share.ts [--days 14]   （SWITCHBOARD_HOME の switchboard.db。既定は ~/.switchboard）
// 繰り返しの短い返事: 直近 days 日の、利用者の返信（各 Task の最初の依頼を除く）のうち、40 字以下で同じ文が 3 回以上あるもの。
// 定型経由: settings の presetUses（[{ id, scene, at }]。無ければ空）の scene が "task" の記録がある定型の本文と同じ文。定型ごとに記録の回数を上限にする。

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_CHARS = 40;
export const MIN_REPEATS = 3;
const TARGET = "{{target}}";

export interface PresetShare { days: number; replies: number; viaPreset: number }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 定型の本文に合う文: 対象の差し込み口はどの文字列でもよい。 */
const matcher = (text: string) => new RegExp(`^${text.trim().split(TARGET).map(escapeRe).join(".+")}$`);

export function presetShare(db: Database, opts: { days: number; now: number }): PresetShare {
  const since = opts.now - opts.days * 86_400_000;
  // 各 Task の最初の user のメッセージは依頼なので、seq の一番小さい 1 件を除く
  const rows = db
    .query<{ text: string | null }, [number]>(
      `SELECT json_extract(e.json, '$.text') AS text FROM events e
       WHERE substr(e.json, 1, 34) = '{"t":"message.delta","role":"user"' AND e.ts >= ?
         AND e.seq > (SELECT MIN(f.seq) FROM events f WHERE f.task_id = e.task_id AND substr(f.json, 1, 34) = '{"t":"message.delta","role":"user"')`,
    )
    .all(since);
  const counts = new Map<string, number>();
  for (const { text } of rows) {
    const s = (text ?? "").trim();
    if (s && [...s].length <= MAX_CHARS) counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const repeated = [...counts].filter(([, n]) => n >= MIN_REPEATS);
  const replies = repeated.reduce((sum, [, n]) => sum + n, 0);

  const setting = (key: string): unknown => {
    const r = db.query<{ json: string }, [string]>("SELECT json FROM settings WHERE key = ?").get(key);
    try { return r ? JSON.parse(r.json) : []; } catch { return []; }
  };
  const list = (v: unknown): any[] => (Array.isArray(v) ? v : []);
  const used = new Map<string, number>();
  for (const u of list(setting("presetUses"))) if (u?.scene === "task" && typeof u.id === "string" && (typeof u.at !== "number" || u.at >= since)) used.set(u.id, (used.get(u.id) ?? 0) + 1);
  // each preset's uses are spent on the repeated texts it matches, at most the times each text was sent: a use is counted
  // once even when two presets have the same text or one preset's {{target}} matches several texts
  const presets = list(setting("presets")).filter((p) => typeof p?.text === "string" && used.has(p.id)).map((p) => ({ re: matcher(p.text), left: used.get(p.id)! }));
  let viaPreset = 0;
  for (const [s, n] of repeated) {
    let need = n;
    for (const p of presets) {
      if (!need) break;
      if (!p.left || !p.re.test(s)) continue;
      const take = Math.min(p.left, need);
      p.left -= take;
      need -= take;
      viaPreset += take;
    }
  }
  return { days: opts.days, replies, viaPreset };
}

export const formatShare = (s: PresetShare) => `preset-share days=${s.days} replies=${s.replies} via-preset=${s.viaPreset} share=${s.replies ? ((s.viaPreset / s.replies) * 100).toFixed(1) : "0.0"}%`;

if (import.meta.main) {
  const i = process.argv.indexOf("--days");
  const days = i >= 0 ? Number(process.argv[i + 1]) : 14;
  if (!(days > 0)) throw new Error("--days takes a positive number");
  const db = new Database(join(process.env.SWITCHBOARD_HOME ?? join(homedir(), ".switchboard"), "switchboard.db"), { readonly: true });
  try { console.log(formatShare(presetShare(db, { days, now: Date.now() }))); } finally { db.close(); }
}
