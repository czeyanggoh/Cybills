// A quotation paid in advance goes to Xero as an OVERPAYMENT to the supplier,
// never as a bill; the invoice that follows is published Approved and the
// overpayment is allocated against it. Driven over HTTP against a stub relay,
// so what is asserted is what actually reaches Xero.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-test-'));
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
let allocationReply: any = null;
const stub = http.createServer((req, res) => {
  const path = decodeURIComponent(String(req.url)).split('?')[0].replace('/api/webhooks/xero-relay/', '');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: String(req.method), path, body });
    res.setHeader('content-type', 'application/json');
    if (path === 'Accounts') return res.end(JSON.stringify({ Accounts: [{ Code: '429', Name: 'General Expenses', Status: 'ACTIVE', Type: 'EXPENSE' }] }));
    if (path === 'Organisation') return res.end(JSON.stringify({ Organisations: [{ Name: 'Demo Co', BaseCurrency: 'SGD' }] }));
    if (path === 'TrackingCategories') return res.end(JSON.stringify({ TrackingCategories: [] }));
    if (path === 'BankTransactions' && req.method === 'PUT') {
      const t = body.BankTransactions[0];
      return res.end(JSON.stringify({ BankTransactions: [{
        BankTransactionID: 'bt-1', OverpaymentID: 'op-1', Type: t.Type, CurrencyCode: t.CurrencyCode, Contact: { ContactID: 'c-windee' }, HasErrors: false,
      }] }));
    }
    if (path.startsWith('BankTransactions/') && req.method === 'POST') {
      return res.end(JSON.stringify({ BankTransactions: [{ BankTransactionID: 'bt-1', Status: 'DELETED' }] }));
    }
    if (path === 'Invoices' && req.method === 'PUT') {
      const inv = body.Invoices[0];
      return res.end(JSON.stringify({ Invoices: [{ InvoiceID: 'inv-1', InvoiceNumber: 'INV-1', Status: inv.Status, HasErrors: false, LineItems: [] }] }));
    }
    if (/^Overpayments\/[^/]+\/Allocations$/.test(path)) {
      if (allocationReply) { res.statusCode = allocationReply.status; return res.end(JSON.stringify(allocationReply.body)); }
      return res.end(JSON.stringify({ Allocations: [{ Amount: body.Allocations[0].Amount, Invoice: body.Allocations[0].Invoice }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', path }));
  });
});
await new Promise<void>((r) => stub.listen(4731, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4731';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');
const { insertBill, getBillById } = await import('../src/store.ts');
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
const server = app.listen(4732, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const post = async (route: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:4732/api/xero/organisations/org-1/${route}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const doc = (fields: Record<string, unknown>) =>
  insertBill({
    orgId: 'cybm', kind: 'cost', status: 'new', supplier: 'Windee Private Limited', invoiceNumber: 'QUO-2609239',
    documentType: 'Quotation', currency: 'SGD', date: '2026-09-19', category: '', description: 'Window works',
    total: '999', tax: '0', ...fields,
  } as any);

// 1) A quotation is never published as a bill.
const quote = doc({});
let r = await post('publish-bill', { billId: quote.id, accountCode: '429', taxType: 'NONE', status: 'DRAFT' });
check('publishing a quotation is refused', [r.status, r.body.error], [422, 'advance_document']);
check('…and nothing reached Xero', seen.filter((s) => s.path === 'Invoices').length, 0);

// 2) Recorded as an overpayment from the bank account it was paid out of.
r = await post('record-prepayment', { billId: quote.id, bankAccountCode: '090', bankAccountName: 'DBS Business (1234)', date: '2026-09-20' });
check('recorded', r.status, 200);
const sent = seen.find((s) => s.path === 'BankTransactions' && s.method === 'PUT')?.body?.BankTransactions?.[0];
check('as a SPEND-OVERPAYMENT', sent?.Type, 'SPEND-OVERPAYMENT');
check('to the supplier', sent?.Contact, { Name: 'Windee Private Limited' });
check('from the bank account', sent?.BankAccount, { Code: '090' });
check('on the date paid', sent?.Date, '2026-09-20');
check('carrying the quotation number', sent?.Reference, 'Quotation QUO-2609239');
check('for the amount, without tax', [sent?.LineAmountTypes, sent?.LineItems?.[0]?.LineAmount], ['NoTax', 999]);
let q = getBillById('cybm', quote.id)!;
check('the overpayment is kept', [q.prepayment?.overpaymentId, q.prepayment?.amount], ['op-1', 999]);
check('the quotation is Paid, from that account, and set aside', [q.paid, q.paymentMethod, q.status], [true, 'DBS Business (1234)', 'archived']);
r = await post('record-prepayment', { billId: quote.id, bankAccountCode: '090' });
check('recording twice is refused', [r.status, r.body.error], [409, 'already_recorded']);

// 3) Undo while unused, then record again.
r = await post('undo-prepayment', { billId: quote.id });
check('undone', r.status, 200);
q = getBillById('cybm', quote.id)!;
check('…the record is gone and the document is back', [Boolean(q.prepayment), q.status, q.paid], [false, 'new', false]);
r = await post('record-prepayment', { billId: quote.id, bankAccountCode: '090', date: '2026-09-20' });
check('recorded again', r.status, 200);

// 4) The invoice that follows: published Approved, the prepayment applied.
const invoice = doc({
  documentType: 'Invoice', invoiceNumber: 'INV-1', status: 'ready', total: '1200', tax: '99.08',
  date: '2026-10-05', category: '429 - General Expenses', description: 'Window works, as per QUO-2609239',
});
seen.length = 0;
r = await post('publish-bill', { billId: invoice.id, accountCode: '429', taxType: 'INPUTY24', status: 'DRAFT' });
check('the invoice publishes', r.status, 200);
const inv = seen.find((s) => s.path === 'Invoices')?.body?.Invoices?.[0];
check('…Approved, whatever was asked, and said so', [inv?.Status, r.body.statusForced], ['AUTHORISED', true]);
const alloc = seen.find((s) => s.path === 'Overpayments/op-1/Allocations')?.body?.Allocations?.[0];
check('the overpayment is allocated to the new bill', alloc?.Invoice, { InvoiceID: 'inv-1' });
check('…for the whole prepayment', alloc?.Amount, 999);
check('…dated the invoice', alloc?.Date, '2026-10-05');
check('the reply says so', [r.body.prepayment?.ok, r.body.prepayment?.amount, r.body.prepayment?.invoiceRemaining], [true, 999, 201]);
q = getBillById('cybm', quote.id)!;
const i = getBillById('cybm', invoice.id)!;
check('the quotation records where it went', q.prepayment?.allocations?.map((a) => [a.billId, a.amount, a.auto]), [[invoice.id, 999, true]]);
check('the invoice records what it used', i.prepaymentsApplied?.map((a) => [a.fromId, a.reference, a.amount]), [[quote.id, 'QUO-2609239', 999]]);
r = await post('undo-prepayment', { billId: quote.id });
check('a used prepayment cannot be undone', [r.status, r.body.error], [409, 'allocated']);

// 5) Nothing left: the next invoice from the supplier publishes as it was asked.
const next = doc({ documentType: 'Invoice', invoiceNumber: 'INV-2', status: 'ready', total: '50', date: '2026-11-01', category: '429 - General Expenses' });
seen.length = 0;
r = await post('publish-bill', { billId: next.id, accountCode: '429', taxType: 'INPUTY24', status: 'DRAFT' });
check('a used-up prepayment is not applied again',
  [seen.some((s) => s.path.startsWith('Overpayments/')), seen.find((s) => s.path === 'Invoices')?.body?.Invoices?.[0]?.Status],
  [false, 'DRAFT']);

// 6) A deposit on a larger pro-forma, applied by hand to an invoice already in Xero.
const q2 = doc({ supplier: 'Acme Glass', invoiceNumber: 'PF-7', documentType: 'Pro-forma invoice', total: '1000' });
r = await post('record-prepayment', { billId: q2.id, bankAccountCode: '090', amount: '300', date: '2026-09-01' });
check('a deposit of part of the total', [r.status, getBillById('cybm', q2.id)!.prepayment?.amount], [200, 300]);
check('described as a pro-forma',
  seen.filter((s) => s.path === 'BankTransactions').pop()?.body?.BankTransactions?.[0]?.Reference,
  'Pro-forma invoice PF-7');
r = await post('record-prepayment', {
  billId: doc({ supplier: 'Acme Glass', invoiceNumber: 'PF-8', documentType: 'Pro-forma invoice', total: '10' }).id,
  bankAccountCode: '090',
  amount: '20',
});
check('more than the total is refused', [r.status, r.body.error], [400, 'amount_too_large']);
const early = doc({ supplier: 'Acme Glass', documentType: 'Invoice', invoiceNumber: 'AG-1', status: 'archived', total: '1000', xeroInvoiceId: 'inv-early' });
r = await post('apply-prepayment', { billId: early.id, fromId: q2.id });
check('applied by hand', [r.status, r.body.amount, r.body.invoiceRemaining], [200, 300, 700]);
r = await post('apply-prepayment', { billId: early.id, fromId: q2.id });
check('not twice', [r.status, r.body.error], [409, 'already_applied']);
const unpublished = doc({ supplier: 'Acme Glass', documentType: 'Invoice', invoiceNumber: 'AG-2', total: '10' });
r = await post('apply-prepayment', { billId: unpublished.id, fromId: q2.id });
check('an unpublished invoice is refused', [r.status, r.body.error], [409, 'not_published']);

// 7) Xero refusing the allocation does not fail the publish.
const q3 = doc({ supplier: 'Zeta Works', invoiceNumber: 'Q-9', total: '100' });
await post('record-prepayment', { billId: q3.id, bankAccountCode: '090', date: '2026-09-01' });
allocationReply = { status: 200, body: { Allocations: [{ ValidationErrors: [{ Message: 'Allocation date is in a locked period.' }] }] } };
const zInv = doc({ supplier: 'Zeta Works', documentType: 'Invoice', invoiceNumber: 'Z-1', status: 'ready', total: '100', date: '2026-10-01', category: '429 - General Expenses' });
r = await post('publish-bill', { billId: zInv.id, accountCode: '429', taxType: 'INPUTY24', status: 'AUTHORISED' });
check('the bill still posts', r.status, 200);
check('…and the refusal is reported in Xero’s words', [r.body.prepayment?.ok, r.body.prepayment?.message], [false, 'Allocation date is in a locked period.']);
check('…with nothing recorded as used', getBillById('cybm', q3.id)!.prepayment?.allocations?.length, 0);
allocationReply = null;

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
server.close();
stub.close();
process.exit(failures ? 1 : 0);
