#!/bin/bash
# Reversible installer for the sanction-buster SNI proxy.
# Safe to re-run. Touches ONLY: tcp/443 (rtt-probe -> nginx), nginx stream config,
# nftables table 'sanction', dnsmasq (disabled). Leaves AmneziaWG (udp/443), SSH, wg-panel alone.
set -euo pipefail

SRC=/opt/sanction
BACKUP=/root/sanction-backup
mkdir -p "$SRC" "$BACKUP"

echo "== 1. Backup =="
[ -f /etc/nginx/nginx.conf ] && cp -n /etc/nginx/nginx.conf "$BACKUP/nginx.conf.orig" || true

echo "== 2. Disable dnsmasq (avoid open resolver) =="
systemctl stop dnsmasq 2>/dev/null || true
systemctl disable dnsmasq 2>/dev/null || true

echo "== 3. Free tcp/443: stop rtt-probe (SNI proxy will preserve RTT behaviour) =="
if systemctl is-enabled rtt-probe.service >/dev/null 2>&1; then
    systemctl stop rtt-probe.service || true
    systemctl disable rtt-probe.service || true
    echo "rtt-probe.service stopped+disabled (re-enable to revert)"
fi

echo "== 4. Deploy configs =="
# expects the following already uploaded into $SRC:
#   sanction-domains.json gen-allowlist.js stream-sanction.conf sanction.nft traffic-guard.sh
cp "$SRC/stream-sanction.conf" /etc/nginx/stream-sanction.conf
node "$SRC/gen-allowlist.js" "$SRC/sanction-domains.json" /etc/nginx/sanction-allowlist.map
install -m 755 "$SRC/traffic-guard.sh" /usr/local/bin/sanction-traffic-guard

echo "== 5. Wire stream block into nginx.conf (idempotent, top-level) =="
if ! grep -q 'stream-sanction.conf' /etc/nginx/nginx.conf; then
    printf '\n# sanction-buster\ninclude /etc/nginx/stream-sanction.conf;\n' >> /etc/nginx/nginx.conf
fi

echo "== 6. Validate & (re)load nginx =="
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl restart nginx

echo "== 7. Apply nftables limits =="
nft -f "$SRC/sanction.nft"

echo "== 8. Cron: traffic guard (check/min, reset at midnight) =="
CRON=/etc/cron.d/sanction-guard
cat > "$CRON" <<'EOF'
* * * * * root /usr/local/bin/sanction-traffic-guard check >/dev/null 2>&1
0 0 * * * root /usr/local/bin/sanction-traffic-guard reset >/dev/null 2>&1
EOF
chmod 644 "$CRON"

echo "== 9. Persist nftables across reboot =="
mkdir -p /etc/systemd/system
cat > /etc/systemd/system/sanction-nft.service <<EOF
[Unit]
Description=Sanction nftables rules
After=network.target
[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f $SRC/sanction.nft
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable sanction-nft.service >/dev/null 2>&1 || true

echo "== DONE =="
echo "tcp/443 -> nginx SNI proxy | udp/443 AmneziaWG untouched"
ss -tulpn | grep -E ':443|:53' || true
