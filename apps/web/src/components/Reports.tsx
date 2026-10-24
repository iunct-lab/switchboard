import { useEffect, useRef, useState } from "react";
import type { ReportRow } from "@switchboard/protocol";
import { api } from "../api.ts";
import { reportMeta } from "../reports.ts";
import { ArtifactBody, UNDO_MS } from "./Artifacts.tsx";

/**
 * The レポート section of Insights (#1835): every task's HTML artifacts, newest first, opened in place with the same
 * sandboxed body as a Task's 成果物 tab; × removes with 元に戻す, and a row leads to its Task's 成果物 tab.
 */
export function Reports(props: { openId?: string; onOpenTask: (taskId: string, artifactId: string) => void; onError: (msg: string) => void }) {
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [sel, setSel] = useState<string | null>(props.openId ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [undo, setUndo] = useState<ReportRow | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = () =>
    api.reports().then((list) => {
      setRows(list);
      return list;
    });
  useEffect(() => {
    let live = true;
    load().then(
      (list) => live && setSel((s) => (s && list.some((r) => r.id === s) ? s : (list[0]?.id ?? null))),
      (e) => {
        if (!live) return;
        setRows([]);
        setErr(`レポートを読めません: ${String((e as Error).message ?? e)}`);
      },
    );
    return () => {
      live = false;
      clearTimeout(undoTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per visit; openId changes select below
  }, []);
  useEffect(() => {
    if (props.openId) setSel(props.openId);
  }, [props.openId]);

  const remove = async (r: ReportRow) => {
    setErr(null);
    try {
      await api.removeArtifact(r.id);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
      return;
    }
    // removed: 元に戻す is on offer from here, even if the list cannot be read again
    setUndo(r);
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
    try {
      const list = await load();
      if (sel === r.id) setSel(list[0]?.id ?? null);
    } catch (e) {
      setErr(`一覧を読み直せません: ${String((e as Error).message ?? e)}`);
    }
  };
  const restore = async () => {
    if (!undo) return;
    const r = undo;
    setUndo(null);
    clearTimeout(undoTimer.current);
    try {
      await api.restoreArtifact(r.id);
      await load();
      setSel(r.id);
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };

  const current = rows?.find((r) => r.id === sel) ?? null;
  return (
    <section className="card reports">
      <h5>レポート</h5>
      {rows === null && !err && <div className="muted">読み込み中…</div>}
      {rows && rows.length === 0 && !err && <div className="muted">定期タスクや Task が HTML を成果物に登録すると、ここに新しい順に並びます。</div>}
      {rows && rows.length > 0 && (
        <div role="tablist" aria-label="レポート">
          {rows.map((r) => (
            <div key={r.id} className={`row${r.id === sel ? " on" : ""}`}>
              <button role="tab" aria-selected={r.id === sel} className="ghost t" onClick={() => setSel(r.id)} title={r.source}>
                {r.title}
              </button>
              <span className="m">{reportMeta(r)}</span>
              <button className="ghost" onClick={() => props.onOpenTask(r.taskId, r.id)} title={`Task「${r.taskTitle}」の成果物タブで開く`}>
                Task を開く
              </button>
              <button className="art-x" aria-label={`${r.title} を消す`} title="消す" onClick={() => remove(r)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
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
      {current && <ArtifactBody key={`${current.id}:${current.updatedAt}`} a={current} shown onRefreshed={() => load().catch((e) => setErr(`一覧を読み直せません: ${String((e as Error).message ?? e)}`))} />}
    </section>
  );
}
