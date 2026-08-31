import { Router } from 'express';
import { keyMatches } from './inboundKey.js';
import { WORKSPACE_ID } from './workspace.js';
import {
  dataScopeForOrg,
  listOrganisations,
  type Organisation,
} from './organisations.js';
import {
  costComplete,
  displayIdOf,
  getBillByIdAny,
  listBills,
  parseAmount,
  type Bill,
} from './store.js';
import { getBillFile } from './storage.js';
import { appOrigin } from './users.js';
import {
  accountsForOrg,
  postBillToXero,
  postingCodesFrom,
  taxRatesForOrg,
} from './xero.js';

// Payables: the half of a document's life that happens in CYWorkspace.
//
// CYBills collects the paper and codes it; CYWS runs the payment — it holds the
// supplier's bank details, builds the bank upload file, and emails the run out.
// Those two used to meet only in Xero, which meant a bill CYBills had read but
// not yet published simply did not exist as far as a payment run was concerned:
// CYWS's Bills Listing is built from AUTHORISED ACCPAY invoices, so a document
// sitting Ready in the inbox was invisible to the person about to pay it.
//
// This is the seam. CYWS asks what is payable (§ GET /bills), reads the paper
// to pull the payee's bank details off it (§ GET /bills/:id/file), creates the
// Xero contact and saves those details on it, and only then asks us to publish
// (§ POST /bills/:id/publish) — handing back the CONTACT ID it made. The order
// is the whole of it, and it is why publish takes a contact id at all: Xero
// matches a contact by NAME when given one, and creates a new contact when the
// name is new, so a bill published as "Grab Pte Ltd" against a contact CYWS
// created as "Grab" would land on a second, bank-detail-less contact and the
// payment file would have nowhere to send the money.
//
// Machine-to-machine throughout: the same X-API-Key CYWS already proves itself
// with on the WhatsApp routes (inboundKey.ts), allowlisted past the session
// guard in index.ts. That key opens every client's book, which is why every
// route here also makes the caller NAME the Xero tenant it believes it is
// working in, and refuses a document belonging to a different one. One client's
// bill posted into another client's ledger is not a bug anybody notices quickly.

export const paymentsRouter = Router();

function unauthorised(req: any, res: any): boolean {
  if (keyMatches(req.header('X-API-Key') || '')) return false;
  res.status(401).json({ error: 'bad_key', message: 'X-API-Key did not match.' });
  return true;
}

// Every entity linked to this Xero tenant. Normally one — but the practice can
// link the same Xero organisation twice under different names, and a payment run
// wants everything payable in that ledger rather than whichever entity happened
// to be linked first.
function organisationsForTenant(tenantId: string): Organisation[] {
  const wanted = tenantId.trim().toLowerCase();
  if (!wanted) return [];
  return listOrganisations(WORKSPACE_ID).filter((o) => o.tenantId.trim().toLowerCase() === wanted);
}

// The inbox statuses — a document still being worked on. Mirrors
// INBOX_STATUSES in src/lib/readiness.js, which is what the Costs tab reads.
const INBOX_STATUSES = new Set(['new', 'viewed', 'review', 'ready']);

// What may be offered to a payment run, and every clause is a way of paying
// money twice or paying it for nothing:
//
//   - a COST document, not a sales one;
//   - still in the inbox — archived is somebody setting a document aside, on an
//     expense claim it reaches the ledger as a line of the claim's bill, and
//     merged away it is another document's money now;
//   - not already in Xero, where the ordinary Bills Listing already has it;
//   - COMPLETE, because an incomplete document cannot be published and a
//     payment run that cannot publish is a payment with no bill behind it;
//   - not marked PAID. This is the one that matters most: most of what CYBills
//     collects is receipts — money already handed over at the merchant — and a
//     receipt in a payment run pays the same supplier a second time.
function payable(b: Bill): boolean {
  if (b.kind !== 'cost') return false;
  if (!INBOX_STATUSES.has(String(b.status ?? ''))) return false;
  if (b.xeroInvoiceId) return false;
  if (b.paid) return false;
  return costComplete(b);
}

// One payable document, as CYWS needs it: enough to show the row, enough to
// build the payment line, and the link to the paper it must read the bank
// details off. Snake_case throughout, like the other CYWS-facing payloads.
function payableRow(
  req: any,
  organisation: Organisation,
  bill: Bill,
  posting: ReturnType<typeof postingCodesFrom>
) {
  const itemId = displayIdOf(bill.id) || bill.id;
  return {
    id: bill.id,
    item_id: itemId,
    org_id: organisation.id,
    org_name: organisation.name,
    tenant_id: organisation.tenantId,
    supplier: bill.supplier,
    invoice_number: bill.invoiceNumber || '',
    reference: bill.invoiceNumber || '',
    date: bill.date,
    due_date: bill.dueDate || bill.date,
    currency: bill.currency || '',
    total: parseAmount(bill.total),
    tax: parseAmount(bill.tax),
    // What the paper says the same money is worth in the entity's own currency,
    // where it restated itself. A payment goes out in the BILLING currency, so
    // this is for showing beside it, never for paying.
    base_currency: bill.baseCurrency || '',
    base_total: bill.baseTotal ?? null,
    category: bill.category || '',
    description: bill.description || '',
    document_type: bill.documentType || '',
    // The document page in CYBills, for a row that wants looking at.
    url: `${appOrigin(req)}/costs/${encodeURIComponent(itemId)}?org=${encodeURIComponent(organisation.id)}`,
    has_file: Boolean(bill.storageKey),
    file_url: bill.storageKey
      ? `${appOrigin(req)}/api/payments/bills/${encodeURIComponent(bill.id)}/file`
      : '',
    // Whether publishing would work if it were asked for right now, and why not
    // when it wouldn't. Said HERE rather than discovered at publish time,
    // because the alternative is a row that looks payable, gets ticked into a
    // run, has a contact created for it in Xero, and only then refuses.
    postable: posting.ok,
    blocked_reason: posting.ok ? '' : posting.message,
    account_code: posting.ok ? posting.accountCode : '',
    tax_type: posting.ok ? posting.taxType : '',
  };
}

// GET /api/payments/bills?tenant_id=<uuid> — every document in this Xero
// organisation's CYBills book that is waiting to be paid.
//
// The chart of accounts and the tax rates are read ONCE per entity and the
// posting decision made against them per row, rather than two relay calls per
// document: a book with forty payables would otherwise cost eighty calls
// against a tenant's sixty-a-minute.
paymentsRouter.get('/bills', async (req, res) => {
  if (unauthorised(req, res)) return;
  const tenantId = String(req.query.tenant_id ?? '').trim();
  if (!tenantId) {
    return res.status(400).json({ error: 'tenant_id_required', message: 'Name the Xero tenant to list payables for.' });
  }
  const organisations = organisationsForTenant(tenantId);
  if (!organisations.length) {
    // Not an error: CYWS asks for every tenant its user can see, and most of
    // them are not CYBills clients at all. An empty list is the honest answer.
    return res.json({ ok: true, tenant_id: tenantId, organisations: [], bills: [] });
  }

  const bills: ReturnType<typeof payableRow>[] = [];
  for (const organisation of organisations) {
    const candidates = listBills(dataScopeForOrg(organisation.id)).filter(payable);
    if (!candidates.length) continue;
    const [accounts, rates] = await Promise.all([
      accountsForOrg(WORKSPACE_ID, organisation.id),
      taxRatesForOrg(WORKSPACE_ID, organisation.id),
    ]);
    for (const bill of candidates) {
      bills.push(payableRow(req, organisation, bill, postingCodesFrom(bill, accounts, rates)));
    }
  }

  res.json({
    ok: true,
    tenant_id: tenantId,
    organisations: organisations.map((o) => ({ id: o.id, name: o.name })),
    bills,
  });
});

// GET /api/payments/bills/:id/file — the original document.
//
// CYWS reads the payee's bank details off it. The ordinary file route needs a
// session or a signed share link (bills.ts), neither of which a server-to-server
// caller has; this one carries the shared key instead. Deliberately NOT the
// share-link route: those are gated by the entity's Exports → Image sharing
// setting, which is about links pasted into spreadsheets, and switching it off
// must not silently stop a payment run.
paymentsRouter.get('/bills/:id/file', async (req, res) => {
  if (unauthorised(req, res)) return;
  const bill = getBillByIdAny(req.params.id);
  if (!bill || !bill.storageKey) return res.status(404).json({ error: 'no_file' });

  const obj = await getBillFile(bill.storageKey, bill.contentType);
  if (!obj) return res.status(502).json({ error: 'file_unavailable' });

  const type = String(bill.contentType || obj.contentType || 'application/octet-stream');
  res.setHeader('Content-Type', /^[\x20-\x7e]+$/.test(type) ? type : 'application/octet-stream');
  obj.body.on('error', () => res.destroy());
  obj.body.pipe(res);
});

const PUBLISH_STATUSES = new Set(['DRAFT', 'SUBMITTED', 'AUTHORISED']);

// POST /api/payments/bills/:id/publish
// Body: { tenant_id, contact_id, status?, due_date? }
//
// AUTHORISED by default, and that is the point of the route rather than an
// incidental default: Xero will not accept a payment against a DRAFT or a
// SUBMITTED bill, so a payment run that published as either would produce a bank
// file for a bill the ledger refuses to settle. Selecting a document into a
// payment run IS the approval — the run is reviewed before it is released.
//
// Idempotent on purpose. A run that published five bills and then failed to
// build its file is re-run by a person pressing the button again, and each of
// those five must answer with the invoice it already has rather than posting a
// second copy for somebody to find and void.
paymentsRouter.post('/bills/:id/publish', async (req, res) => {
  if (unauthorised(req, res)) return;
  const b = req.body ?? {};
  const tenantId = String(b.tenant_id ?? '').trim();
  const contactId = String(b.contact_id ?? '').trim();
  const status = String(b.status ?? 'AUTHORISED').toUpperCase();
  if (!tenantId || !contactId) {
    return res.status(400).json({
      error: 'missing_field',
      message: 'tenant_id and contact_id are required. The contact must exist in Xero before the bill is posted against it.',
    });
  }
  if (!PUBLISH_STATUSES.has(status)) {
    return res.status(400).json({ error: 'invalid_status', message: 'status must be DRAFT, SUBMITTED or AUTHORISED.' });
  }

  const bill = getBillByIdAny(req.params.id);
  if (!bill) return res.status(404).json({ error: 'bill_not_found' });

  const organisation = listOrganisations(WORKSPACE_ID).find((o) => dataScopeForOrg(o.id) === bill.orgId);
  if (!organisation) {
    return res.status(404).json({ error: 'organisation_not_found', message: 'This document belongs to no linked entity.' });
  }
  // The caller names the ledger it believes it is posting into, and we check it
  // against the document's own. One key opens every client's book here, so
  // without this a mis-set tenant in a payment run would post one client's bill
  // into another client's accounts — and both sides would look fine.
  if (organisation.tenantId.trim().toLowerCase() !== tenantId.toLowerCase()) {
    return res.status(409).json({
      error: 'tenant_mismatch',
      message: `This document belongs to “${organisation.name}”, which isn’t the Xero organisation you named.`,
    });
  }

  // Already in the ledger: answer with what it is rather than refusing, so a
  // re-run of a half-finished payment run carries on from where it stopped.
  if (bill.xeroInvoiceId) {
    return res.json({
      ok: true,
      already_published: true,
      invoice: { invoiceId: bill.xeroInvoiceId, invoiceNumber: bill.invoiceNumber || '', status: bill.xeroStatus || '' },
      bill_id: bill.id,
    });
  }

  // The document is not payable at all — archived, on a claim, merged, or
  // marked paid. The listing already leaves those out, so reaching here means
  // the run is working from a stale list; say so rather than posting it.
  if (!payable(bill)) {
    return res.status(409).json({
      error: 'not_payable',
      message: `“${bill.supplier || 'This document'}” is no longer waiting to be paid — it has been archived, claimed, merged or marked paid since the list was read.`,
    });
  }

  const workspace = dataScopeForOrg(organisation.id);
  const posting = postingCodesFrom(
    bill,
    await accountsForOrg(WORKSPACE_ID, organisation.id),
    await taxRatesForOrg(WORKSPACE_ID, organisation.id)
  );
  if (!posting.ok) return res.status(422).json({ error: posting.error, message: posting.message });

  const out = await postBillToXero(req, organisation, workspace, bill, {
    accountCode: posting.accountCode,
    taxType: posting.taxType,
    status,
    dueDate: b.due_date,
    contactId,
  });
  return res.status(out.status).json(out.body);
});
