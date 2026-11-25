# The image of the stand-alone mode: the tools, versions and paths of the EC2 host (aws/host/devtools.sh,
# node.sh) in one image, built natively for arm64 or x86-64. HOME is /home/switchboard and the repositories live in
# /home/switchboard/repos, as on the host, so a task's cwd and ~/.claude/projects read the same in both. Build from the repository root:
#   docker build -t sb-local -f container/Dockerfile .
# The versions and sha256 below that the host pins too are checked against those scripts by container/versions.test.ts.
FROM public.ecr.aws/amazonlinux/amazonlinux:2023 AS base

# diffutils: sb-rescue makes the diff of a new release with `diff -ruN` for its check; without it no release is ever checked
RUN dnf install -y -q git sqlite unzip tar xz gzip shadow-utils findutils jq diffutils && dnf clean all

# pinned as in aws/host/devtools.sh and node.sh (same versions, same URLs, same sha256). The unsuffixed sha256 are the arm64 ones the
# host pins; <NAME>_SHA256_X86_64 is the same version's x86-64 file from the same upstream release
ARG DOCKER_VERSION=29.10.0
ARG DOCKER_SHA256=6e5159e8b5615e0c0c2954a2a1a2a12bc65f5d9b603595dba24a10cb367408cd
ARG DOCKER_SHA256_X86_64=7c1ebadc65c716cdc6d35fc78759ed0e4317debf43c21dd12f066f2006999def
ARG COMPOSE_VERSION=5.7.1
ARG COMPOSE_SHA256=f2f49f903240895fa764c0dca3a14548b754ad9426f6b609ccaf55ec5a3aa2a5
ARG COMPOSE_SHA256_X86_64=af426722a8af5de812fcee30cc1c39f0639f5f723cbadefb25e5d4db054064cf
ARG UV_VERSION=0.13.8
ARG UV_SHA256=74f2f5c6024d397481db228db8fc25eed420db192243f88438c118e7e013e585
ARG UV_SHA256_X86_64=5acfd9177cfecf0bf87578f059728215ccc884388988f55f7a65041b57387d91
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
ARG GITLEAKS_SHA256_X86_64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG NODE_VERSION=24.22.3
ARG NODE_SHA256=6e51a2ada00f0011cc266f65d98922b403d7ad88f809ca2aa615a5fe1ce6e86c
ARG NODE_SHA256_X86_64=4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb
# pinned here only (the host installs gh from the distribution's repository, and the others at the latest)
ARG GH_VERSION=2.103.3
ARG GH_SHA256=ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63
ARG GH_SHA256_X86_64=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
ARG GH_STACK_VERSION=v0.3.0
ARG GH_STACK_SHA256=803ec91eeba9b2ac38827e299a79830fe75ca7284f0c28d60e6a2704bb34ed13
ARG GH_STACK_SHA256_X86_64=957e822cfa7e435cd84a297cd96c419b58e51e3ac58be249762c24bd9e45099b
ARG BUN_VERSION=1.4.4
ARG CLAUDE_VERSION=2.1.322
ARG CODEX_VERSION=0.167.0

# fetch <url> <sha256> <file>: download and refuse anything whose checksum differs. The CPU is chosen by uname -m (not buildkit's
# TARGETARCH, so the classic builder works too); each upstream names its files differently, hence the names below
RUN set -eu; \
  M="$(uname -m)"; \
  case "$M" in \
    x86_64) CPU=x86_64; GL=x64; GH_CPU=amd64; NODE_CPU=x64; \
      DOCKER_SHA="$DOCKER_SHA256_X86_64"; COMPOSE_SHA="$COMPOSE_SHA256_X86_64"; UV_SHA="$UV_SHA256_X86_64"; GITLEAKS_SHA="$GITLEAKS_SHA256_X86_64"; \
      GH_SHA="$GH_SHA256_X86_64"; NODE_SHA="$NODE_SHA256_X86_64"; GH_STACK_SHA="$GH_STACK_SHA256_X86_64" ;; \
    aarch64) CPU=aarch64; GL=arm64; GH_CPU=arm64; NODE_CPU=arm64; \
      DOCKER_SHA="$DOCKER_SHA256"; COMPOSE_SHA="$COMPOSE_SHA256"; UV_SHA="$UV_SHA256"; GITLEAKS_SHA="$GITLEAKS_SHA256"; \
      GH_SHA="$GH_SHA256"; NODE_SHA="$NODE_SHA256"; GH_STACK_SHA="$GH_STACK_SHA256" ;; \
    *) echo "unsupported CPU: $M" >&2; exit 1 ;; \
  esac; \
  fetch() { curl -fsSL -o "$3" "$1" && echo "$2  $3" | sha256sum -c --quiet -; }; \
  DL="$(mktemp -d)"; \
  fetch "https://download.docker.com/linux/static/stable/$CPU/docker-$DOCKER_VERSION.tgz" "$DOCKER_SHA" "$DL/docker.tgz"; \
  tar --no-same-owner -xzf "$DL/docker.tgz" -C /usr/local/bin --strip-components=1 docker/docker; \
  fetch "https://github.com/docker/compose/releases/download/v$COMPOSE_VERSION/docker-compose-linux-$CPU" "$COMPOSE_SHA" "$DL/compose"; \
  install -D -m 755 "$DL/compose" /usr/local/lib/docker/cli-plugins/docker-compose; \
  fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$CPU-unknown-linux-gnu.tar.gz" "$UV_SHA" "$DL/uv.tar.gz"; \
  tar --no-same-owner -xzf "$DL/uv.tar.gz" -C /usr/local/bin --strip-components=1 uv-$CPU-unknown-linux-gnu/uv uv-$CPU-unknown-linux-gnu/uvx; \
  fetch "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION}_linux_$GL.tar.gz" "$GITLEAKS_SHA" "$DL/gitleaks.tar.gz"; \
  tar --no-same-owner -xzf "$DL/gitleaks.tar.gz" -C /usr/local/bin gitleaks; \
  fetch "https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_linux_$GH_CPU.tar.gz" "$GH_SHA" "$DL/gh.tar.gz"; \
  tar --no-same-owner -xzf "$DL/gh.tar.gz" -C /usr/local --strip-components=1 "gh_${GH_VERSION}_linux_$GH_CPU/bin/gh"; \
  fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$NODE_CPU.tar.xz" "$NODE_SHA" "$DL/node.tar.xz"; \
  mkdir -p /usr/local/lib/nodejs; \
  tar --no-same-owner -xJf "$DL/node.tar.xz" -C /usr/local/lib/nodejs --strip-components=1; \
  for b in node npm npx; do ln -sf "/usr/local/lib/nodejs/bin/$b" "/usr/local/bin/$b"; done; \
  fetch "https://github.com/github/gh-stack/releases/download/$GH_STACK_VERSION/linux-$GH_CPU" "$GH_STACK_SHA" "$DL/gh-stack"; \
  D=/home/switchboard/.local/share/gh/extensions/gh-stack; \
  install -D -m 755 "$DL/gh-stack" "$D/gh-stack"; \
  printf 'owner: github\nname: gh-stack\nhost: github.com\ntag: %s\nispinned: true\npath: %s/gh-stack\n' "$GH_STACK_VERSION" "$D" > "$D/manifest.yml"; \
  rm -rf "$DL"

# bun, claude and codex, from npm at a pinned version (the host takes the latest of each). The npm package of bun only has bun.exe next to
# the binary process.execPath names; tests put dirname(process.execPath) on a narrow PATH and run `bun` from it (as on the host, ~/.bun/bin), so `bun` is a link there
RUN npm install -g --no-fund --no-audit "bun@$BUN_VERSION" "@anthropic-ai/claude-code@$CLAUDE_VERSION" "@openai/codex@$CODEX_VERSION" \
  && for b in bun claude codex; do ln -sf "/usr/local/lib/nodejs/bin/$b" "/usr/local/bin/$b"; done \
  && ln -s bun.exe /usr/local/lib/nodejs/lib/node_modules/bun/bin/bun \
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
ARG PLAYWRIGHT_VERSION=1.65.1
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN dnf install -y -q git-core zstd rsync procps-ng file diffutils fontconfig google-noto-sans-fonts google-noto-sans-cjk-ttc-fonts nss atk at-spi2-atk \
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

# the tree the image was built from, at a read-only place (root's). The daemon does not run from it: the entrypoint
# bundles sb-rescue from it and reads where releases come from, and the running version is built in the sb-home volume
# (which builds its own web UI). Installed, because container/e2e.sh starts a fake daemon from this tree.
COPY . /opt/switchboard
WORKDIR /opt/switchboard
RUN bun install --frozen-lockfile

USER switchboard
WORKDIR /home/switchboard

# sb-rescue and its daemon behind relays to 127.0.0.1 (container/entrypoint.sh); started by container/up.sh
ENTRYPOINT ["bash", "/opt/switchboard/container/entrypoint.sh"]
