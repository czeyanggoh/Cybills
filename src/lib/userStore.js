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

// Approve a pending self-signup, granting them access.
export async function approveUser(id) {
  await req(`/${id}/approve`, 'POST', {});
  notifyUsersChanged();
}

// Self-signup: the signed-in user submits their details + chosen company. They
// become a pending member until an admin approves. Returns { status, user }.
export async function joinCompany(payload) {
  const res = await fetch('/api/users/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  if (!res.ok) throw new Error(`join failed (${res.status})`);
  notifyUsersChanged();
  return res.json();
}

// The signed-in user's membership status (anonymous | none | pending |
// deactivated | active) plus their roster profile, used to gate the app.
export async function fetchMembership() {
  try {
    const res = await fetch('/api/users/me');
    if (!res.ok) return { status: 'anonymous', user: null };
    return res.json();
  } catch {
    return { status: 'anonymous', user: null };
  }
}

// Set a user's password (admin action). Returns true on success. Lets that user
// sign in with email + password (no Google needed). The account owner is
// emailed that their password was changed (see the server's mailer).
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

// --- Invitations + password links -------------------------------------------

// Invite (or re-invite) a user by email: the server mints a single-use link and
// mails it. Returns { sent, link, error } — `link` is always present so the
// admin can pass it on by hand when mail is off or delivery failed.
export async function inviteUser(id) {
  try {
    const res = await fetch(`/api/users/${id}/invite`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { sent: false, error: data.error || `http_${res.status}` };
    notifyUsersChanged();
    return data;
  } catch {
    return { sent: false, error: 'network' };
  }
}

// Ask for a password-reset email. Always resolves true — the server answers the
// same way whether or not the address has an account, so this can't be used to
// probe for members.
export async function requestPasswordReset(email) {
  try {
    const res = await fetch('/api/users/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Check an invite/reset token from the emailed link. Returns
// { valid, kind, name, email }.
export async function checkResetToken(token) {
  try {
    const res = await fetch(`/api/users/reset/${encodeURIComponent(token)}`);
    if (!res.ok) return { valid: false };
    return res.json();
  } catch {
    return { valid: false };
  }
}

// Consume the token and set the chosen password. On success the server also
// signs the user in, so the caller can go straight into the app.
export async function acceptReset(token, password) {
  try {
    const res = await fetch('/api/users/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `http_${res.status}` };
    notifyUsersChanged();
    return { ok: true, user: data.user };
  } catch {
    return { ok: false, error: 'network' };
  }
}

// Change your own password. Returns { ok, error }; `currentPassword` is only
// required when you already have one set.
export async function changeOwnPassword(currentPassword, newPassword) {
  try {
    const res = await fetch('/api/users/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.error || `http_${res.status}` };
    return { ok: true };
  } catch {
    return { ok: false, error: 'network' };
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

// Just two roles — approval routing is a standalone "Direct manager" column now,
// so we no longer need separate Approver / Bookkeeper / User Admin tiers.
export const ROLES = ['Standard', 'Admin'];

// Map any legacy role stored on old user records to one of the two current roles,
// so the table + pickers always display a valid current role.
export function normalizeRole(role) {
  return role === 'Business Admin' || role === 'User Admin' || role === 'Admin' ? 'Admin' : 'Standard';
}

// Admin-tier role check (accepts the legacy names still on un-normalized rows).
export function isAdminRole(role) {
  return role === 'Admin' || role === 'Business Admin' || role === 'User Admin';
}

// Whether the current session has admin access. When someone is actually signed
// in (a roster membership exists), their real role decides it — a Standard user
// is never an admin, even in a password-only (no-Google) setup. Only when there
// is NO identified user (anonymous / mock demo) do we fall back to leaving the
// app open when Google auth isn't configured.
export function isAdminAccess(membership, googleEnabled) {
  if (membership?.user) return isAdminRole(membership.user.role);
  return !googleEnabled;
}

// Short descriptions shown in the role step.
export const ROLE_INFO = {
  Standard: ['Submit, view and edit their own items', 'Change their personal settings'],
  Admin: [
    'Submit, view, edit and publish other peoples’ items',
    'Add and suspend users',
    'Change account-wide settings',
  ],
};
