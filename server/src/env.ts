import 'dotenv/config';

// Central place to read + validate process env. Keep it small; add keys as the
// app grows (DB URL, JWT secret, Xero creds, …).
const NODE_ENV = process.env.NODE_ENV ?? 'development';

// Public origin the app is served from — used to build OAuth redirect URIs and
// to redirect back into the SPA after sign-in.
const APP_ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173';

export const env = {
  PORT: Number(process.env.PORT) || 3004,
  NODE_ENV,
  isProd: NODE_ENV === 'production',
  APP_ORIGIN,

  // --- Google OAuth ---------------------------------------------------------
  // All three must be present for real sign-in to switch on (see `googleEnabled`
  // below). Until then the frontend falls back to its mock sign-in so the app
  // keeps working without credentials configured.
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? '',
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET ?? '',
  GOOGLE_REDIRECT_URI:
    process.env.GOOGLE_REDIRECT_URI ?? `${APP_ORIGIN}/api/auth/google/callback`,
  // Secret used to sign the session cookie (JWT). Set to a long random string.
  SESSION_SECRET: process.env.SESSION_SECRET ?? '',
  // Optional: restrict sign-in to a single Google Workspace domain (e.g.
  // "cy-bm.sg"). Empty = any Google account allowed.
  ALLOWED_HOSTED_DOMAIN: process.env.ALLOWED_HOSTED_DOMAIN ?? '',

  // --- Claude Vision (receipt extraction) -----------------------------------
  // Set ANTHROPIC_API_KEY to switch on the /api/costs/extract endpoint. Model
  // defaults to Opus 4.8; set ANTHROPIC_MODEL=claude-sonnet-5 for a cheaper/
  // faster option.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8',
  // Receipt/invoice extraction defaults to Sonnet 5 — Haiku was fast but misread
  // messy photographed receipts (wrong dates from DD/MM/YY, garbled amounts).
  // Accuracy matters more than the extra second here. Set
  // ANTHROPIC_EXTRACT_MODEL=claude-opus-4-8 for the most accurate (slower) read,
  // or =claude-haiku-4-5-20251001 to trade accuracy for speed.
  ANTHROPIC_EXTRACT_MODEL: process.env.ANTHROPIC_EXTRACT_MODEL ?? 'claude-sonnet-5',

  // --- The practice (CYBM) --------------------------------------------------
  // CYBills is run BY an accounting practice FOR its clients. The practice's own
  // team are "colleagues" (Practice > Colleagues); each colleague is granted
  // "client access" to the client entities they work on, where they act as a
  // Business Admin. Everyone else on the roster is an employee of one client
  // entity and never leaves it.
  //
  // PRACTICE_DOMAIN is only used to recognise existing rows as practice staff
  // the first time this runs (the seeded team is matched by name/email too);
  // after that, membership is whatever the Colleagues page says.
  PRACTICE_NAME: process.env.PRACTICE_NAME ?? 'CYBM',
  PRACTICE_DOMAIN: process.env.PRACTICE_DOMAIN ?? 'cy-bm.sg',
  // Timezone the practice's day rolls over in — used to bucket "today's" Claude
  // API spend on the Clients page.
  PRACTICE_TIMEZONE: process.env.PRACTICE_TIMEZONE ?? 'Asia/Singapore',
  // Optional per-model price overrides for the API-cost estimate, USD per
  // million tokens: '{"claude-sonnet-5":{"input":2,"output":10}}'. Unset uses
  // the published list prices in usage.ts.
  ANTHROPIC_PRICES: process.env.ANTHROPIC_PRICES ?? '',

  // --- Org roster (assignable users) ----------------------------------------
  // Optional comma-separated roster of org members for the Support Desk
  // "Assignee" dropdown. Each entry is `email` or `email:Display Name`, e.g.
  // "ada@cy-bm.sg:Ada Lim,grace@cy-bm.sg". Falls back to a built-in seed roster
  // (see org.ts) when unset. The signed-in user is always included.
  ORG_MEMBERS: process.env.ORG_MEMBERS ?? '',

  // --- Admin recovery -------------------------------------------------------
  // Optional comma-separated emails that are always treated as account owners
  // (Admin role), e.g. "czeyang.goh@cy-bm.sg,astrid@cy-bm.sg". Break-glass for
  // the case where an owner's roster row drifted to Standard under an address
  // the built-in seed doesn't know (e.g. signed up through /join with a
  // different Google account) — which silently hides Users and Business
  // settings from them. Their row is promoted on load; nobody is ever demoted.
  OWNER_EMAILS: process.env.OWNER_EMAILS ?? '',

  // --- Bills store ----------------------------------------------------------
  // Directory for the persisted-bills JSON file (uploaded cost documents +
  // duplicate-detection index). Empty = default to server/.data (gitignored, so
  // it survives the deploy's `git reset --hard`). Set to an absolute path to
  // store data outside the repo checkout.
  BILLS_DATA_DIR: process.env.BILLS_DATA_DIR ?? '',

  // --- Xero (via the cyworkspace relay) --------------------------------------
  // CYBills never talks to Xero or holds Xero tokens directly. All Xero calls
  // go through cyworkspace's authenticated relay, which owns the OAuth client,
  // token refresh, and rate-limit retries. Set the relay origin (on the VPS
  // both apps share a box, so http://127.0.0.1:3001 avoids the public round
  // trip) and the shared webhook API key. Xero features 503 until the key is
  // set (see `xeroEnabled`).
  CYWORKSPACE_RELAY_URL: process.env.CYWORKSPACE_RELAY_URL ?? 'https://cyworkspace.cy-bm.sg',
  CYWORKSPACE_API_KEY: process.env.CYWORKSPACE_API_KEY ?? '',

  // --- Cloudflare R2 (original bill files) ----------------------------------
  // Object storage for the uploaded file bytes (the JSON store only keeps
  // metadata + a hash). All four must be set for file storage to switch on (see
  // `r2Enabled`); until then uploads still persist metadata + dedup, just
  // without a retrievable original. R2 exposes an S3-compatible API at
  // https://<account-id>.r2.cloudflarestorage.com.
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID ?? '',
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? '',
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? '',
  R2_BUCKET: process.env.R2_BUCKET ?? '',

  // --- CYHR handoff (signed deep links) -------------------------------------
  // CYBills captures the receipt + Xero category, then deep-links the employee
  // into CYHR where the claim lands prefilled for them to submit and the admin
  // to approve. The link is HMAC-SHA256 signed with a secret shared with CYHR
  // (same value on both sides) so the params can't be altered en route. The
  // secret is used ONLY on the server to compute the signature — it never
  // reaches the browser. Both must be set for the handoff to switch on (see
  // `cyhrEnabled`); until then the "Submit to CYHR" action is disabled.
  // CYHR_BASE_URL is the full claim-form URL; defaults to CYHR's confirmed
  // expenses form so only the secret has to be set on the VPS to switch on.
  CYHR_BASE_URL: process.env.CYHR_BASE_URL ?? 'https://hr.cy-bm.sg/claims/expenses/new',
  CYHR_SIGNING_SECRET: process.env.CYHR_SIGNING_SECRET ?? '',
  // Model B: where an APPROVED claim's payable is routed to CYHR for payment.
  // Path unconfirmed until CYHR builds the payment-intake page; override here.
  CYHR_PAYMENT_URL: process.env.CYHR_PAYMENT_URL ?? 'https://hr.cy-bm.sg/payments/new',

  // --- Outbound email (Microsoft Graph, DELEGATED) --------------------------
  // Account emails (invitations, password resets/changes) are sent through
  // Graph's sendMail as a signed-in Microsoft user — the app registration holds
  // the `Mail.Send` DELEGATED permission, never the Application one. Delegated
  // means the app can only ever send as the account that consented; it has no
  // tenant-wide reach and cannot read any mailbox.
  //
  // Because a password-reset is triggered by someone who is BY DEFINITION not
  // signed in, an admin connects the sending mailbox once (Settings > Email)
  // and CYBills keeps the resulting refresh token (encrypted at rest, see
  // mailAccount.ts). Sending then works for every flow, still as that one user.
  //
  // These three make the connection POSSIBLE (`mailConfigured`); mail actually
  // sends once a mailbox is connected (`isMailConnected()`). Until then the
  // invite/reset endpoints still mint the link and hand it back so an admin can
  // pass it on manually. See deploy/EMAIL.md.
  GRAPH_TENANT_ID: process.env.GRAPH_TENANT_ID ?? '',
  GRAPH_CLIENT_ID: process.env.GRAPH_CLIENT_ID ?? '',
  GRAPH_CLIENT_SECRET: process.env.GRAPH_CLIENT_SECRET ?? '',
  // Must EXACTLY match a "Web" redirect URI on the app registration.
  GRAPH_REDIRECT_URI: process.env.GRAPH_REDIRECT_URI ?? `${APP_ORIGIN}/api/mail/callback`,
  // Optional: send from a SHARED mailbox (e.g. no-reply@cy-bm.sg) instead of
  // the connecting admin's own. Needs the `Mail.Send.Shared` delegated
  // permission plus "Send As" rights on that mailbox for the connecting user —
  // still delegated, still not tenant-wide. Blank = send as the connected user.
  GRAPH_SHARED_SENDER: process.env.GRAPH_SHARED_SENDER ?? '',
  // Optional Reply-To, so replies to a no-reply sender reach a real inbox.
  MAIL_REPLY_TO: process.env.MAIL_REPLY_TO ?? '',
  // How long an invitation / password-reset link stays valid.
  INVITE_TTL_DAYS: Number(process.env.INVITE_TTL_DAYS) || 7,

  // --- Outbound email via SMTP (any transactional provider) -----------------
  // The universal alternative to Microsoft Graph, for domains not on Microsoft
  // 365 (e.g. a Cloudflare-managed domain, which only *receives*). Point these
  // at a transactional provider (Resend, Brevo, Mailgun, Amazon SES, …) that is
  // verified to send as your domain. When SMTP is configured it takes priority
  // over Graph. See deploy/EMAIL.md.
  SMTP_HOST: process.env.SMTP_HOST ?? '',
  SMTP_PORT: Number(process.env.SMTP_PORT) || 587,
  SMTP_USER: process.env.SMTP_USER ?? '',
  SMTP_PASS: process.env.SMTP_PASS ?? '',
  // true for implicit TLS on port 465; false for STARTTLS on 587 (the default).
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  // The From address all account email is sent as, e.g. no-reply@cybills.sg.
  MAIL_FROM: process.env.MAIL_FROM ?? '',
  MAIL_FROM_NAME: process.env.MAIL_FROM_NAME ?? 'CYBills',
};

// Real Google sign-in is only enabled once the client credentials AND a session
// secret are configured. Kept as a getter so tests/deploys can toggle via env.
export const googleEnabled = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET
);

// Claude Vision receipt extraction is enabled once an Anthropic API key is set.
export const visionEnabled = Boolean(env.ANTHROPIC_API_KEY);

// Xero (via the cyworkspace relay) switches on once the shared webhook API key
// is configured. Until then the Xero endpoints return 503 xero_not_configured.
export const xeroEnabled = Boolean(env.CYWORKSPACE_API_KEY);

// R2 file storage switches on once the account, bucket, and credentials are all
// configured. Until then uploads persist metadata + dedup only (no stored file).
export const r2Enabled = Boolean(
  env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET
);

// The CYHR handoff switches on once the target URL AND the shared signing
// secret are configured. Until then /api/cyhr/claim-link returns 503 and the
// client disables the "Submit to CYHR" action.
export const cyhrEnabled = Boolean(env.CYHR_BASE_URL && env.CYHR_SIGNING_SECRET);

// Whether a mailbox CAN be connected — i.e. the Azure app registration is
// configured. Sending additionally needs an admin to have connected a mailbox
// (see isMailConnected() in mailAccount.ts): delegated auth has no credential
// of its own, it borrows a user's. Until both hold, invite/reset links are
// still generated — they're just returned to the admin instead of emailed.
export const mailConfigured = Boolean(
  env.GRAPH_TENANT_ID && env.GRAPH_CLIENT_ID && env.GRAPH_CLIENT_SECRET
);

// SMTP sending is ready as soon as host + credentials + a From address are set.
// Unlike Graph (delegated) it needs no interactive "connect" step, so once these
// are present mail sends straight away. Takes priority over Graph when set.
export const smtpConfigured = Boolean(
  env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM
);
