// Profile settings persisted in localStorage: the account email, and the
// bookkeeping / approval email-notification preferences. Mock-mode only — real
// email/password changes would go through the auth backend later.

import { useEffect, useState } from 'react';

const KEY = 'cybills.profile.v1';
export const PROFILE_EVENT = 'cybills:profile-changed';

function read() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function write(next) {
  localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(PROFILE_EVENT));
}

export function getProfile() {
  const s = read();
  return {
    email: s.email || '',
    bookkeepingFreq: s.bookkeepingFreq || 'Daily',
    bookkeeping: s.bookkeeping || {},
    approval: s.approval || {},
  };
}

export function setProfileEmail(email) {
  write({ ...read(), email: String(email || '').trim() });
}
export function setBookkeepingFreq(freq) {
  write({ ...read(), bookkeepingFreq: freq });
}
export function setBookkeepingToggle(key, on) {
  const s = read();
  write({ ...s, bookkeeping: { ...(s.bookkeeping || {}), [key]: on } });
}
export function setApprovalFreq(key, freq) {
  const s = read();
  write({ ...s, approval: { ...(s.approval || {}), [key]: freq } });
}

export function useProfile() {
  const [v, setV] = useState(getProfile);
  useEffect(() => {
    const sync = () => setV(getProfile());
    window.addEventListener(PROFILE_EVENT, sync);
    return () => window.removeEventListener(PROFILE_EVENT, sync);
  }, []);
  return v;
}
