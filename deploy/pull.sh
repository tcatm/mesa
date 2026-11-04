#!/bin/sh
# Run every minute by mesa-pull.timer: fetch main, and apply it if it changed.
set -eu
cd /opt/mesa/repo
export GIT_SSH_COMMAND="ssh -i /opt/mesa/keys/deploy_key -o IdentitiesOnly=yes -o UserKnownHostsFile=/opt/mesa/keys/known_hosts"
git fetch -q origin main
if [ "$(git rev-parse origin/main)" != "$(cat /opt/mesa/deployed 2>/dev/null)" ]; then
  git reset -q --hard origin/main
  sh deploy/apply.sh
  git rev-parse HEAD > /opt/mesa/deployed
fi
