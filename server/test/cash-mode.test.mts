// Cash mode: an entity whose Xero has no bills or invoices. Everything it
// publishes goes up as a bank transaction — Spend Money or Receive Money — from
// a bank or card account, and nothing else is written: no invoice, no credit
// note, no payment. What is asserted is what actually goes to the relay.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finish } from './support.mts';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-cash-mode-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';
process.env.WHATSAPP_INBOUND_KEY = 'inbound-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-1', orgId: 'cybm', name: 'Cash Co', tenantId: 'tenant-1', tenantName: 'Cash Co', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);
writeFileSync(
  join(DATA_DIR, 'settings.json'),
  JSON.stringify({
    items: [
      {
        workspaceId: 'cybm',
        key: 'cybills.extraction-settings.v1::org-1',
        value: { cashMode: true, cardFeeRules: [{ bankAccount: 'DBS Current', percent: '1', accountCode: '404 - Bank Fees' }] },
      },
    ],
  })
);
const ITEM = {
  itemId: '', date: '2026-09-18', supplier: 'Kopi', category: '429 - General Expenses', description: 'meal', net: '10.00', tax: '0.90', total: '10.90',
};
writeFileSync(
  join(DATA_DIR, 'claims.json'),
  JSON.stringify({
    items: [{
      id: 'claim-1', workspaceId: 'cybm', orgId: 'cybm', claimFor: 'Jenny Lye', type: 'Regular',
      name: 'September claim', claimDate: '2026-09-30', endDate: '2026-09-30', currency: 'SGD',
      transactions: [{ ...ITEM, itemId: '260918000001' }],
      history: [], approvalStatus: 'approved', approver: '', approverEmail: '', decidedBy: '', decidedAt: '',
      archived: false, deleted: false, createdBy: '', createdAt: new Date(0).toISOString(),
      hrSentAt: '', hrSentAmount: '', hrSentBy: '', hrRevision: 0,
    }],
  })
);
writeFileSync(
  join(DATA_DIR, 'bills.json'),
  JSON.stringify({
    bills: [{
      id: 'bill_claimed', orgId: 'cybm', displayId: '260918000001', fileHash: 'h-claimed', fileName: 'kopi.jpg', supplier: 'Kopi',
      invoiceNumber: 'K-1', documentType: 'Receipt', currency: 'SGD', date: '2026-09-18', category: '429 - General Expenses',
      total: '10.90', tax: '0.90', taxRate: 'Standard-Rated Purchases', createdBy: '', status: 'expenseclaim', kind: 'cost',
      createdAt: new Date(0).toISOString(),
    }],
  })
);

// --- stub relay --------------------------------------------------------------
let calls: Array<{ method: string; path: string; body: any }> = [];
let reconciled = false;
let last: any = null;
let n = 0;
const stub = http.createServer((req, res) => {
  const path = decodeURIComponent(String(req.url)).split('?')[0].replace(/^.*xero-relay\//, '');
  res.setHeader('content-type', 'application/json');
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const send = (body: unknown) => res.end(JSON.stringify(body));
    if (path === 'Accounts') {
      return send({ Accounts: [
        { AccountID: 'acc-429', Code: '429', Name: 'General Expenses', Status: 'ACTIVE', Type: 'EXPENSE', TaxType: 'INPUTY24' },
        { AccountID: 'acc-dbs', Code: '090', Name: 'DBS Current', Status: 'ACTIVE', Type: 'BANK', BankAccountNumber: '072-113-2338', CurrencyCode: 'SGD' },
        { AccountID: 'acc-debtors', Code: '620', Name: 'Director', Status: 'ACTIVE', Type: 'CURRENT', EnablePaymentsToAccount: true },
      ] });
    }
    if (path === 'TaxRates') {
      return send({ TaxRates: [
        { Name: 'Standard-Rated Purchases', TaxType: 'INPUTY24', Status: 'ACTIVE', EffectiveRate: 9 },
        { Name: 'No Tax', TaxType: 'NONE', Status: 'ACTIVE', EffectiveRate: 0 },
      ] });
    }
    if (path === 'Organisation') return send({ Organisations: [{ Name: 'Cash Co', BaseCurrency: 'SGD' }] });
    if (path === 'Currencies') return send({ Currencies: [{ Code: 'SGD' }] });
    if (path === 'TrackingCategories') return send({ TrackingCategories: [] });
    if (path.includes('/Attachments/')) {
      calls.push({ method: req.method!, path, body: null });
      return send({ Attachments: [{ AttachmentID: 'att-1' }] });
    }
    if (path.startsWith('BankTransactions') || path.startsWith('Invoices') || path.startsWith('CreditNotes') || path.startsWith('Payments')) {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method!, path, body });
      if (path === 'BankTransactions') {
        const t = body.BankTransactions[0];
        const id = t.BankTransactionID ?? `bt-${++n}`;
        last = {
          ...t, BankTransactionID: id, Status: 'AUTHORISED', IsReconciled: false, CurrencyCode: 'SGD',
          Date: `${t.Date}T00:00:00`,
          LineItems: t.LineItems.map((l: any, i: number) => ({ ...l, LineItemID: `li-${i + 1}` })),
        };
        return send({ BankTransactions: [last] });
      }
      if (/^BankTransactions\//.test(path)) {
        if (req.method === 'GET') return send({ BankTransactions: [{ ...last, IsReconciled: reconciled }] });
        return send({ BankTransactions: [{ BankTransactionID: path.split('/')[1], Status: 'DELETED' }] });
      }
      res.statusCode = 400;
      return send({ error: 'should_not_be_called' });
    }
    res.statusCode = 404;
    send({ error: 'not_found', path });
  });
});
await new Promise<void>((r) => stub.listen(4872, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4872';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');
const { paymentsRouter } = await import('../src/payments.ts');
const { recordsFor, undoSettlement } = await import('../src/bankMatch.ts');
const { insertBill, getBillById } = await import('../src/store.ts');
const { getOrganisation } = await import('../src/organisations.ts');
const { getClaimForXero } = await import('../src/claims.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
app.use('/api/payments', paymentsRouter);
const server = app.listen(4873, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const bill = (fields: Record<string, unknown>) =>
  insertBill({
    orgId: 'cybm', kind: 'cost', status: 'ready', supplier: 'Canva', invoiceNumber: 'C-1',
    documentType: 'Receipt', currency: 'SGD', date: '2026-09-30', category: '429 - General Expenses',
    description: 'Subscription', total: '109.00', tax: '9.00', taxRate: 'Standard-Rated Purchases',
    ...fields,
  } as any);

const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`http://127.0.0.1:4873${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
};
const publish = (billId: string, extra: Record<string, unknown> = {}) => {
  calls = [];
  return call('/api/xero/organisations/org-1/publish-bill', { billId, accountCode: '429', taxType: 'INPUTY24', status: 'DRAFT', ...extra });
};
const writes = () => calls.filter((c) => !c.path.includes('/Attachments/') && c.method !== 'GET');
const sent = () => writes()[0]?.body?.BankTransactions?.[0];

// --- A paid receipt is Spend Money --------------------------------------------
const first = bill({ paid: true, paymentMethod: 'DBS Current (2338)' });
{
  const out = await publish(first.id);
  check('publishes', out.status, 200);
  check('one write, a bank transaction — no invoice, no payment', writes().map((c) => `${c.method} ${c.path}`), ['PUT BankTransactions']);
  check('money out, from the account the document names', [sent()?.Type, sent()?.BankAccount], ['SPEND', { AccountID: 'acc-dbs' }]);
  check('on the document date, carrying its number', [sent()?.Date, sent()?.Reference], ['2026-09-30', 'C-1']);
  check('the same coded line a bill would carry', sent()?.LineItems.map((l: any) => [l.UnitAmount, l.TaxAmount, l.TaxType, l.AccountCode]), [[100, 9, 'INPUTY24', '429']]);
  check('no status or due date is asked of Xero', [sent()?.Status, sent()?.DueDate], [undefined, undefined]);
  const doc = getBillById('cybm', first.id)!;
  check('the document is published as Spend Money and paid', [doc.xeroDocType, doc.xeroStatus, doc.status], ['SPEND', 'PAID', 'archived']);
}

// --- Money must have moved through a bank or card account ------------------------
{
  let out = await publish(bill({ invoiceNumber: 'C-2', paid: false, paymentMethod: 'DBS Current (2338)' }).id);
  check('not marked paid and nothing picked: refused', [out.status, out.body.error, writes().length], [422, 'no_bank_account', 0]);
  out = await publish(bill({ invoiceNumber: 'C-3', paid: true, paymentMethod: 'Director' }).id);
  check('a method that is not a bank account: refused', [out.status, out.body.error, writes().length], [422, 'no_bank_account', 0]);
  const picked = bill({ invoiceNumber: 'C-4', paid: false, paymentMethod: '' });
  out = await publish(picked.id, { paidFrom: 'acc-dbs', paidDate: '2026-10-02' });
  check('picked in the dialog: posted from it, on that day', [out.status, sent()?.BankAccount, sent()?.Date], [200, { AccountID: 'acc-dbs' }, '2026-10-02']);
  const doc = getBillById('cybm', picked.id)!;
  check('and the document says what the ledger says', [doc.paid, doc.paymentMethod], [true, 'DBS Current (2338)']);
}

// --- Which way the money went ---------------------------------------------------
{
  const paid = { paid: true, paymentMethod: 'DBS Current (2338)' };
  await publish(bill({ ...paid, invoiceNumber: 'CN-1', documentType: 'Credit note/refund', total: '-109.00', tax: '-9.00' }).id);
  check('a cost refund is money in, as positive figures', [sent()?.Type, sent()?.LineItems[0].UnitAmount], ['RECEIVE', 100]);
  await publish(bill({ ...paid, invoiceNumber: 'S-1', kind: 'sales', supplier: 'A Customer' }).id);
  check('a sale is money in', [sent()?.Type, sent()?.Contact], ['RECEIVE', { Name: 'A Customer' }]);
}

// --- A foreign receipt posts in the account's currency ---------------------------
{
  await publish(bill({
    paid: true, paymentMethod: 'DBS Current (2338)', invoiceNumber: 'U-1', currency: 'USD', total: '10.00', tax: '0', taxRate: 'No Tax',
    baseCurrency: 'SGD', baseTotal: 13.5, baseTax: 0, exchangeRate: 1.35,
  }).id);
  check('at the figure the paper restated', sent()?.LineItems[0].UnitAmount, 13.5);
  check('no currency is named — it is the bank account’s', sent()?.CurrencyCode, undefined);
}

// --- A bank line settles as one Spend Money, card fee included --------------------
{
  const doc = bill({ invoiceNumber: 'F-1', total: '100.00', tax: '0', taxRate: 'No Tax', paid: false, paymentMethod: '' });
  calls = [];
  const line = { date: '2026-10-01', amount: -101, currency: 'SGD', reference: 'CANVA CARD', description: 'CANVA', bank_account_id: 'acc-dbs', bank_account_name: 'DBS Current' };
  const out = await call(`/api/payments/bills/${doc.id}/settle`, { tenant_id: 'tenant-1', line }, { 'X-API-Key': 'inbound-key' });
  check('settles', [out.status, out.body.ok, out.body.cash], [200, true, true]);
  check('one write only', writes().map((c) => `${c.method} ${c.path}`), ['PUT BankTransactions']);
  check('dated and referenced as the bank shows it', [sent()?.Date, sent()?.Reference], ['2026-10-01', 'CANVA CARD']);
  check('the card fee is a second line, so the total is the line’s', sent()?.LineItems.map((l: any) => [l.UnitAmount, l.AccountCode]), [[100, '429'], [1, '404']]);
  const record = recordsFor('cybm').find((r) => r.billId === doc.id)!;
  check('the match remembers the transaction', [record.cash, record.invoiceId, getBillById('cybm', doc.id)?.paid], [true, out.body.invoice.invoiceId, true]);

  calls = [];
  const undone = await undoSettlement(record, getOrganisation('cybm', 'org-1')!);
  check('undo deletes the transaction', [undone.status, writes()[0]?.body?.BankTransactions?.[0]?.Status], [200, 'DELETED']);
  const back = getBillById('cybm', doc.id)!;
  check('and the document is unpublished and unpaid again', [back.xeroInvoiceId, back.paid, back.status === 'archived'], [undefined, false, false]);
}

// --- Update in Xero ------------------------------------------------------------
{
  const doc = bill({ invoiceNumber: 'UP-1', paid: true, paymentMethod: 'DBS Current (2338)' });
  await publish(doc.id, { paidDate: '2026-10-03' });
  const id = getBillById('cybm', doc.id)!.xeroInvoiceId;
  const update = () => {
    calls = [];
    return call('/api/xero/organisations/org-1/update-bill', { billId: doc.id, accountCode: '429', taxType: 'INPUTY24' });
  };
  reconciled = true;
  let out = await update();
  check('a reconciled transaction is not asked to change', [out.status, out.body.error, writes().length], [409, 'reconciled', 0]);
  reconciled = false;
  out = await update();
  check('an unreconciled one is restated', [out.status, writes()[0]?.method, sent()?.BankTransactionID], [200, 'POST', id]);
  check('keeping the day it was paid', sent()?.Date, '2026-10-03');
}

// --- What cash mode leaves out ---------------------------------------------------
{
  const quote = bill({ invoiceNumber: 'Q-1', documentType: 'Quotation', tax: '0', taxRate: 'No Tax' });
  const rec = await call('/api/xero/organisations/org-1/record-prepayment', { billId: quote.id, bankAccountId: 'acc-dbs' });
  check('no prepayments', [rec.status, rec.body.error], [409, 'cash_mode']);
  bill({ invoiceNumber: 'W-1' });
  const list = await call('/api/payments/bills?tenant_id=tenant-1', undefined, { 'X-API-Key': 'inbound-key' });
  check('nothing is offered to a payment run', [list.status, list.body.bills], [200, []]);
}

// --- A claim is one Spend Money, from the account it was reimbursed from ----------
{
  const post = (extra: Record<string, unknown>) => {
    calls = [];
    return call('/api/xero/organisations/org-1/publish-claim', { claimId: 'claim-1', ...extra });
  };
  let out = await post({ paidFrom: 'acc-dbs' });
  check('the date paid is asked for', [out.status, out.body.error, writes().length], [400, 'missing_field', 0]);
  out = await post({ paidFrom: 'acc-dbs', paidDate: '2026-10-05' });
  check('publishes', out.status, 200);
  check('as Spend Money to the claimant', [writes().map((c) => c.path), sent()?.Type, sent()?.Contact, sent()?.Date], [['BankTransactions'], 'SPEND', { Name: 'Jenny Lye' }, '2026-10-05']);
  const claim = getClaimForXero('cybm', 'claim-1')!;
  check('the claim records it, reimbursed', [claim.xeroDocType, claim.xeroStatus, claim.xeroPaidDate], ['SPEND', 'PAID', '2026-10-05']);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
await finish(failures, server, stub);
