import type { Backlog, BacklogEditInput, BacklogIssueDetail, BacklogSyncInfo, BacklogSyncReason, BacklogSyncState } from "@switchboard/protocol";
import { jstDateTime, jstTime } from "./time.ts";

/** What the list says a send promises (BacklogSyncInfo.guarantee "A"), and what it does not. */
export const GUARANTEE_A =
  "送る直前と直後に GitHub の値を読み、編集の元から変わっていれば上書きせずに競合として保留します。見つけられないもの: Status 以外の Project フィールド、同じアカウントで GitHub の画面から書いた編集、押し出された古い版。";

const STATE_LABEL: Record<BacklogSyncState, string> = { synced: "同期済み", pending: "送信待ち", conflict: "競合", error: "同期失敗" };
const REASON_LABEL: Record<BacklogSyncReason, string> = {
  failed: "GitHub が編集を受け付けませんでした",
  unknown: "送信の結果が分からない（送り直す前に探します）",
  unavailable: "GitHub がこの Issue を返しません（404）",
  forbidden: "この Issue を読む権限がありません（403）",
  unfetched: "まだ読んでいません",
  import: "GitHub との照合に失敗しているか、待っています",
};

/** Where the public copy says how to set up a Project and its repository variable (#2362; the owner reads it, not this repository's own). */
export const PROJECT_SETUP_DOC = "https://github.com/iunct-lab/switchboard/blob/main/ops-kit/README.md#fork-して開発を始める";

/**
 * What a workspace that could not be read asks of the owner (#2362), by the error's kind: a lead line and the steps.
 * `other` says the reason as it is. The kind is the daemon's (where gh was called); gh's wording is not read here.
 */
export function workspaceErrorGuide(e: Backlog["errors"][number], projectVar: string | undefined): { lead: string; steps: Array<{ text: string; link?: string }> } {
  if (e.kind === "gh-login")
    return { lead: `${e.workspaceName} を読むには gh のログインが要ります`, steps: [{ text: "ターミナルで gh auth login を実行する" }, { text: "終わったら「再読込」を押す" }] };
  if (e.kind === "project-var")
    return {
      lead: `${e.workspaceName} の Project の URL がリポジトリ変数 ${projectVar ?? "SWITCHBOARD_PROJECT_URL"} にありません。次のどちらかで始められます`,
      steps: [
        { text: "Project を用意する: 手順に従って Project を作り、変数に URL を設定してから「再読込」を押す", link: PROJECT_SETUP_DOC },
        { text: "GitHub と連携しないで使う: 設定の「Workspace」で「ホストのパス」を選び「GitHub と連携しない」に印を付けて自分のリポジトリを追加するか、設定の「GitHub 同期」でこの workspace の同期を無効にする" },
      ],
    };
  return { lead: `${e.workspaceName} を読めませんでした: ${e.message}`, steps: [] };
}

/**
 * The backlog's heading (#2362): when it was imported from GitHub, or — with only workspaces kept here in view — that
 * it is stored here. `github` = a workspace in view syncs with GitHub; null = the workspaces have not arrived yet.
 */
export function backlogHeading(fetchedAt: number | null, busy: boolean, github: boolean | null, fmt: (ms: number) => string = jstTime): string {
  if (fetchedAt === null) return busy ? "読み込み中…" : "";
  return `${github === false ? "Switchboard に保存（GitHub と連携しない）" : `${fmt(fetchedAt)} に GitHub から取得`}${busy ? " · 読み込み中…" : ""}`;
}

/**
 * A workspace's GitHub sync (#2266), for the settings and the backlog's sync line: off (with what waits to go when it is
 * on), being turned on (how many of the Issues made here GitHub has made), or on — then the line of `syncLine`.
 */
export function githubSyncText(s: Pick<Backlog["syncs"][number], "backlog" | "enabling" | "sync">, fmt: (ms: number) => string = jstDateTime): { state: BacklogSyncState; label: string; parts: string[] } {
  // a conflict or a refusal on the way is said with the progress: the turning on waits for it
  if (s.enabling) {
    const held = [s.sync.conflicts.length > 0 ? `競合 ${s.sync.conflicts.length} 件` : "", s.sync.reason ? REASON_LABEL[s.sync.reason] : ""].filter(Boolean);
    return { state: s.sync.state === "conflict" || s.sync.state === "error" ? s.sync.state : "pending", label: "GitHub に移しています", parts: [`${s.enabling.done} / ${s.enabling.total}`, ...held] };
  }
  if (s.backlog === "switchboard") return { state: "synced", label: "GitHub 同期: 無効", parts: s.sync.pendingCount > 0 ? [`未送信 ${s.sync.pendingCount} 件（有効にすると送ります）`] : [] };
  return syncLine(s.sync, fmt);
}

/** One line's parts for a row or workspace: the state's word, when it was last read, what it waits for and why. */
export function syncLine(s: BacklogSyncInfo, fmt: (ms: number) => string = jstDateTime): { state: BacklogSyncState; label: string; parts: string[] } {
  const parts: string[] = [s.lastSuccessfulSync === null ? "最終成功: なし（未取得）" : `最終成功: ${fmt(s.lastSuccessfulSync)}`];
  if (s.pendingCount > 0) parts.push(`未送信 ${s.pendingCount} 件`);
  if (s.conflicts.length > 0) parts.push(`競合 ${s.conflicts.length} 件`);
  if (s.reason) parts.push(REASON_LABEL[s.reason]);
  if (s.retryAt !== null) parts.push(`${fmt(s.retryAt)} まで待機`);
  return { state: s.state, label: STATE_LABEL[s.state], parts };
}

/**
 * An Issue on the sync line that holds operations not sent (#1872), Closed ones too: `#354 題（競合 1 件 · 未送信 2 件 · Closed）`.
 * A conflict is one of the operations not sent, so 未送信 counts the others; a count of 0 and Open are not said.
 */
export function heldIssueText(i: Backlog["syncs"][number]["issues"][number]): string {
  const parts = [
    i.state === "error" ? STATE_LABEL.error : "",
    i.conflictCount > 0 ? `競合 ${i.conflictCount} 件` : "",
    i.pendingCount > i.conflictCount ? `未送信 ${i.pendingCount - i.conflictCount} 件` : "",
    i.closed ? "Closed" : "",
  ].filter(Boolean);
  return `#${i.number} ${i.title}${parts.length ? `（${parts.join(" · ")}）` : ""}`;
}

/** The values of the edit form, all strings as typed; `labels` is comma-separated. */
export interface EditForm {
  title: string;
  body: string;
  labels: string;
  state: "OPEN" | "CLOSED";
  milestone: string;
  parent: string;
  fields: Record<string, string>;
}

export const labelList = (s: string) => [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))];

/** The form as it opens: the Issue as the daemon shows it (its stored edits on top of GitHub's). */
export function formOf(d: Pick<BacklogIssueDetail, "issue" | "fields">): EditForm {
  return {
    title: d.issue.title,
    body: d.issue.body,
    labels: d.issue.labels.join(", "),
    state: d.issue.state,
    milestone: d.issue.milestone ?? "",
    parent: d.issue.parent === null ? "" : String(d.issue.parent),
    // the Project's own Title is the Issue's title as GitHub shows it in the Project: edited as 題, not as a field
    fields: Object.fromEntries(Object.entries(d.fields ?? {}).filter(([k]) => k !== "Title").map(([k, v]) => [k, v === null ? "" : String(v)])),
  };
}

/**
 * The PATCH that makes the Issue what the form says: only what changed (a field left alone follows GitHub), null when
 * nothing did. A Project field typed as a number stays a number when it was one; an emptied one is null. A parent that
 * is not a number is `error`, nothing is sent.
 */
export function editOf(d: Pick<BacklogIssueDetail, "issue" | "fields">, f: EditForm): { edit: Omit<BacklogEditInput, "workspaceId"> | null; error: string | null } {
  const was = formOf(d);
  const edit: Omit<BacklogEditInput, "workspaceId"> = {};
  if (f.title.trim() !== was.title.trim()) edit.title = f.title;
  if (f.body !== was.body) edit.body = f.body;
  const now = new Set(labelList(f.labels));
  const before = new Set(d.issue.labels);
  const add = [...now].filter((l) => !before.has(l));
  const remove = [...before].filter((l) => !now.has(l));
  if (add.length || remove.length) edit.labels = { add, remove };
  if (f.state !== was.state) edit.state = f.state;
  if (f.milestone.trim() !== was.milestone) edit.milestone = f.milestone.trim() || null;
  if (f.parent.trim() !== was.parent) {
    const n = Number(f.parent.trim());
    if (f.parent.trim() && !(Number.isInteger(n) && n > 0)) return { edit: null, error: "親 Issue は番号で入力してください" };
    edit.parent = f.parent.trim() ? n : null;
  }
  const fields: Record<string, string | number | null> = {};
  for (const [k, v] of Object.entries(f.fields)) {
    if (v === (was.fields[k] ?? "")) continue;
    const text = v.trim();
    fields[k] = text === "" ? null : typeof d.fields?.[k] === "number" && Number.isFinite(Number(text)) ? Number(text) : text;
  }
  if (Object.keys(fields).length) edit.fields = fields;
  return { edit: Object.keys(edit).length ? edit : null, error: null };
}

/** A value of a held edit as text: a string as is, else JSON; GitHub's not read is said so. */
export const valueText = (v: unknown, read = true) => (!read ? "（読めていません）" : typeof v === "string" ? v : v === null || v === undefined ? "（なし）" : JSON.stringify(v));

/** What the person typed and has not saved, kept per Issue so that a refused or unreachable save and a reload lose nothing. */
export const draftKey = (workspaceId: string, number: number | string) => `switchboard.backlog.draft.${workspaceId}:${number}`;

/** A kept draft: the form as typed and the read it was typed over (`base`), so a later read rebases it (rebaseForm). */
export interface EditDraft {
  form: EditForm;
  base: Pick<BacklogIssueDetail, "issue" | "fields">;
}

export function loadDraft(store: Pick<Storage, "getItem">, key: string): EditDraft | null {
  try {
    const v = JSON.parse(store.getItem(key) ?? "null") as EditDraft | null;
    const f = v?.form;
    return f && typeof f.title === "string" && typeof f.body === "string" && typeof f.fields === "object" && v.base?.issue ? v : null;
  } catch {
    return null;
  }
}

/**
 * The form after a read `d`: the one on screen rebased from the read it was typed over, else a kept draft rebased from
 * its base (a reload), else the Issue as read. `keep` is the kept draft stored again over the new read (null = none was
 * kept), so a value given up meanwhile (a conflict's choice) does not come back from storage on a reopen or reload.
 */
export function formAfterRead(shown: { form: EditForm; base: Pick<BacklogIssueDetail, "issue" | "fields"> } | null, saved: EditDraft | null, d: Pick<BacklogIssueDetail, "issue" | "fields">): { form: EditForm; keep: EditDraft | null } {
  const from = shown ?? saved;
  if (!from) return { form: formOf(d), keep: null };
  const form = rebaseForm(from.base, from.form, d);
  return { form, keep: saved ? { form, base: { issue: d.issue, fields: d.fields } } : null };
}

/**
 * The form after the Issue was read again (a choice on a conflict, a save elsewhere): what the person changed since
 * the old read stays, everything they did not touch follows the new read — so a stale value never goes back out.
 */
export function rebaseForm(before: Pick<BacklogIssueDetail, "issue" | "fields">, form: EditForm, after: Pick<BacklogIssueDetail, "issue" | "fields">): EditForm {
  const was = formOf(before);
  const now = formOf(after);
  const pick = <K extends Exclude<keyof EditForm, "fields">>(k: K) => (form[k] !== was[k] ? form[k] : now[k]);
  const fields = { ...now.fields };
  for (const [k, v] of Object.entries(form.fields)) if (v !== (was.fields[k] ?? "")) fields[k] = v;
  return { title: pick("title"), body: pick("body"), labels: pick("labels"), state: pick("state"), milestone: pick("milestone"), parent: pick("parent"), fields };
}

/** A creation's word: what GitHub has (or has not) done with it, not always "waiting". */
export const createWord = (state: BacklogSyncState) =>
  ({ synced: "作成済み", pending: "作成は送信待ち", conflict: "作成が競合", error: "作成できていません（GitHub が受け付けない・保留中）" })[state];

/** One free-text draft (a comment, a new Issue) kept across a failed save and a reload. */
export const textDraftKey = (scope: string) => `switchboard.backlog.text.${scope}`;

/** A new Issue's draft (#910): what is typed and the kind chosen, kept per workspace. */
export interface NewIssueDraft {
  title: string;
  body: string;
  kind: "type:request" | "type:pbi";
}

export function loadNewIssueDraft(store: Pick<Storage, "getItem">, key: string): NewIssueDraft | null {
  try {
    const v = JSON.parse(store.getItem(key) ?? "null") as Partial<NewIssueDraft> | null;
    if (!v || typeof v.title !== "string" || typeof v.body !== "string") return null;
    return { title: v.title, body: v.body, kind: v.kind === "type:pbi" ? "type:pbi" : "type:request" };
  } catch {
    return null;
  }
}
