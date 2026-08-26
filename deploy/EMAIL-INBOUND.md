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
        attachments,
      }),
    });
  },
};
```

Deploy: `wrangler deploy`, then `wrangler secret put INBOUND_SECRET` (same value
as the server's).

## Notes / fast-follow

- Documents arrive in the **Costs inbox** as `new` with the file attached but not
  yet read — the reader runs on open / "Re-read with Claude". Auto-reading on
  arrival is a fast-follow (needs the extraction pass refactored into a callable
  the endpoint can invoke).
- The handle defaults to the user's first name (`yakson`); collisions get a
  numeric suffix. It's editable on the Edit-user page if you want a specific one.
