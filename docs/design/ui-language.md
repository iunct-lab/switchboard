# UI language (which words on the screen are English and which are Japanese)

The web UI mixed the two languages without a rule: the header had English tabs followed by `設定` and `救援画面`, the rail had `Running · Waiting` and `Workspaces` next to `要対応 · N`, and a few screen headings (`Task Brief`) were English inside Japanese screens. This document holds the rule the owner confirmed on 2026-10-23, and `scripts/ui-strings.ts` lists every fixed string of `apps/web/src` against it. A later language switch (an English mode) builds on the same split.

## Rule

| Where | Language | Examples |
|---|---|---|
| Header (`App.tsx`'s `<header className="chrome">`): brand, tabs, rescue entry, connection state | English words | `Home` `Task` `Knowledge` `Ledger` `Insights` `Backlog` `Schedules` `Settings` `Rescue`, `daemon connected` |
| A screen's name where a tab opens it (its heading, `screen.ts`'s `screenLabel`) | The tab's word | `Backlog`, `Settings` (not `設定`), `Schedules` (not `定期タスク`) |
| The rail's group headings | `Running · Waiting` and `Tasks` as they are (English); the rest by the row below | `Running · Waiting`, `Tasks`, `Workspace`, `要対応 · N` |
| Every other heading, buttons, labels, body text, `placeholder` / `title` / `aria-label` / `alt` | Japanese; proper nouns mixed in as they are | `新しいタスク · Inbox`, `Terminal の履歴（Claude Code）` |
| Proper nouns: products, runners, external services, protocols | As they are | Switchboard, Claude Code, Codex, DAK, GitHub, MCP, Workspace MCP, URL, JSON |
| GitHub's names for its parts: `Project`, `Issue`, `PR`, `Milestone`, `Actions` | As they are | `Issue を作る`, `PR #12` |
| Values from data: Issue titles, Project field options, model ids, runner ids, paths, commands | As they are (not listed) | `claude-opus-…`, `~/.claude/projects`, `bun run dev` |

The rule's data is in `scripts/ui-strings.ts` only: `NAV_EN` (the header's words), `RAIL_HEADINGS` and `PROPER_NOUNS` (the proper-noun rows above and the app's own words below; the first row gives examples, the constant has the full list). Changing the rule means changing those constants and this table together; the one rule held in code instead of data is the single-letter unit in `judge` (see Listing).

### The app's own words

The owner kept these English words for the app's concepts as proper nouns (2026-10-23), since they already work as names inside Japanese sentences (`Inbox に保存`, `Task の会話`, the `Terminal` tag): Workspace, Inbox, Terminal, Task, SP (the Project's Story Points), PBI, worktree, main, OK, ID / id, and the units ms, KB, MB, GB, JST, UTC and a single letter next to a number (`3 s`, `12 k`). `Local` / `Cloud` (the run location) are translated: ローカル / クラウド.

The owner's answer (2026-10-23) keeps two of the rail's group headings in English as they are: `Running · Waiting` and `Tasks` (`RAIL_HEADINGS`). The third, `Workspaces`, follows the confirmed proposal and becomes the proper noun `Workspace`; `要対応 · N` stays Japanese.

### Login names and how much text a screen carries

The owner's rules (2026-10-24, 2026-10-25):

- Claude Code's login choices use Anthropic's own names: Claude アカウント (subscription), Anthropic Console アカウント (API usage fees), and a third-party platform such as Amazon Bedrock. Do not write 「サブスク」, 「API 課金」 or 「定額」 for them. The internal values (`billing: subscription|api`) stay as they are.
- Do not add explanatory text to a screen, on any screen (Home included); one extra line is the most a change adds. Rarely used operations (adding a repository, for example) go to Settings, not Home. Login state and logout live in Settings; cost and its filters live in the Ledger.

## Listing

```bash
bun scripts/ui-strings.ts [dir…]           # every string: path:line  kind  lang  verdict  text (default dir apps/web/src)
bun scripts/ui-strings.ts --check [dir…]   # the violations only; exit 1 when there is one
```

What it reads, with the TypeScript compiler API (no new dependency): every `*.tsx` and `screen.ts` under the directories, test files excluded.

- `kind`: `nav` = text inside the header, and `screenLabel`'s names of screens with a tab; `heading` = text directly in `h1`–`h6`; `rail` = text in a `className="grp"` group heading (`RAIL_HEADINGS` applies only here); `text` = other JSX text; `attr` = `title` / `placeholder` / `aria-label` / `alt` / `label`; `literal` = a string in a JSX expression (a ternary's branch)
- `lang`: `ja` = kana or kanji, `en` = Latin letters only, `mixed` = both, `symbol` = neither
- `verdict`: a `nav` that is not English is a violation. An `en` string is ok when it is a tab's word used as a screen heading, or when nothing is left after removing proper nouns, code-like tokens (paths, env names, `{{…}}`, `#12`) and a single letter next to a number or alone after one (a unit or a metric: `3 s`, `p90`, the `k` of `{n}k`). Japanese and mixed strings are ok outside the header.
- Not collected: children of `code` / `pre` / `kbd`, strings compared with `===`, object keys, lists of plain strings (`["claude", "codex"].map(…)`), and object values other than `label` / `title` / `text` / `placeholder` / `hint` / `message`. Callbacks inside JSX (a `.map` that builds rows) are read like the JSX around them; handlers in `onClick` and other non-text attributes are not. Strings built outside JSX (module constants, `.ts` helpers such as `attention.ts`) are not read either; the listing is of what JSX shows directly.

The check is not part of `scripts/ci.ts`: the target is zero violations once the screens are fixed, and the language switch will change how wording is held.

## Rescue page

`rescue/src/page.html` is a separate page (one HTML file, not read by the script). Its headings, buttons and body are Japanese already (`Switchboard 救援`, `再起動`, `前の版に戻す`, `救援エージェント`, `昇格の履歴`), and `/tmp` and `claude -p` are paths and commands. The status line's `（supervisor: <state>）` names the rescue service's supervisor and shows its state value; it is kept (the page's own wording is outside this work). Nothing in it breaks the rule, so it is left as it is. Only the entry to it, in the web header, becomes `Rescue`.
