import type { Msg } from "./i18n.ts";
import { settings } from "./i18n/settings.ts";

/**
 * Settings のまとまり: each card of the Settings screen belongs to exactly one group, named by its heading (the card's h5).
 * A group is named after what its cards are about (not after when they apply). Settings.tsx renders the cards in this
 * order, one block per group with the group's title above it; the table of contents reads the same list. Order inside a
 * group is the order on the screen.
 */
export interface SettingsGroup {
  id: string;
  /** The group's title, in both languages (the one place it is written). */
  title: Msg;
  /** The cards' headings in Japanese: compared with Settings.tsx's h5 by settingsGroups.test.ts, not shown. */
  sections: string[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  { id: "settings-login", title: settings.groupLogin, sections: ["ログイン"] },
  { id: "settings-runner", title: settings.groupRunner, sections: ["ランナーごとの既定", "どの仕事をどのランナーで", "ADK のエージェント（カスタムランナー）", "並走（DAK）の既定"] },
  { id: "settings-auto", title: settings.groupAuto, sections: ["Switchboard 自体の開発", "バックログを進める", "使用量と自動再開", "回答の方針", "新しい予定の既定", "定型の指示"] },
  { id: "settings-judge", title: settings.groupJudge, sections: ["判定と自動選択", "LLM 提案", "タスク名の自動付与"] },
  { id: "settings-model", title: settings.groupModel, sections: ["モデルの価格", "予算"] },
  { id: "settings-workspace", title: settings.groupWorkspace, sections: ["Workspace", "GitHub 同期", "Workspace MCP", "Knowledge"] },
  { id: "settings-app", title: settings.groupApp, sections: ["言語", "端末通知", "動いている版", "海外から使う", "外への送信", "Terminal の履歴（Claude Code）"] },
];

/** The group by its id; Settings.tsx names each block by id, so a typo fails at render rather than showing nothing. */
export function settingsGroup(id: string): SettingsGroup {
  const g = SETTINGS_GROUPS.find((x) => x.id === id);
  if (!g) throw new Error(`unknown settings group: ${id}`);
  return g;
}
