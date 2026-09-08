// Bank match: settling a statement line against the document it pays.
//
// Two roads to one act. The BROWSER asks for the lines CYWorkspace's auto bank
// reconciliation left outstanding and a person matches one; the MACHINE — CYWS's
// run itself — asks what a line could pay and settles it. Both publish the
// document AUTHORISED if it is not yet in Xero and record a payment from the
// bank account on the statement date, so what is asserted here is the payment
// that actually goes to Xero: which bill, which account, which date, how much,
// and — for a foreign-currency document — that the rate carries the bank's
// figure onto the bill's.
//
// Driven over real HTTP against the real server, with one stub standing in for
// both the Xero relay and CYWS's outstanding-lines route (they are the same
// host). Mock mode (no Google sign-in configured), so the browser routes need no
// session; the machine routes' allowlist is proved by payables.test.mts.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-bank-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
process.env.WHATSAPP_INBOUND_KEY = 'cyws-key';
process.env.CYWORKSPACE_API_KEY = 'relay-key';
process.env.APP_ORIGIN = 'https://cybills.example.com';
process.env.PORT = '4654';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-1', orgId: 'cybm', name: 'Demo Co', tenantId: 'tenant-1', tenantName: 'Demo Co', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-2', orgId: 'cybm', name: 'Old CYWS Co', tenantId: 'tenant-2', tenantName: 'Old CYWS Co', createdAt: new Date(1000).toISOString(), createdBy: '' },
    ],
  })
);

// --- the lines CYWS hands back ------------------------------------------------
const L1 = { id: 0, date: '2026-08-20', amount: -109, reference: 'FAST A1 CONSULTANCY INV-9', description: 'A1 CONSULTANCY', status: 'no_match', reason: 'no_match', bank_account_id: 'acct-dbs', bank_account_name: 'DBS Current', bank_account_currency: 'SGD' };
const L2 = { id: 1, date: '2026-08-21', amount: -28.3, reference: 'GRABPAY* SINGAPORE', description: '', status: 'no_match', reason: 'no_match', bank_account_id: 'acct-dbs', bank_account_name: 'DBS Current', bank_account_currency: 'SGD' };
const L3 = { id: 2, date: '2026-08-22', amount: 500, reference: 'CUSTOMER PAYMENT', description: '', status: 'no_match', reason: 'no_match', bank_account_id: 'acct-dbs', bank_account_name: 'DBS Current', bank_account_currency: 'SGD' };
const L4 = { id: 3, date: '2026-08-23', amount: -75, reference: 'TRF SUPPLIES', description: '', status: 'below_min_confidence', reason: 'below_min_confidence', bank_account_id: 'acct-dbs', bank_account_name: 'DBS Current', bank_account_currency: 'SGD' };
// No bank account resolved, and no currency said — the entity's base fills it.
const L5 = { id: 4, date: '2026-08-25', amount: -22.2, reference: 'MICROSOFT', description: '', status: 'no_match', reason: 'no_bank_account', bank_account_id: '', bank_account_name: '' };

// --- stub: the Xero relay AND CYWS's outstanding route ------------------------
let invoicePosts: any[] = [];
let approvals: any[] = [];
let payments: any[] = [];
let deletedPayments: string[] = [];
const paidInvoices = new Set<string>();
let invoiceSeq = 0;
const stub = http.createServer((req, res) => {
  const url = new URL(String(req.url), 'http://x');
  const path = decodeURIComponent(url.pathname);
  res.setHeader('content-type', 'application/json');
  const body = (cb: (b: any) => void) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => cb(raw ? JSON.parse(raw) : {}));
  };
  if (path === '/api/webhooks/cybills/bank-recon/outstanding') {
    if (req.headers['x-api-key'] !== 'relay-key') { res.statusCode = 401; return res.end(JSON.stringify({ error: 'invalid_api_key' })); }
    if (url.searchParams.get('tenant_id') === 'tenant-2') {
      // An older CYWS: Express's bare 404, no JSON.
      res.statusCode = 404;
      res.setHeader('content-type', 'text/html');
      return res.end('Cannot GET /api/webhooks/cybills/bank-recon/outstanding');
    }
    return res.end(JSON.stringify({
      ok: true,
      tenant: { tenant_id: 'tenant-1', tenant_name: 'Demo Co' },
      retrieved_at: '2026-08-26T01:00:00.000Z',
      reports: [{ name: 'DBS Current.xlsx', retrieved_at: '2026-08-26T01:00:00.000Z' }],
      lines: [L1, L2, L3, L4, L5],
    }));
  }
  if (path.endsWith('/Accounts')) {
    return res.end(JSON.stringify({ Accounts: [
      { Code: '429', Name: 'General Expenses', Status: 'ACTIVE', Type: 'EXPENSE', TaxType: 'INPUTY24' },
      { Code: '493', Name: 'Travel - National', Status: 'ACTIVE', Type: 'EXPENSE', TaxType: 'NONE' },
      { Code: 'DBS', Name: 'DBS Current', Status: 'ACTIVE', Type: 'BANK', BankAccountNumber: '0720265734' },
    ] }));
  }
  if (path.endsWith('/TaxRates')) {
    return res.end(JSON.stringify({ TaxRates: [
      { Name: 'Standard-Rated Purchases', TaxType: 'INPUTY24', Status: 'ACTIVE', EffectiveRate: 9, CanApplyToExpenses: true },
      { Name: 'No Tax', TaxType: 'NONE', Status: 'ACTIVE', EffectiveRate: 0, CanApplyToExpenses: true },
    ] }));
  }
  if (path.endsWith('/Organisation')) return res.end(JSON.stringify({ Organisations: [{ Name: 'Demo Co', BaseCurrency: 'SGD', ShortCode: '!ab123' }] }));
  if (path.endsWith('/TrackingCategories')) return res.end(JSON.stringify({ TrackingCategories: [] }));
  if (path.endsWith('/Invoices') && req.method === 'PUT') {
    return body((b) => {
      const inv = b.Invoices?.[0];
      invoicePosts.push(inv);
      invoiceSeq += 1;
      res.end(JSON.stringify({ Invoices: [{
        InvoiceID: `inv-${invoiceSeq}`, InvoiceNumber: inv?.InvoiceNumber || `BILL-${invoiceSeq}`, Status: inv?.Status, HasErrors: false,
        AmountDue: inv?.LineItems?.[0]?.UnitAmount ?? 0, Total: 0, CurrencyCode: inv?.CurrencyCode || 'SGD',
        Contact: { ContactID: inv?.Contact?.ContactID || 'contact-new' }, LineItems: [],
      }] }));
    });
  }
  if (path.endsWith('/Invoices') && req.method === 'POST') {
    return body((b) => {
      const inv = b.Invoices?.[0];
      approvals.push(inv);
      res.end(JSON.stringify({ Invoices: [{ InvoiceID: inv?.InvoiceID, Status: inv?.Status, ValidationErrors: [] }] }));
    });
  }
  const one = /\/Invoices\/([^/]+)$/.exec(path);
  if (one && req.method === 'GET') {
    const id = one[1];
    const paid = paidInvoices.has(id);
    return res.end(JSON.stringify({ Invoices: [{
      InvoiceID: id, InvoiceNumber: 'BILL-X', Status: paid ? 'PAID' : 'AUTHORISED',
      FullyPaidOnDate: paid ? '2026-08-20T00:00:00' : undefined,
      Payments: paid ? [{ PaymentID: 'pay-x', Reference: payments.find((p) => p.Invoice?.InvoiceID === id)?.Reference || '' }] : [],
    }] }));
  }
  if (path.endsWith('/Payments') && req.method === 'PUT') {
    return body((b) => {
      const p = b.Payments?.[0];
      payments.push(p);
      paidInvoices.add(String(p?.Invoice?.InvoiceID));
      res.end(JSON.stringify({ Payments: [{ PaymentID: `pay-${payments.length}`, Status: 'AUTHORISED', HasValidationErrors: false, ValidationErrors: [] }] }));
    });
  }
  const del = /\/Payments\/([^/]+)$/.exec(path);
  if (del && req.method === 'POST') {
    return body(() => {
      deletedPayments.push(del[1]);
      const n = Number(del[1].replace('pay-', ''));
      const p = payments[n - 1];
      if (p) paidInvoices.delete(String(p.Invoice?.InvoiceID));
      res.end(JSON.stringify({ Payments: [{ PaymentID: del[1], Status: 'DELETED' }] }));
    });
  }
  if (path.includes('/Attachments/')) return res.end(JSON.stringify({ Attachments: [] }));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found', path }));
});
await new Promise<void>((r) => stub.listen(4655, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4655';

const { insertBill, getBillById } = await import('../src/store.ts');
const { dataScopeForOrg } = await import('../src/organisations.ts');
await import('../src/index.ts');
await new Promise((r) => setTimeout(r, 200));

const BASE = 'http://127.0.0.1:4654';
const ORG = { 'X-Org-Id': 'org-1', 'Content-Type': 'application/json' };
const KEY = { 'X-API-Key': 'cyws-key', 'Content-Type': 'application/json' };

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const call = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${BASE}${path}`, init);
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

const book1 = dataScopeForOrg('org-1');
const bill = (fields: Record<string, unknown>) =>
  insertBill({
    orgId: book1, kind: 'cost', status: 'ready', supplier: 'A1 Consultancy', invoiceNumber: 'INV-9',
    documentType: 'Invoice', currency: 'SGD', date: '2026-08-18', category: '429 - General Expenses',
    taxRate: 'Standard-Rated Purchases', description: 'Consulting', total: '109', tax: '9',
    ...fields,
  } as any);

// --- the book ------------------------------------------------------------------
const a1 = bill({});
const grab = bill({ supplier: 'Grab', invoiceNumber: '', category: '493 - Travel - National', taxRate: 'No Tax', total: '28.30', tax: '0', paid: true, documentType: 'Receipt', date: '2026-08-21' });
const microsoft = bill({ supplier: 'Microsoft Regional Sales', invoiceNumber: 'E0400ABC', currency: 'USD', total: '17.17', tax: '1.42', baseCurrency: 'SGD', baseTotal: 22.2, baseTax: 1.84, exchangeRate: 1.293, date: '2026-08-24' });
// Published by the automatic publish-after-reading, so it sits SUBMITTED in an
// approval queue: Xero refuses a payment against it until it is approved.
const queued = bill({ supplier: 'Supplies Co', invoiceNumber: 'S-75', total: '75', tax: '0', taxRate: 'No Tax', date: '2026-08-22', status: 'archived', xeroInvoiceId: 'inv-old', xeroDocType: 'ACCPAY', xeroTenantId: 'tenant-1', xeroStatus: 'SUBMITTED' });
// None of these can be paid by a bank line.
bill({ supplier: 'Paid In Xero', status: 'archived', xeroInvoiceId: 'inv-paid', xeroStatus: 'PAID' });
bill({ supplier: 'On A Claim', status: 'expenseclaim' });
bill({ supplier: 'Merged Away', status: 'merged' });
bill({ supplier: 'A Sales Invoice', kind: 'sales' });
bill({ supplier: 'Owes Us', documentType: 'Credit note/refund', total: '-530', tax: '0' });

// --- the outstanding lines ------------------------------------------------------
let r = await call('/api/bank/outstanding', { headers: ORG });
check('the lines CYWS left outstanding', [r.status, r.body.ok, r.body.lines.length], [200, true, 5]);
check('each carries a key', r.body.lines.every((l: any) => typeof l.key === 'string' && l.key.length > 0), true);
check('a line naming no currency takes the entity’s base', r.body.lines[4].currency, 'SGD');
check('the report is named', r.body.reports.map((x: any) => x.name), ['DBS Current.xlsx']);
const lines: any[] = r.body.lines;
const [l1, l2, l3, l4, l5] = lines;

r = await call('/api/bank/outstanding', { headers: { 'X-Org-Id': 'org-2' } });
check('an older CYWS with no such route is said to need updating, not to have failed', [r.status, r.body.ok, r.body.error], [200, false, 'route_missing']);

// --- a person matching a line ----------------------------------------------------
const match = (billId: string, line: any, extra: Record<string, unknown> = {}) =>
  call('/api/bank/match', { method: 'POST', headers: ORG, body: JSON.stringify({ billId, line, ...extra }) });

r = await match(a1.id, l1);
check('a ready document is published and paid', [r.status, r.body.ok], [200, true]);
check('published AUTHORISED — a payment needs that, whatever the entity’s publish status', invoicePosts[0]?.Status, 'AUTHORISED');
check('and named by supplier, since nobody made a contact first', invoicePosts[0]?.Contact, { Name: 'A1 Consultancy' });
let p = payments[0];
check('the payment is against the bill just made', p?.Invoice, { InvoiceID: 'inv-1' });
check('from the bank account the line came from', p?.Account, { AccountID: 'acct-dbs' });
check('on the STATEMENT date, not the document’s', p?.Date, '2026-08-20');
check('for the document’s figure', p?.Amount, 109);
check('carrying the bank’s reference', p?.Reference, 'FAST A1 CONSULTANCY INV-9');
check('same currency: no rate sent', 'CurrencyRate' in (p ?? {}), false);
let stored = getBillById(book1, a1.id)!;
check('the document records the bill and what Xero says of it', [stored.xeroInvoiceId, stored.xeroStatus, stored.xeroPaidDate], ['inv-1', 'PAID', '2026-08-20']);
check('its own Paid toggle is on, from that account', [stored.paid, stored.paymentMethod], [true, 'DBS Current']);
check('the match is recorded', [r.body.match.kind, r.body.match.billId, r.body.match.via, r.body.match.publishedHere], ['match', a1.id, 'browser', true]);
const a1Match = r.body.match;

r = await match(a1.id, l1);
check('the same line again is already settled', [r.status, r.body.already_settled], [200, true]);
check('and made no second payment', payments.length, 1);

r = await match(grab.id, l1);
check('another document against a settled line is refused', [r.status, r.body.error], [409, 'line_already_matched']);

r = await match(grab.id, l4);
check('a different figure is refused rather than part-paid', [r.status, r.body.error], [422, 'amount_mismatch']);
check('and nothing reached Xero', [invoicePosts.length, payments.length], [1, 1]);

r = await match(a1.id, l3);
check('money in is not a cost', [r.status, r.body.error], [422, 'money_in']);

r = await match(microsoft.id, l5);
check('no bank account resolved and none picked: refused', [r.status, r.body.error], [422, 'no_bank_account']);
check('and not published either', invoicePosts.length, 1);

r = await match(microsoft.id, { ...l5, bank_account_code: 'DBS' });
check('a foreign-currency document at its restated SGD figure', [r.status, r.body.ok], [200, true]);
p = payments[1];
check('paid from the account picked, by code', p?.Account, { Code: 'DBS' });
check('for the BILL’s own currency figure', p?.Amount, 17.17);
check('at a rate that carries the bank’s figure onto it (divide, get what the bank moved)', Math.round((17.17 / p?.CurrencyRate) * 100) / 100, 22.2);

r = await match(queued.id, l4);
check('a bill already in Xero is paid, not re-posted', [r.status, r.body.ok, invoicePosts.length], [200, true, 2]);
check('but approved first, because Xero refuses a payment against a SUBMITTED bill', approvals[0], { InvoiceID: 'inv-old', Status: 'AUTHORISED' });
check('the payment names the existing bill', payments[2]?.Invoice, { InvoiceID: 'inv-old' });
check('and the record says the publish was not this act’s', r.body.match.publishedHere, false);

// --- what the page now sees ---------------------------------------------------------
r = await call('/api/bank/outstanding', { headers: ORG });
check('the records ride with the lines', r.body.records.filter((x: any) => x.kind === 'match').length, 3);

// --- undo ------------------------------------------------------------------------
r = await call(`/api/bank/matches/${a1Match.id}/undo`, { method: 'POST', headers: ORG });
check('undo takes the payment off in Xero', [r.status, deletedPayments], [200, ['pay-1']]);
stored = getBillById(book1, a1.id)!;
check('the document is back to awaiting payment, still published', [stored.xeroInvoiceId, stored.xeroStatus, stored.xeroPaidDate], ['inv-1', 'AUTHORISED', '']);
check('and its Paid toggle back to what it was', [stored.paid, stored.paymentMethod], [false, '']);
r = await call('/api/bank/outstanding', { headers: ORG });
check('the match is forgotten', r.body.records.some((x: any) => x.id === a1Match.id), false);

// --- ignoring a line ---------------------------------------------------------------
r = await call('/api/bank/lines/dismiss', { method: 'POST', headers: ORG, body: JSON.stringify({ line: l3 }) });
check('a line that is not a cost is set aside', [r.status, r.body.record.kind, r.body.record.key], [200, 'dismissed', l3.key]);
const dismissed = r.body.record;
r = await call('/api/bank/outstanding', { headers: ORG });
check('and comes back marked so', r.body.records.find((x: any) => x.id === dismissed.id)?.kind, 'dismissed');
r = await call(`/api/bank/lines/${dismissed.id}/restore`, { method: 'POST', headers: ORG });
check('restore offers it again', r.status, 200);

// --- the machine road: CYWS asking what a line could pay ------------------------------
r = await call('/api/payments/bank-candidates?tenant_id=tenant-1');
check('candidates need the key', [r.status, r.body.error], [401, 'bad_key']);
r = await call('/api/payments/bank-candidates?tenant_id=tenant-1', { headers: KEY });
const names = (r.body.candidates ?? []).map((c: any) => c.supplier).sort();
check('what a statement line could pay: a receipt already marked paid included, settled and unpayable ones out', names, ['A1 Consultancy', 'Grab']);
const grabRow = r.body.candidates.find((c: any) => c.id === grab.id);
check('a paid receipt says so, with its posting codes', [grabRow.paid, grabRow.account_code, grabRow.tax_type, grabRow.postable], [true, '493', 'NONE', true]);
const a1Row = r.body.candidates.find((c: any) => c.id === a1.id);
check('a bill already in Xero says which', [a1Row.published, a1Row.xero_invoice_id, a1Row.xero_status], [true, 'inv-1', 'AUTHORISED']);
r = await call('/api/payments/bank-candidates?tenant_id=tenant-nobody', { headers: KEY });
check('a tenant CYBills has never heard of is an empty list', [r.status, r.body.candidates], [200, []]);

// --- and settling one -------------------------------------------------------------
const settle = (id: string, body: Record<string, unknown>) =>
  call(`/api/payments/bills/${id}/settle`, { method: 'POST', headers: KEY, body: JSON.stringify(body) });

r = await settle(grab.id, { tenant_id: 'tenant-2', line: L2 });
check('another client’s ledger is refused', [r.status, r.body.error], [409, 'tenant_mismatch']);
r = await settle(grab.id, { tenant_id: 'tenant-1' });
check('a settle with no line is refused', [r.status, r.body.error], [400, 'missing_field']);
// CYWS's own shape: signed_amount / payment_date, and the contact it made first.
r = await settle(grab.id, { tenant_id: 'tenant-1', contact_id: 'contact-9', line: { payment_date: L2.date, signed_amount: L2.amount, reference: L2.reference, bank_account_id: 'acct-dbs', bank_account_name: 'DBS Current', bank_account_currency: 'SGD' } });
check('CYWS settles a receipt: published and paid', [r.status, r.body.ok, r.body.match.via], [200, true, 'cyws']);
check('the bill names the contact CYWS made, by id', invoicePosts[2]?.Contact, { ContactID: 'contact-9' });
check('the payment is on the statement date for the receipt’s figure', [payments[3]?.Date, payments[3]?.Amount, payments[3]?.Account], ['2026-08-21', 28.3, { AccountID: 'acct-dbs' }]);
r = await settle(grab.id, { tenant_id: 'tenant-1', line: L2 });
check('the run re-pressed finds its settlement rather than paying twice', [r.status, r.body.already_settled, payments.length], [200, true, 4]);
r = await call('/api/payments/bank-candidates?tenant_id=tenant-1', { headers: KEY });
check('and the settled receipt is no longer a candidate', (r.body.candidates ?? []).map((c: any) => c.supplier), ['A1 Consultancy']);

stub.close();
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall bank-match checks passed');
process.exit(0);
