# Outbound email

CYBills sends account email — invitations, password resets, password-changed
notices. There are **two** ways to send; pick one:

- **SMTP** (below) — the universal path. Use this when your domain is **not** on
  Microsoft 365 — e.g. `cybills.sg` on **Cloudflare**, which only *receives*
  (Email Routing) and cannot send. You point CYBills at any transactional
  provider (Resend, Brevo, Mailgun, Amazon SES, …) verified to send as your
  domain, and it sends as e.g. `no-reply@cybills.sg`. No interactive connect step.
- **Microsoft Graph** (further down) — use only when the sending mailbox lives in
  Microsoft 365 / Exchange Online. Delegated OAuth, an admin connects once.

When **both** are configured, **SMTP wins**.

---

# Outbound email via SMTP (any provider)

Cloudflare Email Routing forwards *inbound* mail but has no outbound sending, so
sending as `no-reply@cybills.sg` needs a transactional email provider. The steps
are the same for any of them:

## 1. Pick a provider and verify the domain

Sign up for a transactional email service (e.g. **Resend**, **Brevo**,
**Mailgun**, **Amazon SES**, **Postmark**). In its dashboard, **add and verify
the domain `cybills.sg`**. The provider gives you a handful of DNS records —
usually an **SPF** `TXT`, one or more **DKIM** `CNAME`/`TXT`, and sometimes a
**DMARC** `TXT` and a return-path `CNAME`.

## 2. Add those DNS records in Cloudflare

Cloudflare dashboard → **`cybills.sg`** → **DNS** → **Records** → add each record
the provider listed, exactly as given. For the records the provider says to add
as `CNAME` (DKIM/return-path), set the Cloudflare **proxy status to "DNS only"**
(grey cloud) — proxying breaks mail DNS. Wait for the provider to show the domain
as **Verified** (minutes to an hour).

> Keep your existing Cloudflare Email Routing MX records — they handle *incoming*
> mail and don't conflict with outbound sending.

## 3. Get SMTP credentials

In the provider, open the **SMTP** section and copy the host, port, username and
password (often the username is a fixed string like `resend` / `apikey` and the
password is an API key). Typical values:

| | Value |
| --- | --- |
| `SMTP_HOST` | e.g. `smtp.resend.com`, `smtp-relay.brevo.com`, `email-smtp.ap-southeast-1.amazonaws.com` |
| `SMTP_PORT` | `587` (STARTTLS) — or `465` with `SMTP_SECURE=true` |
| `SMTP_USER` | the provider's SMTP username |
| `SMTP_PASS` | the provider's SMTP password / API key |

## 4. Configure CYBills

On the VPS, in `/opt/cybills/server/.env`:

```
SMTP_HOST=<provider smtp host>
SMTP_PORT=587
SMTP_USER=<smtp username>
SMTP_PASS=<smtp password / api key>
SMTP_SECURE=false                    # true only if using port 465
MAIL_FROM=no-reply@cybills.sg        # every account email is sent as this
MAIL_FROM_NAME=CYBills               # optional display name
MAIL_REPLY_TO=support@cybills.sg     # optional; where replies should go
APP_ORIGIN=https://cybills.cy-bm.sg  # links in emails are built from this
SESSION_SECRET=<long random string>  # also signs sessions
```

Then restart — no connect step, it sends straight away:

```bash
sudo systemctl restart cybills-backend.service
```

`GET /api/auth/status` reports `"mailEnabled": true`, and Settings → Email shows
it sending as `no-reply@cybills.sg`. Send a test from Settings → Email to confirm
delivery (check the recipient's inbox and, at first, the spam folder — good SPF +
DKIM keeps it out of spam).

### SMTP troubleshooting

| Symptom | Cause |
| --- | --- |
| `EAUTH` / 535 | Wrong `SMTP_USER` / `SMTP_PASS` |
| `ETIMEDOUT` / `ECONNREFUSED` | Wrong host/port, or the VPS firewall blocks outbound 587/465 |
| Mail lands in spam | Domain not fully verified — recheck SPF/DKIM/DMARC in Cloudflare |
| `Mailbox unauthorized` / 550 sender | `MAIL_FROM` domain isn't verified in the provider |

---

# Outbound email via Microsoft Graph (delegated)

Use this path **only** if the sending mailbox is on Microsoft 365. CYBills sends
from a Microsoft 365 mailbox via Microsoft Graph's `sendMail`.

Server-side: `server/src/mailer.ts` (tokens + templates), `mailAccount.ts` (the
stored connection), `mail.ts` (the connect flow). Until a mailbox is connected,
every send is a no-op returning `sent: false` — the invite/reset endpoints still
mint the link and hand it back so an admin can pass it on by hand.

## Which Graph permission

**`Mail.Send` — Microsoft Graph, _Delegated_ permission.** In Entra's own words,
delegated means _"your application needs to access the API as the signed-in
user"_, as opposed to Application permissions, which run _"as a background
service or daemon without a signed-in user"_ and are **tenant-wide**.

What this grant does and doesn't allow:

- ✅ Send mail **as the one account that consented** — nothing else.
- ❌ Cannot read, search, or delete anything, in that mailbox or any other.
- ❌ Cannot reach any other mailbox in the organisation. There is no tenant-wide
  application permission involved, so no Exchange application access policy is
  needed to fence it in.

Two scopes are requested alongside it:

| Scope | Why |
| --- | --- |
| `offline_access` | Yields the refresh token. Without it the connection would die at the first access-token expiry (~1 hour). |
| `Mail.Send.Shared` | **Only** if `GRAPH_SHARED_SENDER` is set — lets the connected user send as a shared mailbox they have Send As rights on. Still delegated, still not tenant-wide. |

### Why a token is stored

Delegated auth borrows a user's identity, and a password reset is requested by
someone who — by definition — is not signed in. There is no live session to
borrow at that moment. So an admin connects the sending mailbox **once**, and
CYBills keeps the resulting refresh token to send with thereafter.

The token is encrypted at rest (AES-256-GCM, key derived from `SESSION_SECRET`)
in `server/.data/mailAccount.json`. On its own it isn't redeemable anyway —
Azure requires `client_id` + `client_secret` from the confidential client too.

The trade-off versus an application permission: a user's grant can lapse — if
that account's password changes, its consent is revoked, or conditional access
tightens. CYBills detects this (`invalid_grant`), stops retrying, and shows
**Reconnect needed** in Settings → Email.

## Where these live in Entra

Portal: <https://entra.microsoft.com> → **Identity** → **Applications** →
**App registrations** → **New registration**. Name it e.g. `CYBills Mailer`,
single tenant. Under **Redirect URI** choose platform **Web** and enter:

```
https://cybills.cy-bm.sg/api/mail/callback
```

(For local dev add `http://localhost:5173/api/mail/callback` as a second Web
redirect URI.)

Then, on that app registration:

| What you need | Where in Entra |
| --- | --- |
| `GRAPH_TENANT_ID` | **Overview** → _Directory (tenant) ID_ |
| `GRAPH_CLIENT_ID` | **Overview** → _Application (client) ID_ |
| `GRAPH_CLIENT_SECRET` | **Certificates & secrets** → _Client secrets_ → **New client secret** → copy the **Value** column (not "Secret ID") |
| The permission | **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions** → search `Mail.Send` → tick it → **Add permissions** |
| Redirect URI (if not set at registration) | **Authentication** → **Add a platform** → **Web** |

The secret **Value** is shown once, at creation — masked on every later visit.
Note the expiry you pick (max 24 months) and diarise the rotation. Rotating it
does **not** require reconnecting the mailbox.

Adding a shared sender? Also tick `Mail.Send.Shared` under **Delegated
permissions**, and give the connecting user **Send As** rights on that mailbox
(Exchange admin center → Recipients → Mailboxes → the mailbox → Delegation).

### Admin consent

Delegated permissions can be consented by each user at connect time, so the
**Grant admin consent** button is optional here — unlike the Application flow,
where it's mandatory. Click it anyway if your tenant restricts user consent
(Entra → **Enterprise applications** → **Consent and permissions**), otherwise
the connect flow will fail with "approval required".

The permissions table should end up listing Microsoft Graph / `Mail.Send` /
**Delegated**. The default `User.Read` (Delegated) row is fine to leave — the
connect flow uses it to read back which account consented, so it can name the
connected mailbox in Settings.

## Configure CYBills

On the VPS, in `/opt/cybills/server/.env`:

```
GRAPH_TENANT_ID=<Directory (tenant) ID>
GRAPH_CLIENT_ID=<Application (client) ID>
GRAPH_CLIENT_SECRET=<the secret Value>
GRAPH_REDIRECT_URI=https://cybills.cy-bm.sg/api/mail/callback
GRAPH_SHARED_SENDER=no-reply@cy-bm.sg   # optional; blank = send as the connecting admin
MAIL_REPLY_TO=admin@cy-bm.sg            # optional
APP_ORIGIN=https://cybills.cy-bm.sg     # links in emails are built from this
SESSION_SECRET=<long random string>     # also encrypts the stored refresh token
INVITE_TTL_DAYS=7                       # optional, default 7
```

`APP_ORIGIN` matters: invitation and reset links are built from it, so a wrong
value produces links that go nowhere.

Then restart and connect the mailbox:

```bash
sudo systemctl restart cybills-backend.service
```

1. Sign in to <https://cybills.cy-bm.sg> as a Business/User Admin.
2. **Settings → Email → Connect mailbox**.
3. Sign in to Microsoft as the sending account and approve the consent screen —
   it will say "Send mail as you", which is exactly the delegated grant.
4. Back in CYBills, click **Send test email** to confirm it end to end.

`GET /api/auth/status` reports `"mailEnabled": true` once connected.

## What gets sent

| Trigger | Email |
| --- | --- |
| Users → Manage → **Send / Resend invitation** | Invitation with a single-use link to choose a password |
| Sign-in page → **Forgot password?** | Reset link (silent if the address has no account) |
| Profile → Security → **Change password** | "Your password was changed" confirmation |
| Users → Manage → **Set/Change password** (admin) | "Your password was changed by &lt;admin&gt;" notice |
| Settings → Email → **Send test email** | One-off test to the admin who clicked |

Links are single-use and expire after `INVITE_TTL_DAYS`. Only a SHA-256 of each
token is stored, so the data file can't be replayed into an account. Passwords
are never emailed.

Sent messages land in the sending mailbox's Sent Items (`saveToSentItems: true`),
which is a useful delivery audit trail.

## Troubleshooting

Failures are logged by the backend (`journalctl -u cybills-backend -f`) with the
verbatim Microsoft error, and surfaced in Settings → Email.

| Error | Cause |
| --- | --- |
| `AADSTS50011` redirect URI mismatch | `GRAPH_REDIRECT_URI` doesn't byte-match a **Web** redirect URI on the app registration |
| `AADSTS700016` / app not found | Wrong `GRAPH_CLIENT_ID`, or the app is in another tenant |
| `AADSTS7000215` invalid client secret | Wrong or expired secret — check you copied the _Value_, not the _Secret ID_ |
| `AADSTS900021` invalid tenant | Wrong `GRAPH_TENANT_ID` |
| `AADSTS65001` consent required | Tenant restricts user consent — click **Grant admin consent** in Entra |
| `graph_no_refresh_token` | `offline_access` wasn't consented; reconnect the mailbox |
| **Reconnect needed** in Settings | The refresh token was rejected — that account's password changed, consent was revoked, or conditional access tightened. Click Reconnect. |
| `ErrorSendAsDenied` / 403 on a shared sender | Connecting user lacks **Send As** on `GRAPH_SHARED_SENDER`, or `Mail.Send.Shared` wasn't consented |
| `mail_not_configured` | One of `GRAPH_TENANT_ID` / `GRAPH_CLIENT_ID` / `GRAPH_CLIENT_SECRET` is blank |
| `mail_not_connected` | App registration is set up, but no admin has connected a mailbox yet |
