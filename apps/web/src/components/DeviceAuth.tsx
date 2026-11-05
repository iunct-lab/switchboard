import { useEffect, useState } from "react";
import type { DeviceAuthView } from "@switchboard/protocol";
import { copyText } from "../clipboard.ts";
import { hostOf, remaining, visible } from "../deviceAuth.ts";
import { t } from "../i18n.ts";
import { task as m } from "../i18n/task.ts";

/**
 * A Task waiting for an approval elsewhere (#662): the URL and one-time code a command printed, handed over by the
 * kit's `device-auth`. The person approves in their own browser; the card goes when the command ends or the code
 * expires. The URL came from the agent's command, so the host and the command are shown to judge it by. Nothing kept.
 */
export function DeviceAuth(props: { auth: DeviceAuthView | null | undefined; onError: (m: string) => void }) {
  const [now, setNow] = useState(() => Date.now());
  const shown = visible(props.auth, now);
  useEffect(() => {
    if (!shown) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [shown]);
  // a new wait (or the same one again) is judged against the clock now, not the one of the last tick
  useEffect(() => setNow(Date.now()), [props.auth]);
  const auth = props.auth;
  if (!auth || !visible(auth, now)) return null;
  return (
    <div className="perm device-auth" role="alertdialog">
      <div>
        <b>{t(m.approveAt, { host: hostOf(auth.url) })}</b>
        <span className="hint">{t(m.timeLeft, { left: remaining(auth.expiresAt, now) })}</span>
        <div className="runner-login">
          <a className="button pri" href={auth.url} target="_blank" rel="noopener noreferrer">
            {t(m.openApproval)}
          </a>
          {auth.code && (
            <span>
              {t(m.deviceCode)}<code className="device-code">{auth.code}</code>{" "}
              <button className="ghost" onClick={() => copyText(auth.code!).catch((e) => props.onError(e.message))}>
                {t(m.copy)}
              </button>
            </span>
          )}
        </div>
        <div className="hint">
          {t(m.commandBefore)}<code>{auth.command}</code>{t(m.commandAfter)}
        </div>
      </div>
    </div>
  );
}
