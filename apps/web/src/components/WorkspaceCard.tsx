import { useCallback, useEffect, useState } from "react";
import type { Task, Workspace, WorkspaceRemoval } from "@switchboard/protocol";
import { api, type RunnerConfigView, type WorkspaceClone } from "../api.ts";
import { runnerConfigSummary } from "../foreignWorkspace.ts";
import { GithubLoginRow } from "./GithubLoginRow.tsx";
import { RULES_MAX, baselineWarning, canAdopt, canRemove, canSaveRules, canStartBaseline, cloneRowText, removalWarning } from "../workspaceAdd.ts";
import { t } from "../i18n.ts";
import { common as m } from "../i18n/common.ts";

/** A foreign repository (#2576): its runner config shown as text until confirmed, then 元の更新を取り込む. */
function ForeignRow(props: { workspace: Workspace; onTaskStarted: (task: Task) => void; onError: (msg: string) => void }) {
  const { workspace: w, onError } = props;
  const [config, setConfig] = useState<RunnerConfigView | null>(null);
  const [busy, setBusy] = useState(false);
  const fail = (e: unknown) => onError(String((e as Error).message ?? e));
  const read = useCallback(() => api.runnerConfig(w.id).then(setConfig).catch((e: unknown) => onError(String((e as Error).message ?? e))), [w.id, onError]);
  useEffect(() => {
    void read();
  }, [read]);
  if (!config) return null;
  if (config.confirmed) {
    return (
      <div className="row">
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api.syncUpstream(w.id).then(props.onTaskStarted).catch((e: unknown) => {
              fail(e);
              void read(); // refused because the config changed since: back to the list
            }).finally(() => setBusy(false));
          }}
        >
          {t(m.syncUpstream)}
        </button>
      </div>
    );
  }
  return (
    <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
      <div className="hint">{runnerConfigSummary(config.files)}</div>
      {config.files.map((f) => (
        <details key={f.path}>
          <summary className="mono">{f.path}</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{f.content}</pre>
        </details>
      ))}
      <div className="row">
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api.confirmRunnerConfig(w.id, config.hash).then(read).catch((e: unknown) => {
              fail(e);
              void read();
            }).finally(() => setBusy(false));
          }}
        >
          {t(m.configConfirmed)}
        </button>
      </div>
    </div>
  );
}

/**
 * A repository of your own: 取り込み (the adopt-repo skill, with or without GitHub) and 立ち上げ (the p2-baseline candidate from a
 * concept). Each starts one Task and opens it. There is no confirmation here: 取り込み asks in the Task before it writes
 * anything, and 立ち上げ asks its decisions in the Task before its first pull request merges.
 */
function OwnRow(props: { workspace: Workspace; open: boolean; onOpen: (open: boolean) => void; onTaskStarted: (task: Task) => void; onError: (msg: string) => void }) {
  const { workspace: w, open } = props;
  const [busy, setBusy] = useState(false);
  const [concept, setConcept] = useState("");
  const run = (start: () => Promise<Task>, after?: () => void) => {
    setBusy(true);
    start()
      .then((task) => {
        after?.();
        props.onTaskStarted(task);
      })
      .catch((e: unknown) => props.onError(String((e as Error).message ?? e)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <div className="row" style={{ justifyContent: "flex-start" }}>
        {canAdopt(w) ? <button className="ghost" disabled={busy} onClick={() => run(() => api.adoptRepo(w.id))}>{t(m.adopt)}</button> : null}
        <button className={open ? undefined : "ghost"} aria-expanded={open} onClick={() => props.onOpen(!open)}>{t(m.baseline)}</button>
      </div>
      {open ? (
        <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <div className="hint">{t(m.baselineHint)}</div>
          <textarea value={concept} onChange={(e) => setConcept(e.target.value)} aria-label={t(m.baselineLabel)} placeholder={t(m.baselinePlaceholder)} rows={5} />
          {baselineWarning(concept) ? <div className="hint">{baselineWarning(concept)}</div> : null}
          <div className="row">
            <button disabled={busy || !canStartBaseline(concept)} onClick={() => run(() => api.startBaseline(w.id, concept.trim()), () => { setConcept(""); props.onOpen(false); })}>{t(m.baselineStart)}</button>
            <button className="ghost" onClick={() => props.onOpen(false)}>{t(m.cancel)}</button>
          </div>
        </div>
      ) : null}
      {w.rules ? <RulesFold workspace={w} onError={props.onError} /> : null}
    </>
  );
}

/**
 * The rules an adoption kept on Switchboard's side, folded under the row: read them and correct them. Only a workspace
 * that has rules shows it (an adoption Task places them; there is no box to write them from nothing). When the kept
 * text changes (a save here, or a change from elsewhere), the box starts again from it and the fold stays as it was.
 */
function RulesFold(props: { workspace: Workspace; onError: (msg: string) => void }) {
  const saved = props.workspace.rules ?? "";
  const [draft, setDraft] = useState(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(saved), [saved]);
  return (
    <details className="ws-rules">
      <summary>{t(m.rulesHeading)}</summary>
      <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
        <div className="hint">{t(m.rulesHint)}</div>
        <textarea value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={t(m.rulesLabel)} rows={8} />
        {draft.length > RULES_MAX ? <div className="hint">{t(m.rulesTooLong, { n: draft.length, max: RULES_MAX })}</div> : null}
        <div className="row" style={{ justifyContent: "flex-start" }}>
          <button
            disabled={busy || !canSaveRules(draft, saved)}
            onClick={() => {
              setBusy(true);
              api.setWorkspaceRules(props.workspace.id, draft).catch((e: unknown) => props.onError(String((e as Error).message ?? e))).finally(() => setBusy(false));
            }}
          >
            {t(m.rulesSave)}
          </button>
        </div>
      </div>
    </details>
  );
}

/** The name the server will give the copy, for display only: after the last separator, without `.git` and a trailing `/`. */
function repoName(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf(":")) + 1);
}

/** Where the private copy will be made, `<owner>/<name>`; an empty owner reads as the owner's own account. */
export function ownCopyTarget(owner: string, repoInput: string): string {
  return `${owner.trim() || t(m.ownCopyMyAccount)}/${repoName(repoInput) || t(m.ownCopyNamePlaceholder)}`;
}

/** The mark to make a private copy of your own, and (only while it is on) the destination field with where it will land. */
export function OwnCopyFields(props: { ownCopy: boolean; owner: string; repo: string; onOwnCopy: (v: boolean) => void; onOwner: (v: string) => void }) {
  return (
    <>
      <label className="hint" style={{ display: "block" }}>
        <input type="checkbox" checked={props.ownCopy} onChange={(e) => props.onOwnCopy(e.target.checked)} /> {t(m.ownCopy)}
      </label>
      {props.ownCopy ? (
        <div className="row" style={{ paddingLeft: 22, justifyContent: "flex-start", flexWrap: "wrap" }}>
          <input value={props.owner} onChange={(e) => props.onOwner(e.target.value)} aria-label={t(m.ownCopyOwnerLabel)} placeholder={t(m.ownCopyOwnerPlaceholder)} style={{ width: "12em" }} />
          <span className="hint">→ {ownCopyTarget(props.owner, props.repo)}</span>
        </div>
      ) : null}
    </>
  );
}

/**
 * Workspace (#1447): the registered repositories and the ways to add one, in one place. 新しく作る asks a Task to create
 * and register a repository (the steps are the skill's, not the daemon's); GitHub から clones one of the owner's own next
 * to the checkout (#2575); ホストのディレクトリ registers a directory that already exists.
 */
export function WorkspaceCard(props: { workspaces: Workspace[]; clones: WorkspaceClone[]; onAddWorkspaceFromGithub: (repo: string, backlog: "github" | "switchboard", ownCopy: boolean, ownCopyOwner: string) => Promise<void>; onAddWorkspace: (path: string, backlog: "github" | "switchboard") => Promise<void>; onTaskStarted: (task: Task) => void; onError: (msg: string) => void }) {
  const [method, setMethod] = useState<"github" | "new" | "path">("github");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [newPath, setNewPath] = useState("");
  const [repo, setRepo] = useState("");
  // a workspace without GitHub (#2265): its backlog kept in Switchboard; off by default
  const [localBacklog, setLocalBacklog] = useState(false);
  // 他者のリポジトリを自分の GitHub の非公開のコピーにもする印: always offered (whether it is yours is not known before adding); off by default and put back after an add
  const [ownCopy, setOwnCopy] = useState(false);
  // where that copy goes: empty means the owner's own account
  const [copyOwner, setCopyOwner] = useState("");
  // the row whose 登録を外す is open (#2600): what removing it would do, the typed name, and whether the copy goes too
  const [removing, setRemoving] = useState<{ id: string; info: WorkspaceRemoval; typed: string; deleteCopy: boolean } | null>(null);
  // the row whose 立ち上げ is open: one at a time, like 登録を外す
  const [launching, setLaunching] = useState<string | null>(null);
  const fail = (e: unknown) => props.onError(String((e as Error).message ?? e));
  const localBacklogBox = (
    <label className="hint">
      <input type="checkbox" checked={localBacklog} onChange={(e) => setLocalBacklog(e.target.checked)} /> {t(m.localBacklog)}
    </label>
  );
  return (
    <details className="card" id="workspace">
      <summary>
        <h5>Workspace</h5>
      </summary>
      {props.workspaces.filter((w) => w.kind === "repo").map((w) => (
        <div key={w.id}>
          <div className="row">
            <span>{w.upstream ? t(m.upstreamName, { name: w.name, upstream: w.upstream }) : w.name}</span>
            <span className="mono hint" style={{ flex: 1 }}>{w.path}</span>
            <button className="ghost" onClick={() => api.workspaceRemoval(w.id).then((info) => setRemoving({ id: w.id, info, typed: "", deleteCopy: false })).catch(fail)}>{t(m.unregister)}</button>
          </div>
          {w.upstream ? <ForeignRow workspace={w} onTaskStarted={props.onTaskStarted} onError={props.onError} /> : <OwnRow workspace={w} open={launching === w.id} onOpen={(o) => setLaunching(o ? w.id : null)} onTaskStarted={props.onTaskStarted} onError={props.onError} />}
          {removing?.id === w.id ? (
            <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
              {removalWarning(removing.info, removing.deleteCopy) ? <div className="hint">{removalWarning(removing.info, removing.deleteCopy)}</div> : null}
              <input value={removing.typed} onChange={(e) => setRemoving({ ...removing, typed: e.target.value })} aria-label={t(m.removeNameLabel)} placeholder={removing.info.name} />
              {removing.info.copy.deletable ? (
                <label className="hint">
                  <input type="checkbox" checked={removing.deleteCopy} onChange={(e) => setRemoving({ ...removing, deleteCopy: e.target.checked })} /> {t(m.deleteCopy)}
                </label>
              ) : null}
              <div className="row">
                <button
                  disabled={busy || !canRemove(removing.typed, removing.info)}
                  onClick={() => {
                    setBusy(true);
                    api.removeWorkspace(w.id, removing.deleteCopy).then(() => setRemoving(null)).catch(fail).finally(() => setBusy(false));
                  }}
                >
                  {t(m.unregister)}
                </button>
                <button className="ghost" onClick={() => setRemoving(null)}>{t(m.cancel)}</button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
      <h5>{t(m.addHeading)}</h5>
      <GithubLoginRow onError={props.onError} />
      <div className="row">
        <button className={method === "github" ? undefined : "ghost"} onClick={() => setMethod("github")}>{t(m.fromGithub)}</button>
        <button className={method === "new" ? undefined : "ghost"} onClick={() => setMethod("new")}>{t(m.createNew)}</button>
        <button className={method === "path" ? undefined : "ghost"} onClick={() => setMethod("path")}>{t(m.addHostDir)}</button>
      </div>
      {method === "github" ? (
        <>
          <div className="row">
            <input value={repo} onChange={(e) => setRepo(e.target.value)} aria-label={t(m.githubRepoLabel)} placeholder={t(m.githubRepoPlaceholder)} style={{ flex: 1 }} />
            <button
              disabled={!repo.trim()}
              onClick={() =>
                props
                  .onAddWorkspaceFromGithub(repo.trim(), localBacklog ? "switchboard" : "github", ownCopy, copyOwner)
                  .then(() => {
                    setRepo((now) => (now === repo ? "" : now));
                    setOwnCopy(false);
                    setCopyOwner("");
                  })
                  .catch(fail)
              }
            >
              {t(m.add)}
            </button>
          </div>
          <OwnCopyFields ownCopy={ownCopy} owner={copyOwner} repo={repo} onOwnCopy={setOwnCopy} onOwner={setCopyOwner} />
          {props.clones.map((c) => (
            <div key={c.path} className="hint">{cloneRowText(c)}</div>
          ))}
          {localBacklogBox}
        </>
      ) : method === "new" ? (
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t(m.newRepoNameLabel)} placeholder={t(m.newRepoNamePlaceholder)} pattern="[A-Za-z0-9._-]{1,100}" />
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label={t(m.newRepoPurposeLabel)} placeholder={t(m.newRepoPurposePlaceholder)} style={{ flex: 1 }} />
          <button
            disabled={busy || !name.trim() || !purpose.trim()}
            onClick={() => {
              setBusy(true);
              api
                .newRepo(name.trim(), purpose.trim())
                .then((task) => {
                  setName("");
                  setPurpose("");
                  props.onTaskStarted(task);
                })
                .catch(fail)
                .finally(() => setBusy(false));
            }}
          >
            {t(m.askToCreate)}
          </button>
        </div>
      ) : (
        <>
          <div className="row">
            <input value={newPath} onChange={(e) => setNewPath(e.target.value)} placeholder="/absolute/path/to/repo" style={{ flex: 1 }} />
            <button
              disabled={!newPath.trim()}
              onClick={() =>
                props
                  .onAddWorkspace(newPath.trim(), localBacklog ? "switchboard" : "github")
                  .then(() => {
                    setNewPath("");
                    setLocalBacklog(false);
                  })
                  .catch(fail)
              }
            >
              {t(m.add)}
            </button>
          </div>
          {localBacklogBox}
        </>
      )}
    </details>
  );
}
