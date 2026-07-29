import { Router } from 'express';
import { createHmac } from 'node:crypto';
import { env, cyhrEnabled } from './env.js';
import { getBillById } from './store.js';
import { orgIdFor } from './bills.js';
import { readSession } from './auth.js';

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

// CYHR matches the claim to an employee record by email. Employee records use
// each person's real address (gmail/yahoo/cy-bm.sg), so accept any email the
// client sends (the claim's person). Fall back to this default only when none
// is provided. Override with CYHR_DEFAULT_EMPLOYEE on the VPS.
const DEFAULT_EMPLOYEE = process.env.CYHR_DEFAULT_EMPLOYEE || 'czeyang.goh@cy-bm.sg';
const isEmail = (e: unknown): e is string => typeof e === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);

// ---------------------------------------------------------------------------
// The one place the CYHR param contract lives (confirmed with the CYHR side).
// `source` powers CYHR's "Imported from CYBills" banner. Amount is the captured
// receipt total; `category` is the Xero account/category (amounts/accounts come
// from Xero). `employee` is the person the claim is for — CYHR matches it to the
// employee record and requires it on the link. All non-empty params are signed.
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

function paramsForBill(b: Billish, employee: string): Record<string, string> {
  return {
    source: 'cybills',
    amount: b.total != null ? String(b.total) : '',
    currency: b.currency ?? '',
    category: b.category ?? '', // Xero account/category
    supplier: b.supplier ?? '',
    date: b.date ?? '',
    ref: b.invoiceNumber ?? '',
    description: b.documentType ?? '',
    employee, // CYHR matches this to the employee record
    // glCode: '',  // reserved — add here if CYHR wants the GL code carried separately
  };
}

// Sign a param set and append it to a base URL. Only non-empty params take part
// in the signature, keys sorted for a stable canonical form on both sides, RAW
// (unencoded) values — matching CYHR's verifier byte-for-byte.
export function buildSignedUrl(baseUrl: string, params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const canonical = entries
    .map(([k, v]) => [k, String(v)] as const)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const sig = createHmac('sha256', env.CYHR_SIGNING_SECRET).update(canonical).digest('hex');

  const query = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  query.push(`sig=${sig}`);
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}${query.join('&')}`;
}

// Back-compat wrapper for the (Model A) create-expense deep link.
export function signClaimUrl(params: Record<string, string>): string {
  return buildSignedUrl(env.CYHR_BASE_URL, params);
}

// --- Model B: route an APPROVED claim's payable to CYHR for payment ---------
// The expense claim is created + approved in CYBills; only the amount to pay is
// handed to CYHR. `type=expense_payment` tells CYHR this is a payable to record,
// not an expense to create. Same signing recipe + shared secret.
type ClaimPayment = {
  claimId?: string | number;
  claimName?: string;
  total?: number | string;
  currency?: string;
  date?: string;
  approvedBy?: string;
};
function paramsForPayment(c: ClaimPayment, employee: string): Record<string, string> {
  return {
    source: 'cybills',
    type: 'expense_payment',
    claimId: c.claimId != null ? String(c.claimId) : '',
    claimName: c.claimName ?? '',
    amount: c.total != null ? String(c.total) : '',
    currency: c.currency ?? '',
    date: c.date ?? '',
    approvedBy: c.approvedBy ?? '',
    employee, // who gets paid — matched to the CYHR employee record by email
  };
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
  const session = readSession(req);
  let base: (Billish & { employee?: string }) | null = null;
  let createdBy = '';

  if (typeof body.billId === 'string' && body.billId) {
    const bill = getBillById(orgIdFor(req), body.billId);
    if (!bill) return res.status(404).json({ error: 'not_found' });
    base = bill;
    createdBy = bill.createdBy;
  } else if (body.fields && typeof body.fields === 'object') {
    base = body.fields as Billish & { employee?: string };
  }

  if (!base) return res.status(400).json({ error: 'missing_bill' });

  // The employee the claim is for. CYHR matches by @cy-bm.sg email, so prefer
  // the first candidate that is one; otherwise fall back to the default record
  // (non-cy-bm.sg logins like Google accounts never match on the CYHR side).
  const employee =
    [body.employee, base.employee, session?.email, createdBy].find(isEmail) || DEFAULT_EMPLOYEE;

  res.json({ url: signClaimUrl(paramsForBill(base, employee)) });
});

// POST /api/cyhr/payment-link — Model B. Route an approved claim's payable to
// CYHR for payment. Claims live client-side, so the claim fields come in the
// body. Returns { url } pointing at CYHR_PAYMENT_URL, signed the same way.
cyhrRouter.post('/payment-link', (req, res) => {
  if (!cyhrEnabled) return res.status(503).json({ error: 'cyhr_not_configured' });

  const body = req.body ?? {};
  const claim = (body.claim && typeof body.claim === 'object' ? body.claim : {}) as ClaimPayment & {
    employee?: string;
  };
  if (claim.total == null || claim.total === '') return res.status(400).json({ error: 'missing_amount' });

  const session = readSession(req);
  const employee =
    [body.employee, claim.employee, session?.email].find(isEmail) || DEFAULT_EMPLOYEE;

  res.json({ url: buildSignedUrl(env.CYHR_PAYMENT_URL, paramsForPayment(claim, employee)) });
});
