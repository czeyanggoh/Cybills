import { useState, useEffect } from 'react';
import { USERS as BASE } from '@/data/users';

// Client-side store for users. The seed list lives in src/data/users.js; users
// added via the Users page are kept in localStorage, and management actions
// (edit details / privileges, deactivate, remove) are layered on top as
// overrides so they work for seed users too. Real provisioning moves
// server-side later.

const KEY = 'cybills.users.added.v1';
const STATE_KEY = 'cybills.users.state.v1';
export const USERS_EVENT = 'cybills:users-changed';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]');
  } catch {
    return [];
  }
}
function write(list) {
  localStorage.setItem(KEY, JSON.stringify(list));
  window.dispatchEvent(new Event(USERS_EVENT));
}
function readState() {
  try {
    return { overrides: {}, deactivated: [], removed: [], ...(JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {}) };
  } catch {
    return { overrides: {}, deactivated: [], removed: [] };
  }
}
function writeState(state) {
  localStorage.setItem(STATE_KEY, JSON.stringify(state));
  window.dispatchEvent(new Event(USERS_EVENT));
}

let seq = 0;
function normalize(u) {
  const first = (u.firstName || '').trim();
  const last = (u.lastName || '').trim();
  const name = (u.name || `${first} ${last}`).trim() || 'New user';
  seq += 1;
  return {
    id: `nu_${Date.now()}_${seq}`,
    name,
    firstName: first,
    lastName: last,
    email: u.email || '',
    // Login access — 'Yes'/'No' string to match the seed shape.
    login: u.login ? 'Yes' : 'No',
    role: u.role || 'Standard',
    mobile: u.mobile || '',
    privileges: u.privileges || {},
    lastLogin: '—',
  };
}

export function getAddedUsers() {
  return read();
}

// All users: added + seed, with removed filtered out, overrides applied, and a
// `deactivated` flag attached.
export function getAllUsers() {
  const { overrides, deactivated, removed } = readState();
  const removedSet = new Set(removed);
  const deactivatedSet = new Set(deactivated);
  return [...read(), ...BASE]
    .filter((u) => !removedSet.has(u.id))
    .map((u) => ({ ...u, ...overrides[u.id], deactivated: deactivatedSet.has(u.id) }));
}

export function addUser(u) {
  write([normalize(u), ...read()]);
}
export function addUsers(users) {
  write([...users.map(normalize), ...read()]);
}

// --- Management actions ------------------------------------------------------
export function updateUser(id, patch) {
  const state = readState();
  const next = { ...(state.overrides[id] || {}), ...patch };
  // Keep the display name in sync when first/last name change.
  if (patch.firstName !== undefined || patch.lastName !== undefined) {
    const base = getAllUsers().find((u) => u.id === id) || {};
    const first = patch.firstName ?? base.firstName ?? '';
    const last = patch.lastName ?? base.lastName ?? '';
    if (first || last) next.name = `${first} ${last}`.trim();
  }
  writeState({ ...state, overrides: { ...state.overrides, [id]: next } });
}

export function setUserActive(id, active) {
  const state = readState();
  const deactivated = new Set(state.deactivated);
  if (active) deactivated.delete(id);
  else deactivated.add(id);
  writeState({ ...state, deactivated: [...deactivated] });
}

export function removeUser(id) {
  const state = readState();
  // Drop an added user outright; mark a seed user removed.
  const added = read().filter((u) => u.id !== id);
  if (added.length !== read().length) write(added);
  writeState({ ...state, removed: [...new Set([...state.removed, id])] });
}

export function useUsers() {
  const [, bump] = useState(0);
  useEffect(() => {
    const sync = () => bump((n) => n + 1);
    window.addEventListener(USERS_EVENT, sync);
    return () => window.removeEventListener(USERS_EVENT, sync);
  }, []);
  return getAllUsers();
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
