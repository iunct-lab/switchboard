#!/bin/sh
# docker (#371) — the docker CLI against the host user's rootless dockerd, which dockerd-up starts when it is not running.
D="${SB_DOCKER_BIN:-/usr/local/lib/docker-rootless/bin}"
export DOCKER_HOST="${DOCKER_HOST:-unix://$HOME/.docker/run/docker.sock}"
# a build or a compose stack may not fit the host's dockerd (sb-dockerd, 1.5 GiB): one line on where it can go (#678).
# Only a hint: the command still runs here, where its bind mounts and localhost ports are
# (the hint names the repository: it reaches Tasks of every repository, whose work trees do not have that README)
heavy=
case "$1" in
  build) heavy=1 ;;
  buildx | image) [ "$2" = build ] && heavy=1 ;;
  compose)
    # compose's own subcommand: the first word that is not an option or an option's value, not what a container runs
    shift; skip=
    for a in "$@"; do
      if [ -n "$skip" ]; then skip=; continue; fi
      case "$a" in
        -f | --file | -p | --project-name | --env-file | --profile | --project-directory | --ansi | --progress | --parallel) skip=1 ;;
        -*) ;;
        up | build) heavy=1; break ;;
        *) break ;;
      esac
    done
    set -- compose "$@" ;;
esac
[ -z "$heavy" ] || echo "docker: heavy builds and compose stacks can run off the host: sb-offload [--size large] <command> — small unless asked; a compose stack's checks can need large (開発リポジトリ aws/README.md, Offload)" >&2
if [ "$DOCKER_HOST" = "unix://$HOME/.docker/run/docker.sock" ]; then "${SB_DOCKERD_UP:-/usr/local/bin/dockerd-up}" || exit 1; fi
exec "$D/docker" "$@"
