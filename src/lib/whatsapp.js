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

// Close a collection down. Two acts behind one call, because they are one
// decision with two answers:
//
//   deleteGroup: false — CYBills stops collecting through the group. It carries
//                        on in WhatsApp exactly as it was, everyone still in it.
//   deleteGroup: true  — CYBot removes everyone and leaves.
//
// Neither touches the documents already collected or the thread already
// mirrored: those are the record, and the group is only how they arrived.
export async function closeWhatsappChannel({ submissionId, deleteGroup = false }) {
  const res = await fetch(`/api/whatsapp/channels/${encodeURIComponent(submissionId)}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify({ deleteGroup }),
  });
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  // CYWS writes its refusals for a person to read — "could not remove everyone,
  // so the group was left alone rather than half-dismantled" — and the server
  // passes them straight through, so they are shown rather than restated.
  const err = new Error(data?.message || 'Could not close the group.');
  err.code = data?.error || '';
  err.retryable = Boolean(data?.retryable);
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

// --- The conversation ---------------------------------------------------------
// Costs shows what was picked OUT of a collection group. These read the group
// itself — every message CYWorkspace mirrors across, so a document its
// classifier read as something else can still be found, corrected and filed.

async function json(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.message || body.error || `Request failed (${res.status})`);
    err.code = body.error || `http_${res.status}`;
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Every collection group of the current entity, with what has arrived in it. */
export function useWhatsappThreads() {
  const [state, setState] = useState({ threads: [], canManage: false, loading: true, error: '' });

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await json('/api/whatsapp/threads', { headers: orgHeaders() });
      setState({ threads: data.threads ?? [], canManage: Boolean(data.canManage), loading: false, error: '' });
    } catch (err) {
      setState({ threads: [], canManage: false, loading: false, error: err.message });
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);
  return [state, reload];
}

/** One group's messages, oldest first. `submissionId` empty = nothing to load. */
export function useWhatsappThread(submissionId) {
  const [state, setState] = useState({ channel: null, messages: [], canManage: false, loading: Boolean(submissionId), error: '' });

  const reload = useCallback(async () => {
    if (!submissionId) {
      setState({ channel: null, messages: [], canManage: false, loading: false, error: '' });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await json(`/api/whatsapp/threads/${encodeURIComponent(submissionId)}`, { headers: orgHeaders() });
      setState({ channel: data.channel ?? null, messages: data.messages ?? [], canManage: Boolean(data.canManage), loading: false, error: '' });
    } catch (err) {
      setState({ channel: null, messages: [], canManage: false, loading: false, error: err.message });
    }
  }, [submissionId]);

  useEffect(() => { reload(); }, [reload]);
  return [state, reload];
}

/** Correct what a document is. The reviewer's answer, not the model's guess. */
export async function setMessageCategory(waMessageId, docCategory) {
  return json(`/api/whatsapp/messages/${encodeURIComponent(waMessageId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify({ doc_category: docCategory }),
  });
}

/** File one attachment as a cost document — the manual counterpart to the
 * hand-off CYWorkspace makes on its own. */
export async function fileMessageAsCost(waMessageId) {
  return json(`/api/whatsapp/messages/${encodeURIComponent(waMessageId)}/file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: '{}',
  });
}

// What CYWorkspace's classifier can say a document is. Kept in the same order
// and wording it uses, so a reviewer correcting one is choosing between the
// same options the model had rather than a second, subtly different list.
export const DOC_CATEGORIES = [
  { id: 'supplier_bill', label: 'Supplier bill' },
  { id: 'receipt', label: 'Receipt' },
  { id: 'bank_statement', label: 'Bank statement' },
  { id: 'sales_invoice', label: 'Sales invoice' },
  { id: 'payment_proof', label: 'Payment proof' },
  { id: 'supplier_statement', label: 'Supplier statement' },
  { id: 'payslip', label: 'Payslip' },
  { id: 'quotation', label: 'Quotation' },
  { id: 'purchase_order', label: 'Purchase order' },
  { id: 'contract', label: 'Contract / agreement' },
  { id: 'other_document', label: 'Other document' },
  { id: 'not_a_document', label: 'Not a document' },
];

export const categoryLabel = (id) => DOC_CATEGORIES.find((c) => c.id === id)?.label || id || '';
