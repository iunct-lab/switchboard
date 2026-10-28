import { useEffect, useState } from "react";
import type { Task, TerminalStatus, Workspace } from "@switchboard/protocol";
import { OriginTag, ResumeTag, ShadowTag } from "./ui.tsx";
import { attentionList, outcomeDotClass, outcomeLabel, terminalMark } from "../attention.ts";
import { taskTimes } from "../inProgress.ts";
import { filterTasks, PAGE, STATUS_FILTERS, type StatusFilter } from "../taskList.ts";

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
  const active = live.filter((t) => t.status === "running" || t.status === "waiting" || props.terminals[t.id] === "waiting");
  const attention = attentionList(live);
  return (
    <aside className={`rail ${props.listOpen ? "open" : ""}`}>
      <button className={`it rail-approvals ${props.approvalsOpen ? "on" : ""}`} onClick={props.onApprovals} title="承認・判断・確認の待ち">
        <span className="t">判断待ち</span>
        {props.approvals > 0 && <span className="badge">{props.approvals}</span>}
      </button>
      {/* Phones only (#359): the list below is hidden there until this opens it. */}
      <button className={`it rail-tasks ${props.listOpen ? "on" : ""}`} onClick={props.onToggleList}>
        <span className="t">一覧</span>
      </button>
      <div className="rail-list">
      {active.length > 0 && (
        <>
          <div className="grp">Running · Waiting</div>
          {active.map((t) => (
            <button key={t.id} className={`it ${props.currentTaskId === t.id ? "on" : ""}`} onClick={() => props.onOpenTask(t.id)} title={`${t.title}\n${timesLine(t)}`}>
              <span className="t">{t.title}</span>
              <ShadowTag task={t} />
              <TerminalMark status={props.terminals[t.id]} />
              <span className={`dot ${dotClass(t.status)}`} />
            </button>
          ))}
        </>
      )}
      {attention.length > 0 && (
        <>
          <div className="grp">要対応 · {attention.length}</div>
          {attention.map((t) => (
            <button key={t.id} className={`it ${props.currentTaskId === t.id ? "on" : ""}`} onClick={() => props.onOpenTask(t.id)} title={`${t.title}\n${outcomeLabel(t.outcome)}\n${timesLine(t)}`}>
              <span className="t">{t.title}</span>
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
            {w.kind === "meta" && <span className="tag">自分自身</span>}
          </span>
          <span className="m">{byWs.get(w.id)?.length ?? 0}</span>
        </div>
      ))}
      <div className="grp">Tasks</div>
      <input className="rail-search" aria-label="Task を検索" placeholder="検索" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="rail-filters">
        <select aria-label="状態" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          {STATUS_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            aria-label="アーカイブ済みを表示"
            checked={archived}
            onChange={(e) => {
              setArchived(e.target.checked);
              if (e.target.checked) props.onShowArchived();
            }}
          />{" "}
          アーカイブ済み
        </label>
      </div>
      {props.tasks.length === 0 && <div className="it muted">まだタスクがありません</div>}
      {props.tasks.length > 0 && rows.length === 0 && <div className="it muted">当てはまる Task がありません</div>}
      {rows.slice(0, shown).map((t) => (
        <button key={t.id} className={`it ${props.currentTaskId === t.id ? "on" : ""}`} onClick={() => props.onOpenTask(t.id)} title={`${t.title}\n${timesLine(t)}\n${t.cwd}${t.origin === "terminal" ? "\nTerminal で実行（取り込み）" : ""}`}>
          <span className="t">{t.title}</span>
          {/* Two tags leave the title no room in this width; while a resume is planned that tag matters more (the tooltip still says Terminal). */}
          {t.resumeAt === null && <OriginTag origin={t.origin} />}
          <ResumeTag resumeAt={t.resumeAt} reason={t.resumeReason} compact />
          {t.resumeAt === null && <ShadowTag task={t} />}
          <TerminalMark status={props.terminals[t.id]} />
          <span className={`dot ${dotClass(t.status)}`} />
        </button>
      ))}
      {rows.length > shown && (
        <button className="ghost rail-more" onClick={() => setShown((n) => n + PAGE)}>
          さらに表示（残り {rows.length - shown} 件）
        </button>
      )}
      </div>
      <button className="ghost rail-feedback" onClick={props.onFeedback} title="画面のスクショつきで要望を送る。要望 Issue と PBI / Task が作られる">フィードバック</button>
    </aside>
  );
}
