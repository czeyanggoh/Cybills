import { Router } from 'express';
import { env, xeroEnabled } from './env.js';
import { orgIdFor } from './bills.js';
import { getOrganisation } from './organisations.js';
import { getBillById, markBillPosted, parseAmount } from './store.js';

// Xero, via the cyworkspace relay. CYBills holds no Xero credentials — every
// call below is a plain HTTPS request to cyworkspace's authenticated forwarder
// (ANY /api/webhooks/xero-relay/<XeroPath>?tenant_id=<UUID>, X-API-Key header),
// which owns the OAuth client, token refresh, and 429 retries. See
// cyworkspace skills/xero-relay/references/relay-and-discovery.md for the
// consumer contract this file implements against.

type RelayResult =
  | { ok: true; status: number; data: any }
  | { ok: false; status: number; error: string; message: string; data: any };

async function relay(
  xeroPath: string,
  opts: { method?: string; tenantId?: string; query?: Record<string, string>; body?: unknown } = {}
): Promise<RelayResult> {
  const url = new URL(`${env.CYWORKSPACE_RELAY_URL}/api/webhooks/xero-relay/${xeroPath}`);
  if (opts.tenantId) url.searchParams.set('tenant_id', opts.tenantId);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      'X-API-Key': env.CYWORKSPACE_API_KEY,
      Accept: 'application/json',
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });

  const data = await res.json().catch(() => null);
  if (res.ok) return { ok: true, status: res.status, data };
  return {
    ok: false,
    status: res.status,
    error: String(data?.error ?? 'relay_failed'),
    message: String(data?.message ?? `relay returned ${res.status}`),
    data,
  };
}

// The relay has no dedicated "list tenants" route; its documented discovery
// trick is to request with an unresolvable tenant id and read the 404 body's
// `available_tenants` (stored + live-discovered orgs, merged and deduped).
async function listTenants(): Promise<Array<{ tenant_id: string; tenant_name: string }>> {
  const res = await relay('Organisation', { tenantId: '__list__' });
  if (!res.ok && res.status === 404 && Array.isArray(res.data?.available_tenants)) {
    return res.data.available_tenants;
  }
  if (res.ok) return []; // can't happen for '__list__', but don't throw on it
  throw new Error(`${res.error}: ${res.message}`);
}

function notConfigured(res: any): boolean {
  if (xeroEnabled) return false;
  res.status(503).json({
    error: 'xero_not_configured',
    message: 'Set CYWORKSPACE_API_KEY (and CYWORKSPACE_RELAY_URL) in server/.env to enable Xero.',
  });
  return true;
}

// Resolve the :id param to a linked organisation or write the 404.
function requireOrganisation(req: any, res: any) {
  const organisation = getOrganisation(orgIdFor(req), req.params.id);
  if (!organisation) {
    res.status(404).json({ error: 'organisation_not_found' });
    return null;
  }
  return organisation;
}

export const xeroRouter = Router();

// GET /api/xero/status — capability probe for the frontend.
xeroRouter.get('/status', (_req, res) => {
  res.json({ xeroEnabled });
});

// GET /api/xero/tenants — Xero organisations connected in cyworkspace, for the
// add-organisation picker.
xeroRouter.get('/tenants', async (_req, res) => {
  if (notConfigured(res)) return;
  try {
    const tenants = await listTenants();
    tenants.sort((a, b) => a.tenant_name.localeCompare(b.tenant_name, 'en', { sensitivity: 'base' }));
    res.json({ tenants });
  } catch (err) {
    console.error('[xero] list tenants failed', err);
    res.status(502).json({ error: 'relay_unreachable', message: String((err as Error).message) });
  }
});

// GET /api/xero/organisations/:id/accounts — active accounts in the linked
// Xero org, for the publish dialog's account picker. Includes each account's
// default TaxType so the dialog can preselect the matching tax rate.
xeroRouter.get('/organisations/:id/accounts', async (req, res) => {
  if (notConfigured(res)) return;
  const organisation = requireOrganisation(req, res);
  if (!organisation) return;
  const result = await relay('Accounts', {
    tenantId: organisation.tenantId,
    query: { where: 'Status=="ACTIVE"' },
  });
  if (!result.ok) return res.status(result.status).json(result.data ?? { error: result.error });
  const accounts = (result.data?.Accounts ?? [])
    .filter((a: any) => a.Code)
    .map((a: any) => ({
      code: a.Code,
      name: a.Name,
      type: a.Type,
      taxType: a.TaxType ?? '',
      description: a.Description ?? '',
    }));
  res.json({ accounts });
});

// GET /api/xero/organisations/:id/taxrates — active tax rates usable on
// purchases in the linked Xero org.
xeroRouter.get('/organisations/:id/taxrates', async (req, res) => {
  if (notConfigured(res)) return;
  const organisation = requireOrganisation(req, res);
  if (!organisation) return;
  const result = await relay('TaxRates', { tenantId: organisation.tenantId });
  if (!result.ok) return res.status(result.status).json(result.data ?? { error: result.error });
  const taxRates = (result.data?.TaxRates ?? [])
    .filter((t: any) => t.Status === 'ACTIVE' && t.CanApplyToExpenses !== false)
    .map((t: any) => ({ name: t.Name, taxType: t.TaxType, rate: t.EffectiveRate ?? 0 }));
  res.json({ taxRates });
});

const PUBLISH_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'AUTHORISED']);

// POST /api/xero/organisations/:id/publish-bill — publish a stored cost
// document to the linked Xero org as a supplier bill (ACCPAY invoice).
// Body: { billId, accountCode, taxType, status?, dueDate?, description?,
//         force? }. The bill's total is posted tax-inclusive as one line.
// Re-publishing an already-posted bill is refused (409) unless force:true.
xeroRouter.post('/organisations/:id/publish-bill', async (req, res) => {
  if (notConfigured(res)) return;
  const organisation = requireOrganisation(req, res);
  if (!organisation) return;

  const b = req.body ?? {};
  const billId = String(b.billId ?? '');
  const accountCode = String(b.accountCode ?? '').trim();
  const taxType = String(b.taxType ?? '').trim();
  const status = String(b.status ?? 'DRAFT').toUpperCase();
  if (!billId || !accountCode || !taxType) {
    return res.status(400).json({ error: 'missing_field', message: 'billId, accountCode and taxType are required.' });
  }
  if (!PUBLISH_STATUSES.has(status)) {
    return res.status(400).json({ error: 'invalid_status', message: 'status must be DRAFT, SUBMITTED or AUTHORISED.' });
  }

  const workspace = orgIdFor(req);
  const bill = getBillById(workspace, billId);
  if (!bill) return res.status(404).json({ error: 'bill_not_found' });
  if (bill.xeroInvoiceId && b.force !== true) {
    return res.status(409).json({
      error: 'already_posted',
      message: `Already posted to ${bill.xeroTenantName || 'Xero'} on ${bill.xeroPostedAt ?? ''}.`,
      xeroInvoiceId: bill.xeroInvoiceId,
    });
  }

  const total = parseAmount(bill.total);
  if (!(total > 0)) {
    return res.status(400).json({ error: 'invalid_total', message: 'The bill needs a positive total before it can be posted.' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(bill.date) ? bill.date : today;
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.dueDate ?? '')) ? String(b.dueDate) : date;
  const tax = parseAmount(bill.tax);

  const line: Record<string, unknown> = {
    Description:
      String(b.description ?? '').trim() ||
      [bill.category || bill.documentType || 'Supplier bill', bill.invoiceNumber].filter(Boolean).join(' — '),
    Quantity: 1,
    UnitAmount: total, // tax-inclusive; LineAmountTypes below tells Xero so
    AccountCode: accountCode,
    TaxType: taxType,
  };
  // When the document states its own GST, override Xero's computed tax so the
  // posted bill matches the paper exactly (rounding differences are common).
  if (tax > 0) line.TaxAmount = tax;

  const payload: Record<string, unknown> = {
    Type: 'ACCPAY',
    Contact: { Name: bill.supplier || 'Unknown supplier' },
    Date: date,
    DueDate: dueDate,
    LineAmountTypes: 'Inclusive',
    LineItems: [line],
    Status: status,
  };
  if (bill.invoiceNumber) payload.InvoiceNumber = bill.invoiceNumber;
  if (bill.currency) payload.CurrencyCode = bill.currency;

  // PUT = create-only (POST would upsert); summarizeErrors=false makes Xero
  // return per-record ValidationErrors with a 200 instead of a bare 400.
  const result = await relay('Invoices', {
    method: 'PUT',
    tenantId: organisation.tenantId,
    query: { summarizeErrors: 'false' },
    body: { Invoices: [payload] },
  });

  if (!result.ok) {
    console.error('[xero] publish failed', result.status, result.message);
    return res.status(result.status >= 500 ? 502 : result.status).json({
      error: result.error,
      message: result.message,
    });
  }

  const invoice = result.data?.Invoices?.[0];
  const validationErrors: string[] = (invoice?.ValidationErrors ?? []).map((e: any) => String(e.Message ?? e));
  if (!invoice || invoice.HasErrors || validationErrors.length > 0) {
    return res.status(422).json({
      error: 'xero_validation_failed',
      messages: validationErrors.length ? validationErrors : ['Xero rejected the bill.'],
    });
  }

  const updated = markBillPosted(workspace, bill.id, {
    xeroInvoiceId: String(invoice.InvoiceID ?? ''),
    xeroTenantId: organisation.tenantId,
    xeroTenantName: organisation.tenantName || organisation.name,
  });

  res.json({
    ok: true,
    invoice: {
      invoiceId: String(invoice.InvoiceID ?? ''),
      invoiceNumber: String(invoice.InvoiceNumber ?? ''),
      status: String(invoice.Status ?? status),
    },
    bill: updated,
  });
});
