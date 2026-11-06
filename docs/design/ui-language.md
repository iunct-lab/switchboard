# UI language (which words on the screen are English and which are Japanese)

The web UI mixed the two languages without a rule: the header had English tabs followed by `設定` and `救援画面`, the rail had `Running · Waiting` and `Workspaces` next to `要対応 · N`, and a few screen headings (`Task Brief`) were English inside Japanese screens. This document holds the rule the owner confirmed on 2026-10-23, and `scripts/ui-strings.ts` lists every fixed string of `apps/web/src` against it. A later language switch (an English mode) builds on the same split.

## Rule

| Where | Language | Examples |
|---|---|---|
| Header (`App.tsx`'s `<header className="chrome">`): brand, tabs, rescue entry, connection state | English words | `Home` `Task` `Knowledge` `Ledger` `Insights` `Backlog` `Resources` `Schedules` `Settings` `Rescue`, `daemon connected` |
| A screen's name where a tab opens it (its heading, `screen.ts`'s `screenLabel`) | The tab's word | `Backlog`, `Settings` (not `設定`), `Schedules` (not `定期タスク`) |
| The rail's group headings | `Running · Waiting` and `Tasks` as they are (English); the rest by the row below | `Running · Waiting`, `Tasks`, `Workspace`, `要対応 · N` |
| Every other heading, buttons, labels, body text, `placeholder` / `title` / `aria-label` / `alt` | Japanese; proper nouns mixed in as they are | `新しいタスク · Inbox`, `Terminal の履歴（Claude Code）` |
| Proper nouns: products, runners, external services, protocols | As they are | Switchboard, Claude Code, Codex, DAK, GitHub, MCP, Workspace MCP, URL, JSON |
| GitHub's names for its parts: `Project`, `Issue`, `PR`, `Milestone`, `Actions`, and git's `head` / `base` of a PR | As they are | `Issue を作る`, `PR #12`, `head 1a2b3c4 · base 5d6e7f8` |
| Values from data: Issue titles, Project field options, model ids, runner ids, paths, commands | As they are (not listed) | `claude-opus-…`, `~/.claude/projects`, `bun run dev` |

The rule's data is in `scripts/ui-strings.ts` only: `NAV_EN` (the header's words), `RAIL_HEADINGS` and `PROPER_NOUNS` (the proper-noun rows above and the app's own words below; the first row gives examples, the constant has the full list). Changing the rule means changing those constants and this table together; the one rule held in code instead of data is the single-letter unit in `judge` (see Listing).

### The app's own words

The owner kept these English words for the app's concepts as proper nouns (2026-10-23), since they already work as names inside Japanese sentences (`Inbox に保存`, `Task の会話`, the `Terminal` tag): Workspace, Inbox, Terminal, Task, SP (the Project's Story Points), PBI, worktree, main, OK, ID / id, and the units ms, KB, MB, GB, JST, UTC and a single letter next to a number (`3 s`, `12 k`). `Local` / `Cloud` (the run location) are translated: ローカル / クラウド.

The owner's answer (2026-10-23) keeps two of the rail's group headings in English as they are: `Running · Waiting` and `Tasks` (`RAIL_HEADINGS`). The third, `Workspaces`, follows the confirmed proposal and becomes the proper noun `Workspace`; `要対応 · N` stays Japanese.

### Login names and how much text a screen carries

The owner's rules (2026-10-24, 2026-10-25):

- Claude Code's login choices use Anthropic's own names: Claude アカウント (subscription), Anthropic Console アカウント (API usage fees), and a third-party platform such as Amazon Bedrock. Do not write 「サブスク」, 「API 課金」 or 「定額」 for them. The internal values (`billing: subscription|api`) stay as they are.
- Do not add explanatory text to a screen, on any screen (Home included); one extra line is the most a change adds. Rarely used operations (adding a repository, for example) go to Settings, not Home. Login state and logout live in Settings; cost and its filters live in the Ledger.
- Where a feature is placed (the floor, the ceiling or the walls) is decided by `ui-layers.md`; this section only limits how much text a screen carries.

## Listing

```bash
bun scripts/ui-strings.ts [dir…]           # every string: path:line  kind  lang  verdict  reason  text (default dir apps/web/src)
bun scripts/ui-strings.ts --check [dir…]   # the violations only; exit 1 when there is one
```

What it reads, with the TypeScript compiler API (no new dependency): every `*.tsx` and `*.ts` under the directories, test files and the dictionaries (`i18n/`) excluded.

- `kind`: `nav` = text inside the header, and `screenLabel`'s names of screens with a tab; `heading` = text directly in `h1`–`h6`; `rail` = text in a `className="grp"` group heading (`RAIL_HEADINGS` applies only here); `text` = other JSX text; `attr` = `title` / `placeholder` / `aria-label` / `alt` / `label`; `literal` = a string in a JSX expression (a ternary's branch), or a string with kana or kanji outside JSX (a `.ts` helper, a module constant of a `.tsx`)
- `lang`: `ja` = kana or kanji, `en` = Latin letters only, `mixed` = both, `symbol` = neither
- `verdict` and `reason`: a `nav` that is not English is a violation. Outside the header a `ja` or `mixed` string is a violation with the reason `untranslated`: Japanese written directly in JSX instead of through a dictionary and `t()` (see "Adding wording" below), so it cannot switch to English. An `en` string is ok when it is a tab's word used as a screen heading, or when nothing is left after removing proper nouns, code-like tokens (paths, env names, `{{…}}`, `#12`) and a single letter next to a number or alone after one (a unit or a metric: `3 s`, `p90`, the `k` of `{n}k`); otherwise it is a violation too (English written directly shows in Japanese mode).
- Marked values: a comment `ui-strings: value "<text>" ["<text>"…] — <why>` lists strings that look like wording but are values (sent to the daemon, compared, keys, a sample entry). It covers only the node right after it (the statement a `//` comment leads, or the next JSX child for `{/* … */}`), and only the texts it names; they are listed as `ok` with the reason `marked as a value`. Example: `screen.ts`'s `判断待ち`, which the feedback sends as it is.
- Not collected: children of `code` / `pre` / `kbd`, strings compared with `===` or tested with `in`, object keys, lists of plain strings (`["claude", "codex"].map(…)`), and object values other than `label` / `title` / `text` / `placeholder` / `hint` / `message`. Callbacks inside JSX (a `.map` that builds rows) are read like the JSX around them; handlers in `onClick` and other non-text attributes are not. Outside JSX only Japanese is collected, with the same exceptions: English there is mostly values (keys, ids, paths), and the rule is that Japanese reaches the screen through a dictionary.

`scripts/ui-strings.test.ts` runs `--check` on `apps/web/src` and expects no violation, so the check runs with `bun test` (not as a step of its own in `scripts/ci.ts`).

## Rescue page

`rescue/src/page.html` is a separate page (one HTML file, not read by the script). Its headings, buttons and body are Japanese already (`Switchboard 救援`, `再起動`, `前の版に戻す`, `救援エージェント`, `昇格の履歴`), and `/tmp` and `claude -p` are paths and commands. The status line's `（supervisor: <state>）` names the rescue service's supervisor and shows its state value; it is kept (the page's own wording is outside this work). Nothing in it breaks the rule, so it is left as it is. Only the entry to it, in the web header, becomes `Rescue`.

## Language switch (English mode)

The web UI gets a choice between Japanese (the default) and English. Japanese stays exactly as the rule above describes; English replaces the app's own fixed wording. Inputs to development (the prompts the daemon gives Tasks, CLAUDE.md, skills, Issue templates) stay Japanese (the owner's decision, 2026-10-23).

### What switches

| Target | Switches? | Why | Where |
|---|---|---|---|
| The screen's fixed wording: JSX text and attributes, and the `.ts` helpers that build sentences for the screen | Yes | This is what a reader who does not read Japanese has to read | `apps/web/src` (`*.tsx`, `asks.ts`, `inProgress.ts`, `stops.ts`, `interventions.ts`, `backlogSync.ts`, `release.ts` and the like) |
| Dates and numbers | No | They are digits only (`YYYY-MM-DD`, `M/D HH:MM`, `toLocaleString()`'s separators) and read the same in both languages; JST stays fixed. The words around them (`に戻る`, `件`) are fixed wording and switch | `apps/web/src/time.ts` (formats); the sentences around them are where they are built (`quota.ts`, `components/ui.tsx`, `components/Brief.tsx` and others) |
| Browser notifications | Yes | They are sentences the web UI builds (`ツール承認待ち: …`, `要対応: …`) | `apps/web/src/notify.ts` |
| The PWA's name | No | `Switchboard` is a proper noun | `apps/web/public/manifest.webmanifest` |
| Instructions the daemon gives Tasks (prompts) | No | Inputs to development do not change | `packages/core/src` |
| The feedback's screen name (`screenLabel`) | Sent value: No. On screen (the feedback dialog's `送信元: …`): Yes | The value goes into a Task's prompt, an input to development; the dialog shows the same name to the reader, so the dialog shows the dictionary's word while the value sent stays as it is today (the tab's word, or Japanese such as `判断待ち`); a Task's line `Task「title」(id)` is shown with the language's quotes (`Task "title" (id)` in English) | `apps/web/src/screen.ts`, `apps/web/src/components/Feedback.tsx` |
| Proper nouns and the app's own words (`PROPER_NOUNS`), and values from data (Issue titles, Project options, model ids, paths) | No | They are names, or they are not the app's words | `scripts/ui-strings.ts` |
| Error messages from the API, and sentences the daemon builds that the screen shows as they are | No (the owner confirmed, 2026-11-05) | See below | `packages/core/src` (`server.ts`, `asks.ts`, `backlog.ts`, `stops.ts` and others) |
| Errors the scratch-app bridge returns to an artifact's page (`apps/web/src/scratchBridge.ts`) | No | They are API errors handed to the artifact's code, like the daemon's own errors (scratch-apps.md) | `apps/web/src/scratchBridge.ts` |
| The rescue page | No | A separate one-file emergency page, outside the daemon and the web build | `rescue/src/page.html` |

Daemon-built sentences: they live in the same files as the Task instructions, which must stay Japanese, and the daemon does not know which language a browser chose (the choice is per browser, below). Switching them means the daemon learning the language with each request and moving those sentences into dictionaries of their own, about two or three more pieces of work. They stay Japanese in English mode (the owner's answer, 2026-11-05); they show up in error banners and in a few status lines, not in the screen's structure.

### How the choice is held

`apps/web/src/i18n.ts` holds the language and `t()`; the screens move their wording into dictionaries one by one.

- The language is in the browser's `localStorage` under `switchboard.lang` (`ja` or `en`; anything else or nothing means `ja`). It is per browser: a phone and a laptop can differ. The settings API, the database and the protocol do not change, and the daemon never uses the language.
- Settings has a card to choose it (Language, in the connection and app group). Changing it reloads the page; the module reads the language once at load, so there is no React context for it.
- Wording lives in dictionaries, one file per screen: `apps/web/src/i18n/<screen>.ts`, each entry `{ ja, en }`. No i18n library is added (no new dependency). A missing English entry fails the type check, and `apps/web/src/i18n.test.ts` fails on an empty side or on placeholders (`{name}`) that differ between the two sides.
- `bun scripts/ui-text-e2e.ts --lang ja|en --out <dir> [--dist <dir>] [screen…]` writes each screen's wording, as a daemon with a fake runner and fake data shows it, to `<dir>/<screen>.txt` (numbers as `N`, the running build's sha as `<sha>`, lines sorted). Two `--lang ja` runs, one with `--dist` pointing at the build before a change, compare with `diff -r`; `--lang en` lists the lines that still have kana or kanji and exits 1 when one of them is not expected (below).

### Adding wording

- Put the screen's new wording in its dictionary, `apps/web/src/i18n/<screen>.ts` (`msgs({ key: { ja, en } })`, keys named by role, variables as `{name}`), and show it with `t(dict.key, { name })`. A sentence that wraps an element (`<code>`) is split into entries around it. Helpers several screens share, and the few places without a dictionary of their own (the Resources screen, Settings' Workspace and login cards), go in `apps/web/src/i18n/common.ts`; a screen does not import another screen's dictionary.
- `.ts` helpers that build sentences for the screen call `t()` themselves. A string that is compared, stored or sent to the daemon stays as it is, with a short comment saying so.
- Japanese written directly fails `bun test` (`scripts/ui-strings.test.ts`, the `untranslated` rule above), in JSX and in a `.ts` helper or a module constant alike. A string that must stay Japanese because it is a value (sent to the daemon, compared, a URL) gets a `ui-strings: value "<text>" — <why>` comment naming it, on the line before the statement or declaration it belongs to.
- English mode may show Japanese only where this document says it does not switch: the daemon's sentences, values from data, and `日本語` in the Language card. `scripts/ui-text-e2e.ts` holds the lines it expects in a short list (`EXPECTED_JA`), each with its reason: today the routing reason from `packages/core/config/routing.yaml`, the schedule title the daemon seeds, the default auto-resume prompt (sent to a Task) and its `[Switchboard 自動再開]` marker. The fake backlog's Issue comments are data written in Japanese whose headings the daemon parses (`## 判断待ち`), so their lines are expected as well. Anything else in Japanese is a missed string: move it into a dictionary rather than adding it to the list.
