import { useEffect, useState } from 'react';

// Client helpers for outbound email. The server owns the M365 credentials and
// renders the HTML body itself — the client only ever sends structured data (a
// claim id, a recipient, a detail level), never markup.

// Is the mailer configured on the server? Drives the UI's fallback: when this
// is false we don't offer "Send", we offer "Copy" so the user can paste the
// summary into Outlook themselves. `missing` lists the env var NAMES still to
// be set (never their values) so the note can say what's outstanding.
export function useEmailStatus() {
  const [status, setStatus] = useState({ enabled: false, missing: [], loaded: false });
  useEffect(() => {
    let alive = true;
    fetch('/api/email/status')
      .then((r) => (r.ok ? r.json() : { enabled: false, missing: [] }))
      .then((j) => {
        if (alive) {
          setStatus({ enabled: Boolean(j.enabled), missing: j.missing || [], loaded: true });
        }
      })
      .catch(() => alive && setStatus({ enabled: false, missing: [], loaded: true }));
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

// Email an expense-claim summary. The server reads the claim from its own
// store, so only the id + delivery options travel. Throws an Error carrying
// `.code` ('email_not_configured' | 'email_send_failed' | …) so callers can
// tell "not set up" from "Microsoft rejected it".
export async function sendClaimEmail(claimId, { toName, toEmail, cc, message, detailLevel, senderName, attachCsv } = {}) {
  const res = await fetch(`/api/email/claim/${encodeURIComponent(claimId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toName, toEmail, cc, message, detailLevel, senderName, attachCsv }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = /** @type {any} */ (new Error(payload.message || payload.error || `Request failed (${res.status})`));
    err.code = payload.error;
    err.httpStatus = res.status;
    throw err;
  }
  return payload.data ?? { sent: true };
}

// Short, human sentence for a failed send. Long detail belongs in the server
// logs (Graph status + body); the UI gets one line plus a fallback.
export function emailErrorMessage(err) {
  switch (err?.code) {
    case 'email_not_configured':
      return 'Email isn’t set up on the server yet. Copy the summary and send it from Outlook.';
    case 'email_send_failed':
      return 'Microsoft rejected the message. Copy the summary and send it from Outlook.';
    case 'invalid_recipient':
      return err.message || 'That email address doesn’t look right.';
    case 'email_attachment_too_large':
      return err.message || 'The attachment is too large to email.';
    case 'not_found':
      return 'This claim no longer exists.';
    default:
      return err?.message || 'Couldn’t send the email. Copy the summary and send it from Outlook.';
  }
}

// --- Fallback -------------------------------------------------------------
// Plain-text rendering of the claim for the Copy button, so an unconfigured
// (or failing) mailer never leaves the user stuck. This is built in the browser
// from the claim already on screen and goes to the clipboard — it is not a
// message body the server will send.

function money(v) {
  return (Number(v) || 0).toFixed(2);
}

export function buildClaimEmailText(claim, { detailLevel = 'summary', message = '', senderName = '' } = {}) {
  const cur = claim?.currency || 'SGD';
  const txns = claim?.transactions || [];
  const total = txns.reduce((n, t) => n + (Number(t.total) || 0), 0);
  const lines = [];

  lines.push(`Expense claim: ${claim?.name || 'Untitled claim'}`);
  if (senderName) lines.push(`Shared by: ${senderName}`);
  lines.push(`Claim for: ${claim?.claimFor || '—'}`);
  lines.push(`Claim date: ${claim?.claimDate || claim?.endDate || '—'}`);
  lines.push(`Line items: ${txns.length}`);
  lines.push(`Total: ${cur} ${money(total)}`);
  if (message.trim()) lines.push('', message.trim());
  lines.push('');

  if (detailLevel === 'items') {
    lines.push('Date\tSupplier\tCategory\tNet\tTax\tTotal');
    for (const t of txns) {
      lines.push(
        [t.date, t.supplier, t.category, money(t.net), money(t.tax), money(t.total)].join('\t')
      );
    }
  } else {
    const map = new Map();
    for (const t of txns) {
      const key = t.category || 'Uncategorised';
      const row = map.get(key) || { net: 0, tax: 0, total: 0 };
      row.net += Number(t.net) || 0;
      row.tax += Number(t.tax) || 0;
      row.total += Number(t.total) || 0;
      map.set(key, row);
    }
    lines.push('Category\tNet\tTax\tTotal');
    for (const [category, r] of map) {
      lines.push([category, money(r.net), money(r.tax), money(r.total)].join('\t'));
    }
  }

  lines.push('', `${window.location.origin}/expense-claims/${claim?.id ?? ''}`);
  return lines.join('\n');
}

// Copy text to the clipboard, falling back to a hidden textarea when the async
// Clipboard API is unavailable (non-HTTPS origins, older browsers).
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
