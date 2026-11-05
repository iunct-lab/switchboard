// test-reads: apps/web/src/components/Settings.tsx
import { describe, expect, test } from "bun:test";
import { SETTINGS_GROUPS, settingsGroup } from "./settingsGroups.ts";

const source = await Bun.file(new URL("./components/Settings.tsx", import.meta.url)).text();
/** The Settings screen's own body: from its <main> to the end of it. */
const body = source.slice(source.indexOf('<main className="main settings">\n'), source.indexOf("    </main>\n  );\n}\n"));

/** The screen in source order: a group's heading as "group:<id>", a card by its heading (the two cards drawn by their own component by name). */
function screenOrder(): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/<SettingsGroupHeading id="([\w-]+)"|<h5>(.*?)<\/h5>|<(WorkspaceCard|PolicySettings)\b/g)) {
    if (m[1]) out.push(`group:${m[1]}`);
    else if (m[2]) out.push(m[2]);
    else out.push(m[3] === "WorkspaceCard" ? "Workspace" : "回答の方針");
  }
  return out;
}

describe("SETTINGS_GROUPS", () => {
  test("every card is in exactly one group, and Settings.tsx draws them group by group in that order", () => {
    const all = SETTINGS_GROUPS.flatMap((g) => g.sections);
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(SETTINGS_GROUPS.map((g) => g.id)).size).toBe(SETTINGS_GROUPS.length);
    expect(screenOrder()).toEqual(SETTINGS_GROUPS.flatMap((g) => [`group:${g.id}`, ...g.sections]));
  });

  test("the cards of one topic are in one group: automatic resume, judging", () => {
    const groupOf = (name: string) => SETTINGS_GROUPS.find((g) => g.sections.includes(name))?.id;
    expect(new Set(["使用量と自動再開", "使用上限での自動再開"].map(groupOf))).toEqual(new Set(["settings-resume"]));
    expect(new Set(["判定と自動選択", "ターン終了時の自動判定", "ルーブリック判定"].map(groupOf))).toEqual(new Set(["settings-judge"]));
  });

  test("the values that can be set are the same as before the reordering", () => {
    // the top-level keys of every save({ … }) in Settings.tsx on main before #3356, and hiddenModels (載せない, #1401)
    const keys = new Set([...source.matchAll(/save\(\{ ?(\w+):/g)].map((m) => m[1]));
    expect([...keys].sort()).toEqual(["autoResume", "autoStart", "bedrock", "defaultPermissionMode", "evals", "hiddenModels", "judge", "judgeAndChoice", "models", "newDefaults", "prices", "quotaAndResume", "routing", "shadowRunner", "titles"]);
  });

  test("an unknown group id throws", () => {
    expect(settingsGroup("settings-resume").title).toBe("止まったときと再開");
    expect(() => settingsGroup("settings-nope")).toThrow();
  });
});
