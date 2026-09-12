# Inbound email ("Extract by email")

Each user gets an address `<handle>@cybills.sg` (shown on their **Users → Manage →
Edit user details** page). A supplier — or the user, via a Gmail forward — sends
bills there, and CYBills files them under that user. **No per-user mailbox is
created**: cybills.sg is on Cloudflare, and a single catch-all **Email Worker**
receives everything and POSTs it to CYBills.

```
supplier / user's Gmail forward  →  <handle>@cybills.sg
        │
Cloudflare Email Routing (catch-all)  →  Email Worker
        │   POST https://cybills.cy-bm.sg/api/inbound/email   (X-Inbound-Secret)
        ▼
CYBills:  resolve <handle> → user
          • Gmail forwarding-confirmation email → held on the user's page to click
          • anything else → a cost document per attachment, owned by the user
```

Because CYBills catches Google's forwarding-confirmation email and **surfaces the
link on the user's page**, nobody has to log into a mailbox to complete a Gmail
forward. That's the amber "Forwarding confirmation received" panel.

## What the app already does (shipped)

- `POST /api/inbound/email` — machine-to-machine, gated by the `INBOUND_SECRET`
  header. 503s until the secret is set, so deploys are safe before setup.
- Per-user `emailHandle` (auto-assigned, editable), and the address + confirmation
  UI on the Edit-user page.

## One-time setup (Cloudflare + one env var)

### 1. Server env (`server/.env` on the VPS)

```
INBOUND_SECRET=<a long random string>
INBOUND_MAIL_DOMAIN=cybills.sg        # optional; this is the default
```

Restart the service after adding it.

### 2. Cloudflare Email Routing → catch-all → Worker

1. Cloudflare dashboard → the **cybills.sg** zone → **Email → Email Routing** →
   enable it (adds the MX + SPF records automatically).
2. Create a Worker (below), then under **Email Routing → Routes → Catch-all
   address**, set the action to **Send to a Worker** and pick it.

### 3. The Email Worker

`wrangler.toml`:

```toml
name = "cybills-inbound"
main = "src/worker.js"
compatibility_date = "2024-09-01"

[vars]
CYBILLS_INBOUND_URL = "https://cybills.cy-bm.sg/api/inbound/email"
# set INBOUND_SECRET as a SECRET, not a plain var:  wrangler secret put INBOUND_SECRET
```

`src/worker.js` (needs `postal-mime`: `npm i postal-mime`):

```js
import PostalMime from 'postal-mime';

function toBase64(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export default {
  async email(message, env) {
    const email = await new PostalMime().parse(message.raw);
    const attachments = (email.attachments || []).map((a) => ({
      filename: a.filename || 'document',
      contentType: a.mimeType || '',
      contentBase64: toBase64(a.content),
    }));
    await fetch(env.CYBILLS_INBOUND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Inbound-Secret': env.INBOUND_SECRET },
      body: JSON.stringify({
        to: message.to,                       // <handle>@cybills.sg
        from: email.from?.address || '',
        subject: email.subject || '',
        text: email.text || '',
        html: email.html || '',
        // The message's own id. Optional, and worth sending: it is what the
        // Email tab keys its rows on, so a delivery retried after a timeout
        // leaves one row rather than two — and does not ask n8n to fetch the
        // same invoice twice. Without it CYBills names the message by what it
        // IS (recipient + sender + subject + date + body), which is nearly as
        // good and occasionally not.
        messageId: email.messageId || '',
        // BOTH parts matter now, not only the attachments: an invoice sent as
        // a LINK lives in `html`.
        attachments,
      }),
    });
  },
};
```

Deploy: `wrangler deploy`, then `wrangler secret put INBOUND_SECRET` (same value
as the server's).

## Notes / fast-follow

- Documents arrive in the **Costs inbox** wearing "Processing" and are read on
  arrival, with the covering message and their own file name (that fast-follow
  landed).
- The handle defaults to the user's first name (`yakson`); collisions get a
  numeric suffix. It's editable on the Edit-user page if you want a specific one.

## A bill that arrives as a LINK (n8n)

Xero's own subscription invoice carries no PDF: "View your bill online:
INV-7822201", and the file is behind a login. So does a growing number of
supplier portals. That mail used to file nothing and leave no trace — no
document, no row, no reason.

CYBills holds no credentials for those portals and should not. **n8n** does, so
a delivery that filed nothing of its own hands its links over and files whatever
comes back, reading it exactly as it would an attachment.

```
mail with no attachment  →  every http(s) link in it
        │   POST $N8N_FETCH_URL      (X-API-Key: $N8N_API_KEY)
        ▼
n8n:    follow the link, log in, download the PDF
        │   200 with the file
        ▼
CYBills: file it as a cost document owned by the same person, read it,
         and show the whole delivery in the Email tab
```

### Server env (`server/.env`)

```
N8N_FETCH_URL=https://n8n.example.com/webhook/cybills-fetch-document
N8N_API_KEY=<optional; sent as X-API-Key, for a webhook set to header auth>
N8N_TIMEOUT_MS=120000                 # optional; a portal login is slow
```

Unset, the road simply is not there: the mail is still mirrored in the Email tab
saying so, with its links there to open by hand.

### What CYBills sends

```json
{
  "url": "https://in.xero.com/abc123DEF",
  "links": ["https://in.xero.com/abc123DEF", "https://central.xero.com/s/article/billing"],
  "from": "czeyang.goh@cy-bm.sg",
  "to": "astrid4@cybills.sg",
  "subject": "FW: Your Xero Invoice for Tiffinlabs US LLC",
  "date": "2026-09-11T02:25:00.000Z",
  "text": "the covering message, capped at 4000 characters"
}
```

`url` is the first link; `links` is all of them, in the order they were written,
deduped and capped at 25. **Which of them is the invoice is n8n's decision** —
a mail carries an unsubscribe link and a help-centre link beside the one that
matters, and the workflow holding the portal credentials is the half equipped to
tell them apart.

### What CYBills accepts back

Whichever of these your workflow finds easiest to produce — all are read:

```jsonc
[{ "fileName": "INV-7822201.pdf", "mimeType": "application/pdf", "data": "<base64>" }]
{ "fileName": "…", "contentBase64": "<base64>" }        // or fileBase64 / base64 / content / pdf
{ "documents": [ … ] }                                   // or files / attachments
```

…or the **bytes themselves** with a non-JSON content type (`application/pdf`),
in which case the name comes from `Content-Disposition`. Several documents in one
answer are all filed. Up to 25 MB each.

**The bytes decide what a file is.** A portal that wants a login answers `200`
with a sign-in PAGE, and a workflow handing that back — labelled
`application/pdf`, named `invoice.pdf`, because that is what the author typed —
must not have it filed as a cost and read as an invoice. So the declared type and
the file name are not consulted at all: only the file's own signature is. Nothing
that isn't a PDF, PNG, JPEG, WebP or GIF is kept, and the message says what came
back instead.

Anything else — a non-2xx, an unreachable host, a workflow that found nothing —
is a **note on the message**, never an error thrown at the delivery: the mail is
mirrored either way, carrying n8n's own words, and **Fetch the document** on that
message asks again once the workflow (or the login) is fixed. An `error`,
`message`, `note` or `reason` field in the reply is quoted back verbatim, so say
there what you would want a reviewer to read.

### The Email tab

Every delivery is mirrored, whatever became of it, and threaded by the person it
was addressed to — the WhatsApp tab's shape, for the same reason: an inbound
address is one person's pipe. Business Admin only, on the route as well as in the
rail, because it shows everybody's mail in the entity.

It exists for the mail that produced NOTHING: a link nobody could follow, a
`.docx` the reader cannot take, a forwarding confirmation. Those deliveries
appeared nowhere in CYBills at all, so "I emailed that last week" had no answer
here.
