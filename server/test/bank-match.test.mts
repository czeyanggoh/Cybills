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
// Each bill's lines as Xero holds them, so a card fee added by an update can be
// read back; and every such update.
const linesById = new Map<string, any[]>();
const invoiceUpdates: any[] = [];
const paidInvoices = new Set<string>();
let invoiceSeq = 0;
// What CYWS is told about spent lines, and a switch to make it unreachable.
const lineNotices: any[] = [];
let noticesDown = false;
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
  if (path === '/api/webhooks/cybills/bank-recon/used' && req.method === 'POST') {
    return body((b) => {
      if (noticesDown) { res.statusCode = 503; return res.end(JSON.stringify({ error: 'unavailable' })); }
      lineNotices.push({ ...b, tenant: url.searchParams.get('tenant_id'), apiKey: req.headers['x-api-key'] });
      res.end(JSON.stringify({ ok: true }));
    });
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
      linesById.set(`inv-${invoiceSeq}`, (inv?.LineItems ?? []).map((li: any, i: number) => ({ ...li, LineItemID: `inv-${invoiceSeq}-li-${i}` })));
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
      // An update that re-sends LineItems (the card fee) replaces the bill's lines.
      if (Array.isArray(inv?.LineItems)) {
        invoiceUpdates.push(inv);
        const id = String(inv.InvoiceID);
        linesById.set(id, inv.LineItems.map((li: any, i: number) => ({ ...li, LineItemID: li.LineItemID || `${id}-li-new-${i}` })));
        return res.end(JSON.stringify({ Invoices: [{ InvoiceID: inv.InvoiceID, Status: 'AUTHORISED', LineItems: linesById.get(id), ValidationErrors: [] }] }));
      }
      approvals.push(inv);
      res.end(JSON.stringify({ Invoices: [{ InvoiceID: inv?.InvoiceID, Status: inv?.Status, ValidationErrors: [] }] }));
    });
  }
  const one = /\/Invoices\/([^/]+)$/.exec(path);
  if (one && req.method === 'GET') {
    const id = one[1];
    const paid = paidInvoices.has(id);
    const storedLines = linesById.get(id) ?? [];
    const lineTotal = Math.round(storedLines.reduce((t: number, li: any) => t + (Number(li.UnitAmount) || 0) * (Number(li.Quantity) || 1) + (Number(li.TaxAmount) || 0), 0) * 100) / 100;
    return res.end(JSON.stringify({ Invoices: [{
      InvoiceID: id, InvoiceNumber: 'BILL-X', Status: paid ? 'PAID' : 'AUTHORISED',
      LineItems: storedLines, Total: lineTotal, AmountDue: paid ? 0 : lineTotal,
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

const { insertBill, getBillById, clearBillPosted } = await import('../src/store.ts');
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
const waitFor = async (ready: () => boolean) => {
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((r) => setTimeout(r, 20));
  return ready();
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
await waitFor(() => lineNotices.length >= 1);
const used1 = lineNotices[0];
check(
  'CYWS is told the line is spent, so its reconciliation never proposes it again',
  [used1?.action, used1?.tenant, used1?.apiKey, used1?.key, used1?.line?.reference, used1?.line?.amount, used1?.payment_id, used1?.invoice_id, used1?.supplier],
  ['used', 'tenant-1', 'relay-key', l1.key, 'FAST A1 CONSULTANCY INV-9', -109, 'pay-1', 'inv-1', 'A1 Consultancy']
);

r = await match(a1.id, l1);
check('the same line again is already settled', [r.status, r.body.already_settled], [200, true]);
check('and made no second payment', payments.length, 1);
check('nor a second notice', lineNotices.length, 1);

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
await waitFor(() => lineNotices.some((n) => n.action === 'released'));
check(
  'and CYWS is told the line is free again, after it was told it was spent',
  lineNotices.filter((n) => n.key === l1.key).map((n) => [n.action, n.payment_id]),
  [['used', 'pay-1'], ['released', 'pay-1']]
);

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
// CYWS's notice route is down for this one, so the notice has to wait.
noticesDown = true;
r = await settle(grab.id, { tenant_id: 'tenant-1', contact_id: 'contact-9', line: { payment_date: L2.date, signed_amount: L2.amount, reference: L2.reference, bank_account_id: 'acct-dbs', bank_account_name: 'DBS Current', bank_account_currency: 'SGD' } });
check('CYWS settles a receipt: published and paid', [r.status, r.body.ok, r.body.match.via], [200, true, 'cyws']);
check('the bill names the contact CYWS made, by id', invoicePosts[2]?.Contact, { ContactID: 'contact-9' });
check('the payment is on the statement date for the receipt’s figure', [payments[3]?.Date, payments[3]?.Amount, payments[3]?.Account], ['2026-08-21', 28.3, { AccountID: 'acct-dbs' }]);
r = await settle(grab.id, { tenant_id: 'tenant-1', line: L2 });
check('the run re-pressed finds its settlement rather than paying twice', [r.status, r.body.already_settled, payments.length], [200, true, 4]);
await new Promise((res) => setTimeout(res, 150));
const grabKey = l2.key;
check('a notice CYWS could not take is not lost…', lineNotices.some((n) => n.key === grabKey), false);
noticesDown = false;
await call('/api/bank/outstanding', { headers: ORG });
await waitFor(() => lineNotices.some((n) => n.key === grabKey));
check(
  '…it is delivered the next time anybody asks for lines',
  lineNotices.filter((n) => n.key === grabKey).map((n) => [n.action, n.via]),
  [['used', 'cyws']]
);
r = await call('/api/payments/bank-candidates?tenant_id=tenant-1', { headers: KEY });
check('and the settled receipt is no longer a candidate', (r.body.candidates ?? []).map((c: any) => c.supplier), ['A1 Consultancy']);

// --- Autofill payment: Dext's move, from the inbox -------------------------------
// The Match column names the line; Autofill keeps it on the document and turns
// Paid on; PUBLISH records the payment. Nothing reaches Xero at autofill time.
const L6 = { date: '2026-08-27', amount: -45.5, currency: 'SGD', reference: 'AUTOFILL CO', description: '', bank_account_id: 'acct-dbs', bank_account_name: 'DBS Current' };
const af = bill({ supplier: 'Autofill Co', invoiceNumber: 'AF-1', category: '493 - Travel - National', taxRate: 'No Tax', total: '45.50', tax: '0', date: '2026-08-26' });
const autofill = (billId: string, line: any) => call('/api/bank/autofill', { method: 'POST', headers: ORG, body: JSON.stringify({ billId, line }) });

const paymentsBefore = payments.length;
const postsBefore = invoicePosts.length;
r = await autofill(af.id, L6);
check('autofill keeps the line on the document without touching Xero', [r.status, r.body.settled, payments.length, invoicePosts.length], [200, false, paymentsBefore, postsBefore]);
stored = getBillById(book1, af.id)!;
check('Paid is on, from that account, and the line is pending', [stored.paid, stored.paymentMethod, stored.bankMatch?.date, stored.bankMatch?.amount], [true, 'DBS Current', '2026-08-27', -45.5]);
check('and it remembers what stood before', [stored.bankMatch?.paidBefore, stored.bankMatch?.paymentMethodBefore], [false, '']);

r = await autofill(a1.id, { ...L6, amount: -1 });
check('a line at a different figure is refused at autofill, not at publish', [r.status, r.body.error], [422, 'amount_mismatch']);

r = await call('/api/bank/autofill/clear', { method: 'POST', headers: ORG, body: JSON.stringify({ billId: af.id }) });
stored = getBillById(book1, af.id)!;
check('clear puts Paid and the payment method back', [r.status, stored.paid, stored.paymentMethod, stored.bankMatch], [200, false, '', undefined]);

await autofill(af.id, L6);
r = await call('/api/xero/organisations/org-1/publish-bill', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ billId: af.id, accountCode: '493', taxType: 'NONE', status: 'DRAFT' }),
});
check('publish goes through', [r.status, r.body.ok], [200, true]);
check('AUTHORISED whatever was asked — a payment needs it — and it says so', [invoicePosts[invoicePosts.length - 1]?.Status, r.body.statusForced], ['AUTHORISED', true]);
const lastPayment = payments[payments.length - 1];
check('the payment is recorded against the new bill, on the statement date, for the document’s figure', [lastPayment?.Invoice, lastPayment?.Date, lastPayment?.Amount, lastPayment?.Account], [{ InvoiceID: r.body.invoice.invoiceId }, '2026-08-27', 45.5, { AccountID: 'acct-dbs' }]);
check('and reported beside the publish', [r.body.bankPayment?.ok, r.body.bankPayment?.payment?.date], [true, '2026-08-27']);
stored = getBillById(book1, af.id)!;
check('the document is paid in Xero and the pending line is spent', [stored.xeroStatus, stored.bankMatch, stored.paid], ['PAID', undefined, true]);
r = await call('/api/bank/outstanding', { headers: ORG });
check('the settlement is on record, as the publish’s', r.body.records.some((x: any) => x.kind === 'match' && x.billId === af.id && x.publishedHere === true), true);
await waitFor(() => lineNotices.some((n) => n.line?.reference === 'AUTOFILL CO'));
check('and the publish tells CYWS the autofilled line is spent too', lineNotices.find((n) => n.line?.reference === 'AUTOFILL CO')?.action, 'used');

// --- a card fee the bank adds on top -------------------------------------------------
// UOB takes 1% on some debit-card spends in the same statement line: a Canva
// receipt of SGD 17.99 clears as 18.17. Last in the file, because a document
// matched and undone here goes back to being a candidate for the lists above.
{
  const { loadCollection, saveCollection } = await import('../src/jsonStore.ts');
  const { WORKSPACE_ID } = await import('../src/workspace.ts');
  const canva = bill({
    supplier: 'Canva Pty Ltd', invoiceNumber: '04983-44591559-1', documentType: 'Receipt', category: '429 - General Expenses',
    taxRate: 'Standard-Rated Purchases', total: '17.99', tax: '1.49', date: '2026-08-24',
  });
  const UOB = { date: '2026-08-26', amount: -18.17, currency: 'SGD', reference: 'Canva* 04983-44591559 Sydney', description: 'MISC DR - DEBIT CARD', bank_account_id: 'acct-uob', bank_account_name: 'UOB SGD' };

  r = await match(canva.id, UOB);
  check('without a card-fee rule, a line of 18.17 does not pay 17.99', [r.status, r.body.error], [422, 'amount_mismatch']);

  const settingKey = 'cybills.extraction-settings.v1::org-1';
  saveCollection('settings', [
    ...loadCollection<any>('settings').filter((s: any) => s.key !== settingKey),
    { workspaceId: WORKSPACE_ID, key: settingKey, value: { cardFeeRules: [{ bankAccount: 'UOB SGD', percent: '1', accountCode: '404 - Bank Fees' }] } },
  ]);

  r = await match(canva.id, UOB);
  check('with UOB’s 1% rule it settles', [r.status, r.body.ok], [200, true]);
  const feeUpdate = invoiceUpdates[invoiceUpdates.length - 1];
  const feeLine = (feeUpdate?.LineItems ?? []).find((li: any) => /card fee/i.test(String(li.Description)));
  check('the fee is added to the BILL as a line', [feeLine?.UnitAmount, feeLine?.AccountCode, feeLine?.TaxType], [0.18, '404', 'NONE']);
  check('beside the bill’s own lines, sent back with their ids so Xero keeps them', (feeUpdate?.LineItems ?? []).filter((li: any) => li.LineItemID).length >= 1, true);
  const feePay = payments[payments.length - 1];
  // ONE payment of the statement amount: the only shape Xero's reconciliation
  // suggests on its own for the 18.17 line.
  check('and ONE payment for the whole statement amount, from UOB, on the statement date', [feePay?.Amount, feePay?.Account, feePay?.Date], [18.17, { AccountID: 'acct-uob' }, '2026-08-26']);
  check('reported, and the fee line remembered on the match', [r.body.fee?.ok, r.body.fee?.amount, Boolean(r.body.match?.feeLineItemId)], [true, 0.18, true]);
  const canvaInvoice = r.body.match?.invoiceId;

  r = await call(`/api/bank/matches/${r.body.match.id}/undo`, { method: 'POST', headers: ORG });
  const afterUndo = invoiceUpdates[invoiceUpdates.length - 1];
  check('undo deletes the payment and takes the fee line back off the bill', [
    r.status,
    afterUndo?.InvoiceID === canvaInvoice,
    (afterUndo?.LineItems ?? []).some((li: any) => /card fee/i.test(String(li.Description))),
  ], [200, true, false]);

  r = await autofill(canva.id, UOB);
  check('autofill accepts the same fee match', [r.status, r.body.ok], [200, true]);

  // CYWS's matcher needs the rule too: every candidate of the entity carries it.
  r = await call('/api/payments/bank-candidates?tenant_id=tenant-1', { headers: KEY });
  check('bank-candidates carry the entity’s card-fee rules for CYWS', (r.body.candidates ?? [])[0]?.card_fees, [{ bank_account: 'UOB SGD', percent: 1 }]);

  // Settled, then the Xero link cleared (the bill was removed at the Xero end):
  // the match goes with it, and the line is free again — here and for CYWS.
  r = await match(canva.id, UOB);
  check('settled again', [r.status, r.body.ok], [200, true]);
  r = await call(`/api/costs/bills/${canva.id}/unpublish`, { method: 'POST', headers: ORG });
  check('the Xero link is cleared', r.status, 200);
  r = await call('/api/bank/outstanding', { headers: ORG });
  check('and the match on it is forgotten, so the line is outstanding again', r.body.records.some((x: any) => x.kind === 'match' && x.billId === canva.id), false);
  const freed = await waitFor(() => lineNotices.some((n) => n.action === 'released' && n.line?.reference === UOB.reference));
  check('and CYWS is told the line is free', freed, true);
}

// --- a stale match repairs itself -------------------------------------------------
// A document whose Xero link was cleared BEFORE clearing forgot its matches: the
// record outlived the bill, held the line as settled, and nothing could release
// it. Reading the lines releases it.
{
  const stale = bill({ supplier: 'Stale Co', invoiceNumber: 'ST-1', category: '493 - Travel - National', taxRate: 'No Tax', total: '33', tax: '0', date: '2026-08-27' });
  const STALE = { date: '2026-08-28', amount: -33, currency: 'SGD', reference: 'STALE CO ST-1', description: '', bank_account_id: 'acct-dbs', bank_account_name: 'DBS Current' };
  r = await match(stale.id, STALE);
  check('settled', [r.status, r.body.ok], [200, true]);
  // The old road: the link cleared in the store, with no bank-match cleanup.
  clearBillPosted(book1, stale.id);
  r = await call('/api/bank/outstanding', { headers: ORG });
  check('reading the lines releases the match whose bill is gone', r.body.records.some((x: any) => x.kind === 'match' && x.billId === stale.id), false);
  const staleDoc = getBillById(book1, stale.id)!;
  check('and puts the document’s Paid back, since the match was what set it', [staleDoc.paid, staleDoc.paymentMethod], [false, '']);
  const released = await waitFor(() => lineNotices.some((n) => n.action === 'released' && n.line?.reference === STALE.reference));
  check('and tells CYWS the line is free', released, true);
  r = await call('/api/bank/outstanding', { headers: ORG });
  check('the other matches stand', r.body.records.filter((x: any) => x.kind === 'match').length >= 1, true);
}

stub.close();
if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall bank-match checks passed');
process.exit(0);
