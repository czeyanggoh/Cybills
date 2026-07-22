import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { env } from './env.js';
import { authRouter } from './auth.js';
import { orgRouter } from './org.js';
import { extractRouter, vaultRouter } from './extract.js';
import { billsRouter } from './bills.js';
import { organisationsRouter } from './organisations.js';
import { xeroRouter } from './xero.js';

const app = express();

app.use(cors());
// Bills are uploaded as base64 in the JSON body; allow room for larger scans
// and PDFs (the client also downscales images before sending).
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());
app.use(morgan('tiny'));

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

app.listen(env.PORT, () => {
  console.log(`[cybills] server listening on :${env.PORT} (${env.NODE_ENV})`);
});
