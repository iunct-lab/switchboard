import { t } from "../i18n.ts";
import { settings } from "../i18n/settings.ts";
import { type SettingsResponse } from "../api/settings.ts";

type Release = SettingsResponse["release"];

/** 動いている版: how far a new version goes by itself, and which tags of a development origin it takes by itself (the tag CI's result). Saved on change, like the other tunables of the card. */
export function ReleaseAutoFields(props: { release: Release; defaults: Release; disabled: boolean; onSave: (patch: Partial<Release>) => void }) {
  const { release, defaults } = props;
  const auto = { promote: settings.releaseAutoPromote, review: settings.releaseAutoReview, off: settings.releaseAutoOff };
  const tagCi = { pass: settings.releaseTagCiPass, "no-fail": settings.releaseTagCiNoFail };
  // a choice with its default, not a number with a unit: the text field's two columns (the name, then the select with its
  // default under it; one column on a phone) — the number field's grid has a fixed 88px box and a 2.5em unit column
  return (
    <>
      <label className="text-field" title={t(settings.releaseAutoHint)}>
        <span className="hint">{t(settings.releaseAuto)}</span>
        <select className="mode" value={release.auto} disabled={props.disabled} aria-label={t(settings.releaseAuto)} onChange={(e) => props.onSave({ auto: e.target.value as Release["auto"] })}>
          <option value="promote">{t(auto.promote)}</option>
          <option value="review">{t(auto.review)}</option>
          <option value="off">{t(auto.off)}</option>
        </select>
        <span className="muted">{t(settings.defaultValue, { value: t(auto[defaults.auto]) })}</span>
      </label>
      <div className="muted">{t(settings.releaseAutoHint)}</div>
      <label className="text-field" title={t(settings.releaseTagCiHint)}>
        <span className="hint">{t(settings.releaseTagCi)}</span>
        <select className="mode" value={release.tagCi} disabled={props.disabled} aria-label={t(settings.releaseTagCi)} onChange={(e) => props.onSave({ tagCi: e.target.value as Release["tagCi"] })}>
          <option value="pass">{t(tagCi.pass)}</option>
          <option value="no-fail">{t(tagCi["no-fail"])}</option>
        </select>
        <span className="muted">{t(settings.defaultValue, { value: t(tagCi[defaults.tagCi]) })}</span>
      </label>
      <div className="muted">{t(settings.releaseTagCiHint)}</div>
    </>
  );
}
