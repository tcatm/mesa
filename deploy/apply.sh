#!/bin/sh
# Decrypt secrets and bring every service to what the repo describes.
# Services whose image and config did not change are left running.
set -eu
cd /opt/mesa/repo/deploy
umask 077
age -d -i /opt/mesa/keys/age.key secrets.env.age > /opt/mesa/secrets.env.tmp
mv /opt/mesa/secrets.env.tmp /opt/mesa/secrets.env
mkdir -p /opt/mesa/data/elysium /opt/mesa/data/indexer /opt/mesa/data/caddy /opt/mesa/status
chown 1000:1000 /opt/mesa/data/elysium
docker compose --env-file /opt/mesa/secrets.env up -d --build --remove-orphans
docker image prune -f > /dev/null
