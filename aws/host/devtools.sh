#!/usr/bin/env bash
# devtools — what a runner on the host needs to develop as on the Mac: Stacked PRs (gh-stack), the E2E scripts'
# headless Chrome, a Python project's tests (uv and Python 3.11+, docker, gitleaks), an AWS SAM template's lint, sqlite3 for the skills,
# and cosign for the daemon's check of a new Codex CLI.
# Run by bootstrap.sh as root after gh is logged in, with the same SB_HOST_USER / SB_HOST_HOME / SB_REPOS_DIR; running it
# again skips what is there. Last it applies the owner's Claude settings patch, read first from private/ of the development
# clone under SB_REPOS_DIR (unset: the clone "switchboard" under /), else from private/ of this clone. The user gets no
# root: docker is rootless (rootlesskit + pasta), started on demand by the docker wrapper.
set -euo pipefail
: "${SB_HOST_USER:?}" "${SB_HOST_HOME:?}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
as_user() { sudo -u "$SB_HOST_USER" -H env HOME="$SB_HOST_HOME" PATH="$SB_HOST_HOME/.local/bin:$SB_HOST_HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin" "$@"; }

# pinned by version and sha256 of the downloads: the distributor's published checksum where there is one, else the sha256 of the file itself
DOCKER_VERSION=29.10.1
DOCKER_SHA256=a38c8a9ef6d17bce07499bfd3a3688542274769dc3b4f75c06ea2705fe65053e
DOCKER_ROOTLESS_SHA256=9b677eb3bb0ce21c4e6aae3e44678309250f1aa6fbc95f66a94de7b88b04e45b
COMPOSE_VERSION=5.7.1
COMPOSE_SHA256=f2f49f903240895fa764c0dca3a14548b754ad9426f6b609ccaf55ec5a3aa2a5
UV_VERSION=0.13.10
UV_SHA256=14590f644805a6234ffe071154340669e38137f38e60aa9629690119704107d2
GITLEAKS_VERSION=8.30.1
GITLEAKS_SHA256=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
SAM_VERSION=1.172.1
SAM_SHA256=fcfc7cd414a75cc17a00c81110b2955ab52b6fae1dd8b7415d637ca95ca931df
# sigstore's verifier: the daemon checks the signature of a new Codex CLI with it (cli-update-source.ts). Pinned 2026-11-19
# (the release's asset digest and cosign_checksums.txt agree)
COSIGN_VERSION=3.1.4
COSIGN_SHA256=ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2
PLAYWRIGHT_VERSION=1.65.1
PLAYWRIGHT_MCP_VERSION=0.0.85
GH_STACK_VERSION=v0.3.0
# bun is installed by bootstrap.sh (bun install runs before this script, which may fail without stopping the bootstrap); the
# pin lives here so the versions sit in one place. Pinned 2026-11-26 (SHASUMS256.txt of the release, bun-linux-aarch64.zip);
# container/Dockerfile installs the same version from npm
BUN_VERSION=1.4.4
BUN_SHA256=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
DOCKER_BIN=/usr/local/lib/docker-rootless/bin

# --- from the distribution (signed): sqlite3, pasta and iptables for rootless docker, Chromium's libraries, CJK fonts,
# bubblewrap and socat for Claude Code's sandbox (a Claude review job runs its tests in it; without them it only reads) ---
dnf install -y -q sqlite passt iptables-nft fontconfig google-noto-sans-cjk-ttc-fonts bubblewrap socat \
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
# a failed cosign download leaves the rest of the setup to run: without cosign the daemon only retries the Codex check
# the verifier is the pinned one or none: a cosign already there with other bytes is replaced
echo "$COSIGN_SHA256  /usr/local/bin/cosign" | sha256sum -c --quiet - 2>/dev/null || {
  fetch "https://github.com/sigstore/cosign/releases/download/v$COSIGN_VERSION/cosign-linux-arm64" "$COSIGN_SHA256" "$DL/cosign" &&
    install -m 755 "$DL/cosign" /usr/local/bin/cosign
} || echo "devtools: cosign was not installed; the daemon cannot check a new Codex CLI until it is" >&2
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
