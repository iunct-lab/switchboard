# The image of the stand-alone mode (#4042): the tools, versions and paths of the EC2 host (aws/host/devtools.sh,
# node.sh) in one arm64 image. HOME is /home/switchboard and the repositories live in /home/switchboard/repos, as on
# the host, so a task's cwd and ~/.claude/projects read the same in both. Build from the repository root:
#   docker build -t sb-local -f container/Dockerfile .
# The versions and sha256 below that the host pins too are checked against those scripts by container/versions.test.ts.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023 AS base

RUN dnf install -y -q git sqlite unzip tar xz gzip shadow-utils findutils jq && dnf clean all

# pinned as in aws/host/devtools.sh and node.sh (same versions, same URLs, same sha256)
ARG DOCKER_VERSION=29.9.3
ARG DOCKER_SHA256=1b27fd739378ef938401e81ce5afb73b7ad7432d4f598814a9ff5f826bb464d2
ARG COMPOSE_VERSION=5.7.0
ARG COMPOSE_SHA256=15861535d14e26555736b49376c95e14bfd94285366c8446bfac7156a972e76f
ARG UV_VERSION=0.13.7
ARG UV_SHA256=71279f8d3c67241e807b9d8db872d1bf541579fb9f08b7d1eb1682196d1e57dc
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
ARG NODE_VERSION=24.22.2
ARG NODE_SHA256=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8
# pinned here only (the host installs gh from the distribution's repository, and the others at the latest)
ARG GH_VERSION=2.103.3
ARG GH_SHA256=ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63
ARG GH_STACK_VERSION=v0.3.0
ARG GH_STACK_SHA256=803ec91eeba9b2ac38827e299a79830fe75ca7284f0c28d60e6a2704bb34ed13
ARG BUN_VERSION=1.4.4
ARG CLAUDE_VERSION=2.1.322
ARG CODEX_VERSION=0.167.0

# fetch <url> <sha256> <file>: download and refuse anything whose checksum differs
RUN set -eu; \
  fetch() { curl -fsSL -o "$3" "$1" && echo "$2  $3" | sha256sum -c --quiet -; }; \
  DL="$(mktemp -d)"; \
  fetch "https://download.docker.com/linux/static/stable/aarch64/docker-$DOCKER_VERSION.tgz" "$DOCKER_SHA256" "$DL/docker.tgz"; \
  tar --no-same-owner -xzf "$DL/docker.tgz" -C /usr/local/bin --strip-components=1 docker/docker; \
  fetch "https://github.com/docker/compose/releases/download/v$COMPOSE_VERSION/docker-compose-linux-aarch64" "$COMPOSE_SHA256" "$DL/compose"; \
  install -D -m 755 "$DL/compose" /usr/local/lib/docker/cli-plugins/docker-compose; \
  fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-aarch64-unknown-linux-gnu.tar.gz" "$UV_SHA256" "$DL/uv.tar.gz"; \
  tar --no-same-owner -xzf "$DL/uv.tar.gz" -C /usr/local/bin --strip-components=1 uv-aarch64-unknown-linux-gnu/uv uv-aarch64-unknown-linux-gnu/uvx; \
  fetch "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION}_linux_arm64.tar.gz" "$GITLEAKS_SHA256" "$DL/gitleaks.tar.gz"; \
  tar --no-same-owner -xzf "$DL/gitleaks.tar.gz" -C /usr/local/bin gitleaks; \
  fetch "https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_linux_arm64.tar.gz" "$GH_SHA256" "$DL/gh.tar.gz"; \
  tar --no-same-owner -xzf "$DL/gh.tar.gz" -C /usr/local --strip-components=1 "gh_${GH_VERSION}_linux_arm64/bin/gh"; \
  fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-arm64.tar.xz" "$NODE_SHA256" "$DL/node.tar.xz"; \
  mkdir -p /usr/local/lib/nodejs; \
  tar --no-same-owner -xJf "$DL/node.tar.xz" -C /usr/local/lib/nodejs --strip-components=1; \
  for b in node npm npx; do ln -sf "/usr/local/lib/nodejs/bin/$b" "/usr/local/bin/$b"; done; \
  fetch "https://github.com/github/gh-stack/releases/download/$GH_STACK_VERSION/linux-arm64" "$GH_STACK_SHA256" "$DL/gh-stack"; \
  D=/home/switchboard/.local/share/gh/extensions/gh-stack; \
  install -D -m 755 "$DL/gh-stack" "$D/gh-stack"; \
  printf 'owner: github\nname: gh-stack\nhost: github.com\ntag: %s\nispinned: true\npath: %s/gh-stack\n' "$GH_STACK_VERSION" "$D" > "$D/manifest.yml"; \
  rm -rf "$DL"

# bun, claude and codex, from npm at a pinned version (the host takes the latest of each)
RUN npm install -g --no-fund --no-audit "bun@$BUN_VERSION" "@anthropic-ai/claude-code@$CLAUDE_VERSION" "@openai/codex@$CODEX_VERSION" \
  && for b in bun claude codex; do ln -sf "/usr/local/lib/nodejs/bin/$b" "/usr/local/bin/$b"; done \
  && npm cache clean --force

# the user, its HOME, and the four paths that container/compose.yaml mounts volumes on (a new named volume takes the
# owner of the directory it covers, so the daemon can write to them); what gh-stack's install above made is the user's
RUN useradd -u 1000 -m -d /home/switchboard switchboard \
  && mkdir -p /home/switchboard/.switchboard /home/switchboard/.claude /home/switchboard/.codex /home/switchboard/repos \
  && chown -R switchboard:switchboard /home/switchboard
ENV HOME=/home/switchboard

# the stage that CI runs in, off the host (sb-offload: `docker build --target ci`): what the stand-alone image has, plus a
# git with PCRE (git grep -P), Playwright's Chromium at the host's pin (aws/host/devtools.sh), Noto Sans and Noto Sans
# CJK JP for the screenshots, and the aws CLI (the build fetches the work tree from S3). It stops before the repository
# is copied in: the work tree is mounted or copied by the CI steps. No USER, so root can mount tmpfs, and the
# unprivileged user of the base stage (switchboard, uid 1000) is the one that runs the steps.
FROM base AS ci
ARG PLAYWRIGHT_VERSION=1.65.0
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN dnf install -y -q git-core fontconfig google-noto-sans-fonts google-noto-sans-cjk-ttc-fonts nss atk at-spi2-atk \
    cups-libs libdrm libxkbcommon libXcomposite libXdamage libXrandr mesa-libgbm pango alsa-lib awscli-2 \
  && dnf clean all \
  && npx -y "playwright@$PLAYWRIGHT_VERSION" install chromium \
  && chmod -R a+rX /opt/playwright \
  && ln -s "$(ls -d /opt/playwright/chromium-*/chrome-linux*/chrome | sort -V | tail -1)" /usr/local/bin/chromium \
  && rm -rf /home/switchboard/.npm
ENV CHROME_BIN=/usr/local/bin/chromium
# --no-index: the build is not in a repository, where git grep stops with 128 before it looks at -P
RUN git grep --no-index -P x </dev/null; [ $? -ne 128 ]

# the stand-alone image, the last stage and so the one `docker build` makes without --target
FROM base AS stand-alone

# the repository, installed and built, at a read-only place (root's)
COPY . /opt/switchboard
WORKDIR /opt/switchboard
RUN bun install --frozen-lockfile && bun run --cwd apps/web build

USER switchboard
WORKDIR /home/switchboard

# the stand-alone daemon behind a relay to 127.0.0.1 (container/entrypoint.sh); started by container/up.sh
ENTRYPOINT ["bash", "/opt/switchboard/container/entrypoint.sh"]
