import { useState } from "react";
import type { BacklogAction, CreatedIssueRow, Task } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { createdRowButtons, createdRowStage, startCreatedRow } from "../createdIssues.ts";
import { t } from "../i18n.ts";
import { task as m } from "../i18n/task.ts";
import { activeTaskLine } from "../inProgress.ts";
import { IssueLink } from "./BacklogOwner.tsx";

/**
 * この Task が作った Issue: the open requests and PBIs the Task opened, under the conversation, each with its stage and
 * the step it can start now as another Task (the Backlog row's buttons), or the link to its running stage Task.
 * Nothing when the Task opened none.
 */
export function CreatedIssues(props: { rows: CreatedIssueRow[]; onStarted: (task: Task) => void; onOpenTask: (id: string) => void; onError: (msg: string) => void }) {
  const [starting, setStarting] = useState<string | null>(null);
  if (props.rows.length === 0) return null;
  const now = Date.now();
  const start = (row: CreatedIssueRow, action: BacklogAction) => {
    setStarting(`${row.workspaceId}#${row.number}`);
    void startCreatedRow(api.startBacklog, row, action, props).finally(() => setStarting(null));
  };
  return (
    <section className="created-issues" aria-label={t(m.createdIssues)}>
      <h5>{t(m.createdIssues)}</h5>
      {props.rows.map((r) => {
        const stage = createdRowStage(r);
        const active = r.item?.activeTaskId ?? null;
        const buttons = active ? [] : createdRowButtons(r);
        return (
          <div key={`${r.workspaceId}#${r.number}`} className="created-issue" data-issue={r.url}>
            <span className="t">
              <IssueLink url={r.url}>#{r.number}</IssueLink> {r.title}
              {stage && <span className="pill">{stage}</span>}
            </span>
            {(active || buttons.length > 0) && (
              <div className="created-issue-actions">
                {active && (
                  <button className="ghost link" onClick={() => props.onOpenTask(active)}>
                    {activeTaskLine(r.item!.lastTask?.id === active ? r.item!.lastTask : null, now)}
                  </button>
                )}
                {buttons.map(([action, label]) => (
                  <button key={action} disabled={starting !== null} onClick={() => start(r, action)}>
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
