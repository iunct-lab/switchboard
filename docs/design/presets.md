# Saved instructions (定型の指示)

PBI #940 (request #934). The same long request — "handle the review of PR … through to the merge" — was typed again for every Issue or PR, and a condition was sometimes left out. A saved instruction keeps the text once; sending it is choosing it and the target.

## Shape

A preset is `{ id, name, text, createdAt, updatedAt }` (`Preset` in `packages/protocol/src/model.ts`). `name` is 1–60 characters, `text` 1–8000. `{{target}}` in the text is where the chosen Issue / PR goes; a text without it uses no target. The "scope of the run" (e.g. 「レビュー対応からマージまで」) is not a field: it is written in the name and the text.

A preset has no approval mode, runner or model. `PresetInput` is strict, so `permissionMode` or any other extra key is 400.

## Where it is kept

The daemon's `settings` table, key `presets` (a JSON array), like the answer policies (`answerPolicies`, #938): one user, a short list, no new table. An entry that does not parse is dropped with a warning; the browser keeps nothing (no localStorage).

It is not a Knowledge document. `commands/` in Knowledge are slash commands written out to `~/.claude/commands`, not request texts with a target slot. The steps themselves stay where they are kept now — a skill or a Knowledge document — and a preset names them in a short request ("… を `review-triage-and-merge` の手順で"), so there is one source for the steps.

A text with a value that signs in or acts as the user (`findSecrets`, `ops-kit/src/secrets.ts`) is refused (400), as is a second preset with the same name (409).

## Putting the target in

`POST /api/presets/:id/expand { workspaceId, target }` returns `{ title, text, repo, target }` and writes nothing.

- The target is written `12`, `#12`, `owner/name#12`, or the Issue / PR URL (`…/issues/12`, `…/pull/12`). Anything else is 400.
- Every `{{target}}` becomes `owner/name#n`, where `owner/name` is the Workspace's repository (`gh repo view`, asked only here). A target naming another repository (compared ignoring case) is 409; a failing `gh` is 424.
- The title is `<name> <owner/name#n>`, or the name when no target is used.
- A target is required when the text has `{{target}}` (empty = 400) and refused when it does not (400). With no Workspace (自動) a target cannot be checked: 400.
- Whether the Issue / PR exists is not asked: the person sees the text before sending it.

## Sending it

`PresetPicker` (`apps/web/src/components/PresetPicker.tsx`) sits over Home's request box and a Task's reply box. It starts as a 「定型の指示…」 button and reads the list when pressed, so opening Home or a Task costs no request (perf-ratchet's journeys). 「本文に入れる」 puts the expanded text (and on Home the title) into the box; the person reads it, may edit it, and sends it with the box's own 開始 / 送信 — `POST /api/tasks` and `POST /api/tasks/:id/send` are unchanged and take no preset.

On Home, a text put in from a preset and left as it was is not sent once the Workspace changes (`staleDraft`, `apps/web/src/presets.ts`): it names the other workspace's repository. 開始 and Inbox に保存 stay disabled until it is put in again. A text edited by hand is the person's and is not held.

## Approvals

A preset is what to ask, never a standing permission. The Task it starts uses the approval mode chosen in the request box, and the runner's approvals, the Knowledge `approval:` rules and the saved answer policies apply as for any typed request (`permission-modes.md`, `asks.md`). `scripts/presets-e2e.ts` checks that a write the fake runner asks for still waits with 許可 / 拒否.

## API

- `GET /api/presets` — `{ presets }`, newest `updatedAt` first.
- `POST /api/presets { name, text }` — 201; 400 (shape, secret), 409 (same name).
- `PATCH /api/presets/:id { name?, text? }` — same checks; 404 for an unknown id.
- `DELETE /api/presets/:id` — 404 for an unknown id.
- `POST /api/presets/:id/expand { workspaceId?, target? }` — above.

## Tests

- `packages/core/src/presets.test.ts` — the target forms, the expansion, the API's refusals, kept over a restart, nothing written by expand.
- `apps/web/src/presets.test.ts` — the settings row, `{{target}}` detection, `staleDraft`.
- `scripts/presets-e2e.ts` (after `bun run --cwd apps/web build`; `CHROME_BIN`, `SCREENSHOT_DIR`) — 設定 add / edit / reload / delete, the refusals, one 開始 with the target swapped in (the runner and the Task's first message get the box's text exactly), the Task on the request box's approval mode and its write still waiting, a reply, 390px without sideways scroll.
