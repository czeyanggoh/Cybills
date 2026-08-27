import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import { env, googleEnabled } from './env.js';
import { authRouter, readSession } from './auth.js';
import { orgRouter } from './org.js';
import { extractRouter, vaultRouter } from './extract.js';
import { billsRouter } from './bills.js';
import { inboundRouter } from './inbound.js';
import { organisationsRouter } from './organisations.js';
import { xeroRouter } from './xero.js';
import { cyhrRouter } from './cyhr.js';
import { claimsRouter } from './claims.js';
import { autoClaimsRouter } from './autoClaims.js';
import { usersRouter, memberForSession, canAccessOrg } from './users.js';
import { practiceRouter } from './practice.js';
import { mailRouter } from './mail.js';
import { settingsRouter, adoptLegacySettings } from './settings.js';
import { boardRouter } from './board.js';
import { xeroWebhookRouter } from './xeroWebhook.js';
import { whatsappRouter } from './whatsapp.js';
import { scrubFillerText } from './store.js';
import { verifyShareToken } from './shareLinks.js';

const app = express();

app.use(cors());

// Xero webhooks, before everything else. Two reasons this one route jumps the
// queue: its signature covers the RAW request bytes, so it must not meet
// express.json() first (a re-serialised body is a different body), and it is
// called by Xero rather than by a signed-in person, so the session guard below
// would answer it 401 forever. It carries its own proof instead — the
// x-xero-signature HMAC, which is what makes it safe out here.
app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }), xeroWebhookRouter);

// Bills are uploaded as base64 in the JSON body; allow room for larger scans
// and PDFs (the client also downscales images before sending).
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());
app.use(morgan('tiny'));

// Auth guard: once real Google sign-in is on, the data APIs require a valid
// session — otherwise anyone with the URL could read/write company data. Public:
// the auth flow, the password login (how you GET a session), the health check,
// and a bill file opened with a signed share link (exported CSVs and claim PDFs
// are read outside the app). In mock/dev (no Google configured) everything stays
// open so local development isn't blocked.
app.use((req, res, next) => {
  if (!googleEnabled) return next();
  const p = req.path;
  if (!p.startsWith('/api/')) return next();
  if (p.startsWith('/api/auth')) return next();
  if (p === '/api/users/login') return next();
  // Invitation / password-reset links are opened by people who, by definition,
  // can't sign in yet — these three are the flow that gets them a password.
  if (p === '/api/users/forgot-password') return next();
  if (p === '/api/users/reset') return next();
  if (p.startsWith('/api/users/reset/')) return next();
  if (p === '/api/health') return next();
  // Inbound email is machine-to-machine (the Cloudflare Email Worker), guarded
  // by its own shared secret rather than a user session.
  if (p === '/api/inbound/email') return next();
  // Same for a bill handed over from a WhatsApp collection group: CYWorkspace
  // calls it machine-to-machine and proves itself with its own X-API-Key.
  if (p === '/api/whatsapp/invoice') return next();
  // An image link in an exported CSV, or an Item ID in an emailed claim PDF, is
  // opened by somebody with no session here — an accountant, an approver. It
  // carries a signed, expiring token naming the one document it opens instead
  // (shareLinks.ts); the route itself then checks that the document's entity
  // still allows sharing.
  const shared = /^\/api\/costs\/bills\/([^/]+)\/file$/.exec(p);
  if (shared && verifyShareToken(decodeURIComponent(shared[1]), String(req.query.s ?? ''))) return next();
  if (!readSession(req)) return res.status(401).json({ error: 'unauthenticated' });
  return next();
});

// Client-access guard. Every per-entity API (bills, Xero, settings, claims, the
// user roster) names the entity it is working in with an X-Org-Id header, so
// one check here covers all of them: a client entity's staff can only ever
// address their own entity, and a practice colleague only the clients they have
// been given. Deliberately narrow — it judges nothing when there's no header,
// no session, or no roster row for the caller, so every pre-existing caller
// behaves exactly as before.
app.use((req, res, next) => {
  if (!googleEnabled || !req.path.startsWith('/api/')) return next();
  // Two endpoints answer "who am I / let me in", and neither is about the
  // entity in the header. Self-signup names the company it is joining in its
  // BODY, and the browser is still carrying whichever entity it last had open —
  // so the one request that exists to MAKE somebody a member was refused for
  // not already being one, and the join form could only say "please try again".
  if (req.path.startsWith('/api/users/join') || req.path === '/api/users/me') return next();
  const requested = (req.header('X-Org-Id') || '').trim();
  if (!requested) return next();
  const me = memberForSession(req);
  if (!me || canAccessOrg(me, requested)) return next();
  return res.status(403).json({ error: 'no_client_access' });
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

// Auto Expense claims — the schedule that files each person's finished cost
// documents into a claim for them when a claims period ends.
app.use('/api/auto-claims', autoClaimsRouter);

// Users — server-backed + shared (people list + approver roster).
app.use('/api/users', usersRouter);
app.use('/api/inbound', inboundRouter);

// Bill collection over WhatsApp, in partnership with CYWorkspace: asking it for
// a group per submission, and receiving the supplier bills its classifier
// picks out of that group. 503s until CYWORKSPACE_API_KEY is set.
app.use('/api/whatsapp', whatsappRouter);

// The practice (CYBM) itself: its colleagues, their client access, and the
// connected-client list with what each has cost in Claude API usage.
app.use('/api/practice', practiceRouter);

// Connecting the Microsoft 365 sending mailbox (delegated Mail.Send). 503s
// until the GRAPH_* app-registration vars are set.
app.use('/api/mail', mailRouter);

// Per-workspace settings blobs — Lists, custom categories, customer/supplier rules.
app.use('/api/settings', settingsRouter);

// Support Desk boards (tickets / feature requests / testing checklist) — shared.
app.use('/api/board', boardRouter);

app.listen(env.PORT, () => {
  console.log(`[cybills] server listening on :${env.PORT} (${env.NODE_ENV})`);
  // Documents read before the extractor stopped emitting filler carry literal
  // "placeholder" text, which publishes to Xero as the bill's line description.
  // Idempotent, so it just no-ops on every boot after the first.
  const scrubbed = scrubFillerText();
  if (scrubbed) console.log(`[cybills] cleared filler text on ${scrubbed} document(s)`);
  // The Business profile is per-entity now; hand the one saved before that to
  // the entity it actually describes. Idempotent, so it no-ops after the first.
  const adopted = adoptLegacySettings();
  if (adopted) console.log(`[cybills] primary organisation adopted ${adopted} legacy setting(s)`);
});
