import { Router } from 'express';
import { keyMatches } from './inboundKey.js';
import { WORKSPACE_ID } from './workspace.js';
import {
  dataScopeForOrg,
  listOrganisations,
  publishTargetFor,
  type Organisation,
} from './organisations.js';
import { rechargeClaims } from './claims.js';
import {
  costComplete,
  displayIdOf,
  getBillByIdAny,
  isCreditNote,
  listBills,
  parseAmount,
  type Bill,
} from './store.js';
import { getBillFile } from './storage.js';
import { appOrigin, peopleForOrg, REPORTING_OFFICER } from './users.js';
import {
  accountsForOrg,
  postBillToXero,
  postingCodesFrom,
  taxRatesForOrg,
} from './xero.js';
import { isAdvanceDoc, loadPrepaymentRules, recordPrepayment } from './prepayment.js';
import { bankRules, cardFeeRules, readLine, recordsFor, repairStaleMatches, settleBillAgainstLine } from './bankMatch.js';

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

// Every entity whose claims REACH this Xero tenant — which is not the same
// question as `organisationsForTenant`, and the difference is the whole reason
// this exists. A BRIDGE entity has no tenant of its own: ST Engineering's staff
// claim against Red Alpha's ledger, so the entity holding their claims answers
// `tenantId === ''` and the payables rule above cannot see it. Claims are the
// one thing a bridge entity CAN put in Xero (`publishTargetFor` resolves the
// parent), so the recharge road has to ask where a claim would post, not where
// the entity is linked.
//
// Deliberately a second helper rather than widening the first: payables must
// keep the narrower rule. A bridge entity's COSTS are not payable through that
// road — they reach the ledger as lines of a claim's own bill — and a payment
// run that offered them would pay the same money twice.
// Is this entity linked to Xero in its own right? A bridge entity is not — it
// borrows its parent's ledger — and that is the one bit of the shape a caller
// cannot work out from a name.
const isLinkedItself = (o: Organisation): boolean => Boolean(o.tenantId.trim());

function organisationsPublishingTo(tenantId: string): Organisation[] {
  const wanted = tenantId.trim().toLowerCase();
  if (!wanted) return [];
  return listOrganisations(WORKSPACE_ID).filter((o) => {
    const target = publishTargetFor(WORKSPACE_ID, o);
    return Boolean(target) && target!.tenantId.trim().toLowerCase() === wanted;
  });
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
function payable(b: Bill, advance = false): boolean {
  if (b.kind !== 'cost') return false;
  if (!INBOX_STATUSES.has(String(b.status ?? ''))) return false;
  if (b.xeroInvoiceId) return false;
  if (b.paid) return false;
  // A credit note is money the supplier owes US. It is not a bill to pay, and
  // in a payment run it would read as one — a positive line for a refund.
  if (isCreditNote(b)) return false;
  // A QUOTATION or PRO-FORMA the supplier wants paid up front. It is paid like
  // any other line in the bank file, but it is never a bill: the run records it
  // as a prepayment (§ POST /bills/:id/prepay) and the tax invoice that follows
  // uses it up. No category is asked of it — nothing is posted to an account —
  // only what the overpayment needs: who, when, and how much.
  if (advance) {
    if (b.prepayment?.overpaymentId) return false;
    const supplier = String(b.supplier ?? '').trim();
    return Boolean(supplier) && supplier.toLowerCase() !== 'unknown supplier'
      && Boolean(String(b.date ?? '').trim()) && parseAmount(b.total) > 0;
  }
  return costComplete(b);
}

// Whether a document is a quotation / pro-forma, asked synchronously once the
// shared rules are loaded (src/lib/prepayment.js via prepayment.ts).
async function advanceTest(): Promise<(b: Bill) => boolean> {
  const r = await loadPrepaymentRules();
  return (b) => Boolean(r && r.isAdvanceDocument(b.documentType));
}

// One payable document, as CYWS needs it: enough to show the row, enough to
// build the payment line, and the link to the paper it must read the bank
// details off. Snake_case throughout, like the other CYWS-facing payloads.
function payableRow(
  req: any,
  organisation: Organisation,
  bill: Bill,
  posting: ReturnType<typeof postingCodesFrom>,
  advance = false
) {
  const itemId = displayIdOf(bill.id) || bill.id;
  return {
    id: bill.id,
    // 'bill' is published AUTHORISED at commit (§ publish); 'prepayment' is a
    // quotation / pro-forma paid in advance, recorded as a Xero overpayment
    // once the run's bank account and date are known (§ prepay). A
    // 'prepayment' row is never published — CYBills refuses it.
    kind: advance ? 'prepayment' : 'bill',
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
  const isAdvance = await advanceTest();
  for (const organisation of organisations) {
    const candidates = listBills(dataScopeForOrg(organisation.id)).filter((b) => payable(b, isAdvance(b)));
    if (!candidates.length) continue;
    const [accounts, rates] = await Promise.all([
      accountsForOrg(WORKSPACE_ID, organisation.id),
      taxRatesForOrg(WORKSPACE_ID, organisation.id),
    ]);
    for (const bill of candidates) {
      // A prepayment posts to no account and carries no tax code, so the chart
      // has nothing to refuse it for.
      const advance = isAdvance(bill);
      const posting = advance
        ? ({ ok: true, accountCode: '', taxType: '' } as ReturnType<typeof postingCodesFrom>)
        : postingCodesFrom(bill, accounts, rates);
      bills.push(payableRow(req, organisation, bill, posting, advance));
    }
  }

  res.json({
    ok: true,
    tenant_id: tenantId,
    organisations: organisations.map((o) => ({ id: o.id, name: o.name })),
    bills,
  });
});

// GET /api/payments/claims?tenant_id=<uuid> — the approved expense claims whose
// bills post into this Xero tenant, for the RECHARGE half.
//
// A bridge entity exists because the people claiming against a client's ledger
// do not work for that client: ST Engineering's staff claim against Red Alpha's
// book. Their claims post there as ACCPAY bills against a clearing account, and
// the practice then invoices the ST Engineering company that seconded them —
// which nets that account back off. CYWS runs that half (it holds the PO
// register that says who is seconded where, and it writes the sales invoice),
// and this is where it reads what is waiting to be recharged.
//
// Scoped by PUBLISH TARGET, not by the entity's own tenant link — see
// organisationsPublishingTo. Contract: deploy/RECHARGE.md.
paymentsRouter.get('/claims', async (req, res) => {
  if (unauthorised(req, res)) return;
  const tenantId = String(req.query.tenant_id ?? '').trim();
  if (!tenantId) {
    return res.status(400).json({ error: 'tenant_id_required', message: 'Name the Xero tenant to list claims for.' });
  }
  const organisations = organisationsPublishingTo(tenantId);
  if (!organisations.length) {
    // Not an error, for the same reason the payables listing says so: CYWS asks
    // about every tenant its user can see, and most are not CYBills clients.
    return res.json({ ok: true, tenant_id: tenantId, organisations: [], claims: [] });
  }

  const origin = appOrigin(req);
  const claims: Array<Record<string, unknown>> = [];
  for (const organisation of organisations) {
    // Two quite different things reach one tenant, and a caller that cannot
    // tell them apart will act on the wrong one. A BRIDGE entity holds the
    // claims of people seconded from somewhere else — those are the ones the
    // practice invoices on. The tenant's OWN entity holds its own staff's
    // claims, which are its own cost: they post to an ordinary expense account
    // rather than to a recharge clearing account, and billing them to the
    // seconding company would charge a client for somebody who never worked
    // for them. So the row says which it is rather than leaving the far end to
    // infer it from a name.
    const bridge = !isLinkedItself(organisation);
    for (const row of await rechargeClaims(dataScopeForOrg(organisation.id), origin)) {
      claims.push({
        ...row,
        org_id: organisation.id,
        org_name: organisation.name,
        bridge,
        // Carries ?org= because the app opens whichever entity that browser
        // last had, and a bridge entity's claim looked for in the parent is a
        // claim reported missing.
        url: `${origin}/expense-claims/${row.id}?org=${encodeURIComponent(organisation.id)}`,
      });
    }
  }

  res.json({
    ok: true,
    tenant_id: tenantId,
    organisations: organisations.map((o) => ({ id: o.id, name: o.name, bridge: !isLinkedItself(o) })),
    claims,
  });
});

// GET /api/payments/people?tenant_id=<uuid> — everybody in the entities whose
// claims post into this Xero tenant.
//
// The recharge half is organised by PO, and a PO names the PEOPLE it covers.
// Deriving that list from the claims already raised would be circular: nobody
// could be put on a PO until they had a claim, and no claim could be recharged
// until somebody was on a PO. So the roster is its own question, asked before
// there is a single claim to show.
//
// `peopleForOrg` deliberately reaches wider than the entity's own roster — a
// practice colleague working in a client's book is in it too. That is right
// here: they can raise a claim in the entity, so they must be assignable. The
// general account is not a person and is left out.
paymentsRouter.get('/people', (req, res) => {
  if (unauthorised(req, res)) return;
  const tenantId = String(req.query.tenant_id ?? '').trim();
  if (!tenantId) {
    return res.status(400).json({ error: 'tenant_id_required', message: 'Name the Xero tenant to list people for.' });
  }
  const organisations = organisationsPublishingTo(tenantId);
  // One row per ADDRESS, which is what a PO assignment matches on. Somebody who
  // works in two of these entities is one person to assign, not two.
  const seen = new Set<string>();
  const people: Array<Record<string, unknown>> = [];
  for (const organisation of organisations) {
    const bridge = !isLinkedItself(organisation);
    for (const p of peopleForOrg(WORKSPACE_ID, organisation.id)) {
      const key = p.email.trim().toLowerCase();
      if (!key || p.general || seen.has(key)) continue;
      seen.add(key);
      people.push({
        email: p.email,
        name: p.name,
        // A colleague from the practice rather than one of this entity's own
        // people — assignable, but worth telling apart in a list of 200.
        external: p.external,
        deactivated: p.deactivated,
        // The role they hold in this entity. A REPORTING OFFICER is somebody at
        // the seconding company who signs these claims off — the person a
        // recharge report is addressed to, not a person a PO covers — and the
        // flag beside it is that question answered, so the far end does not
        // compare role names of its own.
        role: p.role,
        reporting_officer: p.role === REPORTING_OFFICER,
        // Who their claims are routed to for approval, which is how a report's
        // recipient is suggested for the people on a PO.
        manager_email: p.managerEmail,
        manager_name: p.managerName,
        org_id: organisation.id,
        org_name: organisation.name,
        bridge,
      });
    }
  }
  people.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  res.json({
    ok: true,
    tenant_id: tenantId,
    organisations: organisations.map((o) => ({ id: o.id, name: o.name, bridge: !isLinkedItself(o) })),
    people,
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

  // A quotation is paid, not published: § prepay. Said before the payable
  // check so a caller working from an older listing learns which route it
  // wanted rather than that the document vanished.
  if (await isAdvanceDoc(bill)) {
    return res.status(409).json({
      error: 'prepayment_document',
      message: `“${bill.supplier || 'This document'}” is a quotation / pro-forma, not a tax invoice, so it is not published as a bill. It is recorded as a prepayment to the supplier when the payment is posted to Xero.`,
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

// POST /api/payments/bills/:id/prepay
// Body: { tenant_id, contact_id, bank_account_id, date, amount?, reference?,
//         bank_account_name? }
//
// A quotation or pro-forma paid in a payment run. It goes to Xero as a
// SPEND-OVERPAYMENT on the supplier's contact, from the bank account the run
// paid it out of, on the payment date — the same act as the document page's
// "Record prepayment in Xero" (prepayment.ts), so the tax invoice that follows
// uses it up on publish exactly as it would one recorded by hand. Called when
// the run is POSTED to Xero, not when it is committed: until then neither the
// bank account nor the date is known, and the overpayment IS the payment.
//
// `amount` below the total is a deposit on a larger quotation. `contact_id` is
// required for the reason publish requires it — the contact holding the bank
// details, never a second one Xero makes from a name.
//
// Idempotent: a quotation already recorded answers with the prepayment it has,
// so a re-pressed Post to Xero does not record the supplier's credit twice.
paymentsRouter.post('/bills/:id/prepay', async (req, res) => {
  if (unauthorised(req, res)) return;
  const b = req.body ?? {};
  const tenantId = String(b.tenant_id ?? '').trim();
  const contactId = String(b.contact_id ?? '').trim();
  const bankAccountId = String(b.bank_account_id ?? '').trim();
  if (!tenantId || !contactId || !bankAccountId) {
    return res.status(400).json({
      error: 'missing_field',
      message: 'tenant_id, contact_id and bank_account_id are required.',
    });
  }

  const bill = getBillByIdAny(req.params.id);
  if (!bill) return res.status(404).json({ error: 'bill_not_found' });
  const organisation = listOrganisations(WORKSPACE_ID).find((o) => dataScopeForOrg(o.id) === bill.orgId);
  if (!organisation) {
    return res.status(404).json({ error: 'organisation_not_found', message: 'This document belongs to no linked entity.' });
  }
  if (organisation.tenantId.trim().toLowerCase() !== tenantId.toLowerCase()) {
    return res.status(409).json({
      error: 'tenant_mismatch',
      message: `This document belongs to “${organisation.name}”, which isn’t the Xero organisation you named.`,
    });
  }
  if (!(await isAdvanceDoc(bill))) {
    return res.status(409).json({
      error: 'not_prepayment',
      message: `“${bill.supplier || 'This document'}” is not a quotation / pro-forma. Publish it as a bill instead.`,
    });
  }
  if (bill.prepayment?.overpaymentId) {
    return res.json({ ok: true, already_recorded: true, prepayment: bill.prepayment, bill_id: bill.id });
  }
  if (!payable(bill, true)) {
    return res.status(409).json({
      error: 'not_payable',
      message: `“${bill.supplier || 'This document'}” is no longer waiting to be paid — it has been archived, marked paid or published since the list was read.`,
    });
  }

  const out = await recordPrepayment(organisation, dataScopeForOrg(organisation.id), bill, {
    bankAccountId,
    bankAccountName: String(b.bank_account_name ?? ''),
    contactId,
    date: String(b.date ?? ''),
    amount: b.amount,
    reference: String(b.reference ?? ''),
    by: 'cyworkspace',
  });
  if (out.status !== 200) return res.status(out.status).json(out.body);
  return res.json({ ok: true, prepayment: out.body.prepayment, applied: out.body.applied, attachment: out.body.attachment ?? null, bill_id: bill.id });
});

// --- Bank match, the machine half ---------------------------------------------
// CYWS's auto bank reconciliation settles each unreconciled statement line
// against the Xero bill it pays, and for a line no Xero bill answers it looks
// past the ledger — to Dext's review pile, and now to the documents here. Two
// routes: what a statement line could pay, and the settle that publishes the
// document and applies the payment in one act (bankMatch.ts, which the Bank tab
// shares). Contract: deploy/BANK-MATCH.md.

// GET /api/payments/bank-candidates?tenant_id=<uuid> — every document in this
// Xero organisation's CYBills books that a statement line could pay.
//
// WIDER than /bills on purpose, and the difference is the whole point. The
// payables list leaves out a document marked PAID, because a receipt in a
// payment run pays the supplier a second time; here a receipt marked paid is
// exactly what a card line on the statement IS, so it is offered. A bill
// already published but still awaiting payment is offered too — publishing is
// not paying. What is still left out is what no bank line can pay: a credit
// note, a document on a claim or merged away, and one Xero already calls PAID.
paymentsRouter.get('/bank-candidates', async (req, res) => {
  if (unauthorised(req, res)) return;
  const tenantId = String(req.query.tenant_id ?? '').trim();
  if (!tenantId) {
    return res.status(400).json({ error: 'tenant_id_required', message: 'Name the Xero tenant to list candidates for.' });
  }
  const rules = await bankRules();
  if (!rules) return res.status(500).json({ error: 'rules_unavailable' });
  const organisations = organisationsForTenant(tenantId);
  if (!organisations.length) {
    return res.json({ ok: true, tenant_id: tenantId, organisations: [], candidates: [] });
  }
  const candidates: any[] = [];
  for (const organisation of organisations) {
    const ws = dataScopeForOrg(organisation.id);
    // The entity's card-fee rules (Bank match → Card fees), on every candidate
    // of its, so CYWS's own matcher can pair a line that is a document plus the
    // bank's fee — the same rule CYBills holds again when it settles.
    const cardFees = cardFeeRules(organisation)
      .map((r: any) => ({ bank_account: String(r?.bankAccount ?? '').trim(), percent: Number(String(r?.percent ?? '').replace(/[^0-9.]/g, '')), account: String(r?.accountCode ?? '').trim() }))
      .filter((r) => r.bank_account && r.percent > 0 && r.account)
      .map(({ bank_account, percent }) => ({ bank_account, percent }));
    // A stale match (its document no longer linked to the bill it paid) must not
    // keep that document out of the list, nor its line spent.
    repairStaleMatches(ws);
    const settled = new Set(recordsFor(ws).filter((r) => r.kind === 'match').map((r) => r.billId));
    const mine = listBills(ws).filter((b) => rules.matchable(b) && !settled.has(b.id));
    if (!mine.length) continue;
    const [accounts, rates] = await Promise.all([
      accountsForOrg(WORKSPACE_ID, organisation.id),
      taxRatesForOrg(WORKSPACE_ID, organisation.id),
    ]);
    for (const bill of mine) {
      const published = Boolean(bill.xeroInvoiceId);
      // A bill already in Xero needs no posting codes: it is paid, not posted.
      const posting = published ? null : postingCodesFrom(bill, accounts, rates);
      const row = payableRow(req, organisation, bill, posting ?? { ok: true, accountCode: '', taxType: '' });
      candidates.push({
        ...row,
        paid: Boolean(bill.paid),
        payment_method: bill.paymentMethod || '',
        published,
        xero_invoice_id: bill.xeroInvoiceId || '',
        xero_status: bill.xeroStatus || '',
        postable: published ? true : posting!.ok,
        blocked_reason: published ? '' : posting!.ok ? '' : posting!.message,
        card_fees: cardFees,
      });
    }
  }
  res.json({
    ok: true,
    tenant_id: tenantId,
    organisations: organisations.map((o) => ({ id: o.id, name: o.name })),
    candidates,
  });
});

// POST /api/payments/bills/:id/settle
// Body: { tenant_id, contact_id?, line: { date, amount, currency, reference,
//         description, bank_account_id, bank_account_name } }
//
// Publish the document AUTHORISED if it is not yet in Xero, then record the
// payment from that bank account, on the statement date, for the statement
// amount. `amount` is SIGNED as the report prints it — negative is money out —
// and must equal the document's figure to the cent in the bank's currency; a
// payment for a different figure is refused (422 amount_mismatch) rather than
// leaving a part-paid bill. `contact_id` is the payables road's own rule: the
// contact CYWS made first, carrying the payee's bank details, so the bill lands
// on it by ID. Idempotent on the LINE: a line already settled against this
// document answers 200 { already_settled: true }.
paymentsRouter.post('/bills/:id/settle', async (req, res) => {
  if (unauthorised(req, res)) return;
  const b = req.body ?? {};
  const tenantId = String(b.tenant_id ?? '').trim();
  const line = await readLine(b.line);
  if (!tenantId || !line) {
    return res.status(400).json({
      error: 'missing_field',
      message: 'tenant_id and a statement line (date, signed amount, reference, bank_account_id) are required.',
    });
  }
  const bill = getBillByIdAny(req.params.id);
  if (!bill) return res.status(404).json({ error: 'bill_not_found' });
  const organisation = listOrganisations(WORKSPACE_ID).find((o) => dataScopeForOrg(o.id) === bill.orgId);
  if (!organisation) {
    return res.status(404).json({ error: 'organisation_not_found', message: 'This document belongs to no linked entity.' });
  }
  if (organisation.tenantId.trim().toLowerCase() !== tenantId.toLowerCase()) {
    return res.status(409).json({
      error: 'tenant_mismatch',
      message: `This document belongs to “${organisation.name}”, which isn’t the Xero organisation you named.`,
    });
  }
  const out = await settleBillAgainstLine(req, organisation, dataScopeForOrg(organisation.id), bill, line, {
    via: 'cyws',
    by: 'cyworkspace',
    contactId: String(b.contact_id ?? '').trim() || undefined,
  });
  return res.status(out.status).json(out.body);
});
