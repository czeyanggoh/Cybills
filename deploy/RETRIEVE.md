# Retrieve: signing into supplier portals (Costs → Retrieve)

Some suppliers never send the bill. SP Group's is on its customer portal, and
somebody has to sign in each month to download it. **Costs → Retrieve** keeps an
entity's login for each such portal and hands it to an **n8n workflow**, which
signs in, downloads the invoices and answers with them. CYBills files each one
into the Costs inbox and reads it like an upload.

```
Costs → Retrieve → "Retrieve now", or the login's schedule
        │   POST $N8N_RETRIEVE_URL      (X-API-Key: $N8N_API_KEY)
        ▼
n8n:  sign into the portal as `username` / `password`
      download the invoices dated after `last_invoice_date`,
      not before `retrieve_from`, and not in `known_references`
        │   200 [{ fileName, invoice_number, invoice_date, pdf_base64 }, …]
        ▼
CYBills:  file each new document into the entity's Costs inbox, then read it
```

## Server env (`server/.env`)

```
N8N_RETRIEVE_URL=https://n8n.cy-bm.sg/webhook/portal-retrieve
N8N_API_KEY=<shared with N8N_FETCH_URL; sent as X-API-Key>
N8N_RETRIEVE_TIMEOUT_MS=300000        # optional; default 5 minutes (a held-open answer)
N8N_RETRIEVE_CALLBACK_MS=1800000      # optional; default 30 minutes (a 202 then callback)
```

`N8N_RETRIEVE_URL` defaults to `https://n8n.cy-bm.sg/webhook/portal-retrieve`,
so it needs setting only to point elsewhere. Set it EMPTY (`N8N_RETRIEVE_URL=`)
to switch retrieval off: logins can still be saved and the page says retrieval
is not switched on. `SESSION_SECRET` must be set (it always is in production): the passwords
are sealed with a key derived from it, and **changing it makes every saved
portal password unreadable** — the page then asks for each to be entered again.

## The request CYBills sends

`POST $N8N_RETRIEVE_URL`, JSON, every field in snake_case **and** camelCase:

| field | meaning |
|---|---|
| `portal` | which recipe to run: `spgroup`, or `other` |
| `portal_name` | what a person calls it ("SP Group") |
| `login_url` | for `other` only: the sign-in page somebody typed |
| `username` | the login's username / email |
| `password` | the password, opened for this one request |
| `account_ref` | optional account number, where one login holds several accounts |
| `login_id`, `run_id` | to correlate a run (screenshots, logs) |
| `last_retrieved_at` | ISO time of the last run that succeeded, `''` on the first |
| `last_invoice_date` | ISO date (`2026-10-05`) of the newest invoice this login has filed, `''` on the first run — **retrieve only invoices dated after it** |
| `retrieve_from` | ISO date the login's **Retrieve invoices from** names, `''` = no limit — **never retrieve an invoice dated before it** |
| `known_references` | invoice numbers this login already filed — skip these |
| `xero_name`, `tenant_id` | which client's book it is for |
| `callback_url` | where to POST the invoices instead of answering with them (see below) |
| `callback_token` | the one-time token that callback must carry, as `X-Callback-Token` |

**Never log the request body** — it carries the password. The workflow should
not keep it either: it is sent fresh on every run.

## Answering now, or calling back (recommended)

A portal sign-in takes minutes, so the workflow need not hold CYBills' request
open for it. Either:

- **Answer with the invoices** (the shapes below), as before. Fine for a quick
  portal, but the request stays open for the whole sign-in.
- **Answer `202` straight away** (or `200 { "accepted": true }`) — in n8n, a
  Webhook node set to *Respond: Immediately* — then, when it is done, **POST the
  same answer to `callback_url`** with the header
  `X-Callback-Token: <callback_token>` (or `callback_token` in the JSON body).
  A refusal is `{ "ok": false, "error": "Login failed: incorrect password" }`.
  CYBills answers the callback `202`; a wrong token or an unknown run is `404`,
  and a second callback for a run already settled is `409`.

The run shows as running until the callback lands, for up to
`N8N_RETRIEVE_CALLBACK_MS` (default 30 minutes), after which it is shown as
failed ("never posted the invoices back"). Nobody needs to stay on the page.
`callback_url` is the host the button was pressed on, or `APP_ORIGIN`, else
`https://cybills.cy-bm.sg` for a scheduled run, so n8n must be able to reach
that host.

**CYBills sends one run at a time**, across every client: a second Retrieve
now, Retrieve all and the schedule all wait in one queue until the run before
them has settled — answered, failed, or called back — so n8n is never asked for
a second run while its browser is busy ("a run is already in progress").

## What the workflow answers

The same shapes the link fetch accepts (see EMAIL-INBOUND.md): a JSON array of
items, each carrying the file as base64 under `pdf_base64` (or `data`,
`contentBase64`, …) with a `fileName`, and ideally an `invoice_number` — that is
what stops a portal that regenerates its PDFs from filing the same invoice
twice. A streamed PDF body also works.

**Send each invoice's date too** (`invoice_date`, or `invoiceDate` / `bill_date`
/ `date`), as the portal lists it — `2026-10-05`, `05/10/2026` and `05 Oct 2026`
are all read. It is what the next run's `last_invoice_date` is worked out from:
the newest date the login has filed, taking the portal's own date where n8n gave
one and otherwise the date the reader took off the PDF. A date later than today
is ignored as a misread. Two invoices on the same day are safe whether the
recipe compares "after" or "on or after": `known_references` and CYBills' own
check still stop one being filed twice.

**Retrieve invoices from** is set per login in its dialog, so the first run does
not pull a portal's whole history. Both dates apply on every run: an invoice must
be dated after `last_invoice_date` (when there is one) and on or after
`retrieve_from` (when there is one). CYBills holds the second itself as well — an
item whose `invoice_date` is before it is not filed, and the run says how many
were left on the portal — so a recipe that ignores it costs a slower run, not a
book full of last year's bills. That check needs the item's `invoice_date`; an
item without one is filed.

- **Nothing new** → `200 []`, or `200 { "message": "No new invoices" }`. Shown
  as "Nothing new".
- **Refused** (wrong password, portal down, a recipe missing for an `other`
  portal) → a non-2xx with `{ "error": "Login failed: incorrect password" }`.
  The words are shown on the login as the reason the run failed.
- **The bytes decide**: an HTML page (a sign-in form the robot could not get
  past) is never filed, whatever it is labelled.

## Behaviour in CYBills

- Business Admin only, on the page and on every `/api/retrieve` route.
- The password is sealed at rest (AES-GCM), never returned to the browser,
  never logged, and deleted with the login.
- A run is a background job; the page polls, and nobody has to stay on it.
  Every run — a button, "Retrieve all", the schedule — goes through one queue,
  one at a time across every client.
- A document is skipped if this login filed the same bytes or the same invoice
  number before, or the entity already holds the same file.
- Retrieved documents are owned by the login's "File documents under" person,
  else the entity's general account, and carry `retrieved` (portal, login,
  username, invoice number) so where each came from is on record.
- A request from a scheduled run is identical to a button press — the workflow
  cannot tell them apart and does not need to.

## Scheduled runs

Each login has **Retrieve automatically** in its dialog: **Off** (the default),
**Every day**, or **Once a month** on a chosen day, at an hour in
`PRACTICE_TIMEZONE` (Asia/Singapore unless set). The card shows the schedule and
the day it next runs. The server checks every five minutes (no extra env):

- **At most once per practice day.** The day is recorded *before* the run
  starts, so a restart or a slow portal cannot start it twice.
- **Downtime is made up.** If the server was down over the scheduled hour, the
  missed run happens when it comes back — and that counts as the day's run.
  "The 31st" runs on the last day of a shorter month.
- **A failed run is not retried that day** (a wrong password retried every five
  minutes locks portal accounts). The reason shows on the login; it tries again
  at the next scheduled slot, or when somebody presses Retrieve now.
- **One at a time across every client.** Each run is a browser session on n8n's
  machine, so scheduled runs never overlap each other or a run somebody started
  by hand; whatever is still due waits for the next check.
- A slot from before the schedule was saved is not made up: one saved on the
  10th for "the 5th" first runs on the 5th of next month. (Saved on the day of
  its slot after the hour, it runs within five minutes.)
- With `N8N_RETRIEVE_URL` set empty nothing runs, and nothing is marked as run.

Covered by `npm test` in `server/` (`test/portal-retrieve.test.mts`,
`test/retrieve-schedule.test.mts`).
