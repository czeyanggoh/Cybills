import { useState, useEffect } from 'react';
import { blobStore } from '@/lib/blobStore';

// Approval-reminder settings, shared across the workspace (server-backed blob).
// CYBills has no mail server, so the reminder is delivered IN-APP (a banner to
// an approver with outstanding requests) rather than by email — the day/time
// schedule is stored for when email is wired up later.

const KEY = 'cybills.approval-reminders.v1';
export const REMINDERS_EVENT = 'cybills:approval-reminders';
const emit = () => window.dispatchEvent(new Event(REMINDERS_EVENT));

export const DAYS = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
];
export const TIMES = [['9am', '9:00 AM'], ['noon', 'Noon'], ['5pm', '5:00 PM']];

export const DEFAULT_REMINDERS = {
  enabled: true,
  days: { mon: true, tue: false, wed: false, thu: false, fri: false, sat: false, sun: false },
  time: '9am',
};

const store = blobStore(KEY, DEFAULT_REMINDERS, emit);

export function getReminders() {
  const v = store.get() || {};
  return { ...DEFAULT_REMINDERS, ...v, days: { ...DEFAULT_REMINDERS.days, ...(v.days || {}) } };
}

export function setReminders(next) {
  store.set(next);
  emit();
}

export function useApprovalReminders() {
  const [val, setVal] = useState(getReminders);
  useEffect(() => {
    const sync = () => setVal(getReminders());
    window.addEventListener(REMINDERS_EVENT, sync);
    return () => window.removeEventListener(REMINDERS_EVENT, sync);
  }, []);
  return val;
}
