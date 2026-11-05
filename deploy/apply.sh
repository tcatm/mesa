#!/bin/sh
# Decrypt secrets and bring every service to what the repo describes.
# Services whose image and config did not change are left running.
set -eu
cd /opt/mesa/repo/deploy
umask 077
age -d -i /opt/mesa/keys/age.key secrets.env.age > /opt/mesa/secrets.env.tmp
mv /opt/mesa/secrets.env.tmp /opt/mesa/secrets.env
mkdir -p /opt/mesa/data/elysium /opt/mesa/data/indexer /opt/mesa/data/media /opt/mesa/data/caddy /opt/mesa/data/status /opt/mesa/status
chown 1000:1000 /opt/mesa/data/elysium
docker compose --env-file /opt/mesa/secrets.env up -d --build --remove-orphans
# Caddy reads its config at start, and a bind-mounted file replaced by git is
# not seen by the running container: restart it when the Caddyfile changed.
sum=$(sha256sum Caddyfile | cut -d' ' -f1)
if [ "$sum" != "$(cat /opt/mesa/caddyfile.sum 2>/dev/null)" ]; then
  docker compose --env-file /opt/mesa/secrets.env restart caddy
  echo "$sum" > /opt/mesa/caddyfile.sum
fi
docker image prune -f > /dev/null
