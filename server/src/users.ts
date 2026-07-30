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
  };
}

// Return the workspace's users, seeding the real employees on first use.
function ensure(ws: string): User[] {
  const items = load();
  if (!items.some((u) => u.workspaceId === ws)) {
    items.push(...SEED.map((s) => full(s, ws)));
    save(items);
  }
  return items;
}

export const usersRouter = Router();

usersRouter.get('/', (req, res) => {
  const ws = workspaceId(req);
  res.json({ users: ensure(ws).filter((u) => u.workspaceId === ws && !u.removed).map(publicUser) });
});

// Add one or many users. Body: a user object, or { users: [...] }.
usersRouter.post('/', (req, res) => {
  const ws = workspaceId(req);
  const items = ensure(ws);
  const incoming = Array.isArray(req.body?.users) ? req.body.users : [req.body ?? {}];
  const added = incoming.map((u: Partial<User>) => full({ ...u, id: undefined }, ws));
  items.unshift(...added);
  save(items);
  res.json({ users: added.map(publicUser) });
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

const EDITABLE: (keyof User)[] = ['name', 'firstName', 'lastName', 'email', 'login', 'role', 'mobile', 'privileges', 'deactivated'];

usersRouter.patch('/:id', (req, res) =>
  mutate(req, res, (user) => {
    const b = req.body ?? {};
    for (const k of EDITABLE) if (k in b) (user as Record<string, unknown>)[k] = b[k];
    if ('firstName' in b || 'lastName' in b) {
      const nm = `${user.firstName || ''} ${user.lastName || ''}`.trim();
      if (nm) user.name = nm;
    }
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
