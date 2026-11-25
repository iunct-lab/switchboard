import { useEffect, useRef, useState } from "react";
import type { BacklogIssueDetail, Workspace } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { BACKLOG_CHANGED_EVENT, createWord, loadNewIssueDraft, NEW_ISSUE_DRAFT_EVENT, newIssueDraftKey, savedWords, type NewIssueDraft } from "../backlogSync.ts";
import { IssueLink } from "./BacklogOwner.tsx";
import { t } from "../i18n.ts";
import { backlog as m } from "../i18n/backlog.ts";
import { home } from "../i18n/home.ts";

/** One Issue made here, followed from its localId to the number GitHub gives it (and the row it then is). */
function Made(props: { workspaceId: string; localId: string; title: string; keptHere: boolean }) {
  const words = savedWords(props.keptHere);
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
 * 自分で書いて保存: a new Issue kept here and created on GitHub later, with no Task started. Made as a request or a PBI (the
 * labels the Backlog lists by), its localId is followed to the number; what is typed stays until it is kept. It sits in the
 * instruction form's 詳細; an open Backlog reads its list again when one is saved.
 */
export function SaveIssue(props: { workspaces: Workspace[]; current: string }) {
  const keptHere = (workspaceId: string) => props.workspaces.find((w) => w.id === workspaceId)?.backlog === "switchboard";
  const [ws, setWs] = useState(props.current || props.workspaces[0]?.id || "");
  const [saved] = useState(() => loadNewIssueDraft(localStorage, newIssueDraftKey(ws)));
  const [kind, setKind] = useState<NewIssueDraft["kind"]>(saved?.kind ?? "type:request");
  const [title, setTitle] = useState(saved?.title ?? "");
  const [body, setBody] = useState(saved?.body ?? "");
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [made, setMade] = useState<Array<{ workspaceId: string; localId: string; title: string }>>([]);
  // two of these can be on one page (Home's form and the dialog opened over it), on the same stored draft: each tells the
  // other when it writes or clears it, and the other shows what is stored instead of writing its older copy over it
  const me = useRef({});
  const tell = (key: string) => dispatchEvent(new CustomEvent(NEW_ISSUE_DRAFT_EVENT, { detail: { key, from: me.current } }));
  const keep = (d: NewIssueDraft) => {
    localStorage.setItem(newIssueDraftKey(ws), JSON.stringify(d));
    tell(newIssueDraftKey(ws));
  };
  useEffect(() => {
    const changed = (e: Event) => {
      const { key, from } = (e as CustomEvent<{ key: string; from: unknown }>).detail;
      if (from !== me.current && key === newIssueDraftKey(ws) && !saving) switchTo(ws);
    };
    addEventListener(NEW_ISSUE_DRAFT_EVENT, changed);
    return () => removeEventListener(NEW_ISSUE_DRAFT_EVENT, changed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, saving]);
  // the workspace chosen above is where a new Issue goes: follow it when it changes (the first value is the initial one)
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
    const d = loadNewIssueDraft(localStorage, newIssueDraftKey(w));
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
        setMade((list) => [...list, { workspaceId: ws, localId: r.localId, title }]);
        localStorage.removeItem(newIssueDraftKey(ws));
        tell(newIssueDraftKey(ws));
        setTitle("");
        setBody("");
        setNote(savedWords(keptHere(ws)).created);
        dispatchEvent(new Event(BACKLOG_CHANGED_EVENT));
      })
      .catch((e) => setNote(t(m.createFailed, { error: String(e.message ?? e) })))
      .finally(() => setSaving(false));
  };
  return (
    <details className="compose-save" data-compose-save open={saved !== null || undefined}>
      <summary>{t(home.saveIssue)}</summary>
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
      <button disabled={saving || !title.trim() || !ws} onClick={create}>
        {t(m.saveLocally)}
      </button>
      {note && <div className="hint backlog-note">{note}</div>}
      {made.map((x) => (
        <Made key={x.localId} {...x} keptHere={keptHere(x.workspaceId)} />
      ))}
    </details>
  );
}
