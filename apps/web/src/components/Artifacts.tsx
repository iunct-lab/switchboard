import { type MouseEvent, useEffect, useRef, useState } from "react";
import type { Artifact } from "@switchboard/protocol";
import { type AppUse, api, apiRaw } from "../api.ts";
import { appRequestDraft, appRequestOf, copyKind, frameUnavailable, isMarkdown, pickArtifact, viewOf } from "../artifacts.ts";
import { requestFeedback } from "./Feedback.tsx";
import { viewPath } from "../route.ts";
import { t } from "../i18n.ts";
import { panels as m } from "../i18n/panels.ts";
import { Markdown, MdViewToggle } from "./Markdown.tsx";
import { useMdView } from "../mdView.ts";
import { type BridgeRequest, createBridge } from "../scratchBridge.ts";
import { CopyButton } from "./ui.tsx";

export const UNDO_MS = 5000;
/** A fetched view url is used again for this long (the daemon's key lasts an hour). */
const KEY_REUSE_MS = 30 * 60 * 1000;

/** The 成果物 tab of a Task (#1777): register a file / folder / URL, switch between them, open, refresh, remove with undo. */
export function Artifacts(props: { taskId: string; openId?: string; /** bumped by each request to open (#1778): the same id opens again */ openSeq?: number; hidden?: boolean; onCount: (n: number) => void }) {
  const [items, setItems] = useState<Artifact[]>([]);
  const [sel, setSel] = useState<string | null>(props.openId ?? null);
  const selRef = useRef(sel); // the selection as the list reads below see it
  useEffect(() => {
    selRef.current = sel;
  }, [sel]);
  const [source, setSource] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<Artifact | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = () =>
    api.listArtifacts(props.taskId).then((list) => {
      setItems(list);
      props.onCount(list.length);
      return list;
    });
  useEffect(() => {
    setUndo(null);
    return () => clearTimeout(undoTimer.current);
  }, [props.taskId]);
  // One read of the list for the mount and for each request to open one (#1778 a row of the conversation, #1835 Insights'
  // list — also while the tab is already mounted, and again on every press of the same row, by openSeq): the list is read
  // first (the agent may have registered the artifact since the tab was opened), then `pickArtifact` says what is selected;
  // a requested one that is gone since says so.
  useEffect(() => {
    let live = true;
    const want = props.openId;
    load().then(
      (list) => {
        if (!live) return;
        const pick = pickArtifact(list, want, selRef.current);
        setSel(pick.id);
        if (want) setErr(pick.gone ? t(m.artifactGone) : null);
      },
      (e) => live && setErr(String((e as Error).message ?? e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load reads props.taskId, in the deps
  }, [props.taskId, props.openId, props.openSeq]);

  const add = async () => {
    if (!source.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const a = await api.addArtifact(props.taskId, { source: source.trim() });
      setSource("");
      await load();
      setSel(a.id);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (a: Artifact) => {
    setErr(null);
    try {
      await api.removeArtifact(a.id);
      const list = await load();
      if (sel === a.id) setSel(list[0]?.id ?? null);
      setUndo(a);
      clearTimeout(undoTimer.current);
      undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  const restore = async () => {
    if (!undo) return;
    const a = undo;
    setUndo(null);
    setErr(null);
    clearTimeout(undoTimer.current);
    try {
      await api.restoreArtifact(a.id);
      await load();
      setSel(a.id);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  const current = items.find((a) => a.id === sel) ?? null;
  return (
    <div className="artifacts" hidden={props.hidden}>
      <div className="art-strip" role="tablist" aria-label={t(m.artifacts)}>
        {items.map((a) => (
          <span key={a.id} className={`art-tab${a.id === sel ? " on" : ""}`}>
            <button
              role="tab"
              aria-selected={a.id === sel}
              onClick={() => {
                setErr(null); // a choice on the strip ends the message of a row's request too (#1778)
                setSel(a.id);
              }}
              title={a.source}
            >
              {a.title}
            </button>
            <button className="art-x" aria-label={t(m.removeNamed, { title: a.title })} title={t(m.remove)} onClick={() => remove(a)}>
              ×
            </button>
          </span>
        ))}
        <form
          className="art-add"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input value={source} onChange={(e) => setSource(e.target.value)} placeholder={t(m.sourcePlaceholder)} aria-label={t(m.sourceLabel)} />
          <button type="submit" disabled={busy || !source.trim()}>
            {t(m.add)}
          </button>
        </form>
      </div>
      {err && (
        <div className="warn" role="alert">
          {err}
        </div>
      )}
      {undo && (
        <div className="hint art-undo" role="status">
          {t(m.removed, { title: undo.title })}
          <button className="ghost" onClick={restore}>
            {t(m.undo)}
          </button>
        </div>
      )}
      {current ? <ArtifactBody key={`${current.id}:${current.updatedAt}`} a={current} shown={!props.hidden} onRefreshed={() => load().catch((e) => setErr(t(m.reloadListFailed, { error: String((e as Error).message ?? e) })))} /> : <div className="muted art-empty">{t(m.artifactsEmpty)}</div>}
    </div>
  );
}

/** One artifact opened in place (frame / image / text, 全画面, 取り直す). Also the body of a report on Insights (#1835). */
export function ArtifactBody(props: { a: Artifact; shown: boolean; onRefreshed: () => void }) {
  const { a } = props;
  const how = viewOf(a);
  const md = isMarkdown(a);
  const copy = copyKind(a);
  const read = how === "text" || copy === "content"; // a page or an SVG is read as text too, for コピー (#3687); the frame still loads its url
  const [mdView] = useMdView();
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [readOk, setReadOk] = useState(false);
  const [readStatus, setReadStatus] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 全画面 (#1826): the report over the whole screen, and three ways back to the Task screen — the 戻る button, Esc, and
  // the browser's / phone's back (an entry of its own in the history, so back closes it instead of leaving the app).
  const [full, setFull] = useState(false);
  const openFull = () => {
    history.pushState({ ...(history.state ?? {}), sbArtifactFull: a.id }, "");
    setFull(true);
    // the inline url may be older than the key's hour (the tab stays mounted): the frame below loads a fresh one
    if (Date.now() - keyAt.current > KEY_REUSE_MS)
      api.viewArtifact(a.id).then(({ url: u }) => {
        keyAt.current = Date.now();
        setUrl(u);
      }, (e) => setErr(String((e as Error).message ?? e)));
  };
  // Not history.back(): a link inside the report (its table of contents) adds entries of its own, and back would only
  // move inside the report. The entry pushed on open stays; a later back over it changes nothing on screen.
  const closeFull = () => setFull(false);
  useEffect(() => {
    if (!full) return;
    const onPop = () => setFull(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !askRef.current) closeFull(); // an open write confirm takes Esc for itself
    };
    addEventListener("popstate", onPop);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("popstate", onPop);
      removeEventListener("keydown", onKey);
    };
  }, [full]);
  // The artifact bridge (docs/design/scratch-apps.md): the frame stays opaque; a GET /api it posts is read here and
  // answered to that frame only — a message from any other window or another artifact's frame is ignored.
  // A write waits for the person in ScratchConfirm, one at a time (the bridge queues the next until this one closes).
  const inlineFrame = useRef<HTMLIFrameElement>(null);
  const fullFrame = useRef<HTMLIFrameElement>(null);
  const [ask, setAsk] = useState<{ req: BridgeRequest; answer: (yes: boolean) => void } | null>(null);
  const askRef = useRef(ask);
  askRef.current = ask;
  // A throwaway app (#3683): the first request through the bridge tells the daemon the page was used today (it counts a
  // day once and starts a request on the 3rd); the answer says whether that request was started.
  const [use, setUse] = useState<AppUse>({ appDays: a.appDays, appRequestTaskId: a.appRequestTaskId });
  const [usedNow, setUsedNow] = useState(false);
  const told = useRef(false);
  // Leaving the artifact (another tab hides it, or it unmounts) declines what is asked and what waits behind it (#3880)
  const shownRef = useRef(props.shown);
  useEffect(() => {
    shownRef.current = props.shown;
    if (!props.shown) askRef.current?.answer(false);
  }, [props.shown]);
  useEffect(() => {
    let closed = false;
    const bridge = createBridge({
      frames: () => [inlineFrame.current?.contentWindow, fullFrame.current?.contentWindow].filter(Boolean),
      call: (r) => {
        if (!told.current) {
          told.current = true;
          setUsedNow(true);
          api.artifactAppUse(a.id).then((u) => !closed && setUse(u), () => undefined); // not counted: the page reads all the same
        }
        return apiRaw(r.path, r.method === "GET" ? undefined : { method: r.method, ...(r.body !== undefined ? { body: JSON.stringify(r.body) } : {}) });
      },
      confirm: (req) =>
        closed || !shownRef.current
          ? Promise.resolve(false)
          : new Promise<boolean>((resolve) =>
          setAsk({
            req,
            answer: (yes) => {
              setAsk(null);
              resolve(yes);
            },
          }),
        ),
      reply: (to, result) => (to as Window).postMessage(result, "*"), // an opaque origin can only be named as "*"; the window is fixed to the asker
      // a screen of Switchboard's own (the path is checked): a new history entry, so back returns here; App's popstate
      // handler shows it, as for the browser's own back / forward
      navigate: (path) => {
        if (closed || !shownRef.current || location.pathname === path) return;
        history.pushState(null, "", path);
        dispatchEvent(new PopStateEvent("popstate"));
      },
    });
    const onMessage = (e: MessageEvent) => void bridge({ source: e.source, data: e.data });
    addEventListener("message", onMessage);
    return () => {
      closed = true;
      removeEventListener("message", onMessage);
      askRef.current?.answer(false);
    };
  }, []);
  // A view key lasts an hour (#1782): the tab stays mounted, so ask again when it is shown after a long time away.
  const keyAt = useRef(0);
  useEffect(() => {
    // a frame's page is checked again when its check did not finish (hidden while it read, #4062)
    if (a.kind === "url" || !props.shown || (url !== null && (!read || text !== null) && (how !== "frame" || readStatus !== null) && Date.now() - keyAt.current < KEY_REUSE_MS)) return;
    let live = true;
    api
      .viewArtifact(a.id)
      .then(async ({ url: u }) => {
        if (!live) return;
        keyAt.current = Date.now();
        setUrl(u);
        // a page in a frame is read too (a folder's entry as well, #4062): its status tells whether the frame can show it
        if (read || how === "frame") {
          const r = await fetch(u);
          const body = await r.text();
          if (!live) return;
          setReadStatus(r.status);
          if (read) {
            setText(r.ok ? body : t(m.cannotRead, { status: r.status }));
            setReadOk(r.ok); // コピー copies the file, never the error shown in its place
          }
        }
      })
      .catch((e) => live && setErr(String((e as Error).message ?? e)));
    return () => {
      live = false;
    };
  }, [a.id, a.updatedAt, props.shown]);

  // The key in a url lasts an hour and the page may have sat for longer: a new tab or a download asks for a fresh one.
  const openFresh = async (download: boolean) => {
    const w = download ? null : window.open("about:blank", "_blank");
    if (w) w.opener = null;
    try {
      const { url: fresh } = await api.viewArtifact(a.id);
      if (w) w.location.href = fresh;
      else {
        const link = document.createElement("a");
        link.href = fresh;
        link.download = a.entry ?? a.title;
        link.click();
      }
    } catch (e) {
      w?.close();
      setErr(String((e as Error).message ?? e));
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    setErr(null);
    try {
      await api.refreshArtifact(a.id);
      props.onRefreshed();
    } catch (e) {
      setErr(t(m.refreshFailed, { error: String((e as Error).message ?? e) }));
    } finally {
      setRefreshing(false);
    }
  };

  const app = appRequestOf(use, usedNow);
  // 要望にする (#3683): the dialog names the artifact's Task by its title; a screen that has no title for it (判断待ち's
  // mockups) reads it first, and the id stands in only when that read fails
  const openAppRequest = async () => {
    let taskTitle = "taskTitle" in a && typeof a.taskTitle === "string" ? a.taskTitle : undefined;
    if (taskTitle === undefined) {
      const r = await apiRaw(`/api/tasks/${encodeURIComponent(a.taskId)}?limit=0`).catch(() => null);
      const title = (r?.body as { task?: { title?: unknown } } | undefined)?.task?.title;
      if (r && r.status === 200 && typeof title === "string") taskTitle = title;
    }
    requestFeedback({ text: appRequestDraft(a.title), source: { kind: "artifact", artifactId: a.id }, artifact: { title: a.title, taskId: a.taskId, ...(taskTitle !== undefined ? { taskTitle } : {}) } });
  };
  const openTaskPath = (id: string) => (e: MouseEvent) => {
    e.preventDefault();
    history.pushState(null, "", viewPath({ name: "task", id }));
    dispatchEvent(new PopStateEvent("popstate"));
  };

  // A .md in the preview (#3677) once its text is read; everything else (and the switch on テキスト) as it was.
  const textBody = md && mdView === "preview" && text !== null
    ? <div className="art-text"><Markdown text={text} /></div>
    : <pre className="art-text">{text ?? t(m.loading)}</pre>;

  return (
    <div className="art-body">
      <div className="art-meta hint">
        <span className="mono" title={a.source}>{a.source}</span>
        {md && <MdViewToggle />}
        {/* the file's own text even while a .md shows its preview */}
        {(copy === "url" || (copy === "content" && readOk)) && <CopyButton text={() => (copy === "url" ? a.source : (text ?? ""))} onError={setErr} />}
        {a.kind !== "url" && how !== "external" && url && !frameUnavailable(readStatus) && (
          <button className="art-full-open" onClick={openFull}>
            {t(m.fullScreen)}
          </button>
        )}
        {a.kind !== "url" && (
          <button className="ghost" onClick={refresh} disabled={refreshing}>
            {refreshing ? t(m.refreshing) : t(m.refresh)}
          </button>
        )}
        {app.offer && (
          <button className="ghost art-app-request" title={t(m.appRequestTitle)} onClick={openAppRequest}>
            {t(m.appRequest)}
          </button>
        )}
        {app.taskId && (
          <a className="art-app-task" href={viewPath({ name: "task", id: app.taskId })} onClick={openTaskPath(app.taskId)}>
            {t(m.appRequestStarted)}
          </a>
        )}
      </div>
      {err && (
        <div className="warn" role="alert">
          {err}
        </div>
      )}
      {a.kind === "url" && (
        <div className="art-open">
          <a className="btn" href={a.source} target="_blank" rel="noopener noreferrer">
            {t(m.openNewTab)}
          </a>
          <p className="muted">{t(m.externalNote)}</p>
        </div>
      )}
      {a.kind !== "url" && how === "frame" && url && !full && !frameUnavailable(readStatus) && <iframe ref={inlineFrame} className="art-frame" title={a.title} sandbox="allow-scripts" src={url} />}
      {a.kind !== "url" && how === "frame" && frameUnavailable(readStatus) && <div className="muted">{t(m.cannotRead, { status: readStatus! })}</div>}
      {a.kind !== "url" && how === "image" && url && <img className="art-image" alt={a.title} src={url} />}
      {a.kind !== "url" && how === "text" && textBody}
      {full && url && (
        <div className="art-full" role="dialog" aria-modal="true" aria-label={t(m.fullLabel, { title: a.title })}>
          <div className="art-full-bar">
            <button onClick={closeFull} autoFocus>
              {t(m.back)}
            </button>
            <span className="art-full-title" title={a.source}>
              {a.title}
            </span>
            {md && <MdViewToggle />}
            <button className="ghost" onClick={() => openFresh(false)}>
              {t(m.newTab)}
            </button>
          </div>
          {how === "frame" && frameUnavailable(readStatus) && <div className="muted">{t(m.cannotRead, { status: readStatus! })}</div>}
          {how === "frame" && !frameUnavailable(readStatus) && <iframe ref={fullFrame} className="art-frame" title={a.title} sandbox="allow-scripts" src={url} />}
          {how === "image" && (
            <div>
              <img className="art-image" alt={a.title} src={url} />
            </div>
          )}
          {how === "text" && textBody}
        </div>
      )}
      {ask && <ScratchConfirm title={a.title} req={ask.req} answer={ask.answer} />}
      {a.kind !== "url" && how === "external" && url && (
        <div className="art-open">
          <button className="btn" onClick={() => openFresh(false)}>
            {t(m.openNewTab)}
          </button>
          <button className="btn ghost" onClick={() => openFresh(true)}>
            {t(m.download)}
          </button>
        </div>
      )}
    </div>
  );
}

/** The longest body shown in the confirm; the rest is cut (the request still sends all of it). */
export const CONFIRM_BODY_MAX = 2_000;
/** 実行する takes a press only after this long. */
const CONFIRM_ARM_MS = 500;

/**
 * The confirm before an artifact's write goes to the API (docs/design/scratch-apps.md): what it would do, once. The
 * focus starts on やめる; Esc and a press outside the box are やめる too. No "don't ask again" (ui-layers.md).
 */
function ScratchConfirm(props: { title: string; req: BridgeRequest; answer: (yes: boolean) => void }) {
  const { req, answer } = props;
  // a click meant for the page under the dialog (a double click on its button) must not land on 実行する
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") answer(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [answer]);
  const body = req.body === undefined ? "" : JSON.stringify(req.body, null, 2) ?? "";
  const shown = body.length > CONFIRM_BODY_MAX ? `${body.slice(0, CONFIRM_BODY_MAX)}\n${t(m.bodyCut, { n: CONFIRM_BODY_MAX.toLocaleString() })}` : body;
  return (
    <div className="recent-check scratch-confirm" role="alertdialog" aria-modal="true" aria-label={t(m.confirmLabel)} onClick={(e) => e.target === e.currentTarget && answer(false)}>
      <div className="recent-check-box">
        <p>{t(m.confirmText, { title: props.title })}</p>
        <pre className="scratch-confirm-req">{`${req.method} ${req.path}${shown ? `\n\n${shown}` : ""}`}</pre>
        <div className="scratch-confirm-actions">
          <button autoFocus onClick={() => answer(false)}>
            {t(m.cancel)}
          </button>
          <button disabled={!armed} onClick={() => answer(true)}>
            {t(m.run)}
          </button>
        </div>
      </div>
    </div>
  );
}
