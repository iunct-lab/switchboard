import { useState } from "react";
import type { Task, Workspace, WorkspaceRemoval } from "@switchboard/protocol";
import { api, type WorkspaceClone } from "../api.ts";
import { canRemove, cloneRowText, removalWarning } from "../workspaceAdd.ts";

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
      <input type="checkbox" checked={localBacklog} onChange={(e) => setLocalBacklog(e.target.checked)} /> GitHub と連携しない（Issue・Project を Switchboard に置く。PR は今どおり Remote）
    </label>
  );
  return (
    <section className="card">
      <h5>Workspace</h5>
      {props.workspaces.filter((w) => w.kind === "repo").map((w) => (
        <div key={w.id}>
          <div className="row">
            <span>{w.name}</span>
            <span className="mono hint" style={{ flex: 1 }}>{w.path}</span>
            <button className="ghost" onClick={() => api.workspaceRemoval(w.id).then((info) => setRemoving({ id: w.id, info, typed: "", deleteCopy: false })).catch(fail)}>登録を外す</button>
          </div>
          {removing?.id === w.id ? (
            <div className="row" style={{ flexDirection: "column", alignItems: "stretch" }}>
              {removalWarning(removing.info, removing.deleteCopy) ? <div className="hint">{removalWarning(removing.info, removing.deleteCopy)}</div> : null}
              <input value={removing.typed} onChange={(e) => setRemoving({ ...removing, typed: e.target.value })} aria-label="外す workspace の名前" placeholder={removing.info.name} />
              {removing.info.copy.deletable ? (
                <label className="hint">
                  <input type="checkbox" checked={removing.deleteCopy} onChange={(e) => setRemoving({ ...removing, deleteCopy: e.target.checked })} /> ローカルのコピーも消す
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
                  登録を外す
                </button>
                <button className="ghost" onClick={() => setRemoving(null)}>やめる</button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
      <h5>追加</h5>
      <div className="row">
        <button className={method === "github" ? undefined : "ghost"} onClick={() => setMethod("github")}>GitHub から</button>
        <button className={method === "new" ? undefined : "ghost"} onClick={() => setMethod("new")}>新しく作る</button>
        <button className={method === "path" ? undefined : "ghost"} onClick={() => setMethod("path")}>ホストにあるディレクトリを追加</button>
      </div>
      {method === "github" ? (
        <>
          <div className="row">
            <input value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="GitHub のリポジトリ" placeholder="owner/name か https://github.com/owner/name" style={{ flex: 1 }} />
            <button
              disabled={!repo.trim()}
              onClick={() =>
                props
                  .onAddWorkspaceFromGithub(repo.trim(), localBacklog ? "switchboard" : "github")
                  .then(() => setRepo((now) => (now === repo ? "" : now)))
                  .catch(fail)
              }
            >
              追加
            </button>
          </div>
          {props.clones.map((c) => (
            <div key={c.path} className="hint">{cloneRowText(c)}</div>
          ))}
          {localBacklogBox}
        </>
      ) : method === "new" ? (
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="新しいリポジトリの名前" placeholder="名前" pattern="[A-Za-z0-9._-]{1,100}" />
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} aria-label="新しいリポジトリの用途" placeholder="用途" style={{ flex: 1 }} />
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
            作成を頼む
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
              追加
            </button>
          </div>
          {localBacklogBox}
        </>
      )}
    </section>
  );
}
