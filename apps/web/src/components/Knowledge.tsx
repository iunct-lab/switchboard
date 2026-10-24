import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeDoc, KnowledgeSearchHit, Workspace } from "@switchboard/protocol";
import { api, type KnowledgeIndex, type KnowledgeDocDetail, type MaterializeFile } from "../api.ts";
import { jstDateTime } from "../time.ts";

const KIND_LABEL: Record<KnowledgeDoc["kind"], string> = { rules: "rules/", commands: "commands/", notes: "notes/", docs: "docs/", other: "その他" };
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
            {index && (index.git.isRepo ? (index.git.clean === false ? " · git 未コミットの変更あり" : " · git 変更なし") : " · git 未初期化")}
          </span>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="全文検索（FTS5）" />
        {hits ? (
          <div className="kn-tree">
            {searchErr && <div className="warn">検索に失敗: {searchErr}</div>}
            {!searchErr && hits.length === 0 && <div className="muted">該当なし</div>}
            {hits.length >= 30 && <div className="hint">上位 30 件のみ表示。語を足して絞り込んでください。</div>}
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
                    {d.frontmatter._invalid && <span className="tag warn" title={d.frontmatter._invalid}>frontmatter の誤り</span>}
                  </button>
                ))}
              </div>
            ))}
            {index?.disabled && <div className="warn">フォルダを用意できません: {index.disabled}</div>}
            {index && !index.disabled && index.docs.length === 0 && <div className="muted">まだドキュメントがありません。{index.dir} に Markdown を置くと索引されます。</div>}
          </div>
        )}
        <div className="row sub">
          <span className="hint">{index ? `${index.docs.length} 件 · FTS5` : ""}</span>
          <button className="ghost" onClick={() => api.knowledgeReindex().then(load).catch(() => undefined)}>
            再索引
          </button>
        </div>
      </section>

      <section className="card kn-doc">
        {!detail && <div className="muted">左の一覧か検索結果から選ぶと内容を表示します。</div>}
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

const STATUS_LABEL: Record<MaterializeFile["status"], string> = { new: "新規", changed: "差分あり", unchanged: "最新", removed: "削除" };

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
      const parts = [r.written.length ? `書き込み ${r.written.join(", ")}` : "", r.removed.length ? `削除 ${r.removed.join(", ")}` : "", r.skipped.length ? `見送り ${r.skipped.map((s) => `${s.relPath}（${s.reason === "conflict" ? "手編集あり" : "プレビューが古い"}）`).join(", ")}` : ""].filter(Boolean);
      setNotice(parts.join(" · ") || "変更なし");
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
        <h5>{cleanup ? "リポジトリに残った管理ブロックを外す" : "書き出し先"}</h5>
        {cleanup ? (
          <select aria-label="管理ブロックを外すリポジトリ" disabled={busy} value={wsId} onChange={(e) => { ++seq.current; setFiles(null); setConfirmPaths(null); setNotice(null); setForce(false); setOpen(null); setWsId(e.target.value); }}>
            <option value="">リポジトリを選択</option>
            {workspaces.filter((w) => w.kind === "repo").map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        ) : <span className="hint">ユーザーレベル（~/.claude/CLAUDE.md、~/.codex/AGENTS.md、~/.claude/commands/）</span>}
      </div>
      {warnings.map((w) => <div className="hint warn" key={w.path}>{w.path}: {w.message}</div>)}
      {files && files.length === 0 && <div className="muted">{cleanup ? "管理ブロックは残っていません。" : "書き出し対象の共通ドキュメントがありません（frontmatter の targets を確認）。"}</div>}
      {(files ?? []).map((f) => (
        <div key={f.relPath} className="mat-file">
          <button className="row link" onClick={() => setOpen(open === f.relPath ? null : f.relPath)} title={f.sources.join("\n")}>
            <span className="t mono">{f.relPath}</span>
            <span className="tag">管理 · {f.sources.length}</span>
            {f.conflicts.length > 0 && <span className="tag warn" title={`手で編集されたブロック: ${f.conflicts.join(", ")}`}>手編集あり</span>}
            <span className={`m ${f.status}`}>{STATUS_LABEL[f.status]}</span>
          </button>
          {open === f.relPath && (
            <>
              {f.diff ? <pre className="diff">{f.diff}</pre> : <pre className="diff muted">差分なし</pre>}
              {f.status !== "unchanged" && (
                <div className="row sub">
                  <button disabled={busy || (f.conflicts.length > 0 && !force)} onClick={() => requestApply([f.relPath])}>
                    このファイルだけ適用
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
          適用（{pending.length} ファイル）
        </button>
        {hasConflict && (
          <label className="hint">
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> 手編集されたブロックも上書きする
          </label>
        )}
      </div>
      {confirmPaths && (
        <div className="hint warn" role="dialog" aria-label="管理ブロックの撤去確認">
          {confirmPaths.length} ファイルから管理ブロックを外します。手書き部分は残します。内容が空になるファイルは削除します。
          {(files ?? []).filter((f) => confirmPaths.includes(f.relPath)).map((f) => (
            <div key={f.relPath}>
              <span className="mono">{f.relPath}</span>
              <pre className="diff">{f.diff}</pre>
            </div>
          ))}
          <button className="pri" disabled={busy} onClick={() => { const paths = confirmPaths; setConfirmPaths(null); void applyFiles(paths); }}>外す</button>
          <button className="ghost" disabled={busy} onClick={() => setConfirmPaths(null)}>やめる</button>
        </div>
      )}
      <div className="hint">手書き部分は残します。</div>
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
      {props.fm._invalid && <span className="warn">frontmatter が不正: {props.fm._invalid}</span>}
    </div>
  );
}

function shorten(p: string) {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}
