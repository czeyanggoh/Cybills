import { useState, useEffect } from 'react';

// The organisation-level "Review instructions": a high-level business overview
// plus any GST / coding overrides. Passed to the extraction AI alongside each
// document and the Xero chart of accounts, so it can pick the best account code
// and apply GST rules. Saved per organisation (keyed by the active org id) via
// the shared settings store.

const keyFor = (orgId) => `cybills.review-instructions.${orgId || 'default'}`;

export async function fetchReviewInstructions(orgId) {
  try {
    const res = await fetch(`/api/settings/${encodeURIComponent(keyFor(orgId))}`);
    if (!res.ok) return '';
    const { value } = await res.json();
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

export async function saveReviewInstructions(orgId, text) {
  await fetch(`/api/settings/${encodeURIComponent(keyFor(orgId))}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: String(text ?? '') }),
  });
}

// Load the current org's instructions into editable state.
export function useReviewInstructions(orgId) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchReviewInstructions(orgId).then((t) => { if (alive) { setText(t); setLoading(false); } });
    return () => { alive = false; };
  }, [orgId]);
  return { text, setText, loading };
}
