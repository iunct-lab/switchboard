#!/usr/bin/env bash
# devtools (#371) — what a runner on the host needs to develop as on the Mac: Stacked PRs (gh-stack), the E2E scripts'
# headless Chrome, a Python project's tests (uv and Python 3.11+, docker, gitleaks), an AWS SAM template's lint, sqlite3 for the skills.
# Run by bootstrap.sh as root after gh is logged in, with the same SB_HOST_USER / SB_HOST_HOME / SB_REPOS_DIR; running it
# again skips what is there. Last it applies the owner's Claude settings patch, read first from private/ of the development
# clone under SB_REPOS_DIR (unset: the clone "switchboard" under /), else from private/ of this clone. The user gets no
# root: docker is rootless (rootlesskit + pasta), started on demand by the docker wrapper.
set -euo pipefail
: "${SB_HOST_USER:?}" "${SB_HOST_HOME:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
as_user() { sudo -u "$SB_HOST_USER" -H env HOME="$SB_HOST_HOME" PATH="$SB_HOST_HOME/.local/bin:$SB_HOST_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }

# pinned from the downloads (2026-09-27); Docker publishes no checksums for its static tarballs, the others do
DOCKER_VERSION=29.8.1
DOCKER_SHA256=667395fbffab52901b80181dfbb39ea76da2fbd7642c4fbddd24e42146b07b48
DOCKER_ROOTLESS_SHA256=3890bed82dc432e9fed7e52efcc18bb82647cd7beae45b03e9e2a2f6c3282c66
COMPOSE_VERSION=5.5.1
COMPOSE_SHA256=732e3a84c1a0f67256ce80bc2598a24546b10ca05f9faa97efceb1171ece2ef7
UV_VERSION=0.12.19
UV_SHA256=0804e9b164c64b6914182d5920c08551958a095986f10a3731056df701126436
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
SAM_VERSION=1.166.2
SAM_SHA256=3fd8eba05754538767c6e664496998721f22028343401f0b94314e44d215b55a
PLAYWRIGHT_VERSION=1.63.0
PLAYWRIGHT_MCP_VERSION=0.0.82
GH_STACK_VERSION=v0.1.1
DOCKER_BIN=/usr/local/lib/docker-rootless/bin

# --- from the distribution (signed): sqlite3, pasta and iptables for rootless docker, Chromium's libraries, CJK fonts ---
dnf install -y -q sqlite passt iptables-nft fontconfig google-noto-sans-cjk-ttc-fonts \
  nss atk at-spi2-atk cups-libs libdrm libxkbcommon libXcomposite libXdamage libXrandr mesa-libgbm pango alsa-lib

# fetch <url> <sha256> <file>: download and refuse anything whose checksum differs
fetch() { curl -fsSL -o "$3" "$1" && echo "$2  $3" | sha256sum -c --quiet -; }
DL="$(mktemp -d)"; trap 'rm -rf "$DL"' EXIT
# docker unpacks into <dir>.new and is renamed into place last: the directory exists only when complete, so a
# run stopped halfway is redone next time instead of being taken for done
[ -d "$DOCKER_BIN" ] || {
  fetch "https://download.docker.com/linux/static/stable/aarch64/docker-$DOCKER_VERSION.tgz" "$DOCKER_SHA256" "$DL/docker.tgz"
  fetch "https://download.docker.com/linux/static/stable/aarch64/docker-rootless-extras-$DOCKER_VERSION.tgz" "$DOCKER_ROOTLESS_SHA256" "$DL/rootless.tgz"
  rm -rf "$DOCKER_BIN.new" && mkdir -p "$DOCKER_BIN.new"
  tar --no-same-owner -xzf "$DL/docker.tgz" -C "$DOCKER_BIN.new" --strip-components=1
  tar --no-same-owner -xzf "$DL/rootless.tgz" -C "$DOCKER_BIN.new" --strip-components=1
  mv "$DOCKER_BIN.new" "$DOCKER_BIN"
}
[ -x /usr/local/lib/docker/cli-plugins/docker-compose ] || {
  fetch "https://github.com/docker/compose/releases/download/v$COMPOSE_VERSION/docker-compose-linux-aarch64" "$COMPOSE_SHA256" "$DL/compose"
  install -D -m 755 "$DL/compose" /usr/local/lib/docker/cli-plugins/docker-compose
}
[ -x /usr/local/bin/uv ] && [ -x /usr/local/bin/uvx ] || {
  fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-aarch64-unknown-linux-gnu.tar.gz" "$UV_SHA256" "$DL/uv.tar.gz"
  tar --no-same-owner -xzf "$DL/uv.tar.gz" -C /usr/local/bin --strip-components=1 uv-aarch64-unknown-linux-gnu/uv uv-aarch64-unknown-linux-gnu/uvx
}
# node is pinned in node.sh, which sb-host-update also runs on every start: a new pin replaces the one in place
bash "$HERE/node.sh"
[ -x /usr/local/bin/gitleaks ] || {
  fetch "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION}_linux_arm64.tar.gz" "$GITLEAKS_SHA256" "$DL/gitleaks.tar.gz"
  tar --no-same-owner -xzf "$DL/gitleaks.tar.gz" -C /usr/local/bin gitleaks
}
[ -x /usr/local/bin/sam ] || {
  fetch "https://github.com/aws/aws-sam-cli/releases/download/v$SAM_VERSION/aws-sam-cli-linux-arm64.zip" "$SAM_SHA256" "$DL/sam.zip"
  unzip -q "$DL/sam.zip" -d "$DL/sam"
  "$DL/sam/install" --install-dir /usr/local/aws-sam-cli --bin-dir /usr/local/bin --update
}
install -m 755 "$HERE/chromium.sh" /usr/local/bin/chromium
install -m 755 "$HERE/docker.sh" /usr/local/bin/docker
install -m 755 "$HERE/dockerd-up.sh" /usr/local/bin/dockerd-up

# --- as the host user ---
as_user uv python install 3.11 3.12 3.14
as_user npx -y "playwright@$PLAYWRIGHT_VERSION" install chromium
as_user gh extension list | grep -q 'gh-stack' || as_user gh extension install github/gh-stack --pin "$GH_STACK_VERSION"
# commits as the token's owner, with the GitHub noreply address (a new machine has no identity and git refuses to commit)
as_user git config --global user.name >/dev/null || {
  as_user git config --global user.name "$(as_user gh api user --jq .login)"
  as_user git config --global user.email "$(as_user gh api user --jq '"\(.id)+\(.login)@users.noreply.github.com"')"
}
# the daemon's unit is the parent cgroup and there is no systemd user session, so the rootless dockerd manages cgroupfs
as_user mkdir -p "$SB_HOST_HOME/.config/docker"
[ -f "$SB_HOST_HOME/.config/docker/daemon.json" ] || as_user sh -c "echo '{ \"exec-opts\": [\"native.cgroupdriver=cgroupfs\"] }' > '$SB_HOST_HOME/.config/docker/daemon.json'"
# a browser for Claude (the Mac has claude-in-chrome; here Playwright's MCP drives the same Chromium headless)
as_user claude mcp get playwright >/dev/null 2>&1 || as_user claude mcp add -s user playwright -- npx -y "@playwright/mcp@$PLAYWRIGHT_MCP_VERSION" --headless --browser chromium --executable-path /usr/local/bin/chromium --isolated
# the owner's Claude settings patch is in private/ of the development checkout (left out of the public copy, which a
# rebuild may start from while the stack's GitHubRepo names it); a fork may keep its own there. Read by the host user.
# (the clone's path in two steps: a literal "/switchboard/<name>" reads as an SSM parameter to the template's tests)
DEV_CLONE="${SB_REPOS_DIR:-}/switchboard"
OWN_SETTINGS="$DEV_CLONE/private/claude-settings.json"
[ -f "$OWN_SETTINGS" ] || OWN_SETTINGS="$HERE/../../private/claude-settings.json"
[ ! -f "$OWN_SETTINGS" ] || as_user bash "$HERE/claude-settings.sh" "$SB_HOST_HOME/.claude/settings.json" "$OWN_SETTINGS"
echo "devtools: done"
