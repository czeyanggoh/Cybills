#!/usr/bin/env bash
# One-time setup for pull-based auto-deploy. Run ONCE on the VPS as root:
#
#   sudo bash /opt/cybills/scripts/install-auto-deploy.sh
#
# Installs a quiet long-running daemon that polls origin/main and runs deploy.sh
# when it changes. Safe to re-run.
set -euo pipefail

APP_DIR=/opt/cybills
UNIT_SRC="$APP_DIR/deploy/systemd"
UNIT_DST=/etc/systemd/system

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

echo "[install] installing backend service"
cp "$UNIT_SRC/cybills-backend.service" "$UNIT_DST/"

echo "[install] installing auto-deploy daemon service"
cp "$UNIT_SRC/cybills-autodeploy.service" "$UNIT_DST/"
systemctl daemon-reload
systemctl enable cybills-backend.service
systemctl enable cybills-autodeploy.service
# Use restart (not start) so re-running this picks up an updated unit file.
systemctl restart cybills-backend.service
systemctl restart cybills-autodeploy.service

echo "[install] done. Service status:"
systemctl status cybills-autodeploy.service --no-pager || true
echo
echo "Quiet by design — the journal only gets a line when it actually deploys."
echo "Live logs:   journalctl -u cybills-autodeploy.service -f"
echo "Restart:     systemctl restart cybills-autodeploy.service"
echo "Deploy now:  bash $APP_DIR/scripts/auto-deploy-poll.sh --once"
