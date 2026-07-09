import { Router, type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import { env, googleEnabled } from './env.js';

// Real Google OAuth 2.0 (authorization-code flow), server-side. The whole router
// no-ops with 503 until credentials are configured (see `googleEnabled`), so it
// is safe to ship before the boss provides a Google Cloud OAuth client.

const SESSION_COOKIE = 'cyb_session';
const STATE_COOKIE = 'cyb_oauth_state';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

type SessionUser = {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
};

function oauthClient(): OAuth2Client {
  return new OAuth2Client({
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  });
}

function baseCookieOpts() {
  return {
    httpOnly: true,
    secure: env.isProd, // HTTPS-only in prod; allows http on localhost dev
    sameSite: 'lax' as const,
    path: '/',
  };
}

function setSession(res: Response, user: SessionUser) {
  const token = jwt.sign(user, env.SESSION_SECRET, { expiresIn: SESSION_TTL_SECONDS });
  res.cookie(SESSION_COOKIE, token, { ...baseCookieOpts(), maxAge: SESSION_TTL_SECONDS * 1000 });
}

function readSession(req: Request): SessionUser | null {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, env.SESSION_SECRET) as jwt.JwtPayload & SessionUser;
    return { sub: payload.sub!, email: payload.email, name: payload.name, picture: payload.picture };
  } catch {
    return null;
  }
}

export const authRouter = Router();

// Lets the frontend decide whether to start real OAuth or fall back to its mock.
authRouter.get('/status', (_req, res) => {
  res.json({ googleEnabled });
});

// Who am I? Reads the session cookie. 401 when signed out.
authRouter.get('/me', (req, res) => {
  const user = readSession(req);
  if (!user) return res.status(401).json({ error: 'unauthenticated' });
  res.json({ user });
});

// Step 1: bounce the user to Google's consent screen.
authRouter.get('/google', (req, res) => {
  if (!googleEnabled) return res.status(503).json({ error: 'google_oauth_not_configured' });

  // CSRF: random state echoed back by Google and matched against a cookie.
  const state = randomBytes(16).toString('hex');
  res.cookie(STATE_COOKIE, state, { ...baseCookieOpts(), maxAge: 10 * 60 * 1000 });

  const url = oauthClient().generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    prompt: 'select_account',
    ...(env.ALLOWED_HOSTED_DOMAIN ? { hd: env.ALLOWED_HOSTED_DOMAIN } : {}),
  });
  res.redirect(url);
});

// Step 2: Google redirects back here with a code. Exchange it, verify the ID
// token, establish a session, and send the user into the app.
authRouter.get('/google/callback', async (req, res) => {
  if (!googleEnabled) return res.status(503).json({ error: 'google_oauth_not_configured' });

  const loginFailed = (reason: string) =>
    res.redirect(`${env.APP_ORIGIN}/login?error=${encodeURIComponent(reason)}`);

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const expectedState = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, baseCookieOpts());

  if (!code) return loginFailed('missing_code');
  if (!state || state !== expectedState) return loginFailed('bad_state');

  try {
    const client = oauthClient();
    const { tokens } = await client.getToken(code);
    if (!tokens.id_token) return loginFailed('no_id_token');

    const ticket = await client.verifyIdToken({
      idToken: tokens.id_token,
      audience: env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.email_verified) return loginFailed('email_unverified');
    if (env.ALLOWED_HOSTED_DOMAIN && payload.hd !== env.ALLOWED_HOSTED_DOMAIN) {
      return loginFailed('domain_not_allowed');
    }

    setSession(res, {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
    });
    res.redirect(`${env.APP_ORIGIN}/costs`);
  } catch {
    return loginFailed('exchange_failed');
  }
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, baseCookieOpts());
  res.json({ ok: true });
});
