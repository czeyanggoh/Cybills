import { useEffect, useState } from 'react';

// Client helpers for the CYHR handoff. The server owns the signing secret and
// the param contract; the client just asks it for a signed link and opens it.

// Is the CYHR handoff configured on the server? Gates the "Submit to CYHR"
// action so it never produces a dead link before the env is set on the VPS.
export function useCyhrEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch('/api/cyhr/status')
      .then((r) => (r.ok ? r.json() : { enabled: false }))
      .then((j) => alive && setEnabled(Boolean(j.enabled)))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return enabled;
}

// Ask the server for a signed CYHR deep link for a cost document. Persisted
// bills go by id (server reads the stored fields); sample rows send their
// fields explicitly. `employee` is the person the claim is for (the logged-in
// user) — CYHR requires it on the link. Returns the URL, or throws with a code.
export async function createCyhrClaimLink(doc, employee = '') {
  const body = doc.persisted
    ? { billId: doc.id }
    : {
        fields: {
          total: doc.total,
          currency: doc.currency,
          category: doc.category,
          supplier: doc.supplier,
          date: doc.date,
          invoiceNumber: doc.invoiceNumber || doc.ref || '',
          documentType: doc.type || '',
        },
      };
  if (employee) body.employee = employee;
  const res = await fetch('/api/cyhr/claim-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    const err = /** @type {any} */ (new Error(b.error || `Request failed (${res.status})`));
    err.code = b.error;
    throw err;
  }
  const { url } = await res.json();
  return url;
}

// Build the signed link and open CYHR in a new tab so the logged-in employee
// lands on their prefilled claim. Opens the tab synchronously (before the async
// fetch) so pop-up blockers treat it as user-initiated.
export async function submitToCyhr(doc, employee = '') {
  const tab = window.open('', '_blank');
  try {
    const url = await createCyhrClaimLink(doc, employee);
    if (tab) tab.location.href = url;
    else window.open(url, '_blank');
    return url;
  } catch (err) {
    if (tab) tab.close();
    throw err;
  }
}

// Model B: route an APPROVED expense claim's payable to CYHR for payment.
// Claims are client-side, so the claim fields are sent to the server to sign.
// Returns the signed CYHR payment URL, or throws with a code.
export async function createCyhrPaymentLink(claim) {
  const res = await fetch('/api/cyhr/payment-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      claim: {
        claimId: claim.id,
        claimName: claim.name,
        total: claim.total,
        currency: claim.currency,
        date: claim.endDate || claim.claimDate || '',
        approvedBy: claim.decidedBy || '',
        employee: claim.employeeEmail || '',
      },
    }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    const err = /** @type {any} */ (new Error(b.error || `Request failed (${res.status})`));
    err.code = b.error;
    throw err;
  }
  const { url } = await res.json();
  return url;
}

// Open the signed payment link in a new tab (finance confirms the payable in
// CYHR). Opens the tab synchronously so pop-up blockers treat it as user-driven.
export async function sendClaimToCyhr(claim) {
  const tab = window.open('', '_blank');
  try {
    const url = await createCyhrPaymentLink(claim);
    if (tab) tab.location.href = url;
    else window.open(url, '_blank');
    return url;
  } catch (err) {
    if (tab) tab.close();
    throw err;
  }
}

// Bulk handoff (one signed link per selected cost). Pre-opens a tab for each doc
// synchronously within the click so pop-up blockers treat them as user-initiated,
// then fills each once its link resolves. Throws if any link fails.
export async function submitManyToCyhr(docs, employee = '') {
  const tabs = docs.map(() => window.open('', '_blank'));
  await Promise.all(
    docs.map(async (doc, i) => {
      const tab = tabs[i];
      try {
        const url = await createCyhrClaimLink(doc, employee);
        if (tab) tab.location.href = url;
      } catch (err) {
        if (tab) tab.close();
        throw err;
      }
    })
  );
}
