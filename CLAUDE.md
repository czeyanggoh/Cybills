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

**A person has one name, and a document has an owner.** `createdBy` on a bill is
who UPLOADED it — always an email, never overwritten. The Document owner (the
Costs "User" column, the drawer's picker, the detail field) is its own field,
`owner`, also always an email, and reassigning it leaves the uploader alone.
They were one field until both write paths started storing a display name in it,
which is how a single colleague came to appear twice in one list — "Cze Yang
Goh" on the documents whose owner had been set, "czeyang.goh" on the rest.
Names are resolved through `GET /api/users/directory` (`peopleForOrg`), which is
deliberately WIDER than the roster `GET /api/users` serves: the roster is a
client entity's own employees, but most of its documents are uploaded by a
practice colleague, who is on no client's roster. `emailForPerson` resolves
either spelling to the one email and refuses to guess an ambiguous name; the
rows written before the split are repaired on the next listing (`backfillOwners`
in `bills.ts`). Covered by `npm test` in `server/`.

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
offered only where the linked org actually has that category. `project` is also
READ per line: `extract-lines` is given the org's project list and asks which
one each row is for, taken from what the row names or from the section heading
above it (one laundry invoice bills Tangs, Vivo City and Four Seasons in three
blocks — every row on the document's single project would throw that away).
`project2` is set by hand. On publish,
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

**A read outlives the page that started it.** Reading takes ten to thirty
seconds and a reviewer moves on to the next document rather than watching it, so
a re-read / extract-lines runs as a JOB held at module scope
(`src/lib/extractionJobs.js`), not in the detail page's state. The request was
never cancelled — but everything that KNEW about it died with the page, so the
answer landed on the server while the form still showed the old fields, and the
next keystroke saved those back over it. The job now carries on, the page shows
"Reading…" again whenever it returns to that document, and when the job settles
the page takes the document back from the server rather than trusting what is on
screen. One read per document at a time. A full browser reload still kills it —
that aborts the request itself.

## Merge detection: which uploads are really one document

Two separate uploads are often one cost, and the two ways that happens do not
look alike, so `src/lib/mergeDetect.js` looks for both:

- **Pages of one document** — page 1 (supplier, reference, date) and page 2
  (line items, totals), e.g. a forwarded order confirmation screenshotted in
  halves. SAME supplier.
- **A payment papered twice** — the merchant's itemised receipt and the card
  slip for it. Same total, DIFFERENT suppliers.

The distinction between "pages of one document" and "the same document uploaded
twice" is **complementarity**: pages fill each other's blanks, a re-upload
repeats them. So a page pair needs compatible suppliers, nothing that both
documents state contradicting (total / reference / date / card), at least one
substantive field present on exactly one side, and a positive tie (a shared
reference, a shared total, or the same supplier uploaded in one go) — that last
one is what stops two half-read documents pairing just for being incomplete.

When the reader gets NOTHING off one half (a blank row — no supplier, total,
date or reference), there is no shared fact left to tie it with, so provenance
carries it: arriving in the same upload as the other half. That evidence is much
weaker, so such a pair is **provisional** — offered only where each side has
exactly one candidate. Several blank rows in one upload is genuinely unknowable
and gets nothing rather than a guess; the rows wear a **"Nothing read"** badge
instead, so the reviewer can re-read the document (Cost detail → Re-read) or
pick the two halves by hand.

So three passes, strongest evidence first, and they never chain into each other:
pages tied by a shared fact (these DO chain — a three-page document is one
group), then provisional blank pairs, then a receipt with its card slip. The
last two are forced-choice only, so three documents at one total is left to the
reviewer. Detection runs continuously over the inbox in `Costs.jsx`
(`mergeGroups`), so a row wears a badge instead of the reviewer having to press
a button; nothing is combined until the merge review modal is confirmed.

**Neither scan is a button any more.** Merge detection already ran on every
change; the whole-book duplicate check now does too — `autoScanDuplicates` in
`bills.ts`, off the listing endpoint, guarded by `bookRevision()` so an
unchanged book costs nothing and honouring Duplicate items = Off. It matters
because a document often becomes a duplicate AFTER it was uploaded (the second
copy arrives later, or an edit makes two rows agree), which the read-time check
can never see and a button only catches when somebody remembers to press it.
The toolbar keeps only the review affordances — "Merge suggestions (N)" and
"Review duplicates (N)", each shown only when there is something to review.
`npm test` at the repo root runs the rules.

**Input tax is claimed only on evidence.** GST is recorded only when the
SUPPLIER quotes a Singapore GST registration number and the document calls the
tax GST. The numbers can't settle it — Thailand's VAT is 7% and Malaysia's SST
8%, exactly Singapore's 2022 and 2023 rates — so the reader extracts
`supplierGstRegNo` + `taxLabel` and `claimableSgGst` decides: a UEN or M-number
(OVR counts) plus a tax the document doesn't call VAT/SST/Sales Tax. Without
that the document codes to No Tax and the tax amount is NOT recorded — it stays
inside the cost, which is what foreign tax is. The total never changes.

**A tax code is chosen, or the blank says why.** `src/lib/taxRateRules.js` (pure,
re-exported by `extractionSettings.js`, tested by `npm test`) decides in order:
the ACCOUNT's own default tax code in Xero when the printed GST matches its rate
— what Xero's own UI does, and the only route that can legitimately reach a code
arithmetic must not guess, e.g. an account defaulting to Disallowed Expenses at
9%; then the standard-rated vintage at that percentage; then No Tax for a
foreign-currency document whose rate isn't in the chart. Import GST, reverse
charge and partial exemption all print as a percentage too, so anything else is
left for a human — but only when the rate isn't a standard one at all. A
standard rate always answers: `INPUTY24` IS 9% standard-rated purchases in every
Singapore Xero (7% `INPUT`, 8% `INPUTY23`; `OUTPUT*` on the sales side), so when
an org has written no rule and its visible list can't supply the code — switched
off in Lists, or not loaded — the standard code for the printed rate is used
anyway, named the way that org names it when the unfiltered list can say.
Nothing is silent either way: `taxRateOutcome` returns a `reason`, and a decline
names the rate, what IS visible at it, and points at Business settings → Lists →
Tax rates. A blank field with no explanation is
indistinguishable from a bug, which is exactly how one was reported.

## The Costs inbox's bulk actions

Every bulk action is a **button**. The "Move to" and "Actions" dropdowns this
replaced were a menu of things that are each one click on their own, so reaching
them took a second click and a hunt through a list. The row wraps instead.

Beyond archive/claim/merge, the toolbar carries **Bulk edit**
(`BulkEditModal.jsx`), **Rerun processing**, **Publish to Xero**, and **Delete**
(red — it drops the stored file too, and confirms first). One **Export** button
covers both cases: the ticked rows when anything is ticked, otherwise everything
the tab shows.

Mark as paid / not paid and Move to review / ready are NOT there. Paid is a
field, set on the document or across a selection in Bulk edit; readiness is
derived, so a "Move to ready" button could only ever agree with the server or
be overruled by it a moment later.

**Ready and To review are both derived, and between them they are the whole
inbox.** `src/lib/readiness.js` (pure, tested by `npm test`) decides from the
document, never from its stored status: a cost carrying a Supplier, Date,
Category and a Total above 0 is Ready; every other inbox document is waiting on
a person — most often for the account code the reader could not choose. To
review used to be a STATUS only the toolbar could write, so a document needing
attention landed there only if somebody had already noticed it and pressed the
button. Rows in To review wear a **"Needs: …"** badge naming the missing fields
(`missingFields`), except where "Nothing read" already says it better.

Two rules run through all of them:

- **A tick is what makes a field part of a bulk edit.** An untouched field is not
  sent, so "code these forty receipts to Entertainment" can't also blank forty
  different suppliers. Ticking a field and leaving it empty clears it on purpose.
- **A document already published to Xero is left alone**, and the result says how
  many were skipped. Its figures are in the ledger; editing the copy here would
  only make the two disagree.

Changing a field never sets a status: the server re-derives ready vs inbox from
completeness (`reconcileReadiness`), so bulk-coding a category moves those
documents to Ready by itself. A bulk tax-rate change computes each document's tax
from its OWN total, the same sum the inline Tax rate cell does.

**Rerun processing reads the documents again**, and the precedence it applies is
decided in one place: `src/lib/reRead.js` (`readDecisions`) — supplier rule, then
the document's own printed due date, then this read, then what the document
already carried (a hand-edited tax rate, existing line items are never
clobbered). The document page's single re-read and the inbox's bulk one both call
it, so they can't drift. It exists because a first read can come back with
nothing — a dark photo, a PDF that is really a scan — leaving the document in the
inbox as "Unknown supplier / 0.00" with no way forward but typing it in; it is
also how a supplier rule written AFTER the upload reaches the documents it was
written for. A read that comes back with neither a supplier nor a total is
reported as such rather than counted as a success: twice blank is the FILE's
fault, and running it a third time won't help. The run goes one document at a
time — each read is a model call billed to that client entity.

Publishing in bulk is as conservative as the automatic publish: it skips rather
than guesses (already published, on an expense claim, incomplete, or a category
that isn't in the org's chart), asks first because it writes to a live ledger,
and the server enforces the same gates again.

## Links that leave the app

An exported CSV's Image column, and the Item IDs in a claim PDF, are opened
OUTSIDE CYBills — by an accountant with the file in Excel, by an approver who
was emailed the claim. They used to be the bare file URL, which only worked
because `/api/costs/bills/:id/file` skipped the session guard on the reasoning
that a bill id is an unguessable capability token. An Item ID is a TIMESTAMP
(`260826113257`), so it isn't: a day of one client's receipts could be
enumerated by counting.

So the capability is explicit now. `server/src/shareLinks.ts` signs a token that
names one document and expires (30 days); `POST /api/costs/share-links` mints
them a batch at a time, and only for documents the caller can already read.
Whether they're minted at all is the entity's own decision — Business settings
-> Exports -> **Image sharing**, Dext's toggle, on by default — and that
decision is read again on every request, so switching it off revokes the links
already sitting in somebody's spreadsheet. Without a signed link the CSV's Image
column is blank and a claim PDF's Item ID points at the document page instead.
Covered by `npm test` in `server/`.

## AI API spend

Every model call records its token usage (`server/src/usage.ts`), attributed to
the client entity it was made for and priced at the published per-model rates —
Claude and OpenAI models are both in the table. Practice -> Clients shows today's
and month-to-date cost per client. There is no billing API behind this — it is an
estimate from real token counts. Override a rate with
`LLM_PRICES='{"gpt-5":{"input":1.25,"output":10}}'` (`ANTHROPIC_PRICES` still
works; the two are merged).

## A bridge entity (Red Alpha - ST Engineering)

Some people who submit costs don't work for any client entity CYBills holds. ST
Engineering staff claim against **Red Alpha's** ledger without being Red Alpha
employees, and they have never seen a chart of accounts. So an entity can be
**standalone**: `kind: 'standalone'` + `parentOrgId` on the organisation record,
no Xero tenant of its own, its own isolated Costs book (`dataScopeForOrg` gives
it one for free), and its claims posting into the parent's Xero
(`publishTargetFor`). `requireOrganisation` refuses the chart/tax/contact routes
for it with `no_xero_connection`; `requirePublishTarget` is the one that resolves
the parent, and publishing is the only Xero thing it can do.

**Its categories are plain names.** "Transport - Taxi", "Meal Weekday (after
9pm)" — the rows off the client's own claim form. The list and the add/hide
rules live in one pure module (`src/lib/categoryList.js`) because BOTH sides
read it: the dropdown (`useCategoryOptions`) and the document reader, including
the emailed-document path, which loads it by file path
(`server/src/categories.ts`, same arrangement as `taxRules.ts`). The reader is
given the names instead of accounts (`categories` on `/extract` +
`/extract-lines`, which no client had ever sent) plus a guide for what a plain
name MEANS — the mode a transport receipt names, the date and time deciding a
weekday-late meal from a weekend one, "Others" rather than the closest-sounding
guess.

**" - " does not mean "code - name".** Half the claim-policy names contain that
separator, and the old split read "Transport - Taxi" as the account code
"Transport": a code no chart has, on a line that would post to the wrong place,
and a Name-only dropdown showing a column of unrelated categories all called
"Taxi", "Train", "Bus". A code always has a digit in it — `categoryCode` /
`categoryName` / `categoryCodeEnd` in `categoryList.js` decide it once, for the
display path and the publish path both (`codeFromCategory` in `xero.ts` applies
the same rule server-side). Covered by `npm test` at the repo root.

**The map is what lets it publish.** One setting per bridge entity,
`cybills.category-accounts.v1`, `{ "Transport - Taxi": "493" }`, edited on Lists
-> Categories -> **Posts to** against the PARENT's accounts. `publish-claim`
consults it first and falls back to the label's own digits, so a linked entity
is unaffected. An unmapped category is refused (422, `unpostable_lines`) and
NAMED — never posted around, the same rule a bill's own line items follow — and
the message says to map it rather than to "use a coded category", which would
send those people looking for a chart they don't have. `npm test` in `server/`
posts a bridge claim end to end against a stubbed relay.

Still to do: a user who works in two entities (`extraAccess` on the roster row)
— today access is per-entity equality, so a bridge user is a separate roster
row. And privilege enforcement inside the entity is `docs/roles-enforcement.md`,
which is deliberately untouched here: until it lands, everyone in a bridge
entity sees every document in it. Fine for testing, not for real ST Eng staff.

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
