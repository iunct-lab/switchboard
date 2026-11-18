import { useEffect, useState } from "react";
import type { RunnerInfo, Settings, TaskSummary } from "@switchboard/protocol";
import { api } from "../api/index.ts";
import { type GithubStatus, type Health } from "../api/daemon.ts";
import { githubRowView, loginRowView, logoutConfirmText, switchboardRowView, type LoginRow } from "../loginRow.ts";
import { logoutPath } from "../login.ts";
import { t } from "../i18n.ts";
import { common as m } from "../i18n/common.ts";
import { settings } from "../i18n/settings.ts";
import { RunnerLogin } from "./RunnerLogin.tsx";

/**
 * The login group of Settings: Switchboard, Claude Code, Codex and GitHub on rows of one shape (who, the state, the one
 * button), and under them the switch to Amazon Bedrock of each runner that can run on it. Not folded: the state is what
 * one comes here to read. Logout asks once (it cuts the login of the Tasks that are running), then asks the daemon.
 * The GitHub state is read when the group mounts and again after a login or logout, not on a timer.
 */
export function LoginSettings(props: { health: Health | null; tasks: TaskSummary[]; bedrock: Settings["bedrock"]; onBedrock: (runner: string, next: { region: string } | null) => void; onChanged: () => Promise<unknown>; onError: (msg: string) => void }) {
  const [gh, setGh] = useState<GithubStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const readGh = () => {
    api.githubStatus().then(setGh).catch(() => setGh(null));
  };
  useEffect(readGh, []);
  const runners = (props.health?.runners ?? []).filter((r) => loginRowView(r) !== null);
  const rows: Array<{ view: LoginRow }> = [
    // until the health is read the configuration is not known: no row rather than a wrong "no login needed"
    ...(props.health ? [{ view: switchboardRowView(props.health.login) }] : []),
    ...runners.map((r) => ({ view: loginRowView(r)! })),
    ...(gh ? [{ view: githubRowView(gh) }] : []),
  ];
  const failed = (e: unknown) => props.onError(t(m.logoutFailed, { error: String((e as Error).message ?? e) }));
  const logout = (row: LoginRow) => {
    if (row.id === "switchboard") {
      const path = logoutPath(props.health?.login);
      if (!path) return;
      setBusy(true);
      fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: "{}" })
        .then((r) => (r.ok ? location.assign("/_auth/") : props.onError(t(settings.logoutFailed, { detail: r.status }))))
        .catch(failed)
        .finally(() => setBusy(false));
      return;
    }
    if (!confirm(logoutConfirmText(row.id, props.tasks))) return;
    setBusy(true);
    (row.id === "gh" ? api.githubLogout().then(readGh) : api.runnerLogout(row.id).then(props.onChanged))
      .catch(failed)
      .finally(() => setBusy(false));
  };
  return (
    <>
      {rows.map(({ view }) => (
        <div key={view.id} className="login-row">
          <b className="login-who">{view.label}</b>
          <span className="hint login-state">{view.text}</span>
          {view.action === "logout" ? (
            <button className="ghost" disabled={busy} onClick={() => logout(view)}>
              {t(m.logout)}
            </button>
          ) : view.action === "login" && view.id !== "switchboard" ? (
            <RunnerLogin runner={view.id} onDone={() => void (view.id === "gh" ? readGh() : props.onChanged())} onError={props.onError} />
          ) : null}
        </div>
      ))}
      {runners.filter((r) => r.bedrockAvailable).map((r) => (
        <BedrockSwitch key={r.id} runner={r} label={loginRowView(r)!.label} busy={busy} region={props.bedrock?.[r.id]?.region} onBedrock={(next) => props.onBedrock(r.id, next)} />
      ))}
    </>
  );
}

/** Amazon Bedrock of one runner: only ever switched on by this button (a lapsed login never turns into it); the saved region stays editable, and the way back is there while it is on. */
function BedrockSwitch(props: { runner: RunnerInfo; label: string; busy: boolean; region?: string; onBedrock: (next: { region: string } | null) => void }) {
  const [region, setRegion] = useState(props.region ?? "");
  const on = props.runner.loginKind === "bedrock";
  const saved = props.region ?? "";
  return (
    <div className="login-bedrock bedrock-switch">
      <b className="login-who">{props.label}</b>
      <input aria-label={t(m.bedrockRegionLabel)} placeholder={t(m.bedrockRegionPlaceholder)} value={region} onChange={(e) => setRegion(e.target.value)} />
      {on ? (
        <>
          <button className="ghost" disabled={props.busy || !region.trim() || region.trim() === saved} onClick={() => props.onBedrock({ region: region.trim() })}>
            {t(m.bedrockSaveRegion)}
          </button>
          <button className="ghost" disabled={props.busy} onClick={() => props.onBedrock(null)}>
            {props.runner.id === "claude" ? t(m.bedrockBackClaude) : t(m.bedrockBackPlan)}
          </button>
        </>
      ) : (
        <button className="ghost" disabled={props.busy || !region.trim()} onClick={() => props.onBedrock({ region: region.trim() })}>
          {t(m.bedrockUse)}
        </button>
      )}
      <span className="hint">{t(m.bedrockHint)}</span>
    </div>
  );
}
