import { useState } from "react";
import type { RunnerInfo } from "@switchboard/protocol";
import { api } from "../api.ts";
import { loginRowView } from "../loginRow.ts";
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
      <input aria-label="Amazon Bedrock のリージョン" placeholder="リージョン（例 ap-northeast-1）" value={region} onChange={(e) => setRegion(e.target.value)} />
      {v?.bedrock ? (
        <>
          <button className="ghost" disabled={busy || !region.trim() || region.trim() === saved} onClick={() => onBedrock({ region: region.trim() })}>
            リージョンを保存
          </button>
          <button className="ghost" disabled={busy} onClick={() => onBedrock(null)}>
            {props.runner.id === "claude" ? "Claude アカウントに戻す" : "定額の契約に戻す"}
          </button>
        </>
      ) : (
        <button className="ghost" disabled={busy || !region.trim()} onClick={() => onBedrock({ region: region.trim() })}>
          Amazon Bedrock を使う
        </button>
      )}
      <span className="hint">Bedrock では AWS の資格情報（ホストのロールなど）で動き、Switchboard は鍵を持ちません。モデルの選択肢は Bedrock の id になり、これから始まる Task に効きます。利用は AWS に課金されます。</span>
    </span>
  ) : null;
  const logout = () => {
    setBusy(true);
    api.runnerLogout("claude").then(props.onChanged).catch((e) => props.onError(`ログアウトできません: ${String(e.message ?? e)}`)).finally(() => setBusy(false));
  };
  return (
    <span className="runner-login">
      {v && <span className="hint">{v.text}</span>}
      {!v || v.bedrock ? null : v.logout ? (
        <button className="ghost" disabled={busy} onClick={logout}>
          ログアウト
        </button>
      ) : (
        <RunnerLogin runner="claude" onDone={() => void props.onChanged()} onError={props.onError} />
      )}
      {bedrockControl}
    </span>
  );
}
