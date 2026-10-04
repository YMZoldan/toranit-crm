#!/usr/bin/env bash
# One-time: connect this server to your private GitHub repository (read-only deploy key).
# Usage:  bash setup-git-server.sh <github-user>/<repo>
set -euo pipefail
REPO="${1:-}"
[ -n "$REPO" ] || { echo "Usage: bash setup-git-server.sh <github-user>/<repo>   (example: yeruchem/toranit-crm)"; exit 1; }
[ "$(id -u)" -eq 0 ] || { echo "Run as root."; exit 1; }
command -v git >/dev/null || apt-get install -y git >/dev/null
KEY=/root/.ssh/toranit_deploy
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f "$KEY" ] || ssh-keygen -t ed25519 -f "$KEY" -N "" -C "cameras-server" >/dev/null
if ! grep -q "Host github-toranit" /root/.ssh/config 2>/dev/null; then
  cat >> /root/.ssh/config <<CFG
Host github-toranit
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
CFG
fi
chmod 600 /root/.ssh/config
ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null
echo
echo "1. Open https://github.com/$REPO/settings/keys"
echo "2. Click 'Add deploy key', title: cameras-server, paste the line below, keep 'Allow write access' OFF, click 'Add key':"
echo
cat "$KEY.pub"
echo
read -rp "Press Enter after you added the key... " _
until ssh -T github-toranit 2>&1 | grep -q "successfully authenticated"; do
  read -rp "GitHub does not accept the key yet. Check the steps above and press Enter to retry... " _
done
rm -rf /opt/cameras-src
git clone --quiet "git@github-toranit:$REPO.git" /opt/cameras-src
echo
echo "Connected: /opt/cameras-src  ($(cat /opt/cameras-src/VERSION 2>/dev/null || echo 'no VERSION file yet'))"
echo "From now on, update the server with:  cameras-update"
