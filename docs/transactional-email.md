# Transactional email (Microsoft 365 / Graph)

All outbound mail from CYBills is sent from the shared mailbox
**VA01@cy-bm.sg** on the cy-bm.sg Microsoft 365 tenant, via the Microsoft Graph
API using the OAuth2 **client_credentials** (app-only) flow.

This is a port of the transport already running in production in CYWorkspace.
The env-var names, the exported functions and the error classes are identical
in both apps, so the Azure/Exchange setup and the troubleshooting table below
transfer between them.

## Ground rules

1. **Server-side only.** The client secret never reaches the browser. There is
   no `VITE_`-prefixed M365 variable, ever. Sending happens in a backend route;
   the frontend calls that route.
2. **No "email arbitrary HTML as VA01" relay.** Endpoints accept *structured*
   data (a claim id, a recipient, a detail level) and render the HTML body
   server-side, HTML-escaping every interpolated value. The server never accepts
   an `htmlBody` string from the client and forwards it to Graph. VA01 is a
   trusted internal sender; an open relay on it is a phishing vector.
3. **Degrade gracefully, never crash.** With the M365 vars unset the app still
   works: the send path returns a typed error and the caller falls back to
   something useful (a Copy button so the user can paste into Outlook). An
   unconfigured mailer is a normal state in dev.
4. **Fail loudly in logs, quietly in the UI.** Log the Graph status + body on
   failure; show the user a short sentence and a fallback.

## Environment contract

Exactly four variables, same names as CYWorkspace:

```
M365_TENANT_ID=<Directory (tenant) ID GUID>
M365_CLIENT_ID=<Application (client) ID GUID>
M365_CLIENT_SECRET=<the secret VALUE, not the Secret ID>
M365_SENDER_EMAIL=VA01@cy-bm.sg
```

Plus, because CYBills embeds links in its emails:

```
APP_PUBLIC_URL=https://cybills.cy-bm.sg
```

Rules:

- All four default to `''` except `M365_SENDER_EMAIL`, which defaults to
  `VA01@cy-bm.sg`. Because it has a default it is **not** listed as a missing
  var by `missingEmailEnvVars()`.
- `APP_PUBLIC_URL` defaults to `APP_ORIGIN`, which CYBills already sets.
- Nothing throws at boot when they are unset — the check is done at call time.
- They live in `server/.env` (see `server/.env.example`) and are read through
  `server/src/env.ts`.

## Where the code lives

| File | What it is |
| --- | --- |
| `server/src/email.ts` | The transport. `sendMail`, `isEmailConfigured`, `missingEmailEnvVars`, `escapeHtml`, `EmailNotConfiguredError`, `EmailSendError`, plus the attachment size guard. |
| `server/src/claimEmail.ts` | Server-side body builders for the expense-claim emails (HTML + CSV), every value escaped. |
| `server/src/emailRoutes.ts` | `GET /api/email/status`, `POST /api/email/claim/:id`. |
| `server/src/claims.ts` | Best-effort approver notification on `POST /api/claims/:id/submit`. |
| `src/lib/email.js` | Client helpers: status hook, send call, error copy, and the plain-text Copy fallback. |
| `src/components/ClaimEmailModal.jsx` | The "Send by email" dialog, with the Copy fallback. |

### Things in `email.ts` that look wrong but aren't

- `saveToSentItems: true` is deliberate — a copy lands in VA01's Sent Items,
  which is how delivery problems get diagnosed ("did Graph accept it, or did the
  recipient's filter eat it?").
- Graph returns **202 with an empty body** on success. Anything else is a
  failure. There is no message id to capture.
- The 401 path clears the token cache; without it, a revoked secret produces a
  permanent failure loop until restart.
- The token cache is **per-process**. If CYBills ever runs more than one backend
  process or container, each keeps its own token — that is fine and expected.

### Attachment size

Graph's `/sendMail` caps the whole message at ~4 MB, and base64 inflates bytes
by ~33%, so budget **~3 MB of real bytes**. Larger attachments need a draft +
upload-session flow, which this transport does not implement. Call
`assertAttachmentsFit(attachments)` **before** `sendMail` on any path that
attaches files; it throws `EmailAttachmentTooLargeError`, which the routes map
to HTTP 413 with a clear message. `POST /api/email/claim/:id` does this for the
CSV it attaches.

## Call-site conventions

**A. Best-effort** — mail is a convenience, the operation succeeds either way.
Catch everything, log, report a boolean back so the UI can show a fallback.
Used by the approver notification in `claims.ts`: the claim is saved *before*
the send, so a mail failure can never lose the submission, and the "Approval
request emailed to …" history line only appears when the send actually
succeeded.

**B. Mail is the deliverable** — check configuration up front and map the typed
errors onto distinct HTTP statuses so the frontend can tell "not set up" from
"Microsoft rejected it":

| Condition | Status | `error` |
| --- | --- | --- |
| Env vars unset | 503 | `email_not_configured` |
| Bad recipient address | 400 | `invalid_recipient` |
| Claim not found | 404 | `not_found` |
| Attachments over ~3 MB | 413 | `email_attachment_too_large` |
| Graph rejected the send | 502 | `email_send_failed` |
| Anything else | 500 | `unexpected_error` |

Used by `POST /api/email/claim/:id`.

**Body-builder pattern** (this is how ground rule 2 is enforced in practice):
take structured rows, escape every cell, emit inline-styled HTML because email
clients ignore `<style>` blocks and stylesheets.

```ts
const td = (v: unknown, extra = '') =>
  `<td style="border:1px solid #d0d0d0;padding:5px 9px;vertical-align:top;${extra}">${escapeHtml(v ?? '')}</td>`;
```

Outlook-safe defaults used by both apps:
`font-family:Aptos,Calibri,Arial,sans-serif; font-size:11pt; color:#111111`,
tables with `border-collapse:collapse` and explicit per-cell borders.

## One-time Azure AD + Exchange Online setup

Do this as a **Global Admin** of the cy-bm.sg tenant. Register a *separate* app
for CYBills rather than reusing CYWorkspace's `CYWorkspace Mailer` app — a
second app means CYBills gets its own client secret that can be rotated or
revoked without taking CYWorkspace's mail down. The Exchange management scope
from step 4 can be shared between them.

### 1. Register the application

<https://entra.microsoft.com> → Applications → App registrations → New
registration. Name: **CYBills Mailer**. Supported account types: **Single
tenant**. Redirect URI: leave blank. Register.

From **Overview** copy **Application (client) ID** → `M365_CLIENT_ID` and
**Directory (tenant) ID** → `M365_TENANT_ID`.

### 2. Grant the Mail.Send application permission

API permissions → Add a permission → Microsoft Graph → **Application
permissions**. Tick **Mail.Send**, Add.

Click **Grant admin consent for cy-bm.sg** — application-permission scopes do
not work without it.

### 3. Create a client secret

Certificates & secrets → New client secret. Description `CYBills prod`, expiry
24 months — **set a calendar reminder now**, an expired secret is a silent
outage.

Copy the **Value** (not the Secret ID) immediately; it is shown once. →
`M365_CLIENT_SECRET`.

### 4. Restrict the app to VA01 only (RBAC for Applications)

By default an app holding `Mail.Send` application permission can send as **any
mailbox in the tenant**. This step is what stops a leaked CYBills secret from
sending as the CEO. Modern Exchange Online tenants also *require* it — an app
that isn't registered in Exchange RBAC gets HTTP 403 `ErrorAccessDenied (RAOP -
Blocked by tenant configured AppOnly AccessPolicy settings)` on every send.

**4a. Get the Service Principal Object ID.** Azure has two GUIDs per app and
they are **not** interchangeable:

- **Application (client) ID** = the value from step 1 (`M365_CLIENT_ID`)
- **Service Principal Object ID** = a different GUID

Get it from Entra → Applications → **Enterprise applications** (a different page
from App registrations). Set the filter to "All Applications" if *CYBills
Mailer* isn't listed, click into it, and take the **Object ID** from the
Overview page.

**4b. Register and scope the app in Exchange Online PowerShell:**

```powershell
# Connect-ExchangeOnline -UserPrincipalName your-admin@cy-bm.sg
# Replace <M365_CLIENT_ID> and <SP_OBJECT_ID> with the actual GUIDs
# (no angle brackets — those are placeholders).

# 1) Register the app as a Service Principal known to Exchange Online
New-ServicePrincipal `
  -AppId <M365_CLIENT_ID> `
  -ServiceId <SP_OBJECT_ID> `
  -DisplayName "CYBills Mailer"

# 2) Create a management scope targeting ONLY the VA01 mailbox.
#    SKIP THIS if "VA01 Only Scope" already exists (CYWorkspace created it) —
#    check with: Get-ManagementScope "VA01 Only Scope"
New-ManagementScope `
  -Name "VA01 Only Scope" `
  -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'va01@cy-bm.sg'"

# 3) Grant the app the Application Mail.Send role, scoped to VA01 only
New-ManagementRoleAssignment `
  -App <M365_CLIENT_ID> `
  -Role "Application Mail.Send" `
  -CustomResourceScope "VA01 Only Scope"

# Verify — expect one row: Role "Application Mail.Send",
# RoleAssigneeType ServicePrincipal, CustomResourceScope "VA01 Only Scope"
Get-ManagementRoleAssignment -RoleAssignee <M365_CLIENT_ID>
```

Propagation takes **2–15 minutes**. If the first send after setup fails, wait
and retry before changing anything.

**4c. Fallback for tenants without RBAC for Applications** (skip if 4b worked —
RBAC takes precedence):

```powershell
New-ApplicationAccessPolicy -AppId <M365_CLIENT_ID> `
  -PolicyScopeGroupId va01@cy-bm.sg `
  -AccessRight RestrictAccess `
  -Description "CYBills Mailer - VA01 only"

# Verify: first should say Granted, second Denied.
Test-ApplicationAccessPolicy -Identity va01@cy-bm.sg -AppId <M365_CLIENT_ID>
Test-ApplicationAccessPolicy -Identity ceo@cy-bm.sg  -AppId <M365_CLIENT_ID>
```

### 5. Set the env vars and restart

Put the four `M365_*` values in CYBills' `server/.env` on the VPS, then restart
the backend — the token is cached in-process, so **a restart is required after
any credential or RBAC change**.

### 6. Smoke test

Open an expense claim → **Send by email** to an address you control. Confirm two
things:

1. The dialog reports "Email sent to …" rather than showing the amber
   "not set up" note or an error.
2. The message appears in **VA01's Sent Items**. Sent Items is the source of
   truth for "Graph accepted it".

`GET /api/email/status` is a quick check that the server sees the vars:

```bash
curl -s https://cybills.cy-bm.sg/api/email/status
# {"enabled":true,"missing":[]}
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `AADSTS7000215: Invalid client secret` | Secret pasted wrong (you copied the Secret ID instead of the Value) or expired. Recreate — step 3. |
| `ErrorAccessDenied: [RAOP] : Blocked by tenant configured AppOnly AccessPolicy settings` | Tenant has RBAC for Applications on and the app isn't registered there. Do step 4b. An ApplicationAccessPolicy alone is **not** enough on these tenants, even when `Test-ApplicationAccessPolicy` returns Granted. |
| `AADServicePrincipalNotFound. No ServicePrincipal with Object Id 'X' ... is registered` | You passed the AppId where Exchange wants the Service Principal Object ID. Different GUIDs — see step 4a. |
| `The identity of the policy scope is not a security principal` | Legacy path: `-PolicyScopeGroupId` points at a plain distribution group. Point it at the mailbox address directly. |
| `The '<' operator is reserved for future use` | You pasted the literal placeholder including angle brackets. Use the bare GUID. |
| `A parameter cannot be found that matches parameter name 'X'` | Two cmdlets got mashed onto one line — PowerShell treats everything after a backtick continuation as one command. Run each block separately. |
| `The term 'New-ServicePrincipal' is not recognized` | You're not connected to Exchange Online. `Connect-ExchangeOnline`. |
| `Tenant does not have a SPO license` | `Mail.Send` needs an Exchange Online plan on VA01. Check the mailbox isn't an unlicensed shared alias. |
| Graph returns 202 but nothing arrives | Check VA01's Sent Items. If the message is there, the problem is downstream (recipient spam filter, external routing) — not this code. |
| Worked yesterday, 401s today | Client secret expired, or it was rotated without restarting the backend. Check the expiry in Certificates & secrets. |
| UI shows the amber "not set up" note | `GET /api/email/status` lists which vars the server still needs. Set them in `server/.env` and restart. |
