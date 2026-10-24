import { useEffect, useState } from "react";
import { RECENT_MESSAGE, confirmPasskey, onRecentCheck } from "../recent.ts";

/** The question behind a 401 `recent` (#1491): the button is the click Safari needs to open the passkey sheet. */
export function RecentCheck() {
  const [ask, setAsk] = useState<{ resolve: (ok: boolean) => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => onRecentCheck((resolve) => { setError(null); setAsk({ resolve }); }), []);
  if (!ask) return null;
  const finish = (ok: boolean) => { ask.resolve(ok); setAsk(null); };
  const check = async () => {
    setBusy(true);
    try { await confirmPasskey(); finish(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="recent-check" role="alertdialog" aria-label={RECENT_MESSAGE}>
      <div className="recent-check-box">
        <p>{RECENT_MESSAGE}</p>
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy} onClick={check}>パスキーで確かめる</button>{" "}
        <button className="btn" disabled={busy} onClick={() => finish(false)}>やめる</button>
      </div>
    </div>
  );
}
