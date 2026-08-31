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

  // --- Document reader (receipt/invoice extraction) -------------------------
  // Two interchangeable readers sit behind the extract + summarise endpoints:
  // Claude (Anthropic) and OpenAI. Configure either or both — whichever keys
  // are present is what the app offers (see `readerProviders` below), and
  // Business settings -> Extraction -> "Document reader" picks between them per
  // client entity. LLM_PROVIDER is the fallback when a request doesn't name one.
  //
  // Set ANTHROPIC_API_KEY to switch on the Claude reader. Model defaults to
  // Opus 4.8; set ANTHROPIC_MODEL=claude-sonnet-5 for a cheaper/faster option.
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-8',
  // Receipt/invoice extraction defaults to Sonnet 5 — Haiku was fast but misread
  // messy photographed receipts (wrong dates from DD/MM/YY, garbled amounts).
  // Accuracy matters more than the extra second here. Set
  // ANTHROPIC_EXTRACT_MODEL=claude-opus-4-8 for the most accurate (slower) read,
  // or =claude-haiku-4-5-20251001 to trade accuracy for speed.
  ANTHROPIC_EXTRACT_MODEL: process.env.ANTHROPIC_EXTRACT_MODEL ?? 'claude-sonnet-5',

  // Set OPENAI_API_KEY to switch on the OpenAI reader. It reads the same images
  // and PDFs against the same JSON schema, through the Responses API, so a
  // document read by either provider comes back in one shape.
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
  // Defaults to gpt-5 — cheaper per token than the Claude default and strong on
  // messy scans. Set OPENAI_EXTRACT_MODEL=gpt-5-mini to trade some accuracy for
  // cost/speed. Whatever you pick must accept image + PDF input.
  OPENAI_EXTRACT_MODEL: process.env.OPENAI_EXTRACT_MODEL ?? 'gpt-5',
  // How hard a reasoning model thinks before answering. Extraction is a reading
  // task, not a puzzle, so 'low' keeps it quick; raise to 'medium' if invoices
  // with awkward layouts are being misread. Ignored by non-reasoning models.
  OPENAI_REASONING_EFFORT: process.env.OPENAI_REASONING_EFFORT ?? 'low',
  // Optional: point at an OpenAI-compatible gateway (Azure OpenAI's v1 surface,
  // a proxy, a self-hosted endpoint). Blank = api.openai.com.
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? '',
  // Which reader a request that doesn't name one gets: 'claude' or 'openai'.
  // Falls back to whichever is actually configured, so this can't strand the
  // feature by naming a provider with no key.
  LLM_PROVIDER: (process.env.LLM_PROVIDER ?? 'claude').trim().toLowerCase(),

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
  // the published list prices in usage.ts. LLM_PRICES is the provider-neutral
  // name and covers OpenAI models too ('{"gpt-5":{"input":1.25,"output":10}}');
  // ANTHROPIC_PRICES still works and the two are merged.
  ANTHROPIC_PRICES: process.env.ANTHROPIC_PRICES ?? '',
  LLM_PRICES: process.env.LLM_PRICES ?? '',

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

  // CYWorkspace's PUBLIC origin. `CYWORKSPACE_RELAY_URL` is how we CALL it (on
  // the VPS that is 127.0.0.1:3001 — both apps share a box), but the file links
  // CYWS mints are public https URLs, and the only ones we will follow. Kept
  // separate so the loopback shortcut doesn't quietly become the allowlist.
  CYWORKSPACE_PUBLIC_URL: process.env.CYWORKSPACE_PUBLIC_URL ?? 'https://cyworkspace.cy-bm.sg',

  // The key CYWS sends BACK when it hands over a WhatsApp bill (X-API-Key on
  // POST /api/whatsapp/invoice). Ours to choose, and separate from
  // CYWORKSPACE_API_KEY, which is what we send to THEM: one leaking should not
  // hand over the other direction as well. Left unset, CYBills generates one on
  // first use and keeps it, so a practice admin can read it out of the app and
  // hand it over without any VPS access (see whatsapp.ts, inboundKey).
  WHATSAPP_INBOUND_KEY: process.env.WHATSAPP_INBOUND_KEY ?? '',

  // The webhook key from the Xero app's Webhooks page (My Apps -> Webhooks).
  // Xero signs every delivery with it (x-xero-signature, HMAC-SHA256 over the
  // RAW body), and that signature is the only thing that says a POST really
  // came from Xero — so with this unset the receiver can verify nothing and
  // refuses everything, which is also what an unconfigured deploy should do.
  XERO_WEBHOOK_KEY: process.env.XERO_WEBHOOK_KEY ?? '',

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

// The document readers, each switched on by its own API key. Either alone is
// enough for extraction to work; both means the org gets to choose.
export const claudeEnabled = Boolean(env.ANTHROPIC_API_KEY);
export const openaiEnabled = Boolean(env.OPENAI_API_KEY);

// Receipt extraction / document summarising is available once ANY reader is
// configured. Until then those endpoints return 503 vision_not_configured.
export const visionEnabled = claudeEnabled || openaiEnabled;

// The readers this deploy can actually use, in offer order. Sent to the client
// so Business settings only offers a provider whose key is present.
export const readerProviders: Array<'claude' | 'openai'> = [
  ...(claudeEnabled ? (['claude'] as const) : []),
  ...(openaiEnabled ? (['openai'] as const) : []),
];

// The reader used when a request doesn't name one — the configured preference
// when it has a key, otherwise the first reader that does.
export const defaultReaderProvider: 'claude' | 'openai' =
  (env.LLM_PROVIDER === 'openai' && openaiEnabled) || (env.LLM_PROVIDER === 'claude' && claudeEnabled)
    ? (env.LLM_PROVIDER as 'claude' | 'openai')
    : (readerProviders[0] ?? 'claude');

// Xero (via the cyworkspace relay) switches on once the shared webhook API key
// is configured. Until then the Xero endpoints return 503 xero_not_configured.
export const xeroEnabled = Boolean(env.CYWORKSPACE_API_KEY);

// WhatsApp bill collection runs entirely through CYWorkspace, on the same
// shared key as the Xero relay — so it switches on with that key, and the
// "create a group" button 503s until it is set.
export const whatsappEnabled = Boolean(env.CYWORKSPACE_API_KEY);

// Whether inbound Xero webhooks are accepted. Separate from `xeroEnabled`:
// calling OUT to Xero needs the relay key, being called IN by Xero needs the
// webhook key, and an install can legitimately have one without the other.
export const xeroWebhookEnabled = Boolean(env.XERO_WEBHOOK_KEY);

// R2 file storage switches on once the account, bucket, and credentials are all
// configured. Until then uploads persist metadata + dedup only (no stored file).
export const r2Enabled = Boolean(
  env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET
);


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
