import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { formatShare, presetShare } from "./preset-share.ts";

const DAY = 86_400_000;
const NOW = 100 * DAY;

/** A DB with the two tables the script reads: each task's user messages in order (the first is the request), and the settings. */
function db(tasks: Record<string, [text: string, daysAgo: number][]>, settings: Record<string, unknown> = {}) {
  const d = new Database(":memory:");
  d.run("CREATE TABLE events (task_id TEXT NOT NULL, seq INTEGER NOT NULL, ts INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY (task_id, seq))");
  d.run("CREATE TABLE settings (key TEXT PRIMARY KEY, json TEXT NOT NULL)");
  for (const [id, msgs] of Object.entries(tasks))
    msgs.forEach(([text, ago], i) => {
      d.run("INSERT INTO events VALUES (?, ?, ?, ?)", [id, i * 2 + 1, NOW - ago * DAY, JSON.stringify({ t: "message.delta", role: "user", text })]);
      d.run("INSERT INTO events VALUES (?, ?, ?, ?)", [id, i * 2 + 2, NOW - ago * DAY, JSON.stringify({ t: "message.delta", role: "assistant", text: "ok" })]);
    });
  for (const [k, v] of Object.entries(settings)) d.run("INSERT INTO settings VALUES (?, ?)", [k, JSON.stringify(v)]);
  return d;
}

const merge = "merge許可する。すすめて";
const use = (id: string, n: number, ago = 1, scene = "task") => Array.from({ length: n }, () => ({ id, scene, at: NOW - ago * DAY }));

describe("preset-share", () => {
  test("counts short replies sent 3 times or more, leaving out each task's first request", () => {
    const d = db({ a: [[merge, 1], [merge, 1]], b: [[merge, 2], [merge, 2]], c: [["一度だけ", 1], ["一度だけ", 1]] });
    // a and b start with the text: 2 of the 4 are requests, so the reply is sent 2 times and is not repeated
    expect(presetShare(d, { days: 14, now: NOW }).replies).toBe(0);
    const e = db({ a: [["依頼", 1], [merge, 1], [merge, 1]], b: [["依頼", 1], [merge, 2]] });
    expect(presetShare(e, { days: 14, now: NOW })).toEqual({ days: 14, replies: 3, viaPreset: 0 });
  });

  test("leaves out replies over 40 characters and outside the days", () => {
    const long = "あ".repeat(41);
    const d = db({ a: [["依頼", 1], [long, 1], [long, 1], [long, 1], ["再開して", 20], ["再開して", 20], ["再開して", 1]] });
    expect(presetShare(d, { days: 14, now: NOW }).replies).toBe(0);
  });

  test("counts a reply as via a preset up to the preset's task uses in the days", () => {
    const tasks = { a: [["依頼", 1], [merge, 1], [merge, 1], [merge, 1], [merge, 1]] as [string, number][] };
    const presets = [{ id: "p1", name: "merge", text: merge }];
    expect(presetShare(db(tasks, { presets, presetUses: use("p1", 2) }), { days: 14, now: NOW }).viaPreset).toBe(2);
    expect(presetShare(db(tasks, { presets, presetUses: use("p1", 9) }), { days: 14, now: NOW }).viaPreset).toBe(4);
    // a use on Home, or one older than the days, is not a reply via the preset
    expect(presetShare(db(tasks, { presets, presetUses: [...use("p1", 3, 1, "home"), ...use("p1", 3, 20)] }), { days: 14, now: NOW }).viaPreset).toBe(0);
  });

  test("two presets with the same text do not count the same replies twice", () => {
    const tasks = { a: [["依頼", 1], [merge, 1], [merge, 1], [merge, 1]] as [string, number][] };
    const presets = [{ id: "p1", name: "a", text: merge }, { id: "p2", name: "b", text: merge }];
    const s = presetShare(db(tasks, { presets, presetUses: [...use("p1", 3), ...use("p2", 3)] }), { days: 14, now: NOW });
    expect(s).toEqual({ days: 14, replies: 3, viaPreset: 3 });
  });

  test("a preset's {{target}} matches any target in the reply", () => {
    const tasks = { a: [["依頼", 1], ["PR #1 を見て", 1], ["PR #1 を見て", 1], ["PR #1 を見て", 1]] as [string, number][] };
    const presets = [{ id: "p1", name: "見る", text: "PR {{target}} を見て" }];
    expect(presetShare(db(tasks, { presets, presetUses: use("p1", 3) }), { days: 14, now: NOW }).viaPreset).toBe(3);
  });

  test("one preset's uses are not counted again for each target it matches", () => {
    const r = (t: string): [string, number] => [t, 1];
    const tasks = { a: [["依頼", 1], r("PR #1 を見て"), r("PR #1 を見て"), r("PR #1 を見て"), r("PR #2 を見て"), r("PR #2 を見て"), r("PR #2 を見て")] };
    const presets = [{ id: "p1", name: "見る", text: "PR {{target}} を見て" }];
    expect(presetShare(db(tasks, { presets, presetUses: use("p1", 3) }), { days: 14, now: NOW })).toEqual({ days: 14, replies: 6, viaPreset: 3 });
  });

  test("prints one line, 0.0% when there are no replies", () => {
    expect(formatShare({ days: 14, replies: 8, viaPreset: 2 })).toBe("preset-share days=14 replies=8 via-preset=2 share=25.0%");
    expect(formatShare({ days: 14, replies: 0, viaPreset: 0 })).toBe("preset-share days=14 replies=0 via-preset=0 share=0.0%");
  });
});
