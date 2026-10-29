import { Fragment, useEffect, useRef, useState } from "react";
import type { Artifact, Backlog as BacklogData, BacklogAction, BacklogIssueDetail, BacklogItem, BacklogStage, BacklogSyncInfo, Task, Workspace } from "@switchboard/protocol";
import type { FeedbackTarget } from "../feedbackTarget.ts";
import { api } from "../api.ts";
import { backlogHeading, createWord, draftKey, editOf, formAfterRead, GUARANTEE_A, githubSyncText, heldIssueText, loadDraft, loadNewIssueDraft, syncLine, textDraftKey, valueText, workspaceErrorGuide, type EditForm, type NewIssueDraft } from "../backlogSync.ts";
import { activeTaskLine, ago, autoByWorkspace, inProgressState, readyPending, startButton, lastTaskLine, overlapLine, prereqLine, waitChain, waitOwner, waitRef, waitText, waitUrl, type PrereqPart } from "../inProgress.ts";
import { promotionLine } from "../release.ts";
import { Flow } from "./Flow.tsx";
import { Interventions } from "./Interventions.tsx";
import { Mockups } from "./Approvals.tsx";
import { Stops } from "./Stops.tsx";
import { jstDateTime } from "../time.ts";
import { applyView, DEFAULT_VIEW, loadView, PRIORITIES, saveView, SORTS, STAGES, TYPES, viewSummary, type BacklogView } from "../backlogView.ts";

/** The first lines of a ## 状況 comment shown under its row; the rest is on the Issue. */
const REPORT_LINES = 3;

/** The workspace the list is narrowed to ("" = every workspace), kept across visits. */
const SHOWN_KEY = "switchboard.backlog.workspace";

/** #441: the list last read, kept while the tab is away so that opening it shows this at once; a page reload forgets it. */
let lastBacklog: BacklogData | null = null;

/**
 * A workspace whose backlog could not be read, with the repository variable its Project URL is under (each repository
 * names its own; unset = SWITCHBOARD_PROJECT_URL). Saving reads that workspace again.
 */
function WorkspaceError(props: { error: BacklogData["errors"][number]; loaded: boolean; projectVar: string | undefined; onSaved: () => void; onError: (msg: string) => void }) {
  const [name, setName] = useState(props.projectVar ?? "");
  const [edited, setEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  // the workspaces may arrive after the error: show the saved name then, unless the person has typed meanwhile
  useEffect(() => {
    if (!edited) setName(props.projectVar ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectVar]);
  const save = () => {
    setSaving(true);
    api
      .setWorkspaceProjectVar(props.error.workspaceId, name.trim() || null)
      .then(() => {
        setEdited(false);
        props.onSaved();
      })
      .catch((e) => props.onError(`${props.error.workspaceName} の設定を保存できませんでした: ${String(e.message ?? e)}`))
      .finally(() => setSaving(false));
  };
  const guide = workspaceErrorGuide(props.error, props.projectVar);
  return (
    <div className="muted backlog-error" data-kind={props.error.kind}>
      <span className="backlog-error-msg">{guide.lead}</span>
      {guide.steps.length > 0 && (
        <ol className="backlog-error-steps">
          {guide.steps.map((s) => (
            <li key={s.text}>
              {s.text}
              {s.link && (
                <>
                  {" "}
                  <a href={s.link} target="_blank" rel="noreferrer">
                    手順 →
                  </a>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {props.error.kind !== "other" && <span className="hint backlog-error-detail">詳細: {props.error.message}</span>}
      {props.error.kind !== "gh-login" && (
        <div className="row">
          <label className="hint" htmlFor={`pv-${props.error.workspaceId}`}>
            Project の URL を持つリポジトリ変数
          </label>
          <input
            id={`pv-${props.error.workspaceId}`}
            value={name}
            placeholder="SWITCHBOARD_PROJECT_URL"
            onChange={(e) => {
              setEdited(true);
              setName(e.target.value);
            }}
          />
          <button className="ghost" disabled={!props.loaded || saving || name.trim() === (props.projectVar ?? "")} onClick={save}>
            保存
          </button>
        </div>
      )}
    </div>
  );
}


/** A row's or a workspace's sync state (#908): the word, when it was last read in full, what waits and why; the promise on hover. */
function SyncLine(props: { sync: BacklogSyncInfo; scope?: string; line?: ReturnType<typeof syncLine> }) {
  const l = props.line ?? syncLine(props.sync);
  return (
    <span className="m sync" data-sync={l.state} title={GUARANTEE_A}>
      {props.scope && `${props.scope} `}
      {[l.label, ...l.parts].join(" · ")}
    </span>
  );
}

/**
 * An Issue's edit form under its row (#910): the values as the daemon shows them (stored edits over GitHub's), saved
 * here at once and sent later — the two are told apart. What was typed is kept while the save fails (and across a reload,
 * localStorage) until it is saved; a held conflict shows both sides and takes an explicit choice.
 */
function Editor(props: { target: EditTarget; onChanged: () => void; onError: (msg: string) => void }) {
  const item = props.target;
  const [detail, setDetail] = useState<BacklogIssueDetail | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);
  const key = draftKey(item.workspaceId, item.number);
  const commentKey = textDraftKey(`${item.workspaceId}:${item.number}:comment`);
  const [comment, setComment] = useState(() => localStorage.getItem(commentKey) ?? "");
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const last = useRef<BacklogIssueDetail | null>(null);
  const read = () =>
    api
      .backlogIssue(item.workspaceId, item.number)
      .then((d) => {
        const before = last.current;
        last.current = d;
        setReadFailed(false);
        setDetail(d);
        // what was typed and not saved comes back, over the Issue as read now; an untouched field follows the new read,
        // in the kept draft too
        setForm((f) => {
          const { form: next, keep } = formAfterRead(f && before ? { form: f, base: before } : null, loadDraft(localStorage, key), d);
          if (keep) localStorage.setItem(key, JSON.stringify(keep));
          return next;
        });
      })
      .catch((e) => (setReadFailed(true), props.onError(`#${item.number} を読めませんでした: ${String(e.message ?? e)}`)));
  useEffect(() => {
    void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const change = (patch: Partial<EditForm>) =>
    setForm((f) => {
      const next = { ...f!, ...patch };
      if (last.current) localStorage.setItem(key, JSON.stringify({ form: next, base: { issue: last.current.issue, fields: last.current.fields } }));
      return next;
    });
  const save = () => {
    if (!detail || !form) return;
    const { edit, error } = editOf(detail, form);
    if (error) return setNote(error);
    if (!edit) return setNote("変更がありません");
    setSaving(true);
    api
      .editBacklog(item.workspaceId, item.number, edit)
      .then(async () => {
        // only the draft that was saved: one typed since (in an editor opened again while this save was under way) stays
        if (JSON.stringify(loadDraft(localStorage, key)?.form) === JSON.stringify(form)) localStorage.removeItem(key);
        setNote("手元に保存しました。GitHub への反映は送信待ちです（下の同期の表示で確かめてください）");
        // the form stays while it is read again (a failed read leaves it, not an empty editor)
        await read();
        props.onChanged();
      })
      // refused (409) or unreachable: the form keeps what was typed and is rebased on the Issue read again, so a retry
      // sends what changed against the newest value
      .catch((e) => {
        setNote(`保存できませんでした（入力は残しています）: ${String(e.message ?? e)}`);
        void read();
      })
      .finally(() => setSaving(false));
  };
  const send = (text: string) => {
    setSaving(true);
    api
      .commentBacklog(item.workspaceId, item.number, text)
      .then(async () => {
        setComment("");
        localStorage.removeItem(commentKey);
        setNote("コメントを手元に保存しました。GitHub への反映は送信待ちです");
        await read();
        props.onChanged();
      })
      .catch((e) => setNote(`コメントを保存できませんでした（入力は残しています）: ${String(e.message ?? e)}`))
      .finally(() => setSaving(false));
  };
  // one choice at a time: a second click would carry the same revision and be told to choose again
  const resolve = (field: string, choice: "local" | "remote", expectedRevision: string) => {
    setSaving(true);
    return api
      .editBacklog(item.workspaceId, item.number, { resolve: { field, choice, expectedRevision } })
      .then(async () => {
        setNote(choice === "local" ? "手元の値を送ります" : "GitHub の値を使います");
        await read();
        props.onChanged();
      })
      .catch(async (e) => {
        // an old choice (409): GitHub or the edit moved since it was read — read again, choose again
        setNote(e.status === 409 ? "競合の状態が変わっています。最新の値を読み直しました。選び直してください" : `選べませんでした: ${String(e.message ?? e)}`);
        await read();
      })
      .finally(() => setSaving(false));
  };
  if (!detail || !form)
    return readFailed ? (
      <div className="hint">
        読めませんでした{" "}
        <button className="ghost link" onClick={() => void read()}>
          読み直す
        </button>
      </div>
    ) : (
      <div className="hint">読み込み中…</div>
    );
  const writable = detail.fetchState === "fetched";
  const set = (k: keyof EditForm) => (e: { target: { value: string } }) => change({ [k]: e.target.value } as Partial<EditForm>);
  return (
    <div className="backlog-edit" data-issue={item.url}>
      <SyncLine sync={detail.sync} />
      {/* the daemon's own words for what a send catches (the row's hover keeps the short form) */}
      <div className="hint">{detail.limits}</div>
      {detail.held.map((h) => (
        <div key={h.operation} className="backlog-held warn" data-field={h.field ?? ""}>
          <div>
            {h.field ?? "新規作成"}: {h.status === "conflict" ? "競合" : h.status === "failed" ? "GitHub が受け付けませんでした" : "送信の結果が分かりません"}
            {h.reason ? `（${h.reason}）` : ""}
          </div>
          {h.conflict && (
            <>
              <div className="backlog-sides">
                <div>
                  <div className="hint">手元（local）</div>
                  <pre className="wrap">{valueText(h.conflict.local)}</pre>
                </div>
                <div>
                  <div className="hint">GitHub 側</div>
                  <pre className="wrap">{valueText(h.conflict.remote, h.conflict.remoteRead)}</pre>
                </div>
              </div>
              <button className="ghost" disabled={saving || h.field === null} onClick={() => resolve(h.field!, "local", h.conflict!.revision)}>
                手元の値を送る
              </button>{" "}
              <button className="ghost" disabled={saving || h.field === null} onClick={() => resolve(h.field!, "remote", h.conflict!.revision)}>
                GitHub の値を使う
              </button>
            </>
          )}
        </div>
      ))}
      {!writable && <div className="muted">GitHub から読めていない（{detail.fetchState}）ので編集できません。再読込してください</div>}
      <label className="hint">題</label>
      <input value={form.title} disabled={!writable || saving} onChange={set("title")} />
      <label className="hint">本文</label>
      <textarea rows={6} value={form.body} disabled={!writable || saving} onChange={set("body")} />
      <div className="row">
        <label className="hint" title=", 区切り">ラベル</label>
        <input value={form.labels} disabled={!writable || saving} onChange={set("labels")} />
        <label className="hint">状態</label>
        <select value={form.state} disabled={!writable || saving} onChange={set("state")}>
          <option value="OPEN">開いている</option>
          <option value="CLOSED">閉じた</option>
        </select>
      </div>
      <div className="row">
        <label className="hint">Milestone</label>
        <input value={form.milestone} disabled={!writable || saving} onChange={set("milestone")} />
        <label className="hint">親 Issue</label>
        <input value={form.parent} disabled={!writable || saving} inputMode="numeric" onChange={set("parent")} />
      </div>
      {detail.fields === null ? (
        <div className="hint">Project に入っていないので Project のフィールドはありません</div>
      ) : (
        Object.keys(form.fields).map((k) => (
          <div className="row" key={k}>
            <label className="hint">{k}</label>
            <input value={form.fields[k]} disabled={!writable || saving} onChange={(e) => change({ fields: { ...form.fields, [k]: e.target.value } })} />
          </div>
        ))
      )}
      <button className="pri" disabled={saving || !writable} onClick={save}>
        保存
      </button>
      <label className="hint">コメント</label>
      <textarea rows={3} value={comment} disabled={saving} onChange={(e) => (localStorage.setItem(commentKey, e.target.value), setComment(e.target.value))} placeholder="コメント（手元に保存され、GitHub へは後で送られます）" />
      <button className="ghost" disabled={saving || !comment.trim()} onClick={() => send(comment)}>
        コメントを保存
      </button>
      {note && <div className="hint backlog-note">{note}</div>}
    </div>
  );
}

/** The Issue an edit form opens on: a row's, or one the sync line holds operations for (#1872, Closed ones too). */
type EditTarget = Pick<BacklogItem, "workspaceId" | "number" | "url">;

/**
 * The edit form opens on demand: nothing is read for a row until it is opened. `summary`: what it is opened by (else 編集);
 * `held`: one on the sync line, an Issue that may have no row.
 */
function EditToggle(props: { target: EditTarget; summary?: string; held?: boolean; onChanged: () => void; onError: (msg: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="backlog-editor" data-issue={props.target.url} data-held={props.held ? "" : undefined} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{props.summary ?? "編集"}</summary>
      {open && <Editor target={props.target} onChanged={props.onChanged} onError={props.onError} />}
    </details>
  );
}

/** One Issue made here, followed from its localId to the number GitHub gives it (and the row it then is). */
function Made(props: { workspaceId: string; localId: string; title: string }) {
  const [detail, setDetail] = useState<BacklogIssueDetail | null>(null);
  const read = () => api.backlogIssue(props.workspaceId, props.localId).then(setDetail).catch(() => undefined);
  useEffect(() => {
    void read();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const n = detail?.issue.number ?? 0;
  return (
    <div className="hint backlog-made" data-local={props.localId}>
      {n > 0 ? (
        <a href={detail!.issue.url} target="_blank" rel="noreferrer">
          #{n}
        </a>
      ) : (
        "番号なし"
      )}{" "}
      {props.title}（{detail ? (n > 0 ? "GitHub に作成済み" : createWord(detail.sync.state)) : "確認中"}）{" "}
      <button className="ghost link" onClick={() => void read()}>
        更新
      </button>
    </div>
  );
}

/**
 * A new Issue (#910): kept here and created on GitHub later. Made as a request or a PBI (the labels the Backlog lists
 * by), its localId is followed to the number; what is typed stays until it is kept.
 */
function NewIssue(props: { workspaces: Workspace[]; current: string; onCreated: () => void }) {
  const [ws, setWs] = useState(props.current || props.workspaces[0]?.id || "");
  const draftOf = (w: string) => textDraftKey(`new:${w}`);
  const [saved] = useState(() => loadNewIssueDraft(localStorage, draftOf(ws)));
  const [kind, setKind] = useState<NewIssueDraft["kind"]>(saved?.kind ?? "type:request");
  const [title, setTitle] = useState(saved?.title ?? "");
  const [body, setBody] = useState(saved?.body ?? "");
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [made, setMade] = useState<Array<{ workspaceId: string; localId: string; title: string }>>([]);
  const keep = (d: NewIssueDraft) => localStorage.setItem(draftOf(ws), JSON.stringify(d));
  // the workspace shown above is where a new Issue goes: follow it when it changes (the first value is the initial one)
  const shown = useRef(props.current);
  useEffect(() => {
    if (shown.current === props.current) return;
    shown.current = props.current;
    if (props.current && !saving) switchTo(props.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.current]);
  // each workspace has its own draft: switching shows that one's, and typing does not overwrite it with another's; not
  // while a save is under way (its answer clears the form it was made from)
  const switchTo = (w: string) => {
    const d = loadNewIssueDraft(localStorage, draftOf(w));
    setWs(w);
    setTitle(d?.title ?? "");
    setBody(d?.body ?? "");
    setKind(d?.kind ?? "type:request");
  };
  const create = () => {
    setSaving(true);
    api
      .createBacklog(ws, { title, body, labels: [kind] })
      .then((r) => {
        setMade((m) => [...m, { workspaceId: ws, localId: r.localId, title }]);
        localStorage.removeItem(draftOf(ws));
        setTitle("");
        setBody("");
        setNote("手元に保存しました。GitHub での作成は送信待ちで、番号は作られた後に下に出ます");
        props.onCreated();
      })
      .catch((e) => setNote(`作れませんでした（入力は残しています）: ${String(e.message ?? e)}`))
      .finally(() => setSaving(false));
  };
  return (
    <details className="backlog-new" open={saved !== null || undefined}>
      <summary>新しい Issue</summary>
      {props.workspaces.length > 1 && (
        <select value={ws} disabled={saving} onChange={(e) => switchTo(e.target.value)}>
          {props.workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      )}
      <select value={kind} disabled={saving} onChange={(e) => (keep({ title, body, kind: e.target.value as typeof kind }), setKind(e.target.value as typeof kind))}>
        <option value="type:request">要望（type:request）</option>
        <option value="type:pbi">PBI（type:pbi）</option>
      </select>
      <input value={title} placeholder="題" disabled={saving} onChange={(e) => (keep({ title: e.target.value, body, kind }), setTitle(e.target.value))} />
      <textarea rows={4} value={body} placeholder="本文" disabled={saving} onChange={(e) => (keep({ title, body: e.target.value, kind }), setBody(e.target.value))} />
      <button className="pri" disabled={saving || !title.trim() || !ws} onClick={create}>
        手元に保存
      </button>
      {note && <div className="hint backlog-note">{note}</div>}
      {made.map((m) => (
        <Made key={m.localId} {...m} />
      ))}
    </details>
  );
}

/** The open question of a needs-decision item as plain text (no Markdown renderer) and a free-text answer (#266). */
function Decision(props: { item: BacklogItem; onAnswered: (item: BacklogItem) => void; onError: (msg: string) => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const d = props.item.decision;
  // the screen mockups of the same question on the asks list (#2221); none when it cannot be read — the answer goes on
  const [mockups, setMockups] = useState<Artifact[]>([]);
  const { workspaceId } = props.item;
  useEffect(() => {
    // a new question (or none) starts with none: the last one's must not stay when this read fails
    setMockups([]);
    if (!d) return;
    let live = true;
    // the same question's id on the asks list
    const id = `decision:${workspaceId}#${d.issue}@${d.at}`;
    api.asks().then(
      (l) => live && setMockups(l.asks.find((a) => a.id === id)?.mockups ?? []),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [d?.issue, d?.at, workspaceId]);
  const send = () => {
    setSending(true);
    api
      .answerBacklog(props.item.workspaceId, props.item.number, text, d?.issue)
      .then(() => props.onAnswered(props.item))
      .catch((e) => props.onError(`#${props.item.number} に回答できませんでした: ${String(e.message ?? e)}`))
      .finally(() => setSending(false));
  };
  return (
    <div className="decision">
      {d ? (
        <>
          {d.issue !== props.item.number && (
            // asked on one of the in-progress PBI's Tasks (#562); the answer goes there
            <div className="task-decision">
              <a href={props.item.url.replace(/\/issues\/\d+$/, `/issues/${d.issue}`)} target="_blank" rel="noreferrer">
                Task #{d.issue}
              </a>{" "}
              の判断待ち
            </div>
          )}
          <div className="hint">{jstDateTime(Date.parse(d.at))} の問い</div>
          <pre className="wrap">{d.body}</pre>
          <Mockups list={mockups} />
        </>
      ) : (
        <div className="muted">「## 判断待ち」のコメントが見つかりません（Issue を開いて確かめてください）</div>
      )}
      <textarea rows={3} value={text} placeholder="回答（Issue に「## 回答」として書かれ、判断待ちのラベルが外れます）" onChange={(e) => setText(e.target.value)} />
      <button className="pri" disabled={sending || !text.trim()} onClick={send}>
        回答する
      </button>
    </div>
  );
}

/**
 * The first REPORT_LINES lines of a ## 状況 comment after its heading (the hint above already says 状況), then … when
 * there is more (plain text, like the ## 判断待ち).
 */
function reportHead(body: string): string {
  const lines = body.trim().replace(/^## 状況[^\n]*/, "").trim().split("\n");
  return lines.length > REPORT_LINES ? `${lines.slice(0, REPORT_LINES).join("\n")}\n…` : lines.join("\n");
}

/**
 * An in-progress row's moving / stopped, Project Status, time since the Issue changed and its last stage Task (#522);
 * a running one is the row's 実行中 already.
 */
function InProgressFacts(props: { item: BacklogItem; now: number; onOpenTask: (id: string) => void }) {
  const { item, now } = props;
  const state = inProgressState(item);
  const last = item.lastTask;
  return (
    <>
      {item.projectStatus && <span className="m">{item.projectStatus}</span>}
      <span className="m state" data-state={state.running ? "running" : "stopped"}>
        {state.label}
      </span>
      <span className="m">更新 {ago(item.updatedAt, now)}</span>
      <LastTask {...props} />
    </>
  );
}

/**
 * A row's last stage Task when it is not the running one (#522; Ready rows too, #1045): opens its Task screen. One
 * waiting for the person's reply says 返事待ち, on a request / 分解待ち row too (#1619).
 */
function LastTask(props: { item: BacklogItem; now: number; onOpenTask: (id: string) => void }) {
  const last = props.item.lastTask;
  if (!last || last.id === props.item.activeTaskId) return null;
  return (
    <button className="ghost link" onClick={() => props.onOpenTask(last.id)}>
      {lastTaskLine(last, props.now, props.item.replyWaiting ? "返事待ち" : undefined)}
    </button>
  );
}

/**
 * What a Ready / in-progress row waits for (#817, #1046): the PRs / Issues with their states (linked), how that comes
 * undone and whether backlog-next goes on by itself; the waits behind them folded under a <details>. Each of the row's
 * own waits names the PBI behind it and that PBI's stage Task (#1045, `waitOwner`): the Task opens, a stopped one can be
 * continued (続きを始める).
 */
function Waits(props: { item: BacklogItem; items: BacklogItem[]; auto: boolean; starting: number | null; onOpenTask: (id: string) => void; onStart: (pbi: number) => void }) {
  const { item } = props;
  const text = waitText(item, props.auto);
  if (!text) return null;
  const chain = waitChain(item, props.items);
  const owner = (w: BacklogItem["waits"][number]) => {
    const o = waitOwner(w, item, props.items);
    if (!o) return <> ← 不明</>;
    const t = o.task;
    return (
      <>
        {" ← "}
        <a href={o.pbi.url} target="_blank" rel="noreferrer">
          #{o.pbi.number} {o.pbi.title}
        </a>
        {" の "}
        {t === "unknown" ? (
          "Task 不明"
        ) : t === null ? (
          "工程 Task なし"
        ) : (
          <button className="ghost link" onClick={() => props.onOpenTask(t.id)}>
            Task {t.id}（{t.label}）
          </button>
        )}
        {o.startable && (
          <>
            {" "}
            <button className="ghost" disabled={props.starting !== null} onClick={() => props.onStart(o.pbi.number)}>
              続きを始める
            </button>
          </>
        )}
      </>
    );
  };
  const refs = (waits: BacklogItem["waits"], row: BacklogItem, owners = false) =>
    waits.map((w, n) => {
      const r = waitRef(w);
      return (
        <Fragment key={w.number}>
          {n > 0 && "・"}
          <a href={waitUrl(row, w)} target="_blank" rel="noreferrer">
            {r.ref}
          </a>
          （{r.state}）{owners && owner(w)}
        </Fragment>
      );
    });
  return (
    <div className="backlog-waits hint" data-issue={item.url} data-done={text.done}>
      <div>
        {text.label}
        {item.waits.length > 0 && <>: {refs(item.waits, item, true)}</>}
      </div>
      <div className="muted">
        {text.done || !text.cond ? text.next : `${text.cond} · ${text.next}`}
      </div>
      {chain.length > 0 && (
        <details>
          <summary>待ちの先（{chain.length}）</summary>
          {chain.map((s, n) => (
            <div key={n} style={{ paddingLeft: `${s.depth + 1}em` }}>
              #{s.via.number} の先:{" "}
              {s.parent ? (
                <>
                  <a href={s.parent.url} target="_blank" rel="noreferrer">
                    #{s.parent.number}
                  </a>{" "}
                  が待つ {refs(s.parent.waits, s.parent)}
                </>
              ) : (
                "未取得"
              )}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/**
 * A Ready / in-progress row's prerequisites (#937, `prereqLine`): 前提 (not done yet; backlog-next waits for them) and
 * 進められない (a person fixes the body or the prerequisite), the latter in the warning colour. The row's button still starts it.
 */
function Prereqs(props: { item: BacklogItem }) {
  const { waiting, stuck } = prereqLine(props.item);
  if (!waiting.length && !stuck.length) return null;
  const parts = (ps: PrereqPart[]) =>
    ps.map((p, n) => (
      <Fragment key={`${p.via}:${p.ref}`}>
        {n > 0 && "・"}
        {p.via !== null && (
          <>
            <a href={p.viaUrl!} target="_blank" rel="noreferrer">
              Task #{p.via}
            </a>
            {" の前提 "}
          </>
        )}
        <a href={p.url} target="_blank" rel="noreferrer">
          {p.ref}
        </a>
        {p.after}
      </Fragment>
    ));
  return (
    <div className="backlog-prereqs hint" data-issue={props.item.url}>
      {waiting.length > 0 && <div>前提: {parts(waiting)}</div>}
      {stuck.length > 0 && <div className="warn">進められない: {parts(stuck)}</div>}
    </div>
  );
}

/**
 * A Ready / in-progress row's overlap with other work (#1044, `overlapLine`): the PR / Task whose files its Tasks name, or
 * why that cannot be judged, in the warning colour. backlog-next leaves the row; the button still starts it.
 */
function Overlap(props: { item: BacklogItem }) {
  const line = overlapLine(props.item);
  if (!line) return null;
  return (
    <div className="backlog-overlap hint warn" data-issue={props.item.url}>
      {line.hits.length > 0 && (
        <div>
          重なり:{" "}
          {line.hits.map((h, n) => (
            <Fragment key={`${h.ref}:${h.path}`}>
              {n > 0 && "・"}
              <a href={h.url} target="_blank" rel="noreferrer">
                {h.ref}
              </a>
              （{h.path}）
            </Fragment>
          ))}
        </div>
      )}
      {line.unknown !== null && <div>重なりを判定できない: {line.unknown}</div>}
    </div>
  );
}

/**
 * Backlog screen (#264): the open requests and PBIs on GitHub of every registered workspace (#294), grouped by the stage
 * they are stuck at, each row naming its workspace. Read when opened and on 再読込 only (the daemon answers what it
 * imported from GitHub, #885; 再読込 imports first); the last list shows first and the new one replaces it once read (#441). GitHub stays the place to edit them. The stage buttons and answers act on the row's own workspace. The list
 * can be narrowed to one workspace (remembered in localStorage).
 */
/** Toggles `v` in `list`: in when absent, out when present. */
function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/**
 * The 表示 button and what it opens (#2695): sort, the stage / type / Priority chips and the title or number search. The
 * one part always on the heading; the conditions it sets are kept by the caller.
 */
function ViewPicker(props: { view: BacklogView; onChange: (v: BacklogView) => void }) {
  const { view, onChange } = props;
  const chips = <T extends string>(list: Array<[T, string]>, on: T[], set: (next: T[]) => BacklogView) =>
    list.map(([k, label]) => (
      <button key={k} className={`chip${on.includes(k) ? " on" : ""}`} aria-pressed={on.includes(k)} onClick={() => onChange(set(toggle(on, k)))}>
        {label}
      </button>
    ));
  return (
    <details className="backlog-view">
      <summary>表示</summary>
      <div className="backlog-view-body">
        <label>
          並べ替え{" "}
          <select value={view.sort} onChange={(e) => onChange({ ...view, sort: e.target.value as BacklogView["sort"] })}>
            {SORTS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="chips">{chips(STAGES, view.stages, (stages) => ({ ...view, stages }))}</div>
        <div className="chips">{chips(TYPES, view.types, (types) => ({ ...view, types }))}</div>
        <div className="chips">{chips(PRIORITIES.map((p): [string, string] => [p, p]), view.priorities, (priorities) => ({ ...view, priorities }))}</div>
        <input type="search" placeholder="題か番号" value={view.query} onChange={(e) => onChange({ ...view, query: e.target.value })} />
        {viewSummary(view) && (
          <button className="ghost" onClick={() => onChange(DEFAULT_VIEW)}>
            元に戻す
          </button>
        )}
      </div>
    </details>
  );
}

export function Backlog(props: { onFeedback: (workspace?: FeedbackTarget) => void; onError: (msg: string) => void; onStarted: (task: Task) => void; onOpenTask: (id: string) => void; onOpenSchedules: () => void }) {
  const [data, setData] = useState<BacklogData | null>(lastBacklog);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState<number | null>(null);
  const [approvals, setApprovals] = useState(0);
  const [promotion, setPromotion] = useState<ReturnType<typeof promotionLine>>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  // whether backlog-next resumes a row whose waits closed (#817): an enabled バックログを進める and an implement slot
  const [auto, setAuto] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState(() => localStorage.getItem(SHOWN_KEY) ?? "");
  const [view, setView] = useState(() => loadView(localStorage));
  const changeView = (next: BacklogView) => {
    setView(next);
    saveView(localStorage, next);
  };
  const summary = viewSummary(view);
  const projectVars = workspaces && Object.fromEntries(workspaces.map((w) => [w.id, w.projectVar]));
  const key = (i: BacklogItem) => `${i.workspaceId}:${i.number}`;
  // a remembered workspace that is no longer registered shows everything
  const current = workspaces && !workspaces.some((w) => w.id === shown) ? "" : shown;
  const now = Date.now();
  const inView = (workspaceId: string) => !current || workspaceId === current;
  // the narrowed workspace's name, also before (or without) the workspace list: the rows and errors carry it
  const currentName = workspaces?.find((w) => w.id === current)?.name ?? [...(data?.items ?? []), ...(data?.errors ?? [])].find((i) => i.workspaceId === current)?.workspaceName;
  const show = (id: string) => {
    setShown(id);
    if (id) localStorage.setItem(SHOWN_KEY, id);
    else localStorage.removeItem(SHOWN_KEY);
  };

  const answered = (item: BacklogItem) => {
    // from lastBacklog, not this render's data: another answer may have landed since (two in flight)
    lastBacklog = lastBacklog && { ...lastBacklog, items: lastBacklog.items.filter((i) => key(i) !== key(item)) };
    setData(lastBacklog);
    load(true);
  };

  const start = (workspaceId: string, number: number, action: BacklogAction) => {
    setStarting(number);
    api
      .startBacklog(workspaceId, number, action)
      .then(props.onStarted)
      .catch((e) => {
        const running = (e.body as { taskId?: string } | undefined)?.taskId;
        if (e.status === 409 && running) props.onOpenTask(running);
        else props.onError(`#${number} を始められませんでした: ${String(e.message ?? e)}`);
      })
      .finally(() => setStarting(null));
  };

  const load = (refresh: boolean) => {
    setBusy(true);
    // read with the list (opened, 再読込): backlog-next may have been turned on or off meanwhile
    Promise.all([api.schedules(), api.workspaces()])
      .then(([schedules, workspaces]) => setAuto(autoByWorkspace(schedules, workspaces)))
      .catch(() => setAuto({}));
    api
      .release()
      .then((r) => setPromotion(promotionLine(r)))
      .catch(() => setPromotion(null));
    api
      .backlog(refresh)
      .then((b) => {
        lastBacklog = b;
        setData(b);
        setFailure(null);
      })
      .catch((e) => {
        const message = String(e.message ?? e);
        setFailure(message);
        props.onError(`GitHub を読めませんでした: ${message}`);
      })
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    load(false);
    api
      .queue()
      .then((q) => setApprovals(q.waiting.length))
      .catch(() => setApprovals(0));
    api
      .workspaces()
      .then(setWorkspaces)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="main backlog">
      <section className="card">
        <div className="row head">
          <h5>Backlog</h5>
          <span className="hint backlog-heading">{backlogHeading(data?.fetchedAt ?? null, busy, workspaces ? workspaces.some((w) => inView(w.id) && w.backlog === "github") : null)}</span>
          <button className="ghost" disabled={busy} onClick={() => load(true)}>
            再読込
          </button>
          <ViewPicker view={view} onChange={changeView} />
          <button className="pri" onClick={() => props.onFeedback(current ? { id: current, name: currentName ?? current } : undefined)}>
            要望を登録
          </button>
        </div>
        {summary && (
          <div className="hint backlog-view-line">
            {summary}{" "}
            <button className="ghost link" onClick={() => changeView(DEFAULT_VIEW)}>
              元に戻す
            </button>
          </div>
        )}
        {promotion && (
          <div className="hint promotion">
            {promotion.text}
            {promotion.link && (
              <>
                {" "}
                <a href={promotion.link} target="_blank" rel="noreferrer">
                  救援画面 →
                </a>
              </>
            )}
          </div>
        )}
        {approvals > 0 && (
          <button className="ghost link" onClick={props.onOpenSchedules}>
            承認待ち {approvals} 件 →
          </button>
        )}
        {workspaces && workspaces.length > 1 && (
          <nav className="subtabs backlog-ws">
            <button className={current === "" ? "on" : ""} onClick={() => show("")}>
              すべて{data ? ` ${data.items.length}` : ""}
            </button>
            {workspaces.map((w) => (
              <button key={w.id} className={current === w.id ? "on" : ""} onClick={() => show(w.id)}>
                {w.name}
                {data ? ` ${data.items.filter((i) => i.workspaceId === w.id).length}` : ""}
              </button>
            ))}
          </nav>
        )}
        {failure && <div className="muted">GitHub を読めませんでした: {failure}</div>}
        {data?.syncs.filter((x) => inView(x.workspaceId)).map((x) => (
          <div key={x.workspaceId} className="hint backlog-sync" data-workspace={x.workspaceId}>
            <SyncLine sync={x.sync} line={githubSyncText(x)} scope={data.syncs.length > 1 ? (workspaces?.find((w) => w.id === x.workspaceId)?.name ?? x.workspaceId) : undefined} />
            {x.creates.map((c) => (
              <div key={c.localId} className="m" data-sync={c.state}>
                番号なし（{createWord(c.state)}）: {c.title}
              </div>
            ))}
            {x.issues.map((h) => (
              <EditToggle key={h.number} target={{ workspaceId: x.workspaceId, number: h.number, url: h.url }} summary={heldIssueText(h)} held onChanged={() => load(false)} onError={props.onError} />
            ))}
          </div>
        ))}
        {workspaces && workspaces.length > 0 && <NewIssue workspaces={workspaces} current={current} onCreated={() => load(false)} />}
        {data?.errors.filter((e) => inView(e.workspaceId)).map((e) => (
          <WorkspaceError
            key={e.workspaceId}
            error={e}
            loaded={projectVars !== null}
            projectVar={projectVars?.[e.workspaceId]}
            onSaved={() => {
              api.workspaces().then(setWorkspaces).catch(() => undefined);
              load(true);
            }}
            onError={props.onError}
          />
        ))}
      </section>

      {data &&
        STAGES.filter(([stage]) => view.stages.length === 0 || view.stages.includes(stage)).map(([stage, label]) => {
          const items = applyView(data.items.filter((i) => inView(i.workspaceId)), view).filter((i) => i.stage === stage);
          return (
            <section key={stage} className="card" data-stage={stage}>
              <div className="row head">
                <h5>
                  {label} <span className="hint">{items.length}</span>
                </h5>
              </div>
              {items.length === 0 && <div className="muted">なし</div>}
              {items.map((i) =>
                i.stage === "needs-decision" ? (
                  // a card, not a row: the whole title is the link, then the question and the answer box
                  <div key={key(i)} className="decision-card">
                    <h5 className="backlog-item">
                      <a href={i.url} target="_blank" rel="noreferrer">
                        #{i.number} {i.title}
                      </a>{" "}
                      <span className="m workspace">{i.workspaceName}</span>
                    </h5>
                    <SyncLine sync={i.sync} />
                    <Decision item={i} onAnswered={answered} onError={props.onError} />
                    <EditToggle target={i} onChanged={() => load(false)} onError={props.onError} />
                  </div>
                ) : (
                <Fragment key={key(i)}>
                <div className={`row backlog-item${i.stage === "in-progress" ? " in-progress" : ""}`}>
                  <span className="t">
                    <a href={i.url} target="_blank" rel="noreferrer">
                      #{i.number}
                    </a>{" "}
                    {i.title}
                  </span>
                  <span className="m workspace">{i.workspaceName}</span>
                  {i.tasks && <span className="m num">Task {i.tasks.done}/{i.tasks.total}</span>}
                  {readyPending(i) && <span className="m">分解済み・Ready 待ち</span>}
                  <span className="m">
                    {[i.storyPoints !== null ? `SP ${i.storyPoints}` : null, i.priority].filter(Boolean).join(" · ")}
                  </span>
                  {i.stage === "in-progress" && <InProgressFacts item={i} now={now} onOpenTask={props.onOpenTask} />}
                  {(i.stage === "ready" || (i.replyWaiting && i.stage !== "in-progress")) && <LastTask item={i} now={now} onOpenTask={props.onOpenTask} />}
                  {i.activeTaskId ? (
                    <button className="ghost link" onClick={() => props.onOpenTask(i.activeTaskId!)}>
                      {activeTaskLine(i.lastTask?.id === i.activeTaskId ? i.lastTask : null, now)}
                    </button>
                  ) : (
                    <>
                      {startButton(i) && (
                        <button className="ghost" disabled={starting !== null} onClick={() => start(i.workspaceId, i.number, startButton(i)![0])}>
                          {startButton(i)![1]}
                        </button>
                      )}
                      {/* #531: every Task closed and no confirmation left — pbi-complete's step 6 writes the result and closes it */}
                      {i.closable && (
                        <>
                          <span className="m">閉じられる</span>
                          <button className="ghost" disabled={starting !== null} onClick={() => start(i.workspaceId, i.number, "close")}>
                            閉じる
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
                <div className="backlog-syncline">
                  <SyncLine sync={i.sync} />
                </div>
                {/* #2296: the screen the PBI decided, as a question's mockups (#2221); nothing without a **画面イメージ** line */}
                <Mockups list={i.mockups} />
                {i.stage === "in-progress" && i.report && (
                  <div className="backlog-report">
                    <div className="hint">{jstDateTime(Date.parse(i.report.at))} の状況</div>
                    <pre className="wrap">{reportHead(i.report.body)}</pre>
                  </div>
                )}
                <Waits item={i} items={data.items} auto={auto[i.workspaceId] ?? false} starting={starting} onOpenTask={props.onOpenTask} onStart={(pbi) => start(i.workspaceId, pbi, "complete")} />
                <Prereqs item={i} />
                <Overlap item={i} />
                <Stops stops={i.stopSummary} issue={i.url} />
                <EditToggle target={i} onChanged={() => load(false)} onError={props.onError} />
                </Fragment>
                ),
              )}
            </section>
          );
        })}
      <Flow />
      <Interventions inView={(workspaceId) => workspaceId === null || inView(workspaceId)} onOpenTask={props.onOpenTask} />
    </main>
  );
}
