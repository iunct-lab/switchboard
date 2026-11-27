import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CliRollbackResult, CliUpdateRow, CliUpdateRunnerState } from "@switchboard/protocol";
import { CliRunnerRow, CliUpdateRecords, currentSince, rollbackNotice, shaHead } from "./components/CliUpdateSettings.tsx";

const row = (o: Partial<CliUpdateRow>): CliUpdateRow => ({ id: 1, runner: "claude", at: Date.UTC(2026, 10, 19, 11, 10), fromVersion: null, toVersion: "2.1.328", outcome: "installed", sha256: null, reason: "", by: "auto", ...o });
const state = (o: Partial<CliUpdateRunnerState>): CliUpdateRunnerState => ({ runner: "claude", current: "2.1.328", previous: "2.1.327", previousGone: false, waiting: null, rollbackWaiting: false, checkedAt: null, note: null, ...o });

test("a record row shows when, runner, the move of versions, the result, the sha256 head and the reason, one block per row", () => {
  const sha = "307f8badaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaeb521";
  const h = renderToStaticMarkup(createElement(CliUpdateRecords, { records: [
    row({ id: 2, fromVersion: "2.1.327", sha256: sha, reason: "署名 ok・--version ok" }),
    row({ id: 1, runner: "codex", toVersion: "0.171.0", outcome: "refused", reason: "checksum が配布元と合わない" }),
  ] }));
  expect(h).toContain("2.1.327 → 2.1.328");
  expect(h).toContain("入れた");
  expect(h).toContain(">307f8bad</code>");
  expect(h).toContain(`title="${sha}"`);
  expect(h).toContain("署名 ok・--version ok");
  // the refused one: no move, no checksum ("—"), its reason as the reason
  expect(h).toContain("入れなかった");
  expect(h).toMatch(/data-outcome="refused"[\s\S]*codex[\s\S]*0\.171\.0[\s\S]*—[\s\S]*checksum が配布元と合わない/);
  expect(h.match(/class="cli-record"/g)).toHaveLength(2);
  expect(shaHead(null)).toBe("—");
});

test("a rollback by a person says so in its reason; no record says nothing recorded", () => {
  expect(renderToStaticMarkup(createElement(CliUpdateRecords, { records: [row({ outcome: "rolled-back", by: "person", reason: "2.1.328 から" })] }))).toContain("画面から。2.1.328 から");
  expect(renderToStaticMarkup(createElement(CliUpdateRecords, { records: [] }))).toContain("まだ記録はありません");
});

test("the runner's line names the current and the previous version on the button; with nothing to go back to there is no button", () => {
  const h = renderToStaticMarkup(createElement(CliRunnerRow, { state: state({}), since: Date.UTC(2026, 10, 19, 11, 10), busy: false, onRollback: () => undefined }));
  expect(h).toContain("2.1.328");
  expect(h).toContain("2.1.327 に戻す</button>");
  expect(h).toContain("に入れた");
  expect(h).not.toContain("ファイルが無いので戻せません");
  const none = renderToStaticMarkup(createElement(CliRunnerRow, { state: state({ previous: null }), since: null, busy: false, onRollback: () => undefined }));
  expect(none).not.toContain("<button");
  expect(none).toContain("ここで確かめて入れた版だけに戻せます");
  // the previous version is recorded but its files are gone: the reason is shown and there is nothing to press
  const gone = renderToStaticMarkup(createElement(CliRunnerRow, { state: state({ previousGone: true }), since: null, busy: false, onRollback: () => undefined }));
  expect(gone).not.toContain("<button");
  expect(gone).toContain("前の版 2.1.327 のファイルが無いので戻せません");
  // a rollback already waiting for the Tasks cannot be asked twice
  const waiting = renderToStaticMarkup(createElement(CliRunnerRow, { state: state({ rollbackWaiting: true }), since: null, busy: false, onRollback: () => undefined }));
  expect(waiting).toContain("disabled");
  expect(waiting).toContain("空いたら戻す");
});

test("since is the newest row that put the current version in; the installer's own version has none", () => {
  const records = [row({ id: 3, at: 30, outcome: "refused", toVersion: "2.1.329" }), row({ id: 2, at: 20 }), row({ id: 1, at: 10, toVersion: "2.1.327" })];
  expect(currentSince(records, "claude", "2.1.328")).toBe(20);
  expect(currentSince(records, "claude", "2.1.100")).toBeNull();
  expect(currentSince(records, "codex", "2.1.328")).toBeNull();
});

test("a rollback answer is worded as done, as waiting with the target as an estimate, or as refused with its reason", () => {
  const r = (o: Partial<CliRollbackResult>): CliRollbackResult => ({ ok: true, waiting: false, to: "2.1.327", reason: "", ...o });
  expect(rollbackNotice("claude", r({}))).toBe("claude を 2.1.327 に戻しました");
  expect(rollbackNotice("claude", r({ waiting: true }))).toContain("今の戻し先の見込み: 2.1.327");
  expect(rollbackNotice("claude", r({ ok: false, to: null, reason: "戻す先の版が記録に無い" }))).toContain("戻す先の版が記録に無い");
});
