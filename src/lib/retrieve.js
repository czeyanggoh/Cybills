import { useCallback, useEffect, useRef, useState } from 'react';
import { getActiveOrganisationId } from '@/lib/organisations';
import { notifyBillsChanged } from '@/lib/bills';

// Costs -> Retrieve, from the browser's side.
//
// The entity's supplier-portal logins and the retrieval that hands one to n8n.
// The password goes UP and never comes back: the server answers with
// `hasPassword` and when it was set, so nothing on this page can read a saved
// one. A retrieval runs in the background on the server; the hook polls while
// any login says it is running, and tells the Costs list when one settles so
// the documents it filed appear without a reload.

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

const send = (url, method, body) =>
  json(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...orgHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const POLL_MS = 4000;

/** A run still going, or waiting its turn under Retrieve all. */
export const isActiveRun = (run) => run?.status === 'running' || run?.status === 'queued';

/** This entity's portal logins, the portals offered, and whether n8n is set up. */
export function usePortalLogins() {
  const [state, setState] = useState({ logins: [], portals: [], enabled: false, loading: true, error: '' });
  const running = useRef(new Set());

  const reload = useCallback(async () => {
    try {
      const data = await json('/api/retrieve/logins', { headers: orgHeaders() });
      const logins = data.logins ?? [];
      // A run that was going and has now settled filed documents (or said why
      // not): the Costs list should hear about it.
      const now = new Set(logins.filter((l) => isActiveRun(l.run)).map((l) => l.id));
      const settled = [...running.current].some((id) => !now.has(id));
      running.current = now;
      if (settled) notifyBillsChanged();
      setState({ logins, portals: data.portals ?? [], enabled: Boolean(data.enabled), loading: false, error: '' });
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err.message }));
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const anyRunning = state.logins.some((l) => isActiveRun(l.run));
  useEffect(() => {
    if (!anyRunning) return undefined;
    const t = setInterval(reload, POLL_MS);
    return () => clearInterval(t);
  }, [anyRunning, reload]);

  return [state, reload];
}

export const savePortalLogin = (fields) => send('/api/retrieve/logins', 'POST', fields);
export const updatePortalLogin = (id, fields) => send(`/api/retrieve/logins/${encodeURIComponent(id)}`, 'PATCH', fields);
export const deletePortalLogin = (id) => send(`/api/retrieve/logins/${encodeURIComponent(id)}`, 'DELETE');
export const runPortalLogin = (id) => send(`/api/retrieve/logins/${encodeURIComponent(id)}/run`, 'POST', {});
export const runAllPortalLogins = () => send('/api/retrieve/run-all', 'POST', {});
