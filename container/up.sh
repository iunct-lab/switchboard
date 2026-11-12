#!/usr/bin/env bash
# Starts the stand-alone mode (#4042): builds the image and runs it in the background. DOCKER_GID is the group of the
# machine's docker socket, so that a task's shell in the container can use it (without the socket it is 0 and only
# docker is out of reach).
set -eu
cd "$(dirname "$0")/.."
DOCKER_GID=$(stat -c %g /var/run/docker.sock 2>/dev/null || echo 0) docker compose -f container/compose.yaml up -d --build
