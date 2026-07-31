import { useState, useEffect, useCallback } from 'react';

// Server-backed users, shared across the workspace. Talks to /api/users;
// mirrors the bills/claims client pattern (fetch + a change event). The people
// list + approver roster is now central instead of per-browser localStorage.

export const USERS_EVENT = 'cybills:users-changed';
function notifyUsersChanged() {
  window.dispatchEvent(new Event(USERS_EVENT));
}

async function req(path, method = 'GET', body) {
  const res = await fetch(`/api/users${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`users ${method} ${path} failed (${res.status})`);
  return res.json();
}

// Synchronous email → display-name lookup, so a row's uploader can be shown as
// "Astrid Yang" instead of the raw "astridy2004" email local-part, without every
// caller refetching the roster. Warmed on import + refreshed on every fetch.
let rosterByEmail = {};
function indexRoster(list) {
  const next = {};
  for (const u of list) if (u?.email) next[String(u.email).toLowerCase()] = u.name || u.email;
  rosterByEmail = next;
}
export function nameForEmail(email) {
  if (!email) return '';
  return rosterByEmail[String(email).toLowerCase()] || '';
}

async function fetchUsers() {
  try {
    const { users } = await req('/');
    const list = Array.isArray(users) ? users : [];
    indexRoster(list);
    return list;
  } catch {
    return [];
  }
}

// Warm the roster cache once on load so email→name resolution works before any
// <useUsers> component mounts; the one-time notify makes lists that already
// rendered (e.g. the Costs "User" column) re-resolve with real names.
if (typeof window !== 'undefined') {
  fetchUsers().then(() => notifyUsersChanged());
}

// --- Mutations (async; notify so mounted lists refetch) ----------------------
export async function addUser(u) {
  await req('/', 'POST', u);
  notifyUsersChanged();
}
export async function addUsers(users) {
  await req('/', 'POST', { users });
  notifyUsersChanged();
}
export async function updateUser(id, patch) {
  await req(`/${id}`, 'PATCH', patch);
  notifyUsersChanged();
}
export async function setUserActive(id, active) {
  await req(`/${id}/active`, 'POST', { active });
  notifyUsersChanged();
}
export async function removeUser(id) {
  await req(`/${id}`, 'DELETE');
  notifyUsersChanged();
}

// Set a user's password (admin action). Returns true on success. Lets that user
// sign in with email + password (no Google needed).
export async function setUserPassword(id, password) {
  try {
    const res = await fetch(`/api/users/${id}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (res.ok) notifyUsersChanged();
    return res.ok;
  } catch {
    return false;
  }
}

// Reactive read of all users: fetch on mount, refetch on any mutation.
export function useUsers() {
  const [users, setUsers] = useState([]);
  const reload = useCallback(() => {
    fetchUsers().then(setUsers);
  }, []);
  useEffect(() => {
    reload();
    window.addEventListener(USERS_EVENT, reload);
    return () => window.removeEventListener(USERS_EVENT, reload);
  }, [reload]);
  return users;
}

export const ROLES = ['Standard', 'Business Admin', 'User Admin', 'Approver', 'Bookkeeper'];

// Short descriptions shown in the role step (mirrors Dext).
export const ROLE_INFO = {
  Standard: ['Submit, view and edit their own items', 'Change their personal settings'],
  'Business Admin': ['Submit, view, edit and publish other peoples’ items', 'Change account-wide settings'],
  'User Admin': [
    'Submit, view, edit and publish other peoples’ items',
    'Add and suspend users',
    'Change account-wide settings',
    'Set automation rules and other advanced features',
  ],
  Approver: ['Review and approve expense claims and items'],
  Bookkeeper: ['Submit, view, edit and publish items', 'Publish to accounting software'],
};
