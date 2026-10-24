# CLI update (PBI #1626, request #1625)

`scripts/update-clis.ts` keeps the host's `claude` and `codex` CLIs on npm's latest, checks that the new one still works through Switchboard's adapter, and puts the old one back when it does not. It runs first in the daily `check-models` schedule ([check-models.md](check-models.md)), so check-models always reads the updated version.

## What it does, per runner

1. Reads the installed version (`<bin> --version`) and npm's `latest` (`PACKAGES` and `hostVersions` of `scripts/check-models.ts`; one GET, no key). Same or newer installed: `<runner> version: <v>（最新）`, nothing else.
2. Older: remembers where the CLI's symlink points (`LINKS`: claude `~/.local/bin/claude` → `versions/<v>`, codex `~/.codex/packages/standalone/current` → `releases/<v>-<triple>`), then runs the CLI's own `update` (5 min limit). Each `update` installs the new version beside the old and flips that symlink; the old files stay.
3. Re-reads `--version` (it must have moved), then runs one turn through the adapter: `runSuggestionTurn` (the same path as the routing judge), read-only mode, the CLI's default model, an empty temporary directory, 180 s. Any non-empty answer passes; the content is not looked at.
4. Passes: `<runner> updated: <old> → <new>（確認 ok）`. Fails at any step: the symlink is flipped back to the remembered target (a temporary link in the same directory, then rename — the path never disappears), `--version` is checked to be `<old>` again, and `<runner> rolled back: <new> → <old>（確認 失敗: <reason>）` is printed. If it cannot be put back: `<runner> 戻せなかった: …`.

CLI missing, registry unreadable, or the symlink unreadable: `<runner> latest / version: 分からない（…）`; nothing is changed.

Exit 0 = up to date or updated and checked / 1 = rolled back, could not roll back, or `update` failed / 2 = cannot tell.

## Where the result is read

The schedule's Task (scheduled list in the schedules view → its conversation) keeps the printed lines. On exit 1, `--file-request` files a request Issue titled `CLI 更新の失敗: <runner> <old> → <new> / …` through `scripts/file-request.ts`; the same failure has the same title, so an open request is not filed twice.

## Decisions

- Running Tasks keep the files they started with; only Tasks started later use the new CLI. Replacing a running Task's CLI is out of scope.
- No state is kept for a rolled-back version. The next day it is tried again (update → fail → roll back) and the open request stands, until the adapter is fixed or a newer version passes.
- Old versions are not cleaned up here: they are the rollback targets, and each CLI's `update` owns them.
- Each run costs one flat-rate turn per outdated CLI; an up-to-date host costs none.
- The model list and price table are not updated here: a new model in the updated CLI shows up as `unseen` in check-models as before.
