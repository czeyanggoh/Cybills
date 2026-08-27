# Bill collection over WhatsApp (with CYWorkspace)

Each client entity gets a WhatsApp group. The people who actually hold that
company's invoices send photos and PDFs into it; CYWorkspace (CYWS) runs the
WhatsApp number ("CYBot") on its WAHA server, classifies every attachment, and
hands the **supplier bills** to CYBills. They land in that entity's Costs inbox,
owned by whoever sent them, read with whatever they typed alongside.

```
client's people  →  WhatsApp group ("CYBills - Acme Pte Ltd")
        │
CYWS (WAHA + classifier)          receipts / sales invoices / photos → not forwarded
        │   POST https://cybills.cy-bm.sg/api/whatsapp/invoice   (X-API-Key)
        ▼
CYBills:  submission_id → the entity's book
          • the file is read from the SHARED R2 bucket by key — never copied
          • filed as a cost document, owned by the sender if we hold their number
          • read with the message it came with ("recharge this to CY-Biz")
```

The group is created the other way round:

```
CYBills  →  POST https://cyworkspace.cy-bm.sg/api/webhooks/cybills/create-group
            (X-API-Key: CYWORKSPACE_API_KEY — the same key the Xero relay uses)
```

## Hand these to the CYWS operator

Both are in the app: **Business settings → Extraction → Extract by WhatsApp**
(practice team only — the key authorises filing a bill into *any* client
entity's book, so it belongs to the deployment, not to one client).

| | |
|---|---|
| `CYBILLS_INVOICE_URL` | `https://cybills.cy-bm.sg/api/whatsapp/invoice` |
| `CYBILLS_API_KEY` | shown in the app; set `WHATSAPP_INBOUND_KEY` to pin it |

Left unset, CYBills generates the key on first use and keeps it, so it can be
read out of the app and handed over without anyone having VPS access.

## Setting a group up

**Business settings → Connections → WhatsApp bill collection → Set up the
group.** Enter the numbers in full international format (digits only —
`60123456789`, not `0123456789`; a leading zero is refused rather than guessed
at, because no country code starts with one).

This creates a **real WhatsApp group** and adds real people to it. It is the
only thing in CYBills that can, and it happens only on that button — never on
load, never as a side effect, never in a loop.

Two things to expect:

- **Somebody may not be added.** WhatsApp silently refuses to add a user whose
  privacy settings disallow it, and answers as though nothing happened. That is
  not an error, and the card names the numbers it happened to — send those
  people the group's invite link instead.
- **A failed attempt is resumable.** The submission id is written to disk
  *before* the call goes out, because the dangerous failure is not "the call
  failed" but "the call succeeded and the answer was lost". Pressing the button
  again reuses that id; CYWS is idempotent on it and returns the original group
  (`already_existed: true`). A fresh id would have created a second real group
  in front of the client.

## What CYWS sends

```json
{
  "submission_id": "CYB-org_red00001-a1b2c3d4",
  "chat_id": "120363...@g.us",
  "chat_subject": "CYBills - Acme Pte Ltd",
  "message_id": "clx8f2...",
  "wa_message_id": "false_120363...",
  "r2_key": "whatsapp/ab12cd34.pdf",
  "file_url": "https://cyworkspace.cy-bm.sg/api/invoice-file?k=...&ct=...&s=...",
  "file_name": "bridgers annual return.pdf",
  "content_type": "application/pdf",
  "body": "Please pay this",
  "sender_name": "Dean",
  "sender": "60123456789@c.us",
  "sent_at": "2026-08-27T08:56:00.000Z"
}
```

Answers:

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ok, bill_id, item_id, org_id}` | Filed. Reading happens after the reply. |
| 200 | `{ok, duplicate: true, bill_id}` | Already had this `message_id` — same document, not a second one. |
| 400 | `{error: "submission_id_required" \| "message_id_required"}` | |
| 401 | `{error: "invalid_api_key"}` | |
| 404 | `{error: "unknown_submission"}` | No group in CYBills under that id. Not filed anywhere — the id is what names the entity's book, and guessing would file a client's bills into somebody else's. |
| 502 | `{error: "file_unavailable"}` | Neither the R2 key nor the link resolved. Safe to re-tag. |

Notes on the contract:

- **Deduped on `message_id`.** A re-send answers 2xx with the document that
  already exists; a non-2xx would leave it marked undelivered and invite a
  third send.
- **The reply comes before the read.** A model call takes 10–30s and CYWS gives
  up at 30, so the answer goes out as soon as the document is durably stored and
  the reading happens behind it.
- **The file is not copied.** Both systems hold the same R2 bucket, so CYBills
  stores the object key (prefixed `shared:`) and reads through it. Deleting the
  document in CYBills drops the reference and leaves the object alone — it is
  still CYWS's record of that message. The signed `file_url` is the fallback for
  a deploy with no R2 credentials, and is only ever followed when it points at
  CYWS itself.
- **Only supplier bills.** Receipts, sales invoices, bank statements and random
  photos are classified by CYWS and not forwarded; plain text messages never
  are. `body` is the text attached to the invoice itself.

## What the note does

`body` is treated as an instruction about *that* document, exactly as a covering
email is: it can name the customer to recharge to, the project, or the category,
and it **beats a standing supplier rule** for the fields it decides — a rule is a
policy about every document from that supplier, a note is a person's instruction
about this one. It can never restate the money: the printed supplier, dates and
amounts always win. The document keeps the message, so a re-read sees it too.

The Reason field on the document says which of the two was followed, and the
message itself is on the document's **WhatsApp** tab.

## Who owns the document

The sender's number, matched against the **Mobile** on the roster (in any
spelling — `+60 12-345 6789` is the same number). No match means the entity's
**General** account, which exists for the documents nobody claimed. Never the
person who created the group: that would put their name on work they did not do.

## Environment (server/.env)

| Var | Default | |
|---|---|---|
| `CYWORKSPACE_API_KEY` | — | Already set for the Xero relay. Creating groups switches on with it. |
| `CYWORKSPACE_RELAY_URL` | `https://cyworkspace.cy-bm.sg` | On the VPS, `http://127.0.0.1:3001`. |
| `CYWORKSPACE_PUBLIC_URL` | `https://cyworkspace.cy-bm.sg` | The only host a `file_url` may point at. Separate from the relay URL so the loopback shortcut doesn't quietly become the allowlist. |
| `WHATSAPP_INBOUND_KEY` | generated | The key CYWS sends back. |
| `R2_*` | — | The shared bucket. Without it, files come down the signed link and are stored here instead. |

Covered by `npm test` in `server/` (`test/whatsapp.test.mts`).
