#!/usr/bin/env bash
# sb-env — before the daemon starts, write the values it needs from Parameter Store into /etc/switchboard.env (root,
# 0600): the shared CloudFront header (the daemon rejects requests without it) and the Starter's URL and start
# token (sb-rescue's 作り直す), and, only when /switchboard/uplink-machines exists, the three values that make the daemon
# the receiving side of a work machine (SWITCHBOARD_UPLINK=receive, SWITCHBOARD_UPLINK_PREVIEW=not-for-use,
# SWITCHBOARD_UPLINK_MACHINES=<the parameter>). No runner credentials.
# The edge header is required (without it the daemon would answer nobody through CloudFront). The Starter's URL is
# written by the stack after the instance exists, so on the first boot it may not be there yet: it is left empty
# (no 作り直す button) and picked up at the next daemon start — this runs before every start (switchboard.service).
# With a token file and its owner (`sb-env <env> <token file> <user>`), the API token of the daemon and sb-rescue comes
# from /switchboard/daemon-token when it exists: there is no SSH, so this is how a person gets it (AWS console on a
# phone), and rotating it is a parameter update + restart. Without the parameter the daemon keeps making its own.
# The distribution's https origin (/switchboard/web-url) is the rescue page's outside URL; like the Starter's URL it
# may be missing on the first boot (the link then points at sb-rescue's own address) and is picked up at the next start.
# Only whoever can write Parameter Store switches the instance to the receiving side: the host role reads the parameter
# and has no PutParameter. The parameter is never copied as env lines: exactly the three keys above are written, and a
# value with any character outside letters, digits and . _ / = + , - (a newline, a carriage return, a quote, #, $, a
# backslash, a space inside a name: whatever an EnvironmentFile line would read differently) is refused with a line on
# stderr, and the instance stays alone. Spaces and tabs around "," and "+", after "=" and at the ends are dropped
# first, as the daemon's own reader trims exactly those.
set -euo pipefail
# runuser is in /usr/sbin on AL2023, and the unit's PATH (the host user's) does not have it
export PATH="$PATH:/usr/sbin:/sbin"
OUT="${1:-/etc/switchboard.env}"
TOKEN_FILE="${2:-}"
TOKEN_OWNER="${3:-}"
param() { aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text; }
optional() { param "$1" 2>/dev/null || true; }
EDGE="$(param /switchboard/edge-header)"
STARTER_URL="$(optional /switchboard/starter-url)"
START_TOKEN="$(optional /switchboard/start-token)"
[ -n "$STARTER_URL" ] && [ -n "$START_TOKEN" ] || STARTER_URL="" START_TOKEN=""
umask 077
# the public key that verifies the login cookie the starter Lambda signs after a passkey check; the seed that
# signs is the Starter's alone, so nothing here can make a cookie. Empty = tokens only
SESSION_PUBLIC_KEY="$(optional /switchboard/session-public-key)"
WEB_URL="$(optional /switchboard/web-url)"
printf 'SWITCHBOARD_EDGE_HEADER_VALUE=%s\nSWITCHBOARD_STARTER_URL=%s\nSWITCHBOARD_STARTER_TOKEN=%s\nSWITCHBOARD_SESSION_PUBLIC_KEY=%s\nSWITCHBOARD_WEB_URL=%s\n' "$EDGE" "$STARTER_URL" "$START_TOKEN" "$SESSION_PUBLIC_KEY" "$WEB_URL" > "$OUT"
# the registry of work machines (docs/design/work-machine.md, section 1): there, this instance takes their work in.
# Written by a person only (the instance role cannot write a parameter). A read that fails for another reason than a
# missing parameter is said, and the instance then runs alone. No temporary file: a full /tmp must not stop the start
# (only a failed read is asked again for its reason: a warning a successful read writes is not part of the value)
if ! MACHINES="$(param /switchboard/uplink-machines 2>/dev/null)"; then
  case "$(param /switchboard/uplink-machines 2>&1 >/dev/null || true)" in *ParameterNotFound*) ;; *) echo "sb-env: /switchboard/uplink-machines could not be read: this instance stays alone" >&2;; esac
  MACHINES=""
fi
MACHINES="$(printf %s "$MACHINES" | sed -E 's/[[:blank:]]*([,+])[[:blank:]]*/\1/g; s/=[[:blank:]]+/=/g; s/^[[:blank:]]+//; s/[[:blank:]]+$//')"
machines_ok() { local LC_ALL=C; case "$1" in *[!A-Za-z0-9._/=+,-]*) return 1;; esac; }
if [ -n "$MACHINES" ]; then
  if machines_ok "$MACHINES"; then
    printf 'SWITCHBOARD_UPLINK=receive\nSWITCHBOARD_UPLINK_PREVIEW=not-for-use\nSWITCHBOARD_UPLINK_MACHINES=%s\n' "$MACHINES" >> "$OUT"
  else
    echo "sb-env: /switchboard/uplink-machines has a character outside A-Z a-z 0-9 . _ / = + , - (a newline, a quote...): not written, this instance stays alone" >&2
  fi
fi
if [ -n "$TOKEN_FILE" ] && [ -n "$TOKEN_OWNER" ]; then
  DAEMON_TOKEN="$(optional /switchboard/daemon-token)"
  if [ -n "$DAEMON_TOKEN" ]; then
    # Written as the owner, never as root: the directory is the host user's (and the agents'), so root following a link
    # planted there could overwrite any file. mv replaces a planted link itself rather than writing through it.
    printf '%s\n' "$DAEMON_TOKEN" | runuser -u "$TOKEN_OWNER" -- sh -c 'umask 077; mkdir -p "$(dirname "$1")" && cat > "$1.new" && mv -f "$1.new" "$1"' _ "$TOKEN_FILE"
  fi
fi
