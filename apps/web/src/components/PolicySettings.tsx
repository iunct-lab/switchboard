import { useCallback, useEffect, useState } from "react";
import type { AnswerPolicy } from "@switchboard/protocol";
import { api } from "../api.ts";
import { policyRow, policyState, useLines } from "../policies.ts";
import { jstDay } from "../time.ts";

/** 回答の方針 (#938): the saved policies with their range, expiry and uses; edited or revoked here, never deleted. */
export function PolicySettings(props: { onError: (msg: string) => void }) {
  const [list, setList] = useState<AnswerPolicy[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string; target: string; expires: string; when: Array<{ key: string; value: string; on: boolean }>; error: string | null } | null>(null);
  const { onError } = props;
  const load = useCallback(() => {
    api.listPolicies().then((r) => setList(r.policies)).catch((e) => onError(`回答の方針を読めませんでした: ${String(e.message ?? e)}`));
  }, [onError]);
  useEffect(() => {
    load();
    api.workspaces().then((ws) => setNames(new Map(ws.map((w) => [w.id, w.name])))).catch(() => undefined);
  }, [load]);
  const name = (id: string) => names.get(id) ?? id;
  const revoke = (p: AnswerPolicy, revoked: boolean) =>
    api.patchPolicy(p.id, { revoked }).then(load).catch((e) => onError(`方針を変えられませんでした: ${String(e.message ?? e)}`));
  const save = () => {
    if (!edit) return;
    const p = list?.find((x) => x.id === edit.id);
    if (!p) return;
    api
      .patchPolicy(p.id, { target: edit.target.trim(), when: edit.when.filter((w) => w.on).map(({ key, value }) => ({ key, value })), expiresAt: Date.parse(`${edit.expires}T23:59:59+09:00`) })
      .then(() => {
        setEdit(null);
        load();
      })
      .catch((e) => setEdit({ ...edit, error: String(e.message ?? e) }));
  };
  const now = Date.now();
  return (
    <section className="card policies">
      <h5>回答の方針</h5>
      <div className="muted">判断待ちで「次回も使う」を選んで保存した方針です。ランナー側の拒否と都度確認のルールには当たりません。</div>
      {list && list.length === 0 && <div className="muted">保存した方針はありません</div>}
      {list?.map((p) => {
        const row = policyRow(p, name, now);
        const st = policyState(p, now);
        const editing = edit?.id === p.id ? edit : null;
        return (
          <div key={p.id} className="policy-row" data-policy={p.id}>
            <div className="policy-main">
              <span className={`badge ask-resume ask-resume-${st.tone}`}>{st.text}</span>
              <span className="t">{row.subject}</span>
              <span className="hint">{row.scope}</span>
              <span className="hint">{row.when}</span>
              <span className="hint">期限: {row.expires}</span>
              <span className="hint">{row.uses}</span>
            </div>
            <div className="policy-actions">
              <button className="ghost" onClick={() => setOpen(open === p.id ? null : p.id)}>
                履歴
              </button>
              {p.scope !== "once" && !editing && (
                <button className="ghost" onClick={() => setEdit({ id: p.id, target: p.target, expires: jstDay(p.expiresAt ?? now), when: p.when.map((w) => ({ ...w, on: true })), error: null })}>
                  編集
                </button>
              )}
              <button className="ghost" onClick={() => void revoke(p, p.revokedAt === null)}>
                {p.revokedAt === null ? "無効にする" : "有効にする"}
              </button>
            </div>
            {editing && (
              <div className="policy-edit">
                <label className="ask-policy-field">
                  対象
                  <input value={editing.target} onChange={(e) => setEdit({ ...editing, target: e.target.value })} />
                </label>
                {editing.when.map((w, i) => (
                  <label key={w.key} className="ask-policy-scope">
                    <input type="checkbox" checked={w.on} onChange={(e) => setEdit({ ...editing, when: editing.when.map((y, j) => (j === i ? { ...y, on: e.target.checked } : y)) })} /> 条件 {w.key}={w.value}
                  </label>
                ))}
                <label className="ask-policy-field">
                  期限
                  <input type="date" value={editing.expires} onChange={(e) => setEdit({ ...editing, expires: e.target.value })} />
                </label>
                {editing.error && <div className="hint warn">{editing.error}</div>}
                <div className="policy-actions">
                  <button className="pri" onClick={save}>
                    保存
                  </button>
                  <button className="ghost" onClick={() => setEdit(null)}>
                    やめる
                  </button>
                </div>
              </div>
            )}
            {open === p.id && (
              <ul className="hint policy-uses">
                {useLines(p).length ? useLines(p).map((l) => <li key={l}>{l}</li>) : <li>まだ使われていません</li>}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}
