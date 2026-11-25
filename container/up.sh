#!/usr/bin/env bash
# Starts the stand-alone mode: builds the image and runs it in the background. DOCKER_GID is the group of the
# machine's docker socket, so that a task's shell in the container can use it (without the socket it is 0 and only
# docker is out of reach). SWITCHBOARD_REPO_ROOT, when set, goes through to the container (compose.yaml): the path, in
# the container, of the clone releases are built from; unset, releases come from the public repository.
set -eu
cd "$(dirname "$0")/.."
DC=(docker compose -f container/compose.yaml)
# the container shares the machine's network (compose.yaml): another Switchboard on this machine holds the ports.
# This stack's own running container holds them too, and a re-run (to rebuild or update) recreates it, so it is not asked.
if [ -z "$("${DC[@]}" ps -q --status running switchboard 2>/dev/null)" ]; then
for port in 47831 47841; do
  if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then
    echo "up.sh: 127.0.0.1:$port is already in use (another Switchboard is running on this machine). Stop it first." >&2
    exit 1
  fi
done
fi
DOCKER_GID=$(stat -c %g /var/run/docker.sock 2>/dev/null || echo 0) "${DC[@]}" up -d --build
