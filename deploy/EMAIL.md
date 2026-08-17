# Outbound email (Microsoft Graph)

CYBills sends account email — invitations, password resets, password-changed
notices — from a real Microsoft 365 mailbox via Microsoft Graph's `sendMail`,
using an Azure app registration (app-only / client credentials). No SMTP relay,
no third-party mail vendor.

Server-side consumer: `server/src/mailer.ts`. Until the four `GRAPH_*` vars are
set, every send is a no-op returning `sent: false` — the invite/reset endpoints
still mint the link and hand it back so an admin can pass it on by hand.

## Which Graph permission

**`Mail.Send` — Microsoft Graph, _Application_ permission. That is the only one
needed.** Not `Mail.ReadWrite`, not `Mail.Read`, not full mailbox access.
`Mail.Send` allows sending only: the app cannot read, list, or delete anything
in any mailbox.

The token request asks for the scope `https://graph.microsoft.com/.default`.
That does **not** mean "everything" — it means "issue a token carrying exactly
the application permissions that have already been admin-consented for this
app", which here is `Mail.Send` alone.

⚠️ **The one thing to know:** application-type `Mail.Send` is *tenant-wide* by
default — the app could send as **any** mailbox in the tenant, not just
`GRAPH_SENDER`. Narrow in capability, broad in reach. Lock it to the one sending
mailbox with an application access policy (last section below).

## Where these live in Entra

Portal: <https://entra.microsoft.com> → **Identity** → **Applications** →
**App registrations** → **New registration** (name it e.g. `CYBills Mailer`,
single tenant, no redirect URI — this app never signs users in).

Then, on that app registration:

| What you need | Where in Entra |
| --- | --- |
| `GRAPH_TENANT_ID` | **Overview** blade → _Directory (tenant) ID_ |
| `GRAPH_CLIENT_ID` | **Overview** blade → _Application (client) ID_ |
| `GRAPH_CLIENT_SECRET` | **Certificates & secrets** → _Client secrets_ tab → **New client secret** → copy the **Value** column (not "Secret ID") |
| The `Mail.Send` grant | **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions** → search `Mail.Send` → tick it → **Add permissions** |

The secret **Value** is shown once, at creation — it's masked on every later
visit. Note the expiry you pick (max 24 months) and diarise the rotation.

After adding the permission its Status reads _"Not granted"_. Still on **API
permissions**, click **Grant admin consent for &lt;tenant&gt;** and confirm; the
Status column turns into a green check. Without this step every send fails with
an AAD consent error. Granting consent requires Global Administrator or
Privileged Role Administrator.

The permissions table should end up listing exactly one row: Microsoft Graph /
`Mail.Send` / Application / Granted. If `User.Read` (Delegated) is also there
from the default registration, it's harmless — you can remove it.

## Sending mailbox

`GRAPH_SENDER` is the mailbox to send **as** — e.g. `no-reply@cy-bm.sg`. It must
exist in Exchange Online and be licensed (a shared mailbox works and needs no
licence). Set `MAIL_REPLY_TO` to a monitored inbox so replies to a no-reply
sender don't vanish.

Sent messages land in that mailbox's Sent Items (`saveToSentItems: true`), which
is a useful delivery audit trail.

## Lock the app to that one mailbox

Because the app permission is tenant-wide, scope it in **Exchange Online
PowerShell** (there is no Entra portal UI for this):

```powershell
Connect-ExchangeOnline
New-ApplicationAccessPolicy `
  -AppId <GRAPH_CLIENT_ID> `
  -PolicyScopeGroupId no-reply@cy-bm.sg `
  -AccessRight RestrictAccess `
  -Description "CYBills mailer — no-reply only"

# Verify (allow up to ~30 min to propagate):
Test-ApplicationAccessPolicy -Identity no-reply@cy-bm.sg -AppId <GRAPH_CLIENT_ID>   # AccessCheckResult: Granted
Test-ApplicationAccessPolicy -Identity czeyang.goh@cy-bm.sg -AppId <GRAPH_CLIENT_ID> # AccessCheckResult: Denied
```

`-PolicyScopeGroupId` also takes a mail-enabled security group if you ever need
more than one sender.

## Configure CYBills

On the VPS, in `/opt/cybills/server/.env`:

```
GRAPH_TENANT_ID=<Directory (tenant) ID>
GRAPH_CLIENT_ID=<Application (client) ID>
GRAPH_CLIENT_SECRET=<the secret Value>
GRAPH_SENDER=no-reply@cy-bm.sg
MAIL_REPLY_TO=admin@cy-bm.sg
APP_ORIGIN=https://cybills.cy-bm.sg      # links in emails are built from this
INVITE_TTL_DAYS=7                        # optional, default 7
```

`APP_ORIGIN` matters: invitation and reset links are built from it, so a wrong
value produces links that go nowhere.

Then:

```bash
sudo systemctl restart cybills-backend.service
curl -s https://cybills.cy-bm.sg/api/auth/status   # "mailEnabled": true
```

## What gets sent

| Trigger | Email |
| --- | --- |
| Users → Manage → **Send / Resend invitation** | Invitation with a single-use link to choose a password |
| Sign-in page → **Forgot password?** | Reset link (silent if the address has no account) |
| Profile → Security → **Change password** | "Your password was changed" confirmation |
| Users → Manage → **Set/Change password** (admin) | "Your password was changed by &lt;admin&gt;" notice |

Links are single-use and expire after `INVITE_TTL_DAYS`. Only a SHA-256 of each
token is stored, so the data file can't be replayed into an account. Passwords
are never emailed.

## Troubleshooting

Failures are logged by the backend (`journalctl -u cybills-backend -f`) with the
verbatim Microsoft error, and the invite endpoint returns it to the admin UI.

| Error | Cause |
| --- | --- |
| `AADSTS700016` / app not found | Wrong `GRAPH_CLIENT_ID`, or the app is in another tenant |
| `AADSTS7000215` invalid client secret | Wrong or expired secret — check you copied the _Value_, not the _Secret ID_ |
| `AADSTS900021` invalid tenant | Wrong `GRAPH_TENANT_ID` |
| `ErrorAccessDenied` on sendMail | Admin consent not granted, or the application access policy excludes `GRAPH_SENDER` |
| `MailboxNotEnabledForRESTAPI` | `GRAPH_SENDER` isn't a real Exchange Online mailbox (unlicensed, or on-prem) |
| `mail_not_configured` | One of the four `GRAPH_*` vars is blank |
