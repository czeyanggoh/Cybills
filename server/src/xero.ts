import { Router } from 'express';
import { env, xeroEnabled } from './env.js';
import { dataScopeForOrg, getOrganisation } from './organisations.js';
import { workspaceId } from './workspace.js';
import { apportion, displayIdOf, getBillById, getBillByIdAny, markBillPosted, parseAmount, type Bill } from './store.js';
import { extFor, getBillFile } from './storage.js';
import { claimForBill, getClaimForXero, saveClaimXero } from './claims.js';

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
  return organisation;
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
  if (!organisation) return [];
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
  if (!organisation) return [];
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
  if (!organisation) return [];
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
function codeFromCategory(category: unknown): string {
  const s = String(category ?? '');
  const i = s.indexOf(' - ');
  if (i === -1) return '';
  const code = s.slice(0, i).trim();
  return /^[A-Za-z0-9][A-Za-z0-9-]{0,14}$/.test(code) ? code : '';
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

  const total = parseAmount(bill.total);
  if (!(total > 0)) {
    return res.status(400).json({ error: 'invalid_total', message: 'The bill needs a positive total before it can be posted.' });
  }
  // A bill with no date used to post as TODAY. That is not a missing field being
  // tolerated, it is a WRONG one being invented: a July receipt filed in August
  // lands in the wrong month, the wrong quarter and the wrong GST return, and
  // nothing on the Xero bill says the date was guessed. The document already
  // knows it has no date — the inbox labels it "Missing: Date" — so this refuses
  // rather than choosing a period on the client's behalf.
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const date = String(bill.date ?? '');
  if (!ISO_DATE.test(date)) {
    return res.status(400).json({
      error: 'missing_date',
      message: 'This document has no date, and a bill must be posted into a period. Set the date on the document, then publish.',
    });
  }
  // Due date follows the date actually POSTED, not the one on the paper. When a
  // period is locked, `date` above has already moved to something postable — and
  // a due date left on the original date would then sit BEFORE the bill itself.
  // Tying them together means the pair stays coherent however the date shifts.
  // A date typed into the publish dialog still wins; nothing else does.
  const iso = (v: unknown) => (ISO_DATE.test(String(v ?? '')) ? String(v) : '');
  const dueDate = iso(b.dueDate) || date;
  const tax = parseAmount(bill.tax);

  const net = Math.max(0, total - tax);
  const line: Record<string, unknown> = {
    // A bill published on its own reads as its own document: the description
    // from the paper, nothing prepended. The "<Supplier> #<ItemID> - …" form is
    // for EXPENSE CLAIM lines, where one Xero bill carries many people's
    // receipts and each line has to say which document it came from.
    Description:
      String(b.description ?? '').trim() ||
      String(bill.description ?? '').trim() ||
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

  // A bill with its own line items posts as those lines — each with its own
  // account and its own project(s). Line items that contradict the document are
  // refused rather than posted around: a breakdown that doesn't add up to its
  // own total is a mistake somewhere on the document, and one summary line
  // silently standing in for it hides that from whoever reconciles the ledger.
  const built = await perLineItems(bill, {
    accountCode,
    taxType,
    tenantId: organisation.tenantId,
    fallbackDescription: String(line.Description ?? ''),
  });
  if (built.kind === 'mismatch') {
    const money = (n: number) => n.toFixed(2);
    return res.status(422).json({
      error: 'line_items_unreconciled',
      reason: built.reason,
      linesTotal: built.linesTotal,
      linesTax: built.linesTax,
      message:
        built.reason === 'total'
          ? `This document's ${(bill.lineItems ?? []).length} line items add up to ${money(built.linesTotal)}, not the document's total of ${money(parseAmount(bill.total))}. Fix the lines (or the total) before publishing — a bill whose lines don't add up to it can't be posted.`
          : `This document's line items carry ${money(built.linesTax)} of tax, but the document's tax is ${money(parseAmount(bill.tax))}. Fix the Tax column before publishing.`,
    });
  }
  const lineItems = built.kind === 'lines' ? built.lines : [line];

  const payload: Record<string, unknown> = {
    Type: 'ACCPAY',
    Contact: { Name: bill.supplier || 'Unknown supplier' },
    Date: date,
    DueDate: dueDate,
    LineAmountTypes: 'Exclusive',
    LineItems: lineItems,
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
    lines: lineItems.length,
    perLine: built.kind === 'lines',
    attachment,
    bill: updated,
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

  const updated = saveClaimXero(org, claim.id, {
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
