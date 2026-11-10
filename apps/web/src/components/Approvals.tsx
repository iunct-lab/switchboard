import { useCallback, useEffect, useRef, useState } from "react";
import type { Artifact, Ask, AskAnswer, AskBatch, AskChanged, AskList, PendingApproval, PolicyInput } from "@switchboard/protocol";
import { api } from "../api.ts";
import { ArtifactBody } from "./Artifacts.tsx";
import { DeviceAuth } from "./DeviceAuth.tsx";
import { summarize } from "../approvals.ts";
import { t } from "../i18n.ts";
import { panels as m } from "../i18n/panels.ts";
import { task as tm } from "../i18n/task.ts";
import { answerOf, answersOf, type QuestionChoice } from "../questions.ts";
import { answerButtons, answerTarget, withoutGrant, appliedLine, askCardParts, questionHead, BATCH_LABEL, batchLines, blockerLines, groupAsks, hiddenByBatches, isQuick, quickGroups, initialPolicyForm, keptAnswers, KIND_LABEL, policyInput, policySummary, previousLines, pruneAnswered, resumeLabel, scopeLabel, STATE_LABEL, issueOpenHref, unblockLinks, unblocksLine, workspaceChips, workspaceKey, workspaceSections, type Answered, type PolicyForm } from "../asks.ts";

/**
 * A question tool's questions on a card (#3058): a fieldset per question — its options (checkboxes for multiSelect), or a
 * free-text field for a question without options — and one 回答する once every question has an answer. No policy: the
 * answers are that turn's.
 */
function QuestionFields(props: { ask: Ask; busy: boolean; onAnswer: (a: AskAnswer) => void }) {
  const { ask: x, busy } = props;
  const [choices, setChoices] = useState<(QuestionChoice | undefined)[]>([]); // indexed like x.questions
  const answer = answersOf(x.questions, choices);
  const update = (i: number, fn: (c: QuestionChoice) => QuestionChoice) => setChoices((s) => Object.assign([...s], { [i]: fn(s[i] ?? { labels: [], text: "" }) }));
  return (
    <div className="ask-questions">
      {x.questions.map((q, i) => (
        <fieldset key={i}>
          <legend>
            {q.header && <span className="tag">{q.header}</span>}
            {q.question}
            {q.multiSelect && <span className="hint">{t(tm.multiSelect)}</span>}
          </legend>
          {q.options.map((o) => (
            <label key={o.label} className="opt">
              <input
                type={q.multiSelect ? "checkbox" : "radio"}
                name={`${x.id}:${i}`}
                checked={(choices[i]?.labels ?? []).includes(o.label)}
                disabled={busy}
                onChange={(e) => update(i, (c) => ({ ...c, labels: q.multiSelect ? (e.target.checked ? [...c.labels, o.label] : c.labels.filter((l) => l !== o.label)) : [o.label] }))}
              />
              <span>
                {o.label}
                {o.description && <span className="hint"> — {o.description}</span>}
              </span>
            </label>
          ))}
          {!q.options.length && <textarea placeholder={t(tm.writeAnswer)} value={choices[i]?.text ?? ""} disabled={busy} onChange={(e) => update(i, (c) => ({ ...c, text: e.target.value }))} />}
          {answerOf(q, choices[i]) && <div className="hint">{t(tm.answerLine, { answer: answerOf(q, choices[i]) })}</div>}
        </fieldset>
      ))}
      <button className="pri" disabled={busy || !answer} title={answer ? "" : t(tm.answerAllTitle)} onClick={() => answer && props.onAnswer(answer)}>
        {t(tm.answer)}
      </button>
      <div className="hint ask-send">{t(m.sendTyped, { target: answerTarget(x), next: x.next ?? t(m.unknown) })}</div>
    </div>
  );
}

/**
 * A card's answers (#936): what an answer does not take away, then one button per answer with what it sends and where,
 * and free text when the question takes it (a confirmation's 違う with its reason). Every button is off while one is
 * being sent, so a second tap sends nothing. A grant (#2745) is on a line of its own. Also the Task screen's (TaskView).
 * A question tool's questions (#3058) are answered together by QuestionFields, with no free-text box of the card's own.
 */
export function AnswerArea(props: { ask: Ask; busy: boolean; onAnswer: (a: AskAnswer, policy?: PolicyInput) => void }) {
  const { ask: x, busy } = props;
  if (x.answers.includes("questions"))
    return (
      <div className="ask-answer">
        {blockerLines(x).map((l) => (
          <div key={l} className="hint warn ask-blocker">
            {l}
          </div>
        ))}
        <QuestionFields ask={x} busy={busy} onAnswer={(a) => props.onAnswer(a)} />
      </div>
    );
  return <AnswerButtons {...props} />;
}

function AnswerButtons(props: { ask: Ask; busy: boolean; onAnswer: (a: AskAnswer, policy?: PolicyInput) => void }) {
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
          <summary>{t(m.policyReuse, { scope: scopeLabel(form.scope, x) })}</summary>
          <div className="ask-policy-body">
            {x.policy.scopes.map((s) => (
              <label key={s} className="ask-policy-scope">
                <input type="radio" name={`scope-${x.id}`} checked={form.scope === s} disabled={busy} onChange={() => setForm({ ...form, scope: s })} /> {scopeLabel(s, x)}
              </label>
            ))}
            {form.scope !== "once" && (
              <>
                <label className="ask-policy-field">
                  {t(m.policyTarget)}
                  <input value={form.target} disabled={busy} onChange={(e) => setForm({ ...form, target: e.target.value })} />
                </label>
                {form.when.map((w, i) => (
                  <label key={w.key} className="ask-policy-scope">
                    <input type="checkbox" checked={w.on} disabled={busy} onChange={(e) => setForm({ ...form, when: form.when.map((y, j) => (j === i ? { ...y, on: e.target.checked } : y)) })} /> {t(m.policyCondition, { key: w.key, value: w.value })}
                  </label>
                ))}
                <label className="ask-policy-field">
                  {t(m.policyExpires)}
                  <input type="date" value={form.expires} disabled={busy} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
                </label>
                {policy && (
                  <ul className="hint ask-policy-summary">
                    {policySummary(x, policy, buttons[0]?.send ?? t(m.typedText)).map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </details>
      )}
      {/* a grant's note (not saved as a policy, #2745) is the API's refusal only: the card is as its mockup */}
      {x.policy.note && !form && !x.grant && !x.grants.some(Boolean) && <div className="hint ask-policy-note">{x.policy.note}</div>}
      {buttons.length > 0 && (
        <div className="ask-buttons">
          {buttons.map((b) => (
            <div key={b.label} className="ask-button">
              <button className={b.primary ? "pri" : undefined} disabled={busy} onClick={() => answer(b.answer)}>
                {b.label}
              </button>
              {/* closing a notice (#2866) sends nothing anywhere */}
              {b.answer.kind !== "dismiss" && (
                <div className="hint ask-send">
                  {t(m.sends)}
                  {b.grant === b.send ? (
                    <span className="ask-grant">{b.grant}</span>
                  ) : b.grant ? (
                    <>
                      {withoutGrant(b.send)}
                      <br />
                      <span className="ask-grant">{t(m.grant, { grant: b.grant })}</span>
                    </>
                  ) : (
                    b.send
                  )}{" "}
                  {t(m.sendTarget, { target: b.target, next: b.next })}
                  {policy && b.answer.kind !== "hold" && b.answer.kind !== "deny" && b.answer.kind !== "confirm" ? t(m.savePolicy, { scope: scopeLabel(form!.scope, x) }) : ""}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {(takesText || confirm) && (
        <div className="ask-text">
          <textarea value={text} placeholder={confirm ? t(m.reasonPlaceholder) : t(m.textPlaceholder)} onChange={(e) => setText(e.target.value)} disabled={busy} />
          <button disabled={busy || !text.trim()} onClick={() => answer(confirm ? { kind: "confirm", ok: false, text: text.trim() } : { kind: "text", text: text.trim() })}>
            {confirm ? t(m.sendWrong) : t(m.sendAnswer)}
          </button>
          <div className="hint ask-send">
            {t(m.sendTyped, { target: answerTarget(x), next: x.next ?? t(m.unknown) })}
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
  // #1675: the person's narrowed to the ones answered with one press; only while the screen is open
  const [quickOnly, setQuickOnly] = useState(false);
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
        onError(t(m.loadAsksFailed, { error: String(e.message ?? e) }));
      });
  }, [onError]);
  // on open, and when an approval comes or goes (the live list moves first; the rest is read again with it)
  const approvalKeys = props.approvals.map((a) => `${a.taskId}/${a.id}`).join(" ");
  useEffect(load, [load, approvalKeys]);
  // while a Task logs in for an SSO batch (#2046): its device code, and the rest going on after it, are read again
  const loggingIn = list?.batches.some((b) => b.loggingIn) ?? false;
  useEffect(() => {
    if (!loggingIn) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [loggingIn, load]);

  const answer = (a: PendingApproval, decision: "allow" | "deny") => {
    setBusy(`${a.taskId}/${a.id}`);
    api
      .permission(a.taskId, a.id, decision)
      .then(() => props.onAnswered(a))
      .catch((e) => props.onError(t(m.answerFailedFor, { title: a.taskTitle, error: String(e.message ?? e) })))
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
          else props.onError(t(m.answerChanged, { error: e.body.error, changes: e.body.changes.join(" / ") }));
          load();
        } else props.onError(t(m.answerFailed, { error: String(e.message ?? e) }));
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
          {t(m.allow)}
        </button>
        <button disabled={busy !== null} onClick={() => answer(a, "deny")}>
          {t(m.deny)}
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
  const batches = list?.batches ?? [];
  // a batch's questions are answered on its card (#2046)
  const scoped = groupAsks(hiddenByBatches(all, batches).filter(inScope));
  // the cards' badge is on the question as answered here (a kept answer is not the person's any more)
  const cardOf = (shown: Ask) => { const was = answered.get(shown.id); return was && !was.changed ? was.ask : shown; };
  const quick = (scoped.find((g) => g.key === "person")?.asks.filter((a) => isQuick(cardOf(a))).length ?? 0) + unlisted.length;
  // narrowed by the list's question: a card answered here stays where it was, with what the answer did, until the list is read again
  const groups = quickOnly ? quickGroups(scoped) : scoped;
  // the live approvals not in the list yet have no Workspace: shown (and counted) whatever the filter
  const open = (list ? list.asks.filter((a) => inScope(a) && (a.state === "open" || a.state === "held") && a.needs === "person").length : 0) + unlisted.length;

  return (
    <main className="main approvals">
      <section className="card">
        <div className="row head">
          <h5>
            {t(m.approvalsHeading)} <span className="hint">{open}</span>
          </h5>
          <button className="ghost" onClick={load}>
            {t(m.reload)}
          </button>
        </div>
        {chips.length > 0 && (
          <div className="ask-workspaces">
            <button className={narrowed === null ? "pri" : undefined} onClick={() => setWorkspace(null)}>
              {t(m.all)}
            </button>
            {chips.map((c) => (
              <button key={c.key} className={narrowed === c.key ? "pri" : undefined} data-workspace={c.key} onClick={() => setWorkspace(c.key)}>
                {c.name} {c.count}
              </button>
            ))}
          </div>
        )}
        {/* a toggle of its own (#1675), not one of the Workspace's choices: it narrows on top of them */}
        {(chips.length > 0 || unlisted.length > 0) && (
          <div className="ask-quick-row">
            <button className={quickOnly ? "pri" : undefined} aria-pressed={quickOnly} onClick={() => setQuickOnly((q) => !q)}>
              {t(m.quick)} {quick}
            </button>
          </div>
        )}
        {quickOnly && unlisted.length === 0 && !groups.some((g) => g.key === "person") && <div className="hint ask-quick-none">{t(m.quickNone)}</div>}
        {failed && <div className="hint warn ask-failed">{list ? t(m.failedStale) : t(m.failedNone)}{t(m.failedRetry)}</div>}
        {!list && !failed && <div className="muted">{t(m.loading)}</div>}
        {list && list.asks.length === 0 && <div className="muted">{t(m.noAsks)}</div>}
        {list?.errors.map((e) => (
          <div key={e.workspaceId} className="hint">
            {e.workspaceName}: {e.message}
          </div>
        ))}
      </section>
      {batches.map((b) => (
        <BatchCard key={b.id} batch={b} onOpenTask={props.onOpenTask} onError={props.onError} onDone={load} />
      ))}
      {unlisted.map((a) => (
        <section key={askId(a)} className="card ask approval" data-ask={askId(a)}>
          <div className="ask-tags">
            <span className="badge ask-kind ask-kind-approval">{KIND_LABEL.approval}</span>
            <span className="badge ask-state ask-state-open">{STATE_LABEL.open}</span>
            <span className="badge ask-quick">{t(m.quick)}</span>
          </div>
          {approvalHead(a)}
        </section>
      ))}
      {groups.map((g) => (
        <section key={g.key} className={`ask-group ask-group-${g.key}`}>
          <h5 className="ask-group-head">
            {g.label} <span className="hint">{g.asks.length}</span>
          </h5>
          {g.key === "auto" && <div className="hint">{t(m.autoHint)}</div>}
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
                const parts = askCardParts(x);
                return (
                  <section key={x.id} className={`card ask${a ? " approval" : ""}`} data-ask={x.id}>
                    <div className="ask-tags">
                      <span className={`badge ask-kind ask-kind-${x.kind}`}>{KIND_LABEL[x.kind]}</span>
                      <span className={`badge ask-state ask-state-${x.state}`}>{STATE_LABEL[x.state]}</span>
                      {isQuick(x) && <span className="badge ask-quick">{t(m.quick)}</span>}
                      {unblocksLine(x) && <span className="badge ask-unblocks">{unblocksLine(x)}</span>}
                    </div>
                    {x.unblocks.length > 0 && (
                      <div className="hint ask-unblocks-list">
                        {unblockLinks(x.unblocks).map((u) =>
                          u.href ? (
                            <a key={u.number} href={u.href} target="_blank" rel="noreferrer">
                              #{u.number} {u.title}
                            </a>
                          ) : (
                            <span key={u.number}>
                              #{u.number} {u.title}
                            </span>
                          ),
                        )}
                      </div>
                    )}
                    {/* #4068: what it is about and the question, before the answer buttons — a card read from its buttons up */}
                    {parts.title && (
                      <div className="ask-title">
                        {parts.title.href ? (
                          <a href={parts.title.href} target="_blank" rel="noreferrer">
                            {parts.title.text}
                          </a>
                        ) : (
                          parts.title.text
                        )}
                      </div>
                    )}
                    {/* a live approval's own head says what it asks (approvalHead); a long question shows its first lines, 全文 opens it */}
                    {parts.question && !a && <AskQuestion text={parts.question} />}
                    {a && approvalHead(a, !x.answers.length)}
                    {was?.changes && (
                      <div className={`hint ${was.changed ? "warn " : ""}ask-changes`}>
                        {was.changed ? t(m.askChanged) : t(m.changedAtAnswer)}
                        <ul>
                          {was.changes.map((c) => (
                            <li key={c}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {previousLines(x).length > 0 && (x.state === "open" || x.state === "held") && (
                      <div className="hint warn ask-previous">
                        {t(m.previousDiffers)}
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
                            {t(m.openTask)}
                          </button>
                        )}
                      </div>
                    )}
                    {/* seen before the answer buttons, to compare and then choose (#2221) */}
                    <Mockups list={x.mockups} />
                    {/* before the facts: on a phone the buttons stay in the first screenful (#26) */}
                    <AnswerArea key={x.id} ask={x} busy={sending !== null} onAnswer={(answer, policy) => send(x, answer, policy)} />
                    <dl className="ask-facts">
                      {parts.facts.map((f) => (
                        <div key={f.label} className="ask-fact">
                          <dt>{f.label}</dt>
                          <dd>
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
                    {parts.unknown.length > 0 && <div className="hint ask-unknown">{t(m.unknownFacts, { labels: parts.unknown.join("・") })}</div>}
                    <div className="approval-actions">
                      {x.route === "backlog" && (x.state === "open" || x.state === "held") && (
                        <button className="pri ask-route" onClick={props.onOpenBacklog}>
                          {t(m.answerInBacklog)}
                        </button>
                      )}
                      {!a && taskId && (
                        <button className="ask-route" onClick={() => props.onOpenTask(taskId)}>
                          {t(m.openTask)}
                        </button>
                      )}
                      {issueOpenHref(x) && (
                        <a className="button ask-route" href={issueOpenHref(x) ?? undefined} target="_blank" rel="noreferrer">
                          {t(m.openIssue)}
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
 * The Tasks stopped on the same wait, across Workspaces (#2046): sso = one 「ログインする」 sends the oldest Task on to log
 * in (its device code shows here), the rest go on after it; deploy = the chosen Tasks (all at first) get the approval.
 */
export function BatchCard(props: { batch: AskBatch; onOpenTask: (id: string) => void; onError: (m: string) => void; onDone: () => void }) {
  const { batch: b } = props;
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const chosen = b.asks.map((a) => a.taskId).filter((id) => !off.has(id));
  const press = () => {
    setBusy(true);
    api
      .answerBatch(b.id, b.kind === "deploy" ? chosen : undefined)
      .catch((e) => props.onError(t(m.batchFailed, { batch: BATCH_LABEL[b.kind], error: String(e.message ?? e) })))
      // read again either way: a failure part way leaves the Tasks already sent out of the batch
      .finally(() => {
        setBusy(false);
        props.onDone();
      });
  };
  return (
    <section className="card ask ask-batch" data-batch={b.id}>
      <h5>
        {BATCH_LABEL[b.kind]} <span className="hint">{b.asks.length + (b.loggingIn ? 1 : 0)}</span>
      </h5>
      {b.loggingIn && (
        <div className="ask-batch-login">
          <div className="hint">
            {t(m.loggingIn)}<button className="ghost link" onClick={() => props.onOpenTask(b.loggingIn!.taskId)}>{b.loggingIn.title}</button>
          </div>
          <DeviceAuth auth={b.deviceAuth} onError={props.onError} />
        </div>
      )}
      <ul className="ask-batch-tasks">
        {batchLines(b).map((l) => (
          <li key={l.taskId} data-task={l.taskId}>
            {b.kind === "deploy" && (
              <input type="checkbox" checked={!off.has(l.taskId)} disabled={busy} onChange={(e) => setOff((s) => { const n = new Set(s); if (e.target.checked) n.delete(l.taskId); else n.add(l.taskId); return n; })} />
            )}{" "}
            <button className="ghost link" onClick={() => props.onOpenTask(l.taskId)}>{l.text}</button>
          </li>
        ))}
      </ul>
      <div className="approval-actions">
        {b.kind === "sso" ? (
          <button className="pri" disabled={busy || b.loggingIn !== null || b.asks.length === 0} onClick={press}>{t(m.logIn)}</button>
        ) : (
          <button className="pri" disabled={busy || chosen.length === 0} onClick={press}>{t(m.approveAll)}</button>
        )}
      </div>
    </section>
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
      <div className="hint">{t(m.mockups)}</div>
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

/** A question card's question (#4068): whole when short; the first lines and 全文 when long. */
function AskQuestion(props: { text: string }) {
  const q = questionHead(props.text);
  if (!q.more) return <div className="ask-question">{props.text}</div>;
  return (
    <details className="ask-question">
      <summary>
        <span className="q-head">{q.head}</span>
        <span className="hint q-more"> {t(m.questionWhole)}</span>
        <span className="hint q-less">{t(m.questionFold)}</span>
      </summary>
      {props.text}
    </details>
  );
}
