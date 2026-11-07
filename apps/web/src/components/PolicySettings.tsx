import { useCallback, useEffect, useState } from "react";
import type { AnswerPolicy } from "@switchboard/protocol";
import { api } from "../api.ts";
import { editWarnings, policyRow, policyState, useLines } from "../policies.ts";
import { jstDay } from "../time.ts";
import { t } from "../i18n.ts";
import { settings } from "../i18n/settings.ts";

/** 回答の方針 (#938): the saved policies with their range, expiry and uses; edited or revoked here, never deleted. */
export function PolicySettings(props: { onError: (msg: string) => void }) {
  const [list, setList] = useState<AnswerPolicy[] | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ id: string; target: string; expires: string; when: Array<{ key: string; value: string; on: boolean }>; error: string | null } | null>(null);
  const { onError } = props;
  const load = useCallback(() => {
    api.listPolicies().then((r) => setList(r.policies)).catch((e) => onError(t(settings.policiesUnreadable, { error: String(e.message ?? e) })));
  }, [onError]);
  useEffect(() => {
    load();
    api.workspaces().then((ws) => setNames(new Map(ws.map((w) => [w.id, w.name])))).catch(() => undefined);
  }, [load]);
  const name = (id: string) => names.get(id) ?? id;
  const revoke = (p: AnswerPolicy, revoked: boolean) =>
    api.patchPolicy(p.id, { revoked }).then(load).catch((e) => onError(t(settings.policyChangeFailed, { error: String(e.message ?? e) })));
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
    <details className="card policies">
      <summary>
        <h5>{t(settings.policies)}</h5>
      </summary>
      <div className="muted">{t(settings.policiesHint)}</div>
      {list && list.length === 0 && <div className="muted">{t(settings.noPolicies)}</div>}
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
              <span className="hint">{t(settings.policyExpiresLine, { expires: row.expires })}</span>
              <span className="hint">{row.uses}</span>
            </div>
            <div className="policy-actions">
              <button className="ghost" onClick={() => setOpen(open === p.id ? null : p.id)}>
                {t(settings.policyHistory)}
              </button>
              {p.scope !== "once" && !editing && (
                <button className="ghost" onClick={() => setEdit({ id: p.id, target: p.target, expires: jstDay(p.expiresAt ?? now), when: p.when.map((w) => ({ ...w, on: true })), error: null })}>
                  {t(settings.edit)}
                </button>
              )}
              <button className="ghost" onClick={() => void revoke(p, p.revokedAt === null)}>
                {p.revokedAt === null ? t(settings.turnOff) : t(settings.turnOn)}
              </button>
            </div>
            {editing && (
              <div className="policy-edit">
                <label className="ask-policy-field">
                  {t(settings.policyTarget)}
                  <input value={editing.target} onChange={(e) => setEdit({ ...editing, target: e.target.value })} />
                </label>
                {editing.when.map((w, i) => (
                  <label key={w.key} className="ask-policy-scope">
                    <input type="checkbox" checked={w.on} onChange={(e) => setEdit({ ...editing, when: editing.when.map((y, j) => (j === i ? { ...y, on: e.target.checked } : y)) })} /> {t(settings.policyCondition, { key: w.key, value: w.value })}
                  </label>
                ))}
                <label className="ask-policy-field">
                  {t(settings.policyExpires)}
                  <input type="date" value={editing.expires} onChange={(e) => setEdit({ ...editing, expires: e.target.value })} />
                </label>
                {editWarnings(p, editing.target).map((w) => (
                  <div key={w} className="hint">
                    {w}
                  </div>
                ))}
                {editing.error && <div className="hint warn">{editing.error}</div>}
                <div className="policy-actions">
                  <button className="pri" onClick={save}>
                    {t(settings.save)}
                  </button>
                  <button className="ghost" onClick={() => setEdit(null)}>
                    {t(settings.cancel)}
                  </button>
                </div>
              </div>
            )}
            {open === p.id && (
              <ul className="hint policy-uses">
                {useLines(p).length ? useLines(p).map((l) => <li key={l}>{l}</li>) : <li>{t(settings.policyNotUsed)}</li>}
              </ul>
            )}
          </div>
        );
      })}
    </details>
  );
}
