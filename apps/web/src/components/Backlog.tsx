import { createContext, Fragment, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Artifact, Backlog as BacklogData, BacklogAction, BacklogIssueDetail, BacklogItem, BacklogStage, BacklogSyncInfo, Task, Workspace } from "@switchboard/protocol";
import type { FeedbackTarget } from "../feedbackTarget.ts";
import { api } from "../api.ts";
import { backlogHeading, createWord, draftKey, editOf, formAfterRead, GUARANTEE_A, githubSyncText, heldIssueText, issueHref, loadDraft, loadNewIssueDraft, savedWords, syncLine, textDraftKey, valueText, workspaceErrorGuide, type EditForm, type NewIssueDraft } from "../backlogSync.ts";
import { activeTaskLine, ago, autoByWorkspace, inProgressState, readyPending, startButton, directButton, lastTaskLine, overlapLine, prereqLine, waitChain, waitOwner, waitRef, waitText, waitUrl, type PrereqPart } from "../inProgress.ts";
import { promotionLine } from "../release.ts";
import { changeMarks, changeStateLabel, short } from "../changes.ts";
import { Flow } from "./Flow.tsx";
import { Interventions } from "./Interventions.tsx";
import { Mockups } from "./Approvals.tsx";
import { Stops } from "./Stops.tsx";
import { jstDateTime } from "../time.ts";
import { t } from "../i18n.ts";
import { backlog as m } from "../i18n/backlog.ts";
import { applyView, itemMarks, loadView, PRIORITIES, resetView, saveView, SORTS, STAGES, TYPES, viewSummary, type BacklogView } from "../backlogView.ts";

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
      .catch((e) => props.onError(t(m.saveVarFailed, { name: props.error.workspaceName, error: String(e.message ?? e) })))
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
                    {t(m.steps)}
                  </a>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {props.error.kind !== "other" && <span className="hint backlog-error-detail">{t(m.errorDetail, { message: props.error.message })}</span>}
      {props.error.kind !== "gh-login" && (
        <div className="row">
          <label className="hint" htmlFor={`pv-${props.error.workspaceId}`}>
            {t(m.projectVarLabel)}
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
            {t(m.save)}
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

/** Whether a workspace's backlog is kept here, with no GitHub to send it to (#2343): the words of what is saved depend on it. */
const KeptHere = createContext<(workspaceId: string) => boolean>(() => false);

/** An Issue's number or title: a link to GitHub, the plain text for an Issue with no page there (#2343; the list opens it by 編集). */
function IssueLink(props: { url: string; className?: string; children: ReactNode }) {
  const href = issueHref(props.url);
  if (!href) return <span className={props.className}>{props.children}</span>;
  return (
    <a className={props.className} href={href} target="_blank" rel="noreferrer">
      {props.children}
    </a>
  );
}

/**
 * An Issue's edit form under its row (#910): the values as the daemon shows them (stored edits over GitHub's), saved
 * here at once and sent later — the two are told apart. What was typed is kept while the save fails (and across a reload,
 * localStorage) until it is saved; a held conflict shows both sides and takes an explicit choice.
 */
function Editor(props: { target: EditTarget; onChanged: () => void; onError: (msg: string) => void }) {
  const item = props.target;
  const words = savedWords(useContext(KeptHere)(item.workspaceId));
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
      .catch((e) => (setReadFailed(true), props.onError(t(m.readIssueFailed, { n: item.number, error: String(e.message ?? e) }))));
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
    if (!edit) return setNote(t(m.noChanges));
    setSaving(true);
    api
      .editBacklog(item.workspaceId, item.number, edit)
      .then(async () => {
        // only the draft that was saved: one typed since (in an editor opened again while this save was under way) stays
        if (JSON.stringify(loadDraft(localStorage, key)?.form) === JSON.stringify(form)) localStorage.removeItem(key);
        setNote(words.edit);
        // the form stays while it is read again (a failed read leaves it, not an empty editor)
        await read();
        props.onChanged();
      })
      // refused (409) or unreachable: the form keeps what was typed and is rebased on the Issue read again, so a retry
      // sends what changed against the newest value
      .catch((e) => {
        setNote(t(m.saveFailed, { error: String(e.message ?? e) }));
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
        setNote(words.comment);
        await read();
        props.onChanged();
      })
      .catch((e) => setNote(t(m.commentFailed, { error: String(e.message ?? e) })))
      .finally(() => setSaving(false));
  };
  // one choice at a time: a second click would carry the same revision and be told to choose again
  const resolve = (field: string, choice: "local" | "remote", expectedRevision: string) => {
    setSaving(true);
    return api
      .editBacklog(item.workspaceId, item.number, { resolve: { field, choice, expectedRevision } })
      .then(async () => {
        setNote(choice === "local" ? t(m.sendingLocal) : t(m.usingRemote));
        await read();
        props.onChanged();
      })
      .catch(async (e) => {
        // an old choice (409): GitHub or the edit moved since it was read — read again, choose again
        setNote(e.status === 409 ? t(m.conflictMoved) : t(m.chooseFailed, { error: String(e.message ?? e) }));
        await read();
      })
      .finally(() => setSaving(false));
  };
  // a refused send, its cause put right (#2885): back in the queue, sent with the next run
  const retry = (operation: string) => {
    setSaving(true);
    return api
      .editBacklog(item.workspaceId, item.number, { retry: { operation } })
      .then(async () => {
        setNote(t(m.retrying));
        await read();
        props.onChanged();
      })
      .catch(async (e) => {
        setNote(e.status === 409 ? t(m.stateMoved) : t(m.retryFailed, { error: String(e.message ?? e) }));
        await read();
      })
      .finally(() => setSaving(false));
  };
  if (!detail || !form)
    return readFailed ? (
      <div className="hint">
        {t(m.readFailed)}{" "}
        <button className="ghost link" onClick={() => void read()}>
          {t(m.reread)}
        </button>
      </div>
    ) : (
      <div className="hint">{t(m.loading)}</div>
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
            {h.field ?? t(m.heldNew)}: {h.status === "conflict" ? t(m.heldConflict) : h.status === "failed" ? t(m.heldFailed) : t(m.heldUnknown)}
            {h.reason ? t(m.paren, { text: h.reason }) : ""}
          </div>
          {h.status === "failed" && (
            <button className="ghost" disabled={saving} onClick={() => retry(h.operation)}>
              {t(m.sendAgain)}
            </button>
          )}
          {h.conflict && (
            <>
              <div className="backlog-sides">
                <div>
                  <div className="hint">{t(m.sideLocal)}</div>
                  <pre className="wrap">{valueText(h.conflict.local)}</pre>
                </div>
                <div>
                  <div className="hint">{t(m.sideRemote)}</div>
                  <pre className="wrap">{valueText(h.conflict.remote, h.conflict.remoteRead)}</pre>
                </div>
              </div>
              <button className="ghost" disabled={saving || h.field === null} onClick={() => resolve(h.field!, "local", h.conflict!.revision)}>
                {t(m.sendLocal)}
              </button>{" "}
              <button className="ghost" disabled={saving || h.field === null} onClick={() => resolve(h.field!, "remote", h.conflict!.revision)}>
                {t(m.useRemote)}
              </button>
            </>
          )}
        </div>
      ))}
      {!writable && <div className="muted">{t(m.notWritable, { state: detail.fetchState })}</div>}
      <label className="hint">{t(m.fieldTitle)}</label>
      <input value={form.title} disabled={!writable || saving} onChange={set("title")} />
      <label className="hint">{t(m.fieldBody)}</label>
      <textarea rows={6} value={form.body} disabled={!writable || saving} onChange={set("body")} />
      <div className="row">
        <label className="hint" title={t(m.labelsTitle)}>{t(m.fieldLabels)}</label>
        <input value={form.labels} disabled={!writable || saving} onChange={set("labels")} />
        <label className="hint">{t(m.fieldState)}</label>
        <select value={form.state} disabled={!writable || saving} onChange={set("state")}>
          <option value="OPEN">{t(m.stateOpen)}</option>
          <option value="CLOSED">{t(m.stateClosed)}</option>
        </select>
      </div>
      <div className="row">
        <label className="hint">Milestone</label>
        <input value={form.milestone} disabled={!writable || saving} onChange={set("milestone")} />
        <label className="hint">{t(m.fieldParent)}</label>
        <input value={form.parent} disabled={!writable || saving} inputMode="numeric" onChange={set("parent")} />
      </div>
      {detail.fields === null ? (
        <div className="hint">{t(m.noProjectFields)}</div>
      ) : (
        Object.keys(form.fields).map((k) => (
          <div className="row" key={k}>
            <label className="hint">{k}</label>
            <input value={form.fields[k]} disabled={!writable || saving} onChange={(e) => change({ fields: { ...form.fields, [k]: e.target.value } })} />
          </div>
        ))
      )}
      <button className="pri" disabled={saving || !writable} onClick={save}>
        {t(m.save)}
      </button>
      <label className="hint">{t(m.comment)}</label>
      <textarea rows={3} value={comment} disabled={saving} onChange={(e) => (localStorage.setItem(commentKey, e.target.value), setComment(e.target.value))} placeholder={words.commentHint} />
      <button className="ghost" disabled={saving || !comment.trim()} onClick={() => send(comment)}>
        {t(m.saveComment)}
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
      <summary>{props.summary ?? t(m.edit)}</summary>
      {open && <Editor target={props.target} onChanged={props.onChanged} onError={props.onError} />}
    </details>
  );
}

/** One Issue made here, followed from its localId to the number GitHub gives it (and the row it then is). */
function Made(props: { workspaceId: string; localId: string; title: string }) {
  const words = savedWords(useContext(KeptHere)(props.workspaceId));
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
        <IssueLink url={detail!.issue.url}>
          #{n}
        </IssueLink>
      ) : (
        t(m.noNumber)
      )}{" "}
      {props.title}
      {t(m.paren, { text: detail ? (n > 0 ? words.made : createWord(detail.sync.state)) : t(m.checking) })}{" "}
      <button className="ghost link" onClick={() => void read()}>
        {t(m.refresh)}
      </button>
    </div>
  );
}

/**
 * One local change opened (#2486): its branches' tips now, the marks merge-gate counts (main review, local-ci of this
 * head and base, rechecks), then its body and every comment oldest first — the review, the triage, the results.
 */
function ChangeDetail(props: { workspaceId: string; number: number }) {
  const [detail, setDetail] = useState<BacklogIssueDetail | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    api.backlogIssue(props.workspaceId, props.number).then(setDetail, (e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
  }, [props.workspaceId, props.number]);
  if (failed) return <div className="muted">{t(m.readFailedWith, { error: failed })}</div>;
  if (!detail) return <div className="hint">{t(m.loading)}</div>;
  const marks = changeMarks(detail.comments, detail.changeRefs);
  const ci = { pass: t(m.ciPass), fail: t(m.ciFail), stale: t(m.ciStale) } as const;
  return (
    <div className="change-detail" data-change={props.number}>
      <div className="hint change-marks">
        head {short(detail.changeRefs?.head)} · base {short(detail.changeRefs?.base)}
        {" · "}
        {marks.review ? t(m.latestReview, { runner: marks.review.runner, at: jstDateTime(Date.parse(marks.review.at)) }) : t(m.noReview)}
        {" · "}
        {marks.localCi ? ci[marks.localCi] : t(m.noCi)}
        {marks.rechecks.length > 0 && t(m.rechecks, { list: marks.rechecks.join(", ") })}
      </div>
      <pre className="wrap">{detail.issue.body || t(m.noBody)}</pre>
      {detail.comments.map((c) => (
        <div key={c.id} className="change-comment">
          <div className="hint">{jstDateTime(Date.parse(c.createdAt))}</div>
          <pre className="wrap">{c.body}</pre>
        </div>
      ))}
    </div>
  );
}

/**
 * The local changes of the workspaces in view (#2486): one row each, opened in place. Only open ones are on the floor;
 * the closed ones (merged or not) are folded. Nothing when none is open.
 */
function Changes(props: { changes: BacklogData["changes"] }) {
  const [open, setOpen] = useState<string | null>(null);
  const opened = props.changes.filter((c) => c.state === "OPEN");
  const closed = props.changes.filter((c) => c.state !== "OPEN");
  if (opened.length === 0) return null;
  const row = (c: BacklogData["changes"][number]) => {
    const id = `${c.workspaceId}#${c.number}`;
    return (
      <Fragment key={id}>
        <button className="row backlog-item change-row ghost" data-change={c.number} data-state={c.state} aria-expanded={open === id} onClick={() => setOpen(open === id ? null : id)}>
          <span className="t">
            #{c.number} {c.title}
          </span>
          <span className="m">
            {c.head} → {c.base}
          </span>
          <span className="m">{changeStateLabel(c)}</span>
          <span className="m">{jstDateTime(Date.parse(c.updatedAt))}</span>
        </button>
        {open === id && <ChangeDetail workspaceId={c.workspaceId} number={c.number} />}
      </Fragment>
    );
  };
  return (
    <section className="card backlog-changes">
      <div className="row head">
        <h5>
          {t(m.changes)} <span className="hint">{opened.length}</span>
        </h5>
      </div>
      {opened.map(row)}
      {closed.length > 0 && (
        <details>
          <summary className="hint">{t(m.closedChanges, { n: closed.length })}</summary>
          {closed.map(row)}
        </details>
      )}
    </section>
  );
}

/**
 * A new Issue (#910): kept here and created on GitHub later. Made as a request or a PBI (the labels the Backlog lists
 * by), its localId is followed to the number; what is typed stays until it is kept.
 */
function NewIssue(props: { workspaces: Workspace[]; current: string; onCreated: () => void }) {
  const keptHere = useContext(KeptHere);
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
        setNote(savedWords(keptHere(ws)).created);
        props.onCreated();
      })
      .catch((e) => setNote(t(m.createFailed, { error: String(e.message ?? e) })))
      .finally(() => setSaving(false));
  };
  return (
    <details className="backlog-new" open={saved !== null || undefined}>
      <summary>{t(m.newIssue)}</summary>
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
        <option value="type:request">{t(m.kindRequest)}</option>
        <option value="type:pbi">{t(m.kindPbi)}</option>
      </select>
      <input value={title} placeholder={t(m.fieldTitle)} disabled={saving} onChange={(e) => (keep({ title: e.target.value, body, kind }), setTitle(e.target.value))} />
      <textarea rows={4} value={body} placeholder={t(m.fieldBody)} disabled={saving} onChange={(e) => (keep({ title, body: e.target.value, kind }), setBody(e.target.value))} />
      <button className="pri" disabled={saving || !title.trim() || !ws} onClick={create}>
        {t(m.saveLocally)}
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
      .catch((e) => props.onError(t(m.answerFailed, { n: props.item.number, error: String(e.message ?? e) })))
      .finally(() => setSending(false));
  };
  return (
    <div className="decision">
      {d ? (
        <>
          {d.issue !== props.item.number && (
            // asked on one of the in-progress PBI's Tasks (#562); the answer goes there
            <div className="task-decision">
              <IssueLink url={props.item.url.replace(/\/issues\/\d+$/, `/issues/${d.issue}`)}>
                Task #{d.issue}
              </IssueLink>{" "}
              {t(m.taskDecision)}
            </div>
          )}
          <div className="hint">{t(m.askedAt, { at: jstDateTime(Date.parse(d.at)) })}</div>
          <pre className="wrap">{d.body}</pre>
          <Mockups list={mockups} />
        </>
      ) : (
        <div className="muted">{t(m.noDecision)}</div>
      )}
      <textarea rows={3} value={text} placeholder={t(m.answerPlaceholder)} onChange={(e) => setText(e.target.value)} />
      <button className="pri" disabled={sending || !text.trim()} onClick={send}>
        {t(m.answer)}
      </button>
    </div>
  );
}

/**
 * The first REPORT_LINES lines of a ## 状況 comment after its heading (the hint above already says 状況), then … when
 * there is more (plain text, like the ## 判断待ち).
 */
function reportHead(body: string): string {
  const lines = body.trim().replace(/^## 状況[^\n]*/, "").trim().split("\n"); // compared with the report's heading in the Issue body
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
      <span className="m">{t(m.updated, { ago: ago(item.updatedAt, now) })}</span>
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
      {lastTaskLine(last, props.now, props.item.replyWaiting ? t(m.replyWaiting) : undefined)}
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
    if (!o) return <>{t(m.ownerUnknown)}</>;
    const task = o.task;
    return (
      <>
        {" ← "}
        <IssueLink url={o.pbi.url}>
          #{o.pbi.number} {o.pbi.title}
        </IssueLink>
        {t(m.ownerOf)}
        {task === "unknown" ? (
          t(m.taskUnknown)
        ) : task === null ? (
          t(m.noStageTask)
        ) : (
          <button className="ghost link" onClick={() => props.onOpenTask(task.id)}>
            {t(m.ownerTask, { id: task.id, label: task.label })}
          </button>
        )}
        {o.startable && (
          <>
            {" "}
            <button className="ghost" disabled={props.starting !== null} onClick={() => props.onStart(o.pbi.number)}>
              {t(m.continue)}
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
          {n > 0 && t(m.listSep)}
          <IssueLink url={waitUrl(row, w)}>
            {r.ref}
          </IssueLink>
          {t(m.paren, { text: r.state })}
          {owners && owner(w)}
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
          <summary>{t(m.chain, { n: chain.length })}</summary>
          {chain.map((s, n) => (
            <div key={n} style={{ paddingLeft: `${s.depth + 1}em` }}>
              {t(m.chainVia, { n: s.via.number })}{" "}
              {s.parent ? (
                <>
                  <IssueLink url={s.parent.url}>
                    #{s.parent.number}
                  </IssueLink>{" "}
                  {t(m.chainWaits)}
                  {refs(s.parent.waits, s.parent)}
                </>
              ) : (
                t(m.notRead)
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
        {n > 0 && t(m.listSep)}
        {p.via !== null && (
          <>
            <IssueLink url={p.viaUrl!}>
              Task #{p.via}
            </IssueLink>
            {t(m.prereqOf)}
          </>
        )}
        <IssueLink url={p.url}>
          {p.ref}
        </IssueLink>
        {p.after}
      </Fragment>
    ));
  return (
    <div className="backlog-prereqs hint" data-issue={props.item.url}>
      {waiting.length > 0 && <div>{t(m.prereqs)}{parts(waiting)}</div>}
      {stuck.length > 0 && <div className="warn">{t(m.stuck)}{parts(stuck)}</div>}
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
          {t(m.overlap)}{" "}
          {line.hits.map((h, n) => (
            <Fragment key={`${h.ref}:${h.path}`}>
              {n > 0 && t(m.listSep)}
              <IssueLink url={h.url}>
                {h.ref}
              </IssueLink>
              {t(m.paren, { text: h.path })}
            </Fragment>
          ))}
        </div>
      )}
      {line.unknown !== null && <div>{t(m.overlapUnknown, { reason: line.unknown })}</div>}
    </div>
  );
}

/**
 * A row's buttons (#2696: a board tile's too): the running stage Task's link, else the stage's start button and 閉じる
 * when the PBI can be closed.
 */
function RowActions(props: { item: BacklogItem; now: number; starting: number | null; metaId: string | null; onStart: (action: BacklogAction) => void; onOpenTask: (id: string) => void }) {
  const { item: i, now, starting } = props;
  if (i.activeTaskId)
    return (
      <button className="ghost link" onClick={() => props.onOpenTask(i.activeTaskId!)}>
        {activeTaskLine(i.lastTask?.id === i.activeTaskId ? i.lastTask : null, now)}
      </button>
    );
  const action = startButton(i);
  const direct = directButton(i, props.metaId);
  return (
    <>
      {action && (
        <button className="ghost" disabled={starting !== null} onClick={() => props.onStart(action[0])}>
          {action[1]}
        </button>
      )}
      {direct && (
        <button className="ghost" disabled={starting !== null} onClick={() => props.onStart(direct[0])}>
          {direct[1]}
        </button>
      )}
      {/* #531: every Task closed and no confirmation left — pbi-complete's step 6 writes the result and closes it */}
      {i.closable && (
        <>
          <span className="m">{t(m.closable)}</span>
          <button className="ghost" disabled={starting !== null} onClick={() => props.onStart("close")}>
            {t(m.close)}
          </button>
        </>
      )}
    </>
  );
}

/**
 * A row's facts after its title (#3708: the list row's and an opened board tile's): the workspace, the Task count,
 * 分解済み, SP · Priority, an in-progress row's moving / stopped and its last stage Task (a Ready row's too, and one
 * waiting for the person's reply).
 */
function ItemFacts(props: { item: BacklogItem; now: number; onOpenTask: (id: string) => void }) {
  const { item: i, now } = props;
  return (
    <>
      <span className="m workspace">{i.workspaceName}</span>
      {i.tasks && <span className="m num">Task {i.tasks.done}/{i.tasks.total}</span>}
      {readyPending(i) && <span className="m">{t(m.readyPending)}</span>}
      <span className="m">
        {[i.storyPoints !== null ? `SP ${i.storyPoints}` : null, i.priority].filter(Boolean).join(" · ")}
      </span>
      {i.stage === "in-progress" && <InProgressFacts item={i} now={now} onOpenTask={props.onOpenTask} />}
      {(i.stage === "ready" || (i.replyWaiting && i.stage !== "in-progress")) && <LastTask item={i} now={now} onOpenTask={props.onOpenTask} />}
    </>
  );
}

/**
 * What a row shows under its facts (#3708: one part for the list row and an opened board tile, so what is added to the
 * list shows on the board too): the sync line, the PBI's mockups, an in-progress row's report, its waits,
 * prerequisites, overlap and stops, and 編集. `onStart` continues the PBI behind a wait (続きを始める).
 */
function ItemDetail(props: { item: BacklogItem; items: BacklogItem[]; auto: boolean; starting: number | null; onStart: (pbi: number) => void; onOpenTask: (id: string) => void; onChanged: () => void; onError: (msg: string) => void }) {
  const { item: i } = props;
  return (
    <>
      <div className="backlog-syncline">
        <SyncLine sync={i.sync} />
      </div>
      {/* #2296: the screen the PBI decided, as a question's mockups (#2221); nothing without a **画面イメージ** line */}
      <Mockups list={i.mockups} />
      {i.stage === "in-progress" && i.report && (
        <div className="backlog-report">
          <div className="hint">{t(m.reportAt, { at: jstDateTime(Date.parse(i.report.at)) })}</div>
          <pre className="wrap">{reportHead(i.report.body)}</pre>
        </div>
      )}
      <Waits item={i} items={props.items} auto={props.auto} starting={props.starting} onOpenTask={props.onOpenTask} onStart={props.onStart} />
      <Prereqs item={i} />
      <Overlap item={i} />
      <Stops stops={i.stopSummary} issue={i.url} />
      <EditToggle target={i} onChanged={props.onChanged} onError={props.onError} />
    </>
  );
}

/**
 * A board tile (#2696): the numbered title (the Issue's link), SP · Priority, the marks of the row's sections (#3707)
 * and the row's buttons. ▶ (outside the title, #3708) opens it on what the list row shows: its facts in place of SP ·
 * Priority and the marks, then ItemDetail; whether it is open is not kept. A needs-decision tile is its title only and
 * opens on the list card's parts: the sync line, the question and the answer box (which stays, with what was typed,
 * when it is closed again) and 編集.
 */
function Tile(props: { item: BacklogItem; items: BacklogItem[]; auto: boolean; now: number; starting: number | null; metaId: string | null; onStart: (action: BacklogAction) => void; onContinue: (pbi: number) => void; onOpenTask: (id: string) => void; onAnswered: (item: BacklogItem) => void; onChanged: () => void; onError: (msg: string) => void }) {
  const { item: i } = props;
  const [opened, setOpened] = useState(false);
  const [open, setOpen] = useState(false);
  if (i.stage === "needs-decision")
    return (
      <details className="backlog-tile" data-issue={i.url} onToggle={(e) => e.currentTarget.open && setOpened(true)}>
        <summary className="t">
          #{i.number} {i.title}
        </summary>
        {opened && (
          <div className="backlog-tile-detail">
            <SyncLine sync={i.sync} />
            <Decision item={i} onAnswered={props.onAnswered} onError={props.onError} />
            <EditToggle target={i} onChanged={props.onChanged} onError={props.onError} />
          </div>
        )}
      </details>
    );
  const facts = [i.storyPoints !== null ? `SP ${i.storyPoints}` : null, i.priority].filter(Boolean).join(" · ");
  const label = t(open ? m.closeTile : m.openTile);
  return (
    <div className="backlog-tile" data-issue={i.url}>
      <IssueLink className="t" url={i.url}>
        #{i.number} {i.title}
      </IssueLink>
      <div className="row">
        <button className="ghost" aria-expanded={open} aria-label={label} title={label} data-open-tile onClick={() => setOpen(!open)}>
          {open ? "▼" : "▶"}
        </button>
        {open ? (
          <ItemFacts item={i} now={props.now} onOpenTask={props.onOpenTask} />
        ) : (
          <>
            {facts && <span className="m">{facts}</span>}
            {/* #3707: which of the row's sections (待ち・前提・重なり・停止・返事待ち) the item has, without opening it */}
            {itemMarks(i, props.auto).map((x) => (
              <span key={x.key} className={"mark" + (x.warn ? " warn" : "")} data-mark={x.key}>
                {x.label}
              </span>
            ))}
          </>
        )}
        <RowActions item={i} now={props.now} starting={props.starting} metaId={props.metaId} onStart={props.onStart} onOpenTask={props.onOpenTask} />
      </div>
      {open && (
        <div className="backlog-tile-detail">
          <ItemDetail item={i} items={props.items} auto={props.auto} starting={props.starting} onStart={props.onContinue} onOpenTask={props.onOpenTask} onChanged={props.onChanged} onError={props.onError} />
        </div>
      )}
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
const LAYOUTS: Array<[BacklogView["layout"], string]> = [
  ["list", t(m.layoutList)],
  ["board", t(m.layoutBoard)],
];

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
      <summary>{t(m.view)}</summary>
      <div className="backlog-view-body">
        <div className="chips">
          {LAYOUTS.map(([k, label]) => (
            <button key={k} className={`chip${view.layout === k ? " on" : ""}`} aria-pressed={view.layout === k} onClick={() => onChange({ ...view, layout: k })}>
              {label}
            </button>
          ))}
        </div>
        <label>
          {t(m.sort)}{" "}
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
        <input type="search" placeholder={t(m.searchPlaceholder)} value={view.query} onChange={(e) => onChange({ ...view, query: e.target.value })} />
        {viewSummary(view) && (
          <button className="ghost" onClick={() => onChange(resetView(view))}>
            {t(m.resetView)}
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
  // the board's stage on a phone (#2703): not kept; none chosen = the first with a tile
  const [boardStage, setBoardStage] = useState<BacklogStage | null>(null);
  const changeView = (next: BacklogView) => {
    setView(next);
    saveView(localStorage, next);
  };
  const summary = viewSummary(view);
  const metaId = workspaces?.find((w) => w.kind === "meta")?.id ?? null;
  const projectVars = workspaces && Object.fromEntries(workspaces.map((w) => [w.id, w.projectVar]));
  const key = (i: BacklogItem) => `${i.workspaceId}:${i.number}`;
  // a remembered workspace that is no longer registered shows everything
  const current = workspaces && !workspaces.some((w) => w.id === shown) ? "" : shown;
  const now = Date.now();
  const inView = (workspaceId: string) => !current || workspaceId === current;
  // the stage cards (list) or columns (board) the stage chips leave, and the rows they show in the view's order
  const stages = STAGES.filter(([stage]) => view.stages.length === 0 || view.stages.includes(stage));
  const shownItems = data ? applyView(data.items.filter((i) => inView(i.workspaceId)), view) : [];
  const columns = stages.map(([stage, label]) => ({ stage, label, items: shownItems.filter((i) => i.stage === stage) }));
  const currentStage = columns.find((c) => c.stage === boardStage)?.stage ?? columns.find((c) => c.items.length > 0)?.stage ?? columns[0]?.stage;
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
        else props.onError(t(m.startFailed, { n: number, error: String(e.message ?? e) }));
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
        props.onError(t(m.githubReadFailed, { error: message }));
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

  const keptHere = (workspaceId: string) => workspaces?.find((w) => w.id === workspaceId)?.backlog === "switchboard";
  return (
    <KeptHere.Provider value={keptHere}>
    <main className="main backlog">
      <section className="card">
        <div className="row head">
          <h5>Backlog</h5>
          <span className="hint backlog-heading">{backlogHeading(data?.fetchedAt ?? null, busy, workspaces ? workspaces.filter((w) => inView(w.id)).map((w) => w.backlog) : null)}</span>
          <button className="ghost" disabled={busy} onClick={() => load(true)}>
            {t(m.reload)}
          </button>
          <ViewPicker view={view} onChange={changeView} />
          <button className="pri" onClick={() => props.onFeedback(current ? { id: current, name: currentName ?? current } : undefined)}>
            {t(m.fileRequest)}
          </button>
        </div>
        {summary && (
          <div className="hint backlog-view-line">
            {summary}{" "}
            <button className="ghost link" onClick={() => changeView(resetView(view))}>
              {t(m.resetView)}
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
                  {t(m.rescuePage)}
                </a>
              </>
            )}
          </div>
        )}
        {approvals > 0 && (
          <button className="ghost link" onClick={props.onOpenSchedules}>
            {t(m.approvalsWaiting, { n: approvals })}
          </button>
        )}
        {workspaces && workspaces.length > 1 && (
          <nav className="subtabs backlog-ws">
            <button className={current === "" ? "on" : ""} onClick={() => show("")}>
              {t(m.all)}
              {data ? ` ${data.items.length}` : ""}
            </button>
            {workspaces.map((w) => (
              <button key={w.id} className={current === w.id ? "on" : ""} onClick={() => show(w.id)}>
                {w.name}
                {data ? ` ${data.items.filter((i) => i.workspaceId === w.id).length}` : ""}
              </button>
            ))}
          </nav>
        )}
        {failure && <div className="muted">{t(m.githubReadFailed, { error: failure })}</div>}
        {data?.syncs.filter((x) => inView(x.workspaceId)).map((x) => (
          <div key={x.workspaceId} className="hint backlog-sync" data-workspace={x.workspaceId}>
            <SyncLine sync={x.sync} line={githubSyncText(x)} scope={data.syncs.length > 1 ? (workspaces?.find((w) => w.id === x.workspaceId)?.name ?? x.workspaceId) : undefined} />
            {x.creates.map((c) => (
              <div key={c.localId} className="m" data-sync={c.state}>
                {t(m.createNoNumber, { word: createWord(c.state), title: c.title })}
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

      {data && <Changes changes={data.changes.filter((c) => inView(c.workspaceId))} />}
      {data && view.layout === "board" && (
        <>
          {/* phones only (CSS): one stage at a time instead of the columns side by side */}
          <nav className="subtabs backlog-board-tabs">
            {columns.map(({ stage, label, items }) => (
              <button key={stage} className={stage === currentStage ? "on" : ""} data-stage={stage} onClick={() => setBoardStage(stage)}>
                {label} {items.length}
              </button>
            ))}
          </nav>
          <div className="backlog-board">
            {columns.map(({ stage, label, items }) => (
              <section key={stage} className="card backlog-col" data-stage={stage} data-current={stage === currentStage}>
                <h5>
                  {label} <span className="hint">{items.length}</span>
                </h5>
                {items.map((i) => (
                  <Tile key={key(i)} item={i} items={data.items} auto={auto[i.workspaceId] ?? false} now={now} starting={starting} metaId={metaId} onStart={(action) => start(i.workspaceId, i.number, action)} onContinue={(pbi) => start(i.workspaceId, pbi, "complete")} onOpenTask={props.onOpenTask} onAnswered={answered} onChanged={() => load(false)} onError={props.onError} />
                ))}
              </section>
            ))}
          </div>
        </>
      )}
      {data &&
        view.layout === "list" &&
        stages.map(([stage, label]) => {
          const items = shownItems.filter((i) => i.stage === stage);
          return (
            <section key={stage} className="card" data-stage={stage}>
              <div className="row head">
                <h5>
                  {label} <span className="hint">{items.length}</span>
                </h5>
              </div>
              {items.length === 0 && <div className="muted">{t(m.none)}</div>}
              {items.map((i) =>
                i.stage === "needs-decision" ? (
                  // a card, not a row: the whole title is the link, then the question and the answer box
                  <div key={key(i)} className="decision-card">
                    <h5 className="backlog-item">
                      <IssueLink url={i.url}>
                        #{i.number} {i.title}
                      </IssueLink>{" "}
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
                    <IssueLink url={i.url}>
                      #{i.number}
                    </IssueLink>{" "}
                    {i.title}
                  </span>
                  <ItemFacts item={i} now={now} onOpenTask={props.onOpenTask} />
                  <RowActions item={i} now={now} starting={starting} metaId={metaId} onStart={(action) => start(i.workspaceId, i.number, action)} onOpenTask={props.onOpenTask} />
                </div>
                <ItemDetail item={i} items={data.items} auto={auto[i.workspaceId] ?? false} starting={starting} onStart={(pbi) => start(i.workspaceId, pbi, "complete")} onOpenTask={props.onOpenTask} onChanged={() => load(false)} onError={props.onError} />
                </Fragment>
                ),
              )}
            </section>
          );
        })}
      <Flow />
      <Interventions inView={(workspaceId) => workspaceId === null || inView(workspaceId)} onOpenTask={props.onOpenTask} />
    </main>
    </KeptHere.Provider>
  );
}
