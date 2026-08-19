import { Router, type Request, type Response } from 'express';
import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId } from './workspace.js';
import { setSession, readSession } from './auth.js';
import { env } from './env.js';
import { sendMail, inviteEmail, passwordResetEmail, passwordChangedEmail } from './mailer.js';

// Password login (non-Google), so staff on Google Workspace accounts that Google
// blocks can still sign in. Passwords are salted + scrypt-hashed (Node built-in,
// no native dep). An admin (already signed in) sets a user's password; the user
// then logs in with email + password, getting the same session cookie as Google.
function hashPassword(pw: string): string {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const orig = Buffer.from(hash, 'hex');
  const test = scryptSync(pw, salt, 64);
  return orig.length === test.length && timingSafeEqual(orig, test);
}

// Invitation / password-reset links. The raw token only ever exists in the
// email (and in the response to the admin who triggered it) — the row keeps a
// SHA-256 so the stored copy is useless on its own. One live token per user:
// issuing a new link silently invalidates the previous one.
const TOKEN_TTL_MS = env.INVITE_TTL_DAYS * 24 * 60 * 60 * 1000;
const tokenHash = (raw: string) => createHash('sha256').update(raw).digest('hex');

function issueToken(user: User, kind: 'invite' | 'reset'): string {
  const raw = randomBytes(32).toString('hex');
  user.resetTokenHash = tokenHash(raw);
  user.resetTokenExpires = Date.now() + TOKEN_TTL_MS;
  user.resetTokenKind = kind;
  return raw;
}

function clearToken(user: User) {
  delete user.resetTokenHash;
  delete user.resetTokenExpires;
  delete user.resetTokenKind;
}

// The public origin to build emailed links from. Prefer an explicitly-set
// APP_ORIGIN, but when it's left at the localhost default, derive the real
// origin from the incoming request (behind nginx: X-Forwarded-Proto/Host) so
// invite/reset links point at the domain the app is actually served from —
// no env footgun.
function appOrigin(req: Request): string {
  const configured = (env.APP_ORIGIN || '').replace(/\/+$/, '');
  if (configured && !configured.includes('localhost')) return configured;
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : (configured || 'http://localhost:5173');
}

// The page the emailed link lands on, where the recipient chooses a password.
const resetUrl = (req: Request, raw: string) => `${appOrigin(req)}/set-password?token=${raw}`;

function findByToken(items: User[], raw: string): User | undefined {
  if (!raw) return undefined;
  const h = tokenHash(raw);
  return items.find((u) => u.resetTokenHash === h && !u.removed && (u.resetTokenExpires ?? 0) > Date.now());
}

// Server-backed users, shared across the workspace (same JSON-store pattern as
// claims). This is the company's people list + approver roster + Users-page
// data — now central and shared instead of per-browser localStorage.

type User = {
  id: string;
  workspaceId: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  login: 'Yes' | 'No';
  role: string;
  mobile: string;
  privileges: Record<string, unknown>;
  lastLogin: string;
  deactivated: boolean;
  removed: boolean;
  // Self-signup: a user who joined via /join is `pending` until an admin
  // approves them, and is tied to the company (organisation) they picked.
  pending: boolean;
  companyId: string;
  companyName: string;
  passwordHash?: string; // set by an admin; never returned to the client
  // Single-use invitation / password-reset link. Only the SHA-256 of the token
  // is stored, so a leaked data file can't be replayed into an account.
  resetTokenHash?: string;
  resetTokenExpires?: number; // epoch ms
  resetTokenKind?: 'invite' | 'reset';
  invitedAt?: string; // ISO timestamp of the last invitation sent
};

// Public shape sent to the client — never leak the password hash or the reset
// token; expose only whether a password has been set.
function publicUser(u: User) {
  const { passwordHash, resetTokenHash, resetTokenExpires, resetTokenKind, ...rest } = u;
  return { ...rest, hasPassword: Boolean(passwordHash) };
}

const COLLECTION = 'users';
const load = () => loadCollection<User>(COLLECTION);
const save = (items: User[]) => saveCollection(COLLECTION, items);

// The real company employees (matching the CYHR/Talenox records). Seeded once
// per workspace so the list is never empty.
const SEED: Array<Partial<User>> = [
  { id: 'astrid', name: 'Astrid Yang', email: 'astridy2004@gmail.com', login: 'Yes', role: 'Business Admin' },
  { id: 'cze', name: 'Cze Yang Goh', email: 'czeyang.goh@cy-bm.sg', login: 'Yes', role: 'Business Admin' },
  { id: 'yeoh', name: 'Yeoh Lay Ean', email: 'joanne_yle@yahoo.com', login: 'Yes', role: 'Standard' },
  { id: 'yuyu', name: 'Yu Yu', email: 'yuyu@cy-bm.sg', login: 'Yes', role: 'Standard' },
];

const norm = (s: string) => String(s ?? '').trim().toLowerCase();
// The intended one-email-per-teammate identity, from the seed (each person's
// real address that both their login and CYHR use).
const SEED_EMAIL_BY_NAME = new Map(SEED.map((s) => [norm(String(s.name)), norm(String(s.email))]));
const SEED_IDS = new Set(SEED.map((s) => s.id));

function full(u: Partial<User>, ws: string): User {
  const name = (u.name || `${u.firstName || ''} ${u.lastName || ''}`).trim() || 'New user';
  return {
    id: u.id || `nu_${randomUUID().slice(0, 8)}`,
    workspaceId: ws,
    name,
    firstName: u.firstName || '',
    lastName: u.lastName || '',
    email: u.email || '',
    login: u.login === 'No' ? 'No' : 'Yes',
    role: u.role || 'Standard',
    mobile: u.mobile || '',
    privileges: u.privileges || {},
    lastLogin: u.lastLogin || '—',
    deactivated: Boolean(u.deactivated),
    removed: Boolean(u.removed),
    pending: Boolean(u.pending),
    companyId: u.companyId || '',
    companyName: u.companyName || '',
  };
}

// Collapse duplicate rows for the same person (same name) into a single row, so
// every teammate has exactly one email. Idempotent — runs on every load so a
// roster that drifted (a person added twice under two addresses) self-heals.
// Prefers the row whose email is the teammate's canonical seed address; else one
// that can log in (has a password); else the original seed row; else the first.
// Any password on a discarded duplicate is carried onto the keeper so sign-in
// keeps working. Returns true if anything changed.
function normalizeRoster(items: User[], ws: string): boolean {
  const groups = new Map<string, User[]>();
  for (const u of items) {
    if (u.workspaceId !== ws || u.removed) continue;
    const key = norm(u.name);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.push(u);
    else groups.set(key, [u]);
  }
  let changed = false;
  for (const [name, dups] of groups) {
    if (dups.length < 2) continue; // already one row — nothing to unify
    const seedEmail = SEED_EMAIL_BY_NAME.get(name);
    const keeper =
      (seedEmail ? dups.find((d) => norm(d.email) === seedEmail) : undefined) ||
      dups.find((d) => d.passwordHash) ||
      dups.find((d) => SEED_IDS.has(d.id)) ||
      dups[0];
    if (!keeper.passwordHash) {
      const withPw = dups.find((d) => d.passwordHash);
      if (withPw) {
        keeper.passwordHash = withPw.passwordHash;
        changed = true;
      }
    }
    for (const d of dups) {
      if (d !== keeper && !d.removed) {
        d.removed = true;
        changed = true;
      }
    }
  }
  return changed;
}

// Guarantee the seeded owners (Astrid, Cze) never lose their admin role. Their
// row can drift to a non-admin role — e.g. re-created via the /join self-signup
// flow, which always sets 'Standard' — which would silently lock the account
// owner out of Users and Business settings. Runs on every load so it self-heals.
// Matches by email OR name, so an owner who signed up under a different address
// than the seed email is still recovered. Only ever promotes seed admins; never
// touches other users or demotes anyone.
function reconcileSeedAdmins(items: User[], ws: string): boolean {
  let changed = false;
  for (const s of SEED) {
    if (!isAdminRole(String(s.role))) continue;
    const email = norm(String(s.email));
    const name = norm(String(s.name));
    const row = items.find(
      (u) => u.workspaceId === ws && !u.removed && (norm(u.email) === email || norm(u.name) === name)
    );
    if (row && !isAdminRole(row.role)) {
      row.role = String(s.role);
      changed = true;
    }
  }
  return changed;
}

// Return the workspace's users, seeding the real employees on first use and
// keeping the roster de-duplicated (one email per teammate).
function ensure(ws: string): User[] {
  const items = load();
  let changed = false;
  if (!items.some((u) => u.workspaceId === ws)) {
    items.push(...SEED.map((s) => full(s, ws)));
    changed = true;
  }
  if (normalizeRoster(items, ws)) changed = true;
  if (reconcileSeedAdmins(items, ws)) changed = true;
  if (changed) save(items);
  return items;
}

// The roster member for the signed-in caller (by session email), or null in a
// session-less (mock/dev) context. Used for role-based access control.
export function memberForSession(req: Request): User | null {
  const s = readSession(req);
  if (!s?.email) return null;
  const ws = workspaceId(req);
  const email = norm(s.email);
  return ensure(ws).find((u) => u.workspaceId === ws && !u.removed && norm(u.email) === email) ?? null;
}

// Business/User Admins manage the account; everyone else is limited.
export function isAdminRole(role: string | undefined): boolean {
  return role === 'Business Admin' || role === 'User Admin';
}

const EDITABLE: (keyof User)[] = ['name', 'firstName', 'lastName', 'email', 'login', 'role', 'mobile', 'privileges', 'deactivated', 'pending', 'companyId', 'companyName'];

// Apply the editable fields present in `b` onto a user, keeping name in sync
// with first/last. Shared by the add-merge path and PATCH.
function applyEditable(user: User, b: Partial<User>) {
  for (const k of EDITABLE) if (k in b) (user as Record<string, unknown>)[k] = (b as Record<string, unknown>)[k];
  if ('firstName' in b || 'lastName' in b) {
    const nm = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    if (nm) user.name = nm;
  }
}

export const usersRouter = Router();

usersRouter.get('/', (req, res) => {
  const ws = workspaceId(req);
  res.json({ users: ensure(ws).filter((u) => u.workspaceId === ws && !u.removed).map(publicUser) });
});

// GET /api/users/me — the signed-in user's membership status, used to gate the
// app: 'anonymous' (no session), 'none' (signed in but no roster profile — send
// to /join), 'pending' (awaiting approval), 'deactivated', or 'active'.
usersRouter.get('/me', (req, res) => {
  const session = readSession(req);
  if (!session?.email) return res.json({ status: 'anonymous', user: null });
  const ws = workspaceId(req);
  const email = norm(session.email);
  const user = ensure(ws).find((u) => u.workspaceId === ws && !u.removed && norm(u.email) === email);
  if (!user) return res.json({ status: 'none', user: null });
  const status = user.deactivated ? 'deactivated' : user.pending ? 'pending' : 'active';
  return res.json({ status, user: publicUser(user) });
});

// POST /api/users/join — self-signup onboarding. The signed-in user submits
// their details and the company (organisation) they belong to; they become a
// pending roster member until an admin approves. Idempotent: re-joining updates
// the same row, and an already-active member is left untouched.
usersRouter.post('/join', (req, res) => {
  const session = readSession(req);
  if (!session?.email) return res.status(401).json({ error: 'unauthenticated' });
  const ws = workspaceId(req);
  const items = ensure(ws);
  const email = norm(session.email);
  const b = req.body ?? {};
  const firstName = String(b.firstName || '').trim();
  const lastName = String(b.lastName || '').trim();
  const fields = {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim() || session.name || session.email,
    mobile: String(b.mobile || '').trim(),
    companyId: String(b.companyId || '').trim(),
    companyName: String(b.companyName || '').trim(),
    role: String(b.role || 'Standard'),
  };
  let user = items.find((u) => u.workspaceId === ws && !u.removed && norm(u.email) === email);
  if (user) {
    if (!user.pending && user.login === 'Yes' && !user.deactivated) {
      return res.json({ status: 'active', user: publicUser(user) }); // already a member
    }
    Object.assign(user, fields, { email: session.email, login: 'No', pending: true, deactivated: false });
  } else {
    user = full({ ...fields, email: session.email, login: 'No', pending: true }, ws);
    items.unshift(user);
  }
  save(items);
  return res.json({ status: 'pending', user: publicUser(user) });
});

// POST /api/users/:id/approve — an admin (signed in) approves a pending member,
// granting access.
usersRouter.post('/:id/approve', (req, res) => {
  if (!readSession(req)) return res.status(401).json({ error: 'unauthenticated' });
  return mutate(req, res, (user) => {
    user.pending = false;
    user.deactivated = false;
    user.login = 'Yes';
  });
});

// Add one or many users. Body: a user object, or { users: [...] }. To keep one
// email per teammate, an incoming user that matches an existing one (by email
// or name) updates that teammate in place instead of creating a duplicate row.
usersRouter.post('/', (req, res) => {
  const ws = workspaceId(req);
  const items = ensure(ws);
  const incoming: Partial<User>[] = Array.isArray(req.body?.users) ? req.body.users : [req.body ?? {}];
  const affected: User[] = [];
  for (const u of incoming) {
    const email = norm(String(u.email || ''));
    const name = norm(String(u.name || `${u.firstName || ''} ${u.lastName || ''}`).trim());
    const existing = items.find(
      (x) =>
        x.workspaceId === ws && !x.removed &&
        ((email && norm(x.email) === email) || (name && norm(x.name) === name))
    );
    if (existing) {
      applyEditable(existing, u);
      affected.push(existing);
    } else {
      const created = full({ ...u, id: undefined }, ws);
      items.unshift(created);
      affected.push(created);
    }
  }
  save(items);
  res.json({ users: affected.map(publicUser) });
});

// POST /api/users/login — non-Google sign-in with email + password. Issues the
// same session cookie as Google, so the rest of the app works unchanged.
usersRouter.post('/login', (req, res) => {
  const ws = workspaceId(req);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'missing_credentials' });
  const user = ensure(ws).find(
    (u) => u.workspaceId === ws && !u.removed && !u.deactivated && u.email.toLowerCase() === email
  );
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'invalid_login' });
  }
  setSession(res, { sub: user.id, email: user.email, name: user.name });
  return res.json({ user: publicUser(user) });
});

// --- Account email flows (invite / reset / change password) -------------------
// All of these mint a single-use link and mail it via Microsoft Graph. When
// mail isn't configured the link is still created and returned to the admin, so
// onboarding works before (or during an outage of) the mail setup.

const MIN_PASSWORD = 8;

// Only Business/User Admins may invite or reset someone else's account. In
// mock/dev (no session-backed roster member) the check is skipped, matching the
// rest of the app's dev-open posture.
function requireAdmin(req: Request, res: Response): boolean {
  if (!readSession(req)) {
    res.status(401).json({ error: 'unauthenticated' });
    return false;
  }
  const me = memberForSession(req);
  if (me && !isAdminRole(me.role)) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

// POST /api/users/:id/invite — email a user an invitation to set their password
// and activate their account. Also used by "Resend Invitation": re-issuing
// simply replaces any previous link. Responds with { sent, link } — the link is
// echoed back so an admin can pass it on when mail is off or delivery failed.
usersRouter.post('/:id/invite', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ws = workspaceId(req);
  const items = ensure(ws);
  const user = items.find((u) => u.id === req.params.id && u.workspaceId === ws && !u.removed);
  if (!user) return res.status(404).json({ error: 'not_found' });
  if (!user.email) return res.status(400).json({ error: 'no_email' });

  const raw = issueToken(user, 'invite');
  user.invitedAt = new Date().toISOString();
  save(items);

  const link = resetUrl(req, raw);
  const inviter = memberForSession(req)?.name || readSession(req)?.name;
  const mail = inviteEmail({ name: user.name, url: link, inviterName: inviter, expiresInDays: env.INVITE_TTL_DAYS });
  const { sent, error } = await sendMail({ to: { email: user.email, name: user.name }, ...mail });

  return res.json({ sent, error, link, email: user.email, user: publicUser(user) });
});

// POST /api/users/forgot-password — public. Emails a reset link. Always answers
// 200 with the same body so the endpoint can't be used to discover which email
// addresses have accounts.
usersRouter.post('/forgot-password', async (req, res) => {
  const ws = workspaceId(req);
  const items = ensure(ws);
  const email = norm(String(req.body?.email || ''));
  const user = email
    ? items.find((u) => u.workspaceId === ws && !u.removed && !u.deactivated && norm(u.email) === email)
    : undefined;

  if (user) {
    const raw = issueToken(user, 'reset');
    save(items);
    const mail = passwordResetEmail({ name: user.name, url: resetUrl(req, raw), expiresInDays: env.INVITE_TTL_DAYS });
    await sendMail({ to: { email: user.email, name: user.name }, ...mail });
  }
  return res.json({ ok: true });
});

// GET /api/users/reset/:token — public. Validates an invite/reset link so the
// set-password page can greet the recipient (or explain that it has expired).
usersRouter.get('/reset/:token', (req, res) => {
  const user = findByToken(ensure(workspaceId(req)), String(req.params.token || ''));
  if (!user) return res.status(404).json({ valid: false, error: 'invalid_or_expired' });
  return res.json({ valid: true, kind: user.resetTokenKind ?? 'reset', name: user.name, email: user.email });
});

// POST /api/users/reset — public. Consumes an invite/reset link and sets the
// chosen password. The token is single-use; accepting an invitation also grants
// login access, so the recipient lands straight in the app with a session.
usersRouter.post('/reset', async (req, res) => {
  const ws = workspaceId(req);
  const items = ensure(ws);
  const password = String(req.body?.password || '');
  if (password.length < MIN_PASSWORD) return res.status(400).json({ error: 'weak_password' });

  const user = findByToken(items, String(req.body?.token || ''));
  if (!user) return res.status(400).json({ error: 'invalid_or_expired' });

  const wasInvite = user.resetTokenKind === 'invite';
  user.passwordHash = hashPassword(password);
  clearToken(user);
  if (wasInvite) {
    // An admin-issued invitation is itself the approval.
    user.login = 'Yes';
    user.pending = false;
    user.deactivated = false;
  }
  save(items);

  // Sign them straight in. Skipped in mock/dev, where no SESSION_SECRET is
  // configured to sign a cookie with (the app is open there anyway).
  if (env.SESSION_SECRET) setSession(res, { sub: user.id, email: user.email, name: user.name });
  const mail = passwordChangedEmail({ name: user.name });
  await sendMail({ to: { email: user.email, name: user.name }, ...mail });
  return res.json({ user: publicUser(user) });
});

// POST /api/users/password — the signed-in user changes their OWN password.
// The current password is required when one is already set; a user who signed
// in with Google and has never set one can just choose it (the session is proof
// enough).
usersRouter.post('/password', async (req, res) => {
  const session = readSession(req);
  if (!session?.email) return res.status(401).json({ error: 'unauthenticated' });
  const ws = workspaceId(req);
  const items = ensure(ws);
  const user = items.find((u) => u.workspaceId === ws && !u.removed && norm(u.email) === norm(session.email));
  if (!user) return res.status(404).json({ error: 'not_found' });

  const next = String(req.body?.newPassword || '');
  if (next.length < MIN_PASSWORD) return res.status(400).json({ error: 'weak_password' });
  if (user.passwordHash && !verifyPassword(String(req.body?.currentPassword || ''), user.passwordHash)) {
    return res.status(400).json({ error: 'wrong_current_password' });
  }

  user.passwordHash = hashPassword(next);
  clearToken(user); // a password change retires any outstanding reset link
  save(items);

  const mail = passwordChangedEmail({ name: user.name });
  await sendMail({ to: { email: user.email, name: user.name }, ...mail });
  return res.json({ user: publicUser(user) });
});

// POST /api/users/:id/password — an admin sets a user's password directly (the
// break-glass path when someone can't receive email). The account owner is
// notified by email that it happened, and by whom.
usersRouter.post('/:id/password', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const password = String(req.body?.password || '');
  if (password.length < MIN_PASSWORD) return res.status(400).json({ error: 'weak_password' });

  const ws = workspaceId(req);
  const items = ensure(ws);
  const user = items.find((u) => u.id === req.params.id && u.workspaceId === ws);
  if (!user) return res.status(404).json({ error: 'not_found' });

  user.passwordHash = hashPassword(password);
  clearToken(user);
  save(items);

  const by = memberForSession(req)?.name || readSession(req)?.name;
  const mail = passwordChangedEmail({ name: user.name, by });
  const { sent } = user.email
    ? await sendMail({ to: { email: user.email, name: user.name }, ...mail })
    : { sent: false };
  return res.json({ user: publicUser(user), notified: sent });
});

function mutate(req: Request, res: Response, fn: (u: User) => void) {
  const ws = workspaceId(req);
  const items = ensure(ws);
  const user = items.find((u) => u.id === req.params.id && u.workspaceId === ws);
  if (!user) return res.status(404).json({ error: 'not_found' });
  fn(user);
  save(items);
  return res.json({ user: publicUser(user) });
}

usersRouter.patch('/:id', (req, res) =>
  mutate(req, res, (user) => {
    applyEditable(user, req.body ?? {});
  })
);

usersRouter.post('/:id/active', (req, res) =>
  mutate(req, res, (user) => {
    user.deactivated = req.body?.active === false;
  })
);

usersRouter.delete('/:id', (req, res) =>
  mutate(req, res, (user) => {
    user.removed = true;
  })
);
