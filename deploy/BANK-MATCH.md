# Bank match (with CYWorkspace's auto bank reconciliation)

CYWorkspace (CYWS) runs **auto bank reconciliation**: n8n pulls a client's Xero
*Bank Reconciliation* report, CYWS reads the "Plus Unreconciled Statement
Lines" block, matches each line to the vendor bill or customer invoice it
settles (PV number → invoice number → learned alias → keyword → AI), and posts
the confident ones to Xero as payments dated to the statement. What it cannot
settle it hands back as `not_posted`.

Most of those lines pay a document that is still only in CYBills — read, coded,
maybe marked Ready, never published — because as far as Xero is concerned that
bill does not exist. CYWS already looks past the ledger to Dext's review pile
for the invoice behind a line; this is the same look into CYBills, and it closes
the loop from both ends:

```
                 Xero Bank Reconciliation report (n8n)
                              │
                              ▼
        CYWS auto bank recon: settle each line against a Xero bill
                              │
             lines it could not settle (no_match, low confidence…)
                              │
       ┌──────────────────────┴──────────────────────────┐
       ▼                                                 ▼
 CYWS keeps looking                              CYBills asks for them
   GET  /api/payments/bank-candidates              GET https://cyworkspace…/api/webhooks/
        ?tenant_id=…            (X-API-Key)             cybills/bank-recon/outstanding?tenant_id=…
   ← every CYBills document a line could pay       ← the outstanding lines
   CYWS matches with its own engine                CYBills suggests the document each pays
   POST /api/payments/bills/<id>/settle            a person presses Match (Bank tab)
       └──────────────────────┬──────────────────────────┘
                              ▼
   CYBills publishes the document AUTHORISED (if not yet in Xero) and records a
   PAYMENT against it from the bank account, on the statement date, for the
   statement amount, carrying the bank's reference — the same act either way
                              │
                              ▼
   Xero's reconciliation matches the statement line to that payment (Dext's
   Bank Match does exactly this when an item is matched)
```

Everything machine-to-machine is on the **same `X-API-Key`** the WhatsApp and
payables routes use (`CYBILLS_API_KEY` at the CYWS end, `WHATSAPP_INBOUND_KEY`
here), and CYBills calls CYWS with `CYWORKSPACE_API_KEY`, the key the Xero relay
uses. Contract for the payables routes this sits beside: `deploy/PAYABLES.md`.

## What CYWS provides

One read-only route (`server/src/functions/cybillsBankRecon.ts` in
cyworkspace), so the Bank tab in CYBills can show the lines the last run left
outstanding for a client. The run records those lines as it goes, one entry per
report, so the route has something to say only after the first run since it
shipped:

```
GET https://cyworkspace.cy-bm.sg/api/webhooks/cybills/bank-recon/outstanding?tenant_id=<uuid>
    X-API-Key: <WEBHOOK_API_KEY>
```

```json
{
  "ok": true,
  "tenant": { "tenant_id": "…", "tenant_name": "Demo Co" },
  "retrieved_at": "2026-08-26T01:00:00.000Z",
  "reports": [{ "name": "DBS Current.xlsx", "retrieved_at": "2026-08-26T01:00:00.000Z" }],
  "lines": [{
    "id": 4,
    "date": "2026-08-20",
    "amount": -109.00,
    "currency": "SGD",
    "reference": "FAST A1 CONSULTANCY INV-9",
    "description": "A1 CONSULTANCY",
    "status": "no_match",
    "reason": "no_match",
    "confidence": 0,
    "contact": null,
    "bank_account_id": "acct-…",
    "bank_account_name": "DBS Current",
    "bank_account_currency": "SGD"
  }]
}
```

- **Which lines**: every unreconciled statement line from the tenant's most
  recent auto-bank-recon run(s) that CYWS did **not** post — its `not_posted`,
  whatever the reason (`no_match`, `below_min_confidence`,
  `ai_suggested_excluded`, `no_bank_account`, `already_paid`). Lines it posted
  (`posted`, `already_posted`) are not outstanding and are left out. One run per
  bank account is normal, so a tenant with three accounts answers with the union
  of its three latest reports; `reports` names them.
- **`amount` is SIGNED** as the report prints it: negative is money out. CYBills
  matches only money out against cost documents; money in is shown and can be
  ignored, never matched.
- **`bank_account_id`** is the Xero AccountID CYWS resolved for the line — off
  the report's own heading (`pickBankAccount`) or the PV snapshot — and `''`
  where it could not. CYBills lets a person pick one in that case.
  `bank_account_currency` may be omitted; CYBills then takes the tenant's base
  currency, which is what a statement is in.
- **`date`** is the statement's clearing date, `YYYY-MM-DD`. It becomes the
  Xero payment date, which is what lets Xero's reconciliation pair the line with
  the payment.
- The `key` CYBills works by is computed HERE from date + amount + reference
  (`lineKey` in `src/lib/bankMatch.js`), so CYWS need not mint one — but the
  reference must come back the same on every retrieval.

| Status | Body | Meaning |
|---|---|---|
| 200 | as above | `lines` may be `[]` — a client whose last run settled everything |
| 401 | `{error: "invalid_api_key"}` | |
| 404 | `{error: "tenant_not_found", available_tenants: […]}` | Same shape as the other webhooks (`resolveWebhookScope`) |
| 409 | `{error: "xero_not_connected"}` | |

CYBills tells a **bare** 404 (Express's "Cannot GET", no JSON body — an older
CYWS with no such route) apart from a JSON refusal, and says "CYWorkspace needs
updating" rather than "nothing outstanding". Until the route exists the Bank tab
shows that message and the matches already made; nothing else is affected.

## What CYBills offers CYWS

CYWS's `matchLines` calls both of these (`functions/cybillsBankMatch.ts` in
cyworkspace): after the Xero legs, every still-unmatched money-out line is
paired with a candidate — `matched_cybills`, with the pairing's confidence —
and a pairing confident enough for the run (or ticked on the review page) is
settled through the second route.

### `GET /api/payments/bank-candidates?tenant_id=<uuid>`

Every document in that Xero organisation's CYBills books that a statement line
could pay. **Wider than `GET /api/payments/bills`**, and the difference is the
point: the payables list leaves out a document marked PAID because a receipt in
a payment run pays the supplier a second time, but a receipt marked paid is
exactly what a card line on the statement *is*, so it is offered here. A bill
already **published** but still awaiting payment is offered too — publishing is
not paying. What is still left out is what no bank line can pay: a credit note,
a document on an expense claim or merged away, one Xero already calls PAID, and
one CYBills has already settled against a line.

```json
{
  "ok": true, "tenant_id": "…",
  "organisations": [{ "id": "org-1", "name": "Demo Co" }],
  "candidates": [{
    "id": "bill_…", "item_id": "260822111522",
    "org_id": "org-1", "org_name": "Demo Co", "tenant_id": "…",
    "supplier": "Grab", "invoice_number": "", "reference": "",
    "date": "2026-08-21", "due_date": "2026-08-21",
    "currency": "SGD", "total": 28.30, "tax": 0,
    "base_currency": "", "base_total": null,
    "category": "493 - Travel - National", "description": "…", "document_type": "Receipt",
    "url": "https://cybills.cy-bm.sg/costs/260822111522?org=org-1",
    "has_file": true, "file_url": "https://cybills.cy-bm.sg/api/payments/bills/bill_…/file",
    "paid": true, "payment_method": "",
    "published": false, "xero_invoice_id": "", "xero_status": "",
    "postable": true, "blocked_reason": "", "account_code": "493", "tax_type": "NONE"
  }]
}
```

Match on the money first: a line and a document are the same money when
`|amount|` equals `total` in the document's `currency` to the cent — or, for a
foreign-currency document, equals `base_total` when the bank account is in
`base_currency` (the supplier printed what the money was worth, and that is the
figure the bank moved). Then the date window (a payment lands a few days before
the paper is dated at the earliest, and up to terms after), then the supplier's
name or `invoice_number` in the bank text. `src/lib/bankMatch.js` is CYBills'
own version of that judgement, if it is useful to mirror.

`postable: false` on an unpublished candidate means the settle would fail at
the publish step (`blocked_reason` says why — usually a category that is not in
the org's chart), so it is not worth proposing. A published one is always
settleable.

### `POST /api/payments/bills/<id>/settle`

```json
{
  "tenant_id": "…",
  "contact_id": "…",
  "line": {
    "date": "2026-08-21", "amount": -28.30, "currency": "SGD",
    "reference": "GRABPAY* SINGAPORE", "description": "",
    "bank_account_id": "acct-…", "bank_account_name": "DBS Current"
  }
}
```

`payment_date` / `signed_amount` / `bank_account_currency` are accepted as
aliases, so a CYWS `ReconLine` can be sent as it is. `contact_id` is optional
and follows the payables rule: when CYWS has made the Xero contact first (the
one carrying the payee's bank details), the bill is posted against it by ID;
otherwise it is posted by the supplier's name, as a publish from the app is.

What it does, in order: publishes the document **AUTHORISED** if it is not yet
in Xero (a payment needs that status, whatever the entity's own publish-status
setting says — the money has left the bank, which is as approved as a bill
gets); approves a bill that is already in Xero but still DRAFT/SUBMITTED (the
automatic publish-after-reading sends bills into an approval queue); records a
**Payment** against it — `Account` = the line's bank account, `Date` = the
statement date, `Amount` = the document's own figure in its own currency,
`Reference` = the bank's reference, `CurrencyRate` where the bank account's
currency differs (foreign-per-base, the same way round as the invoice's); reads
the bill back and records what Xero now says (Paid, the date, the reference);
turns the document's own Paid toggle on from that account; and remembers the
match.

```json
{ "ok": true,
  "invoice": { "invoiceId": "…", "invoiceNumber": "BILL-12", "status": "AUTHORISED", … },
  "published": { "lines": 1, "perLine": false, "attachment": { … } },
  "payment": { "paymentId": "…", "date": "2026-08-21", "amount": 28.30, "currency": "SGD", "reference": "GRABPAY* SINGAPORE" },
  "match": { "id": "bl_…", "key": "2026-08-21|-2830|GRABPAY* SINGAPORE", "billId": "…", "via": "cyws", … },
  "bill": { … } }
```

**Idempotent on the line.** A run re-pressed after a failure half way through
finds its earlier settlement — `200 { already_settled: true }` — rather than
paying it twice.

| refusal | meaning |
|---|---|
| `401 bad_key` | `X-API-Key` did not match |
| `400 missing_field` | no `tenant_id`, or no usable line (date, non-zero signed amount) |
| `409 tenant_mismatch` | the document belongs to a different client's ledger |
| `409 line_already_matched` | this line is already settled against ANOTHER document — undo that first (Bank tab) |
| `409 not_matchable` | on a claim, merged, a credit note, or Xero already says PAID |
| `422 money_in` | the line is money coming in |
| `422 amount_mismatch` | the figures differ — a payment for a different amount would leave a part-paid bill, so it is refused rather than posted |
| `422 no_bank_account` | the line names no bank account and none was picked |
| `422 no_account_code` / `account_not_in_chart` / `no_tax_code` / `line_items_unreconciled` | the publish step's own refusals (see PAYABLES.md) |
| `422 not_approved` | Xero would not move a DRAFT/SUBMITTED bill to AUTHORISED, in its own words |
| `422 payment_refused` | Xero rejected the payment, in its own words; `invoice_id` says the bill IS in the ledger now, so do not post it again |

## The Bank tab, for people

**Bank → Bank match** (Business Admin, like the Costs inbox): the outstanding
lines, each with the document CYBills thinks it pays. **Suggested** means the
money agrees to the cent, the date is in the window, and the bank text names
the supplier or the document number (or it is the only document at that figure
within a week). **To choose** means the money and the window agree but several
documents could be it — a person picks. **Match** does the settle above;
**Match all suggested** does every suggested one, one at a time, asking first.
**Undo** deletes the payment in Xero and puts the document's Paid toggle back
(the bill stays published). The eye-off **ignores** a line that is not a cost —
a transfer, a fee, payroll — so it stops being offered; nothing is written to
Xero for that.

CYWS keeps listing a line until the statement line is reconciled in Xero, so a
line CYBills has settled is shown as **Matched** rather than offered again
(`bank-lines` collection, keyed by `lineKey`). A matched line CYWS no longer
lists — reconciled at Xero's end — stays under "Show matched & ignored", because
its undo lives here.

## Environment (server/.env)

Nothing new. `CYWORKSPACE_RELAY_URL` + `CYWORKSPACE_API_KEY` are how CYBills
asks CYWS; `WHATSAPP_INBOUND_KEY` is what CYWS proves itself with here;
`APP_ORIGIN` gives the "Go to CYBills" link on a bill published by machine
(PAYABLES.md). Covered by `npm test` at the root (`bank-match`) and in
`server/` (`test/bank-match.test.mts`, over real HTTP against a stub standing in
for the relay and for CYWS).
