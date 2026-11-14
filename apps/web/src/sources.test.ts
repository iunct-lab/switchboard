import { describe, expect, test } from "bun:test";
import type { SourceRow, SourceView } from "@switchboard/protocol";
import { sourceHeaders, sourceTableRows } from "./sources.ts";

const row = (over: Partial<SourceRow>): SourceRow => ({ repo: "iunct-lab/switchboard", speaker: "利用者", route: null, opened: 0, planned: 0, dropped: 0, delivered: 0, daysToDeliver: null, stale: 0, reverted: 0, followUpBugs: 0, ...over });
const view = (rows: SourceRow[]): SourceView => ({ days: 30, now: 0, staleDays: 14, reworkDays: 7, rows, unread: [] });

describe("sources table", () => {
  test("parent row drops the owner, a child row is indented with its route", () => {
    const rows = sourceTableRows(view([row({ opened: 62, planned: 55, dropped: 2, delivered: 41, daysToDeliver: 2.14, stale: 3, reverted: 1, followUpBugs: 2 }), row({ speaker: "エージェント", route: "動向からの案", opened: 4 })]));
    expect(rows[0]).toEqual({ label: "switchboard / 利用者", child: false, cells: ["62", "55", "2", "41", "2.1 日", "3", "1", "2"] });
    expect(rows[1]).toMatchObject({ label: "└ 動向からの案", child: true });
  });

  test("unknown days show a dash, never 0", () => {
    expect(sourceTableRows(view([row({ opened: 3, delivered: 0, daysToDeliver: null })]))[0]!.cells[4]).toBe("-");
    expect(sourceTableRows(view([row({ delivered: 1, daysToDeliver: 0 })]))[0]!.cells[4]).toBe("0.0 日");
  });

  test("a derived row counts only what happened", () => {
    const [r] = sourceTableRows(view([row({ speaker: "派生", opened: 9 })]));
    expect(r!.cells).toEqual(["9", "-", "-", "-", "-", "-", "-", "-"]);
  });

  test("the heads carry the day counts the daemon used", () => {
    const heads = sourceHeaders(view([]));
    expect(heads).toHaveLength(9);
    expect(heads[6]).toBe("手つかず（14 日超）");
    expect(heads[8]).toBe("後追いの bug（7 日以内）");
  });
});
