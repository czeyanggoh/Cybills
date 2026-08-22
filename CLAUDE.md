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

## The practice (CYBM) vs. its clients

CYBills is run BY an accounting practice FOR its clients, so there are two
kinds of person on the roster and they are not variations of one another:

- **Client employees** — belong to exactly one organisation (a linked Xero
  tenant), never see another, and carry the role their own admin gave them.
  This is the Users page (`/users`), which is tenant-scoped.
- **Colleagues** — the practice's own team (`/colleagues`). They belong to no
  single entity; they hold **client access** to the entities they work on, and
  are a **Business Admin** inside each one. Practice roles are Owner /
  Practice Admin / Standard; the first two also run the practice itself.

Server side: roster rows carry `practice` / `practiceRole` / `clientAccess` /
`allClients`, and the predicates that read them (`canAccessOrg`,
`effectiveRoleFor`, `canManagePractice`) live in `server/src/users.ts` next to
the rows. `server/src/practice.ts` is the practice-facing surface over them
(`/api/practice/colleagues`, `/api/practice/clients`). Access is enforced in
one place: an `X-Org-Id` guard in `index.ts` rejects any per-entity API call
naming a client the caller can't open, and `GET /api/organisations` returns
only the entities they may open (`?all=1`, practice managers only, returns
every linked entity for the client-access picker).

Env (server/.env): `PRACTICE_NAME`, `PRACTICE_DOMAIN` (only used to recognise
pre-existing rows as practice staff on first run), `PRACTICE_TIMEZONE`.

## The document reader: Claude or OpenAI

Uploaded receipts, invoices and Vault documents are read by one of two
interchangeable engines. `server/src/llm.ts` is the whole abstraction: it takes
a file + prompt + JSON schema and returns parsed JSON plus normalised token
counts, so `extract.ts` never branches on provider and a document read by either
comes back in one shape. Notable differences it papers over:

- OpenAI's structured outputs are **strict** — every property of every object
  must be in `required` — so `strictify()` tightens a copy of the schema on the
  way out (Anthropic accepts the looser original).
- A reasoning model (`gpt-5*`, `o*`) spends part of its output budget thinking,
  so the cap is raised and `reasoning.effort` is sent only to those families.
- OpenAI counts cached tokens inside `input_tokens`; they're subtracted back out
  so the 0.1x cache rate isn't charged on top of the full input rate.

Which engine runs is decided per client entity in Business settings ->
Extraction -> **Document reader**, saved in the extraction-settings blob
(`readerProvider`: `'claude'` / `'openai'` / `''` = server default) and sent on
each request. `resolveProvider` has the last word server-side, so a saved choice
whose API key was later removed degrades to a working reader instead of failing
the read. The settings card only offers a provider whose key is present —
`GET /api/auth/status` returns `readerProviders` + `defaultReaderProvider`.

**Line items are their own pass.** `POST /api/costs/extract-lines` reads the
itemised table and nothing else — the general read gave line items three words
of schema description, which is how a "Balance brought forward" row ended up in
the grid as a charge. Its prompt names the rows that are NOT charges, and the
server adds the lines up against the document's own grand total before
returning them: a set that doesn't reconcile is re-read once, told what it got
wrong, and only the better of the two answers is kept. What comes back carries
`reconciled` + `linesTotal` + `grandTotal`, so the caller can say so out loud
rather than pasting rows that don't add up. `npm test` in `server/` runs that
path end to end against a stubbed reader.

**One GST figure becomes per-line GST.** Nearly every SG invoice prints its rows
excluding GST and states it once at the foot ("SUB TOTAL / GST 9% / TOTAL"), so
the rows add up to the SUBTOTAL — and a reader told to make them add up to the
total will load the whole GST onto the last row. The reader is asked for the
summary block (`subTotal` / `taxTotal` / `grandTotal`) and told to leave per-row
tax at 0 unless the document prints it; the server then shares the stated figure
across the rows by net (`apportion` in `store.ts`, largest remainder, so the
parts sum to the whole exactly). Rows printed gross have it taken back out
instead, and a document that breaks tax down per row is left as printed.

Env (server/.env): `ANTHROPIC_API_KEY` + `ANTHROPIC_EXTRACT_MODEL` (default
`claude-sonnet-5`), `OPENAI_API_KEY` + `OPENAI_EXTRACT_MODEL` (default `gpt-5`),
`OPENAI_REASONING_EFFORT` (default `low`), optional `OPENAI_BASE_URL` for an
OpenAI-compatible gateway, and `LLM_PROVIDER` for the deploy-wide default.
Either key alone switches extraction on; both means the toggle appears.

**A bill's own lines can reach Xero.** Line items carry `project` + `project2`
— the org's two Xero tracking categories, per line, editable in the grid and
offered only where the linked org actually has that category. On publish,
`perLineItems` (`xero.ts`) posts those rows as the Xero bill's line items
instead of one summary line, each with its own account code and tracking. It
does so ONLY when the rows are provably the same money as the document: they
add up to its total, and their tax adds up to its tax (a single stated GST
figure is apportioned across the rows by largest remainder, so the parts sum to
the whole exactly). Anything that can't reconcile posts as the single summary
line — a nicer breakdown is never worth changing a published total. Line items
that CONTRADICT the document (they don't add up to its total, or their tax
doesn't add up to its tax) are refused outright, 422, in the dialog and in the
API: a breakdown that disagrees with its own paper is a mistake to fix, not to
post around. Covered by `npm test` in `server/`.

## The Costs inbox's bulk actions

The toolbar's **Actions** menu is everything you can do to a SELECTION, in one
place (Dext's shape). Beyond move/archive/claim/delete it carries **Bulk edit**
(`BulkEditModal.jsx`), Mark as paid / not paid, a bulk **Re-read**, **Publish to
Xero**, and Export/download over just the ticked rows.

Two rules run through all of them:

- **A tick is what makes a field part of the edit.** An untouched field is not
  sent, so "code these forty receipts to Entertainment" can't also blank forty
  different suppliers. Ticking a field and leaving it empty clears it on purpose.
- **A document already published to Xero is left alone**, and the result says how
  many were skipped. Its figures are in the ledger; editing the copy here would
  only make the two disagree.

Changing a field never sets a status: the server re-derives ready vs inbox from
completeness (`reconcileReadiness`), so bulk-coding a category moves those
documents to Ready by itself. A bulk tax-rate change computes each document's tax
from its OWN total, the same sum the inline Tax rate cell does.

**Re-reading is decided in one place.** `src/lib/reRead.js` (`readDecisions`) owns
the precedence a re-read applies — supplier rule, then the document's own printed
due date, then this read, then what the document already carried (a hand-edited
tax rate, existing line items are never clobbered). The document page's single
re-read and the inbox's bulk one both call it, so they can't drift. The bulk run
goes one document at a time: each read is a model call billed to that client
entity. Publishing in bulk is as conservative as the automatic publish — it skips
rather than guesses (already published, on an expense claim, incomplete, or a
category that isn't in the org's chart) and the server enforces the same gates
again.

## AI API spend

Every model call records its token usage (`server/src/usage.ts`), attributed to
the client entity it was made for and priced at the published per-model rates —
Claude and OpenAI models are both in the table. Practice -> Clients shows today's
and month-to-date cost per client. There is no billing API behind this — it is an
estimate from real token counts. Override a rate with
`LLM_PRICES='{"gpt-5":{"input":1.25,"output":10}}'` (`ANTHROPIC_PRICES` still
works; the two are merged).

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
