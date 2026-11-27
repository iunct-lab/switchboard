import { t } from "../i18n.ts";
import { settings } from "../i18n/settings.ts";

/** 「小さい要望は自動で直行にする」: off = the automatic processing starts no request in the direct candidate, in any repository; the row's button is not affected. */
export function AutoDirectToggle({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (autoDirect: boolean) => void }) {
  return (
    <>
      <label className="hint toggle">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        {t(settings.autoDirectToggle)}
      </label>
      <div className="muted">{t(settings.autoDirectHint)}</div>
    </>
  );
}

/** 「Switchboard 自体の開発」: off = Switchboard's own backlog is not read, no improve / すぐ直す for Switchboard itself (other repositories keep すぐ直す), requests go upstream. */
export function DevelopSelfToggle({ checked, disabled, onChange }: { checked: boolean; disabled: boolean; onChange: (developSelf: boolean) => void }) {
  return (
    <>
      <label className="hint toggle">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        {t(settings.developSelfToggle)}
      </label>
      <div className="muted">{t(settings.developSelfHint)}</div>
    </>
  );
}
