import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { loadCollection, saveCollection } from './jsonStore.js';
import { workspaceId } from './workspace.js';

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
};

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
  res.json({ users: ensure(ws).filter((u) => u.workspaceId === ws && !u.removed) });
});

// Add one or many users. Body: a user object, or { users: [...] }.
usersRouter.post('/', (req, res) => {
  const ws = workspaceId(req);
  const items = ensure(ws);
  const incoming = Array.isArray(req.body?.users) ? req.body.users : [req.body ?? {}];
  const added = incoming.map((u: Partial<User>) => full({ ...u, id: undefined }, ws));
  items.unshift(...added);
  save(items);
  res.json({ users: added });
});

function mutate(req: Request, res: Response, fn: (u: User) => void) {
  const ws = workspaceId(req);
  const items = ensure(ws);
  const user = items.find((u) => u.id === req.params.id && u.workspaceId === ws);
  if (!user) return res.status(404).json({ error: 'not_found' });
  fn(user);
  save(items);
  return res.json({ user });
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
