// Who may change a workspace's settings kept on Switchboard's side, and when a change is in force.
//
// The settings hold what the local CI runs and what the merge gate is (`ci`, `mergeGate`, …). In a repository a change of
// those is a PR the merge gate asks the person about; the copy kept here is held to the same: every change is recorded
// (`workspace_config_changes`: before, after, how it came in, when), and a change of a key the gates read is in force only
// after the person confirmed it. Until then `workspaces.config` and the file written from it keep the last confirmed
// value, and the change waits among the questions (判断待ち).
//
// What is and is not guaranteed:
// - Where the passkey login is on (the cloud host), a save or a confirmation counts as the person's only with the login
//   cookie and a fresh passkey check. A Task has the daemon's token, not the cookie: its request can only leave a pending
//   change, and it cannot confirm one.
// - On loopback without the login, the daemon cannot tell the person's page from a Task: both reach it unauthenticated,
//   and a Task can send the headers a page sends. So no save from there puts a gate-read key in force, whoever sent it:
//   it waits, and the confirmation is the step that counts. The confirmation itself asks for the page's look
//   (`humanCheck`), which keeps a slip from passing and is no proof.
// - A Task runs as the daemon's user and can write the database and the files directly. This is consistency of asking
//   and recording, not a boundary (docs/design/new-repo.md, "Who changes the settings").
import { type Ask, type AskAnswerResult, type Workspace } from "@switchboard/protocol";
import { unanswered } from "../asks.ts";
import { ASK_HISTORY_MS } from "../backlog-comments.ts";
import type { WorkspaceConfigChange } from "../db/workspaces.ts";
import { hostAws } from "../../../../ops-kit/src/secrets.ts";
import { changedKeys, checkWorkspaceConfig, configVersion, gatingKeys, savedConfigFile, workspaceConfigSource, writeConfigFiles } from "../workspace-config.ts";
import type { Peer, ServerContext } from "./context.ts";

/** How a request to change the settings came in. Only `person` is known to be the person. */
export type ConfigSource = "person" | "screen" | "call";

export const configSourceOf = async (sc: Pick<ServerContext, "authorize" | "recentRefusal" | "screenLook">, req: Request, srv: Peer): Promise<ConfigSource> => {
  const auth = await sc.authorize(req, srv);
  if (auth.ok && auth.session !== undefined && !sc.recentRefusal(req, auth.session)) return "person";
  return (await sc.screenLook(req, srv)) ? "screen" : "call";
};

/**
 * Whether a change is in force at once. The person's own (cookie and fresh passkey): yes. A request that looks like the
 * page's but is not proven: only when no key the gates read changes. Any other call (a Task's, a script's): never.
 */
export const appliesAtOnce = (source: ConfigSource, keys: readonly string[]): boolean => source === "person" || (source === "screen" && gatingKeys(keys).length === 0);

const ASK_PREFIX = "config:";
export const configAskId = (c: Pick<WorkspaceConfigChange, "workspaceId" | "id">) => `${ASK_PREFIX}${c.workspaceId}:${c.id}`;
export const isConfigAsk = (id: string) => id.startsWith(ASK_PREFIX);

/** What the screens show of a workspace's settings: the confirmed text, its version, and the change that waits. */
export const configView = (sc: Pick<ServerContext, "db">, ws: Workspace) => {
  const pending = sc.db.pendingConfigChanges().find((c) => c.workspaceId === ws.id) ?? null;
  return {
    id: ws.id,
    config: ws.config ?? "",
    file: savedConfigFile(ws.id) || null,
    source: workspaceConfigSource(ws),
    version: configVersion(ws.config),
    pending: pending ? { id: pending.id, askId: configAskId(pending), at: pending.at, source: pending.source, keys: pending.keys, config: pending.after ?? "" } : null,
  };
};

/**
 * PUT /api/workspaces/:id/config. The text is checked (strict shape, no `publicSync`, no value that can authenticate),
 * the change recorded, and put in force or left pending by `appliesAtOnce`. Saving the confirmed text again withdraws a
 * pending change. Returns the view after it, or the refusal's line.
 */
export const saveWorkspaceConfig = async (sc: Pick<ServerContext, "db" | "cfg" | "authorize" | "recentRefusal" | "screenLook" | "logOp" | "broadcast">, req: Request, srv: Peer, ws: Workspace, text: string): Promise<{ refusal: string } | ReturnType<typeof configView>> => {
  const checked = checkWorkspaceConfig(text, hostAws());
  if ("refusal" in checked) return checked;
  const source = await configSourceOf(sc, req, srv);
  // what changes is told against the settings in force when the change is recorded, in that one transaction — not
  // against `ws`, read before the wait above: a change the person confirmed meanwhile is not taken back unasked by a
  // save that was made on the older text
  const c = sc.db.recordConfigChangeBy({ workspaceId: ws.id, at: Date.now(), source, after: checked.config }, (before, waiting) => {
    const keys = changedKeys(before, checked.config);
    if (!keys.length && !waiting) return null;
    // no difference from what is in force = the pending change is taken back (recorded as a confirmed change of nothing)
    return { keys, state: !keys.length || appliesAtOnce(source, keys) ? "confirmed" : "pending" };
  });
  if (c) {
    writeConfigFiles(sc.cfg.home, sc.db);
    // the keys only: the values are in the record
    sc.logOp(req, srv, "workspace.config", { detail: { path: ws.path, change: c.id, state: c.state, source, keys: c.keys } });
    sc.broadcast({ type: "workspaces.updated" });
  }
  return configView(sc, sc.db.getWorkspace(ws.id)!);
};

const SOURCE_LABEL: Record<string, string> = { person: "画面（パスキーで確かめた操作）", screen: "画面と同じ形の呼び出し（本人かは確かめられない）", call: "API の直接の呼び出し（Task やスクリプト）" };

/**
 * The lines of one change for the person: per key, what is in force and what was asked — each value whole. What is
 * confirmed is what is shown: a value cut short would make two changes that differ only further on the same question
 * (the text's length is bounded where it is saved, and the screen scrolls it).
 */
export function changeLines(c: Pick<WorkspaceConfigChange, "before" | "after" | "keys">): string[] {
  const read = (t: string | null) => (t ? (JSON.parse(t) as Record<string, unknown>) : {});
  const a = read(c.before);
  const b = read(c.after);
  const show = (v: unknown) => (v === undefined ? "（なし）" : JSON.stringify(v));
  return c.keys.map((k) => `${k}: ${show(a[k])} → ${show(b[k])}`);
}

/**
 * The pending changes as questions (and those answered within the day, resolved): one per workspace, answered by
 * `confirm` — ok puts the change in force, not ok (with the reason) rejects it. Built from the records each time.
 */
export const configAsks = (sc: Pick<ServerContext, "db">, now: number): Ask[] => {
  // a change put in force as it was saved (decided at the moment it was asked) was never a question
  const ask = (c: WorkspaceConfigChange): Ask[] => {
    const w = sc.db.getWorkspace(c.workspaceId);
    if (!w) return [];
    const open = c.state === "pending";
    const gating = gatingKeys(c.keys);
    return [{
      ...unanswered,
      id: configAskId(c),
      kind: "notice",
      needs: "person",
      state: open ? "open" : "resolved",
      at: c.at,
      changedAt: c.decidedAt ?? c.at,
      workspace: { id: w.id, name: w.name },
      pbi: null,
      issue: null,
      task: null,
      reason: [`出どころ: ${SOURCE_LABEL[c.source] ?? c.source}`, ...(gating.length ? [`ローカル CI・マージ判定が読むキー: ${gating.join(", ")}`] : []), ...changeLines(c), ...(c.state === "rejected" ? [`反映しなかった${c.note ? `: ${c.note}` : ""}`] : c.state === "confirmed" ? ["反映した"] : [])].join("\n"),
      question: `workspace ${w.name} の設定（Switchboard の側）の変更を反映してよいですか`,
      choices: [],
      recommendation: null,
      next: open ? "確認すると、この設定がローカル CI・マージ判定・Task に使われます。それまでは前に確かめた設定のままで、この workspace の PR のマージ判定は [聞く] で止まります。CI の手順はこのホストの利用者の権限でシェルとして走るので、中身を読んでから確認してください。違うなら理由を書いて断る" : null,
      source: { label: "Workspace の設定", url: null, taskId: null },
      route: "none",
      conditions: [],
      answers: open ? ["confirm"] : [],
    }];
  };
  return [...sc.db.pendingConfigChanges(), ...sc.db.decidedConfigChangesSince(now - ASK_HISTORY_MS).filter((c) => c.decidedAt !== c.at)].flatMap(ask);
};

/**
 * The person's answer to a pending change (POST /api/asks/answer with the question's id). The caller has passed
 * `humanCheck`; `by` says how the answer came in. 409 = the change is not the one asked about any more (answered, replaced,
 * or the settings moved under it): nothing is written.
 */
export const answerConfigChange = (sc: Pick<ServerContext, "db" | "cfg" | "broadcast">, id: string, ok: boolean, reason: string | undefined, by: ConfigSource): { status: number; body: object } => {
  const m = /^config:(.+):(\d+)$/.exec(id);
  const c = m ? sc.db.getConfigChange(Number(m[2])) : null;
  if (!m || !c || c.workspaceId !== m[1]) return { status: 409, body: { error: "問いがもうありません", changes: ["問いがもうありません"], current: null } };
  const gone = (why: string) => ({ status: 409, body: { error: why, changes: [why], current: null } });
  if (c.state !== "pending") {
    // a resend of the same answer gets the question as it is now; anything else is told it changed
    const same = (c.state === "confirmed") === ok && c.state !== "superseded";
    const now = configAsks(sc, Date.now()).find((a) => a.id === id) ?? null;
    return same ? { status: 200, body: { ask: now, already: true, changes: [] } satisfies AskAnswerResult } : gone("この変更はもう答えられています（新しい変更に置き換わったか、別の答えが付いた）");
  }
  if (!ok && !reason?.trim()) return { status: 400, body: { error: "違うときは理由を書いてください" } };
  const decided = sc.db.decideConfigChange(c.id, ok ? "confirmed" : "rejected", by, Date.now(), ok ? null : reason!.trim());
  if (!decided) return gone("設定がこの変更の前提から変わりました。変更を保存し直してください");
  writeConfigFiles(sc.cfg.home, sc.db);
  sc.broadcast({ type: "workspaces.updated" });
  return { status: 200, body: { ask: configAsks(sc, Date.now()).find((a) => a.id === id) ?? null, already: false, changes: [] } satisfies AskAnswerResult };
};
