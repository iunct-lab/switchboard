# Running Switchboard as a container on your own machine

One image runs the stand-alone mode: a single Switchboard daemon with the same tools, versions and paths as the cloud host, on any machine where containers run. The machine needs only that, a container engine with `docker compose`. There is no per-operating-system procedure, service unit or script; if something differs between machines, the difference belongs to the engine and not to this repository.

Files: `container/Dockerfile` (the image), `container/compose.yaml` (the one service and its volumes), `container/entrypoint.sh` and `container/relay.ts` (start-up and the relay below), `container/up.sh` (the start), `container/e2e.sh` (the check with a fake runner).

## 1. Start

From a clone of this repository, on a machine where `docker compose` works:

```bash
bash container/up.sh
```

This builds the image `sb-local` (arm64 only, see section 7) and starts the container in the background with `restart: unless-stopped`. Open `http://127.0.0.1:47831/`. The first build downloads the tools and builds the web UI, so it takes a while; later starts reuse the layers.

No AWS setting is needed or read. The daemon starts as a stand-alone instance: no starter, no cloud host, no automatic stop.

## 2. Log in and bring your repositories

Nothing is logged in inside a new container, and Switchboard holds no credentials of its own. Open the Terminal tab of any Task (or run `docker compose -f container/compose.yaml exec switchboard bash`) and log in once, as you would on any machine:

- `claude auth login` (it prints a URL; open it on the machine's browser and paste the code back)
- `codex login --device-auth` (a URL and a one-time code; the browser login's callback to localhost cannot reach the container, as only port 47831 is published)
- `gh auth login` if your Tasks use `gh` (choose the browser login: it shows a one-time code)
- `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"` for commits

The login warning on Home and its login button run the same `claude` / `codex` commands, so they work here too.

Clone repositories into `~/repos` (that is `/home/switchboard/repos`) and register them as Workspaces on the Settings screen. The development clone of Switchboard itself is yours to put there too; nothing is cloned for you.

## 3. What is kept and what is not

Four named volumes are mounted, and they are the only state that survives recreating the container:

| Volume | Mounted at | Holds |
|---|---|---|
| `sb-home` | `~/.switchboard` | the database (Tasks, ledger, backlog), settings, attachments |
| `sb-claude` | `~/.claude` | Claude Code's login and the session files that `--resume` reads |
| `sb-codex` | `~/.codex` | Codex's login and sessions |
| `sb-repos` | `~/repos` | the repositories and their worktrees |

Compose prefixes the volume names with the project name, which `container/compose.yaml` fixes as `switchboard` (so `switchboard_sb-home` and so on; `docker volume ls` shows them).

Everything else in the container's HOME is part of the container and is gone after it is recreated (for example after `up.sh` rebuilds the image with a new version, or after `docker compose down` followed by `up`). That includes `~/.config/gh` (your `gh auth login`), `~/.gitconfig`, and `~/.claude.json` (Claude Code's first-run setup and folder trust). After a recreate, log in and set these again (section 2). Only `docker compose stop` / `start` and a restart of the engine keep the container itself.

To remove the data on purpose:

```bash
docker compose -f container/compose.yaml down        # remove the container, keep the volumes
docker compose -f container/compose.yaml down -v     # also delete the four volumes: Tasks, logins, repositories
```

`down -v` is not undoable.

## 4. What can reach the screen and the API

The container publishes `127.0.0.1:47831` of the machine, nothing else. The screen and the API are therefore reachable from processes on the machine itself, and not from another computer on the network. The port is not published on the machine's other addresses.

The daemon trusts only loopback connections (it has no login on loopback; `docs/design/workspace-mcp.md`, "Local API token"). A published port arrives from the bridge's address, not from loopback, so the daemon listens on `127.0.0.1:47832` inside the container and a small relay (`container/relay.ts`) listens on `0.0.0.0:47831` and passes the bytes through. To the daemon every connection comes from its own loopback.

The relay has to listen on all addresses of the container to receive the published port. On a Linux machine this means a process on the machine can also reach the container's own address (the bridge network) on port 47831. That is the same set of callers who can reach the machine's `127.0.0.1:47831` anyway: processes running on the same machine. It is not a wider exposure to the network, and, as before, a person on the same machine as the daemon is the daemon's owner. Do not change the published address in `compose.yaml` to anything but `127.0.0.1`.

## 5. The Docker socket

`compose.yaml` mounts the machine's `/var/run/docker.sock` into the container, and `up.sh` adds the socket's group (`DOCKER_GID`) to the container user, so that `docker` and `docker compose` work in a Task's shell. This is the machine's Docker daemon, not one inside the container.

The meaning: a Task can start, stop and delete any container, image and volume on the machine, and can mount any path the engine can reach, which is root-equivalent on the machine's engine. That includes the Switchboard container's own volumes. Switchboard's permission modes decide whether the runner asks first; they do not limit the socket. If you do not want a Task to have this, remove the socket line from `compose.yaml`; the rest keeps working and only `docker` in Tasks is out of reach. If `up.sh` cannot read the socket's group it uses 0, with the same effect.

## 6. Versions are kept in two places

The cloud host installs its tools with `aws/host/devtools.sh` and `aws/host/node.sh`; the image installs the same ones in `container/Dockerfile`. Pins for node, docker, compose, uv and gitleaks (version and sha256) and for gh-stack (version) are written in both. `container/versions.test.ts` compares them and fails when one side is changed alone, so change both together. `gh`, `bun`, `claude` and `codex` are pinned in the Dockerfile only (the host takes the distribution's `gh` and the latest of the others); bumping them is a change to the `ARG` lines and a rebuild. HOME is `/home/switchboard` and the repositories are in `/home/switchboard/repos`, as on the host, so a Task's `cwd` and the `~/.claude/projects` folder names read the same on both.

## 7. What it does not do

- Only the stand-alone mode. The mode where a machine is a work site of another instance (the cloud one keeps the record and the GitHub write path) is not here.
- arm64 only. There is no x86 image; the Dockerfile downloads arm64 builds of every tool, and the version test refuses an x86 name.
- No service unit or auto-start of the engine itself. `restart: unless-stopped` brings the container back whenever the engine runs.
- The tools are not updated inside the container; update by changing a version and running `bash container/up.sh` again (which recreates the container; mind section 3).

## 8. Check it with a fake runner

`container/e2e.sh` builds the image, runs a Task with a fake runner to its end, recreates the container, and checks that the same Task id is listed and the session file is still there. It runs no real runner and needs no login:

```bash
bash container/e2e.sh
```

It uses compose's project name `sb-e2e`, so its volumes (`sb-e2e_sb-home` and so on) are separate from your own, and its `down -v` at the end cannot touch them. It refuses to start when `127.0.0.1:47831` is already in use, so stop a real start first (`docker compose -f container/compose.yaml stop`). The image build is heavy, so it is not in CI; run it by hand, on an offload host if you have one.
