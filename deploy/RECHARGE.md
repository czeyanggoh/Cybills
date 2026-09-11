# Recharging a bridge entity's expense claims

A **bridge entity** exists because the people claiming against a client's ledger
do not work for that client. ST Engineering's staff are seconded to Red Alpha
and claim expenses there; "Red Alpha - ST Engineering" is where their claims
live, and it has no Xero organisation of its own.

The money therefore makes a round trip, and both halves already exist in Xero:

```
  claim approved in CYBills
        │
        │  published as an ACCPAY bill into the PARENT's ledger
        │  contact = the CLAIMANT           InvoiceNumber = the claim reference
        ▼  one line, account 612ST, TaxType NONE, the full amount
  612ST "Reimbursements - ST Engineering"        ← an ASSET clearing account
        ▲
        │  one line, account 612ST, TaxType OUTPUTY24 (9% on top, Exclusive)
        │  contact = the ST Eng company    Reference = the PO number
        │
  recharge invoice (ACCREC) raised in CYWorkspace
```

**The balance of 612ST is the answer.** Claims debit it, recharges credit it, so
whatever is sitting in it is exactly the expense the practice has taken on and
not yet billed back. That is the ground truth for "have we recharged this", and
it belongs to the client's own accounts rather than to either app.

CYWorkspace owns the recharge half: it holds the PO register (which ST Eng
company, which seconded people, over which dates) and it writes the sales
invoice. This route is where it reads what is waiting.

## `GET /api/payments/claims?tenant_id=<uuid>`

Machine-to-machine on the **same `X-API-Key`** as the rest of the payables seam
(`CYBILLS_API_KEY` at the CYWS end, `WHATSAPP_INBOUND_KEY` here), allowlisted
past the session guard. Contract for the payment half: `PAYABLES.md`.

```json
{
  "ok": true,
  "tenant_id": "d1a343da-…",
  "organisations": [
    { "id": "org_mt3yimem_…", "name": "Red Alpha Cybersecurity Pte. Ltd.", "bridge": false },
    { "id": "org_mt9qew30_…", "name": "Red Alpha - ST Engineering", "bridge": true }
  ],
  "claims": [
    {
      "id": "6f1c…",
      "reference": "ST Eng Exp Claim 31-Aug-2026 260820120000",
      "claimant": "Wei Ming Tan",
      "claimant_email": "weiming.tan@stengg.com",
      "period_end": "2026-08-31",
      "currency": "SGD",
      "total": "36.50",
      "items": 2,
      "claim_no": "260820120000",
      "approved_by": "Kai Tan",
      "approver": "Martin Lim",
      "decided_at": "2026-09-01T02:00:00.000Z",
      "xero_invoice_id": "",
      "xero_status": "",
      "xero_paid_date": "",
      "org_id": "org_mt9qew30_…",
      "org_name": "Red Alpha - ST Engineering",
      "bridge": true,
      "url": "https://cybills.cy-bm.sg/expense-claims/6f1c…?org=org_mt9qew30_…"
    }
  ]
}
```

## Three things that are easy to get wrong

**Scope is by PUBLISH TARGET, not by the entity's own Xero link.** This is the
whole reason the route exists as its own thing. A bridge entity answers
`tenantId: ""`, so the rule the payables listing uses — match an entity's own
link — cannot see it at all, and asking for Red Alpha's tenant would return
Red Alpha's own claims and none of ST Engineering's. `organisationsPublishingTo`
asks where a claim *would post* (`publishTargetFor`, which resolves the parent).

The payables listing keeps the narrower rule deliberately. A bridge entity's
**costs** are not payable that way — they reach the ledger as lines of a claim's
own bill — and a payment run that offered them would pay the same money twice.

**`bridge` says whose cost it is, and a caller that ignores it will invoice the
wrong party.** Scoping by publish target returns two quite different things:
the claims of people SECONDED in (a bridge entity — `bridge: true`), which are
what the practice invoices on; and the tenant's OWN entity's claims
(`bridge: false`), which are its own staff's cost, posting to an ordinary
expense account rather than to a recharge clearing account. Recharging one of
the second kind bills a client for somebody who has never worked for them, and
it looks like an ordinary sales invoice from every angle.

Both are returned deliberately — the route is the general "what reaches this
ledger" question, and a payments-side caller wants both. The narrowing belongs
to whichever tool is answering a narrower question. Fail CLOSED on it: a claim
without `bridge: true` is not a bridge claim, because the expensive mistake is
a wrong invoice and the cheap one is a claim left off a list somebody can
refresh.

**`approved_by` is who DECIDED; `approver` is who it was routed to.** A
practice colleague may decide on the named approver's behalf, so the two are
different people, and a recharge report naming the wrong one can end up saying
somebody approved their own claim. `claim_no` sits beside `reference` for the
same kind of reason: it is the bare number a report column prints, where
`reference` is that number inside the whole string the Xero bill is named with.

**Each line opens its own receipt.** `lines[]` carries, beside what the
report's Breakdown sheet prints, the document's `item_no` and a `file_url` —
a signed, expiring link to THAT receipt's file, the same capability a receipt
link inside the claim PDF carries, so a manager with no login opens the one
receipt a line is about rather than the whole claim. It is `""` where there is
no stored file, or where the entity has Image sharing off: the file route reads
that toggle on every request and would refuse the link, and a number that opens
nothing beats one that opens an error. The token is bound to the document in
the path, so it opens no other.

**Only APPROVED claims are listed.** An unapproved claim is not yet a cost
anybody has agreed to, and recharging one would invoice a client for money the
practice has not accepted it owes. A claim that is approved but not yet
*published* is still listed: whether its bill has reached Xero is a separate
question, and the row answers it for itself in `xero_invoice_id`.

**`claimant_email` is the identity to key on, not `claimant`.** A PO assigns
people; a claim stores the display NAME it was made out to, and the roster can
rename that (`canonicalPersonName` repairs stale ones on every read). The
address is resolved back through the roster the same way the approval emails
resolve it, and is what a PO assignment should match against. It is `""` for a
claimant no longer on the roster — which is a row for a person to look at, not
one to guess at.

## `GET /api/payments/people?tenant_id=<uuid>` — and who signs claims off

Everybody in the entities whose claims post into the tenant, one row per
address. Each row carries, beside `email` / `name` / `external` /
`deactivated` / `org_id` / `org_name` / `bridge`:

```json
{
  "role": "Reporting Officer",
  "reporting_officer": true,
  "manager_email": "",
  "manager_name": ""
}
```

**A Reporting Officer is the ST Engineering manager who approves the claims of
the people seconded under them** — a role offered only in a bridge entity
(Users -> Edit privileges). The claimants and their approvers work for the SAME
outside company, so on the roster they looked alike; the role is what tells
them apart. They are who a recharge report is addressed to (a PO's
`recipient_name` / `recipient_email` at the CYWS end), not people a PO covers.
Key on `reporting_officer` rather than comparing `role` strings.

`manager_email` / `manager_name` is the person's **Direct manager** — who their
claims are routed to — so a PO's recipient can be suggested from the people on
it. `""` where none is set.

It is a label, not an access tier: a Reporting Officer holds exactly what a
Standard user holds in CYBills (their own work, their direct reports' claims,
and the per-person privileges on top).

## Reading the recharge back

Nothing here records whether a claim has been recharged; CYWS does, and the
ledger does. The two are worth reconciling in that order:

- CYWS's own claim → invoice record says what it raised and when.
- 612ST's balance says what the accounts think is still outstanding.

A difference between them is real and worth surfacing — an invoice voided in
Xero, a claim bill posted by hand, a recharge raised outside the tool.

Covered by `npm test` in `server/` (`test/recharge-claims.test.mts`), driven
over real HTTP because the session-guard allowlist is what a machine caller
meets first and it lives in `index.ts`.
