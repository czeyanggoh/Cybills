import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { env, googleEnabled } from './env.js';
import { authRouter, readSession } from './auth.js';
import { orgRouter } from './org.js';
import { extractRouter, vaultRouter } from './extract.js';
import { billsRouter } from './bills.js';
import { organisationsRouter } from './organisations.js';
import { xeroRouter } from './xero.js';
import { cyhrRouter } from './cyhr.js';
import { claimsRouter } from './claims.js';
import { usersRouter } from './users.js';
import { settingsRouter } from './settings.js';
import { boardRouter } from './board.js';
import { emailRouter } from './emailRoutes.js';

const app = express();

app.use(cors());
// Bills are uploaded as base64 in the JSON body; allow room for larger scans
// and PDFs (the client also downscales images before sending).
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());
app.use(morgan('tiny'));

// Auth guard: once real Google sign-in is on, the data APIs require a valid
// session — otherwise anyone with the URL could read/write company data. Public:
// the auth flow, the password login (how you GET a session), the health check,
// and the capability-URL bill file (opened from exported CSV links without a
// session). In mock/dev (no Google configured) everything stays open so local
// development isn't blocked.
app.use((req, res, next) => {
  if (!googleEnabled) return next();
  const p = req.path;
  if (!p.startsWith('/api/')) return next();
  if (p.startsWith('/api/auth')) return next();
  if (p === '/api/users/login') return next();
  if (p === '/api/health') return next();
  if (/^\/api\/costs\/bills\/[^/]+\/file$/.test(p)) return next();
  if (!readSession(req)) return res.status(401).json({ error: 'unauthenticated' });
  return next();
});

// Health check — nginx proxies /api/* here, and deploy.sh curls this to
// confirm the backend came back up after a restart.
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'cybills-server', ts: new Date().toISOString() });
});

// Google sign-in (auth code flow). No-ops until credentials are configured.
app.use('/api/auth', authRouter);

// Org directory — assignable users for the Support Desk "Assignee" dropdown.
app.use('/api/org', orgRouter);

// Claude Vision receipt extraction. 503s until ANTHROPIC_API_KEY is set.
app.use('/api/costs', extractRouter);

// Persisted bills + duplicate detection (works without a Vision key).
app.use('/api/costs', billsRouter);

// Vault document summariser (Claude auto-fill for stored documents).
app.use('/api/vault', vaultRouter);

// Organisations linked to Xero tenants (via the cyworkspace relay).
app.use('/api/organisations', organisationsRouter);

// Xero, spoken through cyworkspace's relay. 503s until CYWORKSPACE_API_KEY set.
app.use('/api/xero', xeroRouter);

// CYHR handoff: signed deep links that prefill a claim in CYHR. 503s until
// CYHR_BASE_URL + CYHR_SIGNING_SECRET are set.
app.use('/api/cyhr', cyhrRouter);

// Expense claims — server-backed + shared across the workspace.
app.use('/api/claims', claimsRouter);

// Users — server-backed + shared (people list + approver roster).
app.use('/api/users', usersRouter);

// Per-workspace settings blobs — Lists, custom categories, customer/supplier rules.
app.use('/api/settings', settingsRouter);

// Support Desk boards (tickets / feature requests / testing checklist) — shared.
app.use('/api/board', boardRouter);

// Outbound email as VA01@cy-bm.sg via Microsoft Graph. 503s until the four
// M365_* vars are set; the UI falls back to a Copy button until then.
app.use('/api/email', emailRouter);

app.listen(env.PORT, () => {
  console.log(`[cybills] server listening on :${env.PORT} (${env.NODE_ENV})`);
});
