# Invariants — the lines no process candidate may cross

This list is the one place for the rules that hold whatever development process runs (`docs/design/process-kernel.md`, K6). Only the owner changes it; it carries no review dates, fires no counters and is never the subject of a process experiment. Everything else that guides work — minimal diffs, tests first, one Task one PR, review by another runner — is a *rule of care* that belongs to a process candidate or a skill, can be measured, and can be retired. If a sentence could be dropped without exposing a secret, a credential, someone's data, money or a permission boundary, it is a rule of care, not an invariant, and does not go here.

Each item has one line of what holds and one line of where it is enforced or stated today.

- **No provider keys, no runner credentials, no telemetry.** The app spawns the runners the owner logged into and holds nothing of theirs; it never serves other people through the owner's subscription.
  Source: README `## Design rules` ("No keys, no telemetry. Your own login, on your own machine.").
- **Nothing that can authenticate is written to an Issue, a PR, a comment or a public document.** Device codes, approval URLs, tokens, keys, account ids, link secrets, AWS profile and SSO session names are stopped before posting and scanned afterwards.
  Source: `ops-kit/bin/gh` (`docs/design/secret-guard.md`), `ops-kit scan-issues`, the root instructions file's section on values not to write.
- **No default that bypasses approval.** The permission mode is the owner's choice per task; a mode that skips approvals is marked as dangerous and is never the default. The runner's own approval stays untouched.
  Source: README `## Design rules` ("System ENABLES, Agent DECIDES, User APPROVES"), `docs/design/permission-modes.md`.
- **A change to a permission boundary, the gates, CI, dependencies or the host scripts is seen by the owner before it merges.** No recheck by another runner lifts it.
  Source: `scripts/merge-gate.ts` `SECURITY_KINDS` (`security:docs`, `security:words`, `security:lockfile`, `security:github`, `security:gates`, `security:host`) — the `[聞く]` reasons of `docs/merge-gate.md`.
- **Only the owner raises a cost ceiling or a usage threshold.** A task budget, a perf budget, the quota gate: an agent may propose, never set higher.
  Source: `.claude/skills/perf-loop/SKILL.md` (raising a ceiling is the owner's call), `docs/design/perf.md`, task `budgetUsd`.
- **Only the owner deletes the owner's data or publishes.** The database, knowledge, attachments and artifacts are not removed by an agent; the public mirror receives only adopted results, never the private experiment trail.
  Source: README `## Design rules` ("Text stays text"), the kit's `public-sync` (what leaves the private tree is listed in the repository's `ops.config.json`), the owner's answer of 2026-11-03 on what to publish.
- **The owner's data survives an update and its undo.** The schema only grows (no table or column of a released version is dropped or renamed), so an older release put back by a rollback still reads the database; the rollback itself stays reachable from the rescue page. Dropping this would lose data on the first rollback.
  Source: `docs/design/releases-and-rescue.md`, `packages/core/src/schema.test.ts`.
