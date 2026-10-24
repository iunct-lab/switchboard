import { useCallback, useEffect, useRef, useState } from "react";
import type { Artifact, Ask, AskAnswer, AskChanged, AskList, PendingApproval, PolicyInput } from "@switchboard/protocol";
import { api } from "../api.ts";
import { ArtifactBody } from "./Artifacts.tsx";
import { summarize } from "../approvals.ts";
import { answerButtons, answerTarget, appliedLine, askFacts, blockerLines, groupAsks, initialPolicyForm, keptAnswers, KIND_LABEL, policyInput, policySummary, previousLines, pruneAnswered, resumeLabel, scopeLabel, STATE_LABEL, workspaceChips, workspaceKey, workspaceSections, type Answered, type PolicyForm } from "../asks.ts";

/**
 * A card's answers (#936): what an answer does not take away, then one button per answer with what it sends and where,
 * and free text when the question takes it (a confirmation's 違う with its reason). Every button is off while one is
 * being sent, so a second tap sends nothing.
 */
function AnswerArea(props: { ask: Ask; busy: boolean; onAnswer: (a: AskAnswer, policy?: PolicyInput) => void }) {
  const { ask: x, busy } = props;
  const [text, setText] = useState("");
  const [form, setForm] = useState<PolicyForm | null>(() => initialPolicyForm(x));
  const policy = policyInput(form);
  const answer = (a: AskAnswer) => props.onAnswer(a, a.kind === "hold" || a.kind === "deny" || a.kind === "confirm" ? undefined : policy);
  const buttons = answerButtons(x);
  // a stage Task's stop is the Issue's: its answer is not written from here (the API answers 422), so no box
  const takesText = x.answers.includes("text") && !(x.kind === "stop" && x.issue);
  const confirm = x.answers.includes("confirm");
  if (!buttons.length && !takesText && !confirm && !x.blockers.length && !x.policy.note) return null;
  return (
    <div className="ask-answer">
      {blockerLines(x).map((l) => (
        <div key={l} className="hint warn ask-blocker">
          {l}
        </div>
      ))}
      {(buttons.length > 0 || takesText) && form && (
        <details className="ask-policy" onToggle={(e) => { const open = e.currentTarget.open; setForm((f) => (f && f.opened !== open ? { ...f, opened: open } : f)); }}>
          <summary>次回も使う（{scopeLabel(form.scope, x)}）</summary>
          <div className="ask-policy-body">
            {x.policy.scopes.map((s) => (
              <label key={s} className="ask-policy-scope">
                <input type="radio" name={`scope-${x.id}`} checked={form.scope === s} disabled={busy} onChange={() => setForm({ ...form, scope: s })} /> {scopeLabel(s, x)}
              </label>
            ))}
            {form.scope !== "once" && (
              <>
                <label className="ask-policy-field">
                  対象（* で広げられます）
                  <input value={form.target} disabled={busy} onChange={(e) => setForm({ ...form, target: e.target.value })} />
                </label>
                {form.when.map((w, i) => (
                  <label key={w.key} className="ask-policy-scope">
                    <input type="checkbox" checked={w.on} disabled={busy} onChange={(e) => setForm({ ...form, when: form.when.map((y, j) => (j === i ? { ...y, on: e.target.checked } : y)) })} /> 条件 {w.key}={w.value}
                  </label>
                ))}
                <label className="ask-policy-field">
                  期限
                  <input type="date" value={form.expires} disabled={busy} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
                </label>
                {policy && (
                  <ul className="hint ask-policy-summary">
                    {policySummary(x, policy, buttons[0]?.send ?? "入力した文").map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </details>
      )}
      {x.policy.note && !form && <div className="hint ask-policy-note">{x.policy.note}</div>}
      {buttons.length > 0 && (
        <div className="ask-buttons">
          {buttons.map((b) => (
            <div key={b.label} className="ask-button">
              <button className={b.primary ? "pri" : undefined} disabled={busy} onClick={() => answer(b.answer)}>
                {b.label}
              </button>
              <div className="hint ask-send">
                送る: {b.send} → {b.target}、続き: {b.next}
                {policy && b.answer.kind !== "hold" && b.answer.kind !== "deny" && b.answer.kind !== "confirm" ? `、＋ 方針を保存（${scopeLabel(form!.scope, x)}）` : ""}
              </div>
            </div>
          ))}
        </div>
      )}
      {(takesText || confirm) && (
        <div className="ask-text">
          <textarea value={text} placeholder={confirm ? "違うときの理由" : "自由文で答える"} onChange={(e) => setText(e.target.value)} disabled={busy} />
          <button disabled={busy || !text.trim()} onClick={() => answer(confirm ? { kind: "confirm", ok: false, text: text.trim() } : { kind: "text", text: text.trim() })}>
            {confirm ? "違うと送る" : "回答を送る"}
          </button>
          <div className="hint ask-send">
            送る: 入力した文 → {answerTarget(x)}、続き: {x.next ?? "不明"}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 判断待ち (#935, was 承認 #26): every question waiting on the user — tool approvals, the backlog's decisions and
 * confirmations, a Task's operational check, stops and waits — split into the person's, the automatic ones, answered and
 * resolved. A tool approval is still answered here with one tap; the rest send the person where it is answered.
 */
export function Approvals(props: { approvals: PendingApproval[]; onAnswered: (a: PendingApproval) => void; onOpenTask: (id: string) => void; onOpenBacklog: () => void; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [list, setList] = useState<AskList | null>(null);
  const [failed, setFailed] = useState(false);
  // #936: the cards answered here, by the id they were shown with, and the one being sent
  const [answered, setAnswered] = useState<Map<string, Answered>>(new Map());
  const [sending, setSending] = useState<string | null>(null);
  // #1673: the Workspace the cards are narrowed to (its id, "" = not known), null = all; only while the screen is open
  const [workspace, setWorkspace] = useState<string | null>(null);
  const { onError } = props;
  const seq = useRef(0);
  const load = useCallback(() => {
    const mine = ++seq.current;
    api
      .asks()
      .then((l) => {
        if (mine !== seq.current) return; // an older answer never overwrites a newer one
        setList(l);
        setAnswered((m) => pruneAnswered(m, l.asks));
        setFailed(false);
      })
      .catch((e) => {
        if (mine !== seq.current) return;
        setFailed(true);
        onError(`判断待ちを読めませんでした: ${String(e.message ?? e)}`);
      });
  }, [onError]);
  // on open, and when an approval comes or goes (the live list moves first; the rest is read again with it)
  const approvalKeys = props.approvals.map((a) => `${a.taskId}/${a.id}`).join(" ");
  useEffect(load, [load, approvalKeys]);

  const answer = (a: PendingApproval, decision: "allow" | "deny") => {
    setBusy(`${a.taskId}/${a.id}`);
    api
      .permission(a.taskId, a.id, decision)
      .then(() => props.onAnswered(a))
      .catch((e) => props.onError(`${a.taskTitle} に答えられませんでした: ${String(e.message ?? e)}`))
      .finally(() => setBusy(null));
  };
  const askId = (a: PendingApproval) => `approval:${a.taskId}:${a.id}`;
  const send = (x: Ask, answer: AskAnswer, policy?: PolicyInput) => {
    if (sending) return;
    setSending(x.id);
    const done = (v: Answered) => setAnswered((m) => new Map(m).set(x.id, v));
    api
      .answerAsk(x.id, answer, policy)
      .then((r) => {
        done({ ask: r.ask ?? x, changes: r.changes.length ? r.changes : undefined });
        const pending = props.approvals.find((a) => askId(a) === x.id);
        if (pending) props.onAnswered(pending);
        load();
      })
      .catch((e: Error & { status?: number; body?: AskChanged }) => {
        if (e.status === 409 && e.body?.changes) {
          // the question changed: what changed, kept on the question now (by its id), which comes with the list read again;
          // with no question now (answered elsewhere, gone) the reason is said at once
          const current = e.body.current;
          if (current) setAnswered((m) => new Map(m).set(current.id, { ask: current, changes: e.body!.changes, changed: true }));
          else props.onError(`答えられませんでした: ${e.body.error}（${e.body.changes.join(" / ")}）`);
          load();
        } else props.onError(`答えられませんでした: ${String(e.message ?? e)}`);
      })
      .finally(() => setSending(null));
  };
  const live = (x: Ask) => (x.kind === "approval" && x.state === "open" ? props.approvals.find((a) => x.id === askId(a)) : undefined);
  // the live approvals the list does not have yet (it is loading, failed, or older): still answered with one tap
  const unlisted = props.approvals.filter((a) => !list?.asks.some((x) => x.id === askId(a)));
  // `buttons` false: the card's answer buttons answer it (#936); the title and the command stay
  const approvalHead = (a: PendingApproval, buttons = true) => (
    <>
      <button className="ghost link t" onClick={() => props.onOpenTask(a.taskId)}>
        {a.taskTitle}
      </button>
      <pre className="approval-detail">{summarize(a)}</pre>
      {/* one tap, before the facts: on a phone the buttons stay in the first screenful */}
      {buttons && <div className="approval-actions">
        <button className="pri" disabled={busy !== null} onClick={() => answer(a, "allow")}>
          許可
        </button>
        <button disabled={busy !== null} onClick={() => answer(a, "deny")}>
          拒否
        </button>
      </div>}
    </>
  );
  // a question answered here that the list no longer has (a check whose Task went on, a confirmation) stays, as the
  // answer returned it — unless the list has it answered under its new id (a decision's names the answer's time)
  const kept = list ? keptAnswers(answered, list.asks) : [];
  const all = list ? [...list.asks, ...kept] : [];
  const chips = workspaceChips(all);
  // a Workspace that left the list is no filter (all again)
  const narrowed = workspace !== null && chips.some((c) => c.key === workspace) ? workspace : null;
  const inScope = (a: Ask) => narrowed === null || workspaceKey(a) === narrowed;
  const groups = groupAsks(all.filter(inScope));
  // the live approvals not in the list yet have no Workspace: shown (and counted) whatever the filter
  const open = (list ? list.asks.filter((a) => inScope(a) && (a.state === "open" || a.state === "held") && a.needs === "person").length : 0) + unlisted.length;

  return (
    <main className="main approvals">
      <section className="card">
        <div className="row head">
          <h5>
            判断待ち <span className="hint">{open}</span>
          </h5>
          <button className="ghost" onClick={load}>
            再読込
          </button>
        </div>
        {chips.length > 0 && (
          <div className="ask-workspaces">
            <button className={narrowed === null ? "pri" : undefined} onClick={() => setWorkspace(null)}>
              すべて
            </button>
            {chips.map((c) => (
              <button key={c.key} className={narrowed === c.key ? "pri" : undefined} data-workspace={c.key} onClick={() => setWorkspace(c.key)}>
                {c.name} {c.count}
              </button>
            ))}
          </div>
        )}
        {failed && <div className="hint warn ask-failed">{list ? "最新の判断待ちを読めませんでした。前に読んだ一覧と、今の承認を出しています" : "判断待ちを読めませんでした。承認だけを出しています"}（再読込で読み直します）</div>}
        {!list && !failed && <div className="muted">読み込み中…</div>}
        {list && list.asks.length === 0 && <div className="muted">判断待ちはありません</div>}
        {list?.errors.map((e) => (
          <div key={e.workspaceId} className="hint">
            {e.workspaceName}: {e.message}
          </div>
        ))}
      </section>
      {unlisted.map((a) => (
        <section key={askId(a)} className="card ask approval" data-ask={askId(a)}>
          <div className="ask-tags">
            <span className="badge ask-kind ask-kind-approval">{KIND_LABEL.approval}</span>
            <span className="badge ask-state ask-state-open">{STATE_LABEL.open}</span>
          </div>
          {approvalHead(a)}
        </section>
      ))}
      {groups.map((g) => (
        <section key={g.key} className={`ask-group ask-group-${g.key}`}>
          <h5 className="ask-group-head">
            {g.label} <span className="hint">{g.asks.length}</span>
          </h5>
          {g.key === "auto" && <div className="hint">操作は要りません。条件が満たされると自動で進みます</div>}
          {workspaceSections(g.asks).map((ws) => (
            <div key={ws.key} className="ask-workspace" data-workspace={ws.key}>
              <h6 className="ask-workspace-head">
                {ws.name} <span className="hint">{ws.asks.length}</span>
              </h6>
              {ws.asks.map((shown) => {
                const was = answered.get(shown.id);
                // a 409's notice goes on the question as the list has it (read again after the 409)
                const x = was && !was.changed ? was.ask : shown;
                const a = live(x);
                const resume = resumeLabel(x);
                const taskId = x.source.taskId ?? x.task?.id ?? null;
                return (
                  <section key={x.id} className={`card ask${a ? " approval" : ""}`} data-ask={x.id}>
                    <div className="ask-tags">
                      <span className={`badge ask-kind ask-kind-${x.kind}`}>{KIND_LABEL[x.kind]}</span>
                      <span className={`badge ask-state ask-state-${x.state}`}>{STATE_LABEL[x.state]}</span>
                    </div>
                    {a && approvalHead(a, !x.answers.length)}
                    {was?.changes && (
                      <div className={`hint ${was.changed ? "warn " : ""}ask-changes`}>
                        {was.changed ? "問いが変わったので、もう一度確かめてから答えてください" : "回答の時点で変わっていたもの（回答と一緒に書きました）"}
                        <ul>
                          {was.changes.map((c) => (
                            <li key={c}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {previousLines(x).length > 0 && (x.state === "open" || x.state === "held") && (
                      <div className="hint warn ask-previous">
                        前回と違うので確認します
                        <ul>
                          {previousLines(x).map((l) => (
                            <li key={l}>{l}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {appliedLine(x) && <div className="hint ask-applied">{appliedLine(x)}</div>}
                    {resume && (
                      <div className={`badge ask-resume ask-resume-${resume.tone}`}>
                        {resume.text}
                        {x.resume?.state === "running" && x.resume.taskId && (
                          <button className="ghost link" onClick={() => props.onOpenTask(x.resume!.taskId!)}>
                            Task を開く
                          </button>
                        )}
                      </div>
                    )}
                    {/* seen before the answer buttons, to compare and then choose (#2221) */}
                    <Mockups list={x.mockups} />
                    {/* before the facts: on a phone the buttons stay in the first screenful (#26) */}
                    <AnswerArea key={x.id} ask={x} busy={sending !== null} onAnswer={(answer, policy) => send(x, answer, policy)} />
                    <dl className="ask-facts">
                      {askFacts(x).map((f) => (
                        <div key={f.label} className="ask-fact">
                          <dt>{f.label}</dt>
                          <dd className={f.value === "不明" ? "muted" : undefined}>
                            {f.href ? (
                              <a href={f.href} target="_blank" rel="noreferrer">
                                {f.value}
                              </a>
                            ) : (
                              f.value
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <div className="approval-actions">
                      {x.route === "backlog" && (x.state === "open" || x.state === "held") && (
                        <button className="pri ask-route" onClick={props.onOpenBacklog}>
                          Backlog で答える
                        </button>
                      )}
                      {!a && taskId && (
                        <button className="ask-route" onClick={() => props.onOpenTask(taskId)}>
                          Task を開く
                        </button>
                      )}
                      {x.route === "issue" && x.issue && (
                        <a className="button ask-route" href={x.issue.url} target="_blank" rel="noreferrer">
                          Issue を開く
                        </a>
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          ))}
        </section>
      ))}
    </main>
  );
}

/**
 * A question's screen mockups (#2221): a button per title, and the one pressed opened below in the artifact view of the
 * Task screen. Pressing it again closes it. Nothing when there are none.
 */
export function Mockups(props: { list: Artifact[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (props.list.length === 0) return null;
  const shown = props.list.find((a) => a.id === open) ?? null;
  return (
    <div className="mockups">
      <div className="hint">画面イメージ</div>
      <div className="mockup-buttons">
        {props.list.map((a) => (
          <button key={a.id} className="ghost mockup" aria-pressed={a.id === open} onClick={() => setOpen(a.id === open ? null : a.id)}>
            {a.title}
          </button>
        ))}
      </div>
      {shown && <ArtifactBody key={shown.id} a={shown} shown onRefreshed={() => undefined} />}
    </div>
  );
}
