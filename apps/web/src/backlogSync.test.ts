import { describe, expect, test } from "bun:test";
import type { BacklogIssueDetail, BacklogSyncInfo } from "@switchboard/protocol";
import { backlogHeading, createWord, draftKey, heldIssueText, editOf, formAfterRead, formOf, githubSyncText, labelList, loadDraft, loadNewIssueDraft, PROJECT_SETUP_DOC, rebaseForm, syncLine, valueText, workspaceErrorGuide } from "./backlogSync.ts";

const fmt = (ms: number) => `t${ms}`;
const info = (over: Partial<BacklogSyncInfo>): BacklogSyncInfo => ({ state: "synced", reason: null, lastSuccessfulSync: 1000, retryAt: null, pendingCount: 0, conflicts: [], guarantee: "A", ...over });
const detail = (over: Partial<BacklogIssueDetail["issue"]> = {}, fields: BacklogIssueDetail["fields"] = { Status: "Ready", "Story Points": 3, Priority: null }): Pick<BacklogIssueDetail, "issue" | "fields"> => ({
  issue: { number: 7, title: "題", url: "u", state: "OPEN", stateReason: null, body: "本文", labels: ["type:pbi", "P1"], milestone: null, parent: null, subIssues: [], createdAt: "", updatedAt: "", ...over },
  fields,
});

describe("syncLine", () => {
  test("every state is worded with its last successful time", () => {
    expect(syncLine(info({}), fmt)).toEqual({ state: "synced", label: "同期済み", parts: ["最終成功: t1000"] });
    expect(syncLine(info({ state: "pending", pendingCount: 2, retryAt: 5000 }), fmt)).toMatchObject({ label: "送信待ち", parts: ["最終成功: t1000", "未送信 2 件", "t5000 まで待機"] });
    expect(syncLine(info({ state: "conflict", pendingCount: 1, conflicts: [{ field: "body", base: "", local: "", remote: "", remoteRead: true, revision: "r" }] }), fmt).parts).toContain("競合 1 件");
  });
  test("an error says why; never read says so", () => {
    const l = syncLine(info({ state: "error", reason: "import", lastSuccessfulSync: null }), fmt);
    expect(l.label).toBe("同期失敗");
    expect(l.parts[0]).toBe("最終成功: なし（未取得）");
    expect(l.parts.join()).toContain("照合に失敗");
    expect(syncLine(info({ state: "pending", reason: "unknown" }), fmt).parts.join()).toContain("送り直す前に探します");
  });
});

describe("editOf", () => {
  test("an untouched form is no edit", () => {
    expect(editOf(detail(), formOf(detail()))).toEqual({ edit: null, error: null });
  });
  test("only what changed is sent: text, label diff, state, milestone, parent, Project fields keep their type", () => {
    const d = detail();
    const f = { ...formOf(d), title: "新しい題", labels: "type:pbi, P2", state: "CLOSED" as const, milestone: "Phase 3", parent: "12", fields: { ...formOf(d).fields, "Story Points": "5", Priority: "P1", Status: "" } };
    expect(editOf(d, f).edit).toEqual({
      title: "新しい題",
      labels: { add: ["P2"], remove: ["P1"] },
      state: "CLOSED",
      milestone: "Phase 3",
      parent: 12,
      fields: { "Story Points": 5, Priority: "P1", Status: null },
    });
  });
  test("a parent that is not a number is refused before anything is sent; an emptied milestone / parent is null", () => {
    expect(editOf(detail(), { ...formOf(detail()), parent: "abc" })).toEqual({ edit: null, error: "親 Issue は番号で入力してください" });
    const d = detail({ milestone: "Phase 1", parent: 3 });
    expect(editOf(d, { ...formOf(d), milestone: "", parent: "" }).edit).toEqual({ milestone: null, parent: null });
  });
  test("an Issue not in the Project has no field to edit", () => {
    expect(formOf(detail({}, null)).fields).toEqual({});
  });
  test("the Project's own Title is not a field to edit (it is the Issue's title; GitHub refuses writing it)", () => {
    const d = detail({}, { Title: "題", Status: "Ready" });
    expect(formOf(d).fields).toEqual({ Status: "Ready" });
    expect(editOf(d, { ...formOf(d), title: "新しい題" }).edit).toEqual({ title: "新しい題" });
  });
});

describe("drafts and values", () => {
  test("a draft comes back as saved with the read it was typed over, and a broken one is ignored", () => {
    const d = detail();
    const kept = { form: formOf(d), base: d };
    const store = { getItem: (k: string) => (k === draftKey("ws", 7) ? JSON.stringify(kept) : k === "bad" ? "{" : k === "formOnly" ? JSON.stringify(formOf(d)) : null) };
    expect(loadDraft(store, draftKey("ws", 7))).toEqual(kept);
    expect(loadDraft(store, "bad")).toBeNull();
    expect(loadDraft(store, "formOnly")).toBeNull();
    expect(loadDraft(store, "none")).toBeNull();
  });
  test("a new Issue's draft keeps the kind chosen; one without a kind is a request", () => {
    const store = { getItem: (k: string) => ({ pbi: JSON.stringify({ title: "t", body: "b", kind: "type:pbi" }), old: JSON.stringify({ title: "t", body: "b" }), bad: "{" })[k] ?? null };
    expect(loadNewIssueDraft(store, "pbi")).toEqual({ title: "t", body: "b", kind: "type:pbi" });
    expect(loadNewIssueDraft(store, "old")).toEqual({ title: "t", body: "b", kind: "type:request" });
    expect(loadNewIssueDraft(store, "bad")).toBeNull();
  });
  test("labels are split, trimmed and deduplicated; values are shown as text, an unread one says so", () => {
    expect(labelList(" a, b ,a,, c")).toEqual(["a", "b", "c"]);
    expect(valueText("x")).toBe("x");
    expect(valueText(null)).toBe("（なし）");
    expect(valueText(3)).toBe("3");
    expect(valueText("x", false)).toBe("（読めていません）");
  });
});

describe("rebaseForm", () => {
  test("a field the person changed stays; the rest follows the new read, so a chosen remote value is not sent back", () => {
    const before = detail({ body: "A" });
    const after = detail({ body: "B" });
    const typed = { ...formOf(before), title: "新しい題" };
    const next = rebaseForm(before, typed, after);
    expect(next.title).toBe("新しい題");
    expect(next.body).toBe("B");
    // saving it now sends the title only
    expect(editOf(after, next).edit).toEqual({ title: "新しい題" });
  });
  test("Project fields rebase one by one", () => {
    const before = detail({}, { Status: "Ready", Priority: "P1" });
    const after = detail({}, { Status: "Done", Priority: "P1" });
    const typed = { ...formOf(before), fields: { Status: "Ready", Priority: "P0" } };
    expect(rebaseForm(before, typed, after).fields).toEqual({ Status: "Done", Priority: "P0" });
  });
});

describe("formAfterRead", () => {
  test("a conflict resolved to GitHub's value does not come back from the kept draft on a reopen or a reload", () => {
    const a = detail({ body: "A" });
    // the person edits the title over body A: the draft is kept with its base
    const typed = { ...formOf(a), title: "新しい題" };
    const kept = { form: typed, base: a };
    // GitHub's body B is chosen; the read after it rebases the form on screen and the kept draft alike
    const b = detail({ body: "B" });
    const r = formAfterRead({ form: typed, base: a }, kept, b);
    expect(r.form).toMatchObject({ title: "新しい題", body: "B" });
    expect(r.keep).toEqual({ form: r.form, base: b });
    // reopened (no form on screen): the kept draft, rebased on the read now, sends the title only
    const reopened = formAfterRead(null, r.keep, b);
    expect(editOf(b, reopened.form).edit).toEqual({ title: "新しい題" });
    // a draft kept before the choice (an old base) is rebased too: body A does not go back out
    expect(editOf(b, formAfterRead(null, kept, b).form).edit).toEqual({ title: "新しい題" });
  });
  test("no draft: the Issue as read, nothing to keep", () => {
    expect(formAfterRead(null, null, detail())).toEqual({ form: formOf(detail()), keep: null });
  });
});

test("a creation says what became of it", () => {
  expect(createWord("pending")).toBe("作成は送信待ち");
  expect(createWord("error")).toContain("作成できていません");
});

test("heldIssueText: number, title, the counts that are not zero, Closed", () => {
  const held = (over: Partial<Parameters<typeof heldIssueText>[0]>) => ({ number: 354, title: "題", url: "u", closed: false, state: "pending" as const, pendingCount: 0, conflictCount: 0, ...over });
  // a conflict is one of the operations not sent: 未送信 counts the others
  expect(heldIssueText(held({ state: "conflict", pendingCount: 1, conflictCount: 1, closed: true }))).toBe("#354 題（競合 1 件 · Closed）");
  expect(heldIssueText(held({ state: "conflict", pendingCount: 3, conflictCount: 1 }))).toBe("#354 題（競合 1 件 · 未送信 2 件）");
  expect(heldIssueText(held({ pendingCount: 2 }))).toBe("#354 題（未送信 2 件）");
  expect(heldIssueText(held({ state: "error", pendingCount: 1, closed: true }))).toBe("#354 題（同期失敗 · 未送信 1 件 · Closed）");
});

describe("workspaceErrorGuide (#2362)", () => {
  const err = (kind: "gh-login" | "project-var" | "other") => ({ workspaceId: "w", workspaceName: "app", message: "gh variable get: variable SWITCHBOARD_PROJECT_URL was not found", kind });
  test("gh-login: log in with gh, then 再読込", () => {
    const g = workspaceErrorGuide(err("gh-login"), undefined);
    expect(g.lead).toBe("app を読むには gh のログインが要ります");
    expect(g.steps.map((s) => s.text)).toEqual(["ターミナルで gh auth login を実行する", "終わったら「再読込」を押す"]);
  });
  test("project-var: the two ways, the variable's name, and the setup document", () => {
    const g = workspaceErrorGuide(err("project-var"), undefined);
    expect(g.lead).toContain("リポジトリ変数 SWITCHBOARD_PROJECT_URL にありません");
    expect(g.steps).toHaveLength(2);
    expect(g.steps[0]).toMatchObject({ text: expect.stringMatching(/^Project を用意する/), link: PROJECT_SETUP_DOC });
    expect(g.steps[1]!.text).toStartWith("GitHub と連携しないで使う: 設定の「Workspace」で「ホストのパス」");
    expect(g.steps[1]!.link).toBeUndefined();
    expect(workspaceErrorGuide(err("project-var"), "CAPSULE_PROJECT_URL").lead).toContain("リポジトリ変数 CAPSULE_PROJECT_URL にありません");
    // no Issue number of this repository on the screen (the public copy cannot follow it)
    expect(JSON.stringify(g)).not.toMatch(/#\d/);
  });
  test("other: the reason as it is, no steps", () => {
    expect(workspaceErrorGuide(err("other"), undefined)).toEqual({ lead: "app を読めませんでした: gh variable get: variable SWITCHBOARD_PROJECT_URL was not found", steps: [] });
  });
});

describe("backlogHeading (#2362)", () => {
  test("GitHub in view (or not known yet): the import's time", () => {
    expect(backlogHeading(1000, false, true, fmt)).toBe("t1000 に GitHub から取得");
    expect(backlogHeading(1000, true, null, fmt)).toBe("t1000 に GitHub から取得 · 読み込み中…");
  });
  test("only workspaces kept here: not \"from GitHub\"", () => {
    expect(backlogHeading(1000, false, false, fmt)).toBe("Switchboard に保存（GitHub と連携しない）");
    expect(backlogHeading(1000, true, false, fmt)).toBe("Switchboard に保存（GitHub と連携しない） · 読み込み中…");
  });
  test("nothing read yet", () => {
    expect(backlogHeading(null, true, true, fmt)).toBe("読み込み中…");
    expect(backlogHeading(null, false, false, fmt)).toBe("");
  });
});

test("githubSyncText says off, moving and on (#2266)", () => {
  const row = (over: object) => ({ backlog: "github" as const, enabling: null, sync: info({}), ...over });
  expect(githubSyncText(row({ backlog: "switchboard" }), fmt)).toEqual({ state: "synced", label: "GitHub 同期: 無効", parts: [] });
  expect(githubSyncText(row({ backlog: "switchboard", sync: info({ state: "pending", pendingCount: 2 }) }), fmt).parts).toEqual(["未送信 2 件（有効にすると送ります）"]);
  expect(githubSyncText(row({ enabling: { total: 3, done: 1 } }), fmt)).toEqual({ state: "pending", label: "GitHub に移しています", parts: ["1 / 3"] });
  expect(githubSyncText(row({ enabling: { total: 3, done: 3 }, sync: info({ state: "conflict", pendingCount: 1, conflicts: [{ operation: "o", field: "body", reason: null }] as never }) }), fmt)).toEqual({ state: "conflict", label: "GitHub に移しています", parts: ["3 / 3", "競合 1 件"] });
  expect(githubSyncText(row({ enabling: { total: 3, done: 2 }, sync: info({ state: "error", reason: "failed" }) }), fmt).parts).toEqual(["2 / 3", "GitHub が編集を受け付けませんでした"]);
  expect(githubSyncText(row({ sync: info({ state: "conflict", pendingCount: 1, conflicts: [{ operation: "o", field: "title", reason: null }] as never }) }), fmt)).toEqual({ state: "conflict", label: "競合", parts: ["最終成功: t1000", "未送信 1 件", "競合 1 件"] });
});
