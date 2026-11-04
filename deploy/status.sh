#!/bin/sh
# Writes the server's state where Caddy serves it, behind the secret path.
D=/opt/mesa/status
mkdir -p "$D"
cd /opt/mesa/repo/deploy 2>/dev/null || exit 0
w() { "$@" > "$D/.tmp" 2>&1; mv "$D/.tmp" "$D/$OUT"; }
OUT=summary.txt w sh -c 'date -u; echo; echo "deployed: $(cat /opt/mesa/deployed 2>/dev/null)"; cloud-init status; echo; docker compose ps -a; echo; df -h /; echo; free -h; echo; uptime'
for s in elysium relay indexer caddy; do OUT=$s.log w docker compose logs --no-color --tail 300 $s; done
OUT=pull.log w journalctl -u mesa-pull --no-pager -n 100
OUT=cloud-init.log w tail -n 300 /var/log/cloud-init-output.log
