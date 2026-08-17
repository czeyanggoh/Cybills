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

## Account email via Microsoft Graph (delegated)

Invitations, password resets, and password-changed notices are sent from a
Microsoft 365 mailbox through Graph's `sendMail`, using **delegated** auth. The
Azure app registration holds Microsoft Graph **`Mail.Send`, Delegated type** —
deliberately NOT the Application permission, which is tenant-wide. Delegated
means CYBills can only ever send as the one account that consented, and can read
nothing.

Because a password reset is triggered by someone who isn't signed in, there's no
live session to borrow: an admin connects the mailbox once (Settings → Email,
OAuth code flow) and the refresh token is kept, encrypted at rest with a key
derived from `SESSION_SECRET`. A lapsed grant (password change, revoked consent)
surfaces as "Reconnect needed" rather than silent failure.

Server-side: `server/src/mailer.ts` (token redemption + `sendMail` + templates),
`mailAccount.ts` (sealed token store), `mail.ts` (connect/callback/disconnect/
test); the flows live in `server/src/users.ts` (invite / reset / change
password). Env (server/.env): `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`,
`GRAPH_CLIENT_SECRET`, `GRAPH_REDIRECT_URI`, optional `GRAPH_SHARED_SENDER`
(needs `Mail.Send.Shared` + Send As), `MAIL_REPLY_TO`, `INVITE_TTL_DAYS`. With
them unset, mail no-ops and invite/reset links are returned to the admin to
share by hand, so deploys are safe before the app registration exists. Setup
walkthrough: `deploy/EMAIL.md`.

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
