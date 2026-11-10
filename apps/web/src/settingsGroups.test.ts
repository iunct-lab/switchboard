// test-reads: apps/web/src/components/Settings.tsx apps/web/src/components/WorkspaceCard.tsx apps/web/src/components/PolicySettings.tsx
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS_GROUPS, settingsGroup } from "./settingsGroups.ts";
import { settings } from "./i18n/settings.ts";

const source = await Bun.file(new URL("./components/Settings.tsx", import.meta.url)).text();
/** The Settings screen's own body: from its <main> to the end of it. */
const body = source.slice(source.indexOf('<main className="main settings">\n'), source.indexOf("    </main>\n  );\n}\n"));

/** The screen in source order: a group's heading as "group:<id>", a card by its heading (the two cards drawn by their own component by name). */
function screenOrder(): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/<SettingsGroupHeading id="([\w-]+)"|<h5>(.*?)<\/h5>|<SettingsCard title=\{t\(settings\.(\w+)\)\}|<(WorkspaceCard|PolicySettings)\b/g)) {
    if (m[1]) out.push(`group:${m[1]}`);
    else if (m[2]) out.push(m[2].replace(/^\{t\(settings\.(\w+)\)\}$/, (_, k: keyof typeof settings) => settings[k].ja)); // a heading from the dictionary reads as its Japanese
    else if (m[3]) out.push(settings[m[3] as keyof typeof settings].ja); // a folded card (#3849) by its title
    else out.push(m[4] === "WorkspaceCard" ? "Workspace" : "回答の方針");
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

  test("the cards of one topic are one card: automatic resume, judging", () => {
    // #3849: the runners' auto-resume toggles sit in 使用量と自動再開; the turn-end judge and the rubric judge in 判定と自動選択
    const order = screenOrder();
    for (const gone of ["使用上限での自動再開", "ターン終了時の自動判定", "ルーブリック判定"]) expect(order).not.toContain(gone);
    /** The source of the card with this title: from its opening tag to its closing tag. */
    const card = (key: keyof typeof settings) => {
      const from = body.indexOf(`<SettingsCard title={t(settings.${key})}`);
      expect(from).toBeGreaterThan(-1);
      return body.slice(from, body.indexOf("</SettingsCard>", from));
    };
    expect(card("usage")).toContain("save({ autoResume:");
    expect(card("usage")).toContain("save({ quotaAndResume:");
    for (const saved of ["save({ judge:", "save({ evals:", "save({ judgeAndChoice:"]) expect(card("judgeAndChoice")).toContain(saved);
  });

  test("every card but the approval mode default is folded", () => {
    // #3849: a card is a <SettingsCard> (a <details>); only 承認モードの既定 stays an open <section> (a safety setting)
    const open = [...body.matchAll(/<section className="card[^"]*">\s*<h5>(.*?)<\/h5>/g)].map((m) => m[1]);
    expect(open).toEqual(["{t(settings.approvalDefaults)}"]);
    expect(body.match(/<section\b/g)).toHaveLength(1);
    // the cards drawn by their own component fold the same way, and so does the ADK card drawn below the screen's body
    for (const f of ["WorkspaceCard", "PolicySettings"]) {
      const own = readFileSync(new URL(`./components/${f}.tsx`, import.meta.url), "utf8");
      expect(own).toMatch(/<details className="card[^"]*"[^>]*>\s*<summary>\s*<h5>/);
      expect(own).not.toMatch(/<section className="card/);
    }
    expect(source).toContain("<SettingsCard title={t(settings.adk)}>");
    const folded = [...body.matchAll(/<SettingsCard title=/g)].length + 2; // + Workspace, 回答の方針
    expect(folded).toBe(SETTINGS_GROUPS.flatMap((g) => g.sections).length - 1);
  });

  test("the values that can be set are the same as before the reordering", () => {
    // the top-level keys of every save({ … }) in Settings.tsx on main before #3356, and hiddenModels (載せない, #1401)
    const keys = new Set([...source.matchAll(/save\(\{ ?(\w+):/g)].map((m) => m[1]));
    expect([...keys].sort()).toEqual(["autoResume", "autoStart", "bedrock", "defaultPermissionMode", "evals", "hiddenModels", "judge", "judgeAndChoice", "models", "newDefaults", "outbound", "prices", "quotaAndResume", "reviewRunner", "routing", "shadowRunner", "subagentEffort", "titles"]);
  });

  test("レビューのランナー is a card of Task の始まり方 and saves reviewRunner with its two choices (#4025)", () => {
    expect(settingsGroup("settings-task-start").sections).toContain("レビューのランナー");
    const from = body.indexOf("<SettingsCard title={t(settings.reviewRunner)}>");
    expect(from).toBeGreaterThan(-1);
    const card = body.slice(from, body.indexOf("</SettingsCard>", from));
    expect(source).toContain("{ other: settings.reviewRunnerOther, same: settings.reviewRunnerSame }");
    expect(card).toContain("save({ reviewRunner: value })");
    expect(settings.reviewRunnerHint.ja).toContain("次の開始・再開から効く");
  });

  test("an unknown group id throws", () => {
    expect(settingsGroup("settings-resume").title.ja).toBe("止まったときと再開");
    expect(() => settingsGroup("settings-nope")).toThrow();
  });
});
