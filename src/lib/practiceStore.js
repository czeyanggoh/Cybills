import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { USERS_EVENT } from '@/lib/userStore';
import { ORGANISATION_EVENT } from '@/lib/organisations';
import { DEFAULT_USAGE_RANGE } from '@/lib/usageRange';

// The practice (CYBM) — the firm that runs CYBills for its clients.
//
// Two rosters, and they are not the same list. Users is a CLIENT's own staff:
// tenant-specific, the employees of the entity you currently have open. This
// store is the PRACTICE's own team — "colleagues" — who belong to no single
// entity and instead hold "client access" to the ones they work on, acting as a
// Business Admin inside each. Everything here is practice-team-only.

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || body.error || `Request failed (${res.status})`);
    err.code = body.error || `http_${res.status}`;
    err.status = res.status;
    throw err;
  }
  return body;
}

// The three practice roles. Owner and Practice Admin manage the practice's own
// business — the colleague roster and who works on which client. A Standard
// colleague does client work and nothing else. This is separate from the role a
// colleague carries INSIDE a client (always Business Admin — doing the books is
// the job), which is why client access is granted rather than chosen per-role.
export const PRACTICE_ROLES = ['Owner', 'Practice Admin', 'Standard'];

export const PRACTICE_ROLE_INFO = {
  Owner: [
    'Manage the practice’s business — colleagues, roles and client access',
    'Work in every client, present and future',
    'Business Admin inside each client',
  ],
  'Practice Admin': [
    'Manage the practice’s business — colleagues, roles and client access',
    'Work in the clients they’re given access to',
    'Business Admin inside each of those clients',
  ],
  Standard: [
    'Work in the clients they’re given access to',
    'Business Admin inside each of those clients',
    'Can’t change the practice’s own settings or team',
  ],
};

// --- Access ------------------------------------------------------------------
// Same contract as userStore's access helpers: the server decides and says so on
// the membership payload, and the client trusts that rather than re-deriving it.
// Only when there is NO identified user (mock/demo, Google auth not configured)
// do we fall back to leaving the surface open.
function flag(membership, googleEnabled, key) {
  if (typeof membership?.[key] === 'boolean') return membership[key];
  return !googleEnabled;
}

// On the practice team at all — sees Colleagues and Clients.
export function isPracticeTeam(membership, googleEnabled) {
  return flag(membership, googleEnabled, 'practice');
}

// Runs the practice's own business — adds colleagues, sets client access.
export function canManagePractice(membership, googleEnabled) {
  return flag(membership, googleEnabled, 'managePractice');
}

// --- Reads -------------------------------------------------------------------

export function usePractice() {
  return useQuery({
    queryKey: ['practice'],
    queryFn: () => getJson('/api/practice'),
    retry: false,
  });
}

// The practice roster, as the server sends it: the team, and the practice's own
// general account beside them. Refetches when any roster mutation fires, since
// colleagues are edited through the shared user endpoints (invite, password,
// deactivate).
//
// One query, read two ways — the two hooks below pick their half out of it, so a
// page wanting both asks the server once.
function useRoster(select) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['colleagues'],
    queryFn: () => getJson('/api/practice/colleagues'),
    select,
    retry: false,
  });
  useEffect(() => {
    const reload = () => qc.invalidateQueries({ queryKey: ['colleagues'] });
    window.addEventListener(USERS_EVENT, reload);
    return () => window.removeEventListener(USERS_EVENT, reload);
  }, [qc]);
  return query;
}

// The practice team.
export function useColleagues() {
  return useRoster((body) => body.colleagues ?? []);
}

// The practice's own general account — the row that owns the paperwork nobody
// claimed here, carrying the address it answers to. Null where no entity is
// linked yet. It is not a colleague, which is why it is its own hook: nothing
// that lists the team should have to remember to filter it out.
export function useGeneralAccount() {
  return useRoster((body) => body.general ?? null);
}

// Every connected client, with the colleagues on it and its AI API spend —
// today, and over the period asked for (a preset key, or 'custom' with two
// dates). The KEY is what travels: the server resolves it, because a week
// starts and a day rolls over in the practice's timezone rather than in the
// browser's. Refetched on organisation changes so linking or unlinking a client
// is reflected straight away.
export function useClients(range = {}) {
  const qc = useQueryClient();
  const key = range.key || DEFAULT_USAGE_RANGE;
  const from = key === 'custom' ? range.from || '' : '';
  const to = key === 'custom' ? range.to || '' : '';
  const query = useQuery({
    queryKey: ['practice-clients', key, from, to],
    queryFn: () => {
      const params = new URLSearchParams({ range: key });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      return getJson(`/api/practice/clients?${params.toString()}`);
    },
    retry: false,
    // Changing the period re-reads the same list, so the table stays on screen
    // with the old figures rather than emptying itself for a moment.
    placeholderData: (previous) => previous,
  });
  useEffect(() => {
    const reload = () => qc.invalidateQueries({ queryKey: ['practice-clients'] });
    window.addEventListener(ORGANISATION_EVENT, reload);
    window.addEventListener(USERS_EVENT, reload);
    return () => {
      window.removeEventListener(ORGANISATION_EVENT, reload);
      window.removeEventListener(USERS_EVENT, reload);
    };
  }, [qc]);
  return query;
}

// --- Writes ------------------------------------------------------------------

// Add one or many colleagues. Returns { colleagues, duplicates, invites } — the
// same shape the Users page reports on, so an email that already belongs to
// someone is warned about rather than silently merged.
export async function addColleagues(list, notify = true, message = '') {
  const res = await fetch('/api/practice/colleagues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ colleagues: list, notify, message }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || body.error || 'Could not add the colleague.');
    err.code = body.error;
    throw err;
  }
  window.dispatchEvent(new Event(USERS_EVENT));
  return body;
}

// How many clients a colleague can open, said the way the roster shows it.
export function clientAccessLabel(colleague) {
  if (colleague?.allClients) return 'All clients';
  const n = colleague?.clients?.length ?? (colleague?.clientAccess || []).length;
  if (!n) return 'No clients';
  return n === 1 ? '1 client' : `${n} clients`;
}

// USD, at the precision the number deserves: sub-cent spend still reads as a
// number rather than rounding away to $0.00.
export function formatUsd(value) {
  const n = Number(value) || 0;
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function formatTokens(value) {
  const n = Number(value) || 0;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
