import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { env, mailConfigured } from './env.js';
import { readSession } from './auth.js';
import { memberForSession } from './users.js';
import {
  authorizeEndpoint,
  graphScopes,
  redeemCode,
  sendMail,
  forgetCachedToken,
  testEmail,
} from './mailer.js';
import { saveMailAccount, clearMailAccount, mailStatus, senderAddress } from './mailAccount.js';

// Connecting the sending mailbox: a one-time OAuth authorization-code flow that
// an admin runs from Settings > Email. We ask for the DELEGATED `Mail.Send`
// scope plus `offline_access`, so the resulting refresh token can only ever be
// used to send as that one account — no tenant-wide application permission is
// involved, and nothing in any mailbox can be read.

const STATE_COOKIE = 'cyb_mail_state';

export const mailRouter = Router();

// PRACTICE TEAM ONLY, and a session is required. Same posture as the inbound
// Worker's secret, for the same reason: this is not a per-entity setting. There
// is ONE sending mailbox for the whole deployment — every client's invitations,
// password resets and password-changed notices leave from it — so a client's own
// Business Admin reading this surface could disconnect everybody's account
// email, or send from it. Mock/dev (no roster member) stays open so the flow can
// be exercised locally.
function mayManageMail(req: Request): boolean {
  const me = memberForSession(req);
  if (!me) return true; // no roster row — behaves as it did before
  return Boolean(me.practice) && !me.deactivated;
}

function requireAdmin(req: Request, res: Response): boolean {
  if (!readSession(req)) {
    res.status(401).json({ error: 'unauthenticated' });
    return false;
  }
  if (!mayManageMail(req)) {
    res.status(403).json({ error: 'not_practice_team' });
    return false;
  }
  return true;
}

function notConfigured(res: Response): boolean {
  if (mailConfigured) return false;
  res.status(503).json({
    error: 'mail_not_configured',
    message: 'Set GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET in server/.env. See deploy/EMAIL.md.',
  });
  return true;
}

// GET /api/mail/status — drives the Settings > Email panel.
mailRouter.get('/status', (req, res) => {
  if (!readSession(req) && env.SESSION_SECRET) return res.status(401).json({ error: 'unauthenticated' });
  // The panel it drives exists only for the practice, and the address it names
  // is the deployment's. Nothing else in the app reads it.
  if (!mayManageMail(req)) return res.status(403).json({ error: 'not_practice_team' });
  res.json(mailStatus());
});

// GET /api/mail/connect — step 1: bounce the admin to Microsoft's consent
// screen. `prompt=select_account` so they can pick the no-reply mailbox rather
// than silently reusing whichever account the browser is already signed into.
mailRouter.get('/connect', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (notConfigured(res)) return;

  const state = randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60 * 1000,
  });

  const url = new URL(authorizeEndpoint());
  url.searchParams.set('client_id', env.GRAPH_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', env.GRAPH_REDIRECT_URI);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', graphScopes().join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');
  return res.redirect(url.toString());
});

// GET /api/mail/callback — step 2: Microsoft redirects back with a code. Redeem
// it, store the refresh token, and return the admin to Settings with the
// outcome in the query string.
mailRouter.get('/callback', async (req, res) => {
  const back = (params: Record<string, string>) =>
    res.redirect(`${env.APP_ORIGIN}/settings?section=email&${new URLSearchParams(params)}`);

  if (!requireAdminRedirect(req, res, back)) return;

  const state = String(req.query.state ?? '');
  const expected = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: '/' });
  if (!state || !expected || state !== expected) return back({ mail: 'error', reason: 'bad_state' });

  // The user declined consent, or Azure rejected the request outright.
  if (req.query.error) {
    return back({ mail: 'error', reason: String(req.query.error_description ?? req.query.error).slice(0, 300) });
  }

  const code = String(req.query.code ?? '');
  if (!code) return back({ mail: 'error', reason: 'no_code' });

  try {
    const { accessToken, refreshToken, scopes } = await redeemCode(code);
    // Ask Graph who just consented, so the UI can name the connected mailbox.
    const who = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(20_000),
    });
    const me: any = await who.json().catch(() => null);
    const account = String(me?.mail || me?.userPrincipalName || '');
    if (!account) return back({ mail: 'error', reason: 'could_not_identify_account' });

    saveMailAccount({
      account,
      displayName: String(me?.displayName ?? ''),
      refreshToken,
      scopes,
      connectedBy: memberForSession(req)?.name || readSession(req)?.name || readSession(req)?.email || 'an admin',
    });
    forgetCachedToken(); // drop any token cached against a previous connection
    return back({ mail: 'connected', account });
  } catch (err) {
    return back({ mail: 'error', reason: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
  }
});

// The callback is a top-level redirect, so failures have to land back in the UI
// rather than as JSON. Same admin rule, different failure shape.
function requireAdminRedirect(
  req: Request,
  res: Response,
  back: (p: Record<string, string>) => void
): boolean {
  if (!readSession(req)) {
    back({ mail: 'error', reason: 'unauthenticated' });
    return false;
  }
  if (!mayManageMail(req)) {
    back({ mail: 'error', reason: 'not_practice_team' });
    return false;
  }
  return true;
}

// POST /api/mail/disconnect — forget the mailbox. Account email stops sending
// and the invite/reset flows fall back to handing links to the admin.
mailRouter.post('/disconnect', (req, res) => {
  if (!requireAdmin(req, res)) return;
  clearMailAccount();
  forgetCachedToken();
  return res.json(mailStatus());
});

// POST /api/mail/test — prove the connection end to end by mailing the admin
// who asked. The only way to be sure consent, scopes and Send As all line up.
mailRouter.post('/test', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const session = readSession(req);
  const to = String(req.body?.to || session?.email || '');
  if (!to) return res.status(400).json({ error: 'no_recipient' });

  const name = memberForSession(req)?.name || session?.name || to;
  const result = await sendMail({ to: { email: to, name }, ...testEmail({ name, sender: senderAddress() }) });
  return res.json({ ...result, to, sendingAs: senderAddress() });
});
