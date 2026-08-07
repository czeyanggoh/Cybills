import { Router, type Request, type Response } from 'express';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId } from './workspace.js';
import { setSession, readSession } from './auth.js';

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
};

// Public shape sent to the client — never leak the password hash; expose only
// whether a password has been set.
function publicUser(u: User) {
  const { passwordHash, ...rest } = u;
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

// POST /api/users/:id/password — an admin (already signed in) sets a user's
// password. Requires a session so it can't be called anonymously.
usersRouter.post('/:id/password', (req, res) => {
  if (!readSession(req)) return res.status(401).json({ error: 'unauthenticated' });
  const password = String(req.body?.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'weak_password' });
  return mutate(req, res, (user) => {
    user.passwordHash = hashPassword(password);
  });
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
