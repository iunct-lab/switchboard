import { useState } from "react";
import type { RunnerInfo } from "@switchboard/protocol";
import { api } from "../api.ts";
import { loginRowView } from "../loginRow.ts";
import { t } from "../i18n.ts";
import { common as m } from "../i18n/common.ts";
import { RunnerLogin } from "./RunnerLogin.tsx";

/**
 * The claude login on its row (#2528): the kind in use and the logout button; once logged out, the two login buttons.
 * Any runner that can run on Amazon Bedrock (claude #1730, codex #1731) gets the switch to it and back.
 */
export function ClaudeLoginRow(props: { runner: RunnerInfo; region?: string; onBedrock?: (next: { region: string } | null) => void; onChanged: () => Promise<unknown>; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [region, setRegion] = useState(props.region ?? "");
  const v = loginRowView(props.runner);
  // Amazon Bedrock (#1730) is only ever switched on by this button: a lapsed Claude login never turns into it. It is
  // offered also while the login status is unknown (no row of the login then), and the saved region stays editable.
  const onBedrock = props.runner.bedrockAvailable ? props.onBedrock : undefined;
  if (!v && !onBedrock) return null;
  const saved = props.region ?? "";
  const bedrockControl = onBedrock ? (
    <span className="bedrock-switch">
      <input aria-label={t(m.bedrockRegionLabel)} placeholder={t(m.bedrockRegionPlaceholder)} value={region} onChange={(e) => setRegion(e.target.value)} />
      {v?.bedrock ? (
        <>
          <button className="ghost" disabled={busy || !region.trim() || region.trim() === saved} onClick={() => onBedrock({ region: region.trim() })}>
            {t(m.bedrockSaveRegion)}
          </button>
          <button className="ghost" disabled={busy} onClick={() => onBedrock(null)}>
            {props.runner.id === "claude" ? t(m.bedrockBackClaude) : t(m.bedrockBackPlan)}
          </button>
        </>
      ) : (
        <button className="ghost" disabled={busy || !region.trim()} onClick={() => onBedrock({ region: region.trim() })}>
          {t(m.bedrockUse)}
        </button>
      )}
      <span className="hint">{t(m.bedrockHint)}</span>
    </span>
  ) : null;
  const logout = () => {
    setBusy(true);
    api.runnerLogout("claude").then(props.onChanged).catch((e) => props.onError(t(m.logoutFailed, { error: String(e.message ?? e) }))).finally(() => setBusy(false));
  };
  return (
    <span className="runner-login">
      {v && <span className="hint">{v.text}</span>}
      {!v || v.bedrock ? null : v.logout ? (
        <button className="ghost" disabled={busy} onClick={logout}>
          {t(m.logout)}
        </button>
      ) : (
        <RunnerLogin runner="claude" onDone={() => void props.onChanged()} onError={props.onError} />
      )}
      {bedrockControl}
    </span>
  );
}
