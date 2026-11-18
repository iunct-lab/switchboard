#!/usr/bin/env bash
# Starts the stand-alone mode: builds the image and runs it in the background. DOCKER_GID is the group of the
# machine's docker socket, so that a task's shell in the container can use it (without the socket it is 0 and only
# docker is out of reach). SWITCHBOARD_REPO_ROOT, when set, goes through to the container (compose.yaml): the path, in
# the container, of the clone releases are built from; unset, releases come from the public repository.
set -eu
cd "$(dirname "$0")/.."
DOCKER_GID=$(stat -c %g /var/run/docker.sock 2>/dev/null || echo 0) docker compose -f container/compose.yaml up -d --build
