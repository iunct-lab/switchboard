# device-auth (receiving the approval of an unattended run on screen)

When an unattended Task needs a cloud approval (an SSO device code or the like), its URL and code are shown on the Task's screen, and when the user approves in their own browser the Task goes on (decided 2026-10-08). The values are not left in Issues, PRs or stored records.

Reason: if the only way an unattended agent can tell the user something is an Issue, it will write the device code and the approval URL in an Issue comment ([secret-guard.md](secret-guard.md)). With only a rule not to write the values, a Task that needs approval stays stopped until the user resumes it in an interactive session.

This is a different route from the runner's own login (`packages/core/src/runnerlogin.ts`). There the daemon runs the runner's login command. Here the code is printed by a command the agent runs inside a Task.

## Route

```
agent ──(shell)──> device-auth -- <command>                  ops-kit/bin/device-auth (ops-kit/src/device-auth.ts)
                              │  extracts the URL and the code from the output. Masks them in the output returned to the agent
                              │  POST / DELETE  $DEVICE_AUTH_URL (key = the contents of $DEVICE_AUTH_TOKEN_FILE)
                              v
daemon     /api/tasks/:id/device-auth                        packages/core/src/deviceauth.ts (an in-memory Map and timers)
                              │  WS: { type: "task.deviceAuth", taskId, auth | null } (not an event)
                              v
screen     the card on the Task's screen                     apps/web/src/components/DeviceAuth.tsx
```

| Part | Where | Role |
|---|---|---|
| Helper command | `ops-kit/bin/device-auth [--expires-in <seconds>] -- <command...>` | Runs the command as a child process and reads the output line by line. When a URL and a code appear (the same rule as `runnerlogin.ts`: an `XXXX-XXXX(X)` outside a URL, or `user_code=` in a URL), it POSTs. Until the command ends, the values found are replaced in the output with `[画面に表示]`, and lines that `findSecrets` hits are masked too. When the command ends it DELETEs and returns its exit code; on expiry it stops the command, DELETEs and exits 124 |
| Destination | `startSession` in `packages/core/src/tasks.ts` | Adds `DEVICE_AUTH_URL=http://127.0.0.1:<port>/api/tasks/<id>/device-auth` and `DEVICE_AUTH_TOKEN_FILE=<the API key file>` to the runner's environment (`StartOptions.env`; the same channel as the `PATH` of the front of `gh`) |
| Container | `DeviceAuths` in `packages/core/src/deviceauth.ts` | One per Task. A non-`https:` URL, a code over 64 characters, or an expiry outside 1 to 900 seconds gets 400. It is removed on expiry, DELETE, or the Task's end (`onTaskEnd`), and `auth: null` is sent to the screen |
| API | `GET / POST / DELETE /api/tasks/:id/device-auth` | POST is accepted only for a Task whose runner is running (an ended Task gets 409). An error response does not include values from the body |
| Screen | `apps/web/src/components/DeviceAuth.tsx` | "`<ホスト> で承認してください`", the link to the approval page, the code and a copy button, the remaining time, and the command. It removes itself at `expiresAt`. It is fetched when a running / waiting Task is opened, and after a WS reconnect |

No approve button is placed. The user approves in their own browser, and Switchboard holds no cloud credentials ("No keys" in the README's Design rules).

## Logging in all at once

When several Tasks are stopped waiting for an SSO login, the user logs in just once from the card of the group on the awaiting-decision screen (the `SSO・配備のまとまり` section, which gathers SSO login waits and deploy refusals across Tasks and workspaces into one card per kind; `packages/core/src/approval-batch.ts`). "`ログインする`" sends the continuation only to the oldest Task, and the code of that Task's `device-auth` is also shown on the group's card with the same component as the Task's screen (`DeviceAuth.tsx`). Once that Task has moved on, only the continuation is sent to the remaining Tasks, and they are not made to log in again.

Premise: runners run as the same OS user and in the same environment as the daemon, so one Task's login stays in the host's SSO cache, and until its expiry the other Tasks use the same cache. The adapters pass the daemon's environment to the child as it is (`childEnv`, [`packages/adapters/claude/src/index.ts`](../../packages/adapters/claude/src/index.ts) and [`codex`](../../packages/adapters/codex/src/index.ts); only Claude Code's own marker variables are removed, and neither `HOME` nor `AWS_*` is changed), and all that is added to a Task's environment is `StartOptions.env` of `startSession` (`DEVICE_AUTH_URL` and the like). In a setup where the runner changes `HOME` or `AWS_*` per Task (a different user, a container), this premise does not hold, and the remaining Tasks stop again by themselves (they return to the group, so it can be pressed again). Switchboard holds no AWS credentials and does not log in on their behalf.

## Why the values do not remain

- **The agent does not see the values**: `device-auth` masks the command's output before returning it. There is no source for the values to enter the agent's conversation, the tool results (the events in the DB), or the text it writes to an Issue
- **Nothing goes into the DB**: the daemon keeps them in memory only. There is no table or migration. Disappearing on a restart is fine (the code expires in 10 to 15 minutes)
- **WS messages are not stored**: `task.deviceAuth` is not an event, so it does not enter `events` and is not carried on `task.updated`. The screen does not put it in `localStorage` or a Service Worker either
- **No new key is added**: no per-Task token is made. The runner can already read the API key file as the same user as the daemon, so only the file's location is passed

## Expiry

- The default is 600 seconds. `--expires-in` (1 to 900) only when the CLI shows a different expiry. The expiry is not read from the command's output (its form differs by CLI)
- The expiry counts from the start of the command, and the POST's `expiresInSec` is the remaining seconds (so the screen's remaining time and `device-auth`'s expiry agree)
- On expiry, interruption, or a failed hand-over, the command and the descendants it started (`pgrep -P`) are stopped
- If only a URL appears and the code does not come for 1 second, it is sent with the URL only (the flow where the page shows the code itself). If the code comes later, it is sent again with the code

## What it does not stop

- **When the command is run directly without `device-auth`**: the values enter the agent's output. If it then tries to write them to an Issue or PR, the front of `gh` stops it, and what was already written is found by `scan-issues` ([secret-guard.md](secret-guard.md)). The rule is in the shared skill `issue-workflow`, `Issue・PR・コメントに書かない値`
- **That a false URL can be shown on screen**: the URL is what the command the agent ran printed. The daemon accepts only `https:`, but it cannot choose where the URL leads. So the card uses the host name as its heading and also shows the original command. The user judges the approval by whether it is a login page they know
- **Whether the destination is loopback**: `device-auth` sends the code and the daemon's key (the contents of `DEVICE_AUTH_TOKEN_FILE`) to the destination of `DEVICE_AUTH_URL`. It does not check that the destination is loopback. The one who passes the value is the daemon (its own loopback address), and only a Task of the same OS user can rewrite it. That Task can also read the key file directly, so checking would protect nothing more (the trust in loopback in the `前提` section of CLAUDE.md). The same goes for the destination of sb-rescue (`SWITCHBOARD_RESCUE_URL`), which the daemon calls with the key at promotion, and sb-rescue passes it when it starts the daemon
- **When `DEVICE_AUTH_URL` is absent** (run outside Switchboard, or the daemon is old): `device-auth` exits 2 without running the command. The agent shows no values, asks in the Task's conversation, and stops

## How to check

`packages/core/src/deviceauth.e2e.test.ts`: a fake runner runs a fake login through `device-auth`, and the test checks that the values reach the screen (API and WS), that approval moves the Task on and only the exit code reaches `gh`, that expiry gives `auth: null` and exit 124, and that no value is in any table of the DB or in other WS messages. The unit tests are `deviceauth.test.ts` (daemon), `ops-kit/src/device-auth.test.ts` (helper command) and `apps/web/src/deviceAuth.test.ts` (screen).
