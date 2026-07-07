#!/usr/bin/env bash
# Pull-based auto-deploy DAEMON.
#
# Runs ON the VPS as a single long-running systemd service
# (cybills-autodeploy.service, Type=simple). It loops internally and is SILENT
# unless it actually deploys (or hits an error) — so systemd logs "Started"
# once at boot and the journal isn't spammed every minute.
#
# Each iteration: git fetch origin/main; if it advanced, reset --hard +
# scripts/deploy.sh (which holds its own flock). Outbound HTTPS fetch from the
# box is reliable, so no inbound connection to the VPS is needed.
#
# Pass --once to do a single poll (handy for manual "deploy now" / testing).
set -uo pipefail

APP_DIR=/opt/cybills
BRANCH=main
INTERVAL="${POLL_INTERVAL:-60}"   # seconds between polls; overridable via env

# One poll. Returns 10 when it deployed (so the loop can re-exec to pick up any
# change to THIS script), 0 otherwise (up to date / transient fetch failure).
poll_once() {
  cd "$APP_DIR" || { echo "[deploy-daemon] cannot cd $APP_DIR"; return 0; }
  if ! git fetch --quiet origin "$BRANCH"; then
    echo "[deploy-daemon] $(date -u +%FT%TZ) git fetch failed (transient) — retrying next tick"
    return 0
  fi
  local local_sha remote_sha rc
  local_sha=$(git rev-parse HEAD)
  remote_sha=$(git rev-parse "origin/$BRANCH")
  if [ "$local_sha" = "$remote_sha" ]; then
    return 0   # up to date — stay silent
  fi
  echo "[deploy-daemon] $(date -u +%FT%TZ) origin/$BRANCH ${local_sha:0:8} -> ${remote_sha:0:8} — deploying"
  git reset --hard "$remote_sha"
  bash scripts/deploy.sh; rc=$?
  if [ "$rc" -eq 0 ]; then
    echo "[deploy-daemon] $(date -u +%FT%TZ) deploy finished for ${remote_sha:0:8}"
  else
    echo "[deploy-daemon] $(date -u +%FT%TZ) deploy FAILED for ${remote_sha:0:8} (exit $rc) — fix and push a new commit"
  fi
  return 10
}

if [ "${1:-}" = "--once" ]; then
  poll_once
  exit 0
fi

echo "[deploy-daemon] started — polling origin/$BRANCH every ${INTERVAL}s (quiet unless deploying)"
while true; do
  poll_once
  if [ $? -eq 10 ]; then
    # A deploy just ran. Re-exec so any change to this daemon script in the
    # commit we just deployed takes effect immediately. exec keeps the same PID,
    # so systemd is unaffected.
    exec /bin/bash "$0"
  fi
  sleep "$INTERVAL"
done
