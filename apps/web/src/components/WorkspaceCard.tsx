import { useCallback, useEffect, useState } from "react";
import type { Task, Workspace, WorkspaceRemoval } from "@switchboard/protocol";
import { api, type RunnerConfigView, type WorkspaceClone } from "../api.ts";
import { runnerConfigSummary } from "../foreignWorkspace.ts";
import { canRemove, cloneRowText, removalWarning } from "../workspaceAdd.ts";
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
 * Workspace (#1447): the registered repositories and the ways to add one, in one place. 新しく作る asks a Task to create
 * and register a repository (the steps are the skill's, not the daemon's); GitHub から clones one of the owner's own next
 * to the checkout (#2575); ホストのディレクトリ registers a directory that already exists.
 */
export function WorkspaceCard(props: { workspaces: Workspace[]; clones: WorkspaceClone[]; onAddWorkspaceFromGithub: (repo: string, backlog: "github" | "switchboard") => Promise<void>; onAddWorkspace: (path: string, backlog: "github" | "switchboard") => Promise<void>; onTaskStarted: (task: Task) => void; onError: (msg: string) => void }) {
  const [method, setMethod] = useState<"github" | "new" | "path">("github");
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [newPath, setNewPath] = useState("");
  const [repo, setRepo] = useState("");
  // a workspace without GitHub (#2265): its backlog kept in Switchboard; off by default
  const [localBacklog, setLocalBacklog] = useState(false);
  // the row whose 登録を外す is open (#2600): what removing it would do, the typed name, and whether the copy goes too
  const [removing, setRemoving] = useState<{ id: string; info: WorkspaceRemoval; typed: string; deleteCopy: boolean } | null>(null);
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
          {w.upstream ? <ForeignRow workspace={w} onTaskStarted={props.onTaskStarted} onError={props.onError} /> : null}
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
                  .onAddWorkspaceFromGithub(repo.trim(), localBacklog ? "switchboard" : "github")
                  .then(() => setRepo((now) => (now === repo ? "" : now)))
                  .catch(fail)
              }
            >
              {t(m.add)}
            </button>
          </div>
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
