import 'dotenv/config';

// Central place to read + validate process env. Keep it small; add keys as the
// app grows (DB URL, JWT secret, Xero creds, …).
export const env = {
  PORT: Number(process.env.PORT) || 3003,
  NODE_ENV: process.env.NODE_ENV ?? 'development',
};
