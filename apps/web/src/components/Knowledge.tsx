import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeDoc, KnowledgeSearchHit, Workspace } from "@switchboard/protocol";
import { api, type KnowledgeIndex, type KnowledgeDocDetail, type MaterializeFile } from "../api.ts";
import { jstDateTime } from "../time.ts";
import { t } from "../i18n.ts";
import { brief as m } from "../i18n/brief.ts";

const KIND_LABEL: Record<KnowledgeDoc["kind"], string> = { rules: "rules/", commands: "commands/", notes: "notes/", docs: "docs/", other: t(m.kindOther) };
const KIND_ORDER: KnowledgeDoc["kind"][] = ["rules", "commands", "notes", "docs", "other"];

/** Screen C (left half): the Markdown folder as the source of truth — browse, search (FTS5), preview. */
export function Knowledge(props: { refreshKey: number; workspaces: Workspace[]; onError: (msg: string) => void }) {
  const { refreshKey, onError } = props;
  const [index, setIndex] = useState<KnowledgeIndex | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<KnowledgeSearchHit[] | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeDocDetail | null>(null);
  // Sequence counters: a slow response for an older query/selection must not overwrite a newer one.
  const searchSeq = useRef(0);
  const docSeq = useRef(0);

  const load = useCallback(() => api.knowledge().then(setIndex).catch((e) => onError(String(e.message ?? e))), [onError]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    const seq = ++searchSeq.current;
    if (!q.trim()) {
      setHits(null);
      setSearchErr(null);
      return;
    }
    const h = setTimeout(() => {
      api
        .knowledgeSearch(q)
        .then((r) => {
          if (seq !== searchSeq.current) return;
          setHits(r);
          setSearchErr(null);
        })
        .catch((e) => {
          if (seq !== searchSeq.current) return;
          setHits([]);
          setSearchErr(String(e.message ?? e));
        });
    }, 200);
    return () => clearTimeout(h);
  }, [q]);

  useEffect(() => {
    const seq = ++docSeq.current;
    if (!selected) {
      setDetail(null);
      return;
    }
    api
      .knowledgeDoc(selected)
      .then((d) => {
        if (seq === docSeq.current) setDetail(d);
      })
      .catch((e) => {
        if (seq === docSeq.current) onError(String(e.message ?? e));
      });
  }, [selected, refreshKey, onError]);

  const grouped = useMemo(() => {
    const g = new Map<KnowledgeDoc["kind"], KnowledgeDoc[]>();
    for (const d of index?.docs ?? []) g.set(d.kind, [...(g.get(d.kind) ?? []), d]);
    return g;
  }, [index]);

  return (
    <main className="main knowledge">
      <section className="card kn-list">
        <div className="row head">
          <h5>Knowledge</h5>
          <span className="hint mono" title={index?.dir ?? ""}>
            {index ? shorten(index.dir) : "…"}
            {index && (index.git.isRepo ? (index.git.clean === false ? t(m.gitDirty) : t(m.gitClean)) : t(m.gitNone))}
          </span>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t(m.searchPlaceholder)} />
        {hits ? (
          <div className="kn-tree">
            {searchErr && <div className="warn">{t(m.searchFailed, { error: searchErr })}</div>}
            {!searchErr && hits.length === 0 && <div className="muted">{t(m.noHits)}</div>}
            {hits.length >= 30 && <div className="hint">{t(m.top30)}</div>}
            {hits.map((h) => (
              <button key={h.path} className={`it ${selected === h.path ? "on" : ""}`} onClick={() => setSelected(h.path)} title={h.path}>
                <span className="t">{h.title}</span>
                <span className="snip">{h.snippet}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="kn-tree">
            {KIND_ORDER.filter((k) => grouped.has(k)).map((k) => (
              <div key={k}>
                <div className="grp">{KIND_LABEL[k]}</div>
                {grouped.get(k)!.map((d) => (
                  <button key={d.path} className={`it ${selected === d.path ? "on" : ""}`} onClick={() => setSelected(d.path)} title={d.path}>
                    <span className="t">{d.title}</span>
                    {d.frontmatter.targets && <span className="tag">{d.frontmatter.targets.join(" ")}</span>}
                    {d.frontmatter._invalid && <span className="tag warn" title={d.frontmatter._invalid}>{t(m.badFrontmatter)}</span>}
                  </button>
                ))}
              </div>
            ))}
            {index?.disabled && <div className="warn">{t(m.folderUnavailable, { reason: index.disabled })}</div>}
            {index && !index.disabled && index.docs.length === 0 && <div className="muted">{t(m.noDocs, { dir: index.dir })}</div>}
          </div>
        )}
        <div className="row sub">
          <span className="hint">{index ? t(m.docCount, { n: index.docs.length }) : ""}</span>
          <button className="ghost" onClick={() => api.knowledgeReindex().then(load).catch(() => undefined)}>
            {t(m.reindex)}
          </button>
        </div>
      </section>

      <section className="card kn-doc">
        {!detail && <div className="muted">{t(m.pickDoc)}</div>}
        {detail && (
          <>
            <div className="row head">
              <h5>{detail.doc.path}</h5>
              <span className="hint">{jstDateTime(detail.doc.mtime)}</span>
            </div>
            <Frontmatter fm={detail.doc.frontmatter} />
            <pre className="kn-body">{detail.body}</pre>
          </>
        )}
      </section>

      <div style={{ display: "grid", gap: 12 }}>
        <Materialize workspaces={props.workspaces} refreshKey={props.refreshKey} onError={props.onError} />
        <Materialize cleanup workspaces={props.workspaces} refreshKey={props.refreshKey} onError={props.onError} />
      </div>
    </main>
  );
}

const STATUS_LABEL: Record<MaterializeFile["status"], string> = { new: t(m.statusNew), changed: t(m.statusChanged), unchanged: t(m.statusUnchanged), removed: t(m.statusRemoved) };

/** Screen C (right half): where the knowledge gets written, with a diff preview before writing user-level files or removing old repository blocks. */
function Materialize(props: { cleanup?: boolean; workspaces: Workspace[]; refreshKey: number; onError: (msg: string) => void }) {
  const { workspaces, refreshKey, onError, cleanup = false } = props;
  const [wsId, setWsId] = useState("");
  const [files, setFiles] = useState<MaterializeFile[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [force, setForce] = useState(false);
  const [confirmPaths, setConfirmPaths] = useState<string[] | null>(null);
  const [warnings, setWarnings] = useState<Array<{ path: string; message: string }>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    const my = ++seq.current;
    setFiles(null);
    setWarnings([]);
    setConfirmPaths(null);
    if (cleanup && !wsId) return Promise.resolve();
    return api
      .materializePreview(cleanup ? wsId : undefined)
      .then((r) => {
        if (my === seq.current) { setFiles(r.files); setWarnings(r.warnings); }
      })
      .catch((e) => { if (my === seq.current) onError(String(e.message ?? e)); });
  }, [cleanup, wsId, onError]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
      await load();
    } catch (e) {
      onError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  const applyFiles = (paths?: string[]) =>
    run(async () => {
      const expected: Record<string, string> = {};
      for (const f of files ?? []) if (!paths || paths.includes(f.relPath)) expected[f.relPath] = f.hash;
      const r = await api.materializeApply(cleanup ? wsId : undefined, { paths, expected, force });
      const parts = [r.written.length ? t(m.written, { paths: r.written.join(", ") }) : "", r.removed.length ? t(m.removed, { paths: r.removed.join(", ") }) : "", r.skipped.length ? t(m.skipped, { items: r.skipped.map((s) => t(m.skippedItem, { path: s.relPath, reason: s.reason === "conflict" ? t(m.handEdited) : t(m.previewStale) })).join(", ") }) : ""].filter(Boolean);
      setNotice(parts.join(" · ") || t(m.noChange));
    });
  const pending = (files ?? []).filter((f) => f.status !== "unchanged");
  const hasConflict = pending.some((f) => f.conflicts.length > 0);

  const requestApply = (paths?: string[]) => {
    if (cleanup) setConfirmPaths(paths ?? pending.map((f) => f.relPath));
    else void applyFiles(paths);
  };

  return (
    <section className="card kn-mat">
      <div className="row head">
        <h5>{cleanup ? t(m.cleanupHeading) : t(m.targetHeading)}</h5>
        {cleanup ? (
          <select aria-label={t(m.cleanupRepoLabel)} disabled={busy} value={wsId} onChange={(e) => { ++seq.current; setFiles(null); setConfirmPaths(null); setNotice(null); setForce(false); setOpen(null); setWsId(e.target.value); }}>
            <option value="">{t(m.pickRepo)}</option>
            {workspaces.filter((w) => w.kind === "repo").map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        ) : <span className="hint">{t(m.userLevel)}</span>}
      </div>
      {warnings.map((w) => <div className="hint warn" key={w.path}>{w.path}: {w.message}</div>)}
      {files && files.length === 0 && <div className="muted">{cleanup ? t(m.noBlocksLeft) : t(m.noSharedDocs)}</div>}
      {(files ?? []).map((f) => (
        <div key={f.relPath} className="mat-file">
          <button className="row link" onClick={() => setOpen(open === f.relPath ? null : f.relPath)} title={f.sources.join("\n")}>
            <span className="t mono">{f.relPath}</span>
            <span className="tag">{t(m.managed, { n: f.sources.length })}</span>
            {f.conflicts.length > 0 && <span className="tag warn" title={t(m.handEditedTitle, { blocks: f.conflicts.join(", ") })}>{t(m.handEdited)}</span>}
            <span className={`m ${f.status}`}>{STATUS_LABEL[f.status]}</span>
          </button>
          {open === f.relPath && (
            <>
              {f.diff ? <pre className="diff">{f.diff}</pre> : <pre className="diff muted">{t(m.noDiffPlain)}</pre>}
              {f.status !== "unchanged" && (
                <div className="row sub">
                  <button disabled={busy || (f.conflicts.length > 0 && !force)} onClick={() => requestApply([f.relPath])}>
                    {t(m.applyThisFile)}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ))}
      {notice && <div className="hint">{notice}</div>}
      <div className="row sub">
        <button className="pri" disabled={busy || pending.length === 0} onClick={() => requestApply()}>
          {t(m.applyN, { n: pending.length })}
        </button>
        {hasConflict && (
          <label className="hint">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> {t(m.forceOverwrite)}
          </label>
        )}
      </div>
      {confirmPaths && (
        <div className="hint warn" role="dialog" aria-label={t(m.cleanupConfirmLabel)}>
          {t(m.cleanupConfirm, { n: confirmPaths.length })}
          {(files ?? []).filter((f) => confirmPaths.includes(f.relPath)).map((f) => (
            <div key={f.relPath}>
              <span className="mono">{f.relPath}</span>
              <pre className="diff">{f.diff}</pre>
            </div>
          ))}
          <button className="pri" disabled={busy} onClick={() => { const paths = confirmPaths; setConfirmPaths(null); void applyFiles(paths); }}>{t(m.removeBlocks)}</button>
          <button className="ghost" disabled={busy} onClick={() => setConfirmPaths(null)}>{t(m.cancel)}</button>
        </div>
      )}
      <div className="hint">{t(m.handWrittenStays)}</div>
    </section>
  );
}

function Frontmatter(props: { fm: KnowledgeDoc["frontmatter"] }) {
  const entries = Object.entries(props.fm).filter(([k]) => k !== "_invalid");
  if (entries.length === 0 && !props.fm._invalid) return null;
  return (
    <div className="kv fm">
      {entries.map(([k, v]) => (
        <span key={k} className="fm-row">
          <span className="k">{k}</span>
          <span className="mono">{typeof v === "string" ? v : JSON.stringify(v)}</span>
        </span>
      ))}
      {props.fm._invalid && <span className="warn">{t(m.invalidFrontmatter, { reason: props.fm._invalid })}</span>}
    </div>
  );
}

function shorten(p: string) {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}
