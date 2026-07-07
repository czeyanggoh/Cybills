#!/usr/bin/env bash
# Builds + restarts on the VPS. Invoked by the on-box pull-based poller
# (scripts/auto-deploy-poll.sh). Assumes the repo lives at /opt/cybills, is
# already checked out at the target commit, and that vps-bootstrap has run once.
set -euo pipefail

APP_DIR=/opt/cybills
PUBLIC_HOST=cybills.cy-bm.sg
BACKEND_PORT=3004
cd "$APP_DIR"

# Serialize deploys across every trigger so two can't build/restart at once.
# Wait up to 10 min for an in-flight deploy rather than bailing, then proceed.
exec 8>/tmp/cybills-deploy.lock
if ! flock -w 600 8; then
  echo "[deploy] could not acquire deploy lock after 600s — aborting"
  exit 1
fi

# --- Frontend: build into a STAGING dir, never the live one ----------------
# Vite empties its outDir before writing, so building straight into the live
# `dist/` means any interruption leaves the site with no index.html -> nginx
# 500. We build into `dist.new`, verify it, then swap it into place atomically
# only after the backend is ready. The live `dist/` is untouched until the swap.
echo "[deploy] frontend: install + staged build (dist.new)"
npm ci --no-audit --no-fund
rm -rf dist.new
npm run build -- --outDir dist.new --emptyOutDir

# Guard: never publish a build that lacks an entry point.
if [ ! -s dist.new/index.html ]; then
  echo "[deploy] FATAL: staged build missing dist.new/index.html — live site left untouched"
  rm -rf dist.new
  exit 1
fi

echo "[deploy] backend: install + compile"
(
  cd server
  npm ci --no-audit --no-fund
  npm run build
)

echo "[deploy] restart backend"
systemctl restart cybills-backend.service

# --- Publish frontend: atomic swap -----------------------------------------
# Two renames on the same filesystem; the window where `dist/` is absent is
# sub-millisecond. Keep the previous build as dist.prev so we can roll back.
echo "[deploy] publish frontend (atomic swap dist.new -> dist)"
rm -rf dist.prev
if [ -d dist ]; then mv dist dist.prev; fi
mv dist.new dist

echo "[deploy] reload nginx"
systemctl reload nginx

# --- Health check + auto-rollback ------------------------------------------
echo "[deploy] health check"
sleep 1
site_code=$(curl -fsSL -k -o /dev/null -w '%{http_code}' \
  --resolve "$PUBLIC_HOST:80:127.0.0.1" --resolve "$PUBLIC_HOST:443:127.0.0.1" \
  --max-time 20 "http://$PUBLIC_HOST/" 2>/dev/null || echo 000)
# Any HTTP status from the backend port (even 404) proves it's listening;
# 000 = connection refused = the service didn't come back up.
backend_code=$(curl -sS -o /dev/null -w '%{http_code}' \
  --max-time 10 "http://127.0.0.1:${BACKEND_PORT}/api/health" 2>/dev/null || echo 000)
echo "[deploy] health: site=$site_code backend=$backend_code"

if [ "$site_code" != "200" ]; then
  echo "[deploy] HEALTH CHECK FAILED (site=$site_code) — rolling back frontend"
  if [ -d dist.prev ]; then
    rm -rf dist.bad
    mv dist dist.bad
    mv dist.prev dist
    systemctl reload nginx
    recheck=$(curl -fsSL -k -o /dev/null -w '%{http_code}' \
      --resolve "$PUBLIC_HOST:80:127.0.0.1" --resolve "$PUBLIC_HOST:443:127.0.0.1" \
      --max-time 20 "http://$PUBLIC_HOST/" 2>/dev/null || echo 000)
    echo "[deploy] rolled back to previous dist (site now=$recheck); failed build kept in dist.bad"
  else
    echo "[deploy] no dist.prev available to roll back to"
  fi
  exit 1
fi

if [ "$backend_code" = "000" ]; then
  echo "[deploy] WARNING: backend not responding on :${BACKEND_PORT} (static site OK) — investigate cybills-backend.service"
  exit 1
fi

echo "[deploy] done at $(date -u +%FT%TZ) — health OK (site=$site_code backend=$backend_code)"
