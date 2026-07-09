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
};

// Real Google sign-in is only enabled once the client credentials AND a session
// secret are configured. Kept as a getter so tests/deploys can toggle via env.
export const googleEnabled = Boolean(
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.SESSION_SECRET
);

// Claude Vision receipt extraction is enabled once an Anthropic API key is set.
export const visionEnabled = Boolean(env.ANTHROPIC_API_KEY);
