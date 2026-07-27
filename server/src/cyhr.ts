import { Router } from 'express';
import { createHmac } from 'node:crypto';
import { env, cyhrEnabled } from './env.js';
import { getBillById } from './store.js';
import { orgIdFor } from './bills.js';

// CYHR handoff: turn a captured cost into a signed deep link that drops the
// employee onto their prefilled claim in CYHR (they must already be logged into
// CYHR — the link doesn't bypass auth). Mounted at /api/cyhr.
//
// Signing recipe (must match CYHR exactly):
//   canonical = truthy params, keys sorted, `k=v` joined by "&"  (RAW values)
//   sig       = HMAC-SHA256(canonical, CYHR_SIGNING_SECRET) as hex
//   url       = CYHR_BASE_URL + "?" + url-encoded params + "&sig=" + sig
// The secret never leaves the server; only the resulting `sig` goes on the URL.

export const cyhrRouter = Router();

// ---------------------------------------------------------------------------
// The one place the CYHR param contract lives. If CYHR uses different key names
// (or wants an employee identifier / a separate glCode), adjust here only.
// `source` powers CYHR's "Imported from CYBills" banner. Amount is the captured
// receipt total; `category` is the Xero account/category (amounts/accounts come
// from Xero per the agreed contract).
// ---------------------------------------------------------------------------
type Billish = {
  total?: number | string;
  currency?: string;
  category?: string;
  supplier?: string;
  date?: string;
  invoiceNumber?: string;
  documentType?: string;
};

function paramsForBill(b: Billish): Record<string, string> {
  return {
    source: 'cybills',
    amount: b.total != null ? String(b.total) : '',
    currency: b.currency ?? '',
    category: b.category ?? '', // Xero account/category
    supplier: b.supplier ?? '',
    date: b.date ?? '',
    ref: b.invoiceNumber ?? '',
    description: b.documentType ?? '',
    // glCode: '',  // reserved — add here if CYHR wants the GL code carried separately
  };
}

// Build the canonical string + signature, then the final signed URL.
export function signClaimUrl(params: Record<string, string>): string {
  // Only non-empty params take part in the signature, keys sorted for a stable
  // canonical form on both sides. RAW (unencoded) values, matching CYHR.
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const canonical = entries
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const sig = createHmac('sha256', env.CYHR_SIGNING_SECRET).update(canonical).digest('hex');

  const query = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  query.push(`sig=${sig}`);
  const sep = env.CYHR_BASE_URL.includes('?') ? '&' : '?';
  return `${env.CYHR_BASE_URL}${sep}${query.join('&')}`;
}

// GET /api/cyhr/status — lets the client show/enable the "Submit to CYHR" action
// only once the handoff is configured.
cyhrRouter.get('/status', (_req, res) => {
  res.json({ enabled: cyhrEnabled });
});

// POST /api/cyhr/claim-link — build the signed deep link for a captured cost.
// Body: { billId } (persisted bill) or { fields } (explicit params, e.g. a
// sample row that isn't persisted). Returns { url }.
cyhrRouter.post('/claim-link', (req, res) => {
  if (!cyhrEnabled) return res.status(503).json({ error: 'cyhr_not_configured' });

  const body = req.body ?? {};
  let params: Record<string, string> | null = null;

  if (typeof body.billId === 'string' && body.billId) {
    const bill = getBillById(orgIdFor(req), body.billId);
    if (!bill) return res.status(404).json({ error: 'not_found' });
    params = paramsForBill(bill);
  } else if (body.fields && typeof body.fields === 'object') {
    params = paramsForBill(body.fields as Billish);
  }

  if (!params) return res.status(400).json({ error: 'missing_bill' });
  res.json({ url: signClaimUrl(params) });
});
