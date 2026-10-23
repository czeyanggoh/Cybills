// Update in Xero on a PAID bill: take the payment off, update, put it back.
//
// Xero keeps a paid bill's lines largely as they are, so a tax code corrected
// after payment did not stick (Magicboo, 23 Oct 2026, done by hand in Xero, and
// the bank's reference was lost on the way). Asked to, the route does the same
// three steps — and the things pinned here are the ORDER (delete, update,
// record), that the payment goes back exactly as it was, that nothing is
// touched when a payment cannot come off, and that a failure half way puts the
// payment back rather than leaving a paid bill unpaid.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-repay-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management', tenantId: 't-cybm', tenantName: 'CYBM', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);
// A bank match that remembers the payment by id: it must follow the payment
// to its new id, or Undo would delete a payment that no longer exists.
writeFileSync(
  join(DATA_DIR, 'bank-lines.json'),
  JSON.stringify({ items: [{ id: 'bl-1', orgId: 'cybm', tenantId: 't-cybm', kind: 'match', key: 'k1', line: {}, billId: 'x', invoiceId: 'inv-paid', paymentId: 'pay-1', via: 'browser', at: '', by: '' }] })
);

const PAYMENT = {
  PaymentID: 'pay-1',
  Date: '/Date(1789516800000+0000)/',
  Amount: 1067.5,
  Reference: 'PAYNOW-FAST, GEBFT26090604403524',
  CurrencyRate: 1,
  Status: 'AUTHORISED',
  IsReconciled: false,
  Account: { AccountID: 'acc-uob', Code: '101', Name: 'UOB SGD' },
};

// A stub Xero holding one paid bill. `calls` is the order things were asked.
let calls: string[] = [];
let made: any[] = [];
let reconciled = false;
let refuseUpdate = '';
let paymentGone = false;
let lastUpdate: any = null;
const stub = http.createServer((req, res) => {
  const url = new URL(String(req.url), 'http://x');
  const path = decodeURIComponent(url.pathname);
  res.setHeader('content-type', 'application/json');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    if (path.endsWith('/Accounts')) return void res.end(JSON.stringify({ Accounts: [{ Code: '429', Name: 'General Expenses', Status: 'ACTIVE', Type: 'EXPENSE' }] }));
    if (path.endsWith('/TrackingCategories')) return void res.end(JSON.stringify({ TrackingCategories: [] }));
    if (path.endsWith('/Invoices/inv-paid') && req.method === 'GET') {
      return void res.end(JSON.stringify({ Invoices: [{
        InvoiceID: 'inv-paid', Status: paymentGone ? 'AUTHORISED' : 'PAID', Total: 1067.5,
        Payments: paymentGone ? [] : [{ PaymentID: 'pay-1', Amount: 1067.5 }],
        CreditNotes: [], Prepayments: [], Overpayments: [],
        LineItems: [{ LineItemID: 'li-1', Description: 'Spa materials', Quantity: 1, UnitAmount: 979.36, AccountCode: '429', TaxType: 'NONE', TaxAmount: 88.14 }],
      }] }));
    }
    if (path.endsWith('/Payments/pay-1') && req.method === 'GET') {
      return void res.end(JSON.stringify({ Payments: [{ ...PAYMENT, IsReconciled: reconciled }] }));
    }
    if (path.endsWith('/Payments/pay-1') && req.method === 'POST') {
      calls.push(`delete:${body?.Status}`);
      paymentGone = true;
      return void res.end(JSON.stringify({ Payments: [{ ...PAYMENT, Status: 'DELETED' }] }));
    }
    if (path.endsWith('/Payments') && req.method === 'PUT') {
      const p = body?.Payments?.[0] ?? {};
      calls.push('pay');
      made.push(p);
      paymentGone = false;
      return void res.end(JSON.stringify({ Payments: [{ ...p, PaymentID: `pay-new-${made.length}` }] }));
    }
    if (path.endsWith('/Invoices') && req.method === 'POST') {
      const sent = body?.Invoices?.[0] ?? {};
      calls.push(paymentGone ? 'update:unpaid' : 'update:paid');
      lastUpdate = sent;
      if (refuseUpdate) {
        return void res.end(JSON.stringify({ Invoices: [{ ...sent, HasErrors: true, ValidationErrors: [{ Message: refuseUpdate }] }] }));
      }
      return void res.end(JSON.stringify({ Invoices: [{ InvoiceID: 'inv-paid', InvoiceNumber: 'ORD23407', Status: 'AUTHORISED', HasErrors: false, LineItems: sent.LineItems }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', path }));
  });
});
await new Promise<void>((r) => stub.listen(4632, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4632';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');
const { insertBill, markBillPosted } = await import('../src/store.ts');
const { loadRecords } = await import('../src/bankMatch.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
const server = app.listen(4633, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const bill = insertBill({
  orgId: 'cybm', kind: 'cost', status: 'ready', supplier: 'Magicboo Beauty Megamart (S) Pte Ltd', invoiceNumber: 'ORD23407',
  documentType: 'Invoice', currency: 'SGD', date: '2026-09-16', category: '429 - General Expenses',
  taxRate: 'Standard-Rated Purchases', description: 'Spa materials', total: '1067.50', tax: '88.14',
} as any);
markBillPosted('cybm', bill.id, { xeroInvoiceId: 'inv-paid', xeroTenantId: 't-cybm', xeroTenantName: 'CYBM' });

const update = async (extra: Record<string, unknown> = {}) => {
  calls = [];
  made = [];
  paymentGone = false;
  const res = await fetch('http://127.0.0.1:4633/api/xero/organisations/org-cybm/update-bill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ billId: bill.id, accountCode: '429', taxType: 'INPUTY24', ...extra }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// Not asked: the payment is left alone, as before.
let r = await update();
check('without repay the payment is not touched', calls, ['update:paid']);

// Asked: off, update, back on — in that order.
r = await update({ repay: true });
check('repay is accepted', r.status, 200);
check('...deleting, updating, then paying again, in that order', calls, ['delete:DELETED', 'update:unpaid', 'pay']);
check('...the update carries the chosen tax code', lastUpdate?.LineItems?.[0]?.TaxType, 'INPUTY24');
check('...from the same account', made[0]?.Account, { AccountID: 'acc-uob' });
check('...on the same date', made[0]?.Date, '2026-09-16');
check('...for the same amount', made[0]?.Amount, 1067.5);
check('...with the bank’s reference kept', made[0]?.Reference, 'PAYNOW-FAST, GEBFT26090604403524');
check('...against the same bill', made[0]?.Invoice, { InvoiceID: 'inv-paid' });
check('the reply says it was put back', r.body.repay?.ok, true);
check('...naming the new payment', r.body.repay?.payments?.[0]?.newPaymentId, 'pay-new-1');
check('a bank match follows the payment to its new id', loadRecords().find((x: any) => x.id === 'bl-1')?.paymentId, 'pay-new-1');

// A reconciled payment cannot come off from here: refused before anything moves.
reconciled = true;
r = await update({ repay: true });
check('a reconciled payment is refused', r.status, 409);
check('...as payment_reconciled', r.body.error, 'payment_reconciled');
check('...and nothing was deleted, updated or paid', calls, []);
reconciled = false;

// The update refused AFTER the payment came off: it goes back on.
refuseUpdate = 'Something Xero did not like.';
r = await update({ repay: true });
check('a refused update is reported', r.status, 422);
check('...after the payment was taken off and put back', calls, ['delete:DELETED', 'update:unpaid', 'pay']);
check('...and the reply says it was put back', r.body.repay?.ok, true);
refuseUpdate = '';

// An update that would make the bill worth less than was paid on it.
const smaller = await (async () => {
  const { updateBill } = await import('../src/store.ts');
  updateBill('cybm', bill.id, { total: '500.00', tax: '41.28' });
  const out = await update({ repay: true });
  updateBill('cybm', bill.id, { total: '1067.50', tax: '88.14' });
  return out;
})();
check('a bill made smaller than what was paid is refused', smaller.body.error, 'total_below_paid');
check('...before anything moves', calls, []);

console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
await finish(failures, server, stub);
