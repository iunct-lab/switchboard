import { Preset as PresetSchema, type Preset, type PresetExpansion, type PresetInput } from "@switchboard/protocol";
import { findSecrets, hostAws } from "../../../ops-kit/src/secrets.ts";
import type { Db } from "./db.ts";

/**
 * Saved instructions (#940, docs/design/presets.md): a name and a request text kept in the `settings` table (key
 * `presets`, a JSON array — one user, a small list). The text names the skill / Knowledge that holds the steps; the
 * Issue / PR chosen when sending goes where `{{target}}` is. Expanding only builds the text: the Task is created or the
 * reply sent by the usual routes, so the approval mode and rules are the request box's, never the preset's.
 */
export const PRESET_TARGET = "{{target}}";
const KEY = "presets";

export const needsTarget = (p: Pick<Preset, "text">) => p.text.includes(PRESET_TARGET);

const NAME = "[A-Za-z0-9_.-]+";
const SHORT = /^#?(\d+)$/;
const FULL = new RegExp(`^(${NAME}/${NAME})#(\\d+)$`);
const URL_REF = new RegExp(`^https://github\\.com/(${NAME}/${NAME})/(?:issues|pull)/(\\d+)/?$`);

/** `12`, `#12`, `owner/name#12` or the Issue / PR URL; `repo` = null when the text does not name one. Anything else = null. */
export function parseTarget(raw: string): { repo: string | null; number: number } | null {
  const t = raw.trim();
  const m = SHORT.exec(t);
  const full = m ? null : (FULL.exec(t) ?? URL_REF.exec(t));
  const n = Number(m ? m[1] : full?.[2]);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return { repo: full ? full[1]! : null, number: n };
}

export function readPresets(db: Db): Preset[] {
  const raw = db.getSetting<unknown>(KEY, []);
  if (!Array.isArray(raw)) {
    console.warn("[presets] the saved presets are not a list: read as none");
    return [];
  }
  return raw.flatMap((p) => {
    const r = PresetSchema.safeParse(p);
    if (!r.success) console.warn("[presets] dropped a saved preset that does not parse");
    return r.success ? [r.data] : [];
  });
}

export function writePresets(db: Db, list: Preset[]) {
  db.setSetting(KEY, list);
}

/** Why `input` cannot be saved beside `others` (the presets other than the one edited), with the HTTP status; or null. */
export function checkPreset(input: PresetInput, others: Preset[]): { error: string; status: 400 | 409 } | null {
  const hit = findSecrets(`${input.name}\n${input.text}`, hostAws())[0];
  if (hit) return { error: `認証に使える値（${hit.kind}）が入っています。外してから保存してください`, status: 400 };
  return others.some((p) => p.name === input.name) ? { error: `同じ名前の指示があります: ${input.name}`, status: 409 } : null;
}

/** The text to send: every `{{target}}` becomes `repo#n`; the title is the name, with the target when one is used. */
export function expandPreset(p: Preset, repo: string | null, target: number | null): PresetExpansion {
  const ref = repo && target !== null ? `${repo}#${target}` : null;
  return { title: ref ? `${p.name} ${ref}` : p.name, text: ref ? p.text.replaceAll(PRESET_TARGET, ref) : p.text, repo, target: ref };
}
