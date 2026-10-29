import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { InboxNote } from "@switchboard/protocol";
import { DraftEditor, DraftTitle } from "./components/Home.tsx";
import { editChanged, toggleDraft, type DraftEdit } from "./inbox.ts";

const note = (over: Partial<InboxNote> = {}): InboxNote => ({ path: "notes/a.md", title: "題", body: "1\n2\n3\n4\n5", created: "2026-10-29T00:00:00.000Z", status: "inbox", ...over });

test("toggleDraft opens a draft with its title and the whole body, closes it on a second press, and keeps one open (#3032)", () => {
  const a = note();
  const open = toggleDraft(null, a);
  expect(open).toEqual({ path: "notes/a.md", title: "題", text: "1\n2\n3\n4\n5" });
  expect(toggleDraft(open, a)).toBeNull();
  // another draft replaces the open one
  expect(toggleDraft(open, note({ path: "notes/b.md", title: "b", body: "x" }))).toEqual({ path: "notes/b.md", title: "b", text: "x" });
});

test("editChanged: only a different title or body counts; surrounding whitespace does not (#3032)", () => {
  const a = note();
  const open = toggleDraft(null, a)!;
  expect(editChanged(open, a)).toBe(false);
  expect(editChanged({ ...open, text: "1\n2\n3\n4\n5\n" }, a)).toBe(false);
  expect(editChanged({ ...open, text: "1\n2" }, a)).toBe(true);
  expect(editChanged({ ...open, title: "新しい題" }, a)).toBe(true);
  expect(editChanged({ ...open, title: " 題 " }, a)).toBe(false);
});

const noop = () => undefined;
const title = (n: InboxNote, open: boolean) => renderToStaticMarkup(createElement(DraftTitle, { note: n, open, onToggle: noop }));
const editor = (edit: DraftEdit, n: InboxNote, saving = false) => renderToStaticMarkup(createElement(DraftEditor, { edit, note: n, saving, onChange: noop, onCancel: noop, onSave: noop }));

test("render: the closed title marks a longer body with …; the open one does not, and says it is expanded (#3032)", () => {
  const a = note();
  expect(title(a, false)).toContain('aria-expanded="false"');
  expect(title(a, false)).toContain("題<span class=\"hint\"> …</span>");
  expect(title(a, true)).toContain('aria-expanded="true"');
  expect(title(a, true)).not.toContain("…");
  expect(title(note({ body: "one line" }), false)).not.toContain("…");
});

test("render: the editor shows the title and the whole body as typed, with やめる and 保存; 保存 waits for a change (#3032)", () => {
  const a = note();
  const open = toggleDraft(null, a)!;
  const h = editor(open, a);
  expect(h).toContain('<input value="題"/>');
  expect(h).toContain("<textarea>1\n2\n3\n4\n5</textarea>");
  expect(h).toContain("やめる</button>");
  expect(h).toContain('<button class="pri" disabled="">保存</button>');
  expect(editor({ ...open, text: "直した" }, a)).toContain('<button class="pri">保存</button>');
  // while a save is on its way, 保存 cannot be pressed again
  expect(editor({ ...open, text: "直した" }, a, true)).toContain('<button class="pri" disabled="">保存</button>');
});
