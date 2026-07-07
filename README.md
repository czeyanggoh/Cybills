# CYBills

Billing workspace for CY-BM. Deployed at **https://cybills.cy-bm.sg**.

## Stack

- **Frontend:** Vite + React (JS) + Tailwind, shadcn-style component conventions
  (`components.json`), path alias `@ -> src/`.
- **Backend:** TypeScript Express server in `server/` (port 3004).
- **Deploy:** pull-based auto-deploy on the VPS (see `deploy/README.md`).

## Layout

```
src/            frontend (React, JS)
  pages/        route components
  lib/          shared utils (cn, etc.)
server/         backend (Express, TypeScript)
  src/          entry (index.ts), env, routes
deploy/         systemd units + deploy docs
scripts/        deploy.sh, auto-deploy-poll.sh, nginx conf, installers
```

## Local development

```bash
# frontend (http://localhost:5173, proxies /api -> :3004)
npm install
npm run dev

# backend (http://localhost:3004)
cd server
cp .env.example .env
npm install
npm run dev
```

## Scripts

- `npm run dev` — Vite dev server
- `npm run build` — production build into `dist/`
- `npm run lint` / `npm run lint:fix`
- `npm run typecheck` — checkJs over `src/`

## Deploy

Push to `main`; the VPS poller picks it up within ~1 minute. See
[`deploy/README.md`](deploy/README.md).
