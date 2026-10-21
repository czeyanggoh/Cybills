// A document marked Paid, with the account it was paid from, is PAID in Xero
// the moment it is published: approved (Xero refuses a payment on a draft),
// then a payment from that account on the document's date. What is asserted is
// what actually goes to the relay — the bill's status and the payment body —
// and what is left alone: a document not marked paid, one with no method, one
// whose method is no account Xero takes payments to, and a credit note.
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR = mkdtempSync(join(tmpdir(), 'cybills-paid-publish-'));
process.env.BILLS_DATA_DIR = DATA_DIR;
process.env.CYWORKSPACE_API_KEY = 'test-key';

writeFileSync(
  join(DATA_DIR, 'organisations.json'),
  JSON.stringify({
    organisations: [
      { id: 'org-1', orgId: 'cybm', name: 'Dart', tenantId: 'tenant-1', tenantName: 'Dart', createdAt: new Date(0).toISOString(), createdBy: '' },
    ],
  })
);

// --- stub relay --------------------------------------------------------------
let posted: any = null;
let payments: any[] = [];
let paymentReply: any = null;
const read = (req: http.IncomingMessage) =>
  new Promise<any>((r) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => r(JSON.parse(body || '{}')));
  });
const stub = http.createServer(async (req, res) => {
  const path = decodeURIComponent(String(req.url)).split('?')[0];
  res.setHeader('content-type', 'application/json');
  if (path.endsWith('/Accounts')) {
    res.end(JSON.stringify({ Accounts: [
      { AccountID: 'acc-429', Code: '429', Name: 'General Expenses', Status: 'ACTIVE', Type: 'EXPENSE' },
      { AccountID: 'acc-dbs', Code: '090', Name: 'DBS Current', Status: 'ACTIVE', Type: 'BANK', BankAccountNumber: '072-113-2338', CurrencyCode: 'SGD' },
      // Not a bank, but open to payments — the case in the screenshot.
      { AccountID: 'acc-debtors', Code: '620', Name: 'Other Debtors - Red Alpha', Status: 'ACTIVE', Type: 'CURRENT', EnablePaymentsToAccount: true },
      // Exists, but closed to payments: never a payment method.
      { AccountID: 'acc-loan', Code: '800', Name: 'Director Loan', Status: 'ACTIVE', Type: 'CURRLIAB' },
    ] }));
    return;
  }
  if (path.endsWith('/Organisation')) {
    res.end(JSON.stringify({ Organisations: [{ Name: 'Dart', BaseCurrency: 'SGD' }] }));
    return;
  }
  if (path.endsWith('/Currencies')) {
    res.end(JSON.stringify({ Currencies: [{ Code: 'SGD' }] }));
    return;
  }
  if (path.endsWith('/TrackingCategories')) {
    res.end(JSON.stringify({ TrackingCategories: [] }));
    return;
  }
  if (path.endsWith('/Payments')) {
    const body = await read(req);
    payments.push(body.Payments?.[0]);
    res.end(JSON.stringify(paymentReply ?? { Payments: [{ PaymentID: 'pay-1', HasValidationErrors: false }] }));
    return;
  }
  // The read-back after the payment.
  if (/\/Invoices\/inv-1$/.test(path)) {
    res.end(JSON.stringify({ Invoices: [{ InvoiceID: 'inv-1', Status: 'PAID', FullyPaidOnDate: '2026-09-30', AmountDue: 0, Payments: [{ Reference: 'INV-2026-0881' }] }] }));
    return;
  }
  if (path.endsWith('/Invoices')) {
    posted = (await read(req)).Invoices?.[0] ?? null;
    res.end(JSON.stringify({ Invoices: [{
      InvoiceID: 'inv-1',
      InvoiceNumber: 'INV-2026-0881',
      Status: posted?.Status,
      HasErrors: false,
      Total: 1351.77,
      AmountDue: 1351.77,
      CurrencyCode: 'SGD',
      LineItems: [{ LineItemID: 'li-1' }],
    }] }));
    return;
  }
  if (path.endsWith('/CreditNotes')) {
    posted = (await read(req)).CreditNotes?.[0] ?? null;
    res.end(JSON.stringify({ CreditNotes: [{ CreditNoteID: 'cn-1', CreditNoteNumber: 'CN-1', Status: posted?.Status, HasErrors: false, RemainingCredit: 100 }] }));
    return;
  }
  if (path.includes('/Attachments/')) {
    await read(req);
    res.end(JSON.stringify({ Attachments: [{ AttachmentID: 'att-1' }] }));
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found', path }));
});
await new Promise<void>((r) => stub.listen(4672, '127.0.0.1', r));
process.env.CYWORKSPACE_RELAY_URL = 'http://127.0.0.1:4672';

const express = (await import('express')).default;
const { xeroRouter } = await import('../src/xero.ts');
const { insertBill, getBillById } = await import('../src/store.ts');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api/xero', xeroRouter);
const server = app.listen(4673, '127.0.0.1');
await new Promise((r) => server.once('listening', r));

let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : `FAIL got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}  ${name}`);
};

const bill = (fields: Record<string, unknown>) =>
  insertBill({
    orgId: 'cybm', kind: 'cost', status: 'ready', supplier: 'Red Alpha Cybersecurity', invoiceNumber: 'INV-2026-0881',
    documentType: 'Invoice', currency: 'SGD', date: '2026-09-30', category: '429 - General Expenses',
    description: 'Salary recharge', total: '1351.77', tax: '111.61', taxRate: 'Standard-Rated Purchases',
    ...fields,
  } as any);

const publish = async (billId: string) => {
  posted = null;
  payments = [];
  const res = await fetch('http://127.0.0.1:4673/api/xero/organisations/org-1/publish-bill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ billId, accountCode: '429', taxType: 'INPUTY24', status: 'DRAFT' }),
  });
  return { status: res.status, body: (await res.json()) as any };
};

// --- Paid, from an account open to payments ----------------------------------
{
  const doc = bill({ paid: true, paymentMethod: 'Other Debtors - Red Alpha' });
  const out = await publish(doc.id);
  check('publishes', out.status, 200);
  check('as Approved, whatever was asked — Xero refuses a payment on a draft', posted?.Status, 'AUTHORISED');
  check('and says it overrode the choice', out.body.statusForced, true);
  check('one payment is recorded', payments.length, 1);
  check('against the bill just made', payments[0]?.Invoice, { InvoiceID: 'inv-1' });
  check('from the account the document names', payments[0]?.Account, { AccountID: 'acc-debtors' });
  check('on the document date, for what the bill leaves owing', [payments[0]?.Date, payments[0]?.Amount], ['2026-09-30', 1351.77]);
  check('carrying the invoice number', payments[0]?.Reference, 'INV-2026-0881');
  check('the reply says so', [out.body.paidOnPublish?.ok, out.body.paidOnPublish?.account], [true, 'Other Debtors - Red Alpha']);
  check('and the document records what Xero now says', getBillById('cybm', doc.id)?.xeroStatus, 'PAID');
}

// --- A bank account, named the way the dropdown labels it ---------------------
{
  const out = await publish(bill({ invoiceNumber: 'B-2', paid: true, paymentMethod: 'DBS Current (2338)' }).id);
  check('a bank account by its dropdown label', payments[0]?.Account, { AccountID: 'acc-dbs' });
  check('paid', out.body.paidOnPublish?.ok, true);
}

// --- Left alone ---------------------------------------------------------------
{
  let out = await publish(bill({ invoiceNumber: 'B-3', paid: false, paymentMethod: 'DBS Current (2338)' }).id);
  check('not marked paid: posted as asked', posted?.Status, 'DRAFT');
  check('and no payment', [payments.length, out.body.paidOnPublish], [0, null]);

  out = await publish(bill({ invoiceNumber: 'B-4', paid: true, paymentMethod: '' }).id);
  check('paid with no method: posted as asked, no payment', [posted?.Status, payments.length, out.body.paidOnPublish], ['DRAFT', 0, null]);

  out = await publish(bill({ invoiceNumber: 'B-5', paid: true, paymentMethod: 'Director Loan' }).id);
  check('a method that takes no payments: posted as asked', posted?.Status, 'DRAFT');
  check('no payment is guessed at', payments.length, 0);
  check('and the reply says why', [out.body.paidOnPublish?.ok, /takes payments/.test(out.body.paidOnPublish?.message)], [false, true]);

  out = await publish(bill({ invoiceNumber: 'B-6', paid: true, paymentMethod: 'Petty cash (added by hand)' }).id);
  check('a hand-added method that is no Xero account: no payment', [payments.length, out.body.paidOnPublish?.ok], [0, false]);

  out = await publish(bill({ invoiceNumber: 'CN-1', documentType: 'Credit note/refund', total: '100', tax: '0', taxRate: 'No Tax', paid: true, paymentMethod: 'DBS Current (2338)' }).id);
  check('a credit note is not "paid" — that would be a refund', [out.status, payments.length], [200, 0]);
}

// --- Xero refusing the payment does not undo the publish ------------------------
{
  paymentReply = { Payments: [{ HasValidationErrors: true, ValidationErrors: [{ Message: 'Payment date is in a locked period' }] }] };
  const doc = bill({ invoiceNumber: 'B-7', paid: true, paymentMethod: 'DBS Current (2338)' });
  const out = await publish(doc.id);
  paymentReply = null;
  check('the bill is still published', [out.status, getBillById('cybm', doc.id)?.xeroInvoiceId], [200, 'inv-1']);
  check('and the refusal is reported in Xero’s words', [out.body.paidOnPublish?.ok, out.body.paidOnPublish?.message], [false, 'Payment date is in a locked period']);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
server.close();
stub.close();
process.exit(failures ? 1 : 0);
