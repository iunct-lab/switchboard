# Self-managed GitLab CE: install, run beside GitHub, move, recover

An optional stage. GitHub stays the default; nothing here is needed to run Switchboard. This document lets the operator compare the ways to adopt a self-managed GitLab Community Edition (CE) and pick one. It is a procedure, not a running instance: writing it started no instance, bought nothing, logged in nowhere and changed no Git remote.

The kit's GitLab support (`docs/design/forge-integration.md`, "GitLab") was checked against a fake `glab` only. Check it on hosted gitlab.com first; a self-managed instance comes after that check and after a review of GitLab's current security advisories.

Sources are GitLab's own documentation, read on 2026-10-28. Version numbers in the quotes below are GitLab's examples, not a choice; re-read the linked pages before acting.

## Ask first

Each of these needs the operator's OK in the Task's conversation before an agent does it. Never write their answers' secret parts (tokens, passwords, device codes) into an Issue, a PR or this repository.

| Decision | Why it is the operator's |
|---|---|
| Starting an instance (a VM, a container on a new host) | It runs and costs money until stopped |
| Cost | Instance type, storage and hours are the operator's budget |
| Exposure (who can reach it) | A public instance is an attack surface that needs patching on GitLab's schedule |
| Authentication (an account, a token, `glab auth login`) | It hands an agent write access to the code |
| The move itself (remote change, import, `forge` change) | It changes where every Task pushes and reads |

## Pick a path

| Path | What changes | When to pick it |
|---|---|---|
| A. GitHub only (default) | Nothing | GitHub is enough |
| B. Side by side | A trial project on GitLab; the main repository stays on GitHub with `"forge": { "service": "github" }` | To learn GitLab's behaviour, or keep a second home ready |
| C. Staged move | After B, one repository's `forge` becomes `gitlab` and its `origin` points at GitLab | GitHub must stop being the single place the work depends on |

B costs an instance and a login but changes no existing repository. C is B plus the checklist under "Move" and keeps a way back ("Go back").

## Install

### Edition and license

- Use **CE**: the Docker image `gitlab/gitlab-ce` ([Docker install](https://docs.gitlab.com/install/docker/installation/)) or the Linux package `gitlab-ce` from `packages.gitlab.com` ([Linux package](https://docs.gitlab.com/install/package/)). Not `gitlab-ee`: its `ee/` code is under its own license.
- CE's source ([gitlab-foss LICENSE](https://gitlab.com/gitlab-org/gitlab-foss/-/blob/master/LICENSE)) is MIT Expat; its `doc/` directory is CC BY-SA 4.0.
- Switchboard bundles no part of GitLab: no image, package or `glab` is vendored, so this repository's Apache-2.0 license is unaffected. The kit only calls a `glab` the operator installed and logged in.

### Pin a version

- Docker tags are `gitlab/gitlab-ce:<major>.<minor>.<patch>-ce.0`. Use a full tag; `latest` is for testing only (Docker install page).
- Pick the newest patch of a maintained minor. GitLab ships a minor on the third Thursday of each month, patches twice a month, and backports security fixes to the current and the two previous minors ([maintenance policy](https://docs.gitlab.com/policy/maintenance/)). A minor older than that gets no security fix.
- Record the chosen tag in your own deploy notes, not here: it changes with every patch.

### Resources

From [installation requirements](https://docs.gitlab.com/install/requirements/):

| | Requirement |
|---|---|
| CPU | 8 vCPU baseline; burstable types not recommended. Arm is supported (the Linux package page lists known issues on Arm) |
| Memory | 16 GB baseline; at least 8 GB in a constrained single node; swap off where possible |
| Disk | 40 GB for the application, plus all repositories, plus 5–12 GB for PostgreSQL; SSD; no NFS / EFS |
| PostgreSQL | Bundled; its supported range depends on the GitLab major (the requirements page's table) |

The Switchboard host template's default instance (`aws/template.yaml`, `InstanceType`, 4 GB) is below the minimum. Do not put GitLab on the Switchboard host; give it its own host and ask about its cost first.

### Methods

| | Docker | Linux package |
|---|---|---|
| Install | `docker run` / Compose with the pinned tag, `--shm-size 256m` | `gitlab-ce` from `packages.gitlab.com` (Amazon Linux 2023 amd64 / arm64 from 16.3, Ubuntu, Debian, RHEL family) |
| Config | `GITLAB_OMNIBUS_CONFIG` or `$GITLAB_HOME/config/gitlab.rb` | `/etc/gitlab/gitlab.rb`, then `gitlab-ctl reconfigure` |
| Upgrade | Replace the container with a new tag on the same volumes | The package manager |

### Persistent data (Docker)

| Host | Container | Holds |
|---|---|---|
| `$GITLAB_HOME/config` | `/etc/gitlab` | `gitlab.rb`, `gitlab-secrets.json`, TLS files |
| `$GITLAB_HOME/logs` | `/var/log/gitlab` | Logs |
| `$GITLAB_HOME/data` | `/var/opt/gitlab` | Repositories, database, uploads, `backups/` |

GitLab's SSH listens on 22. Either move the host's own SSH to another port, or publish GitLab's on another one and set `gitlab_rails['gitlab_shell_ssh_port']` (clone URLs then carry the port).

### First start

- The initial `root` password is in `/etc/gitlab/initial_root_password`, which is deleted on the first restart after 24 hours (Docker install page). Change it and turn on two-factor authentication.
- New sign-ups are **on** by default: anyone who reaches the instance can create an account. Turn it off in Admin → Settings → General → New user account restrictions → "Allow new user accounts" ([sign-up restrictions](https://docs.gitlab.com/administration/settings/sign_up_restrictions/)).

### TLS and exposure

- Set `external_url "https://<host>"` ([TLS](https://docs.gitlab.com/omnibus/settings/ssl/)). Let's Encrypt is automatic, but needs ports 80 and 443 reachable from the public validation servers.
- A private instance (reached only over a VPN or a private network) cannot use that validation: set `letsencrypt['enable'] = false` and put the full chain in `/etc/gitlab/ssl/<host>.crt` and its key in `/etc/gitlab/ssl/<host>.key`.
- Prefer private. A public instance has to take each high or critical patch release as soon as it ships. Either way it is an "Ask first" decision.

## Authentication for Switchboard

The kit uses only the operator's `glab` login (`gitlabAuth` checks `glab auth status --hostname <host>`). It stores no GitLab credential.

- Log in on the host as the user Switchboard runs as: `glab auth login --hostname <host>`. `--web` uses OAuth in a browser; `--device` is for a headless host (GitLab 17.9 or later); `--stdin` reads a token from standard input ([glab auth login](https://gitlab.com/gitlab-org/cli/-/blob/main/docs/source/auth/login.md)). Never pass the token on the command line or paste it into a Task.
- Without an OS keyring, `glab` keeps the token in plain text in `~/.config/glab-cli/config.yml`. Every Task runs as the same OS user and can read it (the loopback trust model, `docs/design/workspace-mcp.md`). Give the account no more than the next two items.
- Token scope ([scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)): `api`, because the kit writes Issues, notes and merge requests through `glab api`. Pushing over HTTPS also needs `write_repository`; over SSH, a key instead. Tokens expire after at most 365 days by default ([personal access tokens](https://docs.gitlab.com/user/profile/personal_access_tokens/)), so plan the renewal.
- Role ([permissions](https://docs.gitlab.com/user/permissions/)): Developer pushes to unprotected branches, opens merge requests and writes notes; labels and milestones need Planner or above. `scripts/merge-gate.ts` counts marks only from notes by Developer or above. Merging into the protected default branch follows that branch's "Allowed to merge" (Maintainers by default).
- The kit refuses to send a text that holds a GitLab token (`findSecrets` knows the `glpat-` family).

## Back up and restore

From [backup](https://docs.gitlab.com/administration/backup_restore/backup_gitlab/), [Docker backup](https://docs.gitlab.com/install/docker/backup/) and [restore](https://docs.gitlab.com/administration/backup_restore/restore_gitlab/).

Back up:

```bash
docker exec -t <container> gitlab-backup create        # Linux package: sudo gitlab-backup create
```

- The archive goes to `/var/opt/gitlab/backups` (on the data volume). Copy it off the host.
- It does **not** hold the configuration. Copy these separately and keep them apart from the archive, since the secrets file decrypts the database's encrypted columns: `gitlab-secrets.json`, `gitlab.rb`, `/etc/gitlab/ssl`, `/etc/gitlab/trusted-certs` and the SSH host keys. Also left out: Redis (queued jobs), object storage, server and file hooks.

Restore:

- Only onto the **same version and edition** (CE) that made the backup, on a fresh install, with `gitlab-secrets.json` put back first (without it, two-factor users lose access and runners cannot sign in). The backup directory needs three times the archive's size free.

```bash
docker exec -it <container> gitlab-ctl stop puma
docker exec -it <container> gitlab-ctl stop sidekiq
docker exec -it <container> gitlab-ctl status                       # both down before going on
docker exec -it <container> gitlab-backup restore BACKUP=<backup-id> # file name without _gitlab_backup.tar
docker restart <container>
docker exec -it <container> gitlab-rake gitlab:check SANITIZE=true
```

- Rehearse a restore on a throwaway instance before relying on the backup.

What a GitLab restore means for Switchboard: Switchboard's own store is the record of the backlog, and GitLab is one place it syncs to. Items written to GitLab after the backup are gone from GitLab, and the import sees that only in part: every open Issue is read again, so its stored GitLab copy takes the restored, older values; an open Issue that no longer exists is marked unavailable; a closed Issue, or a comment on an Issue whose update time did not move, that vanished keeps its stored copy with no mark. Nothing is deleted from the store. Turn sync off for that workspace while restoring, compare afterwards, then turn it back on.

## Upgrade and roll back

From [before you upgrade](https://docs.gitlab.com/update/plan_your_upgrade/), [upgrade paths](https://docs.gitlab.com/update/upgrade_paths/), [background migrations](https://docs.gitlab.com/update/background_migrations/) and [roll back](https://docs.gitlab.com/update/package/downgrade/).

1. Find the path from your version to the target, including every required upgrade stop. A jump may take several upgrades.
2. Back up (the archive and the configuration, above). Before a Docker upgrade a database-only backup is enough for rolling back: `gitlab-backup create SKIP=artifacts,repositories,registry,uploads,builds,pages,lfs,packages,terraform_state`.
3. Docker: stop and remove the container, start the next pinned tag on the same three volumes. Linux package: install that version of `gitlab-ce`.
4. Wait until all background migrations finish before the next stop.

To roll back: start the earlier tag again and restore the database backup taken before the upgrade, made by that same version, with the same `SKIP=…`. This overwrites everything written since; use it only when the new version does not work.

## Side by side and moving

### What maps and what does not

The kit's side: `docs/design/forge-integration.md` (the GitLab section's table of differences from GitHub). The repository's side:

| | GitHub (now) | GitLab | What happens on a move |
|---|---|---|---|
| Git remote | `origin` on GitHub | `origin` on GitLab | Change the URL; keep GitHub as a second remote for the way back |
| `ops.config.json` `forge` | `{ "service": "github" }` | `{ "service": "gitlab", "host": "<host>", "project": "<group/name>" }` | One PR. The kit sends nothing when `origin` does not match it |
| Pull requests | PRs, stacked with `gh stack` | Merge requests (`ops-kit mr`); no stack merge, so `merge-gate --merge-stack` stops | Open PRs are imported but not synced afterwards: merge or close them first |
| Reviews | Review threads, approvals | Discussions and notes; Approvals is a paid feature and is not used | Approval state is not carried |
| Issues | Issues, sub-issues, close reasons | Issues; no sub-issues; one close state | Parents come from the body's `## 親 PBI` section. "Not planned" reads as completed |
| Project fields (Status, Priority, Story Points) | Project v2 | None | Values stay in Switchboard's store; GitLab gets labels only |
| CI | `.github/workflows/*` (`ci.yml`, `release-tag.yml`, `secret-scan.yml`, `labels.yml`, `project-autoadd.yml`, `host.yml`) | GitLab CI reads none of them | `scripts/local-ci.ts` already runs a merge request and reports in a note. Tags, Releases, the weekly secret scan and the host deploy have no GitLab path yet |
| AWS host | `aws/host/bootstrap.sh` clones from `github.com` with `/switchboard/github-token` | — | A rebuilt host still needs GitHub |
| Public mirror | `ops-kit public-sync` pushes to a GitHub repository | — | Stays on GitHub |

### What GitHub's importer brings and what it leaves

GitLab's [GitHub importer](https://docs.gitlab.com/user/project/import/github/) is available on self-managed Free once an administrator enables the GitHub import source. It needs a classic GitHub token with `repo` and the Maintainer or Owner role in the target group. Ask before creating either.

- Brings: Issues, labels, milestones, wiki; PRs as merge requests with reviews, review comments and suggestions; comments; branches; branch protection; direct collaborators; LFS; release notes; attachments (Markdown attachments only when selected).
- Leaves: GitHub Projects and their fields, sub-issue links, Actions and their run history, approval state when a reviewer has no GitLab user, the "require status checks" rule, outside collaborators, organizations. PRs are not synced after the import.
- Authors arrive as placeholder users (post-migration mapping, the default for GitHub imports on self-managed since 17.8): one per source user, unable to sign in, holding the contributions until a top-level group Owner reassigns them under Manage → Members → Placeholders and the target user accepts ([post-migration mapping](https://docs.gitlab.com/user/import/mapping/post_migration_mapping/)). Leaving some on placeholders is allowed.
- The merge gate counts marks by the note author's role, and a placeholder holds none, so imported marks do not stand for a fresh check: re-run the gate on GitLab before merging anything.

### Before moving (writes only to a throwaway project)

Nothing here touches the main repository, its remotes or GitHub. The only writes are to the trial project in path B.

- [ ] The kit's GitLab path passed on hosted gitlab.com
- [ ] The "Ask first" table is answered: instance, cost, exposure, authentication
- [ ] Inventory, read only: `git remote -v`, `jq .forge ops.config.json`, `ls .github/workflows`, the open PRs (`gh pr list`), the host's GitHub dependencies (above)
- [ ] The instance is installed, pinned, signed-up off, on TLS, with a rehearsed restore
- [ ] Path B on a throwaway project: create an Issue, a merge request, an inline note, resolve it, `bun scripts/local-ci.ts <iid>`, `bun scripts/merge-gate.ts <iid>` (judge only, no `--merge`)
- [ ] Each "Leaves" item above has an owner: carried by Switchboard's store, done by hand, or accepted as lost
- [ ] Decide: stay on B, or move (C)

### Move (each step after the operator's OK)

1. Freeze: no open PRs, no Task pushing, the backlog sweep paused.
2. Import the repository with GitHub's importer. When only the code moves, push from a separate mirror clone to the GitLab URL named explicitly, never from the working checkout (a mirror push to the wrong remote deletes the refs it lacks): `git clone --mirror <GitHub URL> <dir>`, then `git -C <dir> push --mirror <GitLab URL>`.
3. In the working checkout, keep GitHub as `github` and point `origin` at GitLab: `git remote rename origin github`, `git remote add origin <GitLab URL>`.
4. Change `forge` in `ops.config.json` in one merge request.
5. Check: the workspace imports from GitLab, a test merge request goes through local CI and the merge gate, `git remote -v` shows both.

### Go back

1. Set `forge` back to `{ "service": "github" }` and swap the remotes back (`git remote rename origin gitlab`, `git remote rename github origin`). The kit then reads GitHub again and keeps the GitLab records it already stored.
2. Push the branches and tags made on GitLab to GitHub by name (`git push origin <branch>`, `git push origin <tag>`).
3. List everything that changed on GitLab after the move, since none of it is copied to GitHub: Issues and merge requests created there (stored under GitLab's numbers), and edits, comments and closures on the Issues imported from GitHub (GitHub still shows the copy from before the move). Carry over by hand what is still open or still matters. Merged merge requests reach GitHub only as commits.
