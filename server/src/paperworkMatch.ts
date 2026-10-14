import type { Bill, PaperworkLine, PaperworkMatch } from './store.js';
import { getBillById, listBills, listBillsAcrossScopes, setBillPaperworkMatch, updateBill } from './store.js';
import { claimsByXeroInvoiceId } from './claims.js';
import {
  accountsForOrg,
  attachBillFileTo,
  documentLineItemsFor,
  relay,
  taxRatesForOrg,
  trackingCategories,
  xeroDay,
} from './xero.js';

// Paperwork match — Dext's name for it. Xero ALREADY holds the money (a Spend
// Money coded straight off the card feed and reconciled, a bill somebody keyed
// in), and the receipt for it arrives here afterwards. Publishing the receipt
// would post the same spending a second time beside it, so instead the document
// is SENT to that transaction: its file is attached there, the transaction's
// lines are recoded to the document's coding (account, tax, both tracking
// categories) when asked, and the document is set aside as done.
//
// The pairing rules are not written here: they are the pure module the page
// reads too (src/lib/paperworkMatch.js, on top of bankMatch.js), loaded by path
// the way bankMatch.ts loads its own, so a match the page offers can never be
// refused for its money here and one it would never offer cannot be sent by
// asking the API directly.

type Txn = {
  kind: 'spend' | 'bill';
  id: string;
  date: string;
  total: number;
  currency: string;
  contact: string;
  reference: string;
  number: string;
  status: string;
  bankAccount: { name: string; code: string };
  reconciled: boolean;
  hasAttachments: boolean;
  lines: PaperworkLine[];
};

type Candidate = { txn: Txn; days: number; reasons: string[]; word: string; confidence: 'firm' | 'possible' };

type Rules = {
  paperworkEligible: (doc: unknown) => boolean;
  paperworkCandidatesFor: (doc: unknown, txns: Txn[], opts?: Record<string, unknown>) => Candidate[];
  paperworkMatches: (docs: unknown[], txns: Txn[], opts?: Record<string, unknown>) => Map<string, Candidate[]>;
  codingDifferences: (doc: unknown, txn: Txn, trackingNames?: string[]) => Array<{ key: string; label: string; document: string; xero: string }>;
  txnAsLine: (txn: Txn) => Record<string, unknown>;
};
type BankRules = { amountsAgree: (doc: unknown, line: unknown) => boolean };

let rules: Rules | null = null;
let bankRules: BankRules | null = null;
let tried = false;
async function loadRules(): Promise<{ rules: Rules; bank: BankRules } | null> {
  if (!tried) {
    tried = true;
    try {
      rules = (await import(new URL('../../src/lib/paperworkMatch.js', import.meta.url).href)) as Rules;
      bankRules = (await import(new URL('../../src/lib/bankMatch.js', import.meta.url).href)) as BankRules;
    } catch (e) {
      console.error('[paperwork] rules unavailable', e);
      rules = null;
    }
  }
  return rules && bankRules ? { rules, bank: bankRules } : null;
}

type Org = { id: string; tenantId: string; tenantName?: string; name?: string };
type Out = { status: number; body: any };

// --- what Xero holds, in one shape --------------------------------------------------

type Lookups = { accounts: Map<string, string>; taxes: Map<string, string> };

async function lookupsFor(ws: string, orgId: string): Promise<Lookups> {
  const [accounts, rates] = await Promise.all([accountsForOrg(ws, orgId), taxRatesForOrg(ws, orgId)]);
  return {
    accounts: new Map(accounts.map((a) => [a.code, a.name])),
    taxes: new Map(rates.map((r) => [r.code, r.name])),
  };
}

function linesOf(record: any, look: Lookups): PaperworkLine[] {
  return (Array.isArray(record?.LineItems) ? record.LineItems : []).map((l: any) => {
    const code = String(l?.AccountCode ?? '');
    const taxType = String(l?.TaxType ?? '');
    return {
      description: String(l?.Description ?? ''),
      accountCode: code,
      accountName: look.accounts.get(code) || '',
      taxType,
      taxName: look.taxes.get(taxType) || (taxType === 'NONE' ? 'No Tax' : ''),
      amount: Number(l?.LineAmount ?? 0) || 0,
      tax: Number(l?.TaxAmount ?? 0) || 0,
      tracking: (Array.isArray(l?.Tracking) ? l.Tracking : []).map((t: any) => ({
        category: String(t?.Name ?? ''),
        option: String(t?.Option ?? ''),
      })),
    };
  });
}

export function summariseXeroTxn(record: any, kind: 'spend' | 'bill', look: Lookups): Txn {
  return {
    kind,
    id: String(kind === 'spend' ? record?.BankTransactionID ?? '' : record?.InvoiceID ?? ''),
    date: xeroDay(record?.DateString ?? record?.Date),
    total: Number(record?.Total ?? 0) || 0,
    currency: String(record?.CurrencyCode ?? ''),
    contact: String(record?.Contact?.Name ?? ''),
    reference: String(record?.Reference ?? ''),
    number: kind === 'bill' ? String(record?.InvoiceNumber ?? '') : '',
    status: String(record?.Status ?? ''),
    bankAccount: { name: String(record?.BankAccount?.Name ?? ''), code: String(record?.BankAccount?.Code ?? '') },
    reconciled: Boolean(record?.IsReconciled),
    hasAttachments: Boolean(record?.HasAttachments),
    lines: linesOf(record, look),
  };
}

// --- finding them --------------------------------------------------------------------
//
// Xero cannot be asked "which of these forty receipts do you already have", so
// it is asked for the transactions at the documents' AMOUNTS over the dates they
// could have been paid on — Spend Money (Type SPEND) and payable bills — with
// the amounts in the where clause, so a book of thousands of transactions costs
// a handful of calls rather than a page per hundred. Held for five minutes per
// tenant and asked again only when the set of amounts or dates moves: the
// Costs list and the document page both read it, and Xero allows 60 calls a
// minute per tenant.

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; key: string; txns: Txn[] }>();
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const xeroDate = (d: string) => {
  const [y, m, day] = d.split('-');
  return `DateTime(${y},${m},${day})`;
};

function amountsFor(doc: Bill): number[] {
  const out = new Set<number>();
  for (const v of [doc.total, (doc as any).baseTotal]) {
    const n = Math.abs(Number(String(v ?? '').replace(/[^0-9.-]/g, '')));
    if (n > 0) out.add(Math.round(n * 100));
  }
  return [...out];
}

async function pages(path: string, tenantId: string, query: Record<string, string>, key: string): Promise<any[] | null> {
  const out: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await relay(path, { tenantId, query: { ...query, page: String(page) } });
    if (!res.ok) {
      console.error('[paperwork] Xero lookup failed', path, res.status, res.message);
      return out.length ? out : null;
    }
    const rows = Array.isArray(res.data?.[key]) ? res.data[key] : [];
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

export async function xeroTransactionsFor(
  organisation: Org,
  ws: string,
  docs: Bill[],
  refresh = false,
  // A one-document question (the automatic publish) neither reads nor writes
  // the list's cache: its narrower answer would evict the whole list's.
  cacheable = true
): Promise<{ txns: Txn[]; error: string }> {
  const dated = docs.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d.date ?? '')));
  if (!dated.length) return { txns: [], error: '' };
  const times = dated.map((d) => Date.parse(`${d.date}T00:00:00Z`));
  const from = iso(Math.min(...times) - 5 * DAY);
  const to = iso(Math.min(Date.now() + DAY, Math.max(...times) + 90 * DAY));
  const cents = [...new Set(dated.flatMap(amountsFor))].sort((a, b) => a - b);
  if (!cents.length) return { txns: [], error: '' };
  const key = `${from}|${to}|${cents.join(',')}`;
  const hit = cache.get(organisation.tenantId);
  if (cacheable && !refresh && hit && hit.key === key && Date.now() - hit.at < TTL_MS) return { txns: hit.txns, error: '' };

  const look = await lookupsFor(ws, organisation.id);
  const range = `Date>=${xeroDate(from)} AND Date<=${xeroDate(to)}`;
  const txns: Txn[] = [];
  let failed = false;
  for (let i = 0; i < cents.length; i += 25) {
    const totals = cents.slice(i, i + 25).map((c) => `Total==${(c / 100).toFixed(2)}`).join(' OR ');
    const spend = await pages('BankTransactions', organisation.tenantId, {
      where: `Type=="SPEND" AND Status=="AUTHORISED" AND ${range} AND (${totals})`,
    }, 'BankTransactions');
    const bills = await pages('Invoices', organisation.tenantId, {
      where: `Type=="ACCPAY" AND ${range} AND (${totals})`,
      Statuses: 'DRAFT,SUBMITTED,AUTHORISED,PAID',
    }, 'Invoices');
    if (!spend || !bills) failed = true;
    for (const r of spend || []) txns.push(summariseXeroTxn(r, 'spend', look));
    for (const r of bills || []) txns.push(summariseXeroTxn(r, 'bill', look));
  }
  if (!failed && cacheable) cache.set(organisation.tenantId, { at: Date.now(), key, txns });
  return { txns, error: failed ? 'Xero could not be asked for its transactions just now.' : '' };
}

// The Xero records CYBills itself put there — a bill it published, a claim's
// bill — are not paperwork waiting for a receipt: a receipt matching one of
// those is a DUPLICATE, which the duplicate check is for. Nor is a transaction
// another document has already been sent to.
function ownXeroIds(): Set<string> {
  const ids = new Set<string>();
  for (const b of listBillsAcrossScopes()) {
    if (b.xeroInvoiceId) ids.add(String(b.xeroInvoiceId).toLowerCase());
    if (b.paperworkMatch?.id) ids.add(String(b.paperworkMatch.id).toLowerCase());
    if (b.prepayment?.bankTransactionId) ids.add(String(b.prepayment.bankTransactionId).toLowerCase());
  }
  return ids;
}

function notOurs(txns: Txn[]): Txn[] {
  const own = ownXeroIds();
  return txns.filter((t) => {
    const id = t.id.toLowerCase();
    if (!id || own.has(id)) return false;
    if (t.kind === 'bill' && claimsByXeroInvoiceId(t.id).length) return false;
    return true;
  });
}

/**
 * Every eligible document's candidates, for the Costs list and the document
 * page. `visible` narrows the book to what the caller may see.
 */
export async function paperworkMatchesFor(
  organisation: Org,
  ws: string,
  opts: { visible: (b: Bill) => boolean; ownNames: string[]; refresh?: boolean }
): Promise<Out> {
  const loaded = await loadRules();
  if (!loaded) return { status: 503, body: { error: 'rules_unavailable', message: 'Paperwork match is unavailable on this server.' } };
  const docs = listBills(ws).filter((b) => opts.visible(b) && loaded.rules.paperworkEligible(b));
  // The most recent few hundred: a migration's backlog is not worth asking
  // Xero about every five minutes, and nothing older than that is still in
  // somebody's working list for a reason this would fix.
  const recent = docs.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''))).slice(0, 400);
  const [{ txns, error }, cats] = await Promise.all([
    xeroTransactionsFor(organisation, ws, recent, Boolean(opts.refresh)),
    trackingCategories(organisation.tenantId),
  ]);
  const map = loaded.rules.paperworkMatches(recent, notOurs(txns), { ownNames: opts.ownNames });
  const matches: Record<string, Candidate[]> = {};
  for (const [id, cands] of map) matches[id] = cands;
  return { status: 200, body: { ok: true, matches, trackingCategories: cats.map((c) => c.name), error, checkedAt: new Date().toISOString() } };
}

// --- before an UNATTENDED publish ------------------------------------------------------
//
// The automatic publish-after-reading (an upload whose supplier rule or entity
// switch says publish, an emailed / WhatsApp'd / Drive document whose rule
// does) posts with nobody looking, so it cannot rely on somebody noticing the
// "Already in Xero" badge first. It asks Xero this one question before it
// posts: is there a transaction this document is FIRMLY the paper for? If so
// it declines, and the document waits in the list wearing the badge, to be
// sent there instead. A failure to ask is a decline as well — an unattended
// publish that could not check is exactly the duplicate this exists to stop,
// and a document left in the list costs a click.
//
// Firm only, the same bar the list's badge and bulk publish use: a 'possible'
// (the money and the window, nothing naming it) is not a reason to hold up a
// supplier somebody has told CYBills to publish.
export async function xeroAlreadyHas(
  organisation: Org,
  ws: string,
  bill: Bill,
  ownNames: string[]
): Promise<{ ok: true; match: Candidate | null } | { ok: false; error: string }> {
  const loaded = await loadRules();
  if (!loaded) return { ok: false, error: 'Paperwork match is unavailable on this server.' };
  // Whether Xero has this money does not depend on where the document sits in
  // the list — it may still be settling out of Processing when its read
  // finishes — so it is asked of the document as a working one.
  const asWorking = { ...bill, status: 'ready' } as Bill;
  if (!loaded.rules.paperworkEligible(asWorking)) return { ok: true, match: null };
  const { txns, error } = await xeroTransactionsFor(organisation, ws, [asWorking], false, false);
  if (error) return { ok: false, error };
  const cands = loaded.rules.paperworkCandidatesFor(asWorking, notOurs(txns), { ownNames });
  return { ok: true, match: cands.find((c) => c.confidence === 'firm') ?? null };
}

// --- sending a document to one ---------------------------------------------------------

async function fetchTxn(organisation: Org, kind: 'spend' | 'bill', id: string): Promise<any | null> {
  const path = kind === 'spend' ? `BankTransactions/${encodeURIComponent(id)}` : `Invoices/${encodeURIComponent(id)}`;
  const res = await relay(path, { tenantId: organisation.tenantId });
  if (!res.ok) return null;
  return (kind === 'spend' ? res.data?.BankTransactions?.[0] : res.data?.Invoices?.[0]) ?? null;
}

const errorsOf = (record: any): string[] =>
  (record?.ValidationErrors ?? []).map((e: any) => String(e?.Message ?? e)).filter(Boolean);
const cents = (n: unknown) => Math.round(Number(n || 0) * 100);
const lineTotalCents = (lines: Array<Record<string, any>>, types: string) =>
  lines.reduce((sum, l) => {
    const net = cents((Number(l.UnitAmount) || 0) * (Number(l.Quantity) || 1));
    return sum + net + (types === 'Exclusive' ? cents(l.TaxAmount) : 0);
  }, 0);

/**
 * Rewrite the transaction's lines to the document's coding, keeping its total
 * to the cent. The lines are built by the publish path's own builder, so a
 * recode is exactly what publishing the document would have posted; the one
 * thing kept from Xero is a single line's DESCRIPTION — the card narrative a
 * bank feed wrote there is what the statement line is reconciled by.
 */
async function recode(req: any, organisation: Org, ws: string, bill: Bill, kind: 'spend' | 'bill', record: any, look: Lookups) {
  const at = new Date().toISOString();
  const before = linesOf(record, look);
  const built = await documentLineItemsFor(req, organisation, ws, bill);
  if (!built.ok) return { ok: false, at, message: built.message, before };
  const currency = String(record?.CurrencyCode ?? '');
  if (built.currency && currency && built.currency !== currency) {
    return { ok: false, at, before, message: `The document is in ${built.currency} and the Xero transaction in ${currency}, so its lines cannot simply be swapped in. Recode it in Xero.` };
  }
  const items = built.lineItems.map((l) => ({ ...l }));
  const xeroLines = Array.isArray(record?.LineItems) ? record.LineItems : [];
  if (items.length === 1 && xeroLines.length === 1 && xeroLines[0]?.Description) items[0].Description = xeroLines[0].Description;
  const want = cents(record?.Total);
  const got = lineTotalCents(items, built.lineAmountTypes);
  if (want !== got) {
    return { ok: false, at, before, message: `The document's coding adds up to ${(got / 100).toFixed(2)}, not the transaction's ${(want / 100).toFixed(2)}, so it was not sent — a recode must never change what the ledger says was spent.` };
  }
  const path = kind === 'spend' ? `BankTransactions/${encodeURIComponent(String(record.BankTransactionID))}` : `Invoices/${encodeURIComponent(String(record.InvoiceID))}`;
  const body = kind === 'spend'
    ? { BankTransactions: [{ BankTransactionID: record.BankTransactionID, LineAmountTypes: built.lineAmountTypes, LineItems: items }] }
    : { Invoices: [{ InvoiceID: record.InvoiceID, LineAmountTypes: built.lineAmountTypes, LineItems: items }] };
  const res = await relay(path, { method: 'POST', tenantId: organisation.tenantId, query: { summarizeErrors: 'false' }, body });
  const updated = res.ok ? (kind === 'spend' ? res.data?.BankTransactions?.[0] : res.data?.Invoices?.[0]) : null;
  const errors = errorsOf(updated);
  if (!res.ok || !updated || updated.HasErrors || errors.length) {
    return { ok: false, at, before, message: errors.length ? errors.join(' ') : res.ok ? 'Xero did not accept the new coding.' : (res as any).message };
  }
  // Never let a recode be the thing that moved the money.
  if (cents(updated.Total) !== want) {
    console.error('[paperwork] recode changed the total', record.Total, updated.Total);
  }
  return { ok: true, at, before, record: updated };
}

export async function sendToXeroTransaction(
  req: any,
  organisation: Org,
  ws: string,
  bill: Bill,
  opts: { kind: unknown; transactionId: unknown; recode: boolean; by: string; ownNames: string[] }
): Promise<Out> {
  const loaded = await loadRules();
  if (!loaded) return { status: 503, body: { error: 'rules_unavailable', message: 'Paperwork match is unavailable on this server.' } };
  const kind = opts.kind === 'bill' ? 'bill' : opts.kind === 'spend' ? 'spend' : null;
  const id = String(opts.transactionId ?? '').trim();
  if (!kind || !id) return { status: 400, body: { error: 'no_transaction', message: 'Name the Xero transaction to send this document to.' } };
  if (bill.paperworkMatch) return { status: 409, body: { error: 'already_linked', message: 'This document has already been sent to a Xero transaction.' } };
  if (bill.xeroInvoiceId) return { status: 409, body: { error: 'already_posted', message: 'This document is already published to Xero as a bill of its own.' } };
  if (!loaded.rules.paperworkEligible(bill)) {
    return { status: 409, body: { error: 'not_eligible', message: 'Only a receipt or invoice still in the Costs list can be sent to a Xero transaction — not one archived, on a claim, merged or still being read.' } };
  }
  if (ownXeroIds().has(id.toLowerCase()) || (kind === 'bill' && claimsByXeroInvoiceId(id).length)) {
    return { status: 409, body: { error: 'transaction_taken', message: 'That Xero transaction already has a document from CYBills behind it.' } };
  }
  const record = await fetchTxn(organisation, kind, id);
  if (!record) return { status: 404, body: { error: 'transaction_not_found', message: 'Xero no longer has that transaction.' } };
  if (['DELETED', 'VOIDED'].includes(String(record.Status ?? '').toUpperCase())) {
    return { status: 409, body: { error: 'transaction_void', message: `That transaction is ${String(record.Status).toLowerCase()} in Xero.` } };
  }
  const look = await lookupsFor(ws, organisation.id);
  const txn = summariseXeroTxn(record, kind, look);
  // Held to the same money the page offered it on, so nobody can send a
  // receipt to a transaction for a different amount by asking the API.
  if (!loaded.bank.amountsAgree(bill, loaded.rules.txnAsLine(txn))) {
    return { status: 422, body: { error: 'amount_mismatch', message: `The Xero transaction is ${txn.currency} ${txn.total.toFixed(2)}, which is not this document's money.` } };
  }

  // Recode first: a transaction Xero refuses to recode still gets its paper,
  // but the paper should go onto the lines that will stay.
  let recoded: Awaited<ReturnType<typeof recode>> | null = null;
  if (opts.recode) recoded = await recode(req, organisation, ws, bill, kind, record, look);
  const finalTxn = recoded?.ok && (recoded as any).record ? summariseXeroTxn((recoded as any).record, kind, look) : txn;

  const attachment = await attachBillFileTo(organisation.tenantId, kind === 'spend' ? 'BankTransactions' : 'Invoices', id, bill);

  const paidInXero = kind === 'spend' || String(record.Status ?? '').toUpperCase() === 'PAID';
  const match: PaperworkMatch = {
    kind,
    id,
    date: finalTxn.date,
    total: finalTxn.total,
    currency: finalTxn.currency,
    contact: finalTxn.contact,
    reference: finalTxn.reference,
    number: finalTxn.number,
    status: finalTxn.status,
    bankAccount: finalTxn.bankAccount,
    reconciled: finalTxn.reconciled,
    lines: finalTxn.lines,
    linkedAt: new Date().toISOString(),
    linkedBy: opts.by,
    attachment: attachment ? { ok: attachment.ok, ...(attachment.error ? { error: attachment.error } : {}) } : null,
    recode: recoded ? { ok: recoded.ok, at: recoded.at, ...(recoded.message ? { message: recoded.message } : {}), before: recoded.before } : null,
    before: { status: String(bill.status ?? ''), paid: Boolean(bill.paid), paymentMethod: String(bill.paymentMethod ?? '') },
  };
  setBillPaperworkMatch(ws, bill.id, match);
  // Done: its money is in the ledger. A Spend Money IS the payment, from that
  // account; a bill is paid only when Xero says so.
  const patch: Partial<Bill> = { status: 'archived' };
  if (paidInXero) {
    patch.paid = true;
    if (finalTxn.bankAccount.name) patch.paymentMethod = finalTxn.bankAccount.name;
  }
  updateBill(ws, bill.id, patch);
  cache.delete(organisation.tenantId);
  return { status: 200, body: { ok: true, match, attachment, recode: match.recode, bill: getBillById(ws, bill.id) } };
}

/**
 * Recode a transaction a document was ALREADY sent to — the coding was
 * corrected afterwards, or Xero refused the first time and the reason has since
 * been dealt with. The same recode the send makes, against the transaction as
 * Xero holds it now.
 */
export async function recodeLinked(req: any, organisation: Org, ws: string, bill: Bill): Promise<Out> {
  const m = bill.paperworkMatch;
  if (!m) return { status: 409, body: { error: 'not_linked', message: 'This document is not linked to a Xero transaction.' } };
  const record = await fetchTxn(organisation, m.kind, m.id);
  if (!record) return { status: 404, body: { error: 'transaction_not_found', message: 'Xero no longer has that transaction.' } };
  const look = await lookupsFor(ws, organisation.id);
  const done = await recode(req, organisation, ws, bill, m.kind, record, look);
  const now = done.ok && (done as any).record ? summariseXeroTxn((done as any).record, m.kind, look) : summariseXeroTxn(record, m.kind, look);
  const next: PaperworkMatch = {
    ...m,
    lines: now.lines,
    status: now.status,
    recode: { ok: done.ok, at: done.at, ...(done.message ? { message: done.message } : {}), before: done.before },
  };
  setBillPaperworkMatch(ws, bill.id, next);
  return { status: done.ok ? 200 : 422, body: { ok: done.ok, match: next, recode: next.recode, message: done.message, bill: getBillById(ws, bill.id) } };
}

/**
 * Forget the link. Nothing is undone in Xero — its API cannot remove an
 * attachment, and putting old coding back over a transaction somebody may have
 * since corrected is not this button's to decide — so the reply says so, and
 * the document goes back to where it was.
 */
export function unlinkXeroTransaction(organisation: Org, ws: string, bill: Bill): Out {
  const m = bill.paperworkMatch;
  if (!m) return { status: 409, body: { error: 'not_linked', message: 'This document is not linked to a Xero transaction.' } };
  setBillPaperworkMatch(ws, bill.id, null);
  const before = m.before;
  const patch: Partial<Bill> = { paid: before ? before.paid : false, paymentMethod: before ? before.paymentMethod : '' };
  if (bill.status === 'archived') patch.status = before?.status && before.status !== 'archived' ? before.status : 'new';
  updateBill(ws, bill.id, patch);
  cache.delete(organisation.tenantId);
  return { status: 200, body: { ok: true, bill: getBillById(ws, bill.id) } };
}
