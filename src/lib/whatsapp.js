import { useCallback, useEffect, useState } from 'react';
import { getActiveOrganisationId } from '@/lib/organisations';

// Every request names the entity being worked in, the way the bills and claims
// clients do — a collection group belongs to one client entity, and so does
// everything that arrives through it.
const orgHeaders = () => {
  const id = getActiveOrganisationId();
  return id ? { 'X-Org-Id': id } : {};
};

// WhatsApp bill collection, from the browser's side.
//
// CYWorkspace runs the WhatsApp number and creates a group per submission; this
// is the thin client over CYBills's two endpoints — asking for the group, and
// reading back what happened to it. Nothing here creates anything on its own:
// a group is a real WhatsApp group with real people in it, so it is only ever
// made by somebody pressing the button.

// The collection groups this entity has. Refetched on demand rather than
// polled: a group is made once and then just sits there receiving.
export function useWhatsappChannels() {
  const [state, setState] = useState({ channels: [], enabled: false, canManage: false, loading: true });

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/channels', { headers: orgHeaders() });
      const data = res.ok ? await res.json() : null;
      setState({
        channels: data?.channels ?? [],
        enabled: Boolean(data?.enabled),
        canManage: Boolean(data?.canManage),
        loading: false,
      });
    } catch {
      setState((s) => ({ ...s, loading: false }));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return [state, reload];
}

// Ask CYWorkspace for the group. Resolves to the channel on success; throws an
// Error carrying `retryable` on failure, because the two failures need
// different words: WhatsApp declining is worth pressing again, CYWS being
// misconfigured is worth telling somebody about.
export async function createWhatsappChannel({ participants, subject }) {
  const res = await fetch('/api/whatsapp/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify({ participants, subject }),
  });
  const data = await res.json().catch(() => null);
  if (res.ok) return data.channel;
  const err = new Error(data?.message || 'Could not create the WhatsApp group.');
  err.code = data?.error || '';
  err.retryable = Boolean(data?.retryable);
  err.rejected = data?.rejected ?? [];
  throw err;
}

// What the CYWorkspace operator needs from us: where to POST a bill, and the
// key to send with it. Practice team only on the server — the key authorises
// filing documents into any client entity's book.
export function useWhatsappConfig() {
  const [config, setConfig] = useState(null);
  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/config');
      setConfig(res.ok ? await res.json() : null);
    } catch {
      /* leave what we have */
    }
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return [config, reload];
}

// One person's collection group — the "Connect to WhatsApp" card on their own
// page. Deliberately not entity-scoped: a colleague's group is filed under the
// practice's own organisation while the browser usually sits in some client
// entity, and their page still has to find it.
export function useWhatsappForUser(userId) {
  const [state, setState] = useState({ channel: null, mobile: '', enabled: false, canManage: false, loading: true });

  const reload = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await fetch(`/api/whatsapp/channels?userId=${encodeURIComponent(userId)}`);
      const data = res.ok ? await res.json() : null;
      setState({
        // At most one group per person. If an older one is still sitting there
        // unfinished, the open one is the answer.
        channel: (data?.channels ?? []).find((c) => c.status === 'open') ?? data?.channels?.[0] ?? null,
        mobile: data?.mobile ?? '',
        enabled: Boolean(data?.enabled),
        canManage: Boolean(data?.canManage),
        loading: false,
      });
    } catch {
      setState((s) => ({ ...s, loading: false }));
    }
  }, [userId]);

  useEffect(() => {
    reload();
  }, [reload]);

  return [state, reload];
}

// Open the group with one person. The number goes with the request rather than
// being read from their saved row: pressing this is somebody asserting that
// this is their WhatsApp number, and the server stores it as part of connecting
// — an unstored number means the bills that arrive can't be matched back to
// them.
// `replace` opens a SECOND group, for when the one that exists is pointed at the
// wrong number — a real WhatsApp group, so it is never implied by anything else.
// Without it, calling this for somebody already connected saves the number and
// returns the group they have.
export async function connectWhatsappForUser({ userId, mobile, replace = false }) {
  const res = await fetch('/api/whatsapp/channels/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, mobile, replace }),
  });
  const data = await res.json().catch(() => null);
  if (res.ok) return data.channel;
  const err = new Error(data?.message || 'Could not connect WhatsApp.');
  err.code = data?.error || '';
  err.retryable = Boolean(data?.retryable);
  err.rejected = data?.rejected ?? [];
  throw err;
}

// Send one delivery through the real endpoint, the way CYWorkspace would.
// Until CYWS is wired up this is the only way to find out whether THIS side
// works — and "nothing turned up" is the least useful bug report there is.
export async function sendTestDelivery(submissionId = '') {
  const res = await fetch('/api/whatsapp/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify({ submissionId }),
  });
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  const err = new Error(data?.message || 'The test delivery did not go through.');
  err.code = data?.error || '';
  throw err;
}
