#!/bin/bash
# Global daily traffic guard for the sanction SNI proxy.
# Reads the nftables byte counters (client-facing on TCP/443), estimates real bandwidth
# (client-side + upstream-side ~= 2x client-side), and arms a kill-switch when the daily
# cap is exceeded. A separate midnight cron resets counters and disarms.
#
# Usage:
#   traffic-guard.sh check     # run from cron every minute
#   traffic-guard.sh reset     # run from cron at 00:00
set -euo pipefail

CAP_GB="${SANCTION_CAP_GB:-3.3}"
CAP_BYTES=$(awk "BEGIN{printf \"%d\", $CAP_GB*1024*1024*1024}")

get_counter() {
    nft -j list counter inet sanction "$1" 2>/dev/null \
        | grep -o '"bytes":[0-9]*' | head -1 | cut -d: -f2 || echo 0
}

case "${1:-check}" in
  check)
    IN=$(get_counter sni_in);  IN=${IN:-0}
    OUT=$(get_counter sni_out); OUT=${OUT:-0}
    # Real bandwidth ~= 2 x client-facing (proxy fetches an equal amount upstream).
    TOTAL=$(( (IN + OUT) * 2 ))
    if [ "$TOTAL" -ge "$CAP_BYTES" ]; then
        # Arm kill-switch if not already armed.
        if ! nft list chain inet sanction kill 2>/dev/null | grep -q drop; then
            nft add rule inet sanction kill drop
            logger -t sanction "daily cap reached (${TOTAL} bytes >= ${CAP_BYTES}); kill-switch ARMED"
        fi
    fi
    ;;
  reset)
    nft flush chain inet sanction kill 2>/dev/null || true
    nft reset counter inet sanction sni_in  >/dev/null 2>&1 || true
    nft reset counter inet sanction sni_out >/dev/null 2>&1 || true
    logger -t sanction "daily reset: counters cleared, kill-switch disarmed"
    ;;
  status)
    IN=$(get_counter sni_in); OUT=$(get_counter sni_out)
    TOTAL=$(( (IN + OUT) * 2 ))
    echo "client_in=$IN client_out=$OUT est_total_bytes=$TOTAL cap_bytes=$CAP_BYTES"
    nft list chain inet sanction kill 2>/dev/null | grep -q drop && echo "killswitch=ARMED" || echo "killswitch=disarmed"
    ;;
esac
