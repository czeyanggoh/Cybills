import { getActiveOrganisationId } from '@/lib/organisations';
import { notifyClaimsChanged } from '@/lib/claimStore';
import { notifyBillsChanged } from '@/lib/bills';

// Auto Expense claims — the schedule that files each person's finished cost
// documents into an expense claim for them when a claims period ends (Dext's
// "Manage Auto Expense claims"). The server owns the schedule and the sweep;
// this is just the settings dialog's read/write.

// Which client entity's schedule we're reading — the same header the bills API
// uses, since a schedule files that entity's documents.
function orgHeaders() {
  const id = getActiveOrganisationId();
  return id ? { 'X-Org-Id': id } : {};
}

// The periods a claims-end date can roll forward by. Dext's three.
export const FREQUENCIES = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
];

export const EMPTY_AUTO_CLAIMS = {
  endDate: '',
  endOfMonth: false,
  frequency: 'monthly',
  includeInbox: false,
  userIds: [],
  lastRunAt: '',
};

// The schedule plus the people it can be switched on for (this entity's roster).
export async function fetchAutoClaims() {
  try {
    const res = await fetch('/api/auto-claims', { headers: orgHeaders() });
    if (!res.ok) return { settings: EMPTY_AUTO_CLAIMS, users: [], today: '' };
    const b = await res.json();
    return {
      settings: { ...EMPTY_AUTO_CLAIMS, ...(b.settings || {}) },
      users: Array.isArray(b.users) ? b.users : [],
      today: b.today || '',
    };
  } catch {
    return { settings: EMPTY_AUTO_CLAIMS, users: [], today: '' };
  }
}

// Save the schedule. The server files anything already due before replying, so
// the claims list is refreshed here rather than waiting for the next fetch.
export async function saveAutoClaims(settings) {
  const res = await fetch('/api/auto-claims', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    const err = /** @type {any} */ (new Error(b.error || `Request failed (${res.status})`));
    err.code = b.error;
    throw err;
  }
  const body = await res.json();
  notifyClaimsChanged();
  if (body?.run?.items) notifyBillsChanged(); // claimed documents left the inbox
  return body;
}
