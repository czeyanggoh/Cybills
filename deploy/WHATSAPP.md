# Bill collection over WhatsApp (with CYWorkspace)

Each client entity gets a WhatsApp group. The people who actually hold that
company's invoices send photos and PDFs into it; CYWorkspace (CYWS) runs the
WhatsApp number ("CYBot") on its WAHA server, classifies every attachment, and
hands the **supplier bills and receipts** to CYBills. They land in that entity's
Costs inbox, owned by whoever sent them, read with whatever they typed
alongside.

```
client's people  →  WhatsApp group ("CYBills - Acme Pte Ltd")
        │
CYWS (WAHA + classifier)          sales invoices / statements / photos → not forwarded
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

**One person, from their own page** is the ordinary way: **Users / Colleagues →
Manage → Edit details → Connect to WhatsApp**. It opens a group containing just
them, named with their own CYBills address (`astrid4@cybills.sg`) — the same
pipe under a second name, since a bill sent to that address and one sent into
that group are filed under exactly the same person. The number typed there is
saved as part of connecting: it is what a bill arriving from that number is
matched back to, and an unstored one means everything they send lands on the
entity's General account instead.

A colleague belongs to no single client entity, so their documents go where an
emailed one of theirs goes: their own organisation, else the practice's primary
one.

**Changing that number later** saves fine and takes effect for matching, but it
cannot move the group — WhatsApp has no way to swap a number inside one. Either
add the new number from inside the group, or use **Open a new group with this
number**, which is the only thing that ever creates a second one. The old group
is marked replaced rather than deleted: CYWS still files its messages under that
submission id, so anything sent into it keeps arriving until it is deleted at
the WhatsApp end.

**A whole entity** — several people in one group — is set up under Connections
instead:

**Business settings → Connections → WhatsApp bill collection → Set up the
group.** Enter the numbers in full international format (digits only —
`6591234567`, not `91234567`; a leading zero is refused rather than guessed at
too, because no country code starts with one).

This creates a **real WhatsApp group** and adds real people to it. It is the
only thing in CYBills that can, and it happens only on that button — never on
load, never as a side effect, never in a loop.

Two things to expect:

- **Somebody may not be added.** WhatsApp silently refuses to add a user whose
  privacy settings disallow it, and answers as though nothing happened. That is
  not an error, and the card says so — but usually only as a count. WhatsApp
  returns **LIDs** in `participants_added` (`217630539546875`), the opaque
  per-user ids it uses so a group doesn't leak everyone's number, and no phone
  number will ever match one. So a name is claimed only when a returned id
  really is one of the numbers we sent; otherwise all that is honestly known is
  how many are short. Whoever is missing has to be added from inside the group
  — CYWS's API mints no invite link.
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
  "doc_category": "supplier_bill",
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
- **Supplier bills and receipts only.** Both are records of a cost somebody is
  claiming, so both are forwarded, and `doc_category` says which arrived
  (`supplier_bill` — money owed; `receipt` — already paid). A sales invoice is
  money owed TO the business rather than a submission, and it, bank statements
  and random photos are classified by CYWS and left alone; plain text messages
  never arrive. `body` is the text attached to the document itself.

## The conversation, not just the documents

A collection group is a conversation, and CYBills used to see only the documents
CYWS picked out of it. So "I sent that last week" could not be answered here at
all, and an invoice the classifier read as a holiday photo appeared nowhere.

CYWS now mirrors **every** message in a collection group — text included — to:

```
POST https://cybills.cy-bm.sg/api/whatsapp/message   (X-API-Key, same key)
```

```json
{
  "submission_id": "CYB-org_red00001-a1b2c3d4",
  "wa_message_id": "false_120363...@g.us_3EB0...",
  "chat_id": "120363...@g.us",
  "direction": "in",
  "sender": "60123456789@c.us",
  "sender_name": "Dean",
  "body": "sending the bills now",
  "translation": "",
  "msg_type": "image",
  "r2_key": "whatsapp/ab12cd34.jpg",
  "file_url": "https://cyworkspace.cy-bm.sg/api/invoice-file?k=...",
  "file_name": "grab.jpg",
  "content_type": "image/jpeg",
  "doc_category": "receipt",
  "sent_at": "2026-08-27T08:56:00.000Z"
}
```

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ok, updated}` | Stored. `updated: true` means it revised a message already held. |
| 400 | `{error: "submission_id_required" \| "wa_message_id_required"}` | |
| 401 | `{error: "invalid_api_key"}` | |
| 404 | `{error: "unknown_submission"}` | Same refusal as `/invoice`, same reason. |

- **Upserted on `wa_message_id`**, because CYWS sends each message TWICE by
  design: once the moment it lands, so the thread is live, and again once its
  classifier has decided what an attachment is. The second revises the first.
- **A correction made in CYBills wins.** Once a reviewer sets the category on
  the WhatsApp tab it is marked `manual`, and a later CYWS re-send leaves it
  alone — otherwise correcting it would be pointless.
- **The classification is what files it.** A message whose `doc_category` is
  `supplier_bill` or `receipt` is filed as a cost document by this endpoint, on
  the send that carries the verdict. Everything else — a bank statement, a sales
  invoice, a photo — stays in the thread and is filed by nobody unless a person
  says otherwise. **One post per message**: CYWS must NOT also call `/invoice`
  for those two, or the bill is posted twice, filed by one call and shown as
  unfiled by the other with a button that makes a second copy.
- **`/invoice` remains** for the self-test and as the older contract, deduped on
  `message_id` against the same ledger, so the two can never both file one
  document. Both go through one builder, as does the tab's **Add to Costs**, so
  what lands is the same document however it got there.

The tab itself is **WhatsApp** in the left rail, below Costs and Sales: every
group for the entity, its unfiled-attachment count, and the thread. Reading it
needs access to the entity; correcting a category or filing a document needs
Business Admin.

## The tick on the message

A person who photographs a receipt into a group gets no receipt of their own.
The message sits there looking exactly like one that was never picked up, so the
next thing they do is send it again, or ask. CYBills answers in the place they
are already looking — a reaction on their own message, which notifies nobody:

| | when |
|---|---|
| ☑️ grey | filed here, and the reader got something off it |
| ✅ green | Xero says the bill it became has been paid in full |

WhatsApp keeps **one reaction per account per message**, so the green one
REPLACES the grey rather than sitting beside it. That is the design, not a
limitation: the tick they are already looking at changes as the document moves.

CYBills does not hold the WhatsApp session, so it asks CYWS:

```
POST https://cyworkspace.cy-bm.sg/api/webhooks/cybills/react   (X-API-Key, same key)
```

```json
{
  "submission_id": "CYB-org_red00001-a1b2c3d4",
  "wa_message_id": "false_120363...@g.us_3EB0...",
  "emoji": "☑️"
}
```

| Status | Body | Meaning |
|---|---|---|
| 200 | `{data: {chat_id, wa_message_id, emoji}}` | On the message. Sending the same emoji again leaves it as it was. |
| 400 | `{error: "submission_id_required" \| "wa_message_id_required"}` | |
| 401 | `{error: "invalid_api_key"}` | |
| 404 | `{error: "unknown_submission"}` | No group at CYWS under that id. |
| 502 | `{error: "react_failed"}` | WhatsApp refused. CYBills records nothing, so the next thing to happen to the document tries again. |
| 503 | `{error: "react_not_supported"}` | The CYBot number's provider cannot send reactions. |

- **Named by submission id, not chat id.** The shared key opens every chat on
  that number, so CYWS resolves the group from its own record — a bug in CYBills
  cannot then react in a conversation that has nothing to do with it.
- **Which tick is decided from the DOCUMENT**, never from which caller asked
  (`reactionFor` in `server/src/waReactions.ts`). Xero's "paid" reaches CYBills
  by three routes — the invoice webhook, the payments sweep, and the reply to an
  Update in Xero — and between them they produce exactly one reaction. A re-read
  pressed AFTER the bill was paid cannot knock green back to grey, which would
  tell the sender their paid bill had come undone.
- **A read that got nothing is left bare on purpose.** No supplier and no total
  means the file was unreadable — a dark photo, a scan the reader could not see.
  Ticking it would say the receipt is in hand when what it needs is to be sent
  again.
- **Best-effort throughout.** Filing a bill is never held up by a reaction, and
  an older CYWS with no such route just answers 404 into the log. Only what
  actually reached WhatsApp is recorded (`whatsappReaction` on the document), so
  a refusal retries rather than leaving the message bare for good.
- Nothing is ever CLEARED. Taking a tick off says something happened to the
  document, and nothing here ever means that.

## Renaming a group

A collection group is NAMED after the address it collects for —
`gcy.cybm@cybills.sg` — because the two are one pipe: a bill emailed to that
address and one sent into that group are filed under exactly the same person.

The name was a snapshot, though, taken when the group was created, so an address
that moved left its group standing under the old one. There are two ways it
moves — the person changes their handle (Users / Colleagues → Edit details), or
their entity takes a short form (Business settings → Extraction → Extract by
Email), which moves everybody's at once — and both now rename the group.

```
POST https://cyworkspace.cy-bm.sg/api/webhooks/cybills/rename-group   (X-API-Key, same key)
{ "submission_id": "CYB-org_red00001-a1b2c3d4", "subject": "gcy.cybm@cybills.sg" }
```

| Status | Body | Meaning |
|---|---|---|
| 200 | `{data: {chat_id, subject}}` | Renamed. A group already called that answers 200 with `unchanged: true` and is asked nothing. |
| 400 | `{error: "submission_id_required" \| "subject_required"}` | A group with no name at all is not something to put in front of a client. |
| 401 | `{error: "invalid_api_key"}` | |
| 404 | `{error: "unknown_submission"}` | No group at CYWS under that id. |
| 502 | `{error: "rename_failed"}` | WhatsApp refused — only an admin of a group may rename it. |
| 503 | `{error: "group_rename_unavailable"}` | The CYBot number is not on WAHA. |

- **CYBills decides which groups may be renamed**, and two kinds never are. An
  **adopted** conversation is the client's own, merely pointed at CYBills, and
  renaming it from an accounting app is the same species of act as taking it
  apart — which the close path refuses to do unasked. A **closed** collection is
  over, and editing a chat CYBills has stopped collecting through is no longer
  any of its business. CYWS just does what it is told, to a group it holds.
- **Named by submission id**, like the reaction and the teardown, so the group is
  resolved at CYWS's end from its own record rather than from a chat id in the
  request.
- **Best-effort, and only what WhatsApp took is recorded.** Nobody waits on this
  — it happens while somebody saves a form — and a refusal leaves the channel row
  saying what the group is really called, so the next address change tries again
  rather than believing the two already agree. An older CYWS answers 404 into the
  log. Nothing about filing depends on it: a bill sent into the group files under
  the person the CHANNEL names, never under its subject.

## Closing a group down

Two acts, offered side by side on every group (Connections → the group's row,
or the person's own Edit details → Connect to WhatsApp):

| | what happens in WhatsApp |
|---|---|
| **Stop collecting here** | Nothing. The group stays, everyone stays in it — CYBills simply stops taking anything from it. |
| **Delete the group** | CYBot removes everyone, then leaves. |

Both are offered whoever opened the group, because only the person pressing
knows which they mean. A group CYBot opened for one colleague is usually
finished with; a client's own conversation that was merely POINTED at CYBills
(`/channels/attach`) is theirs, and taking it apart from an accounting app would
destroy something that was never ours. The panel says which kind it is — the
channel carries `adopted` — rather than deciding for anybody.

**Neither touches what was collected.** The documents are accounting records and
belong to the book, not to the group; the mirrored thread is the record of what
was said. The channel row survives too, since all of those reference its
submission id. What changes is its status: `disconnected` or `deleted`.

```
POST https://cyworkspace.cy-bm.sg/api/webhooks/cybills/delete-group   (X-API-Key, same key)
{ "submission_id": "CYB-org_red00001-a1b2c3d4", "keep_group": false }
```

| Status | Body | Meaning |
|---|---|---|
| 200 | `{data: {chat_id, removed, left, group_kept}}` | Done. `removed` is how many CYBot took out. |
| 400 | `{error: "submission_id_required"}` | |
| 401 | `{error: "invalid_api_key"}` | |
| 404 | `{error: "unknown_submission"}` | No group at CYWS under that id. |
| 502 | `{error: "remove_failed"}` | Could not empty it, so it was **left alone** rather than half-dismantled. |
| 502 | `{error: "leave_failed"}` | Emptied, but CYBot could not walk out. |
| 503 | `{error: "group_delete_unavailable"}` | The CYBot number is not on WAHA. |

- **Members first, CYBot last.** Leaving is irreversible from our side — once
  CYBot is out it is not an admin and can remove nobody — so a failure to remove
  somebody aborts BEFORE the leave. The alternative is walking out of a group
  named after a client's bills with the client still sitting in it and nobody
  running it.
- **A refusal leaves the collection OPEN.** A group somebody believes is gone,
  still sitting in front of a client, is the failure that matters here, so
  nothing is marked closed on the strength of a call that failed. CYWS's own
  wording is passed through to the person who pressed the button.
- **Deliveries stop at CYBills**, not only at CYWS. A closed collection answers
  409 `channel_closed` to `/invoice` and `/message` and logs the attempt, because
  "CYBills has stopped collecting through this group" is CYBills' decision and
  must hold even if the call asking CYWS to stop forwarding never landed.
- **Idempotent.** Closing an already-closed collection answers 200 and asks CYWS
  nothing: somebody pressing twice wants it shut, and it is.
- **It is not a delete for everyone.** WhatsApp has none. The group stays in the
  ex-members' chat lists showing they were removed; no API reaches their phones.
  The panel says so, because this is the half people assume works.

### Which of them a chat may actually be pointed at

`/directory` lists **every** channel CYBills has ever recorded, retired ones
included — a collection filing to nobody is exactly what an operator needs to
see, and hiding it would leave them wondering why the id on a chat matches
nothing at all. Each row therefore carries **`assignable`**: true only while
CYBills is still collecting through it.

Retired rows accumulate for good reasons and are never deleted. "Open a new
group with this number" marks the old one `replaced` and keeps it, because CYWS
still files that group's messages under its submission id until somebody deletes
the group at the WhatsApp end. An attempt that never completed leaves `pending`
or `failed`, because the id is written to disk BEFORE the call goes out so a
retry can reuse it. Closing leaves `disconnected` or `deleted`.

So one person can legitimately have several rows, and only one of them live.
**Do not offer a row with `assignable: false` as a destination.** Forwarding into
one fails silently — the documents post to an id nothing reads, and CYBills' own
WhatsApp tab hides those channels, so they never appear. That is
indistinguishable from nothing arriving at all. `set_chat_cybills_submission`
refuses one with `submission_not_collecting`; the picker shows a retired row
only when it is the chat's current (wrong) assignment, so it can be seen and
changed rather than showing as blank.

Names differ between rows for the same person because only a live, non-adopted
group is renamed when an address changes — a retired one stays frozen at
whatever it was called when it was retired. Two rows reading
`czeyanggoh@cybills.sg` and `czeyanggoh.cybm@cybills.sg` are the same person
before and after their entity got a short form.

## Saying whose books a group feeds

CYWS files everything under a submission id and holds nothing else, so its own
inbox can only show the hex — it cannot say who `CYB-org_red00001-a1b2c3d4` is,
and has nothing to offer when a group needs pointing at somebody. That fact
lives here, so there is a read-only endpoint for it:

```
GET https://cybills.cy-bm.sg/api/whatsapp/directory   (X-API-Key, same key)
```

```json
{
  "channels": [
    {
      "submission_id": "CYB-org_red00001-a1b2c3d4",
      "person_name": "Astrid Yang",
      "person_email": "astrid@cybills.sg",
      "entity_wide": false,
      "person_missing": false,
      "org_id": "org_red00001",
      "org_name": "Acme Pte Ltd",
      "subject": "astrid@cybills.sg",
      "chat_id": "120363...@g.us",
      "status": "open",
      "received": 12,
      "last_message_at": "2026-08-27T08:56:00.000Z"
    }
  ]
}
```

- `entity_wide` is the entity's own group rather than one person's — a real
  distinction, not a lookup that failed. `person_missing` is the lookup that
  failed: a group whose person has left the roster, which is worth seeing.
- `org_name` falls back to empty; entities are linked separately, so a group can
  outlive or precede a named record.
- `chat_id` is the group CYBills believes the id belongs to. Compare it with the
  chat being forwarded from — if they differ, somebody has pointed one group at
  another's submission, and the documents will file under the latter.
- **No phone numbers.** Naming the person and the entity is the whole job.

The same answer carries `people` — everyone on the roster a group *could* be
pointed at, with `has_channel` saying whether they already collect through one:

```json
{
  "people": [
    {
      "user_id": "nu_1a2b3c4d",
      "name": "Martin Lim",
      "email": "martin@acme.com",
      "org_id": "org_red00001",
      "org_name": "Acme Pte Ltd",
      "has_channel": false
    }
  ]
}
```

The entity's GENERAL account is left out — it is the unclaimed-documents bucket,
not a person. Deactivated and removed rows are left out too. Still no numbers.

## Linking a group that already exists

**Set up the group** and **Connect to WhatsApp** both MAKE a group, every time.
That is right when there isn't one — and wrong when the client has been sending
their bills into a group for months, because it puts a second, empty group in
front of them while the one holding the paperwork stays filed under nobody.

There was no other way in: a submission id is minted here, and the only thing
that minted one also created the group. So there is a write endpoint that mints
the id alone and names the group it belongs to:

```
POST https://cybills.cy-bm.sg/api/whatsapp/channels/attach   (X-API-Key, same key)
{ "user_id": "nu_1a2b3c4d", "chat_id": "120363...@g.us", "subject": "Acme — bills" }
```

Answers `{ ok: true, channel: { submissionId, ... } }`. Nothing is opened in
WhatsApp; the group is CYWS's, and its members are whoever is already in it.
CYWS stamps the returned id on that chat and starts forwarding.

- `subject` is optional — the group's real WhatsApp name, which is what the
  operator on the other side is looking at. Without it the channel is named the
  way one we opened ourselves would be (the person's CYBills address).
- **A person may collect through SEVERAL groups**, and this is the route where
  that is true: their own, opened by CYBot, plus any conversation of theirs that
  was pointed at CYBills. Each gets its own submission id, its own thread and
  its own counts. Nothing splits in the book — every channel names the same
  person, so the documents file under them either way; what stays apart is the
  conversation, which is right, because they are different conversations.
  Opening a second group is still refused (`/channels/user`): that one would put
  a needless empty group in front of a client.
- **409 `chat_in_use`** — that group already files somewhere. Two open channels
  on one chat id would file the same bill into two people's books. This is the
  invariant that survives, and it is the one that matters: it is about a GROUP,
  not a person.

  This route used to refuse a person who already had a group (`already_connected`),
  on the reasoning that a second id would split their bills. That was right about
  opening a group and wrong about adopting one — the conversation already exists
  and bills are already going into it, so refusing prevents no split. It forces
  an ALIAS instead: the operator's only way to point the chat at that person is
  to hand it their existing group's id, and two chats on one id is strictly
  worse, because CYBills then cannot tell them apart at all. One row in the
  WhatsApp tab, one thread, two conversations folded into it — which is exactly
  how a bridge chat came to show up as somebody's personal group.
- No mobile is asked for. The number on their row is still what an emailed or
  forwarded document is matched by; this endpoint does not touch it.

## Testing it yourself

**Extraction → Extract by WhatsApp → "Send a test bill"** (practice team only).

The server posts one document to its own public endpoint — the real URL, the
real key, naming a real group — so it exercises everything from the network in:
reachability, the key, the group lookup, the shared bucket, filing, and the
read. A one-page PDF appears in that group's Costs inbox; delete it once seen.

That splits the problem in half. If the test files a document, the CYBills side
works and what remains is CYWS's: the URL and key it holds, or its classifier
deciding an attachment is not a supplier bill. If it fails, the message says
which step did.

A write failure here (`Access Denied`) blocks uploads through the app and blocks
this test — which has to put a file in the bucket to have something to deliver —
but NOT inbound bills. CYWorkspace has already written those; CYBills only reads
them back by key. A token with **Object Read** is enough for WhatsApp to work;
**Object Read & Write** is what uploads and this button need.

It needs R2 configured — there is no shared bucket to put a file in otherwise,
and it says so rather than failing later as `file_unavailable`.

## Nothing turned up

"I sent a bill into the group and it isn't in the Costs inbox" has two answers
that need different people, so CYBills records every call to the endpoint —
refusals included — under **Business settings → Extraction → Extract by
WhatsApp → What has arrived** (practice team only, last 50).

| It says | It means |
|---|---|
| *nothing at all* | CYWS has not called. Give it the URL and key above, or the classifier decided the attachment was not a supplier bill and never forwarded it — that decision is CYWS's, and it does not reach here. |
| **Wrong key** | CYWS is calling with a key this deploy doesn't hold. |
| **Unknown group** | The `submission_id` names no group here. The group was made outside CYBills, or its record is gone. |
| **File unreadable** | Neither the R2 key nor the signed link gave up the bytes. Safe to re-tag. |
| **Filed** / **Already had it** | It arrived. If it isn't visible, check the entity — a colleague's group files into their own organisation, else the practice's primary one. |

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
