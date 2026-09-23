import { useQuery, useQueryClient } from '@tanstack/react-query';

// The daily digest a colleague is emailed about their clients' paperwork still
// waiting to be paid (server/src/digest.ts; which documents is ./digest.js).
// Practice-team only, like the Colleagues page it is set from.

async function call(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || body.error || `Request failed (${res.status})`);
    err.code = body.error || `http_${res.status}`;
    throw err;
  }
  return body;
}

// Every digest the caller may see, keyed by colleague id — for the column.
export function useDigests() {
  return useQuery({
    queryKey: ['digests'],
    queryFn: async () => {
      const { digests = [] } = await call('/api/digests');
      return Object.fromEntries(digests.map((d) => [d.userId, d]));
    },
    retry: false,
  });
}

// One colleague's digest, with the clients it can cover and their people.
export function useDigest(userId) {
  return useQuery({
    queryKey: ['digest', userId],
    queryFn: () => call(`/api/digests/${encodeURIComponent(userId)}`),
    enabled: Boolean(userId),
    retry: false,
  });
}

export function useDigestRefresh() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['digests'] });
    qc.invalidateQueries({ queryKey: ['digest'] });
  };
}

export const saveDigest = (userId, digest) =>
  call(`/api/digests/${encodeURIComponent(userId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(digest),
  });

export const sendDigestNow = (userId) =>
  call(`/api/digests/${encodeURIComponent(userId)}/send`, { method: 'POST' });

// What the Colleagues column says about a digest.
export function digestLabel(d) {
  if (!d?.enabled) return 'Off';
  if (!d.clients?.length) return 'On · no clients';
  const n = d.clients.length;
  return `${String(d.hour ?? 8).padStart(2, '0')}:00 · ${n} client${n === 1 ? '' : 's'}`;
}
