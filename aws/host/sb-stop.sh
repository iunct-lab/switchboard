#!/usr/bin/env bash
# sb-stop <ISO time | -> — the daemon's SWITCHBOARD_IDLE_STOP_CMD on the cloud host (#227, #230).
# Registers one EventBridge Scheduler wake-up at the given time (nothing when "-"), lets Litestream finish its
# last sync, and shuts the OS down; the instance's shutdown behaviour is "stop", so the disk stays.
set -euo pipefail
# shellcheck source=/dev/null
. "${SB_HOST_ENV:-/etc/switchboard-host.env}"   # SB_INSTANCE_ID, SB_SCHEDULER_ROLE_ARN
WAKE="${1:?usage: sb-stop <ISO time|->}"

as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo -n "$@"; fi; }

if [ "$WAKE" != "-" ]; then
  # the daemon passes Date#toISOString() (UTC, "2026-09-25T05:30:00.000Z"); at() wants it without zone or fraction
  [[ "$WAKE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z$ ]] || { echo "sb-stop: not a UTC ISO time: $WAKE" >&2; exit 2; }
  AT="${WAKE%Z}"; AT="${AT%%.*}"
  set -- --name switchboard-wake --schedule-expression "at($AT)" --schedule-expression-timezone UTC \
    --flexible-time-window Mode=OFF --action-after-completion DELETE \
    --target "{\"Arn\":\"arn:aws:scheduler:::aws-sdk:ec2:startInstances\",\"RoleArn\":\"$SB_SCHEDULER_ROLE_ARN\",\"Input\":\"{\\\"InstanceIds\\\":[\\\"$SB_INSTANCE_ID\\\"]}\"}"
  aws scheduler update-schedule "$@" >/dev/null 2>&1 || aws scheduler create-schedule "$@" >/dev/null
  echo "sb-stop: wake-up registered for $AT UTC"
else
  # nothing due: a wake-up left from an earlier stop must not start the machine for nothing
  aws scheduler delete-schedule --name switchboard-wake >/dev/null 2>&1 || true
fi
# the runners' records as of now (#401): a machine that is stopped has nothing newer to lose on a 作り直す. A failure
# here does not keep the machine running
"${SB_RUNNER_SYNC:-/usr/local/bin/sb-runner-sync}" || echo "sb-stop: the runners' records were not saved" >&2
as_root systemctl stop litestream   # its last sync to S3 happens on stop
as_root shutdown -h now
