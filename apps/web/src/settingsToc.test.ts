import { expect, test } from "bun:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsGroupHeading, SettingsToc } from "./components/Settings.tsx";
import { SETTINGS_GROUPS } from "./settingsGroups.ts";

test("SettingsToc: one link per group, each to the id of that group's heading (#3356)", () => {
  const html = renderToStaticMarkup(createElement(Fragment, null, createElement(SettingsToc), ...SETTINGS_GROUPS.map((g) => createElement(SettingsGroupHeading, { key: g.id, id: g.id }))));
  const toc = html.slice(0, html.indexOf("</nav>"));
  const hrefs = [...toc.matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]);
  expect(hrefs).toEqual(SETTINGS_GROUPS.map((g) => g.id));
  for (const g of SETTINGS_GROUPS) {
    expect(toc).toContain(`>${g.title.ja}</a>`);
    expect(html).toContain(`<h4 class="settings-group" id="${g.id}" tabindex="-1">${g.title.ja}</h4>`);
  }
});
