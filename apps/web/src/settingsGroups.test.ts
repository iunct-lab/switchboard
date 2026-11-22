// test-reads: apps/web/src/components/Settings.tsx apps/web/src/components/WorkspaceCard.tsx apps/web/src/components/PolicySettings.tsx apps/web/src/components/CliUpdateSettings.tsx apps/web/src/App.tsx
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS_GROUPS, settingsGroup } from "./settingsGroups.ts";
import { settings } from "./i18n/settings.ts";

const source = await Bun.file(new URL("./components/Settings.tsx", import.meta.url)).text();
/** The Settings screen's own body: from its <main> to the end of it. */
const body = source.slice(source.indexOf('<main className="main settings">\n'), source.indexOf("    </main>\n  );\n}\n"));

/** The source of one group: from its heading to the next group's (the cards drawn between them). */
function groupBody(id: string): string {
  const from = body.indexOf(`<SettingsGroupHeading id="${id}" />`);
  expect(from).toBeGreaterThan(-1);
  const next = body.indexOf("<SettingsGroupHeading", from + 1);
  return body.slice(from, next === -1 ? undefined : next);
}

/** The screen in source order: a group's heading as "group:<id>", a card by its heading (the cards drawn by their own component by name). */
function screenOrder(): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/<SettingsGroupHeading id="([\w-]+)"|<h5>(.*?)<\/h5>|<SettingsCard title=\{t\(settings\.(\w+)\)\}|<(McpCard|WorkspaceCard|PolicySettings|CliUpdateSettings|CustomRunnersSection)\b/g)) {
    if (m[1]) out.push(`group:${m[1]}`);
    else if (m[2]) out.push(m[2].replace(/^\{t\(settings\.(\w+)\)\}$/, (_, k: keyof typeof settings) => settings[k].ja)); // a heading from the dictionary reads as its Japanese
    else if (m[3]) out.push(settings[m[3] as keyof typeof settings].ja); // a folded card by its title
    else out.push(m[4] === "McpCard" ? "Workspace MCP" : m[4] === "WorkspaceCard" ? "Workspace" : m[4] === "CustomRunnersSection" ? settings.adk.ja : m[4] === "CliUpdateSettings" ? settings.cliUpdate.ja : "回答の方針");
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

  test("the seven groups, named after what their cards are about, in the order of the table of contents", () => {
    expect(SETTINGS_GROUPS.map((g) => g.title.ja)).toEqual(["ログイン", "ランナー", "自動で進める", "判定と提案", "モデルと費用", "Workspace と GitHub", "このアプリ"]);
    expect(settingsGroup("settings-auto").sections).toEqual(["Switchboard 自体の開発", "バックログを進める", "使用量と自動再開", "回答の方針", "新しい予定の既定", "定型の指示"]);
    expect(settingsGroup("settings-workspace").sections).toEqual(["Workspace", "GitHub 同期", "Workspace MCP", "Knowledge"]);
    expect(settingsGroup("settings-app").sections).toEqual(["言語", "端末通知", "動いている版", "海外から使う", "外への送信", "Terminal の履歴（Claude Code）"]);
    // the table of contents draws the same list
    expect(source).toContain("{SETTINGS_GROUPS.map((g) => (\n        <a\n          key={g.id}\n          href={`#${g.id}`}");
  });

  test("the links from other screens point at an id a card of the screen carries", () => {
    const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
    const ids = [...app.matchAll(/openSettingsAt\("([\w-]+)"\)/g)].map((m) => m[1]!);
    expect(ids.sort()).toEqual(["release", "workspace"]);
    const drawn = source + readFileSync(new URL("./components/WorkspaceCard.tsx", import.meta.url), "utf8");
    for (const id of ids) expect(drawn).toMatch(new RegExp(`<(details|SettingsCard)[^>]* id="${id}"`));
    // a folded card is opened before it is shown
    expect(source).toContain('const folded = el?.closest("details");\n    if (folded) folded.open = true;');
  });

  test("the cards of one topic are one card: automatic resume, judging", () => {
    // the runners' auto-resume toggles sit in 使用量と自動再開; the turn-end judge and the rubric judge in 判定と自動選択
    const order = screenOrder();
    for (const gone of ["使用上限での自動再開", "ターン終了時の自動判定", "ルーブリック判定"]) expect(order).not.toContain(gone);
    /** The source of the card with this title: from its opening tag to its closing tag. */
    const card = (key: keyof typeof settings) => {
      const from = body.indexOf(`<SettingsCard title={t(settings.${key})}`);
      expect(from).toBeGreaterThan(-1);
      return body.slice(from, body.indexOf("</SettingsCard>", from));
    };
    expect(card("usage")).not.toContain("autoResume:"); // the per-runner toggle is a row of the runner's block (「ランナーごとの既定」)
    expect(card("usage")).toContain("save({ quotaAndResume:");
    // the flow limit: a field of this card (the ceiling, not Home or the Backlog), with what it limits and which PBIs it counts and holds under it
    expect(card("usage")).toContain("save({ quotaAndResume: { flowLimit: v } })");
    expect(card("usage")).toContain("settings.flowLimitHint");
    expect(card("usage")).toContain("<FlowLimitState limit={qr.flowLimit}");
    // the Fable budget is a cost: it is in モデルと費用's 予算 card, saved under the key it always had
    expect(card("usage")).not.toContain("fableBudgetUsd");
    expect(groupBody("settings-model")).toContain("save({ quotaAndResume: { fableBudgetUsd: v } })");
    expect(card("budgetCard")).toContain("<BudgetField ");
    // the cron of a new schedule has its own card; the hand-started Task's runner is a row of the jobs card
    expect(card("newSchedule")).toContain("save({ newDefaults: { scheduleCron: v } })");
    for (const saved of ["save({ judge:", "save({ evals:", "save({ judgeAndChoice:"]) expect(card("judgeAndChoice")).toContain(saved);
  });

  test("every card but the login group and ランナーごとの既定 is folded; each runner's summary reads its approval mode", () => {
    // a card is a <SettingsCard> (a <details>); only ランナーごとの既定 stays an open <section> (it holds the approval mode, a safety setting)
    const open = [...body.matchAll(/<section className="card[^"]*">\s*<h5>(.*?)<\/h5>/g)].map((m) => m[1]);
    expect(open).toEqual(["{t(settings.login)}", "{t(settings.runnerDefaults)}"]);
    expect(body.match(/<section\b/g)).toHaveLength(2);
    // the block of one runner folds, and its <summary> carries the current approval mode so a folded block still reads it
    const block = body.slice(body.indexOf('<details key={r.id} className="runner-block"'));
    expect(block.slice(0, block.indexOf("</summary>"))).toContain("settings.runnerApprovalNow");
    expect(settings.runnerApprovalNow.ja).toContain("承認モード");
    // a mode that skips confirmations is still not offered as a default
    expect(block).toContain("r.permissionModes.filter((m) => !m.danger || m.value === r.defaultPermissionMode)");
    // the cards drawn by their own component fold the same way, and so does the ADK card drawn below the screen's body
    for (const f of ["WorkspaceCard", "PolicySettings"]) {
      const own = readFileSync(new URL(`./components/${f}.tsx`, import.meta.url), "utf8");
      expect(own).toMatch(/<details className="card[^"]*"[^>]*>\s*<summary>\s*<h5>/);
      expect(own).not.toMatch(/<section className="card/);
    }
    expect(source).toContain("<SettingsCard title={t(settings.adk)}>");
    expect(source).toContain('<SettingsCard title="Workspace MCP">');
    // every card the screen draws is one of the list's (the first test compares the whole order), so nothing is counted apart from it
    expect(screenOrder().filter((x) => !x.startsWith("group:")).sort()).toEqual(SETTINGS_GROUPS.flatMap((g) => g.sections).sort());
  });

  test("the logins are only in the login group: none of their parts is drawn by another card", () => {
    expect(SETTINGS_GROUPS[0]?.id).toBe("settings-login");
    expect(body).toContain("<LoginSettings ");
    const workspace = readFileSync(new URL("./components/WorkspaceCard.tsx", import.meta.url), "utf8");
    for (const part of ["RunnerLogin", "ClaudeLoginRow", "GithubLoginRow", "logoutPath("]) {
      expect(body).not.toContain(part);
      expect(workspace).not.toContain(part);
    }
  });

  test("the values that can be set are the same as before the reordering", () => {
    // the top-level keys of every save({ … }) in Settings.tsx: the regrouping into seven groups moved cards and changed none of them
    // (maxRunners was saved by its own component before and is a box of バックログを進める now)
    const keys = new Set([...source.matchAll(/save\(\{ ?(\w+):/g)].map((m) => m[1]));
    expect([...keys].sort()).toEqual(["autoResume", "autoStart", "bedrock", "cliUpdate", "defaultEffort", "defaultModel", "defaultPermissionMode", "developSelf", "evals", "hiddenModels", "judge", "judgeAndChoice", "maxRunners", "models", "newDefaults", "outbound", "prices", "quotaAndResume", "release", "reviewRunner", "routing", "shadowRunner", "subagentEffort", "subagentModel", "titles"]);
  });

  test("レビュー is a row of どの仕事をどのランナーで and saves reviewRunner with its two choices", () => {
    expect(settingsGroup("settings-runner").sections).toContain("どの仕事をどのランナーで");
    const from = body.indexOf("<SettingsCard title={t(settings.jobsCard)}");
    expect(from).toBeGreaterThan(-1);
    const card = body.slice(from, body.indexOf("</SettingsCard>", from));
    expect(source).toContain("{ other: settings.reviewRunnerOther, same: settings.reviewRunnerSame }");
    expect(card).toContain("save({ reviewRunner: e.target.value as ReviewRunnerChoice })");
    expect(settings.jobsHint.ja).toContain("次の開始・再開から効きます");
  });

  test("the runner, model and thinking effort are chosen only in the ランナー group", () => {
    expect(SETTINGS_GROUPS[1]?.id).toBe("settings-runner");
    for (const g of SETTINGS_GROUPS.filter((x) => x.id !== "settings-runner")) {
      const src = groupBody(g.id);
      for (const part of ["runnerOptions(", "<ModelSelect", "<EffortSelect"]) expect({ group: g.id, part, found: src.includes(part) }).toEqual({ group: g.id, part, found: false });
    }
    const runner = groupBody("settings-runner");
    for (const part of ["runnerOptions(", "<ModelSelect", "<EffortSelect"]) expect(runner).toContain(part);
    // the runner group holds every section it names, and the cards that moved are not in the groups they left
    expect(settingsGroup("settings-runner").sections).toEqual(["ランナーごとの既定", "どの仕事をどのランナーで", "ADK のエージェント（カスタムランナー）", "並走（DAK）の既定", "CLI の更新"]);
    expect(settingsGroup("settings-model").sections).toEqual(["モデルの価格", "予算"]);
  });

  test("each runner block draws runnerRows' rows, the models row by modelsRowView, and saves each row's own value (an empty choice saved as null)", () => {
    const from = body.indexOf('<details key={r.id} className="runner-block"');
    const block = body.slice(from, body.indexOf("</details>\n          );", from));
    expect(block).toContain("{runnerRows(r).map((row) =>");
    // a row the runner cannot change says so instead of being dropped; the models row is folded only when it has something to show
    expect(block).toContain('{!row.editable ? (\n                        <span className="muted">{t(settings.notChangeable)}</span>');
    expect(block).toContain('row.key === "models" && modelsRowView(r).folded ?');
    expect(block).toContain("{modelsRowView(r).list ? <ModelChoices ");
    expect(block).toContain("{modelsRowView(r).candidates && <CliModelCandidates runners={[r]} ");
    for (const saved of [
      "save({ defaultModel: { [r.id]: m || null } })",
      "save({ defaultEffort: { [r.id]: e || null } })",
      "save({ defaultPermissionMode: { [r.id]: e.target.value } })",
      "save({ subagentModel: { [r.id]: m || null } })",
      "save({ subagentEffort: { [r.id]: e || null } })",
      "save({ autoResume: { [r.id]: e.target.checked } })",
      "save(resetPatch({ runner: r.id }))",
    ]) expect(block).toContain(saved);
    // the selects of a row are bare (the row's name says what it is)
    const selects = [...block.matchAll(/<(ModelSelect|EffortSelect) [\s\S]*?\/>/g)].map((m) => m[0]);
    expect(selects).toHaveLength(4); // model, effort, the subagent's model and effort
    for (const sel of selects) expect(sel).toContain(" bare ");
  });

  test("the model / effort selects of the job rows and of the kinds name their empty choice after the runner's default", () => {
    const from = body.indexOf("<SettingsCard title={t(settings.jobsCard)}");
    const card = body.slice(from, body.indexOf("</SettingsCard>", from));
    const kindRow = source.slice(source.indexOf("function KindRow("), source.indexOf("\n}\n", source.indexOf("function KindRow(")));
    for (const src of [card, kindRow]) {
      const selects = [...src.matchAll(/<(ModelSelect|EffortSelect) [\s\S]*?\/>/g)].map((m) => m[0]);
      expect(selects).toHaveLength(2);
      for (const sel of selects) expect(sel).toMatch(/emptyLabel=\{runnerDefaultLabel\("(model|effort)", /);
    }
    // a kind's row shows what the kind starts on (kindChoice), not its stored empty model / effort
    expect(kindRow).toContain("const c = kindChoice(own, props.auto);")
    // a model or effort change keeps the other shown value (kindPick)
    expect(kindRow).toContain("pick(kindPick(own, c, { model }, props.info(cRunner)))");
    expect(kindRow).toContain("pick(kindPick(own, c, { effort }, props.info(cRunner)))");
    // the job rows' runner select shows the bare runner id (no label passed)
    expect(card).toContain('{runnerOptions(j.runner as RunnerId, "")}');
  });

  test("Knowledge is a folded card of 「Workspace と GitHub」 that draws its body only once opened", () => {
    expect(settingsGroup("settings-workspace").sections.at(-1)).toBe("Knowledge");
    const from = body.indexOf("<SettingsCard title={t(settings.knowledge)}");
    expect(from).toBeGreaterThan(-1);
    const card = body.slice(from, body.indexOf("</SettingsCard>", from));
    expect(card.slice(0, card.indexOf(">\n"))).toMatch(/\blazy\b/); // the opening tag
    expect(card).toContain("<Knowledge ");
    // the card draws its children only when not lazy or already opened
    expect(source).toContain("(!props.lazy || opened) && props.children");
  });

  test("an unknown group id throws", () => {
    expect(settingsGroup("settings-auto").title.ja).toBe("自動で進める");
    expect(() => settingsGroup("settings-nope")).toThrow();
    expect(() => settingsGroup("settings-connect")).toThrow();
  });
});
