import { useState, useEffect, useCallback } from 'react';

// The connected Microsoft 365 sending mailbox (Settings → Email). CYBills sends
// account email with DELEGATED Graph permissions, so there is no standing
// credential of its own — an admin connects a mailbox once and the server keeps
// the refresh token. Everything here drives that panel.

export async function fetchMailStatus() {
  try {
    const res = await fetch('/api/mail/status');
    if (!res.ok) return { configured: false, connected: false };
    return res.json();
  } catch {
    return { configured: false, connected: false };
  }
}

// Start the OAuth consent flow. A full-page navigation, not fetch: the user has
// to see and interact with Microsoft's sign-in screen.
export function connectMailbox() {
  window.location.href = '/api/mail/connect';
}

export async function disconnectMailbox() {
  try {
    const res = await fetch('/api/mail/disconnect', { method: 'POST' });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// Send a test message to the signed-in admin. Returns { sent, error, to }.
export async function sendTestEmail() {
  try {
    const res = await fetch('/api/mail/test', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { sent: false, error: data.error || `http_${res.status}` };
    return data;
  } catch {
    return { sent: false, error: 'network' };
  }
}

// Reactive read of the connection, refetched on demand after connect/disconnect.
export function useMailStatus() {
  const [status, setStatus] = useState(null);
  const reload = useCallback(() => {
    fetchMailStatus().then(setStatus);
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return [status, reload];
}
