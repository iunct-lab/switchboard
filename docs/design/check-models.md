# check-models — noticing when the model lists fall behind the CLIs

PBI #248. The model choices in the UI (the list saved on the settings screen's モデルの選択肢, PBI #1400; a runner never saved there offers the bundled `CLAUDE_MODELS` in `packages/adapters/claude/src/index.ts` / `CODEX_MODELS` in `packages/adapters/codex/src/index.ts`) and the price table (`packages/core/config/pricing.json`, with rows entered on the settings screen's モデルの価格 on top, PBI #1402) are kept by hand (PBI #155: Switchboard holds no API key, so it cannot ask the vendors for a model list). When a new model ships, the lists stay behind until someone notices — on 2026-09-23 that someone was the user (#247). `scripts/check-models.ts` notices first, and a daily schedule turns what it finds into a request Issue.

## What it reads

The model tables come from what the installed CLIs carry locally — no vendor API, no API key, no network. The one read over the network is the version check (last item), against the public npm registry, still with no key:

- **claude**: the model table embedded in the executable (`Bun.which("claude")`, resolved to the real file). Its entries look like `{id:"claude-opus-5-5",family:"opus",display_name:"Opus 5.5",…}`; the file (about 240 MB) is scanned chunk by chunk, never read into one string (that got the script OOM-killed on a 3.8 GB host).
- **codex**: `codex debug models --bundled`, the table shipped in the binary. Without `--bundled` codex refreshes the list over the network with the ChatGPT login, so the flag is always given. Only `visibility: "list"` entries count (`"hide"` ones are internal).
- **the model choices** as the daemon offers them: the list saved on the settings screen, from `switchboard.db`'s settings row (read-only; the same `Settings` schema the daemon parses), else the bundled list of that runner.
- **the price table** as the daemon layers it: the rows saved on the settings screen's モデルの価格 (the settings row's `prices`, PBI #1402) over `pricing.json` — `~/.switchboard/pricing.json` (or `$SWITCHBOARD_HOME/pricing.json`) first, then the bundled one.
- **the ledger** in `switchboard.db`, read-only: the claude / codex model names recorded as `source = 'unpriced'` that the price table still does not price.
- **the CLIs' versions** (#1273, request #1271): `claude --version` / `codex --version` against the npm registry's `latest` of `@anthropic-ai/claude-code` / `@openai/codex` (`PACKAGES`; one GET per runner, 10 s, no key). This is the one read that uses the network: an old CLI carries an old table, so a new model looks like "no drift" until someone notices — on 2026-10-07 that someone was the user again (#1071, Haiku 5.5, while the host's CLI sat at 2.1.289 with auto-update off). The script never updates a CLI itself: `scripts/update-clis.ts` ([cli-update.md](cli-update.md)) runs first in the same schedule, so this read sees the updated version; a CLI still behind here means the update was rolled back or failed. A CLI not on PATH is skipped here (the table line already says so); the registry not answering is reported, not counted.

## What it reports

```
<runner> stale: <ids>          offered in the UI (saved list, else bundled), not in the CLI's table (an old or mistyped id)
<runner> unseen: <ids>         in the CLI's table, not in REVIEWED (nobody has looked at it yet)
<runner> 価格表未整備: <ids>    offered in the UI (saved list, else bundled), priced by no row of the settings' prices or pricing.json
unpriced (ledger) new / unknown  past unpriced names: in the CLI's table (the price table lags) / not in it (a wrong name?)
<runner> outdated: <installed> → <latest>   the installed CLI is behind the registry (drift, exit 1)
<runner> version: <installed>（最新）        the same or newer
<runner> version / latest: 分からない（<why>）  `--version` failed / the registry could not be read (report only; exit unchanged)
```

"New in the CLI" is measured against `REVIEWED` in the script — the ids a person has looked at and decided to list or leave out — not against "the newest of each family": some models are left out on purpose (`gpt-5.6-terra`), and they would otherwise be reported every day. The ledger line is report only: past rows cannot be fixed.

Exit 0 = no drift / 1 = drift / 2 = cannot tell (a CLI is not installed, or its table read as empty — the CLI's format changed and the script needs fixing). The same meaning as `scripts/merge-gate.ts`.

## The daily schedule

`bun scripts/check-models.ts --file-request` does the same check and, on exit 1, files a request Issue (`type:request`, via `scripts/file-request.ts` — shared with `scripts/merge-audit.ts` — which calls `scripts/setup/request_issue.sh`; in the app's Task, where `gh issue create` is refused, that stores the request in the app as `ops-kit backlog create` does and the app sends it to GitHub) titled `モデル一覧のズレ: <runner> <kind> <ids> / …`. The title is built from the findings in a fixed order, so the same drift always has the same title; if an open request already has it (looked up over REST, `gh api repos/<owner>/<repo>/issues`, not GraphQL), nothing is filed. A different drift (another id shows up) is a new title and a new request. Exit 2 files nothing.

It runs from the existing scheduler as an ordinary prompt schedule — no new schedule action. The prompt only runs the command and reports; the script decides what to file:

```
POST /api/schedules
{ "title": "check-models（モデル一覧のズレ）", "cron": "0 7 * * *", "workspaceId": <the switchboard workspace>, "runner": "claude",
  "prompt": "bun scripts/update-clis.ts --file-request を 1 回実行し、続けて bun scripts/check-models.ts --file-request を 1 回実行し、それぞれの終了コードと出力をそのまま報告してください。ファイルは変更しないでください。",
  "budgetUsd": <agreed with the user> }
```

Registering it is a call to the running daemon, so it is done with the user's OK (PBI #248), not by the PR.

### Why not `bun test` / CI

The CLIs are not installed in GitHub Actions, so CI cannot run the check; on the host, a failing test would stop every unrelated PR's local CI and merge whenever a CLI auto-updates. So the check runs on a schedule (PBI #248): a day late at most, and nothing else stops.

## When a request arrives

- `stale`: remove or fix the old / mistyped id in モデルの選択肢 on the 設定 tab (no PR: the next run reads the saved list).
- `unseen`: decide whether the model goes in the list (and add it in モデルの選択肢 on the 設定 tab if so), then add the id to `REVIEWED` either way.
- `価格表未整備`: enter the official price in モデルの価格 on the 設定 tab (no PR: the next run reads the saved prices).
- `outdated`: only appears when update-clis rolled back, failed, or could not tell (exit 2: the registry or the rollback link was unreadable, so it changed nothing) — look for the `CLI 更新の失敗` request first (cli-update.md); with none, read the schedule's update-clis lines. Otherwise update the CLI by hand. The request's title carries the installed version only, so one open request stands while the CLI stays, whatever npm publishes meanwhile. The next run says `version: …（最新）` and, if the new table carries a model nobody reviewed, `unseen` follows.
- Close the request once it is fixed (a `stale`, a `価格表未整備` or the list half of `unseen` on the settings screen, the rest by a PR); the next morning's run confirms (exit 0). An `outdated` request has no PR: update the CLI, let the next run print `version: …（最新）`, then close the request by hand (the script never closes one).

The model list is a setting since PBI #1400 (request #601); offering a model the installed CLI carries as a candidate at run time is #1401.
