import { Router } from 'express';
import { env, googleEnabled, xeroEnabled } from './env.js';
import { dataScopeForOrg, getOrganisation, isStandalone, publishTargetFor } from './organisations.js';
import { workspaceId } from './workspace.js';
import { readSetting } from './settings.js';
import { referenceFor, dateFor } from './claimRef.js';
import { apportion, costComplete, displayIdOf, getBillById, getBillByIdAny, listBills, markBillPosted, markBillXeroPayment, parseAmount, type Bill } from './store.js';
import { extFor, getBillFile } from './storage.js';
import { claimForBill, getClaimForXero, markClaimXeroPayment, publishedClaims, saveClaimXero } from './claims.js';
import { appOrigin, memberForSession } from './users.js';

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
  let res: Response;
  try {
    res = await fetch(url, {
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
  } catch (err) {
    // The relay being unreachable — down, DNS gone, or the 60s timeout firing —
    // used to reject with nothing catching it, which takes the whole CYBills
    // process down: Xero having a bad afternoon logged everyone out of the app.
    // Every caller already handles `ok:false`, so it becomes one of those.
    console.error('[xero] relay unreachable', xeroPath, err);
    return {
      ok: false,
      status: 502,
      error: 'relay_unreachable',
      message: `Could not reach the Xero relay: ${err instanceof Error ? err.message : String(err)}`,
      data: null,
    };
  }

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

// One invoice's current state in Xero, for a caller that already knows which
// invoice it wants. This exists for the webhook receiver (xeroWebhook.ts): an
// INVOICE event says only that the invoice changed — never what changed, and
// never what it changed to — so the answer has to be read back from Xero.
// Returns null on any failure; the caller treats "couldn't ask" as "nothing to
// record", which is right for a notification we can always get again.
export async function fetchXeroInvoice(
  tenantId: string,
  invoiceId: string
): Promise<Record<string, any> | null> {
  if (!tenantId || !invoiceId) return null;
  const res = await relay(`Invoices/${encodeURIComponent(invoiceId)}`, { tenantId });
  if (!res.ok) {
    console.error('[xero] could not read invoice', invoiceId, res.status, res.message);
    return null;
  }
  const invoices = Array.isArray(res.data?.Invoices) ? res.data.Invoices : [];
  return invoices[0] ?? null;
}

// What Xero says about one invoice, in the three fields a document keeps.
// Exported because two callers need the SAME reading of a Xero payload: the
// webhook read-back (xeroWebhook.ts) and the backfill sweep below. A document
// paid before webhooks existed must end up saying exactly what one paid after
// them says.
//
// Recorded as Xero words it — PAID, AUTHORISED, VOIDED — rather than reduced to
// a boolean here: "not paid" covers a bill awaiting payment and a bill that was
// voided, and a reviewer looking at the paperwork needs those told apart. The
// UI does the wording (src/lib/xeroPaidStatus.js).
//
// `Status`, not `AmountDue`: Xero only calls a bill PAID when nothing is left
// on it, so a PARTLY paid bill correctly stays AUTHORISED here.
export function paymentFromInvoice(invoice: Record<string, any>): {
  xeroStatus: string;
  xeroPaidDate: string;
  xeroPaymentRef: string;
} {
  // Payments carry the reference somebody typed when the money was recorded — a
  // cheque number, a transfer id, "PayNow 26 Aug". Several can settle one bill
  // (a part payment, then the rest), so they're joined; blank ones and repeats
  // are dropped rather than printed as empty commas.
  const payments = Array.isArray(invoice?.Payments) ? invoice.Payments : [];
  const refs: string[] = [];
  for (const p of payments) {
    const ref = String(p?.Reference ?? '').trim();
    if (ref && !refs.includes(ref)) refs.push(ref);
  }
  return {
    xeroStatus: String(invoice?.Status ?? '').trim().toUpperCase(),
    xeroPaidDate: xeroDay(invoice?.FullyPaidOnDate),
    xeroPaymentRef: refs.join(', '),
  };
}

// The DAY out of a Xero date, whichever of its two shapes it arrives in: the
// JSON endpoints answer "2026-08-26T00:00:00", but the same field comes back as
// "/Date(1756166400000+0000)/" elsewhere in the same API. Reading only the first
// shape is how a backfilled bill would show a paid status with no paid date
// beside it. Anything else reads as no date rather than as a wrong one.
function xeroDay(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (iso) return iso[1];
  const ms = /^\/Date\((-?\d+)/.exec(raw);
  if (ms) {
    const d = new Date(Number(ms[1]));
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  return '';
}

// Several invoices in one call. Xero takes ?IDs=<comma-separated guids> and
// documents it as the cheap way to ask for a known set — one request instead of
// one per bill, which is what makes a whole book's backfill affordable against
// 60 calls a minute. Batched because a URL of 500 guids is not a URL.
async function fetchXeroInvoices(
  tenantId: string,
  invoiceIds: string[]
): Promise<Map<string, Record<string, any>>> {
  const found = new Map<string, Record<string, any>>();
  if (!tenantId) return found;
  const ids = invoiceIds.filter(Boolean);
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await relay('Invoices', { tenantId, query: { IDs: batch.join(',') } });
    if (!res.ok) {
      console.error('[xero] invoice batch failed', res.status, res.message);
      continue; // a bad batch costs those bills this run, not the whole sweep
    }
    for (const inv of Array.isArray(res.data?.Invoices) ? res.data.Invoices : []) {
      const id = String(inv?.InvoiceID ?? '');
      if (id) found.set(id.toLowerCase(), inv);
    }
  }
  return found;
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
// The organisation RECORD is workspace-level (that's the scope it is created
// under), while the bills and claims it owns live in that entity's own book.
// Looking the record up by the entity scope only ever worked because these
// routes are called without an X-Org-Id header — send one and every Xero call
// 404s.
function requireOrganisation(req: any, res: any) {
  const organisation = getOrganisation(workspaceId(req), req.params.id);
  if (!organisation) {
    res.status(404).json({ error: 'organisation_not_found' });
    return null;
  }
  // A standalone entity has no Xero of its own, so every route that reads a
  // chart, a tax rate or a contact has nothing to serve. Say so once, here,
  // rather than sending a request with no tenant_id and relaying back whatever
  // shape the failure happens to take.
  if (!organisation.tenantId) {
    res.status(409).json({
      error: 'no_xero_connection',
      message: `"${organisation.name}" isn't connected to Xero, so it has no chart of accounts of its own.`,
    });
    return null;
  }
  return organisation;
}

// Publishing is the one thing a standalone entity CAN do with Xero, because it
// posts into its parent's. So it resolves its own target rather than going
// through the gate above — the entity the document lives in, and the entity the
// money lands in, are deliberately two different things here.
function requirePublishTarget(req: any, res: any) {
  const ws = workspaceId(req);
  const organisation = getOrganisation(ws, req.params.id);
  if (!organisation) {
    res.status(404).json({ error: 'organisation_not_found' });
    return null;
  }
  const target = publishTargetFor(ws, organisation);
  if (!target) {
    res.status(409).json({
      error: 'no_publish_target',
      message: `"${organisation.name}" has no Xero to post into. Set the entity it publishes into, and make sure that one is connected to Xero.`,
    });
    return null;
  }
  return { organisation, target };
}

// Which entity's book to read on a route that names the organisation in its
// path. Taken from the path rather than the X-Org-Id header: you publish into
// the Xero tenant named in the URL, so that entity's book is the one that must
// supply the document. (The header is what the Costs/Sales APIs use, but these
// routes are called without it — which is why publishing from any entity other
// than the primary one used to 404.)
function bookFor(req: any): string {
  return dataScopeForOrg(String(req.params?.id ?? '').trim());
}

// --- Server-side extraction inputs ------------------------------------------
// The inbound-email reader has no browser to assemble the org's chart of
// accounts and project list the way an upload does (see src/lib/bills.js →
// fetchExtract), so it gathers them here instead — the same relay calls the
// per-org routes above make, minus the req/res. Both never throw: a missing key
// or an unreachable relay yields an empty list, so an emailed document still
// reads (just without account/project classification), never 500s.

export type XeroAccountRef = { code: string; name: string; description: string; type: string; taxType: string };

// The linked org's ACTIVE Xero accounts, for classifying an emailed document
// into the account it should post to. Empty when Xero isn't configured, the org
// isn't linked, or the relay fails.
export async function accountsForOrg(ws: string, orgId: string): Promise<XeroAccountRef[]> {
  if (!xeroEnabled || !orgId) return [];
  const organisation = getOrganisation(ws, orgId);
  // No organisation, or a standalone one with no Xero of its own. Explicit,
  // because the relay would otherwise be called with no tenant_id and the
  // failure swallowed — degrading by accident rather than on purpose.
  if (!organisation?.tenantId) return [];
  try {
    const result = await relay('Accounts', { tenantId: organisation.tenantId, query: { where: 'Status=="ACTIVE"' } });
    if (!result.ok) return [];
    return (result.data?.Accounts ?? [])
      .filter((a: any) => a.Code)
      .map((a: any) => ({
        code: String(a.Code),
        name: String(a.Name ?? ''),
        description: String(a.Description ?? ''),
        type: String(a.Type ?? ''),
        taxType: String(a.TaxType ?? ''),
      }));
  } catch {
    return [];
  }
}

// The linked org's ACTIVE purchase tax rates, shaped the way the client's
// managed list shapes them ({name, code, rate}) so the shared tax-code decision
// (src/lib/taxRateRules.js) reads them identically wherever it is called from.
export async function taxRatesForOrg(ws: string, orgId: string): Promise<Array<{ name: string; code: string; rate: number }>> {
  if (!xeroEnabled || !orgId) return [];
  const organisation = getOrganisation(ws, orgId);
  // No organisation, or a standalone one with no Xero of its own. Explicit,
  // because the relay would otherwise be called with no tenant_id and the
  // failure swallowed — degrading by accident rather than on purpose.
  if (!organisation?.tenantId) return [];
  try {
    const result = await relay('TaxRates', { tenantId: organisation.tenantId });
    if (!result.ok) return [];
    return (result.data?.TaxRates ?? [])
      .filter((t: any) => t.Status === 'ACTIVE' && t.CanApplyToExpenses !== false)
      .map((t: any) => ({ name: String(t.Name ?? ''), code: String(t.TaxType ?? ''), rate: Number(t.EffectiveRate) || 0 }))
      .filter((t: any) => t.name);
  } catch {
    return [];
  }
}

// The names of the linked org's first ACTIVE tracking category (the "PIC" list
// the app calls Projects), so an emailed document can be allocated to the site
// it names. Empty when Xero isn't configured, the org isn't linked, or none.
export async function projectOptionsForOrg(ws: string, orgId: string): Promise<string[]> {
  if (!xeroEnabled || !orgId) return [];
  const organisation = getOrganisation(ws, orgId);
  // No organisation, or a standalone one with no Xero of its own. Explicit,
  // because the relay would otherwise be called with no tenant_id and the
  // failure swallowed — degrading by accident rather than on purpose.
  if (!organisation?.tenantId) return [];
  try {
    const tc = await firstTrackingCategory(organisation.tenantId);
    return tc ? [...tc.options] : [];
  } catch {
    return [];
  }
}

export const xeroRouter = Router();

// GET /api/xero/status — capability probe for the frontend.
xeroRouter.get('/status', (_req, res) => {
  res.json({ xeroEnabled });
});

// GET /api/xero/tenants — Xero organisations connected in cyworkspace, for the
// add-organisation picker.
xeroRouter.get('/tenants', async (req, res) => {
  // Every Xero organisation the practice has connected — which is the firm's
  // client list. A client's own admin has no business reading it, and had no
  // reason to: linking an entity is the practice's job. Asked BEFORE whether
  // the relay is configured, so the answer is "not yours" rather than a hint
  // about the deployment.
  const me = memberForSession(req);
  if (googleEnabled && !(me?.practice && !me.deactivated)) {
    return res.status(403).json({ error: 'not_practice_team' });
  }
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

// Xero rejects attachments over 25 MB. Buffer up to that and no further — a
// runaway file must not take the process with it.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

// A stored document's bytes, for attaching to the Xero bill it was published as.
async function billFileBytes(bill: Bill): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!bill.storageKey) return null;
  const obj = await getBillFile(bill.storageKey, bill.contentType);
  if (!obj) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of obj.body) {
    size += (chunk as Buffer).length;
    if (size > MAX_ATTACHMENT_BYTES) {
      obj.body.destroy();
      return null;
    }
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return {
    bytes: Buffer.concat(chunks),
    contentType: bill.contentType || obj.contentType || 'application/octet-stream',
  };
}

// Xero's attachment filenames are part of the URL: keep them plain, and make
// sure the extension matches what we're actually sending.
function attachmentName(bill: Bill, contentType: string): string {
  const ext = extFor(contentType) || 'pdf';
  const base = String(bill.fileName || bill.supplier || 'document')
    .replace(/\.[^./\\]+$/, '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 80) || 'document';
  return `${base}.${ext}`;
}

// Put the original document on a Xero invoice. Best-effort by design: every
// caller has already posted the invoice, and a failed upload must not undo that.
async function attachBillFile(
  tenantId: string,
  invoiceId: string,
  bill: Bill
): Promise<{ ok: boolean; error?: string; bytes?: number } | null> {
  if (!invoiceId) return null;
  try {
    const file = await billFileBytes(bill);
    if (!file) return null; // nothing stored (or too big) — nothing to attach
    // Never hand Xero an empty body: it answers with a validation error that
    // reads as if the ATTACHMENT was rejected, when the real fault is upstream
    // of the call. Say which end lost the bytes.
    if (!file.bytes.length) {
      console.error('[xero] attachment skipped — read 0 bytes from storage', bill.id, bill.storageKey);
      return { ok: false, error: 'The stored file read back empty, so there was nothing to send.', bytes: 0 };
    }
    const name = attachmentName(bill, file.contentType);
    const att = await relay(`Invoices/${invoiceId}/Attachments/${encodeURIComponent(name)}`, {
      method: 'POST',
      tenantId,
      rawBody: file.bytes,
      contentType: file.contentType,
    });
    if (!att.ok) {
      // The byte count is the whole diagnosis: if Xero reports ContentLength 0
      // while this says we sent thousands, the body was dropped in transit (the
      // relay), not produced empty here.
      console.error(
        '[xero] bill attachment failed',
        att.status,
        att.message,
        `— CYBills sent ${file.bytes.length} bytes of ${file.contentType} as ${name}`
      );
      return {
        ok: false,
        error: `${att.message} (CYBills sent ${file.bytes.length} bytes of ${file.contentType})`,
        bytes: file.bytes.length,
      };
    }
    return { ok: true, bytes: file.bytes.length };
  } catch (err) {
    console.error('[xero] bill attachment error', err);
    return { ok: false, error: 'The file could not be read or sent.' };
  }
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

type TrackingCat = { name: string; options: Set<string> };

// The org's ACTIVE tracking categories in Xero's own order — [0] is the "PIC"
// list the app calls Projects, [1] is Projects 2. Xero allows at most two, and
// a line may be tagged with one option from each.
async function trackingCategories(tenantId: string): Promise<TrackingCat[]> {
  const result = await relay('TrackingCategories', { tenantId });
  if (!result.ok) return [];
  return (result.data?.TrackingCategories ?? [])
    .filter((c: any) => c.Status === 'ACTIVE' && c.Name)
    .slice(0, 2)
    .map((c: any) => ({
      name: String(c.Name),
      options: new Set<string>(
        (c.Options ?? []).filter((o: any) => o.Status === 'ACTIVE').map((o: any) => String(o.Name))
      ),
    }));
}

// The org's first ACTIVE tracking category, for the paths that only tag one.
async function firstTrackingCategory(tenantId: string): Promise<TrackingCat | null> {
  return (await trackingCategories(tenantId))[0] ?? null;
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

// The Tracking array for one line, across both categories — each value kept
// only when it is a live option of ITS category, so a stale project name is
// dropped rather than failing the whole bill.
function trackingAcross(cats: TrackingCat[], values: string[]): Array<{ Name: string; Option: string }> {
  const out: Array<{ Name: string; Option: string }> = [];
  cats.forEach((cat, i) => {
    const v = String(values[i] ?? '').trim();
    if (v && cat.options.has(v)) out.push({ Name: cat.name, Option: v });
  });
  return out;
}

// The org's active account codes, for checking a line's own category before it
// is posted — a code Xero doesn't have would fail the whole bill, and one bad
// line is not a reason to lose the other four.
async function activeAccountCodes(tenantId: string): Promise<Set<string>> {
  const result = await relay('Accounts', { tenantId, query: { where: 'Status=="ACTIVE"' } });
  if (!result.ok) return new Set();
  return new Set<string>((result.data?.Accounts ?? []).map((a: any) => String(a.Code ?? '')).filter(Boolean));
}

// "315 - Outlet Laundry" -> "315". The label the app stores is built from the
// Xero account as `<code> - <name>`, so the code is simply its head.
// The same rule as accountCodeFromCategory in src/data/xeroAccounts.js, which is
// what the browser applies to the same labels.
function codeFromCategory(category: unknown): string {
  const s = String(category ?? '');
  const i = s.indexOf(' - ');
  if (i === -1) return '';
  const code = s.slice(0, i).trim();
  // A code always contains a digit. Without that test a bridge entity's plain
  // category "Transport - Taxi" reads as the account code "Transport".
  return /^(?=.*\d)[A-Za-z0-9][A-Za-z0-9-]{0,14}$/.test(code) ? code : '';
}

// Build the Xero lines for a bill that has its own line items, so each one
// carries its own account and its own project(s). Three outcomes, and the
// caller treats them very differently:
//
//   'none'     — no line items. Posts as the single summary line, as always.
//   'lines'    — the rows are provably the same money as the bill, so they go
//                up as the bill's own lines.
//   'mismatch' — the rows contradict the bill. The publish is REFUSED.
//
// Same money means: they add up to the bill's total to the cent, and their tax
// adds up to its tax to the cent. The second is usually satisfied by
// distributing — a reader fills in per-row tax only when the document breaks
// tax down per row, and most don't, so the bill's single GST figure is spread
// across the rows in proportion to their net, the odd cents going by largest
// remainder.
//
// Rows that can't be reconciled used to post as one summary line. They don't
// any more: a breakdown that disagrees with its own total is a mistake
// somewhere, and posting around it puts a bill in a client's ledger whose lines
// nobody can tie back to the paper. Better to say so and let it be fixed.
// Exported for the reconciliation test in server/test — this arithmetic decides
// what lands in a live ledger.
export type LineBuild =
  | { kind: 'none' }
  | { kind: 'lines'; lines: Array<Record<string, unknown>> }
  | { kind: 'mismatch'; reason: 'total' | 'tax'; linesTotal: number; linesTax: number };

export async function perLineItems(
  bill: Bill,
  opts: { accountCode: string; taxType: string; tenantId: string; fallbackDescription: string }
): Promise<LineBuild> {
  const rows = Array.isArray(bill.lineItems) ? bill.lineItems : [];
  if (!rows.length) return { kind: 'none' };

  const c = (n: number) => Math.round(n * 100);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const totals = rows.map((r) => c(parseAmount(r.total) || parseAmount(r.net) + parseAmount(r.tax)));
  const rowTax = rows.map((r) => c(parseAmount(r.tax)));
  const mismatch = (reason: 'total' | 'tax'): LineBuild => ({
    kind: 'mismatch',
    reason,
    linesTotal: sum(totals) / 100,
    linesTax: sum(rowTax) / 100,
  });
  if (sum(totals) !== c(parseAmount(bill.total))) return mismatch('total');

  const billTax = c(parseAmount(bill.tax));
  let taxes = rowTax;
  if (sum(taxes) !== billTax) {
    // Only the "document states one GST figure" case is recoverable. Rows that
    // carry SOME tax but not the bill's are a disagreement, not a gap.
    if (taxes.some((t) => t !== 0) || billTax === 0) return mismatch('tax');
    if (sum(totals.map((t) => Math.max(0, t))) <= 0) return mismatch('tax');
    taxes = apportion(billTax, totals);
    if (sum(taxes) !== billTax) return mismatch('tax');
  }

  const [codes, cats] = await Promise.all([activeAccountCodes(opts.tenantId), trackingCategories(opts.tenantId)]);
  const lines = rows.map((row, i) => {
    const own = codeFromCategory(row.category);
    const line: Record<string, unknown> = {
      Description: String(row.description ?? '').trim() || opts.fallbackDescription,
      Quantity: 1,
      // Tax-EXCLUSIVE, like the single-line path: Xero then shows a Tax Amount
      // column and the figures match the paper.
      UnitAmount: (totals[i] - taxes[i]) / 100,
      // A line whose own category isn't a live Xero account follows the account
      // chosen for the document rather than being dropped.
      AccountCode: own && codes.has(own) ? own : opts.accountCode,
      TaxType: opts.taxType,
      TaxAmount: taxes[i] / 100,
    };
    // The line's own projects, falling back to the document's for the first
    // category — a row that says nothing is still part of this bill.
    const tracking = trackingAcross(cats, [
      String(row.project ?? '').trim() || String(bill.project ?? ''),
      String(row.project2 ?? ''),
    ]);
    if (tracking.length) line.Tracking = tracking;
    return line;
  });
  return { kind: 'lines', lines };
}

// The Xero bill a stored document becomes. Shared, because a document is turned
// into an ACCPAY invoice twice now — once when it is first published, and again
// whenever a correction is sent to the bill that publish created. Two copies of
// this would drift, and the drift would be silent: an update that built its
// lines differently from the publish would quietly restate a figure in a live
// ledger.
//
// Returns the payload WITHOUT Status or InvoiceID — the two fields that differ
// between creating a bill and correcting one — or the 422 the caller should
// answer with when the document's own line items contradict it.
async function buildBillInvoice(
  req: any,
  organisation: { id: string; tenantId: string },
  bill: Bill,
  opts: { accountCode: string; taxType: string; dueDate?: unknown; description?: unknown }
): Promise<
  | { ok: true; payload: Record<string, unknown>; lines: number; perLine: boolean }
  | { ok: false; status: number; body: any }
> {
  const total = parseAmount(bill.total);
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const date = String(bill.date ?? '');
  // Due date follows the date actually POSTED, not the one on the paper. When a
  // period is locked, `date` above has already moved to something postable — and
  // a due date left on the original date would then sit BEFORE the bill itself.
  // Tying them together means the pair stays coherent however the date shifts.
  // A date typed into the publish dialog still wins; nothing else does.
  const iso = (v: unknown) => (ISO_DATE.test(String(v ?? '')) ? String(v) : '');
  const dueDate = iso(opts.dueDate) || date;
  const tax = parseAmount(bill.tax);

  const net = Math.max(0, total - tax);
  const line: Record<string, unknown> = {
    // A bill published on its own reads as its own document: the description
    // from the paper, nothing prepended. The "<Supplier> #<ItemID> - …" form is
    // for EXPENSE CLAIM lines, where one Xero bill carries many people's
    // receipts and each line has to say which document it came from.
    Description:
      String(opts.description ?? '').trim() ||
      String(bill.description ?? '').trim() ||
      [bill.category || bill.documentType || 'Supplier bill', bill.invoiceNumber].filter(Boolean).join(' — '),
    Quantity: 1,
    // Post tax-EXCLUSIVE (net unit amount + explicit tax) so Xero shows a Tax
    // Amount column and the figures match the paper exactly — matching Dext.
    UnitAmount: net,
    AccountCode: opts.accountCode,
    TaxType: opts.taxType,
    TaxAmount: tax,
  };
  // Tag the line with the doc's project (PIC tracking category) when set.
  if (bill.project) {
    const tracking = trackingFor(await firstTrackingCategory(organisation.tenantId), bill.project);
    if (tracking) line.Tracking = tracking;
  }

  // A bill with its own line items posts as those lines — each with its own
  // account and its own project(s). Line items that contradict the document are
  // refused rather than posted around: a breakdown that doesn't add up to its
  // own total is a mistake somewhere on the document, and one summary line
  // silently standing in for it hides that from whoever reconciles the ledger.
  const built = await perLineItems(bill, {
    accountCode: opts.accountCode,
    taxType: opts.taxType,
    tenantId: organisation.tenantId,
    fallbackDescription: String(line.Description ?? ''),
  });
  if (built.kind === 'mismatch') {
    const money = (n: number) => n.toFixed(2);
    return { ok: false as const, status: 422, body: {
      error: 'line_items_unreconciled',
      reason: built.reason,
      linesTotal: built.linesTotal,
      linesTax: built.linesTax,
      message:
        built.reason === 'total'
          ? `This document's ${(bill.lineItems ?? []).length} line items add up to ${money(built.linesTotal)}, not the document's total of ${money(parseAmount(bill.total))}. Fix the lines (or the total) before publishing — a bill whose lines don't add up to it can't be posted.`
          : `This document's line items carry ${money(built.linesTax)} of tax, but the document's tax is ${money(parseAmount(bill.tax))}. Fix the Tax column before publishing.`,
    } };
  }
  const lineItems = built.kind === 'lines' ? built.lines : [line];

  const payload: Record<string, unknown> = {
    Type: 'ACCPAY',
    Contact: { Name: bill.supplier || 'Unknown supplier' },
    Date: date,
    DueDate: dueDate,
    LineAmountTypes: 'Exclusive',
    LineItems: lineItems,
  };
  if (bill.invoiceNumber) payload.InvoiceNumber = bill.invoiceNumber;
  // "Go to CYBills" on the bill in Xero — straight back to the document this
  // was published from, and the original paper attached to it.
  payload.Url = `${appOrigin(req)}/costs/${encodeURIComponent(displayIdOf(bill.id) || bill.id)}?org=${encodeURIComponent(organisation.id)}`;
  if (bill.currency) payload.CurrencyCode = bill.currency;
  // `lines`/`perLine` are how it went up — the document's own breakdown, or one
  // summary line — which the caller reports back to the dialog.
  return { ok: true as const, payload, lines: lineItems.length, perLine: built.kind === 'lines' };
}

// POST /api/xero/organisations/:id/publish-bill — publish a stored cost
// document to the linked Xero org as a supplier bill (ACCPAY invoice).
// Body: { billId, accountCode, taxType, status?, dueDate?, description?,
//         force? }. The bill's total is posted tax-inclusive as one line.
// Re-publishing an already-posted bill is refused (409) unless force:true.
// What a document is still missing before it may be posted, in the words the
// inbox already uses. Built on costComplete so the two can never disagree: a
// document that reads Ready is postable, and one that reads "Missing: Date" is
// refused rather than posted with today's date invented for it — which lands a
// July receipt in August's quarter and its GST return, saying nothing.
function missingForPublish(bill: Bill): string[] {
  if (costComplete(bill)) return [];
  const out: string[] = [];
  const filled = (v: unknown) => String(v ?? '').trim().length > 0;
  const s = String(bill.supplier ?? '').trim().toLowerCase();
  const c = String(bill.category ?? '').trim().toLowerCase();
  if (!filled(bill.supplier) || s === 'unknown supplier') out.push('a supplier');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(bill.date ?? ''))) out.push('a date');
  if (!filled(bill.category) || c === 'uncategorised') out.push('a category');
  if (!(parseAmount(bill.total) > 0)) out.push('a total above 0');
  return out;
}

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

  const workspace = bookFor(req);
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
  const onClaim = claimForBill(workspace, bill.id);
  if (onClaim) {
    return res.status(409).json({
      error: 'in_expense_claim',
      message: `This document is on the expense claim “${onClaim.name}”, so it can’t also be published as a bill. Remove it from the claim first, or publish the claim.`,
      claimId: onClaim.id,
    });
  }

  // The same completeness bulk publish requires. Publishing one document and
  // publishing forty are the same act on the same ledger, so they cannot hold
  // different standards: bulk SKIPS an incomplete document, and this used to
  // post it. `costComplete` is the one definition (supplier, date, category,
  // total > 0) — the same one that decides Ready vs To review, so a document the
  // inbox is already flagging is never quietly acceptable here.
  const missing = missingForPublish(bill);
  if (missing.length) {
    return res.status(400).json({
      error: 'incomplete',
      missing,
      message: `This document still needs ${missing.join(', ')}. A bill is posted into a live ledger, so it has to be complete first.`,
    });
  }
  const prepared = await buildBillInvoice(req, organisation, bill, {
    accountCode,
    taxType,
    dueDate: b.dueDate,
    description: b.description,
  });
  if (!prepared.ok) return res.status(prepared.status).json(prepared.body);
  const payload = { ...prepared.payload, Status: status };


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

  // Send the original document up as an attachment, so the paper sits on the
  // bill in Xero rather than only here. Best-effort: the bill stays posted even
  // if the upload fails, and /attach-file can retry it.
  const attachment = await attachBillFile(
    organisation.tenantId,
    String(invoice.InvoiceID ?? ''),
    updated ?? bill
  );

  res.json({
    ok: true,
    invoice: {
      invoiceId: String(invoice.InvoiceID ?? ''),
      invoiceNumber: String(invoice.InvoiceNumber ?? ''),
      status: String(invoice.Status ?? status),
    },
    // How it went up: the document's own lines, or one summary line.
    lines: prepared.lines,
    perLine: prepared.perLine,
    attachment,
    bill: updated,
  });
});

// POST /api/xero/organisations/:id/sync-payments — ask Xero about every bill
// this entity has published, and record what it says.
//
// The webhook only ever hears about what changes AFTER it was configured, so a
// bill paid last month fired its event into a void and would sit here showing
// no status forever. This is the one-off that catches those up — and it is
// re-runnable, because it is also the repair for any delivery Xero dropped.
//
// Reads in batches of 50 (?IDs=…), so a book of 500 published bills costs ten
// calls against the tenant's 60 a minute rather than 500. Nothing here writes
// to Xero.
xeroRouter.post('/organisations/:id/sync-payments', async (req, res) => {
  if (notConfigured(res)) return;
  // Deliberately not requireOrganisation: that one refuses a standalone entity
  // for having no Xero of its own, and this route doesn't need it to have one.
  // Its bills carry the tenant they were published INTO — the parent's, for a
  // bridge — which is the tenant to ask either way.
  const organisation = getOrganisation(workspaceId(req), req.params.id);
  if (!organisation) return res.status(404).json({ error: 'organisation_not_found' });

  const scope = dataScopeForOrg(organisation.id);
  const published = listBills(scope).filter((b) => b.xeroInvoiceId);
  // A published CLAIM is a bill in Xero too — one bill carrying many people's
  // receipts — and its claimant is waiting on the same answer. Same read, same
  // three fields; only the paperwork behind the invoice differs.
  const claims = publishedClaims(scope);
  // A bound on one run, not a limit on the book: whatever is left is reported
  // and picked up by running it again. A silent cap would read as "all done".
  const MAX_PER_RUN = 1000;
  const batch = published.slice(0, MAX_PER_RUN);

  // By tenant, because a bridge entity's book can hold bills posted into more
  // than one Xero over its life, and ?IDs= is answered by one tenant at a time.
  const byTenant = new Map<string, typeof batch>();
  for (const bill of batch) {
    const tenantId = bill.xeroTenantId || organisation.tenantId;
    if (!tenantId) continue;
    const rows = byTenant.get(tenantId) ?? [];
    rows.push(bill);
    byTenant.set(tenantId, rows);
  }
  // Claims don't record which tenant they went into, and they can't: a bridge
  // entity's claims post into its PARENT's Xero, which is what publishTargetFor
  // resolves. That target is this entity's, whichever it is.
  const claimTenant = publishTargetFor(workspaceId(req), organisation)?.tenantId || organisation.tenantId;

  let updated = 0;
  let paid = 0;
  let missing = 0;
  let extraReads = 0;
  for (const [tenantId, rows] of byTenant) {
    const invoices = await fetchXeroInvoices(tenantId, rows.map((b) => String(b.xeroInvoiceId)));
    for (const bill of rows) {
      let invoice = invoices.get(String(bill.xeroInvoiceId).toLowerCase());
      // A bill CYBills published that Xero no longer has: deleted there, or
      // moved to a tenant this entity is no longer connected to. Counted and
      // reported rather than quietly skipped — it means the two disagree.
      if (!invoice) {
        missing += 1;
        continue;
      }
      let payment = paymentFromInvoice(invoice);
      // A list response can leave Payments out where a single-invoice read
      // includes them, and the reference is the whole point of the column. So a
      // PAID bill that came back without one is asked for by name — a small
      // minority of a book, and bounded so a first run on a large one can't
      // turn into hundreds of extra calls.
      if (payment.xeroStatus === 'PAID' && !payment.xeroPaymentRef && !Array.isArray(invoice.Payments) && extraReads < 200) {
        extraReads += 1;
        const full = await fetchXeroInvoice(tenantId, String(bill.xeroInvoiceId));
        if (full) {
          invoice = full;
          payment = paymentFromInvoice(full);
        }
      }
      if (!payment.xeroStatus) continue;
      if (payment.xeroStatus === 'PAID') paid += 1;
      if (markBillXeroPayment(bill.orgId, bill.id, payment)) updated += 1;
    }
  }

  // The claims, in one more batch against the tenant they post into.
  if (claims.length && claimTenant) {
    const invoices = await fetchXeroInvoices(claimTenant, claims.map((c) => String(c.xeroInvoiceId)));
    for (const claim of claims) {
      const invoice = invoices.get(String(claim.xeroInvoiceId).toLowerCase());
      if (!invoice) {
        missing += 1;
        continue;
      }
      const payment = paymentFromInvoice(invoice);
      if (!payment.xeroStatus) continue;
      if (payment.xeroStatus === 'PAID') paid += 1;
      if (markClaimXeroPayment(claim.id, payment)) updated += 1;
    }
  }

  res.json({
    checked: batch.length + claims.length,
    claims: claims.length,
    updated,
    paid,
    missing,
    remaining: Math.max(0, published.length - batch.length),
  });
});

// POST /api/xero/organisations/:id/update-bill — send a published document's
// CURRENT figures to the bill it already created in Xero.
// Body: { billId, accountCode, taxType, status?, dueDate?, description? }.
//
// Until now a correction found after publishing had nowhere to go: the document
// here could be fixed, and the ledger kept the first answer. The only routes out
// were editing the bill by hand in Xero — the two copies diverging quietly is
// exactly what publishing from here is meant to prevent — or clearing the Xero
// link and posting a second bill, which leaves the first one to be found and
// voided by somebody who may not know it exists.
//
// The same builder as publish, so a corrected bill is assembled exactly as the
// original was, plus the InvoiceID that makes Xero update rather than create.
// Xero decides what may still change: a PAID or VOIDED bill refuses, and its
// refusal is passed through in its own words rather than translated into a
// guess about why.
xeroRouter.post('/organisations/:id/update-bill', async (req, res) => {
  if (notConfigured(res)) return;
  const organisation = requireOrganisation(req, res);
  if (!organisation) return;

  const b = req.body ?? {};
  const billId = String(b.billId ?? '');
  const accountCode = String(b.accountCode ?? '').trim();
  const taxType = String(b.taxType ?? '').trim();
  if (!billId || !accountCode || !taxType) {
    return res.status(400).json({ error: 'missing_field', message: 'billId, accountCode and taxType are required.' });
  }
  const status = String(b.status ?? '').toUpperCase();
  if (status && !PUBLISH_STATUSES.has(status)) {
    return res.status(400).json({ error: 'invalid_status', message: 'status must be DRAFT, SUBMITTED or AUTHORISED.' });
  }

  const workspace = bookFor(req);
  const bill = getBillById(workspace, billId);
  if (!bill) return res.status(404).json({ error: 'bill_not_found' });
  // The whole premise of this route. Without a bill in Xero there is nothing to
  // update — that is what publish is for, and saying so is more use than
  // silently creating one from a button labelled "update".
  if (!bill.xeroInvoiceId) {
    return res.status(400).json({
      error: 'not_published',
      message: 'This document has not been published to Xero yet, so there is no bill to update. Publish it instead.',
    });
  }

  // Completeness is judged the same as on publish. A document that has LOST a
  // field since it was published — somebody clearing its category — must not be
  // able to blank that field in the ledger.
  const missing = missingForPublish(bill);
  if (missing.length) {
    return res.status(400).json({
      error: 'incomplete',
      missing,
      message: `This document still needs ${missing.join(', ')}. It is already in the ledger, so an update has to be complete too.`,
    });
  }

  const prepared = await buildBillInvoice(req, organisation, bill, {
    accountCode,
    taxType,
    dueDate: b.dueDate,
    description: b.description,
  });
  if (!prepared.ok) return res.status(prepared.status).json(prepared.body);

  // InvoiceID is what makes this an update. Status is sent only when the caller
  // asked for one: omitted, Xero leaves the bill where it is, so correcting an
  // APPROVED bill's coding can't quietly knock it back to DRAFT and out of
  // somebody's approval queue.
  const payload: Record<string, unknown> = { ...prepared.payload, InvoiceID: bill.xeroInvoiceId };
  if (status) payload.Status = status;

  // POST (not PUT) is Xero's update; summarizeErrors=false again, so a rejection
  // comes back per-record with its reasons instead of as a bare 400.
  const result = await relay('Invoices', {
    method: 'POST',
    tenantId: bill.xeroTenantId || organisation.tenantId,
    query: { summarizeErrors: 'false' },
    body: { Invoices: [payload] },
  });

  if (!result.ok) {
    console.error('[xero] update failed', result.status, result.message);
    return res.status(result.status >= 500 ? 502 : result.status).json({ error: result.error, message: result.message });
  }

  const invoice = result.data?.Invoices?.[0];
  const validationErrors: string[] = (invoice?.ValidationErrors ?? []).map((e: any) => String(e.Message ?? e));
  if (!invoice || invoice.HasErrors || validationErrors.length > 0) {
    return res.status(422).json({
      error: 'xero_validation_failed',
      // Xero's own words. A paid bill refuses an amount change, and the reason
      // it gives is more use to a reviewer than anything invented here.
      messages: validationErrors.length ? validationErrors : ['Xero rejected the update.'],
    });
  }

  // The answer names the bill's state as it now stands, so the document's own
  // Xero fields are refreshed from it rather than left to the next webhook.
  const payment = paymentFromInvoice(invoice);
  if (payment.xeroStatus) markBillXeroPayment(bill.orgId, bill.id, payment);

  res.json({
    ok: true,
    invoice: {
      invoiceId: String(invoice.InvoiceID ?? bill.xeroInvoiceId),
      invoiceNumber: String(invoice.InvoiceNumber ?? ''),
      status: String(invoice.Status ?? ''),
    },
    lines: prepared.lines,
    perLine: prepared.perLine,
    bill: getBillById(workspace, bill.id),
  });
});

// POST /api/xero/organisations/:id/attach-file — put a published document's
// original file on the Xero bill it was posted as. For bills published before
// attachments were sent, or when the upload failed at publish time.
// Body: { billId }.
xeroRouter.post('/organisations/:id/attach-file', async (req, res) => {
  if (notConfigured(res)) return;
  const organisation = requireOrganisation(req, res);
  if (!organisation) return;

  const bill = getBillById(bookFor(req), String(req.body?.billId ?? ''));
  if (!bill) return res.status(404).json({ error: 'bill_not_found' });
  if (!bill.xeroInvoiceId) {
    return res.status(400).json({ error: 'not_published', message: 'This document has not been published to Xero yet.' });
  }
  if (!bill.storageKey) {
    return res.status(400).json({ error: 'no_file', message: 'There is no stored file on this document to attach.' });
  }

  const attachment = await attachBillFile(organisation.tenantId, bill.xeroInvoiceId, bill);
  if (!attachment?.ok) {
    return res.status(502).json({
      error: attachment?.error ? 'attach_failed' : 'file_unavailable',
      message: attachment?.error || 'The stored file could not be read (it may be over Xero’s 25 MB limit).',
    });
  }
  res.json({ ok: true, attachment });
});

// GET /api/xero/organisations/:id/target-accounts — the expense accounts this
// entity's claims can post INTO. For a linked entity that is its own chart; for
// a bridge entity it is the parent's, which is the whole point: mapping a plain
// category to an account means choosing from the ledger that receives the money.
//
// Deliberately not the plain /accounts route: that one refuses a tenant-less
// entity (it has no chart of its own), and it would answer about the wrong
// company anyway.
xeroRouter.get('/organisations/:id/target-accounts', async (req, res) => {
  if (notConfigured(res)) return;
  const resolved = requirePublishTarget(req, res);
  if (!resolved) return;
  const accounts = await accountsForOrg(workspaceId(req), resolved.target.id);
  res.json({ accounts, target: { id: resolved.target.id, name: resolved.target.name } });
});

// POST /api/xero/organisations/:id/publish-claim — post an APPROVED expense
// claim as an ACCPAY bill payable to the employee. Each claim line becomes an
// invoice line (account code from its category); Xero applies each account's
// default tax rate. Defaults to DRAFT so it's reviewable in Xero, not finalised.
// Re-publishing is refused (409) unless force.
//
// The claim's entity and the entity whose ledger receives it are deliberately
// two different things: a bridge entity has no Xero of its own, so its claims
// post into its parent's (`requirePublishTarget`). Everywhere else the target
// IS the organisation, so nothing changes for a linked entity.
xeroRouter.post('/organisations/:id/publish-claim', async (req, res) => {
  if (notConfigured(res)) return;
  const resolved = requirePublishTarget(req, res);
  if (!resolved) return;
  const { organisation, target } = resolved;

  const b = req.body ?? {};
  const claimId = String(b.claimId ?? '');
  const status = String(b.status ?? 'DRAFT').toUpperCase();
  if (!claimId) return res.status(400).json({ error: 'missing_field', message: 'claimId is required.' });
  if (!PUBLISH_STATUSES.has(status)) {
    return res.status(400).json({ error: 'invalid_status', message: 'status must be DRAFT, SUBMITTED or AUTHORISED.' });
  }

  const org = bookFor(req);
  const claim = getClaimForXero(org, claimId);
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

  // Account code for a claim line.
  //
  // A linked entity's categories ARE its chart, so the code is the label's own
  // head ("412 - …" → "412"). A bridge entity's are plain names off a claim
  // policy — "Transport - Taxi" is not account "Transport" — so the entity's
  // own mapping (Business settings → Lists → Categories → Posts to) is what
  // turns them into codes in the parent's chart. The mapping is consulted first
  // either way: an entity that has written one means it.
  const accountMap = readSetting<Record<string, unknown>>(workspaceId(req), 'cybills.category-accounts.v1', organisation.id) || {};
  const mapped = new Map(
    Object.entries(accountMap).map(([name, code]) => [name.trim().toLowerCase(), String(code ?? '').trim()])
  );
  const codeOf = (cat: string) => {
    const name = String(cat ?? '').trim();
    const own = mapped.get(name.toLowerCase());
    if (own) return own;
    return (name.match(/\b(\d{3,})\b/) || [])[1] || '';
  };
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
  const tc = await firstTrackingCategory(target.tenantId);
  // A bridge entity's claims carry NO TAX.
  //
  // It is not a company: it has no GST registration and no tax position, so
  // there is no input tax for it to claim — and the entity whose ledger receives
  // the bill is being handed a reimbursement, not a tax invoice of its own. So
  // the line posts at the full amount with No Tax, which is what the practice
  // has always booked by hand.
  //
  // The tax the claim recorded is not dropped, it is FOLDED IN: the unit amount
  // becomes the whole figure rather than the net. The bill in Xero is worth
  // exactly what the claim is worth, which is the only rule that can't bend.
  const noTax = isStandalone(organisation);
  const lineItems = (claim.transactions ?? [])
    .map((t) => {
      const total = parseAmount(t.total);
      const tax = noTax ? 0 : parseAmount(t.tax);
      const bill = getBillByIdAny(String(t.itemId));
      const line = {
        Description: describe(t),
        Quantity: 1,
        // Tax-exclusive: net unit amount + explicit tax, so Xero renders a Tax
        // Amount column (matching Dext).
        UnitAmount: Math.max(0, total - tax),
        AccountCode: codeOf(t.category),
        TaxAmount: tax,
        // Named explicitly rather than left to the account's default rate in
        // Xero, which would put GST on a figure that has none and make the bill
        // disagree with the claim.
        ...(noTax ? { TaxType: 'NONE' } : {}),
        __total: total,
        __category: String(t.category ?? '').trim(),
      } as Record<string, unknown>;
      // Tag the PIC (tracking category) from the underlying cost doc's project.
      const tracking = trackingFor(tc, String(bill?.project || t.project || ''));
      if (tracking) line.Tracking = tracking;
      return line;
    })
    .map((line) => line as Record<string, unknown>);

  // An item with no coded category, or nothing to pay, cannot become a Xero
  // line. It used to be dropped SILENTLY — so a five-item claim could post as a
  // three-line bill, and the claim in CYBills would say more money than the bill
  // in Xero, with nothing anywhere saying why. Money that disappears between the
  // claim and the ledger is the one outcome worth refusing over, and it is the
  // same rule a bill's own line items already follow: a breakdown that disagrees
  // with its paper is a mistake to fix, not to post around.
  const unpostable = lineItems.filter((l) => !l.AccountCode || !(Number(l.__total) > 0));
  const postable = lineItems
    .filter((l) => l.AccountCode && Number(l.__total) > 0)
    .map(({ __total, __category, ...line }) => line);

  // What a reviewer has to DO about a refusal differs by entity, so the message
  // does too. A linked entity's item needs a coded category; a bridge entity's
  // category is fine as it is and needs mapping to an account in the parent's
  // chart — telling those people to "use a coded category" would send them
  // looking for a chart they don't have.
  const unmappedCategories = [
    ...new Set(
      unpostable
        .filter((l) => !l.AccountCode && Number(l.__total) > 0)
        .map((l) => String(l.__category ?? ''))
        .filter(Boolean)
    ),
  ];
  const fixIt = isStandalone(organisation)
    ? `map each category to a ${target.name} account in Business settings → Lists → Categories` +
      (unmappedCategories.length ? ` (${unmappedCategories.slice(0, 6).map((c) => `"${c}"`).join(', ')})` : '')
    : 'give each item a coded category (e.g. "412 - Consulting & Accounting")';

  if (!postable.length) {
    return res.status(400).json({
      error: 'no_lines',
      categories: unmappedCategories.slice(0, 20),
      message: `No claim line has an account code to post to — ${fixIt}.`,
    });
  }
  if (unpostable.length) {
    return res.status(422).json({
      error: 'unpostable_lines',
      count: unpostable.length,
      lines: unpostable.map((l) => String(l.Description ?? '')).slice(0, 10),
      categories: unmappedCategories.slice(0, 20),
      message:
        `${unpostable.length} of the ${lineItems.length} items on this claim can't become a Xero line — ` +
        `${fixIt}, and each item needs an amount above 0. Publishing now would post a bill for less than the ` +
        'claim is worth, so fix those items first.',
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  // The claim's own date, else the period it covers, else the latest date among
  // its items — every expense on it happened on or before that. Only a claim
  // with nothing dated at all falls back to today, which is what EVERY claim
  // used to do: August's expenses posted into whatever month somebody happened
  // to press the button in.
  const date = (await dateFor(claim)) || today;

  const payload: Record<string, unknown> = {
    Type: 'ACCPAY',
    Contact: { Name: claim.claimFor || 'Employee' },
    Date: date,
    DueDate: date,
    LineAmountTypes: 'Exclusive',
    LineItems: postable,
    Status: status,
    // The box a bill shows as "Reference" in Xero is the API's InvoiceNumber.
    // `Reference` is a SALES-invoice field: on an ACCPAY Xero accepts it, drops
    // it, and the bill arrives with an empty reference — which is exactly what
    // happened. Publishing a document has always used InvoiceNumber (see
    // publish-bill above); a claim now does the same.
    //
    // What goes in it: the claim's own name, its date and its Claim ID —
    // "ST Eng Exp Claim 20-Aug-2026 21324972410", the way the practice has
    // always identified these. The name alone repeats every month.
    InvoiceNumber: await referenceFor(claim),
    // Xero renders this as a "Go to CYBills" button on the bill — the way Dext's
    // bills carry "Go to Dext". Somebody reviewing the ledger can open the claim
    // this came from, with its items, its approvals and the receipts behind
    // them, instead of hunting for it.
    // The entity rides along: the app remembers whichever one you last had open,
    // so a link into a claim that lives in the bridge entity landed in CYBM and
    // reported the claim missing. Naming it makes the link self-contained.
    Url: `${appOrigin(req)}/expense-claims/${encodeURIComponent(claim.id)}?org=${encodeURIComponent(organisation.id)}`,
  };
  if (claim.currency) payload.CurrencyCode = claim.currency;

  const result = await relay('Invoices', {
    method: 'PUT',
    tenantId: target.tenantId,
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

  const updated = saveClaimXero(org, claim.id, {
    xeroInvoiceId: String(invoice.InvoiceID ?? ''),
    xeroTenantName: target.tenantName || target.name,
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
        tenantId: target.tenantId,
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
