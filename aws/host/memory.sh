#!/usr/bin/env bash
# memory (#537) — a swap file and a gentler swappiness, run as root by bootstrap. The host has 4 GiB and no swap; when the
# runners, Chromium and dockerd use it all, it can spend hours re-reading pages from the disk. The limits
# on the daemon's unit (switchboard.service) keep that from happening; the swap absorbs a short peak on the way.
# Idempotent. SB_SWAPFILE, SB_SWAP_MB, SB_FSTAB and SB_SYSCTL_D are where the tests point it.
set -euo pipefail
FILE="${SB_SWAPFILE:-/swapfile}"
MB="${SB_SWAP_MB:-2048}"
FSTAB="${SB_FSTAB:-/etc/fstab}"
SYSCTL_D="${SB_SYSCTL_D:-/etc/sysctl.d}"

# written beside the real name and moved into place formatted, so an interrupted run is redone, not taken for done
if [ ! -f "$FILE" ]; then
  rm -f "$FILE.new"
  dd if=/dev/zero of="$FILE.new" bs=1M count="$MB" status=none
  chmod 600 "$FILE.new"
  mkswap "$FILE.new" >/dev/null   # no -q: util-linux 2.37 on AL2023 has none (with it, the bootstrap stops here)
  mv "$FILE.new" "$FILE"
fi
ACTIVE="$(swapon --show=NAME --noheadings)"   # not a pipe into grep -q: pipefail would read its early exit as a failure
grep -qxF "$FILE" <<<"$ACTIVE" || swapon "$FILE"
grep -qsF "$FILE none swap" "$FSTAB" || echo "$FILE none swap sw 0 0" >> "$FSTAB"

# the default (60) swaps out working pages long before it has to; 10 keeps swap for real pressure
mkdir -p "$SYSCTL_D"
echo "vm.swappiness=10" > "$SYSCTL_D/99-switchboard-memory.conf"
sysctl -q -p "$SYSCTL_D/99-switchboard-memory.conf"
