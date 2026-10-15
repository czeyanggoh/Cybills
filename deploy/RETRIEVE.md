# Retrieve: signing into supplier portals (Costs → Retrieve)

Some suppliers never send the bill. SP Group's is on its customer portal, and
somebody has to sign in each month to download it. **Costs → Retrieve** keeps an
entity's login for each such portal and hands it to an **n8n workflow**, which
signs in, downloads the invoices and answers with them. CYBills files each one
into the Costs inbox and reads it like an upload.

```
Costs → Retrieve → "Retrieve now"
        │   POST $N8N_RETRIEVE_URL      (X-API-Key: $N8N_API_KEY)
        ▼
n8n:  sign into the portal as `username` / `password`
      download the invoices not in `known_references`
        │   200 [{ fileName, invoice_number, pdf_base64 }, …]
        ▼
CYBills:  file each new document into the entity's Costs inbox, then read it
```

## Server env (`server/.env`)

```
N8N_RETRIEVE_URL=https://n8n.cy-bm.sg/webhook/portal-retrieve
N8N_API_KEY=<shared with N8N_FETCH_URL; sent as X-API-Key>
N8N_RETRIEVE_TIMEOUT_MS=300000        # optional; default 5 minutes
```

Unset, logins can still be saved and the page says retrieval is not switched
on. `SESSION_SECRET` must be set (it always is in production): the passwords
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
| `known_references` | invoice numbers this login already filed — skip these |
| `xero_name`, `tenant_id` | which client's book it is for |

**Never log the request body** — it carries the password. The workflow should
not keep it either: it is sent fresh on every run.

## What the workflow answers

The same shapes the link fetch accepts (see EMAIL-INBOUND.md): a JSON array of
items, each carrying the file as base64 under `pdf_base64` (or `data`,
`contentBase64`, …) with a `fileName`, and ideally an `invoice_number` — that is
what stops a portal that regenerates its PDFs from filing the same invoice
twice. A streamed PDF body also works.

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
- A run is a background job; the page polls. "Retrieve all" works through the
  entity's logins one at a time.
- A document is skipped if this login filed the same bytes or the same invoice
  number before, or the entity already holds the same file.
- Retrieved documents are owned by the login's "File documents under" person,
  else the entity's general account, and carry `retrieved` (portal, login,
  username, invoice number) so where each came from is on record.

Covered by `npm test` in `server/` (`test/portal-retrieve.test.mts`).
