import { useCallback, useEffect, useState } from 'react';
import { getActiveOrganisationId } from '@/lib/organisations';

// The Email tab, from the browser's side.
//
// A listing, a retry (asking n8n again what is behind a message's links) and
// one thing that goes the other way: a reply. The mail itself is never fetched
// from here — it was delivered to the server and mirrored there.

const orgHeaders = () => {
  const id = getActiveOrganisationId();
  return id ? { 'X-Org-Id': id } : {};
};

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

/** One row per person mail has arrived for, newest first. */
export function useMailThreads() {
  const [state, setState] = useState({
    threads: [],
    messages: 0,
    unfiled: 0,
    linkFetchEnabled: false,
    loading: true,
    error: '',
  });

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await json('/api/email/threads', { headers: orgHeaders() });
      setState({
        threads: data.threads ?? [],
        messages: Number(data.messages ?? 0),
        unfiled: Number(data.unfiled ?? 0),
        linkFetchEnabled: Boolean(data.linkFetchEnabled),
        loading: false,
        error: '',
      });
    } catch (err) {
      setState({ threads: [], messages: 0, unfiled: 0, linkFetchEnabled: false, loading: false, error: err.message });
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);
  return [state, reload];
}

/** One person's mail, newest first. `userId` empty = nothing to load. */
export function useMailThread(userId) {
  const [state, setState] = useState({
    person: null,
    messages: [],
    linkFetchEnabled: false,
    replyEnabled: false,
    loading: Boolean(userId),
    error: '',
  });

  const reload = useCallback(async () => {
    if (!userId) {
      setState({ person: null, messages: [], linkFetchEnabled: false, loading: false, error: '' });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await json(`/api/email/threads/${encodeURIComponent(userId)}`, { headers: orgHeaders() });
      setState({
        person: data.person ?? null,
        messages: data.messages ?? [],
        linkFetchEnabled: Boolean(data.linkFetchEnabled),
        replyEnabled: Boolean(data.replyEnabled),
        loading: false,
        error: '',
      });
    } catch (err) {
      setState({ person: null, messages: [], linkFetchEnabled: false, loading: false, error: err.message });
    }
  }, [userId]);

  useEffect(() => {
    reload();
  }, [reload]);
  return [state, reload];
}

/**
 * Ask n8n again what is behind this message's links.
 *
 * Waited on — a portal login is slow and the person who pressed it is watching
 * — and it resolves whether or not a document came back, because "n8n found
 * nothing" is an answer worth showing rather than an error to throw.
 */
export async function fetchMessageLinks(messageId) {
  return json(`/api/email/messages/${encodeURIComponent(messageId)}/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
  });
}

/** Whose links this entity follows without asking. */
export function useTrustedSenders() {
  const [state, setState] = useState({ senders: [], linkFetchEnabled: false, loading: true, error: '' });

  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await json('/api/email/senders', { headers: orgHeaders() });
      setState({
        senders: data.senders ?? [],
        linkFetchEnabled: Boolean(data.linkFetchEnabled),
        loading: false,
        error: '',
      });
    } catch (err) {
      setState({ senders: [], linkFetchEnabled: false, loading: false, error: err.message });
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);
  return [state, reload];
}

/**
 * Trust a sender: follow their links from now on, and fetch what is already
 * waiting on the answer.
 *
 * Both halves at once, deliberately — trusting somebody and then having to
 * press fetch on each of their waiting documents is one decision made twice,
 * and the second half is the one people forget.
 */
export async function trustSender(address) {
  return json('/api/email/senders/trust', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify({ address }),
  });
}

/** Stop following this sender's links. What was already fetched stays. */
export async function untrustSender(address) {
  return json('/api/email/senders/untrust', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify({ address }),
  });
}

/** Fetch this one document's link without trusting anybody. */
export async function fetchDocumentLink(billId) {
  return json(`/api/email/documents/${encodeURIComponent(billId)}/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
  });
}

/**
 * What has been answered about the mail a document arrived in, and whether
 * (and to whom) it can be answered now.
 *
 * `available` is false for anybody the server will not show mail to, and for a
 * document that did not come by email: the page then draws nothing, rather
 * than a Reply button that could only be refused.
 */
export function useDocumentReplies(billId) {
  const [state, setState] = useState({ replies: [], replyAddress: '', replyEnabled: false, available: false });

  const reload = useCallback(async () => {
    if (!billId) {
      setState({ replies: [], replyAddress: '', replyEnabled: false, available: false });
      return;
    }
    try {
      const data = await json(`/api/email/documents/${encodeURIComponent(billId)}/replies`, { headers: orgHeaders() });
      setState({
        replies: data.replies ?? [],
        replyAddress: data.replyAddress ?? '',
        replyEnabled: Boolean(data.replyEnabled),
        available: true,
      });
    } catch {
      setState({ replies: [], replyAddress: '', replyEnabled: false, available: false });
    }
  }, [billId]);

  useEffect(() => {
    reload();
  }, [reload]);
  return [state, reload];
}

/**
 * Answer a mail. `{ billId | messageId, body, to?, cc? }` — the recipient
 * defaults, server-side, to whoever sent the original.
 */
export async function sendReply(payload) {
  return json('/api/email/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify(payload),
  });
}

/**
 * File the EMAIL as the document: the message written out as a PDF and
 * attached. `{ billId }` from a document that has no file, `{ messageId }` from
 * a mail on the Email tab that became nothing. For the mail whose paperwork is
 * its own body, where there is no file behind any link to fetch.
 */
export async function saveEmailAsPdf({ billId, messageId, envelope }) {
  const path = billId
    ? `/api/email/documents/${encodeURIComponent(billId)}/pdf`
    : `/api/email/messages/${encodeURIComponent(messageId)}/pdf`;
  // Drawn HERE where the mail's HTML was kept: laying markup out takes a
  // browser, and the server's own page is the message's text. Anything that
  // goes wrong on the way falls back to that page rather than to no paper.
  let pdf = '';
  try {
    const html = await fetchMailBody({ billId, messageId });
    if (html) {
      const { renderMailPdf } = await import('@/lib/mailPdf');
      const when = envelope?.date ? new Date(envelope.date) : null;
      pdf = await renderMailPdf({
        html,
        envelope: {
          subject: envelope?.subject || '',
          from: envelope?.from || '',
          to: envelope?.to || '',
          date:
            when && !Number.isNaN(when.getTime())
              ? when.toLocaleString('en-SG', { dateStyle: 'full', timeStyle: 'short' })
              : envelope?.date || '',
          caption: `Email received at ${envelope?.to || 'CYBills'}, saved as a PDF by CYBills.`,
        },
      });
    }
  } catch {
    pdf = '';
  }
  return json(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: JSON.stringify(pdf ? { pdf } : {}),
  });
}

/**
 * The HTML part of a mail — the message as it was sent — or '' where only its
 * text was kept. `{ billId }` for the mail a document arrived in.
 */
export async function fetchMailBody({ billId, messageId }) {
  if (!billId && !messageId) return '';
  const path = billId
    ? `/api/email/documents/${encodeURIComponent(billId)}/body`
    : `/api/email/messages/${encodeURIComponent(messageId)}/body`;
  const data = await json(path, { headers: orgHeaders() });
  return String(data.html || '');
}
