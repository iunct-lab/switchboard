#!/bin/sh
# dockerd-up (#371) — makes sure the host user's rootless dockerd answers. It runs as sb-dockerd.service (its own cgroup
# and memory ceiling, 2026-09-29), which the user may start through sudoers and nothing else; /usr/local/bin/docker calls
# this before every command, so nothing has to start it after a reboot.
D="${SB_DOCKER_BIN:-/usr/local/lib/docker-rootless/bin}"
SOCK="$HOME/.docker/run/docker.sock"
"$D/docker" -H "unix://$SOCK" info >/dev/null 2>&1 && exit 0
sudo -n "${SB_SYSTEMCTL:-/usr/bin/systemctl}" start sb-dockerd || { echo "dockerd-up: could not start sb-dockerd" >&2; exit 1; }
i=0
until "$D/docker" -H "unix://$SOCK" info >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && { echo "dockerd-up: dockerd did not answer; see journalctl -u sb-dockerd" >&2; exit 1; }
  sleep 1
done
