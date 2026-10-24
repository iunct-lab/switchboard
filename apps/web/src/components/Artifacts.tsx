import { useEffect, useRef, useState } from "react";
import type { Artifact } from "@switchboard/protocol";
import { api } from "../api.ts";
import { pickArtifact, viewOf } from "../artifacts.ts";

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
        if (want) setErr(pick.gone ? "その成果物は消されています" : null);
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
      <div className="art-strip" role="tablist" aria-label="成果物">
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
            <button className="art-x" aria-label={`${a.title} を消す`} title="消す" onClick={() => remove(a)}>
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
          <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="パスか URL（作業ディレクトリからの相対も可）" aria-label="成果物のパスか URL" />
          <button type="submit" disabled={busy || !source.trim()}>
            追加
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
          「{undo.title}」を消しました
          <button className="ghost" onClick={restore}>
            元に戻す
          </button>
        </div>
      )}
      {current ? <ArtifactBody key={`${current.id}:${current.updatedAt}`} a={current} shown={!props.hidden} onRefreshed={() => load().catch((e) => setErr(`一覧を読み直せません: ${String((e as Error).message ?? e)}`))} /> : <div className="muted art-empty">Task が作ったレポートのパス（HTML・画像・テキストなど）か URL を入れると、ここで開けます。登録するとコピーを残すので、元のファイルが消えても見られます。</div>}
    </div>
  );
}

/** One artifact opened in place (frame / image / text, 全画面, 取り直す). Also the body of a report on Insights (#1835). */
export function ArtifactBody(props: { a: Artifact; shown: boolean; onRefreshed: () => void }) {
  const { a } = props;
  const how = viewOf(a);
  const [url, setUrl] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
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
      if (e.key === "Escape") closeFull();
    };
    addEventListener("popstate", onPop);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("popstate", onPop);
      removeEventListener("keydown", onKey);
    };
  }, [full]);
  // A view key lasts an hour (#1782): the tab stays mounted, so ask again when it is shown after a long time away.
  const keyAt = useRef(0);
  useEffect(() => {
    if (a.kind === "url" || !props.shown || (url !== null && (how !== "text" || text !== null) && Date.now() - keyAt.current < KEY_REUSE_MS)) return;
    let live = true;
    api
      .viewArtifact(a.id)
      .then(async ({ url: u }) => {
        if (!live) return;
        keyAt.current = Date.now();
        setUrl(u);
        if (how === "text") {
          const r = await fetch(u);
          const body = await r.text();
          if (live) setText(r.ok ? body : `読み込めません（${r.status}）`);
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
      setErr(`取り直せません: ${String((e as Error).message ?? e)}（前の内容のまま開けます）`);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="art-body">
      <div className="art-meta hint">
        <span className="mono" title={a.source}>{a.source}</span>
        {a.kind !== "url" && how !== "external" && url && (
          <button className="art-full-open" onClick={openFull}>
            全画面
          </button>
        )}
        {a.kind !== "url" && (
          <button className="ghost" onClick={refresh} disabled={refreshing}>
            {refreshing ? "取り直し中…" : "取り直す"}
          </button>
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
            新しいタブで開く
          </a>
          <p className="muted">外部のリンクは切れることがあります。</p>
        </div>
      )}
      {a.kind !== "url" && how === "frame" && url && !full && <iframe className="art-frame" title={a.title} sandbox="allow-scripts" src={url} />}
      {a.kind !== "url" && how === "image" && url && <img className="art-image" alt={a.title} src={url} />}
      {a.kind !== "url" && how === "text" && <pre className="art-text">{text ?? "読み込み中…"}</pre>}
      {full && url && (
        <div className="art-full" role="dialog" aria-modal="true" aria-label={`${a.title}（全画面）`}>
          <div className="art-full-bar">
            <button onClick={closeFull} autoFocus>
              ← 戻る
            </button>
            <span className="art-full-title" title={a.source}>
              {a.title}
            </span>
            <button className="ghost" onClick={() => openFresh(false)}>
              新しいタブ
            </button>
          </div>
          {how === "frame" && <iframe className="art-frame" title={a.title} sandbox="allow-scripts" src={url} />}
          {how === "image" && (
            <div>
              <img className="art-image" alt={a.title} src={url} />
            </div>
          )}
          {how === "text" && <pre className="art-text">{text ?? "読み込み中…"}</pre>}
        </div>
      )}
      {a.kind !== "url" && how === "external" && url && (
        <div className="art-open">
          <button className="btn" onClick={() => openFresh(false)}>
            新しいタブで開く
          </button>
          <button className="btn ghost" onClick={() => openFresh(true)}>
            ダウンロード
          </button>
        </div>
      )}
    </div>
  );
}
