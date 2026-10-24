# Security policy

## Supported versions

Only `main` gets security fixes.

## Reporting a vulnerability

Please report it privately through a GitHub Security Advisory:
https://github.com/iunct-lab/switchboard/security/advisories/new

Do not open a public Issue or Discussion for a vulnerability. Include what you did, what happened, and the commit hash you ran. You will get an answer in the advisory.

## What Switchboard holds

Switchboard holds no API keys and no runner credentials: each runner (Claude Code, Codex, DAK) uses its user's own login on the user's machine, and Switchboard only starts it as a child process. On the optional cloud host, a wrapper in the environment layer (`scripts/host/claude-wrapper.sh`) can read the user's own `claude setup-token` from the user's Parameter Store and hand it to `claude` in that process's environment; the daemon never sees it (`docs/design/cloud-hosting.md` §4). The end-of-turn judgement and the rubric evaluation send text from a task (its request and replies) to the runner set for them, Codex by default and Claude Haiku when that fails, which can be a different provider than the task's own runner; turn them off in 設定 (two switches: `judge.enabled` for the end-of-turn judgement and `evals.judge.enabled` for the rubric evaluation), or set both the judgement's runner (`judge.runner`, Codex by default) and its fallback (`judgeFallbackRunner` / `judgeFallbackModel`) to the provider you want the text to stay with. Creating a task with its Workspace left on 自動 sends the task's title and the start of its prompt, with the registered Workspaces' names, paths and the head of their briefs, to the runner set for routing (`routing.llm.runner`, Claude by default) so that it picks the Workspace; the runner suggestion, when it is switched on (`routing.llm.enabled`), sends that runner the task's title, the start of its prompt and its scope paths, with the titles of earlier tasks and how they ended. Pick the Workspace yourself and leave the suggestion off, or set that runner, to keep the text with one provider. The daemon listens on loopback by default; off loopback every `/api` and `/ws` request needs the token in `~/.switchboard/token` (`/api/health` answers without it and says whether a token is required; each task's `/mcp` endpoint uses its own per-task token).
