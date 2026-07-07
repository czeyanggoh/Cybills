# Deployment

CYBills deploys **pull-based**: the VPS polls GitHub over outbound HTTPS and
deploys itself when `origin/main` advances. No inbound SSH to the box is
required, so there's no GitHub Actions run to watch — a push to `main` lands on
the box within ~1 minute.

## How it works

- `scripts/auto-deploy-poll.sh` — a long-running **daemon**. Every ~1 min:
  `git fetch origin/main`; if it advanced, `git reset --hard` +
  `scripts/deploy.sh`. Silent unless it actually deploys.
- `deploy/systemd/cybills-autodeploy.service` — the systemd service that runs
  the daemon. After each deploy it re-execs so a change to itself takes effect
  immediately.
- `scripts/deploy.sh` — build frontend (staged `dist.new` → atomic swap) +
  build/restart backend + nginx reload + health check with auto-rollback.
  Guarded by a `flock` so triggers can't overlap.

## One-time setup (on the VPS, as root)

```bash
# 1. Clone the repo to /opt/cybills
sudo git clone https://github.com/czeyanggoh/Cybills.git /opt/cybills

# 2. Install nginx site + TLS
sudo cp /opt/cybills/scripts/nginx-cybills.conf /etc/nginx/sites-available/cybills
sudo ln -s /etc/nginx/sites-available/cybills /etc/nginx/sites-enabled/cybills
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d cybills.cy-bm.sg

# 3. First build so dist/ exists, then install the services
cd /opt/cybills && npm ci && npm run build
cd /opt/cybills/server && npm ci && npm run build
sudo bash /opt/cybills/scripts/install-auto-deploy.sh
```

Verify:

```bash
systemctl status cybills-backend.service --no-pager
systemctl status cybills-autodeploy.service --no-pager
journalctl -u cybills-autodeploy.service -f   # watch a deploy happen
```

- **Public host:** cybills.cy-bm.sg
- **Backend port:** 3003 (cyworkspace=3001, rejs=3002)
- **App dir:** /opt/cybills
