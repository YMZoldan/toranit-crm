#!/usr/bin/env bash
# Toranit cable planner — one-shot installer for a fresh Ubuntu 22.04/24.04 server.
# Installs: updates, firewall, fail2ban, Docker, Traefik (HTTPS via Let's Encrypt),
# the app with its own PostgreSQL, and nightly backups.
# Usage (as root):  bash install.sh            first install (asks domain, email, password)
#                   bash install.sh --update   update an existing install, no questions
set -euo pipefail
UPDATE=0; [ "${1:-}" = "--update" ] && UPDATE=1

APP_DIR=/opt/cameras
TRAEFIK_DIR=/opt/traefik
BACKUP_DIR=/opt/backups
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root: sudo bash install.sh"
[ -f "$SRC_DIR/server.js" ] && [ -f "$SRC_DIR/docker-compose.yml" ] || die "Run this script from inside the unzipped cameras folder."
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || warn "Tested on Ubuntu 22.04/24.04; you are on ${PRETTY_NAME:-unknown}."

NEW_VER=$(cat "$SRC_DIR/VERSION" 2>/dev/null || echo "?")
OLD_VER=$(cat "$APP_DIR/VERSION" 2>/dev/null || echo "none")
printf '\n\033[1mToranit cable planner %s\033[0m  (installed now: %s)\n' "$NEW_VER" "$OLD_VER"

# ---------- questions ----------
if [ -f "$APP_DIR/.env" ] && grep -q '^SESSION_SECRET=' "$APP_DIR/.env"; then
  EXISTING=1
  DOMAIN=$(grep '^DOMAIN=' "$APP_DIR/.env" | cut -d= -f2-)
  EMAIL=$(grep -o 'acme.email=[^ ]*' "$TRAEFIK_DIR/docker-compose.yml" 2>/dev/null | head -n1 | cut -d= -f2- || true)
  ok "Existing installation for $DOMAIN: data, users and passwords are kept"
else
  [ "$UPDATE" -eq 1 ] && die "No existing installation found. Run: bash install.sh"
  EXISTING=0
  say "Settings"
  read -rp "Domain [cameras.toranit.co.il]: " DOMAIN
  DOMAIN=${DOMAIN:-cameras.toranit.co.il}
  while :; do
    read -rp "Your email (Let's Encrypt + first login): " EMAIL
    [[ "$EMAIL" == *@*.* ]] && break
    warn "That does not look like an email address (example: name@gmail.com). Try again."
  done
  while :; do
    read -rsp "Password for first login (min 8 chars): " PASS1; echo
    read -rsp "Repeat password: " PASS2; echo
    [ "${#PASS1}" -ge 8 ] || { warn "Too short."; continue; }
    [ "$PASS1" = "$PASS2" ] || { warn "Passwords do not match."; continue; }
    break
  done
fi

# ---------- system ----------
say "Updating system"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
[ "$EXISTING" -eq 1 ] || apt-get -y -o Dpkg::Options::=--force-confold upgrade
apt-get install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades dnsutils git
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
systemctl enable --now fail2ban >/dev/null 2>&1 || true
ok "System updated, automatic security updates and fail2ban enabled"

# ---------- DNS check ----------
say "Checking DNS"
PUBIP=$(curl -fsS4 --max-time 10 https://api.ipify.org || true)
DNSIP=$(dig +short A "$DOMAIN" @1.1.1.1 | tail -n1 || true)
if [ -n "$PUBIP" ] && [ "$PUBIP" = "$DNSIP" ]; then ok "$DOMAIN -> $PUBIP"
else
  warn "$DOMAIN resolves to '${DNSIP:-nothing}', but this server is '${PUBIP:-unknown}'."
  warn "Create an A record: $DOMAIN -> $PUBIP. The HTTPS certificate will be issued once DNS is correct."
  if [ "$EXISTING" -eq 0 ]; then read -rp "Continue anyway? [y/N] " a; [[ "$a" =~ ^[Yy]$ ]] || die "Stopped. Fix DNS and run again."; fi
fi

# ---------- firewall ----------
say "Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ok "Open ports: 22 (SSH), 80, 443"

# ---------- docker ----------
say "Docker"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker >/dev/null
docker network inspect proxy >/dev/null 2>&1 || docker network create proxy >/dev/null
ok "$(docker --version)"

# ---------- traefik ----------
say "Traefik (HTTPS)"
if [ "$EXISTING" -eq 1 ] && [ -f "$TRAEFIK_DIR/docker-compose.yml" ]; then
  (cd "$TRAEFIK_DIR" && docker compose up -d >/dev/null) && ok "Traefik running (settings kept)"
else
mkdir -p "$TRAEFIK_DIR/letsencrypt"
touch "$TRAEFIK_DIR/letsencrypt/acme.json"; chmod 600 "$TRAEFIK_DIR/letsencrypt/acme.json"
cat > "$TRAEFIK_DIR/docker-compose.yml" <<YML
services:
  traefik:
    image: traefik:v3.6
    container_name: traefik
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedbydefault=false
      - --providers.docker.network=proxy
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.email=${EMAIL}
      - --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
      - --log.level=WARN
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt
    networks:
      - proxy
networks:
  proxy:
    external: true
YML
(cd "$TRAEFIK_DIR" && docker compose up -d)
ok "Traefik running"
fi

# ---------- app ----------
say "Installing the app"
mkdir -p "$APP_DIR"
for f in server.js package.json package-lock.json Dockerfile docker-compose.yml .dockerignore README.md CHANGELOG.md VERSION; do
  [ -f "$SRC_DIR/$f" ] && cp "$SRC_DIR/$f" "$APP_DIR/"
done
rm -rf "$APP_DIR/public"; cp -r "$SRC_DIR/public" "$APP_DIR/public"
if [ "$EXISTING" -eq 0 ]; then
  umask 077
  cat > "$APP_DIR/.env" <<ENV
DOMAIN=${DOMAIN}
TRAEFIK_NETWORK=proxy
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_CERTRESOLVER=letsencrypt
POSTGRES_PASSWORD=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)
COOKIE_SECURE=true
ENV
  umask 022
else
  sed -i "s/^DOMAIN=.*/DOMAIN=${DOMAIN}/" "$APP_DIR/.env"
fi
chmod 600 "$APP_DIR/.env"
cd "$APP_DIR"
docker compose up -d --build

say "Waiting for the app to start"
for i in $(seq 1 60); do
  if docker compose exec -T app wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1; then ok "App is healthy"; break; fi
  [ "$i" -eq 60 ] && { docker compose logs --tail 50 app; die "The app did not start. See the log above."; }
  sleep 3
done

if [ "$EXISTING" -eq 0 ]; then
  if printf '%s' "$PASS1" | docker compose exec -T app node server.js adduser "$EMAIL" - admin; then ok "First user created: $EMAIL (password stored hashed only)"
  else warn "Could not create the user (maybe it already exists). Check: docker compose exec app node server.js users"; fi
  unset PASS1 PASS2
fi

# ---------- update command ----------
cat > /usr/local/bin/cameras-update <<'SH'
#!/usr/bin/env bash
# Pull the latest version (or a given tag, e.g. v1.5.0) from GitHub and install it.
set -euo pipefail
SRC=/opt/cameras-src
if [ ! -d "$SRC/.git" ]; then
  echo "Git is not set up yet. Run once:  bash /opt/cameras/setup-git-server.sh <github-user>/<repo>"; exit 1
fi
cd "$SRC"
before=$(cat /opt/cameras/VERSION 2>/dev/null || echo "?")
git fetch --tags --force --quiet origin
if [ -n "${1:-}" ]; then
  git checkout -f --quiet "tags/$1"
else
  branch=$(git remote show origin 2>/dev/null | sed -n 's/.*HEAD branch: //p')
  case "$branch" in ""|*"("*) if git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then branch=main; else branch=master; fi;; esac
  git checkout -f --quiet "$branch" && git reset --hard --quiet "origin/$branch"
fi
after=$(cat VERSION)
echo "Installed: $before   ->   GitHub: $after"
/usr/local/bin/cameras-backup >/dev/null 2>&1 && echo "Backup done before update." || echo "Backup skipped."
bash install.sh --update
SH
chmod 755 /usr/local/bin/cameras-update
cp "$SRC_DIR/setup-git-server.sh" "$APP_DIR/" 2>/dev/null || true
ok "Update command installed: cameras-update"

# ---------- backups ----------
say "Nightly backups"
mkdir -p "$BACKUP_DIR"; chmod 700 "$BACKUP_DIR"
cat > /usr/local/bin/cameras-backup <<'SH'
#!/usr/bin/env bash
set -euo pipefail
D=$(date +%F)
cd /opt/cameras
docker compose exec -T db pg_dump -U cameras cameras | gzip > /opt/backups/cameras-db-$D.sql.gz
docker run --rm -v cameras_uploads:/u:ro -v /opt/backups:/b alpine tar czf /b/cameras-uploads-$D.tgz -C /u .
find /opt/backups -name 'cameras-*' -mtime +14 -delete
SH
chmod 700 /usr/local/bin/cameras-backup
echo "0 2 * * * root /usr/local/bin/cameras-backup >> /var/log/cameras-backup.log 2>&1" > /etc/cron.d/cameras-backup
/usr/local/bin/cameras-backup && ok "Backup works: $(ls -1 $BACKUP_DIR | tail -n 2 | tr '\n' ' ')"

# ---------- HTTPS check ----------
say "Checking https://$DOMAIN (the certificate can take a minute)"
for i in $(seq 1 24); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$DOMAIN/healthz" || true)
  [ "$code" = "200" ] && { ok "https://$DOMAIN is live with a valid certificate"; break; }
  [ "$i" -eq 24 ] && warn "HTTPS not ready yet (last status: ${code:-none}). Usually DNS. Check: docker logs traefik"
  sleep 5
done

cat <<DONE

────────────────────────────────────────────
 Done. Version $NEW_VER is installed.  Open: https://$DOMAIN

 Add a worker:
   cd $APP_DIR && docker compose exec app node server.js adduser worker@toranit.co.il 'Password123' 'Name'
 Logs:      cd $APP_DIR && docker compose logs -f app
 Backups:   $BACKUP_DIR  (every night 02:00, kept 14 days)
 Update:    cameras-update            (latest version from GitHub)
            cameras-update v1.4.0     (go back to a specific version)
────────────────────────────────────────────
DONE
