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

  // --- Org roster (assignable users) ----------------------------------------
  // Optional comma-separated roster of org members for the Support Desk
  // "Assignee" dropdown. Each entry is `email` or `email:Display Name`, e.g.
  // "ada@cy-bm.sg:Ada Lim,grace@cy-bm.sg". Falls back to a built-in seed roster
  // (see org.ts) when unset. The signed-in user is always included.
  ORG_MEMBERS: process.env.ORG_MEMBERS ?? '',

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
