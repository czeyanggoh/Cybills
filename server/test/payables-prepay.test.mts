// A quotation paid through a CYWorkspace payment run.
//
// The payables list offered a quotation like any unpaid bill, and committing
// the run asked CYBills to PUBLISH it — which the one publish path refuses
// (a quotation is not a tax invoice), after CYWS had already made the contact
// and put the line in a bank file. Now the list says what the row is
// (`kind: 'prepayment'`), publish points at the right road, and
// `POST /bills/:id/prepay` records the Xero overpayment from the run's own
// bank account and date, on the contact the run holds the bank details on.
//
// Over real HTTP against the real server, because the session guard's
// allowlist is part of what is being asserted.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-prepay-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.SESSION_SECRET = 'test-session-secret';
process.env.GOOGLE_CLIENT_ID = 'x';
process.env.GOOGLE_CLIENT_SECRET = 'x';
process.env.WHATSAPP_INBOUND_KEY = 'cyws-key';
process.env.CYWORKSPACE_API_KEY = 'relay-key';
process.env.PORT = '4664';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-1', orgId: 'cybm', name: 'Demo Co', tenantId: 'tenant-1', tenantName: 'Demo Co', createdAt: new Date(0).toISOString(), createdBy: '' },
      { id: 'org-2', orgId: 'cybm', name: 'Other Co', tenantId: 'tenant-2', tenantName: 'Other Co', createdAt: new Date(1000).toISOString(), createdBy: '' },
    ],
  })
);

const seen: Array<{ method: string; path: string; body: any }> = [];
const stub = http.createServer((req, res) => {
  const path = decodeURIComponent(String(req.url)).split('?')[0].replace('/api/webhooks/xero-relay/', '');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: String(req.method), path, body });
    res.setHeader('content-type', 'application/json');
    if (path === 'Accounts') return res.end(JSON.stringify({ Accounts: [{ Code: '429', Name: 'General Expenses', Status: 'ACTIVE', Type: 'EXPENSE', TaxType: 'NONE' }] }));
    if (path === 'TaxRates') return res.end(JSON.stringify({ TaxRates: [{ Name: 'No Tax', TaxType: 'NONE', Status: 'ACTIVE', EffectiveRate: 0, CanApplyToExpenses: true }] }));
    if (path === 'BankTransactions' && req.method === 'PUT') {
      const t = body.BankTransactions[0];
      return res.end(JSON.stringify({ BankTransactions: [{
        BankTransactionID: 'bt-1', OverpaymentID: 'op-1', Type: t.Type, CurrencyCode: 'SGD', HasErrors: false,
        Contact: { ContactID: t.Contact.ContactID }, BankAccount: { AccountID: t.BankAccount.AccountID, Code: '090', Name: 'UOB 380-323-746-6' },
      }] }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', path }));
  });
});
await new Promise<void>((r) => stub.listen(4665, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4665';

const { insertBill, getBillById } = await import('../src/store.ts');
const { dataScopeForOrg } = await import('../src/organisations.ts');
await import('../src/index.ts');
await new Promise((r) => setTimeout(r, 200));

const BASE = 'http://127.0.0.1:4664';
const KEY = { 'X-API-Key': 'cyws-key' };

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};
const post = async (path: string, body: unknown, headers: Record<string, string> = KEY) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};

const book = dataScopeForOrg('org-1');
// No category: a quotation posts to no account, so none is asked of it.
const quote = insertBill({
  orgId: book, kind: 'cost', status: 'new', supplier: 'Windee Private Limited', invoiceNumber: 'QUO-2609239',
  documentType: 'Quotation', currency: 'SGD', date: '2026-09-19', category: '', description: 'Window works',
  total: '999', tax: '0',
} as any);
const incomplete = insertBill({
  orgId: book, kind: 'cost', status: 'new', supplier: 'Unknown supplier', documentType: 'Quotation',
  currency: 'SGD', date: '2026-09-19', total: '10', tax: '0',
} as any);

// --- listed as a prepayment --------------------------------------------------
const listed = await fetch(`${BASE}/api/payments/bills?tenant_id=tenant-1`, { headers: KEY }).then((r) => r.json()) as any;
const row = listed.bills.find((b: any) => b.id === quote.id);
check('the quotation is offered to the run', Boolean(row), true);
check('…as a prepayment, postable, with no posting codes', [row?.kind, row?.postable, row?.account_code, row?.tax_type], ['prepayment', true, '', '']);
check('a quotation naming no supplier is not offered', listed.bills.some((b: any) => b.id === incomplete.id), false);

// --- publish points at the right road ----------------------------------------
let r = await post(`/api/payments/bills/${quote.id}/publish`, { tenant_id: 'tenant-1', contact_id: 'c-windee' });
check('publishing it is refused, naming why', [r.status, r.body.error], [409, 'prepayment_document']);
check('…and nothing reached Xero', seen.filter((s) => s.path === 'Invoices').length, 0);

// --- prepay ------------------------------------------------------------------
r = await post(`/api/payments/bills/${quote.id}/prepay`, { tenant_id: 'tenant-1', contact_id: 'c-windee', bank_account_id: 'acc-uob' }, {});
check('no key: refused by the route, not the session guard', [r.status, r.body.error], [401, 'bad_key']);
r = await post(`/api/payments/bills/${quote.id}/prepay`, { tenant_id: 'tenant-1', contact_id: 'c-windee' });
check('no bank account: refused', [r.status, r.body.error], [400, 'missing_field']);
r = await post(`/api/payments/bills/${quote.id}/prepay`, { tenant_id: 'tenant-2', contact_id: 'c-windee', bank_account_id: 'acc-uob' });
check('another client’s tenant: refused', [r.status, r.body.error], [409, 'tenant_mismatch']);

r = await post(`/api/payments/bills/${quote.id}/prepay`, {
  tenant_id: 'tenant-1', contact_id: 'c-windee', bank_account_id: 'acc-uob', date: '2026-09-22', amount: 500, reference: 'PV260922-001',
});
check('recorded', [r.status, r.body.ok], [200, true]);
const sent = seen.find((s) => s.path === 'BankTransactions' && s.method === 'PUT')?.body?.BankTransactions?.[0];
check('as a SPEND-OVERPAYMENT', sent?.Type, 'SPEND-OVERPAYMENT');
check('on the contact the run holds the bank details on, by id', sent?.Contact, { ContactID: 'c-windee' });
check('from the run’s bank account, by id', sent?.BankAccount, { AccountID: 'acc-uob' });
check('on the payment date', sent?.Date, '2026-09-22');
check('for the deposit paid, without tax', [sent?.LineAmountTypes, sent?.LineItems?.[0]?.LineAmount], ['NoTax', 500]);
check('carrying the quotation number, then the PV', sent?.Reference, 'Quotation QUO-2609239 · PV260922-001');
const q = getBillById(book, quote.id)!;
check('the quotation keeps the overpayment', [q.prepayment?.overpaymentId, q.prepayment?.amount, q.prepayment?.contactId], ['op-1', 500, 'c-windee']);
check('…and is Paid, from that account, and set aside', [q.paid, q.paymentMethod, q.status], [true, 'UOB 380-323-746-6', 'archived']);

const puts = seen.filter((s) => s.path === 'BankTransactions').length;
r = await post(`/api/payments/bills/${quote.id}/prepay`, { tenant_id: 'tenant-1', contact_id: 'c-windee', bank_account_id: 'acc-uob' });
check('pressed again: answers with the one it has', [r.status, r.body.already_recorded, r.body.prepayment?.overpaymentId], [200, true, 'op-1']);
check('…and records nothing more in Xero', seen.filter((s) => s.path === 'BankTransactions').length, puts);

const after = await fetch(`${BASE}/api/payments/bills?tenant_id=tenant-1`, { headers: KEY }).then((r) => r.json()) as any;
check('once recorded it leaves the payables list', after.bills.some((b: any) => b.id === quote.id), false);

// --- an invoice is not a prepayment -------------------------------------------
const invoice = insertBill({
  orgId: book, kind: 'cost', status: 'ready', supplier: 'Windee Private Limited', invoiceNumber: 'INV-1',
  documentType: 'Invoice', currency: 'SGD', date: '2026-10-05', category: '429 - General Expenses', taxRate: 'No Tax',
  total: '1200', tax: '0',
} as any);
r = await post(`/api/payments/bills/${invoice.id}/prepay`, { tenant_id: 'tenant-1', contact_id: 'c-windee', bank_account_id: 'acc-uob' });
check('an invoice cannot be prepaid', [r.status, r.body.error], [409, 'not_prepayment']);

stub.close();
console.log(failures ? `\n${failures} FAILED` : '\nAll payables-prepay checks passed');
process.exit(failures ? 1 : 0);
