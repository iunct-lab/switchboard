# GitHub API budget (#884)

Every backlog operation spends one shared budget: GitHub counts GraphQL points and REST requests per user per host,
whichever tool sends them (the daemon, every Task, the backlog scripts, another machine on the same login).
GraphQL is 5,000 points an hour, and secondary limits apply on top of that. The rules are in GitHub's docs
(`rate-limits-and-query-limits-for-the-graphql-api`).

## What spends less now (#894)

- **One import per workspace at a time.** The backlog is read from what was imported (#885). `BacklogSync.sync`
  (`packages/core/src/backlog-sync.ts`) hands an import under way to every caller for the same workspace (a refresh,
  the scheduled sweep, the read-back after an answer). An import asks only for the Issues updated since the last one,
  the open Issues' Project items (the first page of that read also carries up to 50 open PRs with their labels and up to 100 changed files each, #1059), and the numbers it must check again. A write is counted per repository and per
  workspace: an import begun before it — through any checkout of the repository — stores nothing, and the one queued
  after it reads the write back ([backlog.md](backlog.md), 取込み).
- **No calls while a limit or an outage is waited for.** `GithubRetryState` (`ops-kit/src/gh.ts`) keeps one wait per
  host. A failed answer is classified by `retryAtFromResponse` from what `gh` shows: the `--include` headers, the
  GraphQL `errors`, and stderr.
  - The kinds are primary limit, secondary limit, transient (5xx, dropped connection) and auth.
  - For a limit or a transient failure, the wait lasts until `Retry-After`. Without it, the wait lasts until
    `X-RateLimit-Reset` (when the remaining count is 0). Without either, the wait starts at 60 s and doubles per
    failure since the last success, up to 15 min.
  - Auth failures (401, a 403 that is not a limit, `gh auth login`) are never waited for and never retried by a loop.
    The next request asks again.
  - Only a call that began after the failure was recorded clears the wait.
  - In the daemon, a read always shows what is stored, with the reason and the time during the wait. The scheduled
    sweep gets the reason and starts nothing. The end of the wait is stored with the repository (`retryAt`), so a
    restarted daemon keeps it.
  - In ops-kit, `realGh` refuses every call during the wait, writes included: the limits count per token, and a
    refused call has done nothing. The lint and scan retry loops stop on a classified failure.

## What the budget's read spends (#549)

`GithubBudgetCache` (`packages/core/src/backlog.ts`) asks GraphQL `rateLimit` (1 point) for the resume of a Task GitHub's limit stopped (`ratelimit.ts`) and
`GET /api/ledger/summary` (no stage start asks: the budget holds none since #2264), at most once a minute, and keeps the answer, a failure too, for that minute. It
is a new cost, not a saving. It keeps the rule above: while `BacklogSync`'s wait for the host is on (after a restart,
a repository's stored `retryAt` too), it asks nothing — a primary limit is 0 left until the wait ends, another wait
(and a stored one, whose kind is not kept) is not known. At 0 left GitHub refuses the read itself for the primary limit, which counts as 0 left until the reset. It
is not a `GithubCallMetric` (github-api-bench does not show it). See [backlog.md](backlog.md) (定期実行, GitHub の残量).

## Measuring (#895)

`GithubCallMetric` is one call: the operation (`api graphql`, `api rest`, or the gh command and its verb), the host,
the repository, ok or failure kind, and what GitHub said about the limit (remaining, resource, reset).

- `kind: "shared"` marks a backlog import that joined one under way. `kind: "waited"` marks a call refused during a
  wait: a backlog import, or an ops-kit call (`realGh`). Neither of these reached GitHub. Reading the stored backlog is
  not a call and is not measured. A backlog import's shared and waited records carry the repository the workspace
  reads (`repo`), so the counts of two workspaces are told apart; null before the workspace's first import, and null
  on an ops-kit call refused during a wait (`realGh` does not record it). The checkout's path is never
  in the record.
- `cost` is GraphQL's own `rateLimit.cost` when the answer carries it. Otherwise it is null: it is never estimated,
  and never replaced by REST `rate_limit`.
- The record never holds arguments, query text, bodies, headers beyond the limit ones, or credentials.

The ways to collect metrics are `BacklogSync`'s fourth argument (a sink) and `realGh(state, sink)`.

```bash
bun scripts/github-api-bench.ts --fixture              # the same fixtures every time, nothing reaches GitHub
bun scripts/github-api-bench.ts --sample [--task <n>]  # each current operation once, read-only, with the time measured
```

`--fixture` compares these scenarios per operation:

- the backlog imported once (the baseline, `single`)
- listed ten times from what is stored, after one import
- imported ten times at once
- imported ten times while a secondary limit is waited for
- lint
- the overlap check

The ten-times scenarios cost what one import costs: `calls == single`, with `shared: 9` for the imports at once
(the list asks nothing).
The limited scenario shows one failed GraphQL call and `waited: 10`. `scripts/github-api-bench.test.ts` holds these.

`--sample` runs these operations once against GitHub:

- the backlog imported into a database in memory: the first import (every Issue), then the next one (what changed)
- lint
- with `--task`, the overlap check without `--claimed`, which writes nothing

`--sample` does no load test and starts no runner. The overlap check reads with `gh -q`, so its calls carry no headers
and its `remaining` is null. Its calls go through `realGh` like lint's, so they are measured by the same code and
refused during the same wait.

## Past numbers are not current numbers

The table in #547 counts limit stops from 2026-09-22 to 09-29, taken from the daemon's events. It was measured before
#548 (one query for the backlog) and before #894. Use it as history, not as the current cost. Current numbers come
from `--sample`, compared at the time it prints.
