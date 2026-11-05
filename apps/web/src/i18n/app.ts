import { msgs } from "../i18n.ts";

/** The header (`App.tsx`'s `<header className="chrome">`): its words are English in both languages (ui-language.md, Rule). */
export const app = msgs({
  home: { ja: "Home", en: "Home" },
  task: { ja: "Task", en: "Task" },
  knowledge: { ja: "Knowledge", en: "Knowledge" },
  ledger: { ja: "Ledger", en: "Ledger" },
  insights: { ja: "Insights", en: "Insights" },
  backlog: { ja: "Backlog", en: "Backlog" },
  resources: { ja: "Resources", en: "Resources" },
  schedules: { ja: "Schedules", en: "Schedules" },
  settings: { ja: "Settings", en: "Settings" },
  connected: { ja: "daemon connected", en: "daemon connected" },
  offline: { ja: "daemon offline", en: "daemon offline" },
  rescue: { ja: "Rescue", en: "Rescue" },
});
