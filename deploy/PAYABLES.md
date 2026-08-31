# Paying a CYBills bill from CYWorkspace

CYBills collects the paper and codes it. CYWorkspace (CYWS) runs the payment —
it holds the supplier's bank details, builds the bank upload file, and emails
the run out. Until now those two met only in Xero, and CYWS's **Bills Listing**
is built from `AUTHORISED` ACCPAY invoices — so a document CYBills had read,
coded and marked Ready but had not yet published simply did not exist as far as
a payment run was concerned.

These three routes are the seam.

```
CYWS Bills Listing
   │  GET  /api/payments/bills?tenant_id=<uuid>          what is waiting to be paid
   │  GET  /api/payments/bills/<id>/file                 the paper, to read the payee's
   │                                                     bank details off it
   ▼
CYWS creates the Xero CONTACT and saves BankAccountDetails on it
   │
   │  POST /api/payments/bills/<id>/publish
   │       { tenant_id, contact_id }                     ← the contact it just made
   ▼
CYBills posts the bill AUTHORISED against that ContactID and returns the invoice
   │
   ▼
CYWS builds the bank upload file, emails the run, records the payment
```

All three are machine-to-machine on the **same `X-API-Key`** CYWS already uses
for the WhatsApp routes (`CYBILLS_API_KEY` at the CYWS end,
`WHATSAPP_INBOUND_KEY` here). They are allowlisted past the session guard and
carry that key instead of a session.

## Two things that are easy to get wrong

**The contact must exist before the bill is posted, and the bill must name it by
ID.** Xero matches a contact by *name* when given one, and **creates** a new
contact when the name is new. So a bill published as `A1 Consultancy Pte Ltd`
against a contact CYWS created as `A1 Consultancy` lands on a *second* contact —
one with no bank details — and the payment file has nowhere to send the money.
`contact_id` is required for exactly this reason; there is no name fallback on
this route.

**Publish is the last step before the file, not the first step after ticking.**
Publishing writes an `AUTHORISED` bill into a live ledger. Do it when the run is
committed, so a bill that gets unticked leaves nothing behind for somebody to
void.

## `GET /api/payments/bills?tenant_id=<uuid>`

Every document in that Xero organisation's CYBills book that is waiting to be
paid. A tenant CYBills has never heard of answers `200` with an empty list — CYWS
asks for every tenant its user can see, and most are not CYBills clients.

What is listed is deliberately narrow. Each exclusion is a way of paying money
twice or paying it for nothing: a document must be a **cost** (not a sales
document), still in the **inbox** (archived is somebody setting it aside; on an
expense claim it reaches the ledger as a line of the claim's bill; merged away it
is another document's money now), **not already in Xero** (the ordinary Bills
Listing has it), **complete** (supplier, date, category, total > 0 — an
incomplete document cannot be published), and **not marked paid**. That last one
matters most: much of what CYBills collects is *receipts*, money already handed
over at the merchant, and a receipt in a payment run pays the supplier twice.

```json
{
  "ok": true,
  "tenant_id": "…",
  "organisations": [{ "id": "org-1", "name": "Demo Co" }],
  "bills": [{
    "id": "bill_…", "item_id": "260822111522",
    "org_id": "org-1", "org_name": "Demo Co", "tenant_id": "…",
    "supplier": "A1 CONSULTANCY", "invoice_number": "INV-9", "reference": "INV-9",
    "date": "2026-07-31", "due_date": "2026-08-30",
    "currency": "MYR", "total": 17363.25, "tax": 0,
    "base_currency": "SGD", "base_total": 5803.22,
    "category": "476 - Contractors", "description": "…", "document_type": "Invoice",
    "url": "https://cybills.cy-bm.sg/costs/260822111522?org=org-1",
    "has_file": true,
    "file_url": "https://cybills.cy-bm.sg/api/payments/bills/bill_…/file",
    "postable": true, "blocked_reason": "",
    "account_code": "476", "tax_type": "INPUTY24"
  }]
}
```

`postable` is whether publishing would work **right now**, decided against the
org's live chart and tax rates and said here rather than discovered at publish
time — the alternative is a row that looks payable, gets a contact created for it
in Xero, and only then refuses. A row with `postable: false` should be shown with
its `blocked_reason` and not offered for payment.

`base_*` is what a foreign-currency invoice says the same money is worth in the
entity's own currency, where the supplier printed it. **Pay the `currency` /
`total` pair** — the base pair is for showing beside it.

## `GET /api/payments/bills/<id>/file`

The original document, streamed with its own content type. `404 no_file` when the
document has no stored file, `502 file_unavailable` when storage is unreachable.

Deliberately *not* the signed share-link route the CSV exports use: those are
gated by the entity's **Exports → Image sharing** setting, which is about links
pasted into spreadsheets, and switching it off must not silently stop a payment
run.

## `POST /api/payments/bills/<id>/publish`

```json
{ "tenant_id": "…", "contact_id": "…", "status": "AUTHORISED", "due_date": "2026-08-30" }
```

`tenant_id` and `contact_id` are required; `status` defaults to `AUTHORISED` and
`due_date` to the document's own. **AUTHORISED is the default because Xero will
not accept a payment against a `DRAFT` or `SUBMITTED` bill** — anything else
produces a bank file for a bill the ledger refuses to settle. Selecting a
document into a payment run is the approval; the run is reviewed before release.

On success, `200` with the invoice, plus how it went up (the document's own line
items where they provably reconcile, else one summary line), whether the paper
was attached, and the updated document:

```json
{ "ok": true,
  "invoice": { "invoiceId": "…", "invoiceNumber": "BILL-99", "status": "AUTHORISED",
               "amountDue": 109, "total": 109, "currency": "SGD", "contactId": "…" },
  "lines": 3, "perLine": true, "attachment": { … }, "bill": { … } }
```

**Idempotent.** A run that published five bills and then failed to build its file
is re-run by somebody pressing the button again, so a document already in Xero
answers `200 { "already_published": true }` with the invoice it already has,
rather than posting a second copy for somebody to find and void.

| refusal | meaning |
|---|---|
| `401 bad_key` | `X-API-Key` did not match |
| `400 missing_field` | no `tenant_id` / `contact_id` |
| `409 tenant_mismatch` | the document belongs to a different client's ledger |
| `409 not_payable` | archived, claimed, merged or marked paid since the list was read |
| `422 no_account_code` / `account_not_in_chart` / `no_tax_code` | nothing to post it under |
| `422 line_items_unreconciled` | the document's own lines contradict its total or its tax |
| `400 incomplete` | the document is missing a field a bill needs |

`tenant_mismatch` is not a formality. One key opens every client's book here, so
without the check a mis-set tenant in a payment run would post one client's bill
into another client's accounts, and both sides would look fine.
