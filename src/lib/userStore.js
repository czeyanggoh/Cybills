import { useState, useEffect, useCallback } from 'react';
import { getActiveOrganisationId, ORGANISATION_EVENT } from '@/lib/organisations';

// Server-backed users. Talks to /api/users; mirrors the bills/claims client
// pattern (fetch + a change event). The people list + approver roster is
// central instead of per-browser localStorage, and is tenant-specific: each
// linked organisation has its own roster.

export const USERS_EVENT = 'cybills:users-changed';
function notifyUsersChanged() {
  window.dispatchEvent(new Event(USERS_EVENT));
}

// Every roster request names the selected organisation, so the server reads and
// writes that entity's own people list — the same header the bills API uses.
// Omitted when nothing is selected; the server then falls back to the primary
// organisation.
function orgHeaders() {
  const id = getActiveOrganisationId();
  return id ? { 'X-Org-Id': id } : {};
}

async function req(path, method = 'GET', body) {
  const res = await fetch(`/api/users${path}`, {
    method,
    headers: { ...orgHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
  // The cache holds one organisation's names, so re-warm it on a switch.
  window.addEventListener(ORGANISATION_EVENT, () => {
    fetchUsers().then(() => notifyUsersChanged());
  });
}

// --- Mutations (async; notify so mounted lists refetch) ----------------------
// Returns { users, duplicates, invites } so the caller can warn about an email
// that already exists and report whether the invitation was emailed.
export async function addUser(u, notify = true, message = '', orgName = '') {
  const r = await req('/', 'POST', { ...u, notify, message, orgName });
  notifyUsersChanged();
  return r;
}
export async function addUsers(users, notify = true, message = '', orgName = '') {
  const r = await req('/', 'POST', { users, notify, message, orgName });
  notifyUsersChanged();
  return r;
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
    headers: { ...orgHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  if (!res.ok) throw new Error(`join failed (${res.status})`);
  notifyUsersChanged();
  return res.json();
}

// The signed-in user's membership status (anonymous | none | pending |
// deactivated | active) plus their roster profile, used to gate the app.
// `status: 'error'` (not 'anonymous') when the roster lookup itself failed, so a
// blip can't be mistaken for "signed out" and quietly strip the admin surfaces
// from someone who is, in fact, an admin — see AuthProvider, which keeps the
// last known membership in that case.
export async function fetchMembership() {
  try {
    // Named with the selected organisation: a colleague's access comes from
    // client access, so "what may I do" is only answerable against the entity
    // they currently have open.
    const res = await fetch('/api/users/me', { headers: orgHeaders() });
    if (!res.ok) return { status: 'error', user: null };
    return res.json();
  } catch {
    return { status: 'error', user: null };
  }
}

// Set a user's password (admin action). Returns true on success. Lets that user
// sign in with email + password (no Google needed). The account owner is
// emailed that their password was changed (see the server's mailer).
export async function setUserPassword(id, password) {
  try {
    const res = await fetch(`/api/users/${id}/password`, {
      method: 'POST',
      headers: { ...orgHeaders(), 'Content-Type': 'application/json' },
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
    const res = await fetch(`/api/users/${id}/invite`, { method: 'POST', headers: orgHeaders() });
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
    // Rosters are per-organisation, so switching entities loads a different list.
    window.addEventListener(ORGANISATION_EVENT, reload);
    return () => {
      window.removeEventListener(USERS_EVENT, reload);
      window.removeEventListener(ORGANISATION_EVENT, reload);
    };
  }, [reload]);
  return users;
}

// The three Dext roles. Business Admin is the full-access tier — other people's
// items, publishing, the user roster AND account-wide settings. User Admin runs
// the roster (add / suspend / edit people) but can't change how the business is
// configured. Standard works on their own items, extended by the optional
// per-user privileges (access all documents, create claims, publish).
// Approval routing is a standalone "Direct manager" column, not a role.
export const ROLES = ['Business Admin', 'User Admin', 'Standard'];

// Map any legacy role stored on old user records onto one of the three, so the
// table + pickers always show a valid current role. The collapsed 'Admin' tier
// this replaces had full access, so it maps to Business Admin — a migration
// should never quietly take away access someone already has.
export function normalizeRole(role) {
  if (role === 'Business Admin' || role === 'Admin') return 'Business Admin';
  if (role === 'User Admin') return 'User Admin';
  return 'Standard';
}

// Any admin tier — the coarse "not a Standard user" check.
export function isAdminRole(role) {
  return normalizeRole(role) !== 'Standard';
}

// Change account-wide settings (Business settings: lists, categories, exports,
// extraction, email, connections). Business Admin only.
export function isBusinessAdminRole(role) {
  return normalizeRole(role) === 'Business Admin';
}

// Add, suspend and edit people (Users). Both admin tiers — it's the whole point
// of User Admin.
export function canManageUsersRole(role) {
  return isAdminRole(role);
}

// One access question, answered the same way each time. The server decides and
// says so on the membership payload — trust that first, so the client never
// derives a different answer from the role string than the API enforces. Older
// payloads (no flag) fall back to the signed-in user's real role. Only when
// there is NO identified user (anonymous / mock demo) do we fall back to leaving
// the app open when Google auth isn't configured.
function access(membership, googleEnabled, flag, roleAllows) {
  if (typeof membership?.[flag] === 'boolean') return membership[flag];
  if (membership?.user) return roleAllows(membership.user.role);
  return !googleEnabled;
}

// Any admin tier. Coarse — prefer canManageBusiness / canManageUsers when the
// surface belongs to one of them, so a User Admin isn't shown Business settings.
export function isAdminAccess(membership, googleEnabled) {
  return access(membership, googleEnabled, 'admin', isAdminRole);
}

// Business settings (lists, categories, exports, extraction, email).
export function canManageBusiness(membership, googleEnabled) {
  return access(membership, googleEnabled, 'businessAdmin', isBusinessAdminRole);
}

// The Users page and everything that edits the roster.
export function canManageUsers(membership, googleEnabled) {
  return access(membership, googleEnabled, 'canManageUsers', canManageUsersRole);
}

// Short descriptions shown in the role step, mirroring Dext's wording.
export const ROLE_INFO = {
  'Business Admin': [
    'Submit, view, edit and publish other peoples’ items',
    'Add and suspend users',
    'Change account-wide settings',
  ],
  'User Admin': [
    'Submit, view and edit their own items',
    'Add and suspend users',
    'Change their personal settings',
  ],
  Standard: ['Submit, view and edit their own items', 'Change their personal settings'],
};
