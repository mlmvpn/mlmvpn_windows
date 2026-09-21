#!/bin/bash
# Reverts install-sanction.sh. Restores rtt-probe on tcp/443, removes nginx stream block,
# nftables table, cron, and persistence unit. AmneziaWG was never touched.
set -uo pipefail

echo "== remove nginx stream include =="
sed -i '/# sanction-buster/d;/stream-sanction.conf/d' /etc/nginx/nginx.conf
rm -f /etc/nginx/stream-sanction.conf /etc/nginx/sanction-allowlist.map
nginx -t && systemctl restart nginx || echo "nginx test failed — check manually"

echo "== drop nftables table =="
nft delete table inet sanction 2>/dev/null || true

echo "== remove cron + persistence =="
rm -f /etc/cron.d/sanction-guard /usr/local/bin/sanction-traffic-guard
systemctl disable sanction-nft.service 2>/dev/null || true
rm -f /etc/systemd/system/sanction-nft.service
systemctl daemon-reload

echo "== restore rtt-probe on tcp/443 =="
systemctl enable rtt-probe.service 2>/dev/null || true
systemctl start rtt-probe.service 2>/dev/null || true

echo "== DONE (reverted). dnsmasq left disabled; re-enable manually if you need it. =="
ss -tulpn | grep ':443' || true
