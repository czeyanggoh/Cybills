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
    // Excellence is a CLIENT entity, not the practice's primary one — so its
    // documents live in a book of their own ('org-1') while its organisation
    // record lives in the workspace ('cybm'). Production's shape: a test with
    // one entity had the two agree by accident and hid a recode that refused
    // itself for every client but CYBM.
    organisations: [
      { id: 'org-cybm', orgId: 'cybm', name: 'CY Business Management Pte. Ltd.', tenantId: 'tenant-cybm', tenantName: 'CY Business Management Pte. Ltd.', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-1', orgId: 'cybm', name: 'Excellence A.S Pte Ltd', tenantId: 'tenant-1', tenantName: 'Excellence A.S Pte Ltd', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);
mkdirSync(join(DATA_DIR, 'files'), { recursive: true });
writeFileSync(join(DATA_DIR, 'files', 'lalamove.pdf'), Buffer.from('%PDF-1.4 a delivery receipt'));

// The Spend Money as Xero holds it: Freight & Courier, No Tax, outlet HQ.
const spendRecord = () => ({
  BankTransactionID: 'bt-1', Type: 'SPEND', Status: 'AUTHORISED', IsReconciled: reconciled, HasAttachments: false,
  Contact: { ContactID: 'c-lala', Name: 'Lalamove' }, Date: '/Date(1758758400000+0000)/', DateString: '2026-09-25T00:00:00',
  Reference: 'AT262680002000010006526', CurrencyCode: 'SGD', LineAmountTypes: 'Inclusive', Total: 73.8,
  BankAccount: { AccountID: 'acc-amex', Code: '', Name: 'Amex' },
  LineItems: [{ LineItemID: 'li-1', Description: 'CKO*LALAMOVE 624784 SINGAPORE (1005)', Quantity: 1, UnitAmount: 73.8, AccountCode: '425', TaxType: 'NONE', TaxAmount: 0, LineAmount: 73.8, Tracking: [{ Name: 'Outlets', Option: 'HQ' }] }],
});
let recodeReply: any = null;
// Unreconciled until section 9: Xero refuses an app's edit to a reconciled one.
let reconciled = false;
let handEdit = false;
let lookupDown = false;
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
    if (path === 'BankTransactions' && req.method === 'GET') {
      if (lookupDown) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'xero_down', message: 'Xero is having a bad afternoon' })); }
      // Two more Lalamove runs on the Amex, for the automatic publish below.
      const more = (id: string, total: number, day: string) => ({ ...spendRecord(), BankTransactionID: id, Total: total, DateString: `${day}T00:00:00`, Date: '', LineItems: [{ ...spendRecord().LineItems[0], UnitAmount: total, LineAmount: total }] });
      return res.end(JSON.stringify({ BankTransactions: [spendRecord(), more('bt-2', 41.2, '2026-10-02'), more('bt-3', 55, '2026-10-05')] }));
    }
    if (path === 'Invoices' && req.method === 'PUT') {
      return res.end(JSON.stringify({ Invoices: [{ InvoiceID: 'inv-new', InvoiceNumber: 'X', Status: body.Invoices[0].Status, HasErrors: false, LineItems: [] }] }));
    }
    if (path === 'Invoices' && req.method === 'GET') return res.end(JSON.stringify({ Invoices: [] }));
    if (path === 'BankTransactions/bt-1' && req.method === 'GET') {
      const rec = spendRecord();
      if (handEdit) rec.LineItems = [{ ...rec.LineItems[0], Tracking: [{ Name: 'Outlets', Option: 'Tangs' }] }];
      return res.end(JSON.stringify({ BankTransactions: [rec] }));
    }
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
    orgId: 'org-1', kind: 'cost', status: 'ready', supplier: 'Lalamove', documentType: 'Receipt', currency: 'SGD',
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
let b = getBillById('org-1', doc.id)!;
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
b = getBillById('org-1', doc.id)!;
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
b = getBillById('org-1', doc.id)!;
check('…and the lines kept as Xero has them, so the difference still shows', b.paperworkMatch?.lines?.[0]?.tracking, [{ category: 'Outlets', option: 'HQ' }]);
recodeReply = null;
r = await api('paperwork-recode', { billId: doc.id });
check('recoding again later', [r.status, r.body.recode?.ok, getBillById('org-1', doc.id)!.paperworkMatch?.lines?.[0]?.tracking], [200, true, [{ category: 'Outlets', option: 'Tangs' }]]);

// 8) The automatic publish-after-reading, on both roads: Xero is asked first,
//    and a firm match is a decline, not a second copy.
const { publishByRule } = await import('../src/autoPublishRule.ts');
const { loadCollection, saveCollection } = await import('../src/jsonStore.ts');
const { WORKSPACE_ID } = await import('../src/workspace.ts');
type Setting = { workspaceId: string; key: string; value: unknown };
const rules = loadCollection<Setting>('settings').filter((x) => x.key !== 'cybills.supplier.rules.v1::org-1');
rules.push({ workspaceId: WORKSPACE_ID, key: 'cybills.supplier.rules.v1::org-1', value: { Lalamove: { autoPublish: 'AUTHORISED' } } });
saveCollection('settings', rules);
const putInvoices = () => seen.filter((x) => x.path === 'Invoices' && x.method === 'PUT').length;

// The browser's road (an upload): publish-bill, marked unattended.
const uploaded = receipt({ date: '2026-10-01', total: '41.20', invoiceNumber: 'UP-1', fileHash: 'uploaded' });
seen.length = 0;
r = await api('publish-bill', { billId: uploaded.id, accountCode: '425', taxType: 'NONE', status: 'SUBMITTED', unattended: true });
check('upload road: Xero already has it, so it is not published', [r.status, r.body.error, r.body.transaction?.id], [409, 'already_in_xero', 'bt-2']);
check('…nothing reached Xero', putInvoices(), 0);
check('…and the document waits in the list', getBillById('org-1', uploaded.id)!.status, 'ready');

// The server's road (emailed / WhatsApp'd / Drive): the supplier's rule.
const emailed = receipt({ date: '2026-10-04', total: '55.00', invoiceNumber: 'EM-1', fileHash: 'emailed' });
let outcome = await publishByRule({ headers: {} }, WORKSPACE_ID, 'org-1', 'org-1', emailed.id);
check('rule road: declined, and says why', outcome, { published: false, reason: 'already_in_xero' });
check('…nothing reached Xero', putInvoices(), 0);

// No such transaction in Xero: publishes as before.
const fresh = receipt({ date: '2026-06-02', total: '12.30', invoiceNumber: 'NEW-1', fileHash: 'fresh' });
r = await api('publish-bill', { billId: fresh.id, accountCode: '425', taxType: 'NONE', status: 'SUBMITTED', unattended: true });
check('nothing in Xero: it publishes', [r.status, putInvoices()], [200, 1]);

// Xero could not be asked: an unattended publish declines rather than risk it…
lookupDown = true;
const blind = receipt({ date: '2026-06-03', total: '14.50', invoiceNumber: 'NEW-2', fileHash: 'blind' });
r = await api('publish-bill', { billId: blind.id, accountCode: '425', taxType: 'NONE', status: 'SUBMITTED', unattended: true });
check('Xero unreachable: the automatic publish declines', [r.status, r.body.error, putInvoices()], [503, 'paperwork_check_failed', 1]);
// …while a person's publish is not held up by the check at all.
r = await api('publish-bill', { billId: blind.id, accountCode: '425', taxType: 'NONE', status: 'SUBMITTED' });
check('a person publishing is not asked about it', [r.status, putInvoices()], [200, 2]);
lookupDown = false;

// 9) A RECONCILED Spend Money (the real Lalamove one): Xero refuses an app's
//    edit ("cannot be edited as it has been reconciled"), so none is asked for.
//    The file still goes; the refusal is recorded in plain words; and once the
//    change is made by hand in Xero, a re-read clears the difference.
reconciled = true;
const amex = receipt({ date: '2026-09-24', invoiceNumber: 'AMEX-1', fileHash: 'amex' });
await api('paperwork-unlink', { billId: doc.id }); // free bt-1 for this one
seen.length = 0;
r = await api('paperwork-match', { billId: amex.id, kind: 'spend', transactionId: 'bt-1', recode: true });
check('reconciled: sent', [r.status, r.body.attachment?.ok], [200, true]);
check('…no edit is attempted', seen.some((x) => x.path === 'BankTransactions/bt-1' && x.method === 'POST'), false);
check('…and why is said plainly', [r.body.recode?.ok, r.body.recode?.message], [false, 'Xero does not let an app change a Spend Money once it is reconciled with a bank statement line.']);
r = await api('paperwork-recode', { billId: amex.id });
check('pressing Recode on it later asks Xero nothing either', [r.status, seen.some((x) => x.path === 'BankTransactions/bt-1' && x.method === 'POST')], [422, false]);
recodeReply = null;
// Somebody changes the outlet in Xero by hand; the page reads it again.
seen.length = 0;
handEdit = true;
r = await api('paperwork-refresh', { billId: amex.id });
check('re-read after a hand edit: the lines now say Tangs', getBillById('org-1', amex.id)!.paperworkMatch?.lines?.[0]?.tracking, [{ category: 'Outlets', option: 'Tangs' }]);
check('…and nothing was written to Xero', seen.filter((x) => x.method !== 'GET').length, 0);

server.close();
stub.close();
if (failures) {
  console.error(`${failures} paperwork-match check(s) failed`);
  process.exit(1);
}
