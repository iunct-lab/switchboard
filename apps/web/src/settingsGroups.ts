/**
 * Settings の目的別のまとまり (#3356): each card of the Settings screen belongs to exactly one group, named by its heading
 * (the card's h5). Settings.tsx renders the cards in this order, one block per group with the group's title above it; the
 * table of contents reads the same list. Order inside a group is the order on the screen.
 */
export interface SettingsGroup {
  id: string;
  title: string;
  sections: string[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  { id: "settings-task-start", title: "Task の始まり方", sections: ["新規作成の既定", "承認モードの既定", "自動で始まる Task の既定", "定型の指示", "並走（DAK）の既定"] },
  { id: "settings-resume", title: "止まったときと再開", sections: ["使用量と自動再開", "使用上限での自動再開", "回答の方針"] },
  { id: "settings-judge", title: "判定と提案", sections: ["判定と自動選択", "ターン終了時の自動判定", "ルーブリック判定", "LLM 提案", "タスク名の自動付与"] },
  { id: "settings-model", title: "モデルと費用", sections: ["モデルの選択肢", "モデルの価格"] },
  { id: "settings-connect", title: "接続とアプリ", sections: ["Workspace", "端末通知", "動いている版", "バックログを進める", "GitHub 同期", "Terminal の履歴（Claude Code）", "海外から使う", "ログイン"] },
];

/** The group by its id; Settings.tsx names each block by id, so a typo fails at render rather than showing nothing. */
export function settingsGroup(id: string): SettingsGroup {
  const g = SETTINGS_GROUPS.find((x) => x.id === id);
  if (!g) throw new Error(`unknown settings group: ${id}`);
  return g;
}
