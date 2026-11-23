import { Fragment, type ReactNode } from "react";
import type { BacklogItem } from "@switchboard/protocol";
import { issueHref } from "../backlogSync.ts";
import { overlapLine, type pbiOwner } from "../inProgress.ts";
import { t } from "../i18n.ts";
import { backlog as m } from "../i18n/backlog.ts";

/** An Issue's number or title: a link to GitHub, the plain text for an Issue with no page there (the list opens it by 編集). */
export function IssueLink(props: { url: string; className?: string; children: ReactNode }) {
  const href = issueHref(props.url);
  if (!href) return <span className={props.className}>{props.children}</span>;
  return (
    <a className={props.className} href={href} target="_blank" rel="noreferrer">
      {props.children}
    </a>
  );
}

/**
 * Who moves a wait, an overlap or a queue line's holder forward (`pbiOwner`): ` ← #<PBI> の Task <id>（<state>）`,
 * the Task opening on a click, or 工程 Task なし / Task 不明. A wait's names the PBI's title too (`withTitle`; an overlap
 * or a holder repeats per path, the number is enough there); `startable` (a wait's only) adds 続きを始める.
 */
export function OwnerTask(props: { owner: ReturnType<typeof pbiOwner> & { startable?: boolean }; withTitle?: boolean; onOpenTask: (id: string) => void; starting?: number | null; onStart?: (pbi: number) => void }) {
  const { pbi, task, startable } = props.owner;
  const onStart = props.onStart;
  return (
    <>
      {" ← "}
      <IssueLink url={pbi.url}>
        #{pbi.number}
        {props.withTitle && ` ${pbi.title}`}
      </IssueLink>
      {t(m.ownerOf)}
      {task === "unknown" ? (
        t(m.taskUnknown)
      ) : task === null ? (
        t(m.noStageTask)
      ) : (
        <button className="ghost link" onClick={() => props.onOpenTask(task.id)}>
          {t(m.ownerTask, { id: task.id, label: task.label })}
        </button>
      )}
      {startable && onStart && (
        <>
          {" "}
          <button className="ghost" disabled={props.starting != null} onClick={() => onStart(pbi.number)}>
            {t(m.continue)}
          </button>
        </>
      )}
    </>
  );
}

/**
 * A Ready / in-progress row's overlap with other work (`overlapLine`): the PR / Task whose files its Tasks name, each
 * followed by the PBI that moves it and that PBI's Task (`OwnerTask`), or why that cannot be judged, in the warning
 * colour. backlog-next leaves the row; the button still starts it.
 */
export function Overlap(props: { item: BacklogItem; items: BacklogItem[]; onOpenTask: (id: string) => void }) {
  const line = overlapLine(props.item, props.items);
  if (!line) return null;
  return (
    <div className="backlog-overlap hint warn" data-issue={props.item.url}>
      {line.hits.length > 0 && (
        <div>
          {t(m.overlap)}{" "}
          {line.hits.map((h, n) => (
            <Fragment key={`${h.ref}:${h.path}`}>
              {n > 0 && t(m.listSep)}
              <IssueLink url={h.url}>
                {h.ref}
              </IssueLink>
              {t(m.paren, { text: h.path })}
              {h.owner && <OwnerTask owner={h.owner} onOpenTask={props.onOpenTask} />}
            </Fragment>
          ))}
        </div>
      )}
      {line.unknown !== null && <div>{t(m.overlapUnknown, { reason: line.unknown })}</div>}
    </div>
  );
}
