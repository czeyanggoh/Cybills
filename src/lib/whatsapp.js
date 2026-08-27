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
  useEffect(() => {
    let live = true;
    fetch('/api/whatsapp/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live) setConfig(d);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return config;
}
