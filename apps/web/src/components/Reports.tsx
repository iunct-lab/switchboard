import { useEffect, useRef, useState } from "react";
import type { ReportRow } from "@switchboard/protocol";
import { api } from "../api.ts";
import { artifactMeta, reportMeta, type AcrossQuery } from "../reports.ts";
import { ArtifactBody, UNDO_MS } from "./Artifacts.tsx";

/** Rows read at a time; a full page offers さらに表示 (#1833). */
const PAGE = 50;

/**
 * The レポート section of Insights (#1835): every task's HTML artifacts — or, switched to すべての成果物, every artifact
 * (#1833) — newest first, opened in place with the same sandboxed body as a Task's 成果物 tab; × removes with 元に戻す,
 * and a row leads to its Task's 成果物 tab. The words typed filter on the daemon, so rows not read yet are found too.
 */
export function Reports(props: { scope: "reports" | "all"; onScope: (scope: "reports" | "all") => void; openId?: string; onOpenTask: (taskId: string, artifactId: string) => void; onError: (msg: string) => void }) {
  const [rows, setRows] = useState<ReportRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState(""); // q, once typing pauses
  const seq = useRef(0); // a read from the top that a newer one replaced is dropped, its failure too
  const [moreBusy, setMoreBusy] = useState(false);
  const moreBusyRef = useRef(false); // two presses before a render both see the state false
  const [sel, setSel] = useState<string | null>(props.openId ?? null);
  const [err, setErr] = useState<string | null>(null);
  const [undo, setUndo] = useState<ReportRow | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const all = props.scope === "all";
  // what is on screen now: a read that a × or 元に戻す starts after the scope or the words changed uses these, not its render's
  const now = useRef({ all, term });
  now.current = { all, term };
  const read = (o: AcrossQuery) => (now.current.all ? api.allArtifacts(o) : api.reports(o));
  /** Read from the top with the current words and scope; null when a newer read replaced this one (also when it failed). */
  const load = async () => {
    const n = ++seq.current;
    let list: ReportRow[];
    try {
      list = await read({ limit: PAGE, q: now.current.term });
    } catch (e) {
      if (n !== seq.current) return null;
      throw e;
    }
    if (n !== seq.current) return null;
    setRows(list);
    setMore(list.length === PAGE);
    return list;
  };
  /** One page after the last row; one at a time, so a second press cannot add the same page twice. */
  const loadMore = async () => {
    const last = rows?.[rows.length - 1];
    if (!last || moreBusyRef.current) return;
    const n = seq.current;
    moreBusyRef.current = true;
    setMoreBusy(true);
    try {
      const list = await read({ limit: PAGE, q: now.current.term, before: last.id });
      if (n !== seq.current) return;
      setRows((r) => [...(r ?? []), ...list]);
      setMore(list.length === PAGE);
    } catch (e) {
      if (n === seq.current) setErr(`続きを読めません: ${String((e as Error).message ?? e)}`);
    } finally {
      moreBusyRef.current = false;
      setMoreBusy(false);
    }
  };
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    setErr(null);
    load().then(
      (list) => list && setSel((s) => (s && list.some((r) => r.id === s) ? s : (list[0]?.id ?? null))),
      (e) => {
        setRows([]);
        setMore(false);
        setErr(`${all ? "成果物" : "レポート"}を読めません: ${String((e as Error).message ?? e)}`);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again when the scope or the words change; openId changes select below
  }, [props.scope, term]);
  useEffect(
    () => () => {
      seq.current++;
      clearTimeout(undoTimer.current);
    },
    [],
  );
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
      if (list && sel === r.id) setSel(list[0]?.id ?? null);
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
      <div className="row head">
        <h5>レポート</h5>
        <div className="reports-scope">
          <button className="ghost" aria-pressed={!all} onClick={() => props.onScope("reports")}>
            レポート（HTML）
          </button>
          <button className="ghost" aria-pressed={all} onClick={() => props.onScope("all")}>
            すべての成果物
          </button>
        </div>
      </div>
      <input className="reports-q" type="search" aria-label="成果物を絞り込む" placeholder="題・パス・Task の題" value={q} onChange={(e) => setQ(e.target.value)} />
      {rows === null && !err && <div className="muted">読み込み中…</div>}
      {rows && rows.length === 0 && !err && <div className="muted">{term ? `「${term}」に合う成果物はありません` : all ? "Task の成果物に登録すると、ここに新しい順に並びます。" : "定期タスクや Task が HTML を成果物に登録すると、ここに新しい順に並びます。"}</div>}
      {rows && rows.length > 0 && (
        <div role="tablist" aria-label={all ? "すべての成果物" : "レポート"}>
          {rows.map((r) => (
            <div key={r.id} className={`row${r.id === sel ? " on" : ""}`}>
              <button role="tab" aria-selected={r.id === sel} className="ghost t" onClick={() => setSel(r.id)} title={r.source}>
                {r.title}
              </button>
              <span className="m">{all ? artifactMeta(r) : reportMeta(r)}</span>
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
      {more && (
        <button className="ghost" disabled={moreBusy} onClick={() => void loadMore()}>
          さらに表示
        </button>
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
