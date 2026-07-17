# CYBills — Claude working notes

## Repo basics

- Vite + React (JS, not TS in `src/`); TypeScript on the server side
  (`server/src/**/*.ts`)
- Tailwind, eslint, components.json (shadcn-style, new-york)
- Subdirs: `src/` (frontend), `server/` (backend), `scripts/`, `deploy/`
- Default branch: `main`
- Remote: `https://github.com/czeyanggoh/Cybills`
- Public host: `cybills.cy-bm.sg`; backend port `3004`
  (cyworkspace=3001, rejs=3003)

## ALWAYS sync with origin before editing

Before making ANY change (Edit / Write) to a file in this repo, run:

```bash
git fetch --quiet
git status -sb
```

Then act based on result:

- **Up to date, clean tree** → proceed.
- **Behind origin (no local commits/changes)** → pull (or re-clone) so you're
  not acting on stale state, then proceed.
- **Local commits ahead of origin** → STOP. Surface them
  (`git log origin/main..HEAD --oneline`) and ask whether to push first.
- **Uncommitted local changes** → STOP. Call them out (`git status` /
  `git diff`) before overwriting.
- **Diverged** → STOP and let the user choose rebase/merge/discard.

## Xero via the cyworkspace relay

CYBills never holds Xero credentials. All Xero traffic goes through
cyworkspace's authenticated relay
(`ANY /api/webhooks/xero-relay/<XeroPath>?tenant_id=<UUID>`, `X-API-Key`
header) — cyworkspace owns the OAuth client, token refresh, and 429 retries.
Server-side consumer lives in `server/src/xero.ts`; organisations (client
entities linked to a Xero tenant) in `server/src/organisations.ts`.

Env (server/.env): `CYWORKSPACE_RELAY_URL` (on the VPS use
`http://127.0.0.1:3001` — both apps share the box) and `CYWORKSPACE_API_KEY`
(same value as cyworkspace's `WEBHOOK_API_KEY`). Xero endpoints 503 until the
key is set, so deploys are safe before the env is configured.

## Push policy: auto-deploy enabled

The operator has granted standing authorization to push to `main` after each
cohesive commit (see the global auto-push memory). **Each push to `main` is a
real production deploy** to cybills.cy-bm.sg — treat every push as shipping to
prod.

Deploys are **pull-based**, not GitHub-Actions-based. The VPS runs a
long-running daemon (`scripts/auto-deploy-poll.sh`, the
`cybills-autodeploy` systemd service) that polls `origin/main` over outbound
HTTPS every ~1 min; when it advances it `git reset --hard` + runs
`scripts/deploy.sh` (build + restart + health check). So a push lands on the
box within ~1 minute with **no GitHub Actions run** — don't wait on
`gh run list` to confirm a deploy; there won't be one.

Guidelines:

- Push after a complete, self-contained change (don't push half-done work).
- Type-check before pushing if server-side TS changed
  (`cd server && npm run build`).
- If a change is destructive (ENV, breaking API), surface it for explicit
  confirmation before pushing.
- Never `git push --force` or push to `main` from a half-merged state.

To revoke this authorization, the operator removes this section.
