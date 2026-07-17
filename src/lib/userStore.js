import { useState, useEffect } from 'react';
import { USERS as BASE } from '@/data/users';

// Client-side store for users added via the Users page (the seed list lives in
// src/data/users.js). New users are kept in localStorage and shown on top of the
// seed list. Real user provisioning would move server-side later.

const KEY = 'cybills.users.added.v1';
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

let seq = 0;
function normalize(u) {
  const name = (u.name || `${u.firstName || ''} ${u.lastName || ''}`).trim() || 'New user';
  seq += 1;
  return {
    id: `nu_${Date.now()}_${seq}`,
    name,
    email: u.email || '',
    login: u.login ? 'Yes' : 'No',
    role: u.role || 'Standard',
    mobile: u.mobile || '',
    lastLogin: '—',
  };
}

export function getAddedUsers() {
  return read();
}
export function getAllUsers() {
  return [...getAddedUsers(), ...BASE];
}

export function addUser(u) {
  write([normalize(u), ...read()]);
}
export function addUsers(users) {
  const fresh = users.map(normalize);
  write([...fresh, ...read()]);
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

export const ROLES = ['Standard', 'Business Admin', 'Approver', 'Bookkeeper'];
