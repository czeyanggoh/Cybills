// The opening asset-and-accrual entry: a quotation's asset taken up against
// accrued expenses as a bill of 0.00. Driven over HTTP against a stub relay, so
// what is asserted is what actually reaches Xero — and what is refused before it.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-accrual-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-1', orgId: 'cybm', name: 'Demo Co', tenantId: 'tenant-1', tenantName: 'Demo Co', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

const seen: Array<{ method: string; path: string; body: any }> = [];
let billStatus = 'PAID';
let voidReply: { status: number; body: unknown } | null = null;
const stub = http.createServer((req, res) => {
  const path = decodeURIComponent(String(req.url)).split('?')[0].replace('/api/webhooks/xero-relay/', '');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: String(req.method), path, body });
    res.setHeader('content-type', 'application/json');
    if (path === 'Accounts') {
      return res.end(JSON.stringify({ Accounts: [
        { Code: '720', Name: 'Renovation', Status: 'ACTIVE', Type: 'FIXED' },
        { Code: '802', Name: 'Accrued Expenses', Status: 'ACTIVE', Type: 'CURRLIAB' },
        { Code: '800', Name: 'Trade Payables', Status: 'ACTIVE', Type: 'CURRLIAB', SystemAccount: 'CREDITORS' },
        { Code: '429', Name: 'General Expenses', Status: 'ACTIVE', Type: 'EXPENSE' },
      ] }));
    }
    if (path === 'Organisation') return res.end(JSON.stringify({ Organisations: [{ Name: 'Demo Co', BaseCurrency: 'SGD' }] }));
    if (path === 'Invoices' && req.method === 'PUT') {
      return res.end(JSON.stringify({ Invoices: [{ InvoiceID: 'zero-1', Status: 'PAID', HasErrors: false }] }));
    }
    if (path === 'Invoices/zero-1' && req.method === 'GET') return res.end(JSON.stringify({ Invoices: [{ InvoiceID: 'zero-1', Status: billStatus }] }));
    if (path === 'Invoices/zero-1' && req.method === 'POST') {
      if (voidReply) { res.statusCode = voidReply.status; return res.end(JSON.stringify(voidReply.body)); }
      return res.end(JSON.stringify({ Invoices: [{ InvoiceID: 'zero-1', Status: 'VOIDED' }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', path }));
  });
});
await new Promise<void>((r) => stub.listen(4741, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4741';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');
const { insertBill, getBillById } = await import('../src/store.ts');
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
const server = app.listen(4742, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const post = async (route: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:4742/api/xero/organisations/org-1/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
};
const sentBills = () => seen.filter((s) => s.path === 'Invoices' && s.method === 'PUT');
const quote = insertBill({
  orgId: 'cybm', kind: 'cost', status: 'new', supplier: 'Reno Works Pte Ltd', invoiceNumber: 'Q-7',
  documentType: 'Other', currency: 'SGD', date: '2026-09-19', category: '', description: 'Renovation', total: '10900', tax: '900',
} as never);
const ask = (over: Record<string, unknown> = {}) => ({
  billId: quote.id, date: '2026-09-20', accrualAccountCode: '802',
  lines: [{ accountCode: '720', description: 'Carpentry', amount: '6,000.00' }, { accountCode: '720', description: 'Painting', amount: 4000 }],
  ...over,
});

// --- refused before anything reaches Xero ---------------------------------------
let r = await post('record-accrual', ask({ lines: [{ accountCode: '429', amount: 100 }] }));
check('an expense account is not an asset', [r.status, r.body.error], [422, 'not_an_asset']);
r = await post('record-accrual', ask({ accrualAccountCode: '800' }));
check('nor may it be accrued to a system account', [r.status, r.body.error], [422, 'not_a_liability']);
r = await post('record-accrual', ask({ lines: [{ accountCode: '720', amount: 20000 }] }));
check('no more than the quotation', [r.status, r.body.error], [400, 'amount_too_large']);
r = await post('record-accrual', ask({ lines: [{ accountCode: '720', amount: -5 }] }));
check('an asset line is above zero', [r.status, r.body.error], [400, 'no_amount']);
check('nothing was posted', sentBills().length, 0);

// --- recorded as a bill of 0.00 ---------------------------------------------------
r = await post('record-accrual', ask());
check('recorded', r.status, 200);
const sent = sentBills()[0]?.body?.Invoices?.[0];
check('an approved bill to the supplier', [sent?.Type, sent?.Status, sent?.Contact, sent?.Date], ['ACCPAY', 'AUTHORISED', { Name: 'Reno Works Pte Ltd' }, '2026-09-20']);
check('assets in, accrual out', sent?.LineItems?.map((l: any) => [l.AccountCode, l.UnitAmount, l.TaxType]), [['720', 6000, 'NONE'], ['720', 4000, 'NONE'], ['802', -10000, 'NONE']]);
check('adding up to nothing', sent?.LineItems?.reduce((s: number, l: any) => s + l.UnitAmount, 0), 0);
check('named apart from the quotation', sent?.InvoiceNumber, 'Q-7 accrual');
let doc = getBillById('cybm', quote.id)!;
check('kept on the document, which is not “published”', [doc.accrual?.invoiceId, doc.accrual?.amount, doc.xeroInvoiceId ?? ''], ['zero-1', 10000, '']);
r = await post('record-accrual', ask());
check('recording twice is refused', [r.status, r.body.error], [409, 'already_recorded']);
r = await post('publish-bill', { billId: quote.id, accountCode: '429', taxType: 'NONE', status: 'DRAFT' });
check('and it is not published as a bill too', [r.status, r.body.error], [409, 'accrual_recorded']);

// --- undone --------------------------------------------------------------------------
voidReply = { status: 400, body: { Message: 'Cannot void' } };
r = await post('undo-accrual', { billId: quote.id });
check('Xero refusing the void keeps the record', [r.status >= 400, Boolean(getBillById('cybm', quote.id)!.accrual)], [true, true]);
voidReply = null;
r = await post('undo-accrual', { billId: quote.id });
check('voided and forgotten', [r.status, getBillById('cybm', quote.id)!.accrual ?? null], [200, null]);
await post('record-accrual', ask());
billStatus = 'VOIDED';
const before = seen.filter((s) => s.method === 'POST').length;
r = await post('undo-accrual', { billId: quote.id });
check('already voided in Xero: only forgotten', [r.status, seen.filter((s) => s.method === 'POST').length - before], [200, 0]);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, stub, server);
