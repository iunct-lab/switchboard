import { useEffect, useState } from "react";
import type { Task, TerminalStatus, Workspace } from "@switchboard/protocol";
import { OriginTag, BackgroundTag, ResumeTag, ShadowTag } from "./ui.tsx";
import { attentionList, outcomeDotClass, outcomeLabel, terminalMark } from "../attention.ts";
import { taskTimes } from "../inProgress.ts";
import { filterTasks, PAGE, STATUS_FILTERS, type StatusFilter } from "../taskList.ts";
import { t } from "../i18n.ts";
import { home } from "../i18n/home.ts";
import { listTitle } from "../taskTitle.ts";

/** The tooltip's line of when a Task started and since when it is in its status, JST (#2030); the row itself has no room. */
const timesLine = (t: Task) => {
  const x = taskTimes(t, Date.now());
  return `${x.started} · ${x.since}`;
};

/** Claude Code in the Task's terminal tab: working / waiting for the person (#1574). */
function TerminalMark(props: { status: TerminalStatus | undefined }) {
  const mark = terminalMark(props.status);
  return mark && <span className={mark.className}>{mark.text}</span>;
}

const dotClass = (s: Task["status"]) => (s === "running" ? "run" : s === "waiting" ? "wait" : s === "error" ? "err" : "idle");

export function Rail(props: { workspaces: Workspace[]; tasks: Task[]; currentTaskId?: string; approvals: number; approvalsOpen: boolean; onApprovals: () => void; listOpen: boolean; onToggleList: () => void; onOpenTask: (id: string) => void; onHome: () => void; onFeedback: () => void; onShowArchived: () => void; terminals: Record<string, TerminalStatus> }) {
  // the Tasks group (#1142): searched and filtered in what the page holds, drawn PAGE rows at a time
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [archived, setArchived] = useState(false);
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [q, status, archived]);
  const rows = filterTasks(props.tasks, { q, status, archived });
  // the groups above and the counts leave the archived ones out
  const live = props.tasks.filter((t) => t.archivedAt === null);
  const byWs = new Map<string | null, Task[]>();
  for (const t of live) {
    const k = t.workspaceId;
    byWs.set(k, [...(byWs.get(k) ?? []), t]);
  }
  const active = live.filter((t) => t.status === "running" || t.status === "waiting" || t.background || props.terminals[t.id] === "waiting");
  const attention = attentionList(live);
  return (
    <aside className={`rail ${props.listOpen ? "open" : ""}`}>
      <button className={`it rail-approvals ${props.approvalsOpen ? "on" : ""}`} onClick={props.onApprovals} title={t(home.approvalsTitle)}>
        <span className="t">{t(home.approvals)}</span>
        {props.approvals > 0 && <span className="badge">{props.approvals}</span>}
      </button>
      {/* Phones only (#359): the list below is hidden there until this opens it. */}
      <button className={`it rail-tasks ${props.listOpen ? "on" : ""}`} onClick={props.onToggleList}>
        <span className="t">{t(home.list)}</span>
      </button>
      <div className="rail-list">
      {active.length > 0 && (
        <>
          <div className="grp">Running · Waiting</div>
          {active.map((t) => (
            <button key={t.id} className={`it ${props.currentTaskId === t.id ? "on" : ""}`} onClick={() => props.onOpenTask(t.id)} title={`${t.title}\n${timesLine(t)}`}>
              <span className="t">{listTitle(t.title)}</span>
              <ShadowTag task={t} />
              <TerminalMark status={props.terminals[t.id]} />
              <span className={`dot ${dotClass(t.status)}`} />
            </button>
          ))}
        </>
      )}
      {attention.length > 0 && (
        <>
          <div className="grp">{t(home.railAttention, { count: attention.length })}</div>
          {attention.map((t) => (
            <button key={t.id} className={`it ${props.currentTaskId === t.id ? "on" : ""}`} onClick={() => props.onOpenTask(t.id)} title={`${t.title}\n${outcomeLabel(t.outcome)}\n${timesLine(t)}`}>
              <span className="t">{listTitle(t.title)}</span>
              <span className="m">{outcomeLabel(t.outcome)}</span>
              <span className={`dot ${outcomeDotClass(t.outcome)}`} />
            </button>
          ))}
        </>
      )}
      <div className="grp">Workspace</div>
      {props.workspaces.map((w) => (
        <div key={w.id} className="it" title={w.path}>
          <span className="t">
            {w.name}
            {w.kind === "meta" && <span className="tag">{t(home.selfTag)}</span>}
          </span>
          <span className="m">{byWs.get(w.id)?.length ?? 0}</span>
        </div>
      ))}
      <div className="grp">Tasks</div>
      <input className="rail-search" aria-label={t(home.searchLabel)} placeholder={t(home.search)} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="rail-filters">
        <select aria-label={t(home.status)} value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            aria-label={t(home.showArchived)}
            checked={archived}
            onChange={(e) => {
              setArchived(e.target.checked);
              if (e.target.checked) props.onShowArchived();
            }}
          />{" "}
          {t(home.archived)}
        </label>
      </div>
      {props.tasks.length === 0 && <div className="it muted">{t(home.noTasks)}</div>}
      {props.tasks.length > 0 && rows.length === 0 && <div className="it muted">{t(home.noMatch)}</div>}
      {rows.slice(0, shown).map((x) => (
        <button key={x.id} className={`it ${props.currentTaskId === x.id ? "on" : ""}`} onClick={() => props.onOpenTask(x.id)} title={`${x.title}\n${timesLine(x)}\n${x.cwd}${x.origin === "terminal" ? `\n${t(home.terminalImported)}` : ""}`}>
          <span className="t">{listTitle(x.title)}</span>
          {/* Two tags leave the title no room in this width; while a resume is planned that tag matters more (the tooltip still says Terminal). */}
          {x.resumeAt === null && <OriginTag origin={x.origin} />}
          <ResumeTag resumeAt={x.resumeAt} reason={x.resumeReason} plannedAt={x.resumePlannedAt} compact />
          <BackgroundTag background={x.background} compact />
          {x.resumeAt === null && <ShadowTag task={x} />}
          <TerminalMark status={props.terminals[x.id]} />
          <span className={`dot ${dotClass(x.status)}`} />
        </button>
      ))}
      {rows.length > shown && (
        <button className="ghost rail-more" onClick={() => setShown((n) => n + PAGE)}>
          {t(home.more, { count: rows.length - shown })}
        </button>
      )}
      </div>
      <button className="ghost rail-feedback" onClick={props.onFeedback} title={t(home.feedbackTitle)}>{t(home.feedback)}</button>
    </aside>
  );
}
