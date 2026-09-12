import { useCallback, useEffect, useState } from 'react';
import { getActiveOrganisationId } from '@/lib/organisations';

// The Email tab, from the browser's side.
//
// Read-only bar one act: asking n8n again what is behind a message's links. The
// mail itself is never fetched from here — it was delivered to the server and
// mirrored there — so everything below is a listing and a retry.

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
