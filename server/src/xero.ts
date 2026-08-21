import { Router } from 'express';
import { env, xeroEnabled } from './env.js';
import { orgIdFor } from './bills.js';
import { getOrganisation } from './organisations.js';
import { getBillById, getBillByIdAny, markBillPosted, parseAmount } from './store.js';
import { claimForBill, getClaimForXero, saveClaimXero } from './claims.js';
import { workspaceId } from './workspace.js';

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
  opts: {
    method?: string;
    tenantId?: string;
    query?: Record<string, string>;
    body?: unknown;
    // Raw binary upload (e.g. attaching a PDF to an invoice): sent as-is with the
    // given content type instead of being JSON-encoded.
    rawBody?: Buffer;
    contentType?: string;
  } = {}
): Promise<RelayResult> {
  const url = new URL(`${env.CYWORKSPACE_RELAY_URL}/api/webhooks/xero-relay/${xeroPath}`);
  if (opts.tenantId) url.searchParams.set('tenant_id', opts.tenantId);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const hasRaw = opts.rawBody !== undefined;
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      'X-API-Key': env.CYWORKSPACE_API_KEY,
      Accept: 'application/json',
      ...(hasRaw
        ? { 'Content-Type': opts.contentType ?? 'application/octet-stream' }
        : opts.body !== undefined
          ? { 'Content-Type': 'application/json' }
          : {}),
    },
    body: hasRaw
      ? (opts.rawBody as unknown as BodyInit)
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined,
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

// GET /api/xero/organisations/:id/payment-methods — accounts a payment can be
// applied to in the linked Xero org: bank accounts (Type BANK) plus any account
// flagged EnablePaymentsToAccount. Feeds the document "Payment method" dropdown.
xeroRouter.get('/organisations/:id/payment-methods', async (req, res) => {
  if (notConfigured(res)) return;
  const organisation = requireOrganisation(req, res);
  if (!organisation) return;
  const result = await relay('Accounts', {
    tenantId: organisation.tenantId,
    query: { where: 'Status=="ACTIVE"' },
  });
  if (!result.ok) return res.status(result.status).json(result.data ?? { error: result.error });
  const methods = (result.data?.Accounts ?? [])
    .filter((a: any) => String(a.Type).toUpperCase() === 'BANK' || a.EnablePaymentsToAccount === true)
    .map((a: any) => {
      const name = String(a.Name ?? '').trim();
      const last4 = String(a.BankAccountNumber ?? '').replace(/\D/g, '').slice(-4);
      const isBank = String(a.Type).toUpperCase() === 'BANK';
      return {
        code: String(a.Code ?? ''),
        name,
        type: String(a.Type ?? ''),
        bankAccountNumber: String(a.BankAccountNumber ?? ''),
        // "DBS Business Account (1234)" for banks with a number, else the name.
        label: isBank && last4 ? `${name} (${last4})` : name,
      };
    })
    .filter((m: any) => m.label);
  res.json({ paymentMethods: methods });
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

// GET /api/xero/organisations/:id/customers — active customer contacts in the
// linked Xero org, for the document "Customer" allocation dropdown.
xeroRouter.get('/organisations/:id/customers', async (req, res) => {
  if (notConfigured(res)) return;
  const organisation = requireOrganisation(req, res);
  if (!organisation) return;
  const result = await relay('Contacts', {
    tenantId: organisation.tenantId,
    query: { where: 'IsCustomer==true AND ContactStatus=="ACTIVE"' },
  });
  if (!result.ok) return res.status(result.status).json(result.data ?? { error: result.error });
  const customers = (result.data?.Contacts ?? [])
    .map((c: any) => ({ id: String(c.ContactID ?? ''), name: String(c.Name ?? '').trim() }))
    .filter((c: any) => c.name)
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  res.json({ customers });
});

// GET /api/xero/organisations/:id/suppliers — active supplier contacts in the
// linked Xero org, for the Costs → Suppliers list.
xeroRouter.get('/organisations/:id/suppliers', async (req, res) => {
  if (notConfigured(res)) return;
  const organisation = requireOrganisation(req, res);
  if (!organisation) return;
  const result = await relay('Contacts', {
    tenantId: organisation.tenantId,
    query: { where: 'IsSupplier==true AND ContactStatus=="ACTIVE"' },
  });
  if (!result.ok) return res.status(result.status).json(result.data ?? { error: result.error });
  const suppliers = (result.data?.Contacts ?? [])
    .map((c: any) => ({ id: String(c.ContactID ?? ''), name: String(c.Name ?? '').trim() }))
    .filter((c: any) => c.name)
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  res.json({ suppliers });
});

// GET /api/xero/organisations/:id/profile — the linked Xero org's registration
// details (name, CRN, tax number, country, base currency, registered address),
// used to populate Business settings → Business profile.
xeroRouter.get('/organisations/:id/profile', async (req, res) => {
  if (notConfigured(res)) return;
  const organisation = requireOrganisation(req, res);
  if (!organisation) return;
  const result = await relay('Organisation', { tenantId: organisation.tenantId });
  if (!result.ok) return res.status(result.status).json(result.data ?? { error: result.error });
  const org = result.data?.Organisations?.[0];
  if (!org) return res.status(404).json({ error: 'organisation_not_found_in_xero' });
  const addresses: any[] = Array.isArray(org.Addresses) ? org.Addresses : [];
  const addr =
    addresses.find((a) => a.AddressType === 'STREET' && (a.AddressLine1 || a.City)) ||
    addresses.find((a) => a.AddressLine1 || a.City) ||
    {};
  res.json({
    profile: {
      name: org.Name ?? '',
      legalName: org.LegalName ?? '',
      registrationNumber: org.RegistrationNumber ?? '',
      taxNumber: org.TaxNumber ?? '',
      countryCode: org.CountryCode ?? '',
      baseCurrency: org.BaseCurrency ?? '',
      organisationType: org.OrganisationType ?? '',
      address: {
        line1: addr.AddressLine1 ?? '',
        line2: addr.AddressLine2 ?? '',
        city: addr.City ?? '',
        region: addr.Region ?? '',
        postalCode: addr.PostalCode ?? '',
        country: addr.Country ?? '',
      },
    },
  });
});

// GET /api/xero/organisations/:id/tracking — the linked Xero org's tracking
// categories (up to two, active only) and each one's active options. Drives the
// Projects / Projects 2 lists, which are Xero tracking categories 1 and 2.
xeroRouter.get('/organisations/:id/tracking', async (req, res) => {
  if (notConfigured(res)) return;
  const organisation = requireOrganisation(req, res);
  if (!organisation) return;
  const result = await relay('TrackingCategories', { tenantId: organisation.tenantId });
  if (!result.ok) return res.status(result.status).json(result.data ?? { error: result.error });
  const categories = (result.data?.TrackingCategories ?? [])
    .filter((c: any) => c.Status === 'ACTIVE')
    .map((c: any) => ({
      id: c.TrackingCategoryID,
      name: c.Name,
      options: (c.Options ?? [])
        .filter((o: any) => o.Status === 'ACTIVE')
        .map((o: any) => ({ id: o.TrackingOptionID, name: o.Name })),
    }));
  res.json({ categories });
});

const EXPENSE_TYPES = new Set(['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS']);

// GET /api/xero/organisations/:id/categories — the org's Xero expense accounts
// with their AccountID + editable Description, for Business settings → Lists →
// Categories (where the Description can be edited and pushed back to Xero).
xeroRouter.get('/organisations/:id/categories', async (req, res) => {
  if (notConfigured(res)) return;
  const organisation = requireOrganisation(req, res);
  if (!organisation) return;
  const result = await relay('Accounts', { tenantId: organisation.tenantId, query: { where: 'Status=="ACTIVE"' } });
  if (!result.ok) return res.status(result.status).json(result.data ?? { error: result.error });
  const categories = (result.data?.Accounts ?? [])
    .filter((a: any) => a.AccountID && EXPENSE_TYPES.has(String(a.Type).toUpperCase()))
    .map((a: any) => ({ id: a.AccountID, code: a.Code ?? '', name: a.Name ?? '', description: a.Description ?? '' }));
  res.json({ categories });
});

// POST /api/xero/organisations/:id/categories/:accountId — update one account's
// Description in Xero. Body: { name, code, description }. Name (Xero-required)
// and Code are re-sent unchanged so only the Description moves.
xeroRouter.post('/organisations/:id/categories/:accountId', async (req, res) => {
  if (notConfigured(res)) return;
  const organisation = requireOrganisation(req, res);
  if (!organisation) return;
  const b = req.body ?? {};
  const name = String(b.name ?? '').trim();
  if (!name) return res.status(400).json({ error: 'name_required', message: 'The account name is required by Xero.' });
  const account: Record<string, unknown> = { Name: name, Description: String(b.description ?? '') };
  if (String(b.code ?? '').trim()) account.Code = String(b.code).trim();

  const result = await relay(`Accounts/${encodeURIComponent(req.params.accountId)}`, {
    method: 'POST',
    tenantId: organisation.tenantId,
    query: { summarizeErrors: 'false' },
    body: { Accounts: [account] },
  });
  if (!result.ok) {
    return res.status(result.status >= 500 ? 502 : result.status).json({ error: result.error, message: result.message });
  }
  const acc = result.data?.Accounts?.[0];
  const validationErrors: string[] = (acc?.ValidationErrors ?? []).map((e: any) => String(e.Message ?? e));
  if (!acc || validationErrors.length > 0) {
    return res.status(422).json({ error: 'xero_validation_failed', messages: validationErrors.length ? validationErrors : ['Xero rejected the update.'] });
  }
  res.json({ ok: true, category: { id: acc.AccountID, code: acc.Code ?? '', name: acc.Name ?? '', description: acc.Description ?? '' } });
});

const PUBLISH_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'AUTHORISED']);

// Numeric display id (mirrors the client's displayItemId) — a bill's creation
// date-time in SGT as YYMMDDHHMMSS, decoded from the id it embeds.
function displayIdOf(id: string): string {
  const s = String(id ?? '');
  if (/^\d+$/.test(s)) return s;
  const m = /^bill_([0-9a-z]+)_/.exec(s);
  if (m) {
    const ms = parseInt(m[1], 36);
    if (Number.isFinite(ms) && ms > 0) {
      const d = new Date(ms + 8 * 60 * 60 * 1000);
      const p = (n: number) => String(n).padStart(2, '0');
      return `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
    }
  }
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return String(21000000000 + (h % 1000000000));
}

// Dext-style Xero line description: "<Supplier> #<ItemID> - <Description>".
function xeroLineDescription(supplier: string, id: string, description: string): string {
  let out = String(supplier || '').trim();
  const idNum = displayIdOf(id);
  if (idNum) out += ` #${idNum}`;
  const desc = String(description || '').trim();
  if (desc) out += ` - ${desc}`;
  return out.trim();
}

// The org's first ACTIVE tracking category (the "PIC" list) + its valid option
// names, for tagging bill lines with a project/PIC on publish.
async function firstTrackingCategory(
  tenantId: string
): Promise<{ name: string; options: Set<string> } | null> {
  const result = await relay('TrackingCategories', { tenantId });
  if (!result.ok) return null;
  const cat = (result.data?.TrackingCategories ?? []).find((c: any) => c.Status === 'ACTIVE');
  if (!cat || !cat.Name) return null;
  const options = new Set<string>(
    (cat.Options ?? []).filter((o: any) => o.Status === 'ACTIVE').map((o: any) => String(o.Name))
  );
  return { name: String(cat.Name), options };
}

// A Xero line Tracking entry for a project/PIC value, or null when the value
// isn't a valid option of the tracking category.
function trackingFor(
  tc: { name: string; options: Set<string> } | null,
  project: string
): Array<{ Name: string; Option: string }> | null {
  const p = String(project || '').trim();
  if (tc && p && tc.options.has(p)) return [{ Name: tc.name, Option: p }];
  return null;
}

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
  // On an expense claim, this cost reaches Xero as a line of that claim's bill.
  // Publishing it separately would post it twice, so the two are mutually
  // exclusive: take it off the claim first, or let the claim carry it.
  const onClaim = claimForBill(workspaceId(req), bill.id);
  if (onClaim) {
    return res.status(409).json({
      error: 'in_expense_claim',
      message: `This document is on the expense claim “${onClaim.name}”, so it can’t also be published as a bill. Remove it from the claim first, or publish the claim.`,
      claimId: onClaim.id,
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

  const net = Math.max(0, total - tax);
  const line: Record<string, unknown> = {
    Description:
      String(b.description ?? '').trim() ||
      xeroLineDescription(bill.supplier, bill.id, bill.description || '') ||
      [bill.category || bill.documentType || 'Supplier bill', bill.invoiceNumber].filter(Boolean).join(' — '),
    Quantity: 1,
    // Post tax-EXCLUSIVE (net unit amount + explicit tax) so Xero shows a Tax
    // Amount column and the figures match the paper exactly — matching Dext.
    UnitAmount: net,
    AccountCode: accountCode,
    TaxType: taxType,
    TaxAmount: tax,
  };
  // Tag the line with the doc's project (PIC tracking category) when set.
  if (bill.project) {
    const tracking = trackingFor(await firstTrackingCategory(organisation.tenantId), bill.project);
    if (tracking) line.Tracking = tracking;
  }

  const payload: Record<string, unknown> = {
    Type: 'ACCPAY',
    Contact: { Name: bill.supplier || 'Unknown supplier' },
    Date: date,
    DueDate: dueDate,
    LineAmountTypes: 'Exclusive',
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

// POST /api/xero/organisations/:id/publish-claim — post an APPROVED expense
// claim to the linked Xero org as an ACCPAY bill payable to the employee. Each
// claim line becomes an invoice line (account code parsed from its category);
// Xero applies each account's default tax rate. Defaults to DRAFT so it's
// reviewable in Xero, not finalised. Re-publishing is refused (409) unless force.
xeroRouter.post('/organisations/:id/publish-claim', async (req, res) => {
  if (notConfigured(res)) return;
  const organisation = requireOrganisation(req, res);
  if (!organisation) return;

  const b = req.body ?? {};
  const claimId = String(b.claimId ?? '');
  const status = String(b.status ?? 'DRAFT').toUpperCase();
  if (!claimId) return res.status(400).json({ error: 'missing_field', message: 'claimId is required.' });
  if (!PUBLISH_STATUSES.has(status)) {
    return res.status(400).json({ error: 'invalid_status', message: 'status must be DRAFT, SUBMITTED or AUTHORISED.' });
  }

  const ws = workspaceId(req);
  const claim = getClaimForXero(ws, claimId);
  if (!claim) return res.status(404).json({ error: 'claim_not_found' });
  if (claim.approvalStatus !== 'approved') {
    return res.status(400).json({ error: 'not_approved', message: 'Only an approved claim can be published to Xero.' });
  }
  if (claim.xeroInvoiceId && b.force !== true) {
    return res.status(409).json({
      error: 'already_posted',
      message: `Already posted to ${claim.xeroTenantName || 'Xero'} on ${claim.xeroPostedAt ?? ''}.`,
      xeroInvoiceId: claim.xeroInvoiceId,
    });
  }

  // Account code = the leading digits of the category label ("412 - …" → "412").
  const codeOf = (cat: string) => (String(cat ?? '').match(/\b(\d{3,})\b/) || [])[1] || '';
  // Dext-style line description: "<Supplier> #<ItemID> - <Description>". Falls
  // back to the live bill's description for items claimed before descriptions
  // were stored on the transaction, then to supplier + category.
  const describe = (t: (typeof claim.transactions)[number]) => {
    const bill = getBillByIdAny(String(t.itemId));
    const desc = String(t.description || bill?.description || '').trim();
    const supplier = String(t.supplier || bill?.supplier || '').trim();
    return (
      xeroLineDescription(supplier, String(t.itemId), desc) ||
      [t.supplier, t.category].filter(Boolean).join(' — ') ||
      'Expense'
    );
  };
  const tc = await firstTrackingCategory(organisation.tenantId);
  const lineItems = (claim.transactions ?? [])
    .map((t) => {
      const total = parseAmount(t.total);
      const tax = parseAmount(t.tax);
      const bill = getBillByIdAny(String(t.itemId));
      const line = {
        Description: describe(t),
        Quantity: 1,
        // Tax-exclusive: net unit amount + explicit tax, so Xero renders a Tax
        // Amount column (matching Dext).
        UnitAmount: Math.max(0, total - tax),
        AccountCode: codeOf(t.category),
        TaxAmount: tax,
        __total: total,
      } as Record<string, unknown>;
      // Tag the PIC (tracking category) from the underlying cost doc's project.
      const tracking = trackingFor(tc, String(bill?.project || t.project || ''));
      if (tracking) line.Tracking = tracking;
      return line;
    })
    .filter((l) => l.AccountCode && Number(l.__total) > 0)
    .map(({ __total, ...line }) => line);

  if (!lineItems.length) {
    return res.status(400).json({
      error: 'no_lines',
      message: 'No claim lines have a Xero account code. Categorise each item with a coded category (e.g. "412 - Consulting & Accounting") first.',
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const iso = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s)) ? String(s) : '');
  const date = iso(claim.claimDate) || iso(claim.endDate) || today;

  const payload: Record<string, unknown> = {
    Type: 'ACCPAY',
    Contact: { Name: claim.claimFor || 'Employee' },
    Date: date,
    DueDate: date,
    LineAmountTypes: 'Exclusive',
    LineItems: lineItems,
    Status: status,
    Reference: claim.name || 'Expense claim',
  };
  if (claim.currency) payload.CurrencyCode = claim.currency;

  const result = await relay('Invoices', {
    method: 'PUT',
    tenantId: organisation.tenantId,
    query: { summarizeErrors: 'false' },
    body: { Invoices: [payload] },
  });

  if (!result.ok) {
    console.error('[xero] publish-claim failed', result.status, result.message);
    return res.status(result.status >= 500 ? 502 : result.status).json({ error: result.error, message: result.message });
  }

  const invoice = result.data?.Invoices?.[0];
  const validationErrors: string[] = (invoice?.ValidationErrors ?? []).map((e: any) => String(e.Message ?? e));
  if (!invoice || invoice.HasErrors || validationErrors.length > 0) {
    return res.status(422).json({
      error: 'xero_validation_failed',
      messages: validationErrors.length ? validationErrors : ['Xero rejected the claim.'],
    });
  }

  const updated = saveClaimXero(ws, claim.id, {
    xeroInvoiceId: String(invoice.InvoiceID ?? ''),
    xeroTenantName: organisation.tenantName || organisation.name,
    xeroPostedAt: today,
    archived: true, // a published claim leaves the inbox for the Archive tab
  });

  // Best-effort: attach the expense-claim PDF (rendered client-side and passed as
  // base64) to the new Xero bill, so the supporting document rides along — the
  // invoice stays posted even if the attachment fails.
  const invoiceId = String(invoice.InvoiceID ?? '');
  const pdfBase64 = typeof b.pdfBase64 === 'string' ? b.pdfBase64 : '';
  let attachment: { ok: boolean; error?: string } | null = null;
  if (invoiceId && pdfBase64) {
    try {
      const bytes = Buffer.from(pdfBase64, 'base64');
      const rawName = String(b.pdfName || `expense-claim-${invoice.InvoiceNumber || invoiceId}.pdf`);
      const fileName = rawName.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/(\.pdf)?$/i, '.pdf');
      const att = await relay(`Invoices/${invoiceId}/Attachments/${encodeURIComponent(fileName)}`, {
        method: 'POST',
        tenantId: organisation.tenantId,
        rawBody: bytes,
        contentType: 'application/pdf',
      });
      attachment = att.ok ? { ok: true } : { ok: false, error: att.message };
      if (!att.ok) console.error('[xero] claim PDF attach failed', att.status, att.message);
    } catch (err) {
      attachment = { ok: false, error: 'attach_failed' };
      console.error('[xero] claim PDF attach error', err);
    }
  }

  res.json({
    ok: true,
    invoice: {
      invoiceId,
      invoiceNumber: String(invoice.InvoiceNumber ?? ''),
      status: String(invoice.Status ?? status),
    },
    attachment,
    claim: updated,
  });
});
