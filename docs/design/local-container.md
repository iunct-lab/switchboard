# Running Switchboard as a container on your own machine

One image runs the stand-alone mode: a single Switchboard daemon under `sb-rescue`, with the same tools, versions and paths as the EC2 setup, on a Linux machine with Docker. As there, the daemon runs from an immutable release, takes new versions by itself and can be rolled back from the rescue page (`docs/design/releases-and-rescue.md`). The supported CPUs are arm64 and x86-64: the same Dockerfile and the same procedure on both. The machine needs only that, Docker on Linux with `docker compose` 2.24 or later (the optional `env_file` of section 7 needs it; the container uses the machine's network, `network_mode: host`, which Docker has on Linux only). There is no per-operating-system procedure, service unit or script; if something differs between machines, the difference belongs to the engine and not to this repository.

Files: `container/Dockerfile` (the image), `container/compose.yaml` (the one service and its volumes), `container/entrypoint.sh` (start-up), `container/up.sh` (the start), `container/e2e.sh` and `container/e2e-release.sh` (the checks with a fake runner).

## 1. Start

The image holds the tools; the version of Switchboard that runs is not in the image but in the `sb-home` volume (`~/.switchboard/releases`), built there by `sb-rescue`. Where its releases come from is the one choice, and it is sb-rescue's own (`rescue/src/main.ts`), not a setting of the container: a clone named by `SWITCHBOARD_REPO_ROOT`, or without one the public repository's Releases.

### To use it (no git needed)

Two commands on a machine where `docker compose` works, with `curl` and `tar`:

```bash
# 1. Fetch and unpack the source tarball of any Release (the container fetches the newest one itself)
mkdir switchboard-src && curl -fsSL https://github.com/iunct-lab/switchboard/archive/refs/tags/<tag>.tar.gz | tar -xz -C switchboard-src --strip-components=1
# 2. Build the image and start the container
cd switchboard-src && bash container/up.sh
```

This builds the image `sb-local` (arm64 or x86-64) and starts the container in the background with `restart: unless-stopped`. On its first start the container downloads the newest Release of the public repository (the one `publicSync.target` in the tree's `ops.config.json` names), checks the tarball as the install without git does, builds it under `~/.switchboard/releases` (`bun install --frozen-lockfile` and the web build) and starts it under sb-rescue. That takes a few minutes after the image is built; then open `http://127.0.0.1:47831/`; the rescue page is `http://127.0.0.1:47841/` (section 4). No `.git` is made anywhere.

`up.sh` stops, and says so, when `127.0.0.1:47831` or `127.0.0.1:47841` is already in use on the machine (another Switchboard is running there: stop it first). It skips that check when this stack's own container is running, so running it again rebuilds and recreates that container.

The first start needs GitHub: if it cannot be reached, no release can be built, the container stops with that reason (`docker compose -f container/compose.yaml logs`) and the restart policy tries again until it works. Later starts do not need it: they run the release already in the volume.

Later versions arrive by themselves, as for an install from a Release: the daemon looks for a newer Release every few minutes (`設定` → `動いている版`), a model reads its diff first, and a version with no concern goes up while no Task runs; one with a concern, or one that could not be checked, waits for your button. The tree you unpacked is only what the image was built from; running `up.sh` from another tree (a clone of the development repository included) starts the same way and runs the public Release, not that tree's code. To try a tree's own code, use `bun run dev` or `container/e2e.sh`.

### To develop Switchboard (releases from your clone's tags)

Put a clone in the `sb-repos` volume and name it with `SWITCHBOARD_REPO_ROOT` (its path inside the container). sb-rescue then builds the clone's `HEAD` as the first release and follows the clone's `origin` tags, with no review of the diff, as the EC2 setup does. Two commands, from the tree you build the image from, for a volume that has no release yet:

```bash
# 1. Log in to GitHub and clone into the volume (the login is not kept; log in again on the screen afterwards)
docker compose -f container/compose.yaml run --rm --entrypoint bash switchboard -c 'gh auth login && gh repo clone <owner>/<name> ~/repos/<name>'
# 2. Start with the clone as the source of releases
SWITCHBOARD_REPO_ROOT=/home/switchboard/repos/<name> bash container/up.sh
```

Pass the variable on every `up.sh`. The two sources are not mixed in one `sb-home`: a start without the variable, on a volume whose releases were built from a clone, stops and says so, and nothing is replaced.

No AWS setting is needed or read in either case. The daemon starts as a stand-alone instance: no starter, no EC2 instance, no automatic stop.

## 2. Log in and bring your repositories

Nothing is logged in inside a new container, and Switchboard holds no credentials of its own. Every login is done on the screen; the daemon runs the tool's own login command and shows the page to open and the one-time code:

- Claude and Codex: the login warning on Home and its login button (`claude auth login`, `codex login --device-auth`; the browser login's callback to localhost cannot reach a process in the container, so Codex uses the device login)
- GitHub: `Log in to GitHub` above the Workspace's add form on the Settings screen (and on the Backlog screen when a backlog cannot be read for want of it). It runs `gh auth login --web`; approve the code on `github.com/login/device`. Afterwards git's https fetch and push use the same login, and if git has no commit name and email yet, they are set from the GitHub account (its noreply address)

Then add repositories on the Settings screen with `From GitHub`: they are cloned into `~/repos` (that is `/home/switchboard/repos`) and registered as Workspaces. The development clone of Switchboard itself is yours to add too; nothing is cloned for you.

## 3. What is kept and what is not

Four named volumes are mounted, and they are the only state that survives recreating the container:

| Volume | Mounted at | Holds |
|---|---|---|
| `sb-home` | `~/.switchboard` | the database (Tasks, ledger, backlog), settings, attachments; the built releases (`releases/`, with `current` naming the one that runs), their history, and where they come from (`update-source.json`) |
| `sb-claude` | `~/.claude` | Claude Code's login and the session files that `--resume` reads |
| `sb-codex` | `~/.codex` | Codex's login and sessions |
| `sb-repos` | `~/repos` | the repositories and their worktrees |

Compose prefixes the volume names with the project name, which `container/compose.yaml` fixes as `switchboard` (so `switchboard_sb-home` and so on; `docker volume ls` shows them).

The running version is therefore the volume's: after `up.sh` is run again, after a rebuilt image, or after `docker compose down` followed by `up`, the container starts the release `current` names, with its history, and does not go back to the code the image was built from. A start only bundles sb-rescue again from the image (`~/.switchboard/rescue/sb-rescue.js`), so a change to sb-rescue itself arrives with a rebuilt image, not with a release.

Everything else in the container's HOME is part of the container and is gone after it is recreated (for example after `up.sh` rebuilds the image with new tools, or after `docker compose down` followed by `up`). That includes `~/.config/gh` (your GitHub login), `~/.gitconfig`, and `~/.claude.json` (Claude Code's first-run setup and folder trust). After a recreate, log in and set these again (section 2). Only `docker compose stop` / `start` and a restart of the engine keep the container itself.

A container made before this (it ran the code in the image directly, with no sb-rescue) is moved by starting it again from a current tree with the steps of section 1: the image is rebuilt, the container recreated, and the first release built into `sb-home` beside the database, which is used as it is (the new version migrates it, taking a snapshot first). Nothing moves by itself; until then the old container keeps running the old image.

To remove the data on purpose:

```bash
docker compose -f container/compose.yaml down        # remove the container, keep the volumes
docker compose -f container/compose.yaml down -v     # also delete the four volumes: Tasks, logins, repositories, releases
```

`down -v` is not undoable.

## 4. What can reach the screen and the API

The container shares the machine's network (`network_mode: host` in `container/compose.yaml`; it publishes no ports). The daemon (`127.0.0.1:47831`) and sb-rescue (`127.0.0.1:47841`) listen on the machine's own loopback only, as on the EC2 host, so they are reachable from processes on the machine and not from another computer on the network. A container on the docker bridge cannot reach either port, since they are not on the bridge's address. `container/compose.test.ts` fails if the compose file publishes a port or if a forwarder or a listen address is set again.

The daemon and sb-rescue trust only loopback connections (no login on loopback; `docs/design/workspace-mcp.md`, "Local API token"). That is why there is no forwarding process in front of them: a process listening on the container's own address and passing connections on to loopback would make every peer on the docker bridge (a container a Task starts included) the owner of the daemon and of sb-rescue. With the host network nothing is published, nothing forwards, and the rescue page is the same one as on the EC2 host.

The rescue page is `http://127.0.0.1:47841/` in the machine's browser, as on the EC2 host, and the screen links to it from the same places. When the daemon does not answer, open it to see the state, roll back to the previous release or restart the daemon, with no command to type. It trusts loopback callers, so any process on the machine (a Task's shell included) may use it, as with the daemon's own API.

## 5. The Docker socket

`compose.yaml` mounts the machine's `/var/run/docker.sock` into the container, and `up.sh` adds the socket's group (`DOCKER_GID`) to the container user, so that `docker` and `docker compose` work in a Task's shell. This is the machine's Docker daemon, not one inside the container.

The meaning: a Task can start, stop and delete any container, image and volume on the machine, and can mount any path the engine can reach, which is root-equivalent on the machine's engine. That includes the Switchboard container's own volumes. Switchboard's permission modes decide whether the runner asks first; they do not limit the socket. If you do not want a Task to have this, remove the socket line from `compose.yaml`; the rest keeps working and only `docker` in Tasks is out of reach. If `up.sh` cannot read the socket's group it uses 0, with the same effect.

## 6. Versions are kept in two places

The EC2 setup installs its tools with `aws/host/devtools.sh` and `aws/host/node.sh`; the image installs the same ones in `container/Dockerfile`. Pins for node, docker, compose, uv and gitleaks (version and sha256) and for gh-stack (version) are written in both. `container/versions.test.ts` compares them and fails when one side is changed alone, so change both together. The EC2 instance is arm64, so the sha256 compared are the arm64 ones; the x86-64 sha256 (the `_X86_64` lines, same versions) are in the Dockerfile only and have nothing in the EC2 setup to be compared with. `gh`, `bun`, `claude` and `codex` are pinned in the Dockerfile only (the EC2 setup takes the distribution's `gh` and the latest of the others); bumping them is a change to the `ARG` lines and a rebuild. HOME is `/home/switchboard` and the repositories are in `/home/switchboard/repos`, as in the EC2 setup, so a Task's `cwd` and the `~/.claude/projects` folder names read the same on both.

## 7. What it does not do

- The stand-alone mode by default. To run the container as a work machine of another instance (the cloud one keeps the record and the only write path to the backlog's service), copy `container/work-machine.env.example` to `container/work-machine.env` and fill in the values; `compose.yaml` reads that file when it exists, and Git does not track it. It holds the variables of [work-machine.md](work-machine.md) section 1 (`SWITCHBOARD_UPLINK=send`, `SWITCHBOARD_UPLINK_PREVIEW`, `SWITCHBOARD_MACHINE`, `SWITCHBOARD_UPLINK_BUCKET`) and the AWS credentials of the `aws` CLI (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_DEFAULT_REGION`), limited as that section says. The credentials are not in the image or in a volume, but the daemon and the Tasks run by the same container user can read them, so use the key that section describes, which writes only under its own machine's prefixes and, with a condition, the leases. Without the file the container starts alone, as before. The daemon's settings reach it through sb-rescue, which passes its environment on. That mode is closed in this version: `SWITCHBOARD_UPLINK=send` without `SWITCHBOARD_UPLINK_PREVIEW=not-for-use` starts nothing (the daemon does not start), and with it the daemon does start as a work machine, so set that value only for the checks of that document's section 8 ("Before deployment"). A work machine asks the bucket through the `aws` CLI, which the image installs in its base stage (`awscli-2`, the distribution's package, as the EC2 setup takes it), so the stand-alone image and the CI stage both have it.
- No service unit or auto-start of the engine itself. `restart: unless-stopped` brings the container back whenever the engine runs.
- The tools (the `ARG` versions) and sb-rescue's own bundle are not updated inside the container; update by changing a version, or taking a newer tree, and running `bash container/up.sh` again (which recreates the container; mind section 3). Only Switchboard's version updates itself, through the releases.
- No setting chooses the role. It follows from `SWITCHBOARD_REPO_ROOT` being passed or not (section 1), as everywhere sb-rescue runs.
- No built image is published; the image is built on your machine from the tree. The image's `/opt/switchboard` is the tree it was built from as it stands, so an image handed to another person is built from the public tree (the unpacked Release), not from a development checkout. `.dockerignore` keeps what Git does not track out of the build context, but it does not apply the public sync's exclusions.

## 8. Check it with a fake runner

`container/e2e.sh` builds the image, starts a fake daemon from the image's tree in place of the entrypoint, runs a Task with a fake runner to its end, recreates the container, and checks that the same Task id is listed and the session file is still there. It runs no real runner and needs no login:

```bash
bash container/e2e.sh
```

`container/e2e-release.sh` checks the start of section 1 in both roles, with the real entrypoint, sb-rescue and core, a fake runner, and a fake Releases API (`container/fake-releases.ts`) in place of GitHub:

```bash
bash container/e2e-release.sh
```

To use: the first release is built into the volume with no `.git`, the daemon answers on the machine's `127.0.0.1:47831` and the rescue page on `127.0.0.1:47841` (status 200), and neither port is reachable from a container on the docker bridge, a second release whose review says `concern` is not promoted, a third whose review says `ok` is, and that version still runs after `down` / `up` and after a rebuilt image. To develop: a clone in the volume is built at its `HEAD`, a new tag is promoted with no review, and it still runs after a recreate. It makes its releases from `HEAD` of the clone it is run in, so it needs git on the machine, and it takes a while: the daemon keeps what it learned about the newest Release for ten minutes.

They use compose's project names `sb-e2e`, `sb-e2e-release` and `sb-e2e-clone`, so their volumes (`sb-e2e_sb-home` and so on) are separate from your own, and their `down -v` at the end cannot touch them. They refuse to start when `127.0.0.1:47831` or `127.0.0.1:47841` is already in use, so stop a real start first (`docker compose -f container/compose.yaml stop`). The image and the release builds are heavy, so neither is in CI; run them by hand, through `sb-offload` if you have it.

The same install outside a container, against a real Release: `bun scripts/release-smoke.ts <owner/name>` unpacks the newest Release into a temporary HOME, installs it with a PATH that has no git, starts it under sb-rescue on two free ports and checks `/api/health` and the rescue page, then removes everything; its last line is `[release-smoke] pass|fail <tag> <sha>`. The scheduled public sync runs it after a sync that ended 0 (with `--record <tag>`, which also writes the line into the Release of the source repository's tag it was synced from, and on a fail opens an issue there); run it by hand the same way to check a Release.
