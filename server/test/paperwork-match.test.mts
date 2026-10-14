// Paperwork match: a receipt whose money Xero ALREADY holds (a Spend Money off
// the Amex feed, reconciled) is sent to that transaction — attached, and
// recoded to the document's coding — rather than published a second time.
// Driven over HTTP against a stub relay, so what is asserted is what reaches
// Xero.
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-test-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';
writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-1', orgId: 'cybm', name: 'Excellence A.S Pte Ltd', tenantId: 'tenant-1', tenantName: 'Excellence A.S Pte Ltd', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);
mkdirSync(join(DATA_DIR, 'files'), { recursive: true });
writeFileSync(join(DATA_DIR, 'files', 'lalamove.pdf'), Buffer.from('%PDF-1.4 a delivery receipt'));

// The Spend Money as Xero holds it: Freight & Courier, No Tax, outlet HQ.
const spendRecord = () => ({
  BankTransactionID: 'bt-1', Type: 'SPEND', Status: 'AUTHORISED', IsReconciled: true, HasAttachments: false,
  Contact: { ContactID: 'c-lala', Name: 'Lalamove' }, Date: '/Date(1758758400000+0000)/', DateString: '2026-09-25T00:00:00',
  Reference: 'AT262680002000010006526', CurrencyCode: 'SGD', LineAmountTypes: 'Exclusive', Total: 73.8,
  BankAccount: { AccountID: 'acc-amex', Code: '', Name: 'Amex' },
  LineItems: [{ LineItemID: 'li-1', Description: 'CKO*LALAMOVE 624784 SINGAPORE (1005)', Quantity: 1, UnitAmount: 73.8, AccountCode: '425', TaxType: 'NONE', TaxAmount: 0, LineAmount: 73.8, Tracking: [{ Name: 'Outlets', Option: 'HQ' }] }],
});
let recodeReply: any = null;
const seen: Array<{ method: string; path: string; query: string; body: any }> = [];
const stub = http.createServer((req, res) => {
  const [rawPath, query = ''] = String(req.url).split('?');
  const path = decodeURIComponent(rawPath).replace('/api/webhooks/xero-relay/', '');
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const body = path.includes('/Attachments/') ? raw.length : raw.length ? JSON.parse(raw.toString()) : null;
    seen.push({ method: String(req.method), path, query: decodeURIComponent(query), body });
    res.setHeader('content-type', 'application/json');
    if (path === 'Accounts') return res.end(JSON.stringify({ Accounts: [
      { Code: '425', Name: 'Freight & Courier', Status: 'ACTIVE', Type: 'EXPENSE', TaxType: 'NONE' },
    ] }));
    if (path === 'TaxRates') return res.end(JSON.stringify({ TaxRates: [
      { Name: 'No Tax', TaxType: 'NONE', Status: 'ACTIVE', EffectiveRate: 0 },
    ] }));
    if (path === 'TrackingCategories') return res.end(JSON.stringify({ TrackingCategories: [
      { Name: 'Outlets', Status: 'ACTIVE', Options: [{ Name: 'HQ', Status: 'ACTIVE' }, { Name: 'Tangs', Status: 'ACTIVE' }] },
    ] }));
    if (path === 'Organisation') return res.end(JSON.stringify({ Organisations: [{ BaseCurrency: 'SGD' }] }));
    if (path === 'Currencies') return res.end(JSON.stringify({ Currencies: [{ Code: 'SGD' }] }));
    if (path === 'BankTransactions' && req.method === 'GET') return res.end(JSON.stringify({ BankTransactions: [spendRecord()] }));
    if (path === 'Invoices' && req.method === 'GET') return res.end(JSON.stringify({ Invoices: [] }));
    if (path === 'BankTransactions/bt-1' && req.method === 'GET') return res.end(JSON.stringify({ BankTransactions: [spendRecord()] }));
    if (path === 'BankTransactions/bt-1' && req.method === 'POST') {
      if (recodeReply) return res.end(JSON.stringify(recodeReply));
      const sent = body.BankTransactions[0];
      return res.end(JSON.stringify({ BankTransactions: [{ ...spendRecord(), LineItems: sent.LineItems.map((l: any) => ({ ...l, LineAmount: l.UnitAmount })) }] }));
    }
    if (path.includes('/Attachments/')) return res.end(JSON.stringify({ Attachments: [{ AttachmentID: 'att-1' }] }));
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
const api = async (route: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:4742/api/xero/organisations/org-1/${route}`, body === undefined
    ? {}
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const receipt = (fields: Record<string, unknown> = {}) =>
  insertBill({
    orgId: 'cybm', kind: 'cost', status: 'ready', supplier: 'Lalamove', documentType: 'Receipt', currency: 'SGD',
    date: '2026-09-24', invoiceNumber: '3591407579064128444', category: '425 - Freight & Courier', taxRate: 'No Tax',
    project: 'Tangs', description: '* Van delivery from Jalan Kilang Timor to Tang Plaza', total: '73.80', tax: '0',
    fileName: 'lalamove.pdf', storageKey: 'local:lalamove.pdf', contentType: 'application/pdf', ...fields,
  } as any);

// 1) The match is found, and Xero is asked by amount rather than page by page.
const doc = receipt();
let r = await api('paperwork-matches');
check('listed', r.status, 200);
const cands = r.body.matches[doc.id] || [];
check('the Spend Money is the firm match', [cands.length, cands[0]?.confidence, cands[0]?.txn?.id, cands[0]?.txn?.kind], [1, 'firm', 'bt-1', 'spend']);
check('its lines come with names', cands[0]?.txn?.lines?.[0] && [cands[0].txn.lines[0].accountName, cands[0].txn.lines[0].taxName, cands[0].txn.lines[0].tracking], ['Freight & Courier', 'No Tax', [{ category: 'Outlets', option: 'HQ' }]]);
check('the tracking categories, in order', r.body.trackingCategories, ['Outlets']);
const asked = seen.find((s) => s.path === 'BankTransactions' && s.method === 'GET')?.query || '';
check('Xero is asked for SPEND at the documents’ amounts', [asked.includes('Type=="SPEND"'), asked.includes('Total==73.80')], [true, true]);

// 2) Publishing beside it is what this exists to stop — once it is sent.
// 3) Sent, with a recode: the outlet moves to Tangs, the money does not.
seen.length = 0;
r = await api('paperwork-match', { billId: doc.id, kind: 'spend', transactionId: 'bt-1', recode: true });
check('sent', [r.status, r.body.ok], [200, true]);
const recoded = seen.find((s) => s.path === 'BankTransactions/bt-1' && s.method === 'POST')?.body?.BankTransactions?.[0];
check('the transaction is named by id', recoded?.BankTransactionID, 'bt-1');
check('its line is recoded to the document', recoded?.LineItems?.map((l: any) => [l.AccountCode, l.TaxType, l.Tracking]), [['425', 'NONE', [{ Name: 'Outlets', Option: 'Tangs' }]]]);
check('…for the same money', recoded?.LineItems?.map((l: any) => [l.UnitAmount, l.TaxAmount]), [[73.8, 0]]);
check('…keeping the bank narrative it was reconciled by', recoded?.LineItems?.[0]?.Description, 'CKO*LALAMOVE 624784 SINGAPORE (1005)');
check('the file is attached to the Spend Money', seen.some((s) => s.path === 'BankTransactions/bt-1/Attachments/lalamove.pdf' || /^BankTransactions\/bt-1\/Attachments\//.test(s.path)), true);
check('the reply says both', [r.body.attachment?.ok, r.body.recode?.ok], [true, true]);
let b = getBillById('cybm', doc.id)!;
check('the document records the link', [b.paperworkMatch?.id, b.paperworkMatch?.kind, b.paperworkMatch?.lines?.[0]?.tracking], ['bt-1', 'spend', [{ category: 'Outlets', option: 'Tangs' }]]);
check('…and is done: archived, paid from the Amex', [b.status, b.paid, b.paymentMethod], ['archived', true, 'Amex']);
check('nothing was published', seen.some((s) => s.path === 'Invoices' && s.method === 'PUT'), false);

r = await api('publish-bill', { billId: doc.id, accountCode: '425', taxType: 'NONE', status: 'AUTHORISED' });
check('publishing it is refused', [r.status, r.body.error], [409, 'paperwork_matched']);
r = await api('paperwork-match', { billId: doc.id, kind: 'spend', transactionId: 'bt-1', recode: false });
check('sending twice is refused', [r.status, r.body.error], [409, 'already_linked']);

// 4) Another receipt cannot take a transaction already spoken for, and it is
//    no longer offered.
const twin = receipt({ date: '2026-09-23' });
r = await api('paperwork-match', { billId: twin.id, kind: 'spend', transactionId: 'bt-1', recode: false });
check('a transaction already sent to is taken', [r.status, r.body.error], [409, 'transaction_taken']);
r = await api('paperwork-matches?refresh=1');
check('…and no longer offered', (r.body.matches[twin.id] || []).length, 0);

// 5) Unlink: back to the list, nothing touched in Xero.
seen.length = 0;
r = await api('paperwork-unlink', { billId: doc.id });
check('unlinked', r.status, 200);
b = getBillById('cybm', doc.id)!;
check('the document is back as it was', [Boolean(b.paperworkMatch), b.status, b.paid, b.paymentMethod], [false, 'ready', false, '']);
check('nothing was written to Xero', seen.filter((s) => s.method !== 'GET').length, 0);

// 6) The money is held to the cent, whoever asks.
const other = receipt({ total: '70.00', date: '2026-09-24' });
r = await api('paperwork-match', { billId: other.id, kind: 'spend', transactionId: 'bt-1', recode: false });
check('a different amount is refused', [r.status, r.body.error], [422, 'amount_mismatch']);

// 7) Xero refusing the recode still sends the paper, and says why.
recodeReply = { BankTransactions: [{ BankTransactionID: 'bt-1', HasErrors: true, ValidationErrors: [{ Message: 'This Bank Transaction cannot be edited as it has been reconciled with a Bank Statement.' }] }] };
r = await api('paperwork-match', { billId: doc.id, kind: 'spend', transactionId: 'bt-1', recode: true });
check('sent even so', [r.status, r.body.attachment?.ok], [200, true]);
check('…with Xero’s own words for the recode', [r.body.recode?.ok, r.body.recode?.message], [false, 'This Bank Transaction cannot be edited as it has been reconciled with a Bank Statement.']);
b = getBillById('cybm', doc.id)!;
check('…and the lines kept as Xero has them, so the difference still shows', b.paperworkMatch?.lines?.[0]?.tracking, [{ category: 'Outlets', option: 'HQ' }]);
recodeReply = null;
r = await api('paperwork-recode', { billId: doc.id });
check('recoding again later', [r.status, r.body.recode?.ok, getBillById('cybm', doc.id)!.paperworkMatch?.lines?.[0]?.tracking], [200, true, [{ category: 'Outlets', option: 'Tangs' }]]);

server.close();
stub.close();
if (failures) {
  console.error(`${failures} paperwork-match check(s) failed`);
  process.exit(1);
}
