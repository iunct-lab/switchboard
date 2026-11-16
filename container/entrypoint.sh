#!/usr/bin/env bash
# The stand-alone mode's start (#4042): the relay takes 0.0.0.0:47831 (the port compose.yaml publishes on the machine's
# 127.0.0.1) and passes it to the daemon on 127.0.0.1:47832, where the daemon sees every connection as loopback.
# No AWS setting is given, and the development clone is the user's to put in ~/repos (SWITCHBOARD_REPO_ROOT is not set).
# 「GitHub から追加」clones into ~/repos (the repositories' volume), not next to the code in /opt.
set -eu
bun /opt/switchboard/container/relay.ts 47831 47832 &
SWITCHBOARD_PORT=47832 SWITCHBOARD_REPOS_DIR="$HOME/repos" exec bun /opt/switchboard/packages/core/src/main.ts
